import type {
  RuntimeBoundMapTopologyIndex,
  SemanticMapGraph,
} from "@simforge-oss/studio-shared";
import { laneTravelIncreasesS, travelOrderedPolyline } from "@simforge-oss/studio-shared";
import type {
  RuntimeRoadSegment,
  RuntimeWaypointRef,
} from "@/app/lib/runtime/runtime-types";

type Point = { x: number; y: number; z: number | null };

function distance(left: Point, right: Point): number {
  return Math.hypot(right.x - left.x, right.y - left.y, (right.z ?? 0) - (left.z ?? 0));
}

function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1]!, points[index]!);
  }
  return total;
}

function pointAtArc(points: readonly Point[], targetArcM: number): Point {
  if (points.length === 0) return { x: 0, y: 0, z: null };
  if (points.length === 1) return points[0]!;
  const target = Math.max(0, targetArcM);
  let walked = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const length = distance(start, end);
    if (walked + length >= target && length > 1e-9) {
      const fraction = Math.min(1, Math.max(0, (target - walked) / length));
      return {
        x: start.x + (end.x - start.x) * fraction,
        y: start.y + (end.y - start.y) * fraction,
        z: start.z == null || end.z == null
          ? start.z ?? end.z ?? null
          : start.z + (end.z - start.z) * fraction,
      };
    }
    walked += length;
  }
  return points.at(-1)!;
}

function slicePolyline(
  points: readonly Point[],
  startArcM: number,
  endArcM: number,
): Point[] {
  if (points.length < 2) return [];
  const length = polylineLength(points);
  const start = Math.min(length, Math.max(0, startArcM));
  const end = Math.min(length, Math.max(start, endArcM));
  const result: Point[] = [pointAtArc(points, start)];
  let walked = 0;
  for (let index = 1; index < points.length; index += 1) {
    walked += distance(points[index - 1]!, points[index]!);
    if (walked > start + 1e-6 && walked < end - 1e-6) {
      result.push(points[index]!);
    }
  }
  result.push(pointAtArc(points, end));
  return result.filter((point, index) => {
    const prior = result[index - 1];
    return !prior || distance(prior, point) > 1e-6;
  });
}

/**
 * The lane's centreline in the order it is DRIVEN.
 *
 * The direction comes from the index, where it was resolved from CARLA's
 * waypoint yaw — not from the lane-id sign, which is a convention OpenDRIVE
 * does not guarantee. See `@simforge-oss/studio-shared` `lane-travel.ts`.
 */
function topologyTravelPolyline(
  topology: RuntimeBoundMapTopologyIndex,
  lane: RuntimeBoundMapTopologyIndex["lanes"][string],
): Point[] {
  const points = lane.polyline.map(({ x, y }) => ({ x, y, z: null }));
  return travelOrderedPolyline(
    points,
    laneTravelIncreasesS(topology.laneTravelIncreasesS, lane.rsl, lane.laneId),
  );
}

function movementLaneGeometry(
  graph: SemanticMapGraph,
  topology: RuntimeBoundMapTopologyIndex,
): Map<string, Point[]> {
  const geometry = new Map<string, Point[]>();
  for (const corridor of graph.corridors) {
    for (const fragment of corridor.runtimeFragments) {
      const points = slicePolyline(
        corridor.polyline,
        fragment.startArcM,
        fragment.endArcM,
      );
      if (points.length >= 2) geometry.set(fragment.rsl, points);
    }
  }

  const variants = [...graph.movementVariants].sort((left, right) => {
    const status = Number(right.authoringStatus === "authorable") - Number(left.authoringStatus === "authorable");
    return status || left.id.localeCompare(right.id);
  });
  for (const variant of variants) {
    const rsls = variant.runtimeLaneRsls;
    if (rsls.length < 3 || variant.polyline.length < 2) continue;
    const total = polylineLength(variant.polyline);
    const cuts = new Array<number>(rsls.length + 1).fill(0);
    cuts[0] = 0;
    cuts[1] = Math.min(total, variant.entryStationM);
    cuts[rsls.length - 1] = Math.min(total, Math.max(cuts[1]!, variant.exitStationM));
    cuts[rsls.length] = total;
    const internal = rsls.slice(1, -1);
    const internalStart = cuts[1]!;
    const internalEnd = cuts[rsls.length - 1]!;
    const weights = internal.map((rsl) => {
      const lane = topology.lanes[rsl];
      return lane ? Math.max(1e-6, polylineLength(topologyTravelPolyline(topology, lane))) : 1;
    });
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);
    let weightWalked = 0;
    for (let index = 1; index < rsls.length - 1; index += 1) {
      weightWalked += weights[index - 1]!;
      cuts[index + 1] = internalStart + (internalEnd - internalStart) * (weightWalked / weightTotal);
    }
    for (let index = 0; index < rsls.length; index += 1) {
      const rsl = rsls[index]!;
      if (geometry.has(rsl)) continue;
      const points = slicePolyline(variant.polyline, cuts[index]!, cuts[index + 1]!);
      if (points.length >= 2) geometry.set(rsl, points);
    }
  }
  return geometry;
}

function waypointRef(
  topology: RuntimeBoundMapTopologyIndex,
  rsl: string | null | undefined,
): RuntimeWaypointRef | null {
  if (!rsl) return null;
  const lane = topology.lanes[rsl];
  if (!lane) return null;
  return {
    rsl,
    road_id: lane.roadId,
    section_id: lane.section,
    lane_id: lane.laneId,
    lane_type: lane.laneType,
    lane_width: lane.representativeWidthM ?? null,
    is_junction: lane.isJunction,
    junction_id: lane.junctionId == null ? null : Number(lane.junctionId),
  };
}

function allowedLaneChange(
  lane: RuntimeBoundMapTopologyIndex["lanes"][string],
): string {
  const allowed = new Set(
    (lane.laneChangePermissions ?? [])
      .filter((row) => row.allowed)
      .map((row) => row.side),
  );
  if (allowed.has("left") && allowed.has("right")) return "Both";
  if (allowed.has("left")) return "Left";
  if (allowed.has("right")) return "Right";
  return "None";
}

function centerline(points: readonly Point[]) {
  let arcM = 0;
  return points.map((point, index) => {
    if (index > 0) arcM += distance(points[index - 1]!, point);
    const before = points[Math.max(0, index - 1)]!;
    const after = points[Math.min(points.length - 1, index + 1)]!;
    const yaw = Math.atan2(after.y - before.y, after.x - before.x) * 180 / Math.PI;
    return { x: point.x, y: point.y, z: point.z ?? 0, yaw, s: arcM };
  });
}

/**
 * Project the accepted semantic publication into the bounded lane-record shape
 * used by older deterministic planners. Geometry comes from semantic corridors
 * and movement variants first; XODR topology geometry is only a provenance-
 * verified fallback. This adapter lets legacy algorithms migrate without ever
 * composing or reading a central runtime bundle.
 */
export function semanticRoadSegments(
  graph: SemanticMapGraph,
  topology: RuntimeBoundMapTopologyIndex,
): RuntimeRoadSegment[] {
  const exactGeometry = movementLaneGeometry(graph, topology);
  const bound = new Set(topology.runtimeParity.boundLaneRsls);
  const gatesByApproach = new Map<string, typeof topology.gates>();
  for (const gate of topology.gates) {
    gatesByApproach.set(gate.approachLaneRsl, [
      ...(gatesByApproach.get(gate.approachLaneRsl) ?? []),
      gate,
    ]);
  }
  return Object.values(topology.lanes)
    .filter((lane) => bound.has(lane.rsl))
    .sort((left, right) => left.rsl.localeCompare(right.rsl))
    .flatMap((lane) => {
      const points = exactGeometry.get(lane.rsl) ?? topologyTravelPolyline(topology, lane);
      if (points.length < 2) return [];
      const line = centerline(points);
      const left = lane.adjacentLanes?.left?.sameDirection
        ? waypointRef(topology, lane.adjacentLanes.left.laneRsl)
        : null;
      const right = lane.adjacentLanes?.right?.sameDirection
        ? waypointRef(topology, lane.adjacentLanes.right.laneRsl)
        : null;
      const laneChange = allowedLaneChange(lane);
      const refs = {
        start: { ...waypointRef(topology, lane.rsl)!, s: 0 },
        mid: { ...waypointRef(topology, lane.rsl)!, s: line.at(-1)!.s / 2 },
        end: { ...waypointRef(topology, lane.rsl)!, s: line.at(-1)!.s },
      };
      return [{
        id: lane.rsl,
        road_id: lane.roadId,
        section_id: lane.section,
        lane_id: lane.laneId,
        lane_type: lane.laneType,
        is_junction: lane.isJunction,
        lane_change: laneChange,
        lane_width: lane.representativeWidthM ?? null,
        left_lane_id: left?.lane_id ?? null,
        right_lane_id: right?.lane_id ?? null,
        left_lane: left,
        right_lane: right,
        successors: lane.successors.map((rsl) => waypointRef(topology, rsl)).filter((row): row is RuntimeWaypointRef => row != null),
        predecessors: lane.predecessors.map((rsl) => waypointRef(topology, rsl)).filter((row): row is RuntimeWaypointRef => row != null),
        turn_options: (gatesByApproach.get(lane.rsl) ?? []).map((gate) => ({
          relation: gate.turnRelation,
          branch_waypoint: waypointRef(topology, gate.connectingLaneRsl),
          entry_waypoint: waypointRef(topology, gate.approachLaneRsl),
          junction_exit_waypoint: waypointRef(topology, gate.exitLaneRsls[0]),
          heading_delta_degrees: gate.headingChangeRad * 180 / Math.PI,
          classification_source: "semantic_execution_index",
        })),
        lane_start_waypoint: refs.start,
        lane_end_waypoint: refs.end,
        start_waypoint: refs.start,
        mid_waypoint: refs.mid,
        end_waypoint: refs.end,
        centerline: line.map((point) => ({
          ...point,
          lane_change: laneChange,
          lane_width: lane.representativeWidthM ?? null,
          left_lane: left,
          right_lane: right,
        })),
      } satisfies RuntimeRoadSegment];
    });
}
