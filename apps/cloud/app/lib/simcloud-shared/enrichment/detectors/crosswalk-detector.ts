import type {
  Detector,
  DetectorResult,
  MapSceneGraph,
} from "../../map-intelligence";
import { computeCrosswalkPrimitives } from "../primitives/crosswalk-primitives";

const DETECTOR_ID = "crosswalk-detector";
const DETECTOR_VERSION = "1.0.0";

function detect(sceneGraph: MapSceneGraph): DetectorResult[] {
  const results: DetectorResult[] = [];

  for (const crosswalk of sceneGraph.crosswalks) {
    const prims = computeCrosswalkPrimitives(crosswalk, sceneGraph.junctions);
    const matchedTags: string[] = [];
    let confidence = 0.80;

    if (prims.is_near_junction && prims.is_signalized) {
      matchedTags.push("CROSSWALK_MARKED_SIGNALIZED");
      confidence = 0.90;
    } else if (prims.is_near_junction && !prims.is_signalized) {
      matchedTags.push("CROSSWALK_MARKED_UNSIGNALIZED");
      confidence = 0.90;
    } else if (prims.is_midblock) {
      matchedTags.push("CROSSWALK_MARKED_UNSIGNALIZED");
      confidence = 0.80;
    }

    if (matchedTags.length === 0) continue;

    const primitiveRecord: Record<string, number | boolean | string> = {
      is_near_junction: prims.is_near_junction,
      is_midblock: prims.is_midblock,
      is_marked: prims.is_marked,
      is_signalized: prims.is_signalized,
    };
    if (prims.nearest_junction_approach_count !== undefined) {
      primitiveRecord.nearest_junction_approach_count =
        prims.nearest_junction_approach_count;
    }

    const explanation = prims.is_midblock
      ? "Midblock marked crosswalk without signal control."
      : prims.is_signalized
        ? "Marked crosswalk at a signalized junction."
        : "Marked crosswalk at an unsignalized junction.";

    results.push({
      anchorEntityId: crosswalk.entityId,
      evidence: {
        detectorId: DETECTOR_ID,
        detectorVersion: DETECTOR_VERSION,
        primitives: primitiveRecord,
        confidence,
        matchedTags,
        explanation,
      },
    });
  }

  return results;
}

export const crosswalkDetector: Detector = {
  id: DETECTOR_ID,
  version: DETECTOR_VERSION,
  detect,
};
