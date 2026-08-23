import type { RuntimeMapResponse } from "@/app/lib/runtime/runtime-types";

type CrawlWaypoint = { x: number; y: number; yaw?: number | null };
type CrawlSegment = NonNullable<RuntimeMapResponse["road_segments"]>[number];

/** How many places along a lane to test before taking the majority. */
const SAMPLE_COUNT = 5;

/** Below this the tangent and the yaw are perpendicular — no usable signal. */
const ALIGNMENT_EPSILON = 1e-6;

function rslOf(segment: CrawlSegment): string {
  return `${segment.road_id}:${segment.section_id}:${segment.lane_id}`;
}

/** CARLA waypoints for each bound lane, keyed by RSL. */
export function crawlWaypointsByRsl(
  runtimeMap: RuntimeMapResponse,
): Map<string, readonly CrawlWaypoint[]> {
  const byRsl = new Map<string, readonly CrawlWaypoint[]>();
  for (const segment of runtimeMap.road_segments ?? []) {
    const rsl = rslOf(segment);
    if (byRsl.has(rsl)) continue;
    byRsl.set(rsl, segment.centerline ?? []);
  }
  return byRsl;
}

function nearestWaypoint(
  waypoints: readonly CrawlWaypoint[],
  to: { x: number; y: number },
): CrawlWaypoint | null {
  let best: CrawlWaypoint | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const waypoint of waypoints) {
    const distance = (waypoint.x - to.x) ** 2 + (waypoint.y - to.y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = waypoint;
    }
  }
  return best;
}

/**
 * Whether an s-increasing lane polyline runs the way the lane is DRIVEN.
 *
 * This is the one question the OpenDRIVE topology index cannot answer on its
 * own. `parseXodr` never reads the road's `rule` (RHT/LHT) attribute, so the
 * only stand-in available is the convention "negative lane ids run with +s,
 * positive against it" — which OpenDRIVE does not guarantee (left-hand-traffic
 * roads inverting it is the obvious case, junction connectors the murky one),
 * and getting it wrong faces cars backwards in their lane, head-on into the
 * ego. That is too load-bearing a guess to leave as a guess.
 *
 * CARLA's waypoint crawl settles it without assuming anything. Every crawl
 * waypoint stores the yaw CARLA itself resolved from the OpenDRIVE, which IS
 * the direction of travel, so the polyline follows travel exactly when its
 * tangent points the same way as the yaw at the nearest waypoint. This is the
 * same test `batch-scenario-generator/routing.ts::forwardIsIncreasingS`
 * already applies to the runtime bundle — the browser overlay just never had
 * the yaw to run it.
 *
 * On the maps published today the answer happens to match the convention
 * everywhere (San Ramon P1: 1999/1999 lanes; Munich: 389/389), so this is a
 * robustness change rather than a visible one. What it buys is that the next
 * map to break the convention breaks a lookup, not the traffic.
 *
 * Sampled at several places and majority-voted rather than read once: a lane
 * that doubles back (junction connectors especially) can have one tangent
 * disagree with its own travel direction.
 *
 * Returns `null` when the crawl offers no usable yaw, leaving the caller to
 * decide on a fallback rather than inventing an answer here.
 */
export function polylineFollowsTravel(
  waypoints: readonly CrawlWaypoint[],
  polyline: readonly { x: number; y: number }[],
): boolean | null {
  if (waypoints.length === 0 || polyline.length < 2) return null;

  const lastEdge = polyline.length - 2;
  const stride = Math.max(1, Math.floor((lastEdge + 1) / SAMPLE_COUNT));
  let votes = 0;
  for (let index = 0; index <= lastEdge; index += stride) {
    const from = polyline[index]!;
    const to = polyline[index + 1]!;
    const tangent = Math.atan2(to.y - from.y, to.x - from.x);
    if (!Number.isFinite(tangent)) continue;
    const waypoint = nearestWaypoint(waypoints, from);
    const yaw = waypoint?.yaw;
    if (yaw == null || !Number.isFinite(yaw)) continue;
    const aligned = Math.cos(tangent - (yaw * Math.PI) / 180);
    if (Math.abs(aligned) < ALIGNMENT_EPSILON) continue;
    votes += aligned > 0 ? 1 : -1;
  }
  return votes === 0 ? null : votes > 0;
}

/**
 * Travel heading in degrees for the polyline vertex starting edge `index`.
 *
 * The tangent gives the geometry; `followsTravel` gives the sense. Kept as the
 * polyline's own tangent (rather than the crawl waypoint's yaw verbatim) so the
 * emitted heading stays consistent with the emitted vertices — a car placed by
 * interpolating this centerline should face along the line it sits on.
 *
 * Normalised to [-180, 180), the basis `spawn_yaw` uses.
 */
export function travelHeadingDegrees(
  from: { x: number; y: number },
  to: { x: number; y: number },
  followsTravel: boolean,
): number {
  const tangent = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  if (followsTravel) return tangent;
  return ((tangent + 180 + 540) % 360) - 180;
}
