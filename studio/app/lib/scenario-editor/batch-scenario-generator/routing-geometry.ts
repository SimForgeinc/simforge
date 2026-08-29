import type { ScenarioEditorRoadAnchor } from "@simforge-oss/studio-shared";
import {
  laneTravelIncreasesSByConvention,
} from "@simforge-oss/maps/topology";
import type { RuntimeRoadSegment } from "@/app/lib/runtime/runtime-types";
import { isDrivableSegment, rslFromWaypointRef } from "./graph";

// ---------------------------------------------------------------------------
// Lane geometry sampling + travel-direction resolution. Split from routing.ts
// (wave-2a: files over ~1000 lines are split); routing.ts re-exports this
// module, so external `./routing` importers are unchanged.
// ---------------------------------------------------------------------------

export function centerlineArcLengthMeters(segment: RuntimeRoadSegment): number {
  const points = segment.centerline;
  if (!points || points.length < 2) return 0;
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    length += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return length;
}

export function headingDeltaDegrees(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  const normalized = Math.abs((((b - a + 180) % 360) + 360) % 360 - 180);
  return normalized;
}
// ---------------------------------------------------------------------------
// Lane geometry sampling.
// ---------------------------------------------------------------------------

export function centerlinePointAtFraction(
  segment: RuntimeRoadSegment,
  fraction: number,
): { x: number; y: number; z: number } | null {
  const points = segment.centerline;
  if (!points || points.length === 0) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (points.length === 1) return { x: first.x, y: first.y, z: first.z ?? 0 };
  const clamped = Math.min(1, Math.max(0, fraction));
  const targetS = first.s + (last.s - first.s) * clamped;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const span = b.s - a.s;
    if (Math.abs(span) < 1e-9) continue;
    const within =
      span > 0 ? targetS >= a.s && targetS <= b.s : targetS <= a.s && targetS >= b.s;
    if (!within) continue;
    const t = (targetS - a.s) / span;
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: (a.z ?? 0) + ((b.z ?? 0) - (a.z ?? 0)) * t,
    };
  }
  return { x: last.x, y: last.y, z: last.z ?? 0 };
}

/**
 * Intended WORLD position + heading of a road anchor, sampled from the lane
 * centerline at `fraction`. Returns runtime/frontend-frame `{x, y, z, yaw}` (yaw
 * in degrees, the same basis spawn_yaw uses) — or null if no finite position
 * exists. Attached to spawn anchors as `world_anchor` so the CARLA-0.10 worker
 * can resolve the anchor by geometry when the UE4→UE5 road renumber breaks the
 * road_id lookup. Position comes from `centerlinePointAtFraction`; yaw is the
 * stored centerline yaw at the nearest sample, falling back to the local tangent.
 */
export function worldAnchorAtFraction(
  segment: RuntimeRoadSegment,
  fraction: number,
): { x: number; y: number; z: number; yaw: number } | null {
  const point = centerlinePointAtFraction(segment, fraction);
  if (
    !point ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !Number.isFinite(point.z)
  ) {
    return null;
  }
  const yaw = centerlineYawAtFraction(segment, fraction);
  if (!Number.isFinite(yaw)) return null;
  return { x: point.x, y: point.y, z: point.z, yaw };
}

/**
 * Return a copy of `anchor` with `world_anchor` populated from the lane
 * centerline at `fraction` — additive only (road_id/section_id/lane_id/s_fraction
 * untouched). Omits the field entirely when no finite world position exists, so
 * an anchor on a centerline-less segment stays byte-identical to before and the
 * worker falls back to its current road_id-only resolution.
 */
export function withWorldAnchor<T extends ScenarioEditorRoadAnchor>(
  anchor: T,
  segment: RuntimeRoadSegment | null | undefined,
  fraction: number,
): T {
  if (!segment) return anchor;
  const worldAnchor = worldAnchorAtFraction(segment, fraction);
  if (!worldAnchor) return anchor;
  return { ...anchor, world_anchor: worldAnchor };
}

/** Centerline heading (degrees, runtime/frontend yaw convention) at `fraction`.
 * Prefers the stored per-point `yaw` at the nearest centerline sample; falls back
 * to the local tangent of the polyline when yaw is absent/non-finite. */
export function centerlineYawAtFraction(segment: RuntimeRoadSegment, fraction: number): number {
  const points = segment.centerline;
  if (!points || points.length === 0) return Number.NaN;
  const clamped = Math.min(1, Math.max(0, fraction));
  if (points.length === 1) {
    const only = points[0]!;
    return Number.isFinite(only.yaw) ? only.yaw : Number.NaN;
  }
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const targetS = first.s + (last.s - first.s) * clamped;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const span = b.s - a.s;
    if (Math.abs(span) < 1e-9) continue;
    const within =
      span > 0 ? targetS >= a.s && targetS <= b.s : targetS <= a.s && targetS >= b.s;
    if (!within) continue;
    const t = (targetS - a.s) / span;
    const nearer = t < 0.5 ? a : b;
    if (Number.isFinite(nearer.yaw)) return nearer.yaw;
    return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  }
  return Number.isFinite(last.yaw)
    ? last.yaw
    : (Math.atan2(last.y - points[points.length - 2]!.y, last.x - points[points.length - 2]!.x) *
        180) /
        Math.PI;
}

/** Unit vector of a lane's TRAVEL direction at `fraction` (oriented by the lane's
 * actual driving direction, not blindly increasing-s). Used to place a perpendicular
 * pedestrian crossing through the subject's corridor. */
export function laneHeadingAtFraction(
  segment: RuntimeRoadSegment,
  fraction: number,
  forwardIncreasingS: boolean,
): { x: number; y: number } | null {
  const a = centerlinePointAtFraction(segment, Math.max(0, fraction - 0.03));
  const b = centerlinePointAtFraction(segment, Math.min(1, fraction + 0.03));
  if (!a || !b) return null;
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (!forwardIncreasingS) {
    dx = -dx;
    dy = -dy;
  }
  const n = Math.hypot(dx, dy);
  if (n < 1e-6) return null;
  return { x: dx / n, y: dy / n };
}

export function laneMinDistanceToPoint(
  segment: RuntimeRoadSegment,
  point: { x: number; y: number },
): number {
  const points = segment.centerline;
  if (!points || points.length === 0) return Number.POSITIVE_INFINITY;
  if (points.length === 1) {
    return Math.hypot(point.x - points[0]!.x, point.y - points[0]!.y);
  }
  let best = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t =
      lengthSq < 1e-9
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)));
  }
  return best;
}

/** Min distance from a runtime-frame polyline to a point (segment-wise). */
export function polylineMinDistanceToPoint(
  points: ReadonlyArray<{ x: number; y: number }>,
  point: { x: number; y: number },
): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY;
  if (points.length === 1) return Math.hypot(point.x - points[0]!.x, point.y - points[0]!.y);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t =
      lengthSq < 1e-9
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)));
  }
  return best;
}

/** Sample a runtime-frame polyline at a fraction of its arc length, returning
 * the point and the local tangent heading in degrees (runtime/frontend yaw
 * convention, the basis spawn_yaw uses). */
export function sampleParkingPolyline(
  points: ReadonlyArray<{ x: number; y: number }>,
  fraction: number,
): { x: number; y: number; yawDeg: number } | null {
  if (points.length === 0) return null;
  if (points.length === 1) return { x: points[0]!.x, y: points[0]!.y, yawDeg: 0 };
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  const target = total * Math.min(1, Math.max(0, fraction));
  let acc = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + span >= target || i === points.length - 1) {
      const t = span < 1e-9 ? 0 : (target - acc) / span;
      const yawDeg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, yawDeg };
    }
    acc += span;
  }
  const last = points[points.length - 1]!;
  const prev = points[points.length - 2]!;
  return {
    x: last.x,
    y: last.y,
    yawDeg: (Math.atan2(last.y - prev.y, last.x - prev.x) * 180) / Math.PI,
  };
}

// ---------------------------------------------------------------------------
// Forward routing (subject + lead route construction).
// ---------------------------------------------------------------------------

/**
 * Whether a lane's TRAVEL direction runs along INCREASING s_fraction. This is
 * NOT universal: in OpenDRIVE, lanes on one side of the reference line drive with
 * +s and the other side with −s, so a route/placement that blindly increases
 * s_fraction sends the subject the WRONG WAY (into oncoming traffic) on half the
 * lanes. Determined geometrically — the segment's successor connects at its
 * forward (travel) end — with the lane_id-sign convention as a fallback
 * (negative lane_id ⇒ +s travel, the common CARLA/RoadRunner convention).
 */
export function forwardIsIncreasingS(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  segment: RuntimeRoadSegment,
): boolean {
  // PRIMARY — map-agnostic and authoritative. Each centerline point stores CARLA's
  // waypoint yaw, i.e. the lane's actual TRAVEL direction. Forward is increasing-s
  // exactly when the centerline's +s tangent points the SAME way as that yaw. The old
  // heuristic below assumed "positive lane_id ⇒ travels against +s" and leaned on clean
  // successor geometry — both FALSE on some maps: Munich's positive lanes travel WITH +s
  // and their successors point to self, so the heuristic sampled routes BACKWARD down the
  // lane (subject faces forward, waypoints run behind it → wrong-way / off-road / U-turns).
  // Comparing the tangent to the stored yaw is correct per-lane on any map.
  const pts = segment.centerline;
  if (pts && pts.length >= 2) {
    const mid = pts[Math.floor(pts.length / 2)];
    const storedYaw = mid?.yaw;
    const lo = centerlinePointAtFraction(segment, 0.35);
    const hi = centerlinePointAtFraction(segment, 0.65);
    if (lo && hi && storedYaw != null && Number.isFinite(storedYaw)) {
      const sTangent = Math.atan2(hi.y - lo.y, hi.x - lo.x); // heading of the +s direction
      const aligned = Math.cos(sTangent - (storedYaw * Math.PI) / 180); // wraparound-safe
      if (Math.abs(aligned) > 1e-6) return aligned > 0; // +s aligns with travel ⇒ forward is +s
    }
  }
  // FALLBACK — only when a segment carries no usable stored yaw. The original
  // lane-sign + successor heuristic (kept byte-identical for those segments).
  const laneSignForward = laneTravelIncreasesSByConvention(segment.lane_id);
  const succ = (segment.successors ?? [])
    .map((ref) => rslFromWaypointRef(ref))
    .filter((rsl): rsl is string => Boolean(rsl))
    .map((rsl) => segments.get(rsl!))
    .find((seg): seg is RuntimeRoadSegment => Boolean(seg) && isDrivableSegment(seg));
  const succPt = succ ? centerlinePointAtFraction(succ, 0.1) : null;
  const hiP = centerlinePointAtFraction(segment, 0.9);
  const loP = centerlinePointAtFraction(segment, 0.1);
  if (!succPt || !hiP || !loP) return laneSignForward;
  const dHi = Math.hypot(succPt.x - hiP.x, succPt.y - hiP.y);
  const dLo = Math.hypot(succPt.x - loP.x, succPt.y - loP.y);
  return dHi <= dLo; // successor connects nearer the high-s end ⇒ forward is +s
}
