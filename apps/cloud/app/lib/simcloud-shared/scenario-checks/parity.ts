/**
 * Trace parity comparator. Given two per-actor traces sampled independently
 * (e.g. a CARLA run vs an esmini run of the same .xosc, or a native-format
 * CARLA run vs an OSC-imported CARLA run of the same scenario), resample both
 * onto a shared time grid and measure per-actor position/heading/speed error.
 *
 * This is the measurement behind two questions the user asked:
 *   - "is esmini identical to CARLA?" -> compare esmini trace vs CARLA trace.
 *   - "is OSC identical to our format?" (live confirmation of the static
 *     round-trip proof) -> compare native-CARLA trace vs OSC-CARLA trace.
 *
 * Deterministic and dependency-free so it runs in CI and in a headless harness.
 */
import type { CheckActorTrack, ScenarioCheck } from "./types";

export interface ParityTolerance {
  /** Grid step in seconds for resampling both traces (default 0.05 = 20 Hz). */
  gridStepS?: number;
  /** Max acceptable position error, meters (default 0.5). */
  positionM?: number;
  /** Max acceptable heading error, radians (default 0.087 ~= 5 deg). */
  headingRad?: number;
  /** Max acceptable speed error, m/s (default 1.0). */
  speedMps?: number;
}

export interface ActorParity {
  actorId: string;
  samplesCompared: number;
  maxPositionErrorM: number;
  meanPositionErrorM: number;
  maxHeadingErrorRad: number;
  maxSpeedErrorMps: number;
  withinTolerance: boolean;
}

export interface ParityResult {
  /** Actors present in both traces and compared. */
  perActor: ActorParity[];
  /** Actor ids present in only one of the two traces. */
  unmatched: string[];
  maxPositionErrorM: number;
  withinTolerance: boolean;
  gridStepS: number;
  tolerance: Required<ParityTolerance>;
}

interface Sample {
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

/** Derive speed/yaw where absent, matching the kinematic-checks derivation. */
function densify(track: CheckActorTrack): Sample[] {
  const s = track.samples;
  const out: Sample[] = [];
  for (let i = 0; i < s.length; i++) {
    const cur = s[i]!;
    let speed = cur.speed;
    let yaw = cur.yaw;
    if (speed === undefined || yaw === undefined) {
      const a = s[i - 1] ?? cur;
      const b = s[i + 1] ?? cur;
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
    out.push({ t: cur.t, x: cur.x, y: cur.y, yaw: yaw ?? 0, speed: speed ?? 0 });
  }
  return out;
}

/** Linear interpolation of a densified track at time t (clamped at the ends). */
function sampleAt(samples: Sample[], t: number): Sample | null {
  if (samples.length === 0) return null;
  if (t <= samples[0]!.t) return samples[0]!;
  const last = samples[samples.length - 1]!;
  if (t >= last.t) return last;
  // Binary search for the bracketing pair.
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo]!;
  const b = samples[hi]!;
  const span = b.t - a.t;
  const f = span > 0 ? (t - a.t) / span : 0;
  return {
    t,
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    yaw: a.yaw + normalizeAngle(b.yaw - a.yaw) * f,
    speed: a.speed + (b.speed - a.speed) * f,
  };
}

/**
 * Compare a candidate trace against a reference trace. Returns per-actor error
 * envelopes plus an overall within-tolerance verdict.
 */
export function compareRuns(
  reference: CheckActorTrack[],
  candidate: CheckActorTrack[],
  tolerance: ParityTolerance = {},
): ParityResult {
  const tol: Required<ParityTolerance> = {
    gridStepS: tolerance.gridStepS ?? 0.05,
    positionM: tolerance.positionM ?? 0.5,
    headingRad: tolerance.headingRad ?? 0.087,
    speedMps: tolerance.speedMps ?? 1.0,
  };

  const refById = new Map(reference.map((t) => [t.actorId, densify(t)]));
  const candById = new Map(candidate.map((t) => [t.actorId, densify(t)]));

  const unmatched: string[] = [];
  for (const id of refById.keys()) if (!candById.has(id)) unmatched.push(id);
  for (const id of candById.keys()) if (!refById.has(id)) unmatched.push(id);

  const perActor: ActorParity[] = [];
  let overallMaxPos = 0;

  for (const [actorId, refSamples] of refById) {
    const candSamples = candById.get(actorId);
    if (!candSamples || refSamples.length === 0 || candSamples.length === 0) continue;

    const tStart = Math.max(refSamples[0]!.t, candSamples[0]!.t);
    const tEnd = Math.min(
      refSamples[refSamples.length - 1]!.t,
      candSamples[candSamples.length - 1]!.t,
    );

    let maxPos = 0;
    let sumPos = 0;
    let maxHeading = 0;
    let maxSpeed = 0;
    let n = 0;
    for (let t = tStart; t <= tEnd + 1e-9; t += tol.gridStepS) {
      const r = sampleAt(refSamples, t);
      const c = sampleAt(candSamples, t);
      if (!r || !c) continue;
      const posErr = Math.hypot(r.x - c.x, r.y - c.y);
      const headErr = Math.abs(normalizeAngle(r.yaw - c.yaw));
      const speedErr = Math.abs(r.speed - c.speed);
      maxPos = Math.max(maxPos, posErr);
      sumPos += posErr;
      maxHeading = Math.max(maxHeading, headErr);
      maxSpeed = Math.max(maxSpeed, speedErr);
      n++;
    }

    const withinTolerance =
      n > 0 && maxPos <= tol.positionM && maxHeading <= tol.headingRad && maxSpeed <= tol.speedMps;
    overallMaxPos = Math.max(overallMaxPos, maxPos);
    perActor.push({
      actorId,
      samplesCompared: n,
      maxPositionErrorM: Number(maxPos.toFixed(4)),
      meanPositionErrorM: Number((n > 0 ? sumPos / n : 0).toFixed(4)),
      maxHeadingErrorRad: Number(maxHeading.toFixed(4)),
      maxSpeedErrorMps: Number(maxSpeed.toFixed(4)),
      withinTolerance,
    });
  }

  const withinTolerance =
    unmatched.length === 0 && perActor.length > 0 && perActor.every((a) => a.withinTolerance);

  return {
    perActor,
    unmatched,
    maxPositionErrorM: Number(overallMaxPos.toFixed(4)),
    withinTolerance,
    gridStepS: tol.gridStepS,
    tolerance: tol,
  };
}

/** Render a parity result as a checklist entry per actor plus an overall row. */
export function parityToChecks(result: ParityResult, label: string): ScenarioCheck[] {
  const checks: ScenarioCheck[] = [];
  for (const id of result.unmatched) {
    checks.push({
      id: "parity.actor_unmatched",
      category: "parity",
      status: "fail",
      label: `${label}: actor coverage`,
      detail: `actor "${id}" appears in only one of the two runs`,
      actorId: id,
      measuredValue: null,
      threshold: null,
    });
  }
  for (const a of result.perActor) {
    checks.push({
      id: "parity.actor_trajectory",
      category: "parity",
      status: a.withinTolerance ? "pass" : "fail",
      label: `${label}: trajectory parity`,
      detail: a.withinTolerance
        ? `matches within tolerance (max ${a.maxPositionErrorM} m over ${a.samplesCompared} samples)`
        : `diverges: max ${a.maxPositionErrorM} m / ${a.maxHeadingErrorRad} rad / ${a.maxSpeedErrorMps} m/s`,
      actorId: a.actorId,
      measuredValue: a.maxPositionErrorM,
      threshold: result.tolerance.positionM,
    });
  }
  return checks;
}
