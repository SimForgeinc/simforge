/**
 * Ground-truth timelines reconstructed from a corpus scenario.
 *
 * The causal channel records only *transitions*; these helpers fold the
 * transition stream back into per-pair visibility state over the decision
 * grid, index the trigger stream, and expose pose sampling over the decimated
 * tracks. Everything here is pure and deterministic — the same functions the
 * checkers use, so ground-truth derivation and judgment cannot drift.
 */

import type { CausalFrame, CausalTriggerRecord } from '@simforge-oss/training-env';

import type { CorpusScenario, DecimatedTrack } from './corpus.js';

/** Perception gating radius the corpus episodes ran with (rl-env default). */
export const OBJECT_LIST_RANGE_M = 60;
/** Minimum |longitudinal|/|lateral| offset (m) for an ahead/behind/left/right relation to hold. */
export const SPATIAL_MARGIN_M = 1.0;

/** Visibility of `targetId` from `observerId` at one decision tick. */
export interface LosSample {
  readonly tS: number;
  readonly visible: boolean | null; // null = pair not evaluated at this tick
}

/**
 * Reconstruct per-tick LOS state for one observer/target pair.
 *
 * The first frame that mentions a pair defines its initial state (the channel
 * emits every evaluated pair on first observation); later mentions are flips.
 */
export function losTimeline(scenario: CorpusScenario, observerId: string, targetId: string): LosSample[] {
  const key = `${observerId}>${targetId}`;
  const out: LosSample[] = [];
  let current: boolean | null = null;
  for (const frame of scenario.causalChannel.frames) {
    for (const t of frame.losTransitions) {
      if (`${t.observerId}>${t.targetId}` === key) current = t.becameVisible;
    }
    out.push({ tS: frame.tS, visible: current });
  }
  return out;
}

/**
 * Whether the observer→target pair was *evaluated* at tick index `i`
 * (0-based into the decision grid): both present and within the perception
 * range. Mirrors ObjectListBuilder's range gate (no sensors in this corpus).
 */
export function pairEvaluated(scenario: CorpusScenario, observerId: string, targetId: string, i: number): boolean {
  const o = scenario.tracks[observerId];
  const t = scenario.tracks[targetId];
  if (!o || !t || o.present[i] !== 1 || t.present[i] !== 1) return false;
  const dx = t.x[i]! - o.x[i]!;
  const dy = t.y[i]! - o.y[i]!;
  return Math.hypot(dx, dy) <= OBJECT_LIST_RANGE_M;
}

/** All trigger records in frame order, each tagged with its decision time. */
export function allTriggers(scenario: CorpusScenario): readonly (CausalTriggerRecord & { frameTS: number })[] {
  const out: (CausalTriggerRecord & { frameTS: number })[] = [];
  for (const f of scenario.causalChannel.frames) {
    for (const tr of f.triggers) out.push({ ...tr, frameTS: f.tS });
  }
  return out;
}

/** All conflict-genesis records with their decision time. */
export function allGenesis(scenario: CorpusScenario): readonly { tS: number; a: string; b: string; metric: 'ttc' | 'distance' }[] {
  const out: { tS: number; a: string; b: string; metric: 'ttc' | 'distance' }[] = [];
  for (const f of scenario.causalChannel.frames) {
    for (const g of f.conflictGenesis) out.push({ tS: f.tS, a: g.a, b: g.b, metric: g.metric });
  }
  return out;
}

/** Decision-grid index closest to `tS`; -1 when out of range. */
export function tickIndex(track: DecimatedTrack, tS: number): number {
  if (track.t.length === 0) return -1;
  let best = 0;
  for (let i = 1; i < track.t.length; i++) {
    if (Math.abs(track.t[i]! - tS) < Math.abs(track.t[best]! - tS)) best = i;
  }
  return Math.abs(track.t[best]! - tS) <= 1e-6 ? best : best;
}

/** Ego-frame offsets (longitudinal forward, lateral left) of `actorId` from `referenceId` at grid index i. */
export function egoFrameOffsets(
  scenario: CorpusScenario,
  referenceId: string,
  actorId: string,
  i: number,
): { longitudinalM: number; lateralM: number; distanceM: number } | null {
  const r = scenario.tracks[referenceId];
  const a = scenario.tracks[actorId];
  if (!r || !a || r.present[i] !== 1 || a.present[i] !== 1) return null;
  const dx = a.x[i]! - r.x[i]!;
  const dy = a.y[i]! - r.y[i]!;
  const h = r.headingRad[i]!;
  const fwdX = Math.cos(h);
  const fwdY = Math.sin(h);
  const longitudinalM = dx * fwdX + dy * fwdY;
  const lateralM = dx * -fwdY + dy * fwdX;
  return { longitudinalM, lateralM, distanceM: Math.hypot(dx, dy) };
}

/** Frames whose interval contains `tS`. */
export function frameAt(scenario: CorpusScenario, tS: number): CausalFrame | null {
  const frames = scenario.causalChannel.frames;
  if (frames.length === 0) return null;
  let best = frames[0]!;
  for (const f of frames) {
    if (f.tS <= tS + 1e-9 && f.tS >= best.tS) best = f;
  }
  return best;
}
