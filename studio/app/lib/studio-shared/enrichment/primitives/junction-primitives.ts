import type { JunctionEntity } from "../../map-intelligence";

export type JunctionPrimitives = {
  approach_count: number;
  has_signal: boolean;
  has_stop_sign: boolean;
  is_all_way_stop: boolean;
  is_t_intersection: boolean;
  is_complex: boolean;
  gate_count: number;
  internal_lane_count: number;
  has_phases: boolean;
  polygon_area_sqm: number;
  /** Count of left-turn Gate features (incl. U-turn-left) whose midpoint sits inside the junction polygon. */
  left_turn_gate_count: number;
  /** True when at least one controlling signal is identified as a protected-left head. */
  has_protected_left_signal: boolean;
};

/**
 * Compute the area of a polygon using the shoelace formula.
 * The polygon is given in [lng, lat] pairs (degrees). We convert to approximate
 * meters using cos(centroid_lat) * 111320 for the lng axis and 111320 for lat.
 */
function shoelaceAreaSqm(polygon: [number, number][]): number {
  if (polygon.length < 3) return 0;

  // Compute centroid lat for the meter conversion factor
  const centroidLat =
    polygon.reduce((sum, [, lat]) => sum + lat, 0) / polygon.length;
  const cosLat = Math.cos((centroidLat * Math.PI) / 180);
  const mPerDegLng = 111320 * cosLat;
  const mPerDegLat = 111320;

  // Convert to meters relative to first point
  const first = polygon[0]!;
  const refLng = first[0];
  const refLat = first[1];
  const pts = polygon.map(([lng, lat]) => ({
    x: (lng - refLng) * mPerDegLng,
    y: (lat - refLat) * mPerDegLat,
  }));

  // Shoelace formula
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const pi = pts[i]!;
    const pj = pts[(i + 1) % pts.length]!;
    area += pi.x * pj.y;
    area -= pj.x * pi.y;
  }
  return Math.abs(area) / 2;
}

export function computeJunctionPrimitives(
  entity: JunctionEntity,
): JunctionPrimitives {
  return {
    approach_count: entity.approachCount,
    has_signal: entity.isSignalized,
    has_stop_sign: entity.hasStopSign,
    is_all_way_stop: entity.isAllWayStop,
    is_t_intersection: entity.approachCount === 3,
    is_complex: entity.approachCount >= 5,
    gate_count: entity.gateCount,
    internal_lane_count: entity.laneCount,
    has_phases: entity.hasPhases,
    polygon_area_sqm: shoelaceAreaSqm(entity.polygon),
    left_turn_gate_count: entity.leftTurnGateCount,
    has_protected_left_signal: entity.hasProtectedLeftSignal,
  };
}
