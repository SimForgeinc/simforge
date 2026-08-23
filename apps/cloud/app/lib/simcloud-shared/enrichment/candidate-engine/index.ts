/**
 * Candidate engine - main coordinator for the map intelligence pipeline.
 *
 * Takes a MapSceneGraph, runs all detectors, generates anchor-based candidates,
 * pools/merges them, selects the top-K with diversity-aware ranking, and
 * attaches structured explanations.
 */

import type { MapSceneGraph } from "../../map-intelligence";
import type { CandidateLocation } from "../../map-candidate-location";
import { runAllDetectors } from "../detectors";
import { generateAnchors } from "./anchor-generator";
import { poolCandidates } from "./pool-candidates";
import { selectTopK, type RankingStrategy } from "./top-k-selector";
import { explainCandidate } from "./explain-candidate";

export type GenerateCandidatesOptions = {
  strategy?: RankingStrategy;
};

export function generateCandidates(
  sceneGraph: MapSceneGraph,
  options?: GenerateCandidatesOptions,
): CandidateLocation[] {
  const results = runAllDetectors(sceneGraph);
  const anchors = generateAnchors(results, sceneGraph);
  const pooled = poolCandidates(anchors);
  const ranked = selectTopK(pooled, options?.strategy);

  // Attach structured explanations
  return ranked.map((c) => ({ ...c, explanation: explainCandidate(c) }));
}

// Re-export sub-modules for direct access
export { generateAnchors } from "./anchor-generator";
export { poolCandidates } from "./pool-candidates";
export { selectTopK, type RankingStrategy } from "./top-k-selector";
export { explainCandidate, type CandidateExplanation } from "./explain-candidate";
