/**
 * Occluder ↔ pedestrian-path clearance (A2, dib 2026-07-26 triple review).
 *
 * Every occluder builder places a body DELIBERATELY hugging the conflict ped's
 * spawn (downstream end at the ped, extending upstream along the curb) — which is
 * exactly where the companion walkers' lateral offsets (±1.1–2.0 m along the curb)
 * land. The result in review: "peds stuck behind the occlusion van", the
 * cartoonish running-in-place walkers, and — because a stuck ped sits in the
 * subject's route corridor forever — the "subject never resumes" stall.
 *
 * Pure OBB-vs-polyline geometry so the generator can (a) verify the CONFLICT
 * ped's walk clears an occluder before accepting it and (b) drop companion /
 * background walkers whose walk would thread the body.
 */

export interface ObbFootprint {
  /** Body centre (CARLA planner frame, metres). */
  cx: number;
  cy: number;
  /** Heading of the body's LENGTH axis, degrees. */
  yawDeg: number;
  lengthM: number;
  widthM: number;
}

/** A walk polyline: spawn + waypoint positions in order. */
export type WalkPath = ReadonlyArray<{ x: number; y: number }>;

/** Point-in-OBB with an inflation margin on every side. */
export function pointInObb(
  p: { x: number; y: number },
  obb: ObbFootprint,
  marginM = 0,
): boolean {
  const rad = (obb.yawDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const dx = p.x - obb.cx;
  const dy = p.y - obb.cy;
  const lx = dx * c + dy * s; // along length axis
  const ly = -dx * s + dy * c; // along width axis
  return (
    Math.abs(lx) <= obb.lengthM / 2 + marginM && Math.abs(ly) <= obb.widthM / 2 + marginM
  );
}

/**
 * Segment-vs-OBB intersection (exact slab test in the OBB frame), with margin.
 */
export function segmentIntersectsObb(
  a: { x: number; y: number },
  b: { x: number; y: number },
  obb: ObbFootprint,
  marginM = 0,
): boolean {
  const rad = (obb.yawDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const toLocal = (p: { x: number; y: number }) => {
    const dx = p.x - obb.cx;
    const dy = p.y - obb.cy;
    return { x: dx * c + dy * s, y: -dx * s + dy * c };
  };
  const la = toLocal(a);
  const lb = toLocal(b);
  const hx = obb.lengthM / 2 + marginM;
  const hy = obb.widthM / 2 + marginM;
  // Slab clipping of the parametric segment against the axis-aligned box.
  let t0 = 0;
  let t1 = 1;
  const dx = lb.x - la.x;
  const dy = lb.y - la.y;
  for (const [p0, d, h] of [
    [la.x, dx, hx],
    [la.y, dy, hy],
  ] as const) {
    if (Math.abs(d) < 1e-12) {
      if (Math.abs(p0) > h) return false; // parallel outside the slab
      continue;
    }
    let tNear = (-h - p0) / d;
    let tFar = (h - p0) / d;
    if (tNear > tFar) [tNear, tFar] = [tFar, tNear];
    t0 = Math.max(t0, tNear);
    t1 = Math.min(t1, tFar);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * True when the whole walk path stays clear of the (inflated) occluder body.
 * A single-point path degrades to the point test.
 */
export function pathClearsObb(path: WalkPath, obb: ObbFootprint, marginM = 0): boolean {
  if (path.length === 0) return true;
  if (path.length === 1) return !pointInObb(path[0]!, obb, marginM);
  for (let i = 1; i < path.length; i++) {
    if (segmentIntersectsObb(path[i - 1]!, path[i]!, obb, marginM)) return false;
  }
  return true;
}

/** Walk clearance margin: walker capsule radius (~0.35 m) + shoulder room. */
export const PED_OCCLUDER_CLEARANCE_M = 0.6;

// ── Walker spawn hygiene (M-4, dib 2026-07-27 Munich review) ─────────────────
// "No pedestrians spawning on parked cars": a walker whose SPAWN XY lands inside
// a vehicle body either materializes ON the car roof/hood (then sky-drops when
// physics grounds it — the visible drop at clip start) or wedges against the
// body and never walks. The generator resolves this at authoring time: try small
// lateral shifts perpendicular to the walk direction; an unshiftable walker is
// dropped (companion/background) or the site rejected (conflict ped).

/** Lateral shift attempts (m), perpendicular to the walk direction, tried in
 *  order — nearest first, both sides. ±1.0 clears a car body the spawn merely
 *  clips; ±1.5 clears a spawn near the body centre (half-width ~1.0 + margin). */
export const WALKER_SPAWN_SHIFT_OFFSETS_M: readonly number[] = [1.0, -1.0, 1.5, -1.5];

/** Spawn-point clearance to any vehicle body: walker capsule radius + margin.
 *  Deliberately tighter than PED_OCCLUDER_CLEARANCE_M so an occlusion ped may
 *  still spawn hugging the van it emerges from behind (that is the feature). */
export const WALKER_SPAWN_VEHICLE_CLEARANCE_M = 0.4;

/**
 * Resolve a walker spawn point against a set of vehicle OBB footprints.
 * Returns:
 *  - the ORIGINAL spawn object when it already clears every body (identity-
 *    preserved so callers can detect the no-op),
 *  - a SHIFTED point (first WALKER_SPAWN_SHIFT_OFFSETS_M entry perpendicular to
 *    `walkDir` that clears every body) when the spawn sits inside/too close to
 *    a vehicle,
 *  - null when no candidate clears (or the walker has no resolvable walk
 *    direction to shift along) — the caller drops the walker / rejects the site.
 * Pure geometry: no draft mutation here.
 */
export function resolveWalkerSpawnClearOfVehicles(
  spawn: { x: number; y: number },
  walkDir: { x: number; y: number } | null,
  vehicleObbs: ReadonlyArray<ObbFootprint>,
  marginM: number = WALKER_SPAWN_VEHICLE_CLEARANCE_M,
): { x: number; y: number } | null {
  const clear = (p: { x: number; y: number }): boolean =>
    vehicleObbs.every((obb) => !pointInObb(p, obb, marginM));
  if (clear(spawn)) return spawn;
  const len = walkDir ? Math.hypot(walkDir.x, walkDir.y) : 0;
  if (!walkDir || len < 1e-6) return null; // no walk axis → no principled shift
  const px = -walkDir.y / len; // unit perpendicular to the walk direction
  const py = walkDir.x / len;
  for (const off of WALKER_SPAWN_SHIFT_OFFSETS_M) {
    const candidate = { x: spawn.x + px * off, y: spawn.y + py * off };
    if (clear(candidate)) return candidate;
  }
  return null;
}
