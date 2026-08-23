/**
 * Candidate pooling — filters and merges overlapping candidates.
 *
 * 1. Drop candidates with confidence < 0.5
 * 2. Merge overlapping candidates of the same kind whose centers are within
 *    ~30 m (≈ 0.00027 degrees) and share at least one tag
 *
 * No per-kind cap. Search picks scenario fits from the full corpus using
 * spatial relations (proximity to signalized junctions, bus stops, commercial
 * frontages, leading to an uncontrolled junction, …); a per-kind cap here
 * would silently hide real bus stops / parking lots / schools that those
 * higher-criteria filters could have used.
 */

import type { CandidateLocation, CandidateLocationKind } from "../../map-candidate-location";

/** ~30 m expressed in degrees (approximation at mid-latitudes). */
const MERGE_DISTANCE_DEG = 0.00027;

/** Minimum confidence threshold to keep a candidate. */
const MIN_CONFIDENCE = 0.5;

// ── Helpers ───────────────────────────────────────────────────────────────

function degreeDistance(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dlat = a.lat - b.lat;
  const dlng = a.lng - b.lng;
  return Math.sqrt(dlat * dlat + dlng * dlng);
}

function sharesTag(a: CandidateLocation, b: CandidateLocation): boolean {
  const setB = new Set(b.tags);
  return a.tags.some((t) => setB.has(t));
}

/**
 * Merge candidate `b` into candidate `a` (mutates `a`).
 * Keeps the higher-confidence candidate as the base and unions tags/evidence.
 */
function mergeCandidates(
  primary: CandidateLocation,
  secondary: CandidateLocation,
): CandidateLocation {
  const tagSet = new Set([...primary.tags, ...secondary.tags]);
  const scenarioTagSet = new Set([
    ...(primary.scenarioTags ?? []),
    ...(secondary.scenarioTags ?? []),
  ]);

  return {
    ...primary,
    tags: [...tagSet],
    scenarioTags: [...scenarioTagSet],
    evidence: [...primary.evidence, ...secondary.evidence],
    reason: primary.reason + "; " + secondary.reason,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────

export function poolCandidates(
  candidates: CandidateLocation[],
): CandidateLocation[] {
  // Step 1: Filter low-confidence
  const filtered = candidates.filter((c) => c.confidence >= MIN_CONFIDENCE);

  // Step 2: Merge overlapping candidates of the same kind
  const result: CandidateLocation[] = [];

  const mergeGroups = new Map<CandidateLocationKind, CandidateLocation[]>();
  for (const c of filtered) {
    const existing = mergeGroups.get(c.kind);
    if (existing) {
      existing.push(c);
    } else {
      mergeGroups.set(c.kind, [c]);
    }
  }

  for (const [, group] of mergeGroups) {
    // Sort descending by confidence so the primary is always the strongest
    group.sort((a, b) => b.confidence - a.confidence);

    const merged: CandidateLocation[] = [];
    const consumed = new Set<number>();

    for (let i = 0; i < group.length; i++) {
      if (consumed.has(i)) continue;

      let current = group[i]!;

      for (let j = i + 1; j < group.length; j++) {
        if (consumed.has(j)) continue;

        const other = group[j]!;
        const dist = degreeDistance(current.center, other.center);

        if (dist <= MERGE_DISTANCE_DEG && sharesTag(current, other)) {
          current = mergeCandidates(current, other);
          consumed.add(j);
        }
      }

      merged.push(current);
    }

    result.push(...merged);
  }

  return result;
}
