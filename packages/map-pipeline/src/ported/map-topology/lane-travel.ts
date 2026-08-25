import type { MapTopologyIndex, RuntimeBoundMapTopologyIndex } from "./types";

/**
 * A topology index that MAY carry CARLA's resolved travel directions.
 *
 * Bound indexes do; a bare XODR parse does not. Taking this rather than
 * `MapTopologyIndex` lets a function prefer the resolved answer when its
 * caller has one, without forcing every caller to have one.
 */
export type TravelAwareTopologyIndex = MapTopologyIndex &
  Partial<Pick<RuntimeBoundMapTopologyIndex, "laneTravelIncreasesS">>;

/**
 * The lane-id sign convention: negative ids sit right of the reference line
 * and run with `+s`, positive ids sit left and run against it.
 *
 * THE LAST RESORT, and the only place in the codebase allowed to state it.
 * OpenDRIVE does not guarantee it — left-hand-traffic roads invert it, and
 * junction connector ids carry no such meaning — so it is a guess about the
 * single fact that decides which way a vehicle faces. Reach for
 * `laneTravelIncreasesS` instead wherever a bound index is in scope; this
 * exists for the layers that genuinely run before the CARLA crawl is
 * available (the XODR parse itself) and for lanes the crawl never covered.
 *
 * It holds on every map published today — San Ramon P1 1999/1999, Munich
 * 389/389, measured against the crawl — which is precisely why it survived
 * unexamined for so long.
 */
export function laneTravelIncreasesSByConvention(
  laneId: number | null | undefined,
): boolean {
  return (laneId ?? -1) < 0;
}

/**
 * Whether a lane is DRIVEN along increasing `s`.
 *
 * Prefers the answer CARLA resolved from the OpenDRIVE (stamped onto the bound
 * index at bind time from the waypoint crawl's yaw) and falls back to the lane
 * sign only where the crawl never reached — an unbound lane, or an index
 * compiled before the field existed.
 *
 * Use this anywhere a heading, a travel-ordered polyline, or an s-fraction
 * flip is derived from a lane. Passing a bare lane id and inferring the rest
 * is the bug this replaces.
 */
export function laneTravelIncreasesS(
  resolvedByRsl: RuntimeBoundMapTopologyIndex["laneTravelIncreasesS"],
  rsl: string,
  laneId: number | null | undefined,
): boolean {
  return resolvedByRsl?.[rsl] ?? laneTravelIncreasesSByConvention(laneId);
}

/**
 * Whether a lane is DRIVEN along increasing `s`, read off the CRAWLED geometry.
 *
 * Each centerline sample carries the yaw CARLA reported at that waypoint, which
 * is the direction of TRAVEL there. Comparing it against the tangent of the
 * s-sorted polyline answers the question directly, per lane, using nothing but
 * that lane's own samples. Every sample votes so a single bad yaw near a
 * junction cannot flip the lane.
 *
 * Prefer this over any derivation that reads a NEIGHBOURING record. `s` restarts
 * at 0 on every road, so comparing a lane's `s` against its successor's compares
 * two unrelated axes: on Di Rosa 602 of 628 topology edges leave their lane, and
 * that comparison inverted 76 of 479 lanes — including `78:1:-3`, which put a
 * car authored 54 m along its lane back at the lane's start.
 *
 * Falls back to {@link laneTravelIncreasesSByConvention} when no sample carries a
 * usable yaw (an un-crawled lane), which is the same last resort the rest of this
 * module uses.
 */
export function laneTravelIncreasesSFromCenterline(
  centerline: readonly { x: number; y: number; yaw?: number | null }[],
  laneId: number | null | undefined,
): boolean {
  let votes = 0;
  for (let index = 0; index < centerline.length - 1; index += 1) {
    const from = centerline[index]!;
    const to = centerline[index + 1]!;
    const yaw = from.yaw;
    if (yaw == null || !Number.isFinite(yaw)) continue;
    const tangent = Math.atan2(to.y - from.y, to.x - from.x);
    if (!Number.isFinite(tangent)) continue;
    const aligned = Math.cos(tangent - (yaw * Math.PI) / 180);
    if (Math.abs(aligned) < 1e-6) continue;
    votes += aligned > 0 ? 1 : -1;
  }
  if (votes !== 0) return votes > 0;
  return laneTravelIncreasesSByConvention(laneId);
}

/**
 * A lane's polyline in the order it is DRIVEN.
 *
 * The stored polyline is always in s-increasing order, so half a real map's
 * lanes are stored backwards relative to travel.
 */
export function travelOrderedPolyline<T>(
  points: readonly T[],
  travelIncreasesS: boolean,
): T[] {
  return travelIncreasesS ? [...points] : [...points].reverse();
}

/**
 * Convert between a fraction along `+s` and a fraction along travel.
 *
 * Self-inverse: the same flip converts either way.
 */
export function flipFractionForTravel(
  fraction: number,
  travelIncreasesS: boolean,
): number {
  const bounded = Math.min(1, Math.max(0, fraction));
  return travelIncreasesS ? bounded : 1 - bounded;
}
