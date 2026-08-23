/**
 * Candidate ranker.
 *
 * Ranks every candidate by confidence and assigns a 1-based rank. No cap —
 * search picks scenario fits from the full corpus using higher-criteria
 * spatial filters (proximity to signalized junctions, bus stops, commercial
 * frontages, …), so dropping low-rank candidates here would silently hide
 * real features those filters could have used.
 *
 * Supports two strategies:
 * - "balanced" (default) — rank purely by candidate confidence
 * - "parking-first"      — adds 0.1 to parking candidate confidence before
 *                          ranking, surfacing parking earlier in the list
 *
 * The function is still named `selectTopK` for backward compatibility with
 * existing imports; it now returns every input candidate, ordered.
 */

import type { CandidateLocation } from "../../map-candidate-location";

export type RankingStrategy = "balanced" | "parking-first";

const PARKING_KINDS = new Set(["parking_cluster", "street_parking", "parking_lot"]);

export function selectTopK(
  candidates: CandidateLocation[],
  strategy: RankingStrategy = "balanced",
): CandidateLocation[] {
  if (candidates.length === 0) return [];

  const ranked = [...candidates].sort((a, b) => effectiveConfidence(b, strategy) - effectiveConfidence(a, strategy));
  return ranked.map((c, i) => ({ ...c, rank: i + 1 }));
}

function effectiveConfidence(c: CandidateLocation, strategy: RankingStrategy): number {
  if (strategy === "parking-first" && PARKING_KINDS.has(c.kind)) {
    return Math.min(1, c.confidence + 0.1);
  }
  return c.confidence;
}
