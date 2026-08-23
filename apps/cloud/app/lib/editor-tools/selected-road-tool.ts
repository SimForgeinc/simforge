import type { MapLocation } from "@/app/lib/editor-map/types";
import type { RoadRecord } from "@/app/lib/runtime/map-data";
import type { RuntimeRoadSummary } from "@/app/lib/runtime/runtime-types";

export type ManageSelectedRoadsAction =
  | "add"
  | "remove"
  | "replace"
  | "clear"
  | "inspect";

export type ManageSelectedRoadsInput = {
  action: ManageSelectedRoadsAction;
  source: "manual" | "current_location";
  manualRoadIds?: string[];
  currentLocation?: MapLocation | null;
};

export type ManagedSelectedRoad = {
  road_id: string;
  name: string;
  lane_types: string[];
  length_m: number | null;
  is_intersection: boolean;
  junction_id: string | null;
  junction_side: "start" | "end" | null;
  role: "approach" | "intersection_internal" | "isolated";
  approach_direction: string | null;
  departure_direction: string | null;
};

export type SelectedRoadAnchor = {
  anchor_id: string;
  road_id: string;
  anchor_type:
    | "near_junction"
    | "midblock"
    | "far_from_junction"
    | "intersection_center"
    | "roadside_left"
    | "roadside_right";
  fraction: number;
  side: "left" | "right" | "center";
  lane_preference: "driving" | "any";
  description: string;
};

export type RecommendedActorPlacement = {
  placement_id: string;
  actor_role_hint: "ego" | "traffic" | "any";
  road_id: string;
  anchor_id: string | null;
  fraction: number;
  placement_purpose:
    | "approach_spawn"
    | "midblock_spawn"
    | "conflict_position"
    | "roadside_position";
  reason: string;
};

export type RecommendedCrossingPair = {
  pair_id: string;
  left_road_id: string;
  right_road_id: string;
  angle_delta_deg: number;
  left_direction: string | null;
  right_direction: string | null;
  score: number;
  reasons: string[];
  suggested_actor_placements: [RecommendedActorPlacement, RecommendedActorPlacement];
};

export type SelectedRoadNetworkSummary = {
  connected_components: number;
  junction_ids: string[];
  total_length_m: number;
  lane_types: string[];
  intersection_road_ids: string[];
  approach_road_ids: string[];
  boundary_road_ids: string[];
  internal_road_ids: string[];
  isolated_road_ids: string[];
  crossing_pairs: Array<{
    junction_id: string;
    left_road_id: string;
    right_road_id: string;
    angle_delta_deg: number;
    left_direction: string | null;
    right_direction: string | null;
  }>;
  anchors: SelectedRoadAnchor[];
  anchor_groups: {
    spawn_anchors: SelectedRoadAnchor[];
    conflict_anchors: SelectedRoadAnchor[];
    roadside_anchors: SelectedRoadAnchor[];
    center_anchors: SelectedRoadAnchor[];
  };
  placement_summary: {
    area_type:
      | "empty"
      | "intersection"
      | "road_segment"
      | "parking_or_roadside"
      | "multi_component"
      | "mixed";
    primary_junction_id: string | null;
    recommended_strategy: string;
    usable_actor_road_ids: string[];
    avoid_for_actor_spawn: string[];
    reasoning: string[];
  };
  recommended_crossing_pairs: RecommendedCrossingPair[];
  recommended_actor_placements: RecommendedActorPlacement[];
  constraints: {
    drivable_road_ids: string[];
    parking_capable_road_ids: string[];
    roadside_capable_road_ids: string[];
    roads_without_driving_lanes: string[];
  };
  components: Array<{
    index: number;
    road_ids: string[];
    total_length_m: number;
  }>;
  junctions: Array<{
    junction_id: string;
    selected_road_ids: string[];
    selected_road_count: number;
    incoming_roads: Array<{
      road_id: string;
      name: string;
      direction: string | null;
      junction_side: "start" | "end" | null;
    }>;
    outgoing_roads: Array<{
      road_id: string;
      name: string;
      direction: string | null;
      junction_side: "start" | "end" | null;
    }>;
    crossing_pairs: Array<{
      left_road_id: string;
      right_road_id: string;
      angle_delta_deg: number;
    }>;
  }>;
  warnings: string[];
};

export type ManageSelectedRoadsResult = {
  action: ManageSelectedRoadsAction;
  selected_road_ids: string[];
  total_selected: number;
  added_road_ids?: string[];
  removed_road_ids?: string[];
  roads: ManagedSelectedRoad[];
  network_summary: SelectedRoadNetworkSummary;
};

function uniqueRoadIds(roadIds: string[]) {
  return [...new Set(roadIds.map((roadId) => roadId.trim()).filter(Boolean))];
}

function parseSvgPathPoints(path: string): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const re = /([ML])\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(path)) !== null) {
    points.push({ x: Number(match[2]), y: Number(match[3]) });
  }
  return points;
}

function averagePoint(points: Array<{ x: number; y: number }>) {
  if (points.length === 0) return { x: 0, y: 0 };
  const totals = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 },
  );
  return { x: totals.x / points.length, y: totals.y / points.length };
}

function distance(left: { x: number; y: number }, right: { x: number; y: number }) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function bearingToCardinal(angleDegrees: number): string {
  const normalized = ((angleDegrees % 360) + 360) % 360;
  if (normalized >= 337.5 || normalized < 22.5) return "eastbound";
  if (normalized < 67.5) return "north-east";
  if (normalized < 112.5) return "northbound";
  if (normalized < 157.5) return "north-west";
  if (normalized < 202.5) return "westbound";
  if (normalized < 247.5) return "south-west";
  if (normalized < 292.5) return "southbound";
  return "south-east";
}

function directionBetweenPoints(start: { x: number; y: number }, end: { x: number; y: number }) {
  const angle = (Math.atan2(-(end.y - start.y), end.x - start.x) * 180) / Math.PI;
  return bearingToCardinal(angle);
}

function angleForDirection(direction: string | null) {
  if (direction === "eastbound") return 0;
  if (direction === "north-east") return 45;
  if (direction === "northbound") return 90;
  if (direction === "north-west") return 135;
  if (direction === "westbound") return 180;
  if (direction === "south-west") return 225;
  if (direction === "southbound") return 270;
  if (direction === "south-east") return 315;
  return null;
}

function smallestAngleDelta(left: number, right: number) {
  const diff = Math.abs(left - right) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function anchorForRoad(
  anchors: SelectedRoadAnchor[],
  roadId: string,
  preferredTypes: SelectedRoadAnchor["anchor_type"][],
) {
  for (const anchorType of preferredTypes) {
    const anchor = anchors.find(
      (candidate) =>
        candidate.road_id === roadId &&
        candidate.anchor_type === anchorType &&
        candidate.lane_preference === "driving",
    );
    if (anchor) return anchor;
  }
  return anchors.find(
    (candidate) =>
      candidate.road_id === roadId && candidate.lane_preference === "driving",
  ) ?? null;
}

function placementFromAnchor(
  anchor: SelectedRoadAnchor | null,
  input: {
    roadId: string;
    actorRoleHint: RecommendedActorPlacement["actor_role_hint"];
    fallbackFraction: number;
    purpose: RecommendedActorPlacement["placement_purpose"];
    reason: string;
  },
): RecommendedActorPlacement {
  return {
    placement_id: `${input.actorRoleHint}:${input.roadId}:${anchor?.anchor_type ?? input.purpose}`,
    actor_role_hint: input.actorRoleHint,
    road_id: input.roadId,
    anchor_id: anchor?.anchor_id ?? null,
    fraction: anchor?.fraction ?? input.fallbackFraction,
    placement_purpose: input.purpose,
    reason: anchor ? `${input.reason} Anchor: ${anchor.description}` : input.reason,
  };
}

function buildAnchorGroups(anchors: SelectedRoadAnchor[]) {
  return {
    spawn_anchors: anchors.filter((anchor) =>
      anchor.lane_preference === "driving" &&
      (anchor.anchor_type === "far_from_junction" ||
        anchor.anchor_type === "midblock" ||
        anchor.anchor_type === "near_junction"),
    ),
    conflict_anchors: anchors.filter(
      (anchor) =>
        anchor.anchor_type === "near_junction" ||
        anchor.anchor_type === "intersection_center",
    ),
    roadside_anchors: anchors.filter(
      (anchor) =>
        anchor.anchor_type === "roadside_left" ||
        anchor.anchor_type === "roadside_right",
    ),
    center_anchors: anchors.filter(
      (anchor) => anchor.anchor_type === "intersection_center",
    ),
  };
}

function buildRecommendedCrossingPairs(
  crossingPairs: SelectedRoadNetworkSummary["crossing_pairs"],
  anchors: SelectedRoadAnchor[],
  drivableRoadIds: string[],
  roadsById: Map<string, RoadRecord>,
): RecommendedCrossingPair[] {
  const drivable = new Set(drivableRoadIds);
  return crossingPairs
    .map((pair) => {
      const leftDrivable = drivable.has(pair.left_road_id);
      const rightDrivable = drivable.has(pair.right_road_id);
      const leftLaneTypes = new Set(
        roadsById.get(pair.left_road_id)?.sections.flatMap((section) => section.laneTypes) ?? [],
      );
      const rightLaneTypes = new Set(
        roadsById.get(pair.right_road_id)?.sections.flatMap((section) => section.laneTypes) ?? [],
      );
      const reasons: string[] = [];
      let score = 100 - Math.abs(pair.angle_delta_deg - 90) * 2;
      if (leftDrivable && rightDrivable) {
        score += 30;
        reasons.push("Both roads have drivable lanes.");
      } else {
        score -= 60;
        reasons.push("One or both roads lack drivable lanes.");
      }
      if (pair.left_direction && pair.right_direction) {
        score += 10;
        reasons.push(`Clear crossing directions: ${pair.left_direction} vs ${pair.right_direction}.`);
      }
      if (leftLaneTypes.has("biking") || rightLaneTypes.has("biking")) {
        score -= 20;
        reasons.push("One road includes biking lanes; prefer driving-only pairs for vehicle actors.");
      }
      if (pair.angle_delta_deg === 90) {
        reasons.push("Exact 90 degree crossing.");
      }

      const leftAnchor = anchorForRoad(
        anchors,
        pair.left_road_id,
        ["far_from_junction", "midblock", "near_junction", "intersection_center"],
      );
      const rightAnchor = anchorForRoad(
        anchors,
        pair.right_road_id,
        ["far_from_junction", "midblock", "near_junction", "intersection_center"],
      );

      return {
        pair_id: `${pair.junction_id}:${pair.left_road_id}:${pair.right_road_id}`,
        ...pair,
        score,
        reasons,
        suggested_actor_placements: [
          placementFromAnchor(leftAnchor, {
            roadId: pair.left_road_id,
            actorRoleHint: "ego",
            fallbackFraction: 0.5,
            purpose:
              leftAnchor == null || leftAnchor.anchor_type === "intersection_center"
                ? "conflict_position"
                : "approach_spawn",
            reason: "Use this as the primary actor placement for the crossing pair.",
          }),
          placementFromAnchor(rightAnchor, {
            roadId: pair.right_road_id,
            actorRoleHint: "traffic",
            fallbackFraction: 0.5,
            purpose:
              rightAnchor == null || rightAnchor.anchor_type === "intersection_center"
                ? "conflict_position"
                : "approach_spawn",
            reason: "Use this as the secondary actor placement for the crossing pair.",
          }),
        ],
      } satisfies RecommendedCrossingPair;
    })
    .filter((pair) => pair.score > 0)
    .sort((left, right) => right.score - left.score || left.pair_id.localeCompare(right.pair_id))
    .slice(0, 5);
}

function buildRecommendedActorPlacements(
  anchors: SelectedRoadAnchor[],
  recommendedCrossingPairs: RecommendedCrossingPair[],
): RecommendedActorPlacement[] {
  const placements = new Map<string, RecommendedActorPlacement>();
  for (const pair of recommendedCrossingPairs.slice(0, 2)) {
    for (const placement of pair.suggested_actor_placements) {
      placements.set(placement.placement_id, placement);
    }
  }
  for (const anchor of anchors) {
    if (placements.size >= 8) break;
    if (
      anchor.lane_preference === "driving" &&
      (anchor.anchor_type === "far_from_junction" || anchor.anchor_type === "midblock")
    ) {
      const purpose =
        anchor.anchor_type === "far_from_junction"
          ? "approach_spawn"
          : "midblock_spawn";
      const placement = placementFromAnchor(anchor, {
        roadId: anchor.road_id,
        actorRoleHint: "any",
        fallbackFraction: anchor.fraction,
        purpose,
        reason: "General-purpose actor placement from inspected road anchors.",
      });
      placements.set(placement.placement_id, placement);
    }
  }
  return [...placements.values()];
}

function buildPlacementSummary(input: {
  selectedRoadIds: string[];
  components: Array<{ road_ids: string[] }>;
  junctions: SelectedRoadNetworkSummary["junctions"];
  intersectionRoadIds: string[];
  approachRoadIds: string[];
  isolatedRoadIds: string[];
  drivableRoadIds: string[];
  parkingCapableRoadIds: string[];
  roadsideCapableRoadIds: string[];
  roadsWithoutDrivingLanes: string[];
  recommendedCrossingPairs: RecommendedCrossingPair[];
  anchorGroups: ReturnType<typeof buildAnchorGroups>;
}) {
  const reasoning: string[] = [];
  const primaryJunctionId = input.junctions[0]?.junction_id ?? null;
  const hasJunction = input.junctions.length > 0;
  const hasParking = input.parkingCapableRoadIds.length > 0 || input.roadsideCapableRoadIds.length > 0;
  const hasMultipleComponents = input.components.length > 1;
  const area_type: SelectedRoadNetworkSummary["placement_summary"]["area_type"] =
    input.selectedRoadIds.length === 0
      ? "empty"
      : hasMultipleComponents
        ? "multi_component"
        : hasJunction
          ? "intersection"
          : hasParking
            ? "parking_or_roadside"
            : input.selectedRoadIds.length > 0
              ? "road_segment"
              : "mixed";

  if (hasMultipleComponents) reasoning.push("Selected roads span multiple disconnected components; prefer one component for a coherent scenario.");
  if (hasJunction) reasoning.push(`Primary junction ${primaryJunctionId} has ${input.junctions[0]?.selected_road_count ?? 0} selected road(s).`);
  if (input.intersectionRoadIds.length > 0) reasoning.push(`${input.intersectionRoadIds.length} internal intersection road(s) were selected; center anchors are representative conflict positions, not default spawn points.`);
  if (input.approachRoadIds.length > 0) reasoning.push(`${input.approachRoadIds.length} approach road(s) are available for vehicle spawning.`);
  if (input.recommendedCrossingPairs.length > 0) reasoning.push(`${input.recommendedCrossingPairs.length} ranked crossing pair(s) are available; prefer recommended_crossing_pairs over raw crossing_pairs.`);
  if (input.roadsWithoutDrivingLanes.length > 0) reasoning.push(`Avoid ${input.roadsWithoutDrivingLanes.length} road(s) without driving lanes for vehicle actors.`);

  const usableActorRoadIds = input.drivableRoadIds.filter(
    (roadId) => !input.roadsWithoutDrivingLanes.includes(roadId),
  );
  const avoidForActorSpawn = [
    ...new Set([
      ...input.roadsWithoutDrivingLanes,
      ...(input.anchorGroups.spawn_anchors.length > 0
        ? input.intersectionRoadIds.filter(
            (roadId) => input.anchorGroups.spawn_anchors.every((anchor) => anchor.road_id !== roadId),
          )
        : []),
    ]),
  ];

  const recommended_strategy =
    area_type === "intersection"
      ? "Use recommended_crossing_pairs for crossing interactions. Spawn moving vehicles on approach or far/midblock anchors when available; use intersection_center as a conflict/target point rather than a default spawn."
      : area_type === "parking_or_roadside"
        ? "Use roadside_anchors for parked vehicles, props, or curbside interactions; use spawn_anchors for moving vehicles."
        : area_type === "multi_component"
          ? "Choose one connected component before placing actors, unless the scenario intentionally spans disconnected areas."
          : area_type === "road_segment"
            ? "Use midblock or far_from_junction anchors for vehicle placement."
            : "Select a coherent road or location before placing actors.";

  return {
    area_type,
    primary_junction_id: primaryJunctionId,
    recommended_strategy,
    usable_actor_road_ids: usableActorRoadIds,
    avoid_for_actor_spawn: avoidForActorSpawn,
    reasoning,
  } satisfies SelectedRoadNetworkSummary["placement_summary"];
}

function resolveRequestedRoadIds(input: ManageSelectedRoadsInput) {
  if (input.action === "clear" || input.action === "inspect") return [];
  if (input.source === "current_location") {
    return uniqueRoadIds(input.currentLocation?.road_ids ?? []);
  }
  return uniqueRoadIds(input.manualRoadIds ?? []);
}

function buildRoadCatalog(
  selectedRoadIds: string[],
  generatedRoads: RoadRecord[],
  runtimeRoadSummaries: RuntimeRoadSummary[],
  interactionByRoadId: Map<string, {
    junction_id: string | null;
    junction_side: "start" | "end" | null;
    approach_direction: string | null;
    departure_direction: string | null;
  }>,
): ManagedSelectedRoad[] {
  const runtimeById = new Map(runtimeRoadSummaries.map((road) => [String(road.id), road]));
  const generatedById = new Map(generatedRoads.map((road) => [String(road.id), road]));

  return selectedRoadIds.map((roadId) => {
    const generated = generatedById.get(roadId);
    const runtime = runtimeById.get(roadId);
    const interaction = interactionByRoadId.get(roadId);
    return {
      road_id: roadId,
      name: runtime?.name ?? generated?.name ?? `Road ${roadId}`,
      lane_types:
        runtime?.lane_types ??
        [...new Set(generated?.sections.flatMap((section) => section.laneTypes) ?? [])],
      length_m: generated?.length ?? null,
      is_intersection: runtime?.is_intersection ?? generated?.isIntersection ?? false,
      junction_id: interaction?.junction_id ?? null,
      junction_side: interaction?.junction_side ?? null,
      role:
        runtime?.is_intersection ?? generated?.isIntersection
          ? "intersection_internal"
          : interaction?.junction_id
            ? "approach"
            : "isolated",
      approach_direction: interaction?.approach_direction ?? null,
      departure_direction: interaction?.departure_direction ?? null,
    };
  });
}

function buildNetworkSummary(
  selectedRoadIds: string[],
  generatedRoads: RoadRecord[],
) {
  const selectedRoads = generatedRoads.filter((road) => selectedRoadIds.includes(String(road.id)));
  const roadsById = new Map(selectedRoads.map((road) => [String(road.id), road]));
  const sharedJunctionRoadIds = new Map<string, string[]>();
  const laneTypes = new Set<string>();
  const interactionByRoadId = new Map<string, {
    junction_id: string | null;
    junction_side: "start" | "end" | null;
    approach_direction: string | null;
    departure_direction: string | null;
  }>();

  for (const road of selectedRoads) {
    for (const section of road.sections) {
      for (const laneType of section.laneTypes) laneTypes.add(laneType);
    }
    if (!road.junctionId || road.junctionId === "-1") continue;
    const current = sharedJunctionRoadIds.get(road.junctionId) ?? [];
    current.push(String(road.id));
    sharedJunctionRoadIds.set(road.junctionId, current);
  }

  for (const road of selectedRoads) {
    const roadId = String(road.id);
    const points = parseSvgPathPoints(road.path);
    const start = points[0] ?? null;
    const end = points[points.length - 1] ?? null;

    if (!start || !end || !road.junctionId || road.junctionId === "-1") {
      interactionByRoadId.set(roadId, {
        junction_id: null,
        junction_side: null,
        approach_direction: null,
        departure_direction: null,
      });
      continue;
    }

    const peerEndpoints = (sharedJunctionRoadIds.get(road.junctionId) ?? [])
      .flatMap((peerRoadId) => {
        const peerRoad = roadsById.get(peerRoadId);
        if (!peerRoad) return [];
        const peerPoints = parseSvgPathPoints(peerRoad.path);
        const peerStart = peerPoints[0] ?? null;
        const peerEnd = peerPoints[peerPoints.length - 1] ?? null;
        return [peerStart, peerEnd].filter((point): point is { x: number; y: number } => point !== null);
      });
    const centroid = averagePoint(peerEndpoints);
    const junction_side = distance(start, centroid) <= distance(end, centroid) ? "start" : "end";

    interactionByRoadId.set(roadId, {
      junction_id: road.junctionId,
      junction_side,
      approach_direction:
        junction_side === "start"
          ? directionBetweenPoints(end, start)
          : directionBetweenPoints(start, end),
      departure_direction:
        junction_side === "start"
          ? directionBetweenPoints(start, end)
          : directionBetweenPoints(end, start),
    });
  }

  const visited = new Set<string>();
  const components: Array<{
    index: number;
    road_ids: string[];
    total_length_m: number;
  }> = [];

  for (const roadId of selectedRoadIds) {
    if (visited.has(roadId)) continue;
    const componentRoadIds: string[] = [];
    const queue = [roadId];
    visited.add(roadId);

    while (queue.length > 0) {
      const currentRoadId = queue.shift()!;
      componentRoadIds.push(currentRoadId);
      const road = roadsById.get(currentRoadId);
      if (!road?.junctionId || road.junctionId === "-1") continue;
      for (const neighbor of sharedJunctionRoadIds.get(road.junctionId) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }

    components.push({
      index: components.length + 1,
      road_ids: componentRoadIds,
      total_length_m: componentRoadIds.reduce(
        (sum, currentRoadId) => sum + (roadsById.get(currentRoadId)?.length ?? 0),
        0,
      ),
    });
  }

  const selectedNeighborCount = new Map<string, number>();
  for (const roadId of selectedRoadIds) {
    selectedNeighborCount.set(roadId, 0);
  }
  for (const roadIds of sharedJunctionRoadIds.values()) {
    for (const roadId of roadIds) {
      selectedNeighborCount.set(
        roadId,
        Math.max(
          selectedNeighborCount.get(roadId) ?? 0,
          Math.max(0, roadIds.length - 1),
        ),
      );
    }
  }

  const intersectionRoadIds = selectedRoads
    .filter((road) => road.isIntersection)
    .map((road) => String(road.id));
  const approachRoadIds = selectedRoads
    .filter((road) => !road.isIntersection && road.junctionId && road.junctionId !== "-1")
    .map((road) => String(road.id));
  const isolatedRoadIds = selectedRoadIds.filter(
    (roadId) => (selectedNeighborCount.get(roadId) ?? 0) === 0,
  );
  const boundaryRoadIds = selectedRoadIds.filter((roadId) => {
    const road = roadsById.get(roadId);
    if (!road || !road.junctionId || road.junctionId === "-1") return false;
    return (selectedNeighborCount.get(roadId) ?? 0) <= 1;
  });
  const internalRoadIds = selectedRoadIds.filter((roadId) => {
    const road = roadsById.get(roadId);
    if (!road || !road.junctionId || road.junctionId === "-1") return false;
    return (selectedNeighborCount.get(roadId) ?? 0) > 1;
  });

  const junctions = [...sharedJunctionRoadIds.entries()]
    .map(([junctionId, roadIds]) => {
      const incoming_roads = roadIds.map((roadId) => {
        const road = roadsById.get(roadId);
        const interaction = interactionByRoadId.get(roadId);
        return {
          road_id: roadId,
          name: road?.name || `Road ${roadId}`,
          direction: interaction?.approach_direction ?? null,
          junction_side: interaction?.junction_side ?? null,
        };
      });
      const outgoing_roads = roadIds.map((roadId) => {
        const road = roadsById.get(roadId);
        const interaction = interactionByRoadId.get(roadId);
        return {
          road_id: roadId,
          name: road?.name || `Road ${roadId}`,
          direction: interaction?.departure_direction ?? null,
          junction_side: interaction?.junction_side ?? null,
        };
      });
      const crossing_pairs = roadIds.flatMap((leftRoadId, leftIndex) => {
        const leftAngle = angleForDirection(interactionByRoadId.get(leftRoadId)?.approach_direction ?? null);
        if (leftAngle == null) return [];
        return roadIds.slice(leftIndex + 1).flatMap((rightRoadId) => {
          const rightAngle = angleForDirection(interactionByRoadId.get(rightRoadId)?.approach_direction ?? null);
          if (rightAngle == null) return [];
          const angleDelta = smallestAngleDelta(leftAngle, rightAngle);
          if (angleDelta < 45 || angleDelta > 135) return [];
          return [{
            left_road_id: leftRoadId,
            right_road_id: rightRoadId,
            angle_delta_deg: angleDelta,
          }];
        });
      });
      return {
        junction_id: junctionId,
        selected_road_ids: roadIds,
        selected_road_count: roadIds.length,
        incoming_roads,
        outgoing_roads,
        crossing_pairs,
      };
    })
    .sort((left, right) => right.selected_road_count - left.selected_road_count);

  const crossing_pairs = junctions.flatMap((junction) =>
    junction.crossing_pairs.map((pair) => ({
      junction_id: junction.junction_id,
      left_road_id: pair.left_road_id,
      right_road_id: pair.right_road_id,
      angle_delta_deg: pair.angle_delta_deg,
      left_direction:
        interactionByRoadId.get(pair.left_road_id)?.approach_direction ?? null,
      right_direction:
        interactionByRoadId.get(pair.right_road_id)?.approach_direction ?? null,
    })),
  );

  const drivableRoadIds = selectedRoadIds.filter((roadId) =>
    (roadsById.get(roadId)?.sections ?? []).some((section) =>
      section.laneTypes.some((laneType) => laneType === "driving" || laneType === "bidirectional"),
    ),
  );
  const parkingCapableRoadIds = selectedRoadIds.filter((roadId) =>
    (roadsById.get(roadId)?.sections ?? []).some((section) =>
      section.laneTypes.includes("parking"),
    ),
  );
  const roadsideCapableRoadIds = selectedRoadIds.filter((roadId) =>
    (roadsById.get(roadId)?.sections ?? []).some((section) =>
      section.laneTypes.some((laneType) =>
        laneType === "parking" || laneType === "shoulder" || laneType === "sidewalk",
      ),
    ),
  );
  const roadsWithoutDrivingLanes = selectedRoadIds.filter(
    (roadId) => !drivableRoadIds.includes(roadId),
  );

  const anchors: SelectedRoadAnchor[] = [];
  const emittedIntersectionCenterJunctionIds = new Set<string>();
  for (const roadId of selectedRoadIds) {
    const road = roadsById.get(roadId);
    const interaction = interactionByRoadId.get(roadId);
    if (!road) continue;

    if (road.isIntersection) {
      const junctionKey =
        road.junctionId && road.junctionId !== "-1"
          ? road.junctionId
          : `road:${roadId}`;
      if (emittedIntersectionCenterJunctionIds.has(junctionKey)) continue;
      emittedIntersectionCenterJunctionIds.add(junctionKey);
      const internalRoadCount = selectedRoads.filter(
        (candidate) =>
          candidate.isIntersection &&
          ((candidate.junctionId && candidate.junctionId !== "-1"
            ? candidate.junctionId
            : `road:${String(candidate.id)}`) === junctionKey),
      ).length;
      anchors.push(
        {
          anchor_id: `${junctionKey}:intersection_center`,
          road_id: roadId,
          anchor_type: "intersection_center" as const,
          fraction: 0.5,
          side: "center" as const,
          lane_preference: "driving" as const,
          description:
            internalRoadCount > 1
              ? `Representative midpoint for junction ${junctionKey}; collapsed ${internalRoadCount} internal intersection roads into one center anchor.`
              : "Midpoint inside the selected intersection road.",
        },
      );
      continue;
    }

    if (interaction?.junction_side) {
      const nearFraction = interaction.junction_side === "end" ? 0.85 : 0.15;
      const midFraction = interaction.junction_side === "end" ? 0.55 : 0.45;
      const farFraction = interaction.junction_side === "end" ? 0.25 : 0.75;
      anchors.push(
        {
          anchor_id: `${roadId}:near_junction`,
          road_id: roadId,
          anchor_type: "near_junction" as const,
          fraction: nearFraction,
          side: "center" as const,
          lane_preference: "driving" as const,
          description: "Approach anchor near the shared junction.",
        },
        {
          anchor_id: `${roadId}:midblock`,
          road_id: roadId,
          anchor_type: "midblock" as const,
          fraction: midFraction,
          side: "center" as const,
          lane_preference: "driving" as const,
          description: "Mid-road driving anchor between the junction and road midpoint.",
        },
        {
          anchor_id: `${roadId}:far_from_junction`,
          road_id: roadId,
          anchor_type: "far_from_junction" as const,
          fraction: farFraction,
          side: "center" as const,
          lane_preference: "driving" as const,
          description: "Driving anchor farther away from the shared junction.",
        },
        {
          anchor_id: `${roadId}:roadside_left`,
          road_id: roadId,
          anchor_type: "roadside_left" as const,
          fraction: midFraction,
          side: "left" as const,
          lane_preference: "any" as const,
          description: "Generic roadside/curbside anchor on the left side of the road.",
        },
        {
          anchor_id: `${roadId}:roadside_right`,
          road_id: roadId,
          anchor_type: "roadside_right" as const,
          fraction: midFraction,
          side: "right" as const,
          lane_preference: "any" as const,
          description: "Generic roadside/curbside anchor on the right side of the road.",
        },
      );
      continue;
    }

    anchors.push(
      {
        anchor_id: `${roadId}:midblock`,
        road_id: roadId,
        anchor_type: "midblock" as const,
        fraction: 0.5,
        side: "center" as const,
        lane_preference: "driving" as const,
        description: "Generic mid-road anchor on an isolated or non-junction road.",
      },
      {
        anchor_id: `${roadId}:roadside_left`,
        road_id: roadId,
        anchor_type: "roadside_left" as const,
        fraction: 0.5,
        side: "left" as const,
        lane_preference: "any" as const,
        description: "Generic roadside/curbside anchor on the left side of the road.",
      },
      {
        anchor_id: `${roadId}:roadside_right`,
        road_id: roadId,
        anchor_type: "roadside_right" as const,
        fraction: 0.5,
        side: "right" as const,
        lane_preference: "any" as const,
        description: "Generic roadside/curbside anchor on the right side of the road.",
      },
    );
  }

  const warnings: string[] = [];
  if (selectedRoadIds.length === 0) warnings.push("No selected roads.");
  if (components.length > 1) warnings.push("Selected roads are split into multiple disconnected components.");
  if (sharedJunctionRoadIds.size === 0 && selectedRoadIds.length > 0) warnings.push("Selected roads do not share any detected junctions.");
  const anchor_groups = buildAnchorGroups(anchors);
  const recommended_crossing_pairs = buildRecommendedCrossingPairs(
    crossing_pairs,
    anchors,
    drivableRoadIds,
    roadsById,
  );
  const recommended_actor_placements = buildRecommendedActorPlacements(
    anchors,
    recommended_crossing_pairs,
  );
  const placement_summary = buildPlacementSummary({
    selectedRoadIds,
    components,
    junctions,
    intersectionRoadIds,
    approachRoadIds,
    isolatedRoadIds,
    drivableRoadIds,
    parkingCapableRoadIds,
    roadsideCapableRoadIds,
    roadsWithoutDrivingLanes,
    recommendedCrossingPairs: recommended_crossing_pairs,
    anchorGroups: anchor_groups,
  });

  return {
    connected_components: components.length,
    junction_ids: [...sharedJunctionRoadIds.keys()],
    total_length_m: selectedRoads.reduce((sum, road) => sum + (road.length ?? 0), 0),
    lane_types: [...laneTypes].sort(),
    intersection_road_ids: intersectionRoadIds,
    approach_road_ids: approachRoadIds,
    boundary_road_ids: boundaryRoadIds,
    internal_road_ids: internalRoadIds,
    isolated_road_ids: isolatedRoadIds,
    crossing_pairs,
    anchors,
    anchor_groups,
    placement_summary,
    recommended_crossing_pairs,
    recommended_actor_placements,
    constraints: {
      drivable_road_ids: drivableRoadIds,
      parking_capable_road_ids: parkingCapableRoadIds,
      roadside_capable_road_ids: roadsideCapableRoadIds,
      roads_without_driving_lanes: roadsWithoutDrivingLanes,
    },
    components,
    junctions,
    warnings,
    interaction_by_road_id: interactionByRoadId,
  };
}

export function runManageSelectedRoads(
  currentSelectedRoadIds: string[],
  input: ManageSelectedRoadsInput,
  generatedRoads: RoadRecord[],
  runtimeRoadSummaries: RuntimeRoadSummary[],
): ManageSelectedRoadsResult {
  const requestedRoadIds = resolveRequestedRoadIds(input);
  let nextSelectedRoadIds = [...currentSelectedRoadIds];
  let addedRoadIds: string[] = [];
  let removedRoadIds: string[] = [];

  if (input.action === "add") {
    addedRoadIds = requestedRoadIds.filter((roadId) => !nextSelectedRoadIds.includes(roadId));
    nextSelectedRoadIds = uniqueRoadIds([...nextSelectedRoadIds, ...requestedRoadIds]);
  } else if (input.action === "remove") {
    removedRoadIds = requestedRoadIds.filter((roadId) => nextSelectedRoadIds.includes(roadId));
    nextSelectedRoadIds = nextSelectedRoadIds.filter((roadId) => !requestedRoadIds.includes(roadId));
  } else if (input.action === "replace") {
    addedRoadIds = requestedRoadIds.filter((roadId) => !nextSelectedRoadIds.includes(roadId));
    removedRoadIds = nextSelectedRoadIds.filter((roadId) => !requestedRoadIds.includes(roadId));
    nextSelectedRoadIds = requestedRoadIds;
  } else if (input.action === "clear") {
    removedRoadIds = [...nextSelectedRoadIds];
    nextSelectedRoadIds = [];
  }

  const summaryWithInteraction = buildNetworkSummary(nextSelectedRoadIds, generatedRoads);
  const interactionByRoadId = (summaryWithInteraction as typeof summaryWithInteraction & {
    interaction_by_road_id: Map<string, {
      junction_id: string | null;
      junction_side: "start" | "end" | null;
      approach_direction: string | null;
      departure_direction: string | null;
    }>;
  }).interaction_by_road_id;
  const { interaction_by_road_id: _interactionByRoadId, ...network_summary } = summaryWithInteraction as typeof summaryWithInteraction & {
    interaction_by_road_id: Map<string, {
      junction_id: string | null;
      junction_side: "start" | "end" | null;
      approach_direction: string | null;
      departure_direction: string | null;
    }>;
  };
  const roads = buildRoadCatalog(
    nextSelectedRoadIds,
    generatedRoads,
    runtimeRoadSummaries,
    interactionByRoadId,
  );

  return {
    action: input.action,
    selected_road_ids: nextSelectedRoadIds,
    total_selected: nextSelectedRoadIds.length,
    added_road_ids: addedRoadIds,
    removed_road_ids: removedRoadIds,
    roads,
    network_summary,
  };
}
