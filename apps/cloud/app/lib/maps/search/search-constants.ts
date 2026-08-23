/**
 * Single source of truth for map-search configuration that doesn't fit a JSON
 * alias file — scoring weights, cache sizes, stopwords, type-defining semantic
 * ids, spatial relation thresholds, and the word-boundary regex helpers that
 * were previously duplicated in three places (map-search.ts, relation-ast.ts,
 * relation-executor.ts).
 *
 * Data-like values (subtype labels, operator labels, alias lists) live in
 * `map-search-aliases.json`. Pure code (functions, numeric knobs) lives here.
 * Every consumer imports from one of these two places; nothing else should
 * redefine these values.
 */

import type { SearchObjectFamily } from "./map-search-corpus";
import type { RelationOp } from "./relation-ast";

// ---------------------------------------------------------------------------
// Scoring — additive weights applied during ranking
// ---------------------------------------------------------------------------
//
// Bounds: a candidate's score is (confidence × confidenceBase) + any bonuses
// it matches. Relation executor adds relationMaxBonus on top via a linear
// falloff from 0m → threshold. Numbers aren't absolute, only relative: bump
// them together to shift the balance, not individually.

export const SEARCH_SCORING = {
  confidenceBase: 100,
  familyMatchBonus: 20,
  semanticGroupBonus: 18,
  freeTextBonus: 10,
  rankCeiling: 12,
  relationMaxBonus: 20,
} as const;

// ---------------------------------------------------------------------------
// Operational limits
// ---------------------------------------------------------------------------

export const SEARCH_LIMITS = {
  /** Max distinct (map_asset_id, revision-signature) corpora held in memory. */
  corpusCacheEntries: 16,
  /** Default cap on result cards returned to a single query. */
  defaultResultLimit: 50,
  /** Max related-object refs attached to each subject in a relation query. */
  defaultRelatedLimit: 5,
} as const;

// ---------------------------------------------------------------------------
// Stopwords — dropped before free-text matching
// ---------------------------------------------------------------------------
//
// The AST parser (relation-ast.ts) consumes relation-operator aliases like
// "near", "close to", "around", "by" BEFORE any free-text tokenization runs.
// They're still listed here because `runMapSearch`'s own parseQuery receives
// the *raw* query (not the AST-stripped form) from the service, so unmatched
// operator words would otherwise leak into the free-text bucket. Adding a
// word here removes it from the free-text bucket in every consumer — don't
// add anything a user might legitimately type as a search term.

export const SEARCH_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "around",
  "at",
  "by",
  "for",
  "in",
  "near",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

// ---------------------------------------------------------------------------
// Type-defining semantic ids — semantic groups that map one-to-one onto a
// concrete candidate kind. A query like "bus stop near junction" carries the
// bus_stop semantic on the subject; if the matcher also enforced the junction
// object family filter, the bus-stop candidate (family poi, kind bus_stop)
// would be stripped. Membership here tells the filter to skip that hard
// family gate for the subject side.
// ---------------------------------------------------------------------------

export const TYPE_DEFINING_SEMANTIC_IDS: ReadonlySet<string> = new Set([
  "bus_stop",
  "crosswalk",
  "pedestrian",
  "sidewalk",
  "parking",
  "parking_lot",
  "street_parking",
  "narrow_street_parking",
  "school",
  "hospital",
  "gas_station",
  "bike_lane",
  "shared_bike",
  "pickup_dropoff",
]);

// ---------------------------------------------------------------------------
// Word-boundary regex helpers
// ---------------------------------------------------------------------------

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-bounded substring match. `(^|\b)…(\b|$)` in JS treats `_` as a word
 * char, so e.g. "turn_unprotected_left" won't match the term "unprotected
 * left" — intentional, since the raw tag token is distinct from the
 * human-readable phrase variant.
 */
export function matchesTerm(text: string, term: string): boolean {
  return new RegExp(`(^|\\b)${escapeRegExp(term)}(\\b|$)`).test(text);
}

// ---------------------------------------------------------------------------
// Spatial relation thresholds (meters)
// ---------------------------------------------------------------------------
//
// Per-operator, per-family-pair distance thresholds. Global defaults — callers
// of the structured API can still override with an explicit `distance_m`.
// Numbers are calibrated against dense urban maps (Belmont-scale blocks at
// ~100 m) and lean conservative: false negatives are cheaper than a `near`
// that matches every POI.

/** Default `near` thresholds per (left:right) object-family pair. */
export const NEAR_DEFAULT_M: Record<string, number> = {
  "junction:poi": 50,
  "poi:junction": 50,
  "street:poi": 75,
  "poi:street": 75,
  "junction:junction": 120,
  "street:street": 100,
  "junction:street": 60,
  "street:junction": 60,
  "poi:poi": 60,
  "address:address": 50,
  "address:junction": 50,
  "junction:address": 50,
  "address:street": 60,
  "street:address": 60,
  "address:poi": 60,
  "poi:address": 60,
};

/**
 * Tighter `adjacent_to` thresholds. Adjacency is qualitative: two objects are
 * adjacent when their geometries practically touch. Centroid distance is an
 * approximation (centroids can drift from polygon edges) so these are roomy
 * enough to accept a POI whose centroid lands ~20 m from the nearest road.
 */
export const ADJACENT_DEFAULT_M: Record<string, number> = {
  "junction:poi": 25,
  "poi:junction": 25,
  "street:poi": 25,
  "poi:street": 25,
  "street:junction": 5,
  "junction:street": 5,
  "junction:junction": 15,
  "street:street": 10,
  "poi:poi": 15,
  "address:address": 15,
  "address:junction": 25,
  "junction:address": 25,
  "address:street": 25,
  "street:address": 25,
  "address:poi": 20,
  "poi:address": 20,
};

export const NEAR_FALLBACK_M = 80;
export const ADJACENT_FALLBACK_M = 20;

/**
 * Max distance (m) from either endpoint to a subject's centroid before we
 * consider the subject "outside" a relation's spatial scope. Only used by the
 * spatial-index pre-filter when a relation's distance override is unbounded.
 */
export const MAX_RELATION_RADIUS_M = 1500;

/**
 * Default BFS cap (m) for topology operators (`leads_to`, `connected_to`,
 * `upstream_of`, `downstream_of`) when the user does not specify a distance.
 * Calibrated against dense urban maps: 250 m covers roughly a block plus the
 * immediately adjacent junction / POI, which matches the intuition of
 * "reachable from here" without fanning out across the whole map.
 */
export const TOPOLOGY_DEFAULT_M = 250;

/** Hard cap on topology BFS even when the user explicitly asks for more. */
export const TOPOLOGY_MAX_M = 1500;

/**
 * Hard cap on the number of nodes (start + intermediates + end, inclusive)
 * we attach to a topology relation's reconstructed path. The traversal
 * distance budget alone doesn't bound path length — `edgeWeight` falls back
 * to 0 when an edge has no `length_m` / `distance_m`, so a graph with patchy
 * length data can string many nodes onto one path under the same meter
 * budget. This cap keeps the inline path payload bounded; when the real
 * path exceeds the cap we keep the head + tail and flag `pathTruncated`.
 */
export const MAX_TOPOLOGY_PATH_NODES = 8;

function thresholdKey(left: SearchObjectFamily, right: SearchObjectFamily): string {
  return `${left}:${right}`;
}

export function getThresholdMeters(
  op: RelationOp,
  left: SearchObjectFamily,
  right: SearchObjectFamily,
): number {
  if (op === "within") {
    // `within` always needs an explicit distance; the caller must provide one.
    // The fallback here is defensive — the AST parser guards against reaching
    // this code without a distance.
    return MAX_RELATION_RADIUS_M;
  }
  const table = op === "adjacent_to" ? ADJACENT_DEFAULT_M : NEAR_DEFAULT_M;
  const fallback = op === "adjacent_to" ? ADJACENT_FALLBACK_M : NEAR_FALLBACK_M;
  return table[thresholdKey(left, right)] ?? fallback;
}
