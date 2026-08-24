/**
 * Ground-truth claim derivation.
 *
 * Derives the *true* claims.v1 set for a corpus scenario from the engine
 * artifacts alone — no natural language involved. This is the reference the
 * extractor is benchmarked against and the pool perturbations corrupt:
 *
 * - visibility intervals: maximal constant-LOS runs per evaluated pair;
 * - causal-trigger chains: each trigger/genesis event followed by the next
 *   event in the channel;
 * - intents: one per authored interaction that actually fired/completed;
 * - spatial relations: maximal constant-relation runs per actor vs ego.
 */

import { CAUSAL_GAP_S, type Claim, type EventRef } from './claims.js';
import type { CorpusScenario } from './corpus.js';
import {
  allGenesis,
  allTriggers,
  losTimeline,
  pairEvaluated,
  SPATIAL_MARGIN_M,
} from './timeline.js';
import { intentVerbOf } from './checkers.js';

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Reset the derivation id counter; only useful for reproducible tests. */
export function resetClaimIds(): void {
  counter = 0;
}

interface Interval {
  readonly fromTS: number;
  readonly toTS: number;
}

/* -------------------------------------------------------------- visibility */

function deriveVisibility(scenario: CorpusScenario): Claim[] {
  const out: Claim[] = [];
  const targets = Object.keys(scenario.actorKinds).sort();
  for (const targetId of targets) {
    const timeline = losTimeline(scenario, scenario.egoId, targetId);
    let start: number | null = null;
    let state: boolean | null = null;
    const flush = (endTS: number) => {
      if (start === null || state === null) return;
      if (endTS - start < 1 / scenario.decisionHz) return;
      out.push({
        schema: 'https://uniscenarios.dev/schemas/claims.v1.json',
        id: nextId('vis'),
        type: 'visibility',
        actorIds: [targetId],
        tickRange: { fromTS: start, toTS: endTS },
        checkable: 'deterministic',
        state: state ? 'visible' : 'occluded',
      });
    };
    for (const sample of timeline) {
      const i = tickIndexOf(scenario, sample.tS);
      const evaluated = i >= 0 && pairEvaluated(scenario, scenario.egoId, targetId, i);
      const effective = evaluated ? sample.visible : null;
      if (effective === null) {
        flush(sample.tS);
        start = null;
        state = null;
        continue;
      }
      if (state === null || effective !== state) {
        flush(sample.tS);
        start = sample.tS;
        state = effective;
      }
    }
    flush(timeline[timeline.length - 1]?.tS ?? 0);
  }
  return out;
}

function tickIndexOf(scenario: CorpusScenario, tS: number): number {
  const t = scenario.tracks[scenario.egoId]!.t;
  for (let i = 0; i < t.length; i++) {
    if (Math.abs(t[i]! - tS) <= 1e-3) return i;
  }
  return -1;
}

/* ---------------------------------------------------------- causal-trigger */

type ChannelEvent = { tS: number; ref: EventRef; actors: string[] };

function channelEvents(scenario: CorpusScenario): ChannelEvent[] {
  const out: ChannelEvent[] = [];
  for (const tr of allTriggers(scenario)) {
    const kind: EventRef['kind'] =
      tr.kind === 'fired' ? 'trigger-fired'
      : tr.kind === 'skipped' ? 'trigger-skipped'
      : tr.kind === 'preemption' ? 'preemption'
      : tr.kind === 'released' ? 'released'
      : 'completed';
    out.push({ tS: tr.tS, ref: { kind, interactionId: tr.interactionId, actorId: tr.actorId }, actors: [tr.actorId] });
  }
  for (const g of allGenesis(scenario)) {
    out.push({ tS: g.tS, ref: { kind: 'conflict-genesis', metric: g.metric }, actors: [g.a, g.b] });
  }
  return out.sort((a, b) => a.tS - b.tS);
}


function deriveCausalChains(scenario: CorpusScenario): Claim[] {
  const events = channelEvents(scenario);
  const out: Claim[] = [];
  for (let i = 0; i < events.length; i++) {
    const cause = events[i]!;
    // Effect: the very next event sharing an actor (or any event when none shares).
    let effect: ChannelEvent | null = null;
    for (let j = i + 1; j < events.length; j++) {
      if (events[j]!.actors.some((a) => cause.actors.includes(a))) {
        effect = events[j]!;
        break;
      }
    }
    if (!effect && i + 1 < events.length) effect = events[i + 1]!;
    if (!effect) continue;
    // Two events at the same decision tick carry no ordering information; a
    // claim over them is not checkable either way, so emit no chain.
    if (effect.tS <= cause.tS + 1e-9) continue;
    const gap = effect.tS - cause.tS;
    out.push({
      schema: 'https://uniscenarios.dev/schemas/claims.v1.json',
      id: nextId('trg'),
      type: 'causal-trigger',
      actorIds: [...cause.actors],
      tickRange: { fromTS: Math.max(0, cause.tS - 0.2), toTS: effect.tS + 0.1 },
      checkable: 'deterministic',
      cause: cause.ref,
      effect: effect.ref,
      relation: gap <= CAUSAL_GAP_S ? 'causes' : 'precedes',
    });
  }
  return out;
}

/* ------------------------------------------------------------------ intent */

function deriveIntents(scenario: CorpusScenario): Claim[] {
  const executedIds = new Set(
    allTriggers(scenario)
      .filter((t) => t.kind === 'fired' || t.kind === 'preemption' || t.kind === 'completed')
      .map((t) => t.interactionId),
  );
  const out: Claim[] = [];
  for (const it of scenario.interactions) {
    if (!executedIds.has(it.id)) continue;
    out.push({
      schema: 'https://uniscenarios.dev/schemas/claims.v1.json',
      id: nextId('int'),
      type: 'intent',
      actorIds: [it.actorId],
      tickRange: {
        fromTS: Math.max(0, (it.window?.startS ?? 0) - 0),
        toTS: scenario.causalChannel.frames[scenario.causalChannel.frames.length - 1]?.tS ?? scenario.clipSeconds,
      },
      checkable: 'deterministic',
      verb: intentVerbOf(it),
      interactionId: it.id,
    });
  }
  return out;
}

/* ----------------------------------------------------------------- spatial */

const SPATIAL_RELATIONS_CYCLE = ['ahead-of', 'behind', 'left-of', 'right-of'] as const;

function classifyOffsets(longM: number, latM: number): (typeof SPATIAL_RELATIONS_CYCLE)[number] | null {
  if (longM >= SPATIAL_MARGIN_M) return 'ahead-of';
  if (longM <= -SPATIAL_MARGIN_M) return 'behind';
  if (latM >= SPATIAL_MARGIN_M) return 'left-of';
  if (latM <= -SPATIAL_MARGIN_M) return 'right-of';
  return null;
}

function deriveSpatial(scenario: CorpusScenario): Claim[] {
  const out: Claim[] = [];
  const track = scenario.tracks[scenario.egoId];
  if (!track) return out;
  for (const actorId of Object.keys(scenario.actorKinds).sort()) {
    let start: number | null = null;
    let current: (typeof SPATIAL_RELATIONS_CYCLE)[number] | null = null;
    const flush = (endTS: number) => {
      if (start === null || current === null) return;
      if (endTS - start < 1 / scenario.decisionHz) return;
      out.push({
        schema: 'https://uniscenarios.dev/schemas/claims.v1.json',
        id: nextId('spa'),
        type: 'spatial',
        actorIds: [actorId],
        tickRange: { fromTS: start, toTS: endTS },
        checkable: 'deterministic',
        relation: current,
        referenceActorId: scenario.egoId,
      });
    };
    for (let i = 0; i < track.t.length; i++) {
      const r = scenario.tracks[scenario.egoId]!;
      const a = scenario.tracks[actorId];
      if (!a || r.present[i] !== 1 || a.present[i] !== 1) continue;
      const dx = a.x[i]! - r.x[i]!;
      const dy = a.y[i]! - r.y[i]!;
      const h = r.headingRad[i]!;
      const longM = dx * Math.cos(h) + dy * Math.sin(h);
      const latM = dx * -Math.sin(h) + dy * Math.cos(h);
      const rel = classifyOffsets(longM, latM);
      const t = r.t[i]!;
      if (rel === null) {
        flush(t);
        start = null;
        current = null;
        continue;
      }
      if (current === null || rel !== current) {
        flush(t);
        start = t;
        current = rel;
      }
    }
    flush(track.t[track.t.length - 1] ?? 0);
  }
  return out;
}

/* -------------------------------------------------------------- public API */

/** Derive the full true claim set for a corpus scenario. */
export function deriveTrueClaims(scenario: CorpusScenario): Claim[] {
  return [
    ...deriveVisibility(scenario),
    ...deriveCausalChains(scenario),
    ...deriveIntents(scenario),
    ...deriveSpatial(scenario),
  ];
}
