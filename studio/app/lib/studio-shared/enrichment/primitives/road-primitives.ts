import type { RoadSegmentEntity } from "../../map-intelligence";

export type RoadPrimitives = {
  driving_lane_count: number;
  lane_count_per_direction: number;
  speed_limit_mph: number | undefined;
  has_sidewalk: boolean;
  has_bike_lane: boolean;
  has_parking_lane: boolean;
  grade_pct: number;
  length_m: number;
  is_junction_internal: boolean;
};

export function computeRoadPrimitives(
  entity: RoadSegmentEntity,
): RoadPrimitives {
  const drivingLaneCount = entity.laneCountByType["driving"] ?? 0;

  return {
    driving_lane_count: drivingLaneCount,
    lane_count_per_direction: Math.ceil(drivingLaneCount / 2),
    speed_limit_mph: entity.speedLimitMph,
    has_sidewalk: entity.hasSidewalk,
    has_bike_lane: entity.hasBikeLane,
    has_parking_lane: entity.hasParkingLane,
    grade_pct: entity.gradePct ?? 0,
    length_m: entity.lengthM,
    is_junction_internal: entity.isJunctionInternal,
  };
}
