import type {
  RuntimeRoadSegment,
  RuntimeWaypointRef,
} from "@/app/lib/runtime/runtime-types";

export function segmentLengthMeters(segment: RuntimeRoadSegment): number {
  const points = segment.centerline;
  if (!points || points.length < 2) return 0;
  return Math.abs((points[points.length - 1]?.s ?? 0) - (points[0]?.s ?? 0));
}

export function rslFromWaypointRef(
  waypoint: RuntimeWaypointRef | null | undefined,
): string | null {
  if (waypoint?.rsl) return waypoint.rsl;
  if (
    waypoint?.road_id == null ||
    waypoint.section_id == null ||
    waypoint.lane_id == null
  ) {
    return null;
  }
  return `${waypoint.road_id}:${waypoint.section_id}:${waypoint.lane_id}`;
}

export function segmentRsl(segment: RuntimeRoadSegment): string {
  return `${segment.road_id}:${segment.section_id}:${segment.lane_id}`;
}

/** Lane types the subject can drive on, CASE-INSENSITIVELY.
 *
 * The runtime-bundle road network spells these "Driving"/"Bidirectional" (CARLA's
 * own casing); the semantic road network — which the generator reads since the
 * semantic-map migration — spells them "driving"/"bidirectional". A case-SENSITIVE
 * compare here silently classified every semantic lane as undrivable, so
 * candidatesForStrategy returned 0 for every strategy on every map and the batch
 * generator emitted nothing at all, reporting only "No valid runtime topology
 * candidates". Normalize; never compare raw. */
const DRIVABLE_LANE_TYPES = new Set(["driving", "bidirectional"]);

export function laneTypeIs(
  segment: RuntimeRoadSegment | null | undefined,
  laneType: string,
): boolean {
  return String(segment?.lane_type ?? "").toLowerCase() === laneType.toLowerCase();
}

function isDrivableLaneType(segment: RuntimeRoadSegment | null | undefined): boolean {
  return DRIVABLE_LANE_TYPES.has(String(segment?.lane_type ?? "").toLowerCase());
}

export function isDrivableSegment(segment: RuntimeRoadSegment | null | undefined) {
  if (!segment) return false;
  return !segment.is_junction && isDrivableLaneType(segment);
}

// Like isDrivableSegment but INCLUDING junction connecting lanes — for ROUTE traversal
// (the subject drives THROUGH junctions), as opposed to spawn/candidate placement (which must
// avoid junctions). Matches the segments survivalRunwayMeters counts as forward runway, so
// the route a stop subject gets delivers the runway the placement gate vetted.
export function isRoutableSegment(segment: RuntimeRoadSegment | null | undefined) {
  if (!segment) return false;
  return isDrivableLaneType(segment);
}

export function laneChangePermitted(
  segment: RuntimeRoadSegment,
  side: "left" | "right",
): boolean {
  // CARLA's TM honours the OpenDRIVE lane-change marking even on
  // force_lane_change; on generated OSM maps most lanes are NONE (solid), so
  // placing an subject lane change there yields a clip where the subject just drives
  // straight. Probe measured 361/446 NONE segments on Di Rosa. Adjacent-lane
  // traffic density is exempt: those cars spawn in the lane, never cross it.
  const permission = String(segment.lane_change ?? "NONE").toLowerCase();
  return permission === "both" || permission === side;
}

export function laneChangeTarget(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  segment: RuntimeRoadSegment,
  side: "left" | "right",
) {
  if (!laneChangePermitted(segment, side)) return null;
  return adjacentSameDirectionLane(segments, segment, side);
}

export function adjacentSameDirectionLane(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  segment: RuntimeRoadSegment,
  side: "left" | "right",
) {
  const adjacentRsl = rslFromWaypointRef(side === "left" ? segment.left_lane : segment.right_lane);
  if (!adjacentRsl) return null;
  const target = segments.get(adjacentRsl);
  if (!target || !isDrivableSegment(target)) return null;
  const currentLaneId = Number(segment.lane_id);
  const targetLaneId = Number(target.lane_id);
  const sameDirection =
    laneTypeIs(segment, "Bidirectional") ||
    laneTypeIs(target, "Bidirectional") ||
    (Number.isFinite(currentLaneId) &&
      Number.isFinite(targetLaneId) &&
      Math.sign(currentLaneId) === Math.sign(targetLaneId));
  return sameDirection ? target : null;
}

/**
 * Opposite-direction Driving lanes on the same road/section (OpenDRIVE-style:
 * opposite travel direction = opposite sign of lane_id). Junction-internal
 * lanes are excluded — traffic spawned there straddles the intersection box.
 * left_lane/right_lane refs often stop at the road centerline on generated
 * maps, so this scans the segment index instead of walking neighbor refs.
 * Returns the innermost lanes first (smallest |lane_id| — closest to the
 * subject's side, most visible to the front camera) in a deterministic order.
 */
export function oppositeDirectionLanes(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  segment: RuntimeRoadSegment,
  limit: number,
): RuntimeRoadSegment[] {
  const currentLaneId = Number(segment.lane_id);
  if (!Number.isFinite(currentLaneId) || currentLaneId === 0) return [];
  const found: RuntimeRoadSegment[] = [];
  for (const other of segments.values()) {
    if (String(other.road_id) !== String(segment.road_id)) continue;
    if ((other.section_id ?? null) !== (segment.section_id ?? null)) continue;
    if (other.is_junction) continue;
    if (!laneTypeIs(other, "Driving")) continue;
    const otherLaneId = Number(other.lane_id);
    if (!Number.isFinite(otherLaneId) || otherLaneId === 0) continue;
    if (Math.sign(otherLaneId) === Math.sign(currentLaneId)) continue;
    found.push(other);
  }
  return found
    .sort((a, b) => Math.abs(Number(a.lane_id)) - Math.abs(Number(b.lane_id)))
    .slice(0, limit);
}

export function hasKnownDrivableSuccessor(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  segment: RuntimeRoadSegment,
) {
  // Junction connecting-lanes COUNT as a drivable continuation (isRoutableSegment,
  // not isDrivableSegment): on these grids most mid-block lanes feed straight into
  // a junction, and the route builder already drives THROUGH junctions
  // (buildForwardRouteThroughSuccessors). The old !is_junction predicate rejected
  // every such lane with no_drivable_successor even though a valid route exists.
  const selfRsl = segmentRsl(segment);
  return Boolean(
    segment.successors?.some((successor) => {
      const successorRsl = rslFromWaypointRef(successor);
      if (!successorRsl || successorRsl === selfRsl) return false;
      return isRoutableSegment(segments.get(successorRsl));
    }),
  );
}

export function segmentEndsAtJunctionEntry(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  segment: RuntimeRoadSegment,
) {
  return Boolean(
    segment.successors?.some((successor) => {
      const successorRsl = rslFromWaypointRef(successor);
      const successorSegment = successorRsl ? segments.get(successorRsl) : null;
      return Boolean(successorSegment?.is_junction);
    }),
  );
}

export function hasTurn(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  segment: RuntimeRoadSegment,
  relation: "Left" | "Right",
) {
  const option = segment.turn_options?.find((candidate) => candidate.relation === relation);
  if (!option) return false;
  const entryRsl = rslFromWaypointRef(option.entry_waypoint);
  const lookaheadRsl = rslFromWaypointRef(option.lookahead_waypoint);
  return Boolean((!entryRsl || segments.has(entryRsl)) && (!lookaheadRsl || segments.has(lookaheadRsl)));
}

export function turnExitSegment(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  segment: RuntimeRoadSegment,
  relation: "Left" | "Right" | "Straight",
): RuntimeRoadSegment | null {
  const option = segment.turn_options?.find((candidate) => candidate.relation === relation);
  if (!option) return null;
  const exitRsl =
    rslFromWaypointRef(option.lookahead_waypoint) ?? rslFromWaypointRef(option.entry_waypoint);
  // Turn exits frequently point at junction-internal connecting lanes;
  // those are valid continuations (the survival walk handles what follows).
  return exitRsl ? (segments.get(exitRsl) ?? null) : null;
}
