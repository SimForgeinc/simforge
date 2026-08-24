import { dist, obbSeparation, type Obb, type Vec2 } from '../core/math.js';
import type { Dims, ScenePoint } from '../schema/input.js';

export type NearMissPass = 'front' | 'behind' | 'auto';

export interface TimedTrajectoryPoint extends ScenePoint {
  readonly t: number;
  /** Optional authoritative heading. Segment direction is used when omitted. */
  readonly headingRad?: number;
}

export interface PedestrianNearMissRequest {
  readonly pedestrianId: string;
  readonly targetId: string;
  readonly pedestrianStart: ScenePoint;
  readonly pedestrianDims: Dims;
  /** Canonical preview/playback target trajectory, including turns and stops. */
  readonly targetTrajectory: readonly TimedTrajectoryPoint[];
  readonly targetDims: Dims;
  readonly triggerTimeS: number;
  readonly deadlineS: number;
  readonly clearanceM?: number;
  readonly pass?: NearMissPass;
  readonly minSpeedMps?: number;
  readonly maxSpeedMps?: number;
  readonly toleranceM?: number;
}

export type PedestrianNearMissIssueCode =
  | 'near_miss_invalid_trajectory'
  | 'near_miss_invalid_window'
  | 'near_miss_infeasible_speed'
  | 'near_miss_clearance_unresolved'
  | 'near_miss_would_collide';

export interface PedestrianNearMissDiagnostic {
  readonly code: PedestrianNearMissIssueCode;
  readonly message: string;
  readonly detail?: Readonly<Record<string, number | string>>;
}

export interface PedestrianNearMissSolution {
  readonly pedestrianId: string;
  readonly targetId: string;
  readonly pass: Exclude<NearMissPass, 'auto'>;
  readonly triggerTimeS: number;
  readonly closestApproachTimeS: number;
  readonly predictedClearanceM: number;
  readonly requestedClearanceM: number;
  /** Signed target travel time represented by the front/behind offset. */
  readonly predictedTimeGapS: number;
  readonly speedMps: number;
  readonly headingRad: number;
  readonly points: readonly [ScenePoint, ScenePoint, ScenePoint];
  /** Stable digest shared by preview and playback adapters. */
  readonly planHash: string;
}

export type PedestrianNearMissResult =
  | { readonly ok: true; readonly solution: PedestrianNearMissSolution }
  | { readonly ok: false; readonly diagnostic: PedestrianNearMissDiagnostic };

const q = (n: number): number => Math.round(n * 1e6) / 1e6;

function stableHash(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function trajectoryPose(points: readonly TimedTrajectoryPoint[], t: number): { point: Vec2; headingRad: number; speedMps: number } | null {
  if (points.length < 2 || t < points[0]!.t || t > points[points.length - 1]!.t) return null;
  let i = 0;
  while (i + 1 < points.length && points[i + 1]!.t < t) i++;
  const a = points[i]!;
  const b = points[Math.min(i + 1, points.length - 1)]!;
  const dt = b.t - a.t;
  const u = dt <= 1e-9 ? 0 : (t - a.t) / dt;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return {
    point: { x: a.x + dx * u, y: a.z + dz * u },
    headingRad: a.headingRad ?? (Math.hypot(dx, dz) > 1e-9 ? Math.atan2(dz, dx) : b.headingRad ?? 0),
    speedMps: dt <= 1e-9 ? 0 : Math.hypot(dx, dz) / dt,
  };
}

/**
 * Solve a deterministic pedestrian near miss against an authoritative timed
 * target trajectory. The generated closest-approach pose has the requested
 * OBB-to-OBB clearance and is rejected rather than relaxed when infeasible.
 */
export function solvePedestrianNearMiss(request: PedestrianNearMissRequest): PedestrianNearMissResult {
  const trajectory = [...request.targetTrajectory].sort((a, b) => a.t - b.t);
  if (trajectory.length < 2 || trajectory.some((p, i) => !Number.isFinite(p.t + p.x + p.z) || (i > 0 && p.t <= trajectory[i - 1]!.t))) {
    return { ok: false, diagnostic: { code: 'near_miss_invalid_trajectory', message: 'target trajectory must contain strictly increasing finite samples' } };
  }
  if (!(request.deadlineS > request.triggerTimeS)) {
    return { ok: false, diagnostic: { code: 'near_miss_invalid_window', message: 'near-miss deadline must be after its trigger' } };
  }
  const clearance = request.clearanceM ?? 0.5;
  const tolerance = request.toleranceM ?? 0.02;
  const minSpeed = request.minSpeedMps ?? 0.5;
  const maxSpeed = request.maxSpeedMps ?? 3;
  const passes: Array<'front' | 'behind'> = request.pass === 'front' ? ['front'] : request.pass === 'behind' ? ['behind'] : ['front', 'behind'];
  const startT = Math.max(request.triggerTimeS + 0.1, trajectory[0]!.t);
  const endT = Math.min(request.deadlineS, trajectory[trajectory.length - 1]!.t);
  const candidates: PedestrianNearMissSolution[] = [];

  // A 50 ms grid is exact relative to the engine's common 20 Hz contract and
  // keeps identical results across browsers/Node without iterative roots.
  for (let t = Math.ceil(startT * 20) / 20; t <= endT + 1e-9; t += 0.05) {
    const target = trajectoryPose(trajectory, t);
    if (!target) continue;
    const hx = Math.cos(target.headingRad);
    const hz = Math.sin(target.headingRad);
    for (const pass of passes) {
      const sign = pass === 'front' ? 1 : -1;
      // Two deterministic refinements account for pedestrian footprint
      // projection changing with the approach heading.
      let centreOffset = request.targetDims.l / 2 + request.pedestrianDims.w / 2 + clearance;
      let closest = { x: target.point.x + hx * centreOffset * sign, z: target.point.y + hz * centreOffset * sign };
      let pedestrianHeading = Math.atan2(closest.z - request.pedestrianStart.z, closest.x - request.pedestrianStart.x);
      for (let refine = 0; refine < 2; refine++) {
        const delta = pedestrianHeading - target.headingRad;
        const pedExtent = Math.abs(Math.cos(delta)) * request.pedestrianDims.l / 2 + Math.abs(Math.sin(delta)) * request.pedestrianDims.w / 2;
        centreOffset = request.targetDims.l / 2 + pedExtent + clearance;
        closest = { x: target.point.x + hx * centreOffset * sign, z: target.point.y + hz * centreOffset * sign };
        pedestrianHeading = Math.atan2(closest.z - request.pedestrianStart.z, closest.x - request.pedestrianStart.x);
      }
      const travelS = t - request.triggerTimeS;
      const speed = dist({ x: request.pedestrianStart.x, y: request.pedestrianStart.z }, { x: closest.x, y: closest.z }) / travelS;
      if (speed < minSpeed - 1e-9 || speed > maxSpeed + 1e-9) continue;
      const pedObb: Obb = { center: { x: closest.x, y: closest.z }, lengthM: request.pedestrianDims.l, widthM: request.pedestrianDims.w, headingRad: pedestrianHeading };
      const targetObb: Obb = { center: target.point, lengthM: request.targetDims.l, widthM: request.targetDims.w, headingRad: target.headingRad };
      const actual = obbSeparation(pedObb, targetObb);
      if (actual <= 1e-9 || Math.abs(actual - clearance) > tolerance) continue;
      const beyond = { x: closest.x + Math.cos(pedestrianHeading) * 2, z: closest.z + Math.sin(pedestrianHeading) * 2 };
      const base = {
        pedestrianId: request.pedestrianId, targetId: request.targetId, pass,
        triggerTimeS: q(request.triggerTimeS), closestApproachTimeS: q(t),
        predictedClearanceM: q(actual), requestedClearanceM: q(clearance),
        predictedTimeGapS: q(sign * centreOffset / Math.max(target.speedMps, 1e-6)),
        speedMps: q(speed), headingRad: q(pedestrianHeading),
        points: [request.pedestrianStart, { x: q(closest.x), z: q(closest.z) }, { x: q(beyond.x), z: q(beyond.z) }] as const,
      };
      candidates.push({ ...base, planHash: stableHash(base) });
    }
  }
  candidates.sort((a, b) => a.closestApproachTimeS - b.closestApproachTimeS || a.speedMps - b.speedMps || a.pass.localeCompare(b.pass));
  if (candidates[0]) return { ok: true, solution: candidates[0] };
  return { ok: false, diagnostic: { code: 'near_miss_infeasible_speed', message: 'no collision-free near miss satisfies the time, speed and clearance bounds', detail: { minSpeedMps: minSpeed, maxSpeedMps: maxSpeed, clearanceM: clearance } } };
}
