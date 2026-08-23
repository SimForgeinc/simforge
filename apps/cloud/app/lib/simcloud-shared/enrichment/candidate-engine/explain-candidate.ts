/**
 * Generates a structured JSON explanation string for a candidate location.
 *
 * The output is stored in the `explanation` field and is designed for both
 * UI rendering and LLM agent consumption.
 */

import type { CandidateLocation } from "../../map-candidate-location";

export type CandidateExplanation = {
  summary: string;
  detectorBreakdown: {
    detectorId: string;
    confidence: number;
    explanation: string;
    matchedTags: string[];
  }[];
  primitiveSnapshot: Record<string, number | boolean | string>;
};

export function explainCandidate(candidate: CandidateLocation): string {
  // Build detector breakdown from evidence array
  const detectorBreakdown = candidate.evidence.map((ev) => ({
    detectorId: ev.detectorId,
    confidence: ev.confidence,
    explanation: ev.explanation,
    matchedTags: ev.matchedTags,
  }));

  // Merge all primitive snapshots from evidence into one map.
  // Later evidence values overwrite earlier ones for the same key.
  const primitiveSnapshot: Record<string, number | boolean | string> = {};
  for (const ev of candidate.evidence) {
    for (const [key, value] of Object.entries(ev.primitives)) {
      primitiveSnapshot[key] = value;
    }
  }

  // Build a human-readable summary
  const detectorCount = detectorBreakdown.length;
  const tagList =
    candidate.tags.length > 0 ? candidate.tags.join(", ") : "none";

  const summary =
    `${candidate.kind} candidate (confidence ${candidate.confidence.toFixed(2)}) ` +
    `backed by ${detectorCount} detector${detectorCount !== 1 ? "s" : ""}. ` +
    `Tags: ${tagList}.`;

  const payload: CandidateExplanation = {
    summary,
    detectorBreakdown,
    primitiveSnapshot,
  };

  return JSON.stringify(payload);
}
