/**
 * Deterministic fit scoring for collision-site selection (stage-1 Phase 1).
 *
 * The contact-rate baseline (Phase 0: 33% on proximity-only pedestrian
 * selection) showed that picking the *nearest* viable site leaves no margin for
 * engine dynamics — a marginal site that barely clears the run-up guard makes a
 * worse scenario than a roomier, cleaner one slightly farther away. This module
 * is the ranking decision: given a site's typed detector facts (from
 * `MapSearchDocument.facts`, Phase 1a) and a few geometry signals the enumerator
 * extracts, produce a single composite fit score plus a viability verdict.
 *
 * Pure and deterministic: same inputs, same score — unit-tested without a map or
 * a simulator. `findCollisionSites` calls this per candidate site, applies the
 * viability floor, and returns the survivors top-N first.
 */
import type { MapSearchDocumentFacts } from "@/app/lib/maps/search/map-search";

/** Geometry signals the enumerator measures per candidate site (family-agnostic). */
export interface SiteFitSignals {
  /** Forward run-up available to the subject (m): approach length + forward back-walk. */
  runUpM: number;
  /** Run-up the family needs at the requested speed/arrival time (m). */
  requiredRunUpM: number;
  /**
   * Conflict-angle quality in [0,1]: 1 = ideal ~perpendicular crossing, →0 as
   * the conflict becomes oblique/grazing. For pedestrians this is the crossing
   * axis vs the road; for turn families it is the subject turn path vs the
   * conflicting through path at the meeting point.
   */
  conflictPerpendicularity: number;
  /**
   * Optional [0,1]: how comfortably the conflict point sits inside the junction
   * interior (1 = central, →0 at the rim). Omitted for mid-block pedestrian
   * sites. Folds in the CG-style "conflict landed off the junction" guard.
   */
  conflictInteriorScore?: number;
}

/** Weights for the composite (documented, sum to 1 before the prior tiebreak). */
export const SITE_FIT_WEIGHTS = {
  runUpHeadroom: 0.4,
  perpendicularity: 0.4,
  junctionCleanliness: 0.2,
} as const;

/** Minimum perpendicularity for a site to be viable (rejects grazing conflicts). */
export const MIN_PERPENDICULARITY = 0.4;
/** Default composite floor; sites below this are not admitted to the dataset. */
export const DEFAULT_FIT_FLOOR = 0.45;
/** Tiny bonus for a crash-propensity-prone site — a tiebreak, never a gate (G1). */
const PRONE_PRIOR_BONUS = 0.01;

export interface SiteFitResult {
  /** Composite fit in roughly [0,1] (plus a tiny prior tiebreak). */
  fitScore: number;
  /** Clears every hard guard AND the composite floor. */
  viable: boolean;
  /** Per-term contributions, for tuning + the panel's "why" display. */
  terms: {
    runUpHeadroom: number;
    perpendicularity: number;
    junctionCleanliness: number;
    pronePrior: number;
  };
  /** Human-readable reasons (admit/reject rationale). */
  reasons: string[];
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Comfortable run-up: 0 at exactly the required distance, ramping to 1 once the
 * subject has a full extra required-distance of headroom (so it can reach speed and
 * absorb tracking error before the conflict).
 */
function runUpHeadroom(runUpM: number, requiredRunUpM: number): number {
  if (requiredRunUpM <= 0) return runUpM > 0 ? 1 : 0;
  return clamp01((runUpM - requiredRunUpM) / requiredRunUpM);
}

/**
 * Junction cleanliness from typed detector facts: prefer simple, well-formed
 * junctions over sprawling/complex ones (which planted worse contacts in the
 * baseline). Absent facts (un-backfilled map) default to a neutral mid score.
 */
function junctionCleanliness(facts: MapSearchDocumentFacts): number {
  let score = 0.8;
  if (facts.isComplex === true) score -= 0.4;
  if (typeof facts.approachCount === "number" && facts.approachCount > 4) score -= 0.2;
  // A very large junction footprint spreads the conflict out and is harder to
  // plan cleanly; gently penalize the extremes.
  if (typeof facts.polygonAreaSqm === "number" && facts.polygonAreaSqm > 2000) score -= 0.2;
  return clamp01(score);
}

export interface ScoreSiteArgs {
  signals: SiteFitSignals;
  facts: MapSearchDocumentFacts;
  /** A `<family>_prone` tag is present on the backing candidate (soft tiebreak). */
  pronePrior?: boolean;
  /** Override the composite floor (e.g. a looser operation-mode threshold). */
  floor?: number;
}

export function scoreCollisionSite(args: ScoreSiteArgs): SiteFitResult {
  const { signals, facts, pronePrior = false, floor = DEFAULT_FIT_FLOOR } = args;
  const reasons: string[] = [];

  const headroom = runUpHeadroom(signals.runUpM, signals.requiredRunUpM);
  const perpendicularity = clamp01(signals.conflictPerpendicularity);
  const cleanliness = junctionCleanliness(facts);

  const terms = {
    runUpHeadroom: SITE_FIT_WEIGHTS.runUpHeadroom * headroom,
    perpendicularity: SITE_FIT_WEIGHTS.perpendicularity * perpendicularity,
    junctionCleanliness: SITE_FIT_WEIGHTS.junctionCleanliness * cleanliness,
    pronePrior: pronePrior ? PRONE_PRIOR_BONUS : 0,
  };
  // Interior comfort, when measured, scales the geometry confidence — a conflict
  // hugging the junction rim is less reliable even if otherwise perpendicular.
  const interior = signals.conflictInteriorScore;
  const interiorFactor = typeof interior === "number" ? clamp01(interior) : 1;

  const base =
    (terms.runUpHeadroom + terms.perpendicularity + terms.junctionCleanliness) *
    interiorFactor;
  const fitScore = base + terms.pronePrior;

  // Hard viability guards (independent of the composite floor).
  const hasRunUp = signals.runUpM + 1e-6 >= signals.requiredRunUpM;
  const isPerpendicular = perpendicularity >= MIN_PERPENDICULARITY;
  if (!hasRunUp) {
    reasons.push(
      `run-up ${signals.runUpM.toFixed(1)}m below required ${signals.requiredRunUpM.toFixed(1)}m`,
    );
  }
  if (!isPerpendicular) {
    reasons.push(
      `conflict too oblique (perpendicularity ${perpendicularity.toFixed(2)} < ${MIN_PERPENDICULARITY})`,
    );
  }
  const clearsFloor = fitScore >= floor;
  if (!clearsFloor) {
    reasons.push(`fit ${fitScore.toFixed(3)} below floor ${floor}`);
  }
  const viable = hasRunUp && isPerpendicular && clearsFloor;
  if (viable) {
    reasons.push(
      `viable: run-up ${signals.runUpM.toFixed(1)}m, perpendicularity ${perpendicularity.toFixed(2)}, cleanliness ${cleanliness.toFixed(2)}`,
    );
  }

  return { fitScore, viable, terms, reasons };
}

/**
 * Floor + top-N selection over scored sites (the agreed "viability floor AND
 * top-N" rule). Stable: sorts by fitScore desc, ties broken by `tieKey` asc for
 * reproducibility. Returns at most `limit` viable sites.
 */
export function selectTopSites<T extends { fit: SiteFitResult; tieKey: string }>(
  scored: readonly T[],
  limit: number,
): T[] {
  return scored
    .filter((s) => s.fit.viable)
    .slice()
    .sort((a, b) => {
      if (b.fit.fitScore !== a.fit.fitScore) return b.fit.fitScore - a.fit.fitScore;
      return a.tieKey < b.tieKey ? -1 : a.tieKey > b.tieKey ? 1 : 0;
    })
    .slice(0, Math.max(0, limit));
}
