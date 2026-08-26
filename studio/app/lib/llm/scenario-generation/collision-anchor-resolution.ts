import type {
  CollisionAnchorStrategy,
  ScenarioEditorActorDraft,
  ScenarioEditorRoadAnchor,
} from "@simforge-oss/studio-shared";
import type {
  GeometryLaneSample,
  GeometryReport,
} from "@/app/lib/maps/search/server/inspect-location-geometry";

function pickDrivableLane(
  lanes: readonly GeometryLaneSample[],
  used: Set<string>,
): GeometryLaneSample | null {
  for (const lane of lanes) {
    if (lane.lane_type !== "driving" && lane.lane_type !== "bidirectional") continue;
    const key = laneKey(lane);
    if (used.has(key)) continue;
    return lane;
  }
  return null;
}

function pickOppositeDirectionLane(
  lanes: readonly GeometryLaneSample[],
  subject: GeometryLaneSample,
  used: Set<string>,
): GeometryLaneSample | null {
  const subjectSign = Math.sign(subject.lane_id);
  for (const lane of lanes) {
    if (lane.lane_type !== "driving" && lane.lane_type !== "bidirectional") continue;
    if (lane.road_id !== subject.road_id) continue;
    if (Math.sign(lane.lane_id) === subjectSign) continue;
    const key = laneKey(lane);
    if (used.has(key)) continue;
    return lane;
  }
  // Fallback: opposite-sign lane on any nearby road
  for (const lane of lanes) {
    if (lane.lane_type !== "driving" && lane.lane_type !== "bidirectional") continue;
    if (Math.sign(lane.lane_id) === subjectSign) continue;
    const key = laneKey(lane);
    if (used.has(key)) continue;
    return lane;
  }
  return null;
}

function pickAdjacentLane(
  lanes: readonly GeometryLaneSample[],
  subject: GeometryLaneSample,
  used: Set<string>,
): GeometryLaneSample | null {
  const subjectSign = Math.sign(subject.lane_id);
  for (const lane of lanes) {
    if (lane.lane_type !== "driving" && lane.lane_type !== "bidirectional") continue;
    if (lane.road_id !== subject.road_id) continue;
    if (lane.lane_id === subject.lane_id) continue;
    if (Math.sign(lane.lane_id) !== subjectSign) continue;
    const key = laneKey(lane);
    if (used.has(key)) continue;
    return lane;
  }
  return null;
}

function pickSidewalkLane(
  lanes: readonly GeometryLaneSample[],
  used: Set<string>,
): GeometryLaneSample | null {
  for (const lane of lanes) {
    if (lane.lane_type !== "sidewalk") continue;
    const key = laneKey(lane);
    if (used.has(key)) continue;
    return lane;
  }
  return null;
}

export function laneKey(lane: GeometryLaneSample): string {
  return `${lane.road_id}:${lane.section_id}:${lane.lane_id}`;
}

/**
 * Actors are placed either on a road lane (canonical) or — when the
 * document is a crosswalk/sidewalk POI and no walkable lane is exposed
 * in the runtime road network within radius — directly at the
 * document's projected center point. The "point" fallback prevents
 * pedestrian drafts from failing on maps whose XODR doesn't encode
 * sidewalks as separate lanes, which is common for Overture-derived
 * crosswalk POIs ([WAY-...].kind === "crosswalk_zone").
 */
export type ActorPlacement =
  | {
      kind: "lane";
      lane: GeometryLaneSample;
      /** Optional override for `spawn.s_fraction`. Used by approach-lane
       *  placement to push the spawn near the start of the segment so the
       *  actor has runway to drive toward the target. Defaults to 0.5
       *  (lane midpoint) when omitted. */
      s_fraction?: number;
    }
  | { kind: "point"; point: { x: number; y: number } }
  | {
      /**
       * Walker-only. Resolves to `placement_mode: "timed_path"` on the
       * actor draft. The trajectory IS the motion: CARLA traces the
       * walker through the timed waypoints, regardless of timeline
       * actions (walkers can't use follow_route / ram_actor anyway,
       * see `timelineActionsForActor` in actor-utils).
       *
       * `spawnPoint` matches `waypoints[0]` and is what the editor
       * preview reads when `placement_mode === "timed_path"`.
       */
      kind: "timed_path";
      spawnPoint: { x: number; y: number };
      waypoints: ReadonlyArray<{ x: number; y: number; time: number }>;
    };

/**
 * Approximate half-width of an urban road (one lane + parking + sidewalk
 * shoulder). Multiplied by 2 below to span both sides of a 2-lane road
 * during pedestrian crossings. Not parameter-tuned per-map — the
 * resulting 8m crossing is good enough for most urban geometry and
 * forgiving when CARLA's collision dynamics resolve the conflict.
 */
const PEDESTRIAN_CROSSING_HALF_WIDTH_M = 4;
/**
 * Walker waits at the curb for this many seconds before stepping out,
 * giving subject time to enter the conflict zone. The wait is modeled directly
 * in timed-path waypoint timestamps rather than as a timeline action.
 */
const PEDESTRIAN_HOLD_SECONDS = 3;
/**
 * Total walk duration once the walker steps off the curb. Combined
 * with the hold time, the walker is mid-road at ~t=PEDESTRIAN_HOLD +
 * (CROSSING_DURATION / 2), which is the natural collision moment for
 * a 15s scenario with subject entering around t=4–6s.
 */
const PEDESTRIAN_CROSSING_DURATION_S = 6;

/**
 * Project a point onto a lane's centerline — returns the foot of the
 * perpendicular plus the lane direction vector. Used both to position
 * the walker relative to subject's lane (so the crossing actually
 * intersects subject's path) and to push subject's `destination_point` past
 * the crossing so autopilot routes through it.
 */
function projectPointOntoLane(
  point: { x: number; y: number },
  lane: GeometryLaneSample,
): {
  projected: { x: number; y: number };
  dirX: number;
  dirY: number;
  /** Signed perpendicular offset of `point` from the lane centerline. */
  perpOffset: number;
} {
  const dirX = Math.cos(lane.midpoint_yaw_rad);
  const dirY = Math.sin(lane.midpoint_yaw_rad);
  const dx = point.x - lane.midpoint.x;
  const dy = point.y - lane.midpoint.y;
  // Project onto the lane direction (signed scalar along the line).
  const along = dx * dirX + dy * dirY;
  const projected = {
    x: lane.midpoint.x + along * dirX,
    y: lane.midpoint.y + along * dirY,
  };
  // Signed perpendicular component (along the (-sin, cos) perpendicular).
  const perpOffset = dx * -Math.sin(lane.midpoint_yaw_rad) + dy * Math.cos(lane.midpoint_yaw_rad);
  return { projected, dirX, dirY, perpOffset };
}

/**
 * Compute a timed-path trajectory for a walker crossing the road subject
 * is on. Returns null when there is no drivable lane to project onto
 * — caller falls back to point placement (walker stationary).
 *
 * Why we project onto subject's lane: previously we picked the nearest
 * drivable lane to the document center, which could be a side road
 * with a different orientation — the walker then crossed perpendicular
 * to the wrong road and never intersected subject's path. Projecting the
 * document center onto subject's lane fixes both the orientation (walker
 * crosses subject's direction of travel) AND the position (walker spawns
 * close enough to subject's lane that an 8m crossing actually traverses
 * it). When `subjectAnchor` is null (rare — subject placement failed), falls
 * back to the closest drivable lane in the report so we don't entirely
 * lose the walker.
 *
 * Walker starts curb-side on the document-center side of the lane
 * (mimics the bus-stop / sidewalk / parking-lot side) and walks
 * perpendicular across to the opposite curb. Hold for
 * PEDESTRIAN_HOLD_SECONDS so subject has runway, then walk across over
 * PEDESTRIAN_CROSSING_DURATION_S.
 */
export function computePedestrianCrossing(
  geometry: GeometryReport,
  subjectAnchor: GeometryLaneSample | null,
): ActorPlacement | null {
  const center = geometry.documentCenter;
  if (!center) return null;
  const lane =
    subjectAnchor ??
    geometry.availableLanes.find(
      (l) => l.lane_type === "driving" || l.lane_type === "bidirectional",
    );
  if (!lane) return null;

  const { projected, perpOffset } = projectPointOntoLane(center, lane);
  // Perpendicular unit vector (90° CCW from lane heading).
  const perpUnitX = -Math.sin(lane.midpoint_yaw_rad);
  const perpUnitY = Math.cos(lane.midpoint_yaw_rad);
  // Choose the side of the lane the document center is on so the
  // walker spawns on the bus-stop side and crosses toward the far
  // curb. When the doc center is exactly on the lane (perpOffset ≈ 0),
  // default to the +perp side — arbitrary but stable.
  const sign = perpOffset >= 0 ? 1 : -1;
  const start = {
    x: projected.x + perpUnitX * PEDESTRIAN_CROSSING_HALF_WIDTH_M * sign,
    y: projected.y + perpUnitY * PEDESTRIAN_CROSSING_HALF_WIDTH_M * sign,
  };
  const end = {
    x: projected.x - perpUnitX * PEDESTRIAN_CROSSING_HALF_WIDTH_M * sign,
    y: projected.y - perpUnitY * PEDESTRIAN_CROSSING_HALF_WIDTH_M * sign,
  };
  return {
    kind: "timed_path",
    spawnPoint: start,
    waypoints: [
      { x: start.x, y: start.y, time: 0 },
      { x: start.x, y: start.y, time: PEDESTRIAN_HOLD_SECONDS },
      {
        x: end.x,
        y: end.y,
        time: PEDESTRIAN_HOLD_SECONDS + PEDESTRIAN_CROSSING_DURATION_S,
      },
    ],
  };
}

/**
 * For a pedestrian_crossing scenario, compute a destination point past
 * the crossing along subject's lane direction. Used as `destination_point`
 * on the subject actor so CARLA's traffic manager routes through the
 * crossing instead of picking a heuristic turn at the next junction.
 *
 * Returns null when subject isn't lane-placed or the document center isn't
 * resolved — in those cases the walker placement also degrades and
 * setting a destination wouldn't help.
 */
export function computeSubjectDestinationForPedestrianCrossing(
  geometry: GeometryReport,
  subjectAnchor: GeometryLaneSample | null,
): { x: number; y: number } | null {
  if (!subjectAnchor || !geometry.documentCenter) return null;
  const { projected, dirX, dirY } = projectPointOntoLane(
    geometry.documentCenter,
    subjectAnchor,
  );
  // 20m past the crossing along subject's lane — far enough that subject
  // commits to the route through the crossing rather than picking a
  // pre-crossing exit at a junction.
  return {
    x: projected.x + dirX * 20,
    y: projected.y + dirY * 20,
  };
}

/**
 * Pick the best approach lane for subject placement.
 *
 * Inputs: the captured geometry reports for the upstream streets the LLM
 * surfaced via `search_map` with `relation.op = 'upstream_of'`, and the
 * target document's projected center.
 *
 * Rules: only consider drivable / bidirectional lanes whose midpoint
 * heading aligns with the direction toward the target (dot product > 0).
 * Among those, prefer the lane whose midpoint is closest to the target —
 * shorter distance means the subject will reach the target faster, which
 * matters for the 15s scenario duration. Picks `s_fraction: 0.1` so the
 * actor spawns near the segment's start and drives toward its end
 * (which, by construction, is toward the target).
 *
 * Returns null when no forward-facing drivable lane was found across all
 * approach geometries — the caller then falls back to the
 * target-euclidean strategy. Direction-misaligned lanes are NOT used as
 * a silent fallback because the subject would face the wrong way and
 * `follow_route` would carry it backward, which is worse than the
 * euclidean-nearby choice.
 */
function pickApproachLane(
  approachGeometries: readonly GeometryReport[],
  targetCenter: { x: number; y: number } | undefined,
  used: Set<string>,
): { lane: GeometryLaneSample; s_fraction: number } | null {
  if (!targetCenter || approachGeometries.length === 0) return null;
  let best: { lane: GeometryLaneSample; distanceToTarget: number } | null = null;
  for (const report of approachGeometries) {
    for (const lane of report.availableLanes) {
      if (lane.lane_type !== "driving" && lane.lane_type !== "bidirectional") continue;
      if (used.has(laneKey(lane))) continue;
      // Lane heading vector (yaw=0 → +x, runtime is y-up east/north).
      const laneDirX = Math.cos(lane.midpoint_yaw_rad);
      const laneDirY = Math.sin(lane.midpoint_yaw_rad);
      // Vector from this lane's midpoint toward the target document.
      const toTargetX = targetCenter.x - lane.midpoint.x;
      const toTargetY = targetCenter.y - lane.midpoint.y;
      const toTargetLen = Math.hypot(toTargetX, toTargetY);
      if (toTargetLen === 0) continue;
      const dot = (laneDirX * toTargetX + laneDirY * toTargetY) / toTargetLen;
      // Require alignment within ~84° of toward-target — keeps perpendicular
      // and reverse-direction lanes out. cos(84°) ≈ 0.1.
      if (dot < 0.1) continue;
      if (!best || toTargetLen < best.distanceToTarget) {
        best = { lane, distanceToTarget: toTargetLen };
      }
    }
  }
  if (!best) return null;
  // s_fraction 0.1 → spawn near the start of the segment. Combined with
  // the forward-facing filter above, this gives subject runway whose end
  // points toward the target document.
  return { lane: best.lane, s_fraction: 0.1 };
}

export function resolveAnchor(
  strategy: CollisionAnchorStrategy,
  geometry: GeometryReport,
  subjectAnchor: GeometryLaneSample | null,
  used: Set<string>,
  approachGeometries: readonly GeometryReport[] = [],
): ActorPlacement | null {
  const lanes = geometry.availableLanes;
  switch (strategy) {
    case "spawn_on_approach_lane": {
      // Prefer a direction-aware approach lane from the upstream-street
      // geometry reports the LLM surfaced via `search_map upstream_of`.
      // Falls back to the target's euclidean-nearby drivable lane when
      // no approach geometry was provided or none of its lanes face the
      // target — better to spawn near the target than not at all.
      const approach = pickApproachLane(
        approachGeometries,
        geometry.documentCenter,
        used,
      );
      if (approach) {
        return { kind: "lane", lane: approach.lane, s_fraction: approach.s_fraction };
      }
      const lane = pickDrivableLane(lanes, used);
      return lane ? { kind: "lane", lane } : null;
    }
    case "spawn_on_opposing_lane": {
      const lane = subjectAnchor
        ? pickOppositeDirectionLane(lanes, subjectAnchor, used)
        : pickDrivableLane(lanes, used);
      return lane ? { kind: "lane", lane } : null;
    }
    case "spawn_on_adjacent_lane": {
      const lane = subjectAnchor
        ? pickAdjacentLane(lanes, subjectAnchor, used)
        : pickDrivableLane(lanes, used);
      return lane ? { kind: "lane", lane } : null;
    }
    case "spawn_on_pedestrian_area": {
      // Prefer a sidewalk segment; fall back to the closest non-driving
      // lane (parking, shoulder) if no sidewalks were tagged.
      const sidewalk = pickSidewalkLane(lanes, used);
      if (sidewalk) return { kind: "lane", lane: sidewalk };
      for (const lane of lanes) {
        if (lane.lane_type === "driving" || lane.lane_type === "bidirectional") continue;
        const key = laneKey(lane);
        if (used.has(key)) continue;
        return { kind: "lane", lane };
      }
      // Final fallback: when the document IS a pedestrian-bearing POI
      // (crosswalk, sidewalk, bus stop, transit stop, school/hospital/
      // commercial frontage, parking lot/cluster/street parking, or a
      // "Pedestrian At …" occlusion candidate) the location is by
      // definition a pedestrian spawn point even if the XODR doesn't
      // encode a sidewalk lane within radius. Anchor the walker at the
      // document's projected centerpoint and let the editor refine the
      // path. Without this fallback maps with sparse sidewalk coverage
      // (or detector outputs that anchor pedestrians by POI rather than
      // by sidewalk geometry) would reject every pedestrian_crossing
      // draft at a non-crosswalk doc.
      if (geometry.pedestrianSpawn && geometry.documentCenter) {
        return { kind: "point", point: geometry.documentCenter };
      }
      return null;
    }
    case "spawn_on_same_lane_behind":
      return subjectAnchor
        ? { kind: "lane", lane: subjectAnchor }
        : (() => {
            const lane = pickDrivableLane(lanes, used);
            return lane ? { kind: "lane", lane } : null;
          })();
    default:
      return null;
  }
}

export function buildRoadAnchor(
  lane: GeometryLaneSample,
  s_fraction = 0.5,
): ScenarioEditorRoadAnchor {
  return {
    road_id: String(lane.road_id),
    s_fraction,
    lane_id: lane.lane_id,
    section_id: lane.section_id,
  };
}

/**
 * Build a `ScenarioEditorRoadAnchor` from a lane node id (`road:section:lane`)
 * + sFraction. Used by the planner-emit path where the actor's spawn is
 * keyed by lane node, not by `GeometryLaneSample`. Returns null when the
 * id can't be parsed.
 */
export function fallbackAnchorForLaneId(
  laneNodeId: string,
  sFraction: number,
): ScenarioEditorRoadAnchor | null {
  const parts = laneNodeId.split(":");
  if (parts.length !== 3) return null;
  const [roadIdStr, sectionStr, laneStr] = parts;
  const sectionId = Number.parseInt(sectionStr ?? "", 10);
  const laneId = Number.parseInt(laneStr ?? "", 10);
  if (!roadIdStr || Number.isNaN(sectionId) || Number.isNaN(laneId)) return null;
  return {
    road_id: roadIdStr,
    s_fraction: Math.max(0, Math.min(1, sFraction)),
    lane_id: laneId,
    section_id: sectionId,
  };
}

export function emptyNonRoadSpawnAnchor(): ScenarioEditorActorDraft["spawn"] {
  return { road_id: "", s_fraction: 0.5, lane_id: null, section_id: null };
}
