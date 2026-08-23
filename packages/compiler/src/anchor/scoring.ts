/**
 * Clause scoring: `scoreRange`, `scoreSet`, `scoreBool`.
 *
 * From `docs/research/retargeting.md` § Matcher:
 *
 * > Scoring: `scoreRange` linear falloff over a tolerance band (defaults:
 * > distance 25% of range width min 10 m, speed 10 kph, width 0.4 m);
 * > `scoreSet` via a near-miss table (all_way_stop↔signalized 0.6,
 * > minor_stop↔yield 0.85, 4way↔3way 0.4).
 */

import type { Range, ToleranceOverrides } from './types/anchor.js';

/** Clause kinds that share a tolerance band. */
export type ToleranceKind =
  | 'distanceM'
  | 'speedKph'
  | 'widthM'
  | 'curvatureDegPer10m'
  | 'countLanes'
  | 'gradePct';

/** Defaults from the research doc; curvature 2°/10 m per the build brief. */
export const DEFAULT_TOLERANCES: Record<ToleranceKind, number | 'range25'> = {
  distanceM: 'range25',
  speedKph: 10,
  widthM: 0.4,
  curvatureDegPer10m: 2,
  countLanes: 1,
  gradePct: 2,
};

/**
 * Tolerance band width for a clause.
 *
 * `distanceM` uses "25% of the range width, minimum 10 m"; the other kinds are
 * flat. A per-clause `tolerance` or an anchor-level `toleranceOverrides` entry
 * wins over both.
 */
export function toleranceFor(
  kind: ToleranceKind,
  range: Range,
  overrides?: ToleranceOverrides,
  clauseOverride?: number,
): number {
  if (clauseOverride !== undefined) return clauseOverride;
  const fromAnchor = overrides?.[kind];
  if (fromAnchor !== undefined) return fromAnchor;
  const base = DEFAULT_TOLERANCES[kind];
  if (base === 'range25') return Math.max(10, 0.25 * Math.abs(range[1] - range[0]));
  return base;
}

export interface RangeScore {
  score: number;
  /** How far outside the band the value sits, in clause units (0 when inside). */
  slack: number;
  tolerance: number;
}

/**
 * Linear falloff outside `[min, max]` over a tolerance band.
 *
 * `value` inside the range scores 1; `tolerance` metres/kph/… outside scores 0;
 * in between it falls off linearly. Never negative.
 */
export function scoreRange(
  value: number,
  range: Range,
  kind: ToleranceKind,
  overrides?: ToleranceOverrides,
  clauseOverride?: number,
): RangeScore {
  const tolerance = toleranceFor(kind, range, overrides, clauseOverride);
  const [lo, hi] = range;
  if (value >= lo && value <= hi) return { score: 1, slack: 0, tolerance };
  const slack = value < lo ? lo - value : value - hi;
  if (tolerance <= 0) return { score: 0, slack, tolerance };
  return { score: Math.max(0, 1 - slack / tolerance), slack, tolerance };
}

/** Unordered near-miss pairs. Anything absent scores 0. */
const NEAR_MISS_PAIRS: Array<[string, string, number]> = [
  ['all_way_stop', 'signalized', 0.6],
  ['minor_stop', 'yield', 0.85],
  ['minor_stop', 'all_way_stop', 0.5],
  ['uncontrolled', 'yield', 0.5],
  ['roundabout', 'all_way_stop', 0.3],
];

function nearMissKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export const NEAR_MISS_TABLE: ReadonlyMap<string, number> = new Map(
  NEAR_MISS_PAIRS.map(([a, b, v]) => [nearMissKey(a, b), v]),
);

/** Near-miss similarity of two set members, 1 when identical. */
export function nearMissScore(a: string, b: string): number {
  if (a === b) return 1;
  return NEAR_MISS_TABLE.get(nearMissKey(a, b)) ?? 0;
}

/**
 * Arm-count near miss: `4way↔3way 0.4`, generalised to |Δarms| with a floor,
 * so 4↔5 is treated like 4↔3.
 */
export function armCountNearMiss(actual: number, wanted: number): number {
  const d = Math.abs(actual - wanted);
  if (d === 0) return 1;
  if (d === 1) return 0.4;
  return 0;
}

export interface SetScore {
  score: number;
  /** The member of the requested set that the actual value came closest to. */
  closest: string | null;
  slack: number;
}

/** Best near-miss score of `actual` against any member of `allowed`. */
export function scoreSet(actual: string, allowed: readonly string[]): SetScore {
  let best = 0;
  let closest: string | null = null;
  // Sorted so ties resolve deterministically rather than by author order.
  for (const want of [...allowed].sort()) {
    const s = nearMissScore(actual, want);
    if (s > best) {
      best = s;
      closest = want;
    }
  }
  if (closest === null && allowed.length > 0) closest = [...allowed].sort()[0] ?? null;
  return { score: best, closest, slack: best >= 1 ? 0 : 1 - best };
}

/** Boolean clause: 1 or 0. */
export function scoreBool(actual: boolean, wanted: boolean): { score: number; slack: number } {
  return actual === wanted ? { score: 1, slack: 0 } : { score: 0, slack: 1 };
}

/** A required clause passes only when it is fully inside its band. */
export const REQUIRED_PASS_EPSILON = 1e-9;

export function passesRequired(score: number): boolean {
  return score >= 1 - REQUIRED_PASS_EPSILON;
}
