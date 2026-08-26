/**
 * Numeric thresholds + classifier functions shared between the search-index
 * builder (which writes classified facts like `speed_class: "high"` into the
 * sidecar from raw mph/%-grade numbers) and the search corpus (whose
 * `factsToBadges` renders those same class values into human labels).
 *
 * Single source of truth so the two sides of the pipeline can't drift — a
 * change to the "high-speed" mph cutoff, for example, lands in both places
 * via one edit here. Also hosts sidecar-builder geometric thresholds
 * (junction centroid matching, anchor distances, curvature) that aren't
 * classification per se but live with the same "how we interpret map
 * geometry" concern.
 *
 * Relation-query thresholds (near / adjacent_to / within distances) live in
 * `./search-constants.ts` alongside the rest of the runtime search knobs.
 */
import type { CandidateLocationKind, OsmRoadClass } from "@simforge-oss/studio-shared";

// ---------------------------------------------------------------------------
// Speed (mph)
// ---------------------------------------------------------------------------

/** < LOW_MAX → "low". */
export const SPEED_CLASS_LOW_MAX_MPH = 25;
/** LOW_MAX..MEDIUM_MAX → "medium"; > MEDIUM_MAX → "high". */
export const SPEED_CLASS_MEDIUM_MAX_MPH = 40;

export type SpeedClass = "low" | "medium" | "high";

export function speedClassFromMph(mph: number | undefined): SpeedClass | undefined {
  if (mph == null) return undefined;
  if (mph < SPEED_CLASS_LOW_MAX_MPH) return "low";
  if (mph <= SPEED_CLASS_MEDIUM_MAX_MPH) return "medium";
  return "high";
}

// ---------------------------------------------------------------------------
// Grade (% slope)
// ---------------------------------------------------------------------------

/** < FLAT_MAX → "flat". */
export const GRADE_CLASS_FLAT_MAX_PCT = 2;
/** FLAT_MAX..MODERATE_MAX → "moderate"; >= MODERATE_MAX → "steep". */
export const GRADE_CLASS_MODERATE_MAX_PCT = 5;
/**
 * > CREST_THRESHOLD → `crest_present: true`. Deliberately lower than the
 * steep-grade cutoff: a 4%+ grade is high enough to produce a visible
 * crest / elevation change for simulation-relevant behavior even when the
 * road isn't classified as steep overall.
 */
export const CREST_THRESHOLD_PCT = 4;

export type GradeClass = "flat" | "moderate" | "steep";

export function gradeClassFromPct(pct: number | undefined): GradeClass | undefined {
  if (pct == null) return undefined;
  if (pct < GRADE_CLASS_FLAT_MAX_PCT) return "flat";
  if (pct < GRADE_CLASS_MODERATE_MAX_PCT) return "moderate";
  return "steep";
}

export function crestPresentFromPct(pct: number | undefined): boolean {
  return pct != null && pct > CREST_THRESHOLD_PCT;
}

// ---------------------------------------------------------------------------
// Junction leg label + complexity
// ---------------------------------------------------------------------------

export type JunctionLegLabel = "3-leg" | "4-way" | "multi-leg";

export function junctionLegLabel(approachCount: number): JunctionLegLabel | undefined {
  if (approachCount === 3) return "3-leg";
  if (approachCount === 4) return "4-way";
  if (approachCount >= 5) return "multi-leg";
  return undefined;
}

export type JunctionComplexityClass = "simple" | "standard" | "complex";

export function junctionComplexityClass(approachCount: number): JunctionComplexityClass {
  if (approachCount <= 2) return "simple";
  if (approachCount <= 4) return "standard";
  return "complex";
}

// ---------------------------------------------------------------------------
// Parking lot size (space count)
// ---------------------------------------------------------------------------

/** < SMALL_MAX → "small". */
export const PARKING_LOT_SMALL_MAX_SPACES = 30;
/** SMALL_MAX..MEDIUM_MAX → "medium"; > MEDIUM_MAX → "large". */
export const PARKING_LOT_MEDIUM_MAX_SPACES = 200;

export type ParkingLotSizeClass = "small" | "medium" | "large";

export function parkingLotSizeClass(
  spaceCount: number | undefined,
): ParkingLotSizeClass | undefined {
  if (spaceCount == null || spaceCount <= 0) return undefined;
  if (spaceCount < PARKING_LOT_SMALL_MAX_SPACES) return "small";
  if (spaceCount <= PARKING_LOT_MEDIUM_MAX_SPACES) return "medium";
  return "large";
}

// ---------------------------------------------------------------------------
// Junction polygon area (m²)
// ---------------------------------------------------------------------------

/** < SMALL_MAX → "small". */
export const JUNCTION_SIZE_SMALL_MAX_M2 = 200;
/** SMALL_MAX..MEDIUM_MAX → "medium"; > MEDIUM_MAX → "large". */
export const JUNCTION_SIZE_MEDIUM_MAX_M2 = 800;

export type JunctionSizeClass = "small" | "medium" | "large";

export function junctionSizeClassFromAreaM2(
  areaM2: number | undefined,
): JunctionSizeClass | undefined {
  if (areaM2 == null || !Number.isFinite(areaM2) || areaM2 <= 0) return undefined;
  if (areaM2 < JUNCTION_SIZE_SMALL_MAX_M2) return "small";
  if (areaM2 <= JUNCTION_SIZE_MEDIUM_MAX_M2) return "medium";
  return "large";
}

// ---------------------------------------------------------------------------
// Carriageway width (metres)
// ---------------------------------------------------------------------------

/** < NARROW_MAX → "narrow". */
export const WIDTH_CLASS_NARROW_MAX_M = 6;
/** NARROW_MAX..MEDIUM_MAX → "medium"; > MEDIUM_MAX → "wide". */
export const WIDTH_CLASS_MEDIUM_MAX_M = 10;

export type WidthClass = "narrow" | "medium" | "wide";

export function widthClassFromMeters(m: number | undefined): WidthClass | undefined {
  if (m == null || !Number.isFinite(m) || m <= 0) return undefined;
  if (m < WIDTH_CLASS_NARROW_MAX_M) return "narrow";
  if (m <= WIDTH_CLASS_MEDIUM_MAX_M) return "medium";
  return "wide";
}

// ---------------------------------------------------------------------------
// Curvature (1 / metre)
// ---------------------------------------------------------------------------

/**
 * Segments below this length are ignored when picking a road's curvature
 * class — short arcs at junction transitions would otherwise tag a
 * fundamentally straight road as "sharp".
 */
export const CURVATURE_SEGMENT_MIN_LENGTH_M = 10;
/** radius 200 m — anything at or above counts as "curved". */
export const CURVATURE_CURVED_THRESHOLD = 0.005;
/** radius 50 m — anything at or above counts as "sharp". */
export const CURVATURE_SHARP_THRESHOLD = 0.02;

export type CurvatureClass = "straight" | "curved" | "sharp";

export function classifyCurvature(maxAbsCurvature: number): CurvatureClass {
  if (maxAbsCurvature >= CURVATURE_SHARP_THRESHOLD) return "sharp";
  if (maxAbsCurvature >= CURVATURE_CURVED_THRESHOLD) return "curved";
  return "straight";
}

// ---------------------------------------------------------------------------
// Sidecar-builder geometric thresholds
// ---------------------------------------------------------------------------

/**
 * Max distance between an XODR junction centroid and a GeoJSON junction
 * centroid to consider them the same place. XODR files include stub
 * junctions (ramp connectors, short transitions) within ~50 m of real
 * intersections; this window is wide enough to join the two sources but
 * tight enough that each real junction pairs with exactly one GeoJSON
 * polygon.
 */
export const JUNCTION_CENTROID_MATCH_M = 50;

/** A POI anchors to a junction if the junction centroid is within this distance. */
export const JUNCTION_ANCHOR_MAX_M = 40;

/**
 * Fallback anchor distance when no junction is close enough — use the
 * nearest street up to this distance before giving up. Wider than the
 * junction window because street centroids are along the full length of
 * the road, not at the intersection.
 */
export const STREET_ANCHOR_MAX_M = 120;

// ---------------------------------------------------------------------------
// Candidate object-family mapping
// ---------------------------------------------------------------------------
//
// Which SearchObjectFamily a candidate belongs to based on its kind. Kept
// here instead of in JSON so the mapping stays type-checked against the
// CandidateLocationKind enum — a new kind added to the enum without a
// family assignment would be a type error, not a silent fallthrough.

export type SearchObjectFamily = "junction" | "street" | "poi" | "address";

export function objectFamilyForCandidateKind(
  kind: CandidateLocationKind,
): SearchObjectFamily {
  if (kind === "junction") return "junction";
  if (kind === "street_parking" || kind === "road_segment") return "street";
  return "poi";
}

// ---------------------------------------------------------------------------
// Scenario affordances (Phase C+)
// ---------------------------------------------------------------------------
//
// Deterministic heuristics that map existing per-object scalars onto
// higher-level scenario properties. Everything here is a pure function of
// facts already produced by the builder — no new data, no new parsers.

/** XODR-derivable subset of the OSM road-class vocabulary. Deliberately
 *  bottom-heavy: motorway/trunk/primary can only come from real Overture
 *  data, never from this heuristic. */
export type FallbackRoadClass = Extract<
  OsmRoadClass,
  "secondary" | "tertiary" | "residential"
>;

/**
 * Fallback road hierarchy for roads with no matching Overture segment,
 * derived from XODR speed class and lane count and expressed in the OSM
 * vocabulary (the old arterial/collector/local buckets mapped conservatively:
 * arterial→secondary, collector→tertiary, local→residential). Tuned against
 * the Page Mill / Belmont fixtures:
 *   - secondary:   high-speed (>40 mph) OR 4+ driving lanes
 *   - residential: low-speed (<25 mph) AND at most 1 driving lane
 *   - tertiary:    everything in between (includes unclassified)
 *
 * Returns undefined only when both inputs are missing.
 */
export function roadClassFromFacts(
  speedClass: SpeedClass | undefined,
  laneCount: number | undefined,
): FallbackRoadClass | undefined {
  if (speedClass == null && laneCount == null) return undefined;
  if (speedClass === "high") return "secondary";
  if (laneCount != null && laneCount >= 4) return "secondary";
  if (speedClass === "low" && (laneCount == null || laneCount <= 1)) return "residential";
  return "tertiary";
}
