// AUTO-GENERATED from the CA AV Collision corpus.
// Source: CA AV Collision corpus (Xu, Jiao & Chen 2025, CC-BY-4.0).
// Local audit artifacts are written under output/incident-datasets/samples.
//
// DO NOT EDIT BY HAND. Regenerate after the crosswalk, classifier, taxonomy,
// or corpus changes. Pure data, deterministic (no timestamp) — an unchanged
// corpus produces a zero diff. This is crash COMPOSITION, not crash RATE: a
// soft ranking signal for scenario family selection only, never a safety or
// risk score (plan §A.4).
import type { CollisionFamilyId } from "./collision-templates";

/** Prior tuning constants the numbers below were generated with (plan §A.3). */
export const CRASH_CATEGORY_PRIOR_PARAMS = {
  alpha: 20,
  min_category_n: 15,
  lift_threshold: 1.25,
  p_hat_floor: 0.1,
} as const;

/** Corpus base rate P(f) per collision family (`unmatched` excluded). */
export const CRASH_CATEGORY_BASE_RATES: Record<string, number> = {
  "pedestrian_crossing": 0.08757637474541752,
  "rear_end": 0.4786150712830957,
  "right_turn_hook": 0.07739307535641547,
  "sideswipe": 0.0855397148676171,
  "unprotected_left_turn": 0.17718940936863545,
  "unsafe_cut_in": 0.09368635437881874,
};

/**
 * Shared location-category → collision families that clear the lift-over-base-
 * rate prone gate (`n_c ≥ 15`, `lift ≥ 1.25`, `P̂ ≥ 0.1`). A
 * category with no discriminating family maps to an empty array; pure lift
 * gating means the corpus-dominant family (`rear_end`) intentionally earns
 * no `_prone` tag anywhere.
 */
export const CRASH_CATEGORY_PRONE: Record<string, CollisionFamilyId[]> = {
  "bike_lane_present": ["pedestrian_crossing"],
  "midblock_segment": ["unsafe_cut_in"],
  "narrow_roadway": [],
  "parked_vehicle_corridor": ["sideswipe"],
  "pedestrian_zone": [],
  "signalized_junction": ["pedestrian_crossing"],
  "unsignalized_junction": [],
};
