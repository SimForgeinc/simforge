import type {
  Detector,
  DetectorResult,
  MapSceneGraph,
} from "../../map-intelligence";
import { computeParkingPrimitives } from "../primitives/parking-primitives";

const DETECTOR_ID = "parking-detector";
const DETECTOR_VERSION = "1.0.0";

function detect(sceneGraph: MapSceneGraph): DetectorResult[] {
  const results: DetectorResult[] = [];

  for (const cluster of sceneGraph.parkingClusters) {
    const prims = computeParkingPrimitives(cluster, sceneGraph.junctions);
    const matchedTags: string[] = [];
    let confidence = 0.75;

    if (prims.is_standalone_lot) {
      if (prims.has_road_access) {
        matchedTags.push("PARKING_LOT_WITH_ROAD_ACCESS");
        confidence = Math.max(confidence, 0.85);
      } else {
        matchedTags.push("PARKING_LOT_NO_ROAD_ACCESS");
        confidence = Math.max(confidence, 0.70);
      }
    } else {
      if (prims.near_intersection && prims.is_street_parking) {
        matchedTags.push("PARKING_LANE_NEAR_INTERSECTION_OCCLUSION");
        confidence = Math.max(confidence, 0.85);
      }

      if (prims.is_lot_parking) {
        matchedTags.push("PARKING_LOT_INTERNAL_CIRCULATION");
        confidence = Math.max(confidence, 0.80);
      }

      if (prims.is_street_parking && prims.total_length_m > 50) {
        matchedTags.push("NARROW_RESIDENTIAL_STREET_WITH_PARKING");
        confidence = Math.max(confidence, 0.75);
      }
    }

    if (matchedTags.length === 0) continue;

    const explanation = prims.is_standalone_lot
      ? `Parking lot with ${prims.space_count} space${prims.space_count === 1 ? "" : "s"}${prims.has_road_access ? `, ${prims.access_point_count} access point${prims.access_point_count === 1 ? "" : "s"}` : ""}.`
      : `Parking cluster with ${prims.lane_count} ${prims.lane_count === 1 ? "lane" : "lanes"}, ${prims.total_length_m.toFixed(0)}m total.`;

    results.push({
      anchorEntityId: cluster.entityId,
      evidence: {
        detectorId: DETECTOR_ID,
        detectorVersion: DETECTOR_VERSION,
        primitives: {
          is_street_parking: prims.is_street_parking,
          is_lot_parking: prims.is_lot_parking,
          is_standalone_lot: prims.is_standalone_lot,
          lane_count: prims.lane_count,
          total_length_m: prims.total_length_m,
          space_count: prims.space_count,
          access_point_count: prims.access_point_count,
          has_road_access: prims.has_road_access,
          near_intersection: prims.near_intersection,
        },
        confidence,
        matchedTags,
        explanation,
      },
    });
  }

  return results;
}

export const parkingDetector: Detector = {
  id: DETECTOR_ID,
  version: DETECTOR_VERSION,
  detect,
};
