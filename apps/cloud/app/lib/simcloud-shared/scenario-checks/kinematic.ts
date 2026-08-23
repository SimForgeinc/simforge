/**
 * Kinematic-plausibility + data-integrity checks over a per-actor trace. These
 * are the "linting" the user runs after a 2D simulation: they answer "is this
 * motion physically sane?" (comfort/limits) and "is the trace clean?"
 * (discontinuities), returning a pass/warn/fail check per metric.
 *
 * Thresholds mirror the M1 scenario-lint engine's `DEFAULT_LINT_CONFIG` so the
 * verdicts agree whichever engine runs.
 */
import type { CheckActorTrack, CheckTrackSample, ScenarioCheck } from "./types";

export interface KinematicThresholds {
  vehicle: {
    accelWarn: number;
    accelViol: number;
    decelWarn: number;
    decelViol: number;
    lateralWarn: number;
    lateralViol: number;
    jerkWarn: number;
    jerkViol: number;
  };
  walker: {
    speedWarn: number;
    speedViol: number;
  };
  integrity: {
    /** Max plausible per-step position jump beyond constant-velocity, meters. */
    positionJumpM: number;
    /** Max plausible speed step, m/s^2 (finite-difference accel). */
    speedJumpMps2: number;
    /** Max plausible heading step, radians. */
    headingJumpRad: number;
  };
  /** Minimum window for jerk evaluation, seconds. */
  jerkWindowS: number;
}

export const DEFAULT_KINEMATIC_THRESHOLDS: KinematicThresholds = {
  vehicle: {
    accelWarn: 2.5,
    accelViol: 4,
    decelWarn: 3.5,
    decelViol: 9,
    lateralWarn: 3,
    lateralViol: 6,
    jerkWarn: 2,
    jerkViol: 10,
  },
  walker: {
    speedWarn: 3,
    speedViol: 7,
  },
  integrity: {
    positionJumpM: 10,
    speedJumpMps2: 15,
    headingJumpRad: Math.PI / 2,
  },
  jerkWindowS: 0.5,
};

interface DerivedSample {
  t: number;
  x: number;
  y: number;
  yaw: number;
  speed: number;
}

function normalizeAngle(a: number): number {
  let r = a;
  while (r > Math.PI) r -= 2 * Math.PI;
  while (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

/** Fill in speed (finite-difference) and yaw (velocity heading) where absent. */
function derive(samples: CheckTrackSample[]): DerivedSample[] {
  const out: DerivedSample[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    let speed = s.speed;
    let yaw = s.yaw;
    if (speed === undefined || yaw === undefined) {
      const prev = samples[i - 1];
      const next = samples[i + 1];
      // Central difference where possible, else one-sided.
      const a = prev ?? s;
      const b = next ?? s;
      const dt = b.t - a.t;
      if (dt > 0) {
        const vx = (b.x - a.x) / dt;
        const vy = (b.y - a.y) / dt;
        if (speed === undefined) speed = Math.hypot(vx, vy);
        if (yaw === undefined) yaw = vx === 0 && vy === 0 ? (out[i - 1]?.yaw ?? 0) : Math.atan2(vy, vx);
      } else {
        if (speed === undefined) speed = 0;
        if (yaw === undefined) yaw = out[i - 1]?.yaw ?? 0;
      }
    }
    out.push({ t: s.t, x: s.x, y: s.y, yaw: yaw ?? 0, speed: speed ?? 0 });
  }
  return out;
}

function check(
  id: string,
  actorId: string,
  label: string,
  peak: number,
  warn: number,
  viol: number,
  unit: string,
): ScenarioCheck {
  const status = peak >= viol ? "fail" : peak >= warn ? "warn" : "pass";
  const threshold = status === "fail" ? viol : warn;
  const detail =
    status === "pass"
      ? `peak ${peak.toFixed(2)} ${unit} within limits (warn ${warn}, limit ${viol})`
      : `peak ${peak.toFixed(2)} ${unit} exceeds ${status === "fail" ? "limit" : "comfort"} ${threshold} ${unit}`;
  return {
    id,
    category: "kinematic",
    status,
    label,
    detail,
    actorId,
    measuredValue: Number(peak.toFixed(4)),
    threshold,
  };
}

/**
 * Run kinematic + integrity checks on a set of actor tracks. Returns one check
 * per (actor, metric); an actor with too few samples is skipped with a note.
 */
export function runKinematicChecks(
  tracks: CheckActorTrack[],
  thresholds: KinematicThresholds = DEFAULT_KINEMATIC_THRESHOLDS,
): ScenarioCheck[] {
  const checks: ScenarioCheck[] = [];

  for (const track of tracks) {
    const d = derive(track.samples);
    if (d.length < 3) {
      checks.push({
        id: "kinematic.insufficient_samples",
        category: "kinematic",
        status: "warn",
        label: "Insufficient trace",
        detail: `actor ${track.actorId} has ${d.length} sample(s); need >=3 for kinematic checks`,
        actorId: track.actorId,
        measuredValue: d.length,
        threshold: 3,
      });
      continue;
    }

    // Per-step derivatives.
    let peakAccel = 0;
    let peakDecel = 0;
    let peakLateral = 0;
    const accelSeries: Array<{ t: number; a: number }> = [];
    let peakPosJump = 0;
    let peakSpeedJump = 0;
    let peakHeadingJump = 0;

    for (let i = 1; i < d.length; i++) {
      const a = d[i - 1]!;
      const b = d[i]!;
      const dt = b.t - a.t;
      if (dt <= 0) continue;

      const dSpeed = (b.speed - a.speed) / dt;
      accelSeries.push({ t: b.t, a: dSpeed });
      if (dSpeed > peakAccel) peakAccel = dSpeed;
      if (-dSpeed > peakDecel) peakDecel = -dSpeed;

      const dYaw = normalizeAngle(b.yaw - a.yaw);
      const yawRate = dYaw / dt;
      const lateral = Math.abs(yawRate) * Math.max(a.speed, b.speed);
      if (lateral > peakLateral) peakLateral = lateral;

      // Integrity: position jump beyond a constant-velocity extrapolation.
      const predictedDist = a.speed * dt;
      const actualDist = Math.hypot(b.x - a.x, b.y - a.y);
      const posJump = Math.abs(actualDist - predictedDist);
      if (posJump > peakPosJump) peakPosJump = posJump;
      if (Math.abs(dSpeed) > peakSpeedJump) peakSpeedJump = Math.abs(dSpeed);
      if (Math.abs(dYaw) > peakHeadingJump) peakHeadingJump = Math.abs(dYaw);
    }

    // Jerk over the configured window.
    let peakJerk = 0;
    for (let i = 0; i < accelSeries.length; i++) {
      for (let j = i + 1; j < accelSeries.length; j++) {
        const dt = accelSeries[j]!.t - accelSeries[i]!.t;
        if (dt < thresholds.jerkWindowS) continue;
        const jerk = Math.abs(accelSeries[j]!.a - accelSeries[i]!.a) / dt;
        if (jerk > peakJerk) peakJerk = jerk;
        break; // first window that satisfies the min span for this start index
      }
    }

    if (track.kind === "walker") {
      const peakSpeed = Math.max(...d.map((s) => s.speed));
      checks.push(
        check(
          "kinematic.walker_speed",
          track.actorId,
          "Walker speed",
          peakSpeed,
          thresholds.walker.speedWarn,
          thresholds.walker.speedViol,
          "m/s",
        ),
      );
    } else {
      const v = thresholds.vehicle;
      checks.push(
        check("kinematic.longitudinal_acceleration", track.actorId, "Acceleration", peakAccel, v.accelWarn, v.accelViol, "m/s^2"),
        check("kinematic.longitudinal_deceleration", track.actorId, "Deceleration", peakDecel, v.decelWarn, v.decelViol, "m/s^2"),
        check("kinematic.lateral_acceleration", track.actorId, "Lateral accel", peakLateral, v.lateralWarn, v.lateralViol, "m/s^2"),
        check("kinematic.longitudinal_jerk", track.actorId, "Jerk", peakJerk, v.jerkWarn, v.jerkViol, "m/s^3"),
      );
    }

    // Integrity checks (always violation-severity when tripped).
    const integrity = thresholds.integrity;
    const integrityCheck = (
      id: string,
      label: string,
      peak: number,
      limit: number,
      unit: string,
    ): ScenarioCheck => ({
      id,
      category: "integrity",
      status: peak > limit ? "fail" : "pass",
      label,
      detail:
        peak > limit
          ? `discontinuity ${peak.toFixed(3)} ${unit} exceeds ${limit} ${unit} — trace likely corrupt or teleported`
          : `no discontinuity (peak ${peak.toFixed(3)} ${unit})`,
      actorId: track.actorId,
      measuredValue: Number(peak.toFixed(4)),
      threshold: limit,
    });
    checks.push(
      integrityCheck("integrity.position_discontinuity", "Position continuity", peakPosJump, integrity.positionJumpM, "m"),
      integrityCheck("integrity.speed_discontinuity", "Speed continuity", peakSpeedJump, integrity.speedJumpMps2, "m/s^2"),
      integrityCheck("integrity.heading_discontinuity", "Heading continuity", peakHeadingJump, integrity.headingJumpRad, "rad"),
    );
  }

  return checks;
}
