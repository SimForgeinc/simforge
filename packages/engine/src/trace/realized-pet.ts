/**
 * Realized post-encroachment time, measured from the trajectories the episode
 * actually produced.
 *
 * `EpisodeMetrics.minPET` is a *predicted* PET: at every tick `readPathConflict`
 * extrapolates both actors along constant-velocity future paths and reports how
 * nearly simultaneous their arrivals at the crossing point would be. Its own
 * doc comment says so ("Simulation sample at which this prediction was made").
 * Minimising that prediction over a whole clip is not PET — it is "the most
 * nearly simultaneous predicted arrival at any instant".
 *
 * For any arrival-solved near miss that number is ~0 **by construction**: the
 * arrival solver deliberately aims the challenger at the conflict point in
 * sync with the metric subject, so at some tick the constant-velocity
 * prediction reads a near-simultaneous arrival, even when the realized episode
 * is a comfortable, collision-free near miss.
 *
 * Observed on `easterbrook-discovery-school` site `09561123f54cf3fe` draw 4:
 * predicted minPET 0.007 s at t=5.50 s, zero collisions, realized PET 0.940 s.
 * Across one 240-cell batch, 63 of 110 `pet` invariant rejections were false
 * rejections by this measure (58 of them with zero collisions).
 *
 * This module implements the textbook definition instead: PET is the gap
 * between the first actor *clearing* the conflict area and the second actor
 * *entering* it. Following Westhofen et al. (Criticality Metrics for Automated
 * Driving, 2023), PET is **undefined** when both actors occupy the conflict
 * area simultaneously — that case is an encroachment, and path-TTC, not PET,
 * is the metric that describes it.
 */

import type { SimTrace } from './trace.js';

export interface RealizedPetResult {
  /** Seconds between the first actor clearing the area and the second entering. */
  readonly value: number;
  readonly pair: readonly [string, string];
  readonly conflictPoint: { readonly x: number; readonly y: number };
  /** Actor that cleared the conflict area first. */
  readonly firstActor: string;
  readonly secondActor: string;
  /** Time the first actor cleared the area. */
  readonly firstExitT: number;
  /** Time the second actor entered the area. */
  readonly secondEntryT: number;
}

export type RealizedPetStatus =
  | { readonly kind: 'ok'; readonly result: RealizedPetResult }
  /** Both actors were inside the conflict area at once: PET is undefined. */
  | { readonly kind: 'encroachment'; readonly overlapSeconds: number }
  /** At least one actor never reached the conflict area. */
  | { readonly kind: 'not_reached'; readonly missingActor: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

interface Occupancy {
  readonly entryT: number;
  readonly exitT: number;
}

/** Is `(px,py)` inside the oriented footprint centred at `(x,y)`? */
function insideFootprint(
  px: number, py: number,
  x: number, y: number, headingRad: number,
  lengthM: number, widthM: number,
): boolean {
  const dx = px - x;
  const dy = py - y;
  const c = Math.cos(-headingRad);
  const s = Math.sin(-headingRad);
  const lon = dx * c - dy * s;
  const lat = dx * s + dy * c;
  return Math.abs(lon) <= lengthM / 2 && Math.abs(lat) <= widthM / 2;
}

function occupancyOf(trace: SimTrace, actorId: string, cx: number, cy: number): Occupancy | null {
  const track = trace.ticks.actors[actorId];
  if (!track) return null;
  const dims = trace.header.actorMetadata?.[actorId]?.dims;
  const lengthM = dims?.l ?? 4.8;
  const widthM = dims?.w ?? 1.9;
  let entryT: number | null = null;
  let exitT: number | null = null;
  for (let i = 0; i < trace.ticks.t.length; i += 1) {
    if (track.present[i] !== 1) continue;
    if (!insideFootprint(cx, cy, track.x[i]!, track.y[i]!, track.headingRad[i]!, lengthM, widthM)) continue;
    const t = trace.ticks.t[i]!;
    if (entryT === null) entryT = t;
    exitT = t;
  }
  if (entryT === null || exitT === null) return null;
  return { entryT, exitT };
}

/**
 * Measure realized PET for a pair over the conflict point the engine already
 * identified. Deterministic and side-effect free.
 */
export function computeRealizedPet(
  trace: SimTrace,
  a: string,
  b: string,
  conflictPoint?: { readonly x: number; readonly y: number },
): RealizedPetStatus {
  const point = conflictPoint
    ?? trace.metrics.minPET?.conflictPoint
    ?? trace.metrics.minPathTTC?.conflictPoint;
  if (!point) return { kind: 'unavailable', reason: 'no conflict point was recorded for this episode' };

  const oa = occupancyOf(trace, a, point.x, point.y);
  if (!oa) return { kind: 'not_reached', missingActor: a };
  const ob = occupancyOf(trace, b, point.x, point.y);
  if (!ob) return { kind: 'not_reached', missingActor: b };

  const overlap = Math.min(oa.exitT, ob.exitT) - Math.max(oa.entryT, ob.entryT);
  if (overlap >= 0) return { kind: 'encroachment', overlapSeconds: overlap };

  const aFirst = oa.exitT <= ob.entryT;
  const firstExitT = aFirst ? oa.exitT : ob.exitT;
  const secondEntryT = aFirst ? ob.entryT : oa.entryT;
  return {
    kind: 'ok',
    result: {
      value: secondEntryT - firstExitT,
      pair: [a, b],
      conflictPoint: point,
      firstActor: aFirst ? a : b,
      secondActor: aFirst ? b : a,
      firstExitT,
      secondEntryT,
    },
  };
}
