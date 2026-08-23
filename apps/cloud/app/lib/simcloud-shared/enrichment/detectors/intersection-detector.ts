import type {
  Detector,
  DetectorResult,
  MapSceneGraph,
} from "../../map-intelligence";
import { computeJunctionPrimitives } from "../primitives/junction-primitives";

const DETECTOR_ID = "intersection-detector";
const DETECTOR_VERSION = "1.0.0";

function detect(sceneGraph: MapSceneGraph): DetectorResult[] {
  const results: DetectorResult[] = [];

  for (const junction of sceneGraph.junctions) {
    const prims = computeJunctionPrimitives(junction);
    const matchedTags: string[] = [];
    let confidence = 0.85;

    if (prims.has_signal) {
      matchedTags.push("INTERSECTION_SIGNALIZED");
      confidence = 0.95;
    }

    if (prims.is_all_way_stop) {
      matchedTags.push("INTERSECTION_ALL_WAY_STOP");
      confidence = 0.95;
    }

    if (prims.has_stop_sign && !prims.is_all_way_stop && !prims.has_signal) {
      matchedTags.push("INTERSECTION_TWO_WAY_STOP");
      confidence = 0.95;
    }

    if (
      prims.approach_count === 3 &&
      !prims.has_signal &&
      !prims.is_all_way_stop &&
      !prims.has_stop_sign
    ) {
      matchedTags.push("INTERSECTION_T_YIELD");
    }

    if (
      prims.approach_count >= 3 &&
      !prims.has_signal &&
      !prims.has_stop_sign &&
      !prims.is_all_way_stop
    ) {
      matchedTags.push("INTERSECTION_UNCONTROLLED");
    }

    // Complex multi-leg is added alongside other tags
    if (prims.is_complex) {
      matchedTags.push("INTERSECTION_COMPLEX_MULTI_LEG");
    }

    if (matchedTags.length === 0) continue;

    const explanationParts: string[] = [];
    if (matchedTags.includes("INTERSECTION_SIGNALIZED"))
      explanationParts.push("signalized");
    if (matchedTags.includes("INTERSECTION_ALL_WAY_STOP"))
      explanationParts.push("all-way stop");
    if (matchedTags.includes("INTERSECTION_TWO_WAY_STOP"))
      explanationParts.push("two-way stop");
    if (matchedTags.includes("INTERSECTION_T_YIELD"))
      explanationParts.push("T-yield");
    if (matchedTags.includes("INTERSECTION_UNCONTROLLED"))
      explanationParts.push("uncontrolled");
    if (matchedTags.includes("INTERSECTION_COMPLEX_MULTI_LEG"))
      explanationParts.push(`complex ${prims.approach_count}-leg`);

    results.push({
      anchorEntityId: junction.entityId,
      evidence: {
        detectorId: DETECTOR_ID,
        detectorVersion: DETECTOR_VERSION,
        primitives: {
          approach_count: prims.approach_count,
          has_signal: prims.has_signal,
          has_stop_sign: prims.has_stop_sign,
          is_all_way_stop: prims.is_all_way_stop,
          is_t_intersection: prims.is_t_intersection,
          is_complex: prims.is_complex,
          gate_count: prims.gate_count,
          internal_lane_count: prims.internal_lane_count,
          has_phases: prims.has_phases,
          polygon_area_sqm: prims.polygon_area_sqm,
        },
        confidence,
        matchedTags,
        explanation: `Junction with ${prims.approach_count} approaches: ${explanationParts.join(", ")}.`,
      },
    });
  }

  return results;
}

export const intersectionDetector: Detector = {
  id: DETECTOR_ID,
  version: DETECTOR_VERSION,
  detect,
};
