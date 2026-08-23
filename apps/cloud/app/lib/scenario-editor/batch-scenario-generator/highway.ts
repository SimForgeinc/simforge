import type { RuntimeRoadSegment } from "@/app/lib/runtime/runtime-types";
import { isDrivableSegment, laneTypeIs, rslFromWaypointRef, segmentRsl } from "./graph";

// Geometric highway detection, ported from the monolith generator (iteration 5):
// the map generator types every road "town" with 40 mph records, so road
// type/speed cannot be used — a highway lane is one whose travel direction has
// >= 3 parallel Driving lanes. On our maps this admits the P1 I-680 freeway,
// Bollinger Canyon Road, and the widest El Camino / Page Mill arterials.
export const HIGHWAY_MIN_SAME_DIRECTION_LANES = 3;
// Ramps/connectors are NARROW: at most this many same-direction lanes.
export const HIGHWAY_RAMP_MAX_SAME_DIRECTION_LANES = 2;
// Max successor hops walked through a gore/junction chain to resolve the ramp
// (exit) or the mainline (entry).
const HIGHWAY_CHAIN_MAX_HOPS = 6;

/** Lanes on the same (road, section) with the same lane_id sign travel
 * together. */
export function sameDirectionLaneCountKey(segment: RuntimeRoadSegment): string {
  const sign = Number(segment.lane_id) < 0 ? "neg" : "pos";
  return `${segment.road_id}:${segment.section_id ?? ""}:${sign}`;
}

/** One-pass count of non-junction Driving lanes per (road, section,
 * direction) — the geometric basis for highway detection. */
export function buildSameDirectionLaneCounts(
  segments: Iterable<RuntimeRoadSegment>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const segment of segments) {
    if (segment.is_junction) continue;
    if (!laneTypeIs(segment, "Driving")) continue;
    const laneId = Number(segment.lane_id);
    if (!Number.isFinite(laneId) || laneId === 0) continue;
    const key = sameDirectionLaneCountKey(segment);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Per-segments-map memo so placement-time lookups don't rebuild the counts
 * for every candidate. */
const sameDirectionLaneCountsCache = new WeakMap<object, Map<string, number>>();

export function sameDirectionLaneCountsFor(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
): Map<string, number> {
  let counts = sameDirectionLaneCountsCache.get(segments);
  if (!counts) {
    counts = buildSameDirectionLaneCounts(segments.values());
    sameDirectionLaneCountsCache.set(segments, counts);
  }
  return counts;
}

export function isHighwayLane(
  counts: ReadonlyMap<string, number>,
  segment: RuntimeRoadSegment,
): boolean {
  if (segment.is_junction) return false;
  if (!laneTypeIs(segment, "Driving")) return false;
  return (
    (counts.get(sameDirectionLaneCountKey(segment)) ?? 0) >= HIGHWAY_MIN_SAME_DIRECTION_LANES
  );
}

function resolvedSuccessors(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  from: RuntimeRoadSegment,
): RuntimeRoadSegment[] {
  const fromRsl = segmentRsl(from);
  return (from.successors ?? [])
    .map((ref) => rslFromWaypointRef(ref))
    .filter((rsl): rsl is string => Boolean(rsl) && rsl !== fromRsl)
    .map((rsl) => segments.get(rsl))
    .filter((seg): seg is RuntimeRoadSegment => Boolean(seg))
    .sort((a, b) => segmentRsl(a).localeCompare(segmentRsl(b)));
}

/**
 * highway_exit: resolve the gore chain from a mainline highway lane onto a
 * NARROW ramp on a different road. Unlike the monolith's iteration-5 gate
 * (single-successor gore only — a TM constraint: TM extends its waypoint
 * buffer through forks pseudo-randomly), the emitted subject here is a
 * ROUTE-FOLLOWER, so the branch choice is deterministic and FORKED gores are
 * admissible: at each hop pick the branch whose continuation actually leaves
 * the highway. Returns the ordered chain [connector..., ramp] or null.
 */
export function highwayExitChainForCandidate(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  counts: ReadonlyMap<string, number>,
  segment: RuntimeRoadSegment,
): RuntimeRoadSegment[] | null {
  const isRamp = (seg: RuntimeRoadSegment): boolean => {
    if (seg.is_junction || !isDrivableSegment(seg)) return false;
    if (String(seg.road_id) === String(segment.road_id)) return false;
    const lanes = counts.get(sameDirectionLaneCountKey(seg)) ?? 0;
    return lanes > 0 && lanes <= HIGHWAY_RAMP_MAX_SAME_DIRECTION_LANES;
  };
  // DFS over successor branches (deterministic order), bounded by hop count.
  // A branch that stays on the highway (same road / >= 3 lanes) is not an
  // exit; the first branch reaching a narrow different-road lane wins.
  const walk = (
    from: RuntimeRoadSegment,
    chain: RuntimeRoadSegment[],
    visited: Set<string>,
  ): RuntimeRoadSegment[] | null => {
    if (chain.length > HIGHWAY_CHAIN_MAX_HOPS) return null;
    for (const next of resolvedSuccessors(segments, from)) {
      const rsl = segmentRsl(next);
      if (visited.has(rsl)) continue;
      if (isRamp(next)) return [...chain, next];
      // Only continue THROUGH junction connectors — a non-junction successor
      // that isn't a ramp is the mainline continuing (not an exit path).
      if (!next.is_junction) continue;
      visited.add(rsl);
      const found = walk(next, [...chain, next], visited);
      if (found) return found;
    }
    return null;
  };
  return walk(segment, [], new Set([segmentRsl(segment)]));
}

/**
 * highway_entry: the candidate is a NARROW non-highway lane (the on-ramp);
 * resolve the merge chain through junction connectors onto a mainline highway
 * lane. Returns the ordered chain [connector..., highwayLane] or null.
 */
export function highwayEntryChainForCandidate(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  counts: ReadonlyMap<string, number>,
  segment: RuntimeRoadSegment,
): RuntimeRoadSegment[] | null {
  if (segment.is_junction || !isDrivableSegment(segment)) return null;
  const ownLanes = counts.get(sameDirectionLaneCountKey(segment)) ?? 0;
  if (ownLanes === 0 || ownLanes > HIGHWAY_RAMP_MAX_SAME_DIRECTION_LANES) return null;
  const walk = (
    from: RuntimeRoadSegment,
    chain: RuntimeRoadSegment[],
    visited: Set<string>,
  ): RuntimeRoadSegment[] | null => {
    if (chain.length > HIGHWAY_CHAIN_MAX_HOPS) return null;
    for (const next of resolvedSuccessors(segments, from)) {
      const rsl = segmentRsl(next);
      if (visited.has(rsl)) continue;
      if (isHighwayLane(counts, next) && String(next.road_id) !== String(segment.road_id)) {
        return [...chain, next];
      }
      // Merge chains run through junction connectors and short narrow
      // acceleration-lane stubs; both may precede the mainline.
      const nextLanes = counts.get(sameDirectionLaneCountKey(next)) ?? 0;
      const isConnector =
        next.is_junction ||
        (isDrivableSegment(next) && nextLanes <= HIGHWAY_RAMP_MAX_SAME_DIRECTION_LANES);
      if (!isConnector) continue;
      visited.add(rsl);
      const found = walk(next, [...chain, next], visited);
      if (found) return found;
    }
    return null;
  };
  return walk(segment, [], new Set([segmentRsl(segment)]));
}
