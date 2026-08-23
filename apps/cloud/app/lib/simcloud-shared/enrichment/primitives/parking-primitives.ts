import type {
  JunctionEntity,
  ParkingClusterEntity,
} from "../../map-intelligence";

export type ParkingPrimitives = {
  is_street_parking: boolean;
  is_lot_parking: boolean;
  is_standalone_lot: boolean;
  lane_count: number;
  total_length_m: number;
  space_count: number;
  access_point_count: number;
  has_road_access: boolean;
  near_intersection: boolean;
};

/** ~30 meters in degrees (approximate at mid latitudes). */
const NEAR_INTERSECTION_THRESHOLD_DEG = 0.00027;

function isNearAnyJunction(
  center: { lat: number; lng: number },
  junctions: JunctionEntity[],
): boolean {
  return junctions.some((j) => {
    const dLat = Math.abs(center.lat - j.center.lat);
    const dLng = Math.abs(center.lng - j.center.lng);
    return dLat < NEAR_INTERSECTION_THRESHOLD_DEG &&
      dLng < NEAR_INTERSECTION_THRESHOLD_DEG;
  });
}

export function computeParkingPrimitives(
  entity: ParkingClusterEntity,
  junctions: JunctionEntity[],
): ParkingPrimitives {
  const accessPointCount = entity.accessPoints?.length ?? 0;
  return {
    is_street_parking: entity.isStreetParking,
    is_lot_parking: entity.isLotParking,
    is_standalone_lot: entity.isStandaloneLot ?? false,
    lane_count: entity.parkingLaneIds.length,
    total_length_m: entity.totalLengthM,
    space_count: entity.spaceCount ?? 0,
    access_point_count: accessPointCount,
    has_road_access: accessPointCount > 0,
    near_intersection: isNearAnyJunction(entity.center, junctions),
  };
}
