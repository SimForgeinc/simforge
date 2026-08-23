import { describe, expect, it } from 'vitest';

import {
  createBlindReviewPacket,
  evaluateIntentRubric,
  intentRubricSchema,
  summarizeBehavior,
  type IntentRubric,
} from '../trace/intent-rubric.js';
import type { ActorTrack, SimTrace } from '../trace/trace.js';

const t = [0, 1, 2, 3, 4, 5];
function track(x: number[], speedMps: number[], lane = '1:0:-1'): ActorTrack {
  return { x, y: x.map(() => 0), headingRad: x.map(() => 0), speedMps, lateralOffsetM: x.map(() => 0), laneRsl: x.map(() => lane), s: x, present: x.map(() => 1) };
}

function trace(egoSpeeds = [0, 0, 0, 0, 0, 0]): SimTrace {
  return {
    header: { traceVersion: 2, engineVersion: 'test', inputHash: 'abc', seed: 1, mapId: 'fixture', engineGraphDigest: 'g', topologyDigest: 'g', dt: 1, clipSeconds: 5, warmupSeconds: 0, frame: 'xodr-local', actorIds: ['ego', 'ped'], metricSubject: 'ego', physics: { mode: 'kinematic-v1', solver: 'uniscenarios-sim-engine', solverVersion: 'test', substepS: 1, vehicleProfileDigest: null } },
    ticks: {
      t,
      actors: {
        ego: track([0, 0, 0, 0, 0, 0], egoSpeeds),
        ped: track([10, 8, 6, 4, 3, 2], [2, 2, 2, 2, 1, 0], '2:0:-1'),
      },
      signals: { main: { phase: ['red', 'red', 'red', 'green', 'green', 'green'] } },
    },
    events: [
      { t: 0, kind: 'trigger_fired', interactionId: 'ego-hold', actorId: 'ego', verb: 'set_speed', forced: false },
      { t: 3, kind: 'trigger_fired', interactionId: 'ped-clears', actorId: 'ped', verb: 'set_speed', forced: false },
    ],
    metrics: {
      minTTC: null,
      minPathTTC: null,
      minPET: null,
      criticalitySamples: { ttc: [], pathTTC: [], pet: [] },
      minDistance: [{ pair: ['ego', 'ped'], minDistanceM: 2, t: 5 }],
      requiredDecelMax: { ego: 0, ped: 1 },
      collisions: [], triggerNeverFired: [], clippedCriticality: false, ticksSimulated: 6,
      declaredOcclusion: [{ observer: 'ego', target: 'ped', pair: ['ego', 'ped'], relevantOccluderIds: ['van'], occluderId: 'van', status: 'revealed_before_conflict', firstBlockedT: 0, losOpenT: 2, conflictT: 4, revealToConflictS: 2 }],
    },
  };
}

function rubric(criteria: IntentRubric['criteria']): IntentRubric {
  return intentRubricSchema.parse({ version: 1, intentId: 'stationary-yield', title: 'Compliant stationary yield', originalIntent: 'Ego must remain stopped while the pedestrian clears.', criteria });
}

describe('intent rubric evaluator', () => {
  it('accepts a compliant stationary scenario without finite criticality', () => {
    const r = evaluateIntentRubric(trace(), rubric([
      { id: 'hold', kind: 'stationary_success', required: true, actorId: 'ego', window: [0, 5], maxSpeedMps: 0.1, minPresentSeconds: 5 },
      { id: 'order', kind: 'event_order', required: true, mode: 'required', interactionIds: ['ego-hold', 'ped-clears'] },
      { id: 'clearance', kind: 'clearance', required: true, pair: ['ego', 'ped'], measure: 'metric_gap', minM: 2 },
      { id: 'reveal', kind: 'occlusion', required: true, observer: 'ego', target: 'ped', occluderId: 'van', outcome: 'blocked_then_revealed' },
      { id: 'red-seen', kind: 'control_indication', required: true, signalId: 'main', indications: ['red'], mode: 'required' },
      { id: 'no-contact', kind: 'collision', required: true, maxCount: 0 },
    ]));
    expect(r.verdict).toBe('accept');
    expect(r.counts).toEqual({ pass: 6, fail: 0, unchecked: 0, unsupported: 0 });
    expect(r.criteria.every((c) => c.evidence.length > 0)).toBe(true);
    expect(r.behaviorSummary.actors.find((a) => a.actorId === 'ego')).toMatchObject({ maxSpeedMps: 0, distanceTravelledM: 0 });
  });

  it('rejects a deliberately flawed stationary scenario with trace evidence', () => {
    const r = evaluateIntentRubric(trace([0, 0, 0.4, 0.4, 0, 0]), rubric([
      { id: 'hold', kind: 'stationary_success', required: true, actorId: 'ego', maxSpeedMps: 0.1 },
      { id: 'forbidden-order', kind: 'event_order', required: true, mode: 'forbidden', interactionIds: ['ego-hold', 'ped-clears'] },
    ]));
    expect(r.verdict).toBe('reject');
    expect(r.criteria.map((c) => c.status)).toEqual(['fail', 'fail']);
    expect(r.criteria[0]!.evidence[0]!.values).toMatchObject({ observedMaxSpeedMps: 0.4 });
  });

  it('fails required unchecked and unsupported criteria but permits optional ones', () => {
    const required = evaluateIntentRubric(trace(), rubric([
      { id: 'missing', kind: 'speed_band', required: true, actorId: 'ghost', maxMps: 1 },
      { id: 'semantic-only', kind: 'unsupported', required: true, description: 'officer intent is understood', reason: 'mental state is not trace observable' },
    ]));
    expect(required.verdict).toBe('reject');
    expect(required.criteria.map((c) => c.status)).toEqual(['unchecked', 'unsupported']);

    const optional = evaluateIntentRubric(trace(), rubric([
      { id: 'missing', kind: 'speed_band', required: false, actorId: 'ghost', maxMps: 1 },
      { id: 'semantic-only', kind: 'unsupported', required: false, description: 'officer intent is understood', reason: 'mental state is not trace observable' },
    ]));
    expect(optional.verdict).toBe('accept');
  });

  it('produces deterministic, bounded summaries and a blind-review seam', () => {
    const input = rubric([{ id: 'hold', kind: 'stationary_success', required: true, actorId: 'ego', maxSpeedMps: 0.1 }]);
    const evaluation = evaluateIntentRubric(trace(), input);
    expect(summarizeBehavior(trace(), { maxActors: 1, maxEvents: 1, maxOcclusions: 1 })).toEqual(summarizeBehavior(trace(), { maxActors: 1, maxEvents: 1, maxOcclusions: 1 }));
    const packet = createBlindReviewPacket(input, evaluation);
    expect(packet.machineEvaluation).not.toHaveProperty('behaviorSummary');
    expect(packet).not.toHaveProperty('trace');
    expect(JSON.stringify(packet).length).toBeLessThan(30_000);
  });
});
