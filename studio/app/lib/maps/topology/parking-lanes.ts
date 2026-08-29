/**
 * Annotated Parking lanes for scene dressing (static curb-parked cars).
 *
 * The slimmed runtime road-segment bundle keeps only Driving lanes, so parking
 * geometry can't come from there — it's read from the map TOPOLOGY index, which
 * retains every XODR lane type (incl. `parking`). A `ParkingLaneRef` carries the
 * lane's runtime-meter polyline (same x/y frame as RuntimeRoadSegment.centerline)
 * plus its OpenDRIVE ids for traceability; consumers place parked vehicles by
 * explicit world POINT along the polyline (the baked CARLA runtime maps expose
 * only Driving lanes, so a parking-lane road anchor wouldn't resolve in the
 * worker).
 *
 * Shared by the normal-driving batch generator (`batchGenerateScenarios`) and
 * the collision scene-population layer.
 */
import type {
  MapTopologyIndex,
} from "@simforge-oss/maps/topology";

/** A Parking lane sourced from the map topology index. `points` are runtime
 * meters; road_id/section_id/lane_id are OpenDRIVE ids. */
export type ParkingLaneRef = {
  road_id: string | number;
  section_id: number | null;
  lane_id: number | null;
  points: Array<{ x: number; y: number }>;
  length_m: number;
};

/**
 * Extract the annotated Parking lanes from a topology index as placement-ready
 * `ParkingLaneRef`s (lanes with a 2+ point polyline). Cheap + pure; cache per
 * mapAssetId at the call site if reused.
 */
export function parkingLanesFromTopology(topology: MapTopologyIndex): ParkingLaneRef[] {
  return Object.values(topology.lanes)
    .filter((lane) => lane.laneType.toLowerCase() === "parking" && lane.polyline.length >= 2)
    .map((lane) => {
      let length = 0;
      for (let i = 1; i < lane.polyline.length; i += 1) {
        length += Math.hypot(
          lane.polyline[i]!.x - lane.polyline[i - 1]!.x,
          lane.polyline[i]!.y - lane.polyline[i - 1]!.y,
        );
      }
      return {
        road_id: lane.roadId,
        section_id: lane.section,
        lane_id: lane.laneId,
        points: lane.polyline.map((p) => ({ x: p.x, y: p.y })),
        length_m: length,
      };
    });
}
