import type {
  Detector,
  DetectorResult,
  MapSceneGraph,
} from "../../map-intelligence";
import { computeJunctionPrimitives } from "../primitives/junction-primitives";

const DETECTOR_ID = "turn-detector";
const DETECTOR_VERSION = "2.0.0";

/**
 * Unprotected / protected left-turn detector.
 *
 * Grounds its decision in actual RoadRunner Gate features (TurnRelation=Left
 * or UTurnLeft) assigned to each junction by the junction builder, rather
 * than inferring turn counts from junction geometry. A left-turn movement is
 * considered "protected" when the junction's control scheme forces oncoming
 * traffic to yield to it:
 *
 *   - ALL-WAY-STOP — no conflicting oncoming stream (definitionally
 *     protected for any turn).
 *   - PROTECTED-LEFT SIGNAL — the junction carries a dedicated left-turn
 *     arrow signal (MUTCD R10-6 or a RoadRunner signal named as a left
 *     arrow). Detected per-junction; we don't yet know which of several
 *     approaches the arrow protects, so we treat the junction uniformly.
 *
 * Everything else — signalized junctions with only circular greens,
 * two-way-stop junctions (where the mainline left is across traffic that
 * doesn't stop), yield / uncontrolled junctions — produces an unprotected
 * left turn.
 */
function detect(sceneGraph: MapSceneGraph): DetectorResult[] {
  const results: DetectorResult[] = [];

  for (const junction of sceneGraph.junctions) {
    const prims = computeJunctionPrimitives(junction);
    if (prims.left_turn_gate_count === 0) continue;

    const isProtected = prims.is_all_way_stop || prims.has_protected_left_signal;
    // Tag names match the registered taxonomy in map-asset-tags.ts.
    const tag = isProtected ? "TURN_PROTECTED_LEFT_PHASE" : "TURN_UNPROTECTED_LEFT";

    // Confidence calibration: presence of an explicit protected-left signal
    // or all-way-stop is a strong signal; the "unprotected" branch is a
    // default-to-yes heuristic, so it gets a lower confidence to reflect
    // that we haven't positively confirmed per-approach signalling.
    const confidence = isProtected ? 0.85 : 0.7;

    // Phrasing note: the unprotected branch deliberately avoids the bounded
    // phrase "protected left" (e.g. "No protected left-turn control"). The
    // map-search matcher is word-boundary substring only — it cannot parse
    // the negation, so that phrasing false-matches every unprotected
    // junction against a "protected left" query. "Unprotected left turn(s)"
    // keeps the intent and leaves "protected" adjacent to "un" with no
    // word boundary.
    const explanation = isProtected
      ? prims.is_all_way_stop
        ? `All-way stop: ${prims.left_turn_gate_count} left-turn movement(s) have no conflicting oncoming stream.`
        : `Protected left-turn signal detected: ${prims.left_turn_gate_count} left-turn movement(s) governed by a dedicated arrow.`
      : `Unprotected left turn(s): ${prims.left_turn_gate_count} movement(s) must cross oncoming traffic without a dedicated signal.`;

    results.push({
      anchorEntityId: junction.entityId,
      evidence: {
        detectorId: DETECTOR_ID,
        detectorVersion: DETECTOR_VERSION,
        primitives: {
          left_turn_gate_count: prims.left_turn_gate_count,
          has_protected_left_signal: prims.has_protected_left_signal,
          has_signal: prims.has_signal,
          has_stop_sign: prims.has_stop_sign,
          is_all_way_stop: prims.is_all_way_stop,
          approach_count: prims.approach_count,
        },
        confidence,
        matchedTags: [tag],
        explanation,
      },
    });
  }

  return results;
}

export const turnDetector: Detector = {
  id: DETECTOR_ID,
  version: DETECTOR_VERSION,
  detect,
};
