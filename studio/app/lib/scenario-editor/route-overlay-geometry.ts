import type { ScenarioEditorRoadAnchor } from "@simcloud/shared";
import { laneTravelIncreasesSByConvention } from "@simcloud/shared";
import type {
  RuntimeRoadOverlayCollection,
  RuntimeRoadOverlayFeature,
} from "@/app/lib/editor-map/types";

export type RouteOverlayResolution = {
  lines: Array<Array<[number, number]>>;
  unresolvedLegIndexes: number[];
};

export type LaneNode = {
  coordinates: Array<[number, number]>;
  feature: RuntimeRoadOverlayFeature;
  rsl: string;
};

type RouteEdge = {
  from: string;
  kind: "successor" | "lane-change";
  to: string;
};

const LANE_CHANGE_PENALTY_METERS = 25;
const COORDINATE_EPSILON = 1e-9;
const EARTH_RADIUS_METERS = 6_371_008.8;
const laneIndexCache = new WeakMap<
  RuntimeRoadOverlayCollection,
  Map<string, LaneNode>
>();

function clampFraction(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function featureCoordinates(
  feature: RuntimeRoadOverlayFeature,
): Array<[number, number]> {
  return feature.geometry.type === "LineString"
    ? feature.geometry.coordinates
    : (feature.properties.centerline ?? []);
}

function laneRsl(
  value: Pick<ScenarioEditorRoadAnchor, "road_id" | "section_id" | "lane_id">,
) {
  if (
    value.road_id == null ||
    value.section_id == null ||
    value.lane_id == null
  ) {
    return null;
  }
  return `${value.road_id}:${value.section_id}:${value.lane_id}`;
}

function featureRsl(feature: RuntimeRoadOverlayFeature) {
  const { road_id, section_id, lane_id } = feature.properties;
  if (road_id == null || section_id == null || lane_id == null) return null;
  return `${road_id}:${section_id}:${lane_id}`;
}

function isDrivable(feature: RuntimeRoadOverlayFeature) {
  const laneType = String(feature.properties.lane_type ?? "").toLowerCase();
  return (
    feature.properties.feature_kind === "lane_centerline" &&
    feature.properties.source === "runtime" &&
    (laneType === "driving" || laneType === "bidirectional") &&
    featureCoordinates(feature).length >= 2
  );
}

export function buildLaneIndex(overlay: RuntimeRoadOverlayCollection | null) {
  if (!overlay) return new Map<string, LaneNode>();
  const cached = laneIndexCache.get(overlay);
  if (cached) return cached;

  const lanes = new Map<string, LaneNode>();
  for (const feature of overlay.features) {
    if (!isDrivable(feature)) continue;
    const rsl = featureRsl(feature);
    if (!rsl) continue;
    lanes.set(rsl, {
      coordinates: featureCoordinates(feature),
      feature,
      rsl,
    });
  }
  laneIndexCache.set(overlay, lanes);
  return lanes;
}

function geographicDistanceMeters(
  left: [number, number],
  right: [number, number],
) {
  const latitude1 = (left[1] * Math.PI) / 180;
  const latitude2 = (right[1] * Math.PI) / 180;
  const longitudeDelta = ((right[0] - left[0]) * Math.PI) / 180;
  const x = longitudeDelta * Math.cos((latitude1 + latitude2) / 2);
  const y = latitude2 - latitude1;
  return Math.hypot(x, y) * EARTH_RADIUS_METERS;
}

function lineLength(coordinates: Array<[number, number]>) {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    total += geographicDistanceMeters(
      coordinates[index - 1]!,
      coordinates[index]!,
    );
  }
  return total;
}

function pointAtFraction(
  coordinates: Array<[number, number]>,
  fraction: number,
): [number, number] | null {
  if (coordinates.length === 0) return null;
  if (coordinates.length === 1) return coordinates[0]!;
  const total = lineLength(coordinates);
  if (total <= Number.EPSILON) return coordinates[0]!;

  const target = total * clampFraction(fraction);
  let traversed = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1]!;
    const current = coordinates[index]!;
    const segmentLength = geographicDistanceMeters(previous, current);
    if (
      traversed + segmentLength >= target ||
      index === coordinates.length - 1
    ) {
      const local =
        segmentLength <= Number.EPSILON
          ? 0
          : (target - traversed) / segmentLength;
      return [
        previous[0] + (current[0] - previous[0]) * local,
        previous[1] + (current[1] - previous[1]) * local,
      ];
    }
    traversed += segmentLength;
  }
  return coordinates.at(-1) ?? null;
}

function sliceLine(
  coordinates: Array<[number, number]>,
  startFraction: number,
  endFraction: number,
) {
  const start = clampFraction(startFraction);
  const end = clampFraction(endFraction);
  const startPoint = pointAtFraction(coordinates, start);
  const endPoint = pointAtFraction(coordinates, end);
  if (!startPoint || !endPoint) return [];

  const total = lineLength(coordinates);
  if (total <= Number.EPSILON) return [startPoint, endPoint];
  const low = Math.min(start, end) * total;
  const high = Math.max(start, end) * total;
  let traversed = 0;
  const interior: Array<[number, number]> = [];
  for (let index = 1; index < coordinates.length - 1; index += 1) {
    const previous = coordinates[index - 1]!;
    const current = coordinates[index]!;
    traversed += geographicDistanceMeters(previous, current);
    if (
      traversed > low + COORDINATE_EPSILON &&
      traversed < high - COORDINATE_EPSILON
    ) {
      interior.push(current);
    }
  }
  return start <= end
    ? [startPoint, ...interior, endPoint]
    : [startPoint, ...interior.reverse(), endPoint];
}

function endpointDistance(left: [number, number], right: [number, number]) {
  return Math.hypot(left[0] - right[0], left[1] - right[1]);
}

function travelIncreasesFraction(lane: LaneNode, lanes: Map<string, LaneNode>) {
  const successors = lane.feature.properties.successor_rsls ?? [];
  let bestLow = Number.POSITIVE_INFINITY;
  let bestHigh = Number.POSITIVE_INFINITY;
  const low = lane.coordinates[0]!;
  const high = lane.coordinates.at(-1)!;
  for (const successorRsl of successors) {
    const successor = lanes.get(successorRsl);
    if (!successor) continue;
    const successorEnds = [
      successor.coordinates[0]!,
      successor.coordinates.at(-1)!,
    ];
    for (const end of successorEnds) {
      bestLow = Math.min(bestLow, endpointDistance(low, end));
      bestHigh = Math.min(bestHigh, endpointDistance(high, end));
    }
  }
  if (Number.isFinite(bestLow) || Number.isFinite(bestHigh)) {
    return bestHigh <= bestLow;
  }
  // CARLA's own answer, resolved from its waypoint yaw. Only an overlay too old
  // to carry it falls through to the lane-id sign convention.
  const resolved = lane.feature.properties.travel_increases_s;
  if (resolved !== undefined) return resolved;
  return laneTravelIncreasesSByConvention(
    Number(lane.feature.properties.lane_id ?? -1),
  );
}

function permitsLaneChange(
  value: string | null | undefined,
  side: "left" | "right",
) {
  const normalized = String(value ?? "none").toLowerCase();
  return normalized === "both" || normalized === side;
}

function sameDirection(left: LaneNode, right: LaneNode) {
  if (
    String(left.feature.properties.lane_type).toLowerCase() ===
      "bidirectional" ||
    String(right.feature.properties.lane_type).toLowerCase() === "bidirectional"
  ) {
    return true;
  }
  const leftId = Number(left.feature.properties.lane_id);
  const rightId = Number(right.feature.properties.lane_id);
  return (
    Number.isFinite(leftId) &&
    Number.isFinite(rightId) &&
    Math.sign(leftId) === Math.sign(rightId)
  );
}

function outgoingEdges(
  lane: LaneNode,
  lanes: Map<string, LaneNode>,
): RouteEdge[] {
  const edges: RouteEdge[] = [];
  for (const target of lane.feature.properties.successor_rsls ?? []) {
    if (lanes.has(target)) {
      edges.push({ from: lane.rsl, to: target, kind: "successor" });
    }
  }
  const laneChange = lane.feature.properties.lane_change;
  for (const [side, target] of [
    ["left", lane.feature.properties.left_lane_rsl],
    ["right", lane.feature.properties.right_lane_rsl],
  ] as const) {
    if (!target || !permitsLaneChange(laneChange, side)) continue;
    const targetLane = lanes.get(target);
    if (targetLane && sameDirection(lane, targetLane)) {
      edges.push({ from: lane.rsl, to: target, kind: "lane-change" });
    }
  }
  return edges.sort(
    (left, right) =>
      left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind),
  );
}

function shortestPath(
  source: string,
  target: string,
  lanes: Map<string, LaneNode>,
  maxCostM?: number,
): RouteEdge[] | null {
  if (source === target) return [];
  const distances = new Map<string, number>([[source, 0]]);
  const previous = new Map<string, RouteEdge>();
  const pending = new Set<string>([source]);
  const settled = new Set<string>();

  while (pending.size > 0 && settled.size < lanes.size) {
    const current = [...pending].sort((left, right) => {
      const delta =
        (distances.get(left) ?? Number.POSITIVE_INFINITY) -
        (distances.get(right) ?? Number.POSITIVE_INFINITY);
      return delta || left.localeCompare(right);
    })[0]!;
    pending.delete(current);
    if (settled.has(current)) continue;
    settled.add(current);
    if (current === target) break;
    const lane = lanes.get(current);
    if (!lane) continue;

    for (const edge of outgoingEdges(lane, lanes)) {
      if (settled.has(edge.to)) continue;
      const targetLane = lanes.get(edge.to)!;
      const cost =
        lineLength(targetLane.coordinates) +
        (edge.kind === "lane-change" ? LANE_CHANGE_PENALTY_METERS : 0);
      const nextDistance = (distances.get(current) ?? 0) + cost;
      // A caller that knows how far the answer can possibly be says so, and the
      // search stops expanding beyond it rather than exploring the whole map to
      // discover the same "no" more slowly. Route legs pass nothing and are
      // unbounded exactly as before.
      if (maxCostM !== undefined && nextDistance > maxCostM) continue;
      const existingDistance = distances.get(edge.to);
      const existingEdge = previous.get(edge.to);
      const winsTie =
        existingDistance != null &&
        Math.abs(nextDistance - existingDistance) <= Number.EPSILON &&
        `${edge.from}:${edge.kind}` <
          `${existingEdge?.from ?? ""}:${existingEdge?.kind ?? ""}`;
      if (
        existingDistance == null ||
        nextDistance < existingDistance ||
        winsTie
      ) {
        distances.set(edge.to, nextDistance);
        previous.set(edge.to, edge);
        pending.add(edge.to);
      }
    }
  }

  if (!previous.has(target)) return null;
  const path: RouteEdge[] = [];
  let cursor = target;
  while (cursor !== source) {
    const edge = previous.get(cursor);
    if (!edge) return null;
    path.unshift(edge);
    cursor = edge.from;
  }
  return path;
}

function nearestFraction(
  coordinates: Array<[number, number]>,
  point: [number, number],
) {
  const total = lineLength(coordinates);
  if (total <= Number.EPSILON) return 0.5;
  let traversed = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestFraction = 0.5;
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1]!;
    const end = coordinates[index]!;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const lengthSquared = dx * dx + dy * dy;
    const local =
      lengthSquared <= Number.EPSILON
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) /
                lengthSquared,
            ),
          );
    const projected: [number, number] = [
      start[0] + dx * local,
      start[1] + dy * local,
    ];
    const distance = endpointDistance(point, projected);
    const segmentLength = geographicDistanceMeters(start, end);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestFraction = (traversed + segmentLength * local) / total;
    }
    traversed += segmentLength;
  }
  return clampFraction(bestFraction);
}

function appendCoordinates(
  target: Array<[number, number]>,
  source: Array<[number, number]>,
) {
  for (const coordinate of source) {
    const previous = target.at(-1);
    if (
      !previous ||
      endpointDistance(previous, coordinate) > COORDINATE_EPSILON
    ) {
      target.push(coordinate);
    }
  }
}

/**
 * Where `point` sits on this lane: its arc-length fraction and the projected
 * point itself, in lng/lat. Exported so lane-locked timed points can be turned
 * into route anchors without a second projection implementation.
 */
export function laneProjection(
  lane: LaneNode,
  point: [number, number],
): { fraction: number; point: [number, number]; distanceM: number } | null {
  const fraction = nearestFraction(lane.coordinates, point);
  const projected = pointAtFraction(lane.coordinates, fraction);
  if (!projected) return null;
  return {
    fraction,
    point: projected,
    distanceM: geographicDistanceMeters(point, projected),
  };
}

export { geographicDistanceMeters as laneDistanceMeters };

/** Whether travel along this lane runs from fraction 0 toward 1. */
export { travelIncreasesFraction as laneTravelIncreasesFraction };

export function resolveLeg(
  sourceAnchor: ScenarioEditorRoadAnchor,
  targetAnchor: ScenarioEditorRoadAnchor,
  lanes: Map<string, LaneNode>,
  maxCostM?: number,
) {
  const sourceRsl = laneRsl(sourceAnchor);
  const targetRsl = laneRsl(targetAnchor);
  if (!sourceRsl || !targetRsl) return null;
  const sourceLane = lanes.get(sourceRsl);
  const targetLane = lanes.get(targetRsl);
  if (!sourceLane || !targetLane) return null;
  if (sourceRsl === targetRsl) {
    return sliceLine(
      sourceLane.coordinates,
      sourceAnchor.s_fraction,
      targetAnchor.s_fraction,
    );
  }

  const path = shortestPath(sourceRsl, targetRsl, lanes, maxCostM);
  if (!path) return null;
  const coordinates: Array<[number, number]> = [];
  let currentLane = sourceLane;
  let currentFraction = clampFraction(sourceAnchor.s_fraction);

  for (const edge of path) {
    const nextLane = lanes.get(edge.to);
    if (!nextLane) return null;
    if (edge.kind === "successor") {
      const currentEnd = travelIncreasesFraction(currentLane, lanes) ? 1 : 0;
      appendCoordinates(
        coordinates,
        sliceLine(currentLane.coordinates, currentFraction, currentEnd),
      );
      currentLane = nextLane;
      currentFraction = travelIncreasesFraction(currentLane, lanes) ? 0 : 1;
      continue;
    }

    const currentEnd = travelIncreasesFraction(currentLane, lanes) ? 1 : 0;
    const transitionFraction =
      currentFraction + (currentEnd - currentFraction) * 0.3;
    const transitionPoint = pointAtFraction(
      currentLane.coordinates,
      transitionFraction,
    );
    if (!transitionPoint) return null;
    appendCoordinates(
      coordinates,
      sliceLine(currentLane.coordinates, currentFraction, transitionFraction),
    );
    const nextFraction = nearestFraction(nextLane.coordinates, transitionPoint);
    const nextPoint = pointAtFraction(nextLane.coordinates, nextFraction);
    if (!nextPoint) return null;
    appendCoordinates(coordinates, [transitionPoint, nextPoint]);
    currentLane = nextLane;
    currentFraction = nextFraction;
  }

  appendCoordinates(
    coordinates,
    sliceLine(
      currentLane.coordinates,
      currentFraction,
      targetAnchor.s_fraction,
    ),
  );
  return coordinates.length >= 2 ? coordinates : null;
}

export function resolveRouteOverlayGeometry(
  anchors: ScenarioEditorRoadAnchor[],
  overlay: RuntimeRoadOverlayCollection | null,
): RouteOverlayResolution {
  const lanes = buildLaneIndex(overlay);
  const lines: Array<Array<[number, number]>> = [];
  const unresolvedLegIndexes: number[] = [];
  let activeLine: Array<[number, number]> = [];

  for (let index = 1; index < anchors.length; index += 1) {
    const leg = resolveLeg(anchors[index - 1]!, anchors[index]!, lanes);
    if (!leg) {
      if (activeLine.length >= 2) lines.push(activeLine);
      activeLine = [];
      unresolvedLegIndexes.push(index - 1);
      continue;
    }
    appendCoordinates(activeLine, leg);
  }
  if (activeLine.length >= 2) lines.push(activeLine);
  return { lines, unresolvedLegIndexes };
}
