/**
 * Runtime consumer of the crash-derived location-category propensity prior
 * (plan §A.5). The enrichment Lambda imports this to tag stored candidate
 * locations with `<family>_prone` retrieval anchors so AI Search can softly
 * rank a family's matches toward categories where that collision type
 * empirically dominates real AV crashes.
 *
 * The corpus-derived NUMBERS (which family is prone for which category, base
 * rates, tuning params) live in the generated, do-not-edit sibling
 * `crash-category-prior.generated.ts`. This file holds the STABLE,
 * hand-written half: the map-side predicate that decides which shared
 * categories a candidate location belongs to, given its tags + kind.
 *
 * It mirrors the corpus-side classifier so the crash corpus and candidate
 * location index share one coarse category vocabulary.
 * Keep the shared category table in sync if either side changes.
 *
 * IMPORTANT: this is crash COMPOSITION, not crash RATE (no exposure
 * denominator). It is a soft ranking signal for scenario family selection
 * only — never a safety/risk score, never a hard gate (plan §A.4).
 *
 * Pure, deterministic, no I/O.
 */
import type { CollisionFamilyId } from "./collision-templates";
import {
  CRASH_CATEGORY_PRONE,
  CRASH_CATEGORY_BASE_RATES,
  CRASH_CATEGORY_PRIOR_PARAMS,
} from "./crash-category-prior.generated";

export {
  CRASH_CATEGORY_PRONE,
  CRASH_CATEGORY_BASE_RATES,
  CRASH_CATEGORY_PRIOR_PARAMS,
};

/** The coarse shared category vocabulary (plan §A.2). */
export const CRASH_SHARED_CATEGORIES = [
  "signalized_junction",
  "unsignalized_junction",
  "narrow_roadway",
  "parked_vehicle_corridor",
  "bike_lane_present",
  "pedestrian_zone",
  "midblock_segment",
] as const;

export type CrashSharedCategory = (typeof CRASH_SHARED_CATEGORIES)[number];

/**
 * Map-side category predicate (plan §A.2 table, candidate-location side).
 *
 * `kind` is a `CandidateLocationKind` token as persisted in
 * `map_candidate_locations.kind` (e.g. `junction`, `road_segment`,
 * `crosswalk_zone`, `sidewalk_segment`) — NOT a MapSearchDocument object
 * family (`street`/`junction`/`poi`/`address`), which is a separate
 * search-index concept. Tag matching is case-insensitive exact-token (the
 * candidate's `tags` array holds discrete tokens, not free text).
 * Per-category semantics are heterogeneous on purpose (some are kind∧tag,
 * some kind∧¬tag, some tag-only, one kind∨tag), so each is written out
 * rather than forced through one generic rule.
 */
export function crashSharedCategoriesForCandidate(
  tags: readonly string[],
  kind: string,
): CrashSharedCategory[] {
  const t = new Set(tags.map((x) => x.toLowerCase()));
  const k = kind.toLowerCase();
  const has = (tag: string) => t.has(tag.toLowerCase());
  const out: CrashSharedCategory[] = [];

  const isJunction = k === "junction";
  const isRoadSegment = k === "road_segment";
  const isSignalized = has("signalized");

  // Signalized junction: a junction kind carrying a `signalized` tag.
  if (isJunction && isSignalized) out.push("signalized_junction");
  // Unsignalized junction: a junction kind WITHOUT the `signalized` tag.
  if (isJunction && !isSignalized) out.push("unsignalized_junction");
  // Narrow roadway: any explicit narrow tag (kind-agnostic).
  if (has("narrow_roadway") || has("narrow_street_parking") || has("narrow_street")) {
    out.push("narrow_roadway");
  }
  // Parked-vehicle corridor: a street-parking kind/tag.
  if (k === "street_parking" || has("street_parking")) {
    out.push("parked_vehicle_corridor");
  }
  // Bike-lane present: a bike-lane tag (no dedicated kind exists).
  if (has("bike_lane")) out.push("bike_lane_present");
  // Pedestrian zone: a pedestrian-bearing kind OR a pedestrian/crosswalk
  // tag (the one kind∨tag category in the A.2 table).
  if (
    k === "crosswalk_zone" ||
    k === "sidewalk_segment" ||
    has("pedestrian_spawn") ||
    has("crosswalk") ||
    has("pedestrian")
  ) {
    out.push("pedestrian_zone");
  }
  // Mid-block segment: a road_segment kind that is not signalized.
  if (isRoadSegment && !isSignalized) out.push("midblock_segment");

  return out;
}

/**
 * Collision families that are prone for this candidate location — the union
 * of `CRASH_CATEGORY_PRONE` over every shared category the candidate belongs
 * to. Deduplicated, stable order (taxonomy order via first-seen then sort).
 */
export function crashPropensityFamiliesForCandidate(
  tags: readonly string[],
  kind: string,
): CollisionFamilyId[] {
  const fams = new Set<CollisionFamilyId>();
  for (const c of crashSharedCategoriesForCandidate(tags, kind)) {
    for (const f of CRASH_CATEGORY_PRONE[c] ?? []) fams.add(f);
  }
  return [...fams].sort();
}

/** Suffix appended to a family id to form its retrieval-anchor tag. */
export const CRASH_PRONE_TAG_SUFFIX = "_prone";

/**
 * The `<family>_prone` tag strings to append to a candidate location's tags.
 * Empty when no prone family applies (the common case under lift gating).
 */
export function crashPropensityTagsForCandidate(
  tags: readonly string[],
  kind: string,
): string[] {
  return crashPropensityFamiliesForCandidate(tags, kind).map(
    (f) => `${f}${CRASH_PRONE_TAG_SUFFIX}`,
  );
}
