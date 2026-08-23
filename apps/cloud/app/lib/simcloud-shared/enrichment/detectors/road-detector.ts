import type {
  Detector,
  DetectorResult,
  MapSceneGraph,
} from "../../map-intelligence";
import { computeRoadPrimitives } from "../primitives/road-primitives";

const DETECTOR_ID = "road-detector";
const DETECTOR_VERSION = "1.0.0";

function detect(sceneGraph: MapSceneGraph): DetectorResult[] {
  const results: DetectorResult[] = [];

  for (const segment of sceneGraph.roadSegments) {
    const prims = computeRoadPrimitives(segment);

    // Skip junction-internal roads
    if (prims.is_junction_internal) continue;

    const matchedTags: string[] = [];
    let confidence = 0.80;

    if (prims.speed_limit_mph !== undefined && prims.speed_limit_mph >= 45) {
      matchedTags.push("HIGH_SPEED_ARTERIAL_SEGMENT");
      confidence = Math.max(confidence, 0.85);
    }

    if (prims.has_sidewalk && prims.length_m > 20) {
      matchedTags.push("SIDEWALK_PEDESTRIAN_NETWORK");
    }

    if (prims.has_bike_lane && prims.length_m > 20) {
      matchedTags.push("BIKE_LANE_STANDARD");
      // Subtype: narrow multi-use road → shared roadway (sharrow). Wider
      // arterial with a painted bike lane → mixing zone at intersections.
      // Both heuristics are coarse v1 proxies until per-sub-segment lane
      // geometry is wired in.
      if (prims.driving_lane_count > 0 && prims.driving_lane_count <= 2) {
        matchedTags.push("BIKE_LANE_SHARED_ROADWAY");
        confidence = Math.max(confidence, 0.82);
      } else if (prims.driving_lane_count >= 3) {
        matchedTags.push("BIKE_INTERSECTION_MIXING_ZONE");
        confidence = Math.max(confidence, 0.85);
      }
    }

    if (prims.grade_pct > 4 && prims.length_m > 20 && prims.driving_lane_count > 0) {
      matchedTags.push("ROAD_GRADE_CREST_ELEVATION_CHANGE");
      confidence = Math.max(confidence, 0.85);
    }

    if (matchedTags.length === 0) continue;

    const primitiveRecord: Record<string, number | boolean | string> = {
      driving_lane_count: prims.driving_lane_count,
      lane_count_per_direction: prims.lane_count_per_direction,
      has_sidewalk: prims.has_sidewalk,
      has_bike_lane: prims.has_bike_lane,
      has_parking_lane: prims.has_parking_lane,
      grade_pct: prims.grade_pct,
      length_m: prims.length_m,
      is_junction_internal: prims.is_junction_internal,
    };
    if (prims.speed_limit_mph !== undefined) {
      primitiveRecord.speed_limit_mph = prims.speed_limit_mph;
    }

    // Build a human-readable explanation from what was actually detected.
    const parts: string[] = [];
    if (matchedTags.includes("SIDEWALK_PEDESTRIAN_NETWORK")) parts.push("sidewalk");
    if (matchedTags.includes("BIKE_LANE_SHARED_ROADWAY")) parts.push("shared bike lane");
    else if (matchedTags.includes("BIKE_INTERSECTION_MIXING_ZONE")) parts.push("bike lane mixing zone");
    else if (matchedTags.includes("BIKE_LANE_STANDARD")) parts.push("bike lane");
    if (matchedTags.includes("HIGH_SPEED_ARTERIAL_SEGMENT")) parts.push("high-speed segment");
    if (matchedTags.includes("ROAD_GRADE_CREST_ELEVATION_CHANGE")) parts.push(`${prims.grade_pct.toFixed(0)}% grade`);
    const explanation = parts.length > 0
      ? `${parts.join(", ")} — ${prims.length_m.toFixed(0)}m.`
      : `Road segment, ${prims.length_m.toFixed(0)}m.`;

    results.push({
      anchorEntityId: segment.entityId,
      evidence: {
        detectorId: DETECTOR_ID,
        detectorVersion: DETECTOR_VERSION,
        primitives: primitiveRecord,
        confidence,
        matchedTags,
        explanation: explanation.charAt(0).toUpperCase() + explanation.slice(1),
      },
    });
  }

  return results;
}

export const roadDetector: Detector = {
  id: DETECTOR_ID,
  version: DETECTOR_VERSION,
  detect,
};
