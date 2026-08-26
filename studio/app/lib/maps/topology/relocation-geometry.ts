import type {
  MapTopologyIndex,
  ScenarioEditorRoadAnchor,
  Vec2,
} from "@simforge-oss/studio-shared";
import type { TravelAwareTopologyIndex } from "@simforge-oss/studio-shared";
import { flipFractionForTravel, laneTravelIncreasesS } from "@simforge-oss/studio-shared";
import { polylineLength } from "@/app/lib/llm/scenario-generation/planner/gate-subject-route";

/** Provider-neutral geometry used by map projection and semantic binding. */
export function canonicalRelocationNumber(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e9) / 1e9 : value;
}

/**
 * Convert a tangent sampled in OpenDRIVE road-s order to legal lane travel.
 *
 * Takes the DIRECTION rather than a lane id on purpose: the caller has the
 * bound topology and can resolve it from CARLA's waypoint yaw, whereas a lane
 * id can only be turned into a direction by assuming the sign convention.
 * Keeping that decision at the call site is what stops it being invisible.
 */
export function roadSAxisYawToTravelYaw(
  travelIncreasesS: boolean,
  yawDeg: number,
): number {
  return canonicalRelocationNumber(travelIncreasesS ? yawDeg : yawDeg + 180);
}

export type InteractionRelocationGateLink = {
  rsl: string;
  oriented: Vec2[];
};

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function dedupe(points: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || dist(last, point) > 1e-6) {
      out.push({ x: point.x, y: point.y });
    }
  }
  return out;
}

function segmentProjection(point: Vec2, left: Vec2, right: Vec2) {
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  const length2 = dx * dx + dy * dy;
  const t =
    length2 < 1e-12
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point.x - left.x) * dx + (point.y - left.y) * dy) /
              length2,
          ),
        );
  const projected = { x: left.x + t * dx, y: left.y + t * dy };
  return { point: projected, t, distance: dist(point, projected) };
}

export function projectOnPolyline(polyline: readonly Vec2[], point: Vec2) {
  let priorArc = 0;
  let best: {
    point: Vec2;
    arc: number;
    distance: number;
    segment: number;
    t: number;
  } | null = null;
  for (let index = 1; index < polyline.length; index += 1) {
    const left = polyline[index - 1]!;
    const right = polyline[index]!;
    const projection = segmentProjection(point, left, right);
    const segmentLength = dist(left, right);
    if (!best || projection.distance < best.distance) {
      best = {
        point: projection.point,
        arc: priorArc + projection.t * segmentLength,
        distance: projection.distance,
        segment: index - 1,
        t: projection.t,
      };
    }
    priorArc += segmentLength;
  }
  return best;
}

function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const cross = (u: Vec2, v: Vec2) => u.x * v.y - u.y * v.x;
  const denominator = cross(r, s);
  if (Math.abs(denominator) < 1e-9) return null;
  const offset = { x: c.x - a.x, y: c.y - a.y };
  const t = cross(offset, s) / denominator;
  const u = cross(offset, r) / denominator;
  if (t < -1e-7 || t > 1 + 1e-7 || u < -1e-7 || u > 1 + 1e-7) {
    return null;
  }
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

export function firstIntersection(
  left: readonly Vec2[],
  right: readonly Vec2[],
): Vec2 | null {
  for (let leftIndex = 1; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex < right.length; rightIndex += 1) {
      const hit = segmentIntersection(
        left[leftIndex - 1]!,
        left[leftIndex]!,
        right[rightIndex - 1]!,
        right[rightIndex]!,
      );
      if (hit) return hit;
    }
  }
  return null;
}

export function resampleDense(
  points: readonly Vec2[],
  maximumSegmentMeters: number,
): Vec2[] {
  const source = dedupe(points);
  if (source.length < 2) return source;
  const out: Vec2[] = [{ ...source[0]! }];
  for (let index = 1; index < source.length; index += 1) {
    const left = source[index - 1]!;
    const right = source[index]!;
    const length = dist(left, right);
    const segments = Math.max(1, Math.ceil(length / maximumSegmentMeters));
    for (let step = 1; step <= segments; step += 1) {
      const t = step / segments;
      out.push({
        x: left.x + t * (right.x - left.x),
        y: left.y + t * (right.y - left.y),
      });
    }
  }
  return out;
}

function anchorFor(
  rslValue: string,
  fraction: number,
  point: Vec2,
  yawDeg: number,
): ScenarioEditorRoadAnchor {
  const [roadId, sectionId, laneId] = rslValue.split(":");
  const boundedFraction = Math.max(0, Math.min(1, fraction));
  return {
    road_id: roadId!,
    section_id: Number(sectionId),
    lane_id: Number(laneId),
    // Persisted drafts pass through JSONB and compatibility normalization.
    // Canonical precision prevents harmless IEEE-754 tail changes from
    // invalidating the semantic actor proof after a save/load round trip.
    s_fraction: canonicalRelocationNumber(boundedFraction),
    world_anchor: {
      x: canonicalRelocationNumber(point.x),
      y: canonicalRelocationNumber(point.y),
      z: 0,
      yaw: canonicalRelocationNumber(yawDeg),
    },
  };
}

/**
 * Convert between legal-travel progress and the persisted OpenDRIVE road-s
 * fraction. Runtime topology itself is already stored in road-s order.
 */
export function roadFractionToTravelFraction(
  travelIncreasesS: boolean,
  roadFraction: number,
): number {
  return flipFractionForTravel(roadFraction, travelIncreasesS);
}

export function travelFractionToRoadFraction(
  travelIncreasesS: boolean,
  travelFraction: number,
): number {
  return flipFractionForTravel(travelFraction, travelIncreasesS);
}

function pointAtPolylineArc(
  polyline: readonly Vec2[],
  targetArc: number,
): { point: Vec2; yawDeg: number } | null {
  if (polyline.length < 2) return null;
  const total = polylineLength(polyline);
  const boundedArc = Math.max(0, Math.min(total, targetArc));
  let traversed = 0;
  for (let index = 1; index < polyline.length; index += 1) {
    const left = polyline[index - 1]!;
    const right = polyline[index]!;
    const length = dist(left, right);
    if (traversed + length >= boundedArc || index === polyline.length - 1) {
      const fraction = length > 1e-9
        ? Math.max(0, Math.min(1, (boundedArc - traversed) / length))
        : 0;
      return {
        point: {
          x: canonicalRelocationNumber(left.x + fraction * (right.x - left.x)),
          y: canonicalRelocationNumber(left.y + fraction * (right.y - left.y)),
        },
        yawDeg: canonicalRelocationNumber(
          Math.atan2(right.y - left.y, right.x - left.x) * 180 / Math.PI,
        ),
      };
    }
    traversed += length;
  }
  return null;
}

/**
 * Resolve a persisted CARLA road anchor through the pinned runtime topology.
 * Topology polylines and persisted s_fraction both use OpenDRIVE road-s order;
 * the returned yaw is converted to legal lane travel direction.
 */
export function resolveTopologyRoadAnchor(
  topology: TravelAwareTopologyIndex,
  anchor: ScenarioEditorRoadAnchor,
): { rsl: string; point: Vec2; yawDeg: number } | null {
  if (anchor.section_id == null || anchor.lane_id == null) return null;
  const rslValue = `${anchor.road_id}:${anchor.section_id}:${anchor.lane_id}`;
  const lane = topology.lanes[rslValue];
  if (!lane || lane.polyline.length < 2) return null;
  const sample = pointAtPolylineArc(
    lane.polyline,
    polylineLength(lane.polyline) * Math.max(0, Math.min(1, anchor.s_fraction ?? 0.5)),
  );
  return sample
    ? {
        rsl: rslValue,
        point: sample.point,
        yawDeg: roadSAxisYawToTravelYaw(
          laneTravelIncreasesS(topology.laneTravelIncreasesS, rslValue, lane.laneId),
          sample.yawDeg,
        ),
      }
    : null;
}

export function anchorForTopologyPoint(
  topology: MapTopologyIndex,
  rslValue: string,
  point: Vec2,
  yawDeg: number,
): ScenarioEditorRoadAnchor {
  const lane = topology.lanes[rslValue];
  const lanePolyline = lane?.polyline ?? [];
  const projected = projectOnPolyline(lanePolyline, point);
  const laneLength = polylineLength(lanePolyline);
  const sFraction = projected && laneLength > 0 ? projected.arc / laneLength : 0;
  return anchorFor(rslValue, sFraction, point, yawDeg);
}

export function anchorAtFraction(
  topology: MapTopologyIndex,
  link: InteractionRelocationGateLink,
  fraction: number,
): ScenarioEditorRoadAnchor {
  const targetArc = polylineLength(link.oriented) * fraction;
  let prior = 0;
  for (let index = 1; index < link.oriented.length; index += 1) {
    const left = link.oriented[index - 1]!;
    const right = link.oriented[index]!;
    const length = dist(left, right);
    if (prior + length >= targetArc || index === link.oriented.length - 1) {
      const t =
        length > 0
          ? Math.max(0, Math.min(1, (targetArc - prior) / length))
          : 0;
      const point = {
        x: left.x + t * (right.x - left.x),
        y: left.y + t * (right.y - left.y),
      };
      const yaw =
        (Math.atan2(right.y - left.y, right.x - left.x) * 180) / Math.PI;
      return anchorForTopologyPoint(topology, link.rsl, point, yaw);
    }
    prior += length;
  }
  const point = link.oriented[link.oriented.length - 1]!;
  return anchorForTopologyPoint(topology, link.rsl, point, 0);
}
