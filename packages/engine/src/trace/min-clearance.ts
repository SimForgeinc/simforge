/**
 * Exact minimum footprint clearance, measured from the trajectories the episode
 * actually produced.
 *
 * `EpisodeMetrics.minDistance` reports `readPair().gapM`, which is
 * `max(0, centreDistance - (circumscribedRadius(a) + circumscribedRadius(b)))`.
 * Circumscribed circles are a deliberate, correct choice for collision broad
 * phase — an oriented-box hit is impossible when the circles never meet — but
 * the value leaks into a *reported* clearance metric, where it is wrong.
 *
 * For a 4.8 x 1.9 m car (r = 2.58 m) against a 0.6 x 0.6 m pedestrian
 * (r = 0.42 m) the radii sum to 3.00 m, so every encounter closer than three
 * metres reports a clearance of exactly 0 m while the episode records zero
 * collisions. Observed on a passing `easterbrook-discovery-school` cell:
 * reported minDistance 0 m at t=8.58 s, true footprint clearance 0.421 m at
 * t=9.16 s.
 *
 * That matters here for three reasons: a `clearance` intent criterion using
 * `measure: 'metric_gap'` is unfalsifiable at close range, a reviewer reading
 * the trace sees "0 m separation and no collision" and correctly calls it
 * incoherent, and any near-miss distance label exported as ML training data is
 * simply false.
 *
 * This module measures the real separation between the two oriented footprints.
 */

import type { SimTrace } from './trace.js';

export interface MinClearanceResult {
  /** Minimum separation between the two oriented footprints, metres. 0 = touching. */
  readonly minClearanceM: number;
  readonly t: number;
  readonly pair: readonly [string, string];
}

type Vec = readonly [number, number];

function corners(x: number, y: number, headingRad: number, lengthM: number, widthM: number): Vec[] {
  const c = Math.cos(headingRad);
  const s = Math.sin(headingRad);
  const hl = lengthM / 2;
  const hw = widthM / 2;
  return [
    [x + hl * c - hw * s, y + hl * s + hw * c],
    [x + hl * c + hw * s, y + hl * s - hw * c],
    [x - hl * c + hw * s, y - hl * s - hw * c],
    [x - hl * c - hw * s, y - hl * s + hw * c],
  ];
}

function pointSegment(p: Vec, a: Vec, b: Vec): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const denominator = abx * abx + aby * aby;
  const t = denominator < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / denominator));
  return Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * aby));
}

function pointInside(p: Vec, poly: Vec[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (Math.abs(cross) < 1e-12) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Exact separation between two convex quads; 0 when they intersect. */
function polygonDistance(A: Vec[], B: Vec[]): number {
  for (const p of A) if (pointInside(p, B)) return 0;
  for (const p of B) if (pointInside(p, A)) return 0;
  let best = Infinity;
  for (const p of A) for (let i = 0; i < B.length; i += 1) best = Math.min(best, pointSegment(p, B[i]!, B[(i + 1) % B.length]!));
  for (const p of B) for (let i = 0; i < A.length; i += 1) best = Math.min(best, pointSegment(p, A[i]!, A[(i + 1) % A.length]!));
  return best;
}

/** Deterministic, side-effect free. Returns `null` when the pair never coexists. */
export function computeMinClearance(trace: SimTrace, a: string, b: string): MinClearanceResult | null {
  const ta = trace.ticks.actors[a];
  const tb = trace.ticks.actors[b];
  if (!ta || !tb) return null;
  const da = trace.header.actorMetadata?.[a]?.dims ?? { l: 4.8, w: 1.9, h: 1.5 };
  const db = trace.header.actorMetadata?.[b]?.dims ?? { l: 4.8, w: 1.9, h: 1.5 };
  // Any footprint pair is separated by at least this much when centres are further apart.
  const broadPhaseM = Math.hypot(da.l, da.w) / 2 + Math.hypot(db.l, db.w) / 2;
  let best: MinClearanceResult | null = null;
  for (let i = 0; i < trace.ticks.t.length; i += 1) {
    if (ta.present[i] !== 1 || tb.present[i] !== 1) continue;
    const centre = Math.hypot(ta.x[i]! - tb.x[i]!, ta.y[i]! - tb.y[i]!);
    if (best !== null && centre - broadPhaseM > best.minClearanceM) continue;
    const distance = polygonDistance(
      corners(ta.x[i]!, ta.y[i]!, ta.headingRad[i]!, da.l, da.w),
      corners(tb.x[i]!, tb.y[i]!, tb.headingRad[i]!, db.l, db.w),
    );
    if (best === null || distance < best.minClearanceM) {
      best = { minClearanceM: distance, t: trace.ticks.t[i]!, pair: [a, b] };
    }
  }
  return best;
}
