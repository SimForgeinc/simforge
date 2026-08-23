/**
 * Deterministic claim checkers — the only place truth is judged.
 *
 * Each checker takes a corpus scenario (true tracks + causal channel +
 * authored interactions) and one deterministic claim, and returns a verdict:
 *
 * - `pass`         — every sampled decision tick / located event agrees;
 * - `fail`         — ground truth contradicts the claim (reason says where);
 * - `unverifiable` — the claim's window or actors fall outside what the
 *                    engine recorded (never counted as an error);
 * - `deferred`     — `checkable: 'extracted'` claims, per contract.
 *
 * No heuristics, no model calls: given the same scenario and claim the
 * verdict is bit-identical on any machine.
 */

import {
  CAUSAL_GAP_S,
  EVENT_LOCATE_SLACK_S,
  INTENT_VERBS,
  type Claim,
  type EventRef,
} from './claims.js';
import type { CorpusScenario } from './corpus.js';
import {
  allGenesis,
  allTriggers,
  egoFrameOffsets,
  losTimeline,
  pairEvaluated,
  SPATIAL_MARGIN_M,
} from './timeline.js';
import type { CausalTriggerRecord } from '@simforge/training-env';


export type VerdictStatus = 'pass' | 'fail' | 'unverifiable' | 'deferred';

export interface Verdict {
  readonly claimId: string;
  readonly status: VerdictStatus;
  /** Machine-readable reason; required for fail/unverifiable. */
  readonly reason?: string;
}

const EPS = 1e-6;

function sampleRange(scenario: CorpusScenario, fromTS: number, toTS: number): number[] {
  const dt = 1 / scenario.decisionHz;
  const out: number[] = [];
  for (let t = fromTS; t < toTS - EPS; t += dt) out.push(Math.round(t * 1000) / 1000);
  return out;
}

/* -------------------------------------------------------------- visibility */

function checkVisibility(scenario: CorpusScenario, claim: Extract<Claim, { type: 'visibility' }>): Verdict {
  const observerId = claim.observerId ?? scenario.egoId;
  const targetId = claim.actorIds[0]!;
  if (!scenario.tracks[targetId]) {
    return { claimId: claim.id, status: 'fail', reason: `unknown actor "${targetId}"` };
  }
  const timeline = losTimeline(scenario, observerId, targetId);
  const byT = new Map(timeline.map((s) => [s.tS, s.visible]));
  const want = claim.state === 'visible';
  let evaluated = 0;
  let notEvaluated = 0;
  for (const t of sampleRange(scenario, claim.tickRange.fromTS, claim.tickRange.toTS)) {
    const i = indexAt(scenario.tracks[observerId]!.t, t);
    if (!pairEvaluated(scenario, observerId, targetId, i)) {
      notEvaluated += 1;
      continue;
    }
    const visible = byT.get(t);
    if (visible === null || visible === undefined) {
      notEvaluated += 1;
      continue;
    }
    evaluated += 1;
    if (visible !== want) {
      return {
        claimId: claim.id,
        status: 'fail',
        reason: `${targetId} was ${visible ? 'visible' : 'occluded'} at t=${t}s, claimed ${claim.state}`,
      };
    }
  }
  if (evaluated === 0) {
    return {
      claimId: claim.id,
      status: 'unverifiable',
      reason: `pair ${observerId}->${targetId} never evaluated in [${claim.tickRange.fromTS}, ${claim.tickRange.toTS})`,
    };
  }
  void notEvaluated;
  return { claimId: claim.id, status: 'pass' };
}

/** Decision-grid index whose t matches `tS` exactly (tolerance 1 ms). */
function indexAt(t: readonly number[], tS: number): number {
  for (let i = 0; i < t.length; i++) {
    if (Math.abs(t[i]! - tS) <= 1e-3) return i;
  }
  return -1;
}

/* ---------------------------------------------------------- causal-trigger */

function eventTime(scenario: CorpusScenario, ref: EventRef): number[] {
  const times: number[] = [];
  if (ref.kind === 'conflict-genesis') {
    for (const g of allGenesis(scenario)) {
      if (ref.metric && g.metric !== ref.metric) continue;
      if (ref.actorId && g.a !== ref.actorId && g.b !== ref.actorId) continue;
      times.push(g.tS);
    }
    return times;
  }
  for (const tr of allTriggers(scenario)) {
    if (triggerKindOf(tr.kind) !== ref.kind) continue;
    if (ref.interactionId && tr.interactionId !== ref.interactionId) continue;
    if (ref.actorId && tr.actorId !== ref.actorId) continue;
    times.push(tr.tS);
  }
  return times.sort((a, b) => a - b);
}

function triggerKindOf(kind: CausalTriggerRecord['kind']): EventRef['kind'] | null {
  switch (kind) {
    case 'fired': return 'trigger-fired';
    case 'skipped': return 'trigger-skipped';
    case 'preemption': return 'preemption';
    case 'released': return 'released';
    case 'completed': return 'completed';
  }
}

function checkCausalTrigger(
  scenario: CorpusScenario,
  claim: Extract<Claim, { type: 'causal-trigger' }>,
): Verdict {
  const causeTimes = eventTime(scenario, claim.cause).filter(
    (t) =>
      t >= claim.tickRange.fromTS - EVENT_LOCATE_SLACK_S &&
      t <= claim.tickRange.toTS + EVENT_LOCATE_SLACK_S,
  );
  if (causeTimes.length === 0) {
    return { claimId: claim.id, status: 'fail', reason: `cause event (${claim.cause.kind}) not found in window` };
  }
  // Earliest admissible cause; effects must exist at or after it.
  for (const causeT of causeTimes) {
    const effectTimes = eventTime(scenario, claim.effect).filter((t) => t >= causeT - EPS);
    if (effectTimes.length === 0) continue;
    const effectT = effectTimes[0]!;
    if (claim.relation === 'causes') {
      if (effectT - causeT > CAUSAL_GAP_S + EPS) continue;
      // No intervening trigger event on the same actor between cause and effect.
      const intervening = allTriggers(scenario).some(
        (tr) =>
          tr.tS > causeT + EPS &&
          tr.tS < effectT - EPS &&
          (!claim.cause.actorId || tr.actorId === claim.cause.actorId),
      );
      if (intervening) continue;
    }
    return { claimId: claim.id, status: 'pass' };
  }
  return {
    claimId: claim.id,
    status: 'fail',
    reason:
      claim.relation === 'causes'
        ? `no ${claim.effect.kind} within ${CAUSAL_GAP_S}s after ${claim.cause.kind} with clean precedence`
        : `no ${claim.effect.kind} at or after ${claim.cause.kind} in window`,
  };
}

/* ------------------------------------------------------------------ intent */

export function intentVerbOf(
  interaction: CorpusScenario['interactions'][number],
): (typeof INTENT_VERBS)[number] {
  switch (interaction.verb) {
    case 'speed': return 'speed';
    case 'gap': return 'gap';
    case 'changeLane': return 'changeLane';
    case 'laneOffset': return 'laneOffset';
    case 'route': return 'route';
    case 'exist':
      return interaction.target.state === 'present' ? 'exist-present' : 'exist-absent';
    case 'set': return 'set';
  }
}

function checkIntent(scenario: CorpusScenario, claim: Extract<Claim, { type: 'intent' }>): Verdict {
  const actorId = claim.actorIds[0]!;
  const authored = scenario.interactions.filter(
    (it) =>
      it.actorId === actorId &&
      intentVerbOf(it) === claim.verb &&
      (claim.interactionId === undefined || it.id === claim.interactionId),
  );
  if (authored.length === 0) {
    const anyAuthored = scenario.interactions.some((it) => it.actorId === actorId);
    if (!anyAuthored) {
      return { claimId: claim.id, status: 'unverifiable', reason: `actor "${actorId}" has no authored interactions` };
    }
    return { claimId: claim.id, status: 'fail', reason: `no authored ${claim.verb} interaction for "${actorId}"` };
  }
  const ids = new Set(authored.map((it) => it.id));
  const executed = allTriggers(scenario).some(
    (tr) =>
      ids.has(tr.interactionId) &&
      (tr.kind === 'fired' || tr.kind === 'preemption' || tr.kind === 'completed'),
  );
  if (!executed) {
    return {
      claimId: claim.id,
      status: 'fail',
      reason: `interaction(s) ${[...ids].join(', ')} authored but never fired/completed`,
    };
  }
  return { claimId: claim.id, status: 'pass' };
}

/* ----------------------------------------------------------------- spatial */

function checkSpatial(scenario: CorpusScenario, claim: Extract<Claim, { type: 'spatial' }>): Verdict {
  const actorId = claim.actorIds[0]!;
  const referenceId = claim.referenceActorId ?? scenario.egoId;
  if (!scenario.tracks[actorId]) {
    return { claimId: claim.id, status: 'fail', reason: `unknown actor "${actorId}"` };
  }
  if (!scenario.tracks[referenceId]) {
    return { claimId: claim.id, status: 'fail', reason: `unknown reference actor "${referenceId}"` };
  }
  let sampled = 0;
  for (const t of sampleRange(scenario, claim.tickRange.fromTS, claim.tickRange.toTS)) {
    const i = indexAt(scenario.tracks[referenceId]!.t, t);
    if (i < 0) continue;
    const off = egoFrameOffsets(scenario, referenceId, actorId, i);
    if (!off) continue; // absent at this tick — skip like the perception gate does
    sampled += 1;
    if (!relationHolds(claim, off.longitudinalM, off.lateralM, off.distanceM, scenario, referenceId, actorId, i)) {
      return {
        claimId: claim.id,
        status: 'fail',
        reason: `${actorId} not ${claim.relation} ${referenceId} at t=${t}s (Δlong=${off.longitudinalM.toFixed(2)}m, Δlat=${off.lateralM.toFixed(2)}m)`,
      };
    }
  }
  if (sampled === 0) {
    return { claimId: claim.id, status: 'unverifiable', reason: 'actors never co-present in window' };
  }
  return { claimId: claim.id, status: 'pass' };
}

function relationHolds(
  claim: Extract<Claim, { type: 'spatial' }>,
  longitudinalM: number,
  lateralM: number,
  distanceM: number,
  scenario: CorpusScenario,
  referenceId: string,
  actorId: string,
  i: number,
): boolean {
  switch (claim.relation) {
    case 'ahead-of': return longitudinalM >= SPATIAL_MARGIN_M;
    case 'behind': return longitudinalM <= -SPATIAL_MARGIN_M;
    case 'left-of': return lateralM >= SPATIAL_MARGIN_M;
    case 'right-of': return lateralM <= -SPATIAL_MARGIN_M;
    case 'within-distance': return distanceM <= (claim.valueM ?? Number.NaN);
    case 'same-lane':
      return (
        scenario.tracks[referenceId]!.laneRsl[i] !== '' &&
        scenario.tracks[referenceId]!.laneRsl[i] === scenario.tracks[actorId]!.laneRsl[i]
      );
  }
}

/* -------------------------------------------------------------- dispatcher */

/** Judge one claim against engine ground truth. Pure. */
export function checkClaim(scenario: CorpusScenario, claim: Claim): Verdict {
  if (claim.checkable === 'extracted') {
    return { claimId: claim.id, status: 'deferred', reason: 'extracted claims carry no truth judgment' };
  }
  switch (claim.type) {
    case 'visibility': return checkVisibility(scenario, claim);
    case 'causal-trigger': return checkCausalTrigger(scenario, claim);
    case 'intent': return checkIntent(scenario, claim);
    case 'spatial': return checkSpatial(scenario, claim);
  }
}

/** Judge a whole claim set. */
export function checkClaims(scenario: CorpusScenario, claims: readonly Claim[]): Verdict[] {
  return claims.map((c) => checkClaim(scenario, c));
}
