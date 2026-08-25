/**
 * Trajectory-following executor: pure pursuit + a time-indexed speed profile.
 *
 * Turns a planned trajectory — world-frame samples `{x, y, headingRad,
 * speedMps, tS}` with `tS` seconds from plan issuance — into per-tick
 * setpoints for the motion backends: a preview point + heading for the
 * bicycle model's pure-pursuit steering (`controlFor` in dynamic-v1.ts) and
 * a target speed + feedforward acceleration for its longitudinal controller.
 *
 * The follower holds one plan at a time (zero-order hold): `setPlan`
 * replaces it on replan, `command` is called once per decision tick with the
 * live pose. Everything here is a pure function of its inputs — no wall
 * clock, no randomness, no iteration-order dependence — so the same plan
 * sequence over the same poses yields bit-identical commands.
 *
 * Frame convention (shared with the policy_step wire, see
 * docs/policy-step.md): planned trajectories arrive in the *ego frame at
 * plan issuance* — x forward along the ego heading, y left (90° CCW),
 * heading relative to the ego yaw, `tS` seconds from issuance; the first
 * sample is strictly future (t > 0), not the current pose.
 * {@link anchorPlanToWorld} rebases such a plan onto the world frame at the
 * issuance pose; the follower itself always works in world coordinates.
 */

import { clamp, lerp, lerpAngle, normalizeAngle, type Vec2 } from '../core/math.js';

/** One plan sample; world frame after {@link anchorPlanToWorld}. */
export interface TrajectoryPlanPoint {
  readonly x: number;
  readonly y: number;
  readonly headingRad: number;
  /** Signed: negative = reverse travel, magnitude = travel speed. */
  readonly speedMps: number;
  /** Seconds from plan issuance. */
  readonly tS: number;
}

/** Planar pose + travel speed of the tracked actor at one tick. */
export interface TrackedPose {
  readonly x: number;
  readonly y: number;
  readonly yawRad: number;
  readonly speedMps: number;
}

export interface TrajectoryFollowerConfig {
  /** Minimum pure-pursuit lookahead, metres. */
  readonly lookaheadBaseM: number;
  /** Speed-proportional lookahead gain, seconds (Ld = base + gain·|v|). */
  readonly lookaheadGainS: number;
  /** Lookahead ceiling, metres. */
  readonly lookaheadMaxM: number;
}

export const DEFAULT_TRAJECTORY_FOLLOWER_CONFIG: TrajectoryFollowerConfig = {
  lookaheadBaseM: 2.5,
  lookaheadGainS: 0.55,
  lookaheadMaxM: 12,
};

/** One decision-tick output of the follower. */
export interface FollowerCommand {
  /** Travel-speed magnitude setpoint (>= 0). */
  readonly targetSpeedMps: number;
  /** Feedforward acceleration in the travel frame (slope of the speed profile). */
  readonly targetAccelerationMps2: number;
  readonly motionDirection: 1 | -1;
  /** Pure-pursuit preview point on the plan polyline, world frame. */
  readonly previewPoint: Vec2;
  readonly previewHeadingRad: number;
  /** Signed lateral offset from the plan polyline; positive = left of the plan. */
  readonly crossTrackErrorM: number;
  /** Arc position of the pose's projection along the plan, metres. */
  readonly alongTrackM: number;
  /** Seconds since plan issuance. */
  readonly planAgeS: number;
}

/**
 * Rebase an ego-frame plan (x forward, y left, heading relative, at the
 * issuance pose) onto the world frame. Pure; input order is preserved.
 */
export function anchorPlanToWorld(
  points: readonly TrajectoryPlanPoint[],
  anchor: { readonly x: number; readonly y: number; readonly yawRad: number },
): TrajectoryPlanPoint[] {
  const cos = Math.cos(anchor.yawRad);
  const sin = Math.sin(anchor.yawRad);
  return points.map((p) => ({
    x: anchor.x + p.x * cos - p.y * sin,
    y: anchor.y + p.x * sin + p.y * cos,
    headingRad: normalizeAngle(anchor.yawRad + p.headingRad),
    speedMps: p.speedMps,
    tS: p.tS,
  }));
}

/**
 * Deterministic trajectory tracker. Hold-and-replace plan semantics; one
 * `command` per decision tick.
 */
export class TrajectoryFollower {
  private readonly config: TrajectoryFollowerConfig;
  private points: readonly TrajectoryPlanPoint[] = [];
  /** Cumulative polyline arc length at each plan point, metres. */
  private arc: number[] = [];
  private planStartS = 0;

  constructor(config: Partial<TrajectoryFollowerConfig> = {}) {
    this.config = { ...DEFAULT_TRAJECTORY_FOLLOWER_CONFIG, ...config };
    if (!(this.config.lookaheadBaseM > 0)) throw new Error('lookaheadBaseM must be positive');
    if (!(this.config.lookaheadMaxM >= this.config.lookaheadBaseM)) {
      throw new Error('lookaheadMaxM must be >= lookaheadBaseM');
    }
  }

  get hasPlan(): boolean {
    return this.points.length > 0;
  }

  clear(): void {
    this.points = [];
    this.arc = [];
    this.planStartS = 0;
  }

  /**
   * Replace the held plan. `points` are world-frame samples (anchor
   * ego-frame wire plans with {@link anchorPlanToWorld} first); `planStartS`
   * is the sim time of issuance — the instant the samples' `tS` count from.
   */
  setPlan(points: readonly TrajectoryPlanPoint[], planStartS: number): void {
    if (points.length === 0) throw new Error('trajectory plan needs at least one point');
    const sorted = [...points].sort((a, b) => a.tS - b.tS);
    const arc: number[] = [0];
    for (let i = 1; i < sorted.length; i += 1) {
      arc.push(arc[i - 1]! + Math.hypot(sorted[i]!.x - sorted[i - 1]!.x, sorted[i]!.y - sorted[i - 1]!.y));
    }
    this.points = sorted;
    this.arc = arc;
    this.planStartS = planStartS;
  }

  /** Track the held plan from `pose` at sim time `tS`. Throws without a plan. */
  command(pose: TrackedPose, tS: number): FollowerCommand {
    if (this.points.length === 0) throw new Error('command() without a plan; call setPlan() first');
    const { crossTrackErrorM, alongTrackM } = this.project(pose);
    const lookaheadM = clamp(
      this.config.lookaheadBaseM + this.config.lookaheadGainS * Math.abs(pose.speedMps),
      this.config.lookaheadBaseM,
      this.config.lookaheadMaxM,
    );
    const preview = this.at(alongTrackM + lookaheadM);
    const planAgeS = tS - this.planStartS;
    const { speedMps, slopeMps2 } = this.sampleSpeed(planAgeS);
    const motionDirection: 1 | -1 = speedMps < 0 ? -1 : 1;
    return {
      targetSpeedMps: Math.abs(speedMps),
      targetAccelerationMps2: motionDirection * slopeMps2,
      motionDirection,
      previewPoint: preview.point,
      previewHeadingRad: preview.headingRad,
      crossTrackErrorM,
      alongTrackM,
      planAgeS,
    };
  }

  /**
   * Signed projection of `pose` onto the plan polyline. The first and last
   * segments project as open-ended rays: plan samples are strictly future,
   * so right after (re)anchoring the pose sits *behind* the first sample —
   * the longitudinal gap must not read as lateral error. `alongTrackM` is
   * correspondingly signed (negative = behind the first sample).
   */
  private project(pose: TrackedPose): { crossTrackErrorM: number; alongTrackM: number } {
    const pts = this.points;
    let firstSeg = -1;
    let lastSeg = -1;
    for (let i = 0; i < pts.length - 1; i += 1) {
      if (this.arc[i + 1]! - this.arc[i]! < 1e-9) continue;
      if (firstSeg < 0) firstSeg = i;
      lastSeg = i;
    }
    if (firstSeg < 0) {
      // Single sample (or all samples coincident): lateral error in the sample's frame.
      const only = pts[0]!;
      const ct = -(pose.x - only.x) * Math.sin(only.headingRad) + (pose.y - only.y) * Math.cos(only.headingRad);
      return { crossTrackErrorM: ct, alongTrackM: 0 };
    }
    let bestD2 = Infinity;
    let bestArc = 0;
    let bestCt = 0;
    for (let i = firstSeg; i <= lastSeg; i += 1) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const segLen = this.arc[i + 1]! - this.arc[i]!;
      if (segLen < 1e-9) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const tRaw = ((pose.x - a.x) * dx + (pose.y - a.y) * dy) / (segLen * segLen);
      const t = clamp(tRaw, i === firstSeg ? -Infinity : 0, i === lastSeg ? Infinity : 1);
      const cx = a.x + t * dx;
      const cy = a.y + t * dy;
      const d2 = (pose.x - cx) ** 2 + (pose.y - cy) ** 2;
      if (d2 < bestD2 - 1e-12) {
        bestD2 = d2;
        bestArc = this.arc[i]! + t * segLen;
        bestCt = (dx * (pose.y - cy) - dy * (pose.x - cx)) / segLen;
      }
    }
    return { crossTrackErrorM: bestCt, alongTrackM: bestArc };
  }

  /** Point + heading at arc position `s` along the plan, clamped to its ends. */
  private at(s: number): { point: Vec2; headingRad: number } {
    const pts = this.points;
    const last = pts[pts.length - 1]!;
    const total = this.arc[this.arc.length - 1]!;
    if (pts.length === 1 || s >= total) return { point: { x: last.x, y: last.y }, headingRad: last.headingRad };
    if (s <= 0) return { point: { x: pts[0]!.x, y: pts[0]!.y }, headingRad: pts[0]!.headingRad };
    for (let i = 0; i < pts.length - 1; i += 1) {
      const segLen = this.arc[i + 1]! - this.arc[i]!;
      if (segLen < 1e-9 || s > this.arc[i + 1]!) continue;
      const t = (s - this.arc[i]!) / segLen;
      const a = pts[i]!;
      const b = pts[i + 1]!;
      return {
        point: { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) },
        headingRad: lerpAngle(a.headingRad, b.headingRad, t),
      };
    }
    return { point: { x: last.x, y: last.y }, headingRad: last.headingRad };
  }

  /** Piecewise-linear signed speed profile over plan time, clamped at the ends. */
  private sampleSpeed(ageS: number): { speedMps: number; slopeMps2: number } {
    const pts = this.points;
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    if (ageS <= first.tS || pts.length === 1) return { speedMps: first.speedMps, slopeMps2: 0 };
    if (ageS >= last.tS) return { speedMps: last.speedMps, slopeMps2: 0 };
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      if (ageS > b.tS) continue;
      const dt = b.tS - a.tS;
      if (dt < 1e-9) continue;
      const u = (ageS - a.tS) / dt;
      return { speedMps: lerp(a.speedMps, b.speedMps, u), slopeMps2: (b.speedMps - a.speedMps) / dt };
    }
    return { speedMps: last.speedMps, slopeMps2: 0 };
  }
}
