/**
 * Causal GT channel contract: versioned schema, byte-exact round trip, LOS
 * transition detection, trigger causality, conflict genesis — and the
 * historical-trace guarantee that attaching nothing changes a trace digest.
 */
import { canonicalJson, serializeTrace, traceDigest, runSimulation } from '@simforge/engine';
import { describe, expect, it } from 'vitest';

import {
  CausalChannelCollector,
  CAUSAL_CHANNEL_VERSION,
  parseCausalChannel,
  serializeCausalChannel,
} from '../causal.js';
import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, vehicle } from '../fixture.js';
import { EnvSession } from '../session.js';

const graph = syntheticGraph();

function collector(): CausalChannelCollector {
  return new CausalChannelCollector('ego', 10, new Map());
}

describe('causal channel schema', () => {
  it('round trips byte-exactly', () => {
    const c = collector();
    c.observe(0.1, [{ observerId: 'ego', targetId: 'other', visible: true }], [], []);
    c.observe(
      0.2,
      [{ observerId: 'ego', targetId: 'other', visible: false }],
      [
        { t: 0.2, kind: 'trigger_fired', interactionId: 'dart', actorId: 'ped', verb: 'speed', forced: false },
      ],
      [{ a: 'ego', b: 'other', minDistanceM: 3, minTtcS: 1.5, minPathTtcS: Infinity, minPetS: Infinity }],
    );
    const channel = c.channel();
    expect(channel.causalVersion).toBe(CAUSAL_CHANNEL_VERSION);
    const bytes = serializeCausalChannel(channel);
    const parsed = parseCausalChannel(bytes);
    // Byte-exact: canonical JSON of the parse equals the original bytes.
    expect(new TextDecoder().decode(serializeCausalChannel(parsed))).toBe(new TextDecoder().decode(bytes));
  });

  it('rejects unknown channel versions on read', () => {
    const bad = serializeCausalChannel({ ...collector().channel(), causalVersion: 99 as typeof CAUSAL_CHANNEL_VERSION });
    expect(() => parseCausalChannel(bad)).toThrow(/version/);
  });

  it('emits an LOS transition only when visibility flips', () => {
    const c = collector();
    const visible = [{ observerId: 'ego', targetId: 't', visible: true }];
    c.observe(0.1, visible, [], []);
    c.observe(0.2, visible, [], []);
    c.observe(0.3, [{ observerId: 'ego', targetId: 't', visible: false }], [], []);
    const transitions = c.channel().frames.map((f) => f.losTransitions);
    expect(transitions[0]).toEqual([{ observerId: 'ego', targetId: 't', becameVisible: true }]);
    expect(transitions[1]).toEqual([]);
    expect(transitions[2]).toEqual([{ observerId: 'ego', targetId: 't', becameVisible: false }]);
  });

  it('records conflict genesis once per pair per metric at threshold crossing', () => {
    const c = collector();
    const minima = [{ a: 'ego', b: 'x', minDistanceM: 8, minTtcS: 4, minPathTtcS: Infinity, minPetS: Infinity }];
    c.observe(0.1, [], [], minima);
    const closer = [{ a: 'ego', b: 'x', minDistanceM: 2.5, minTtcS: 2, minPathTtcS: Infinity, minPetS: Infinity }];
    c.observe(0.2, [], [], closer);
    c.observe(0.3, [], [], closer);
    const frames = c.channel().frames;
    expect(frames[0]!.conflictGenesis).toEqual([]);
    expect(frames[1]!.conflictGenesis).toHaveLength(2); // ttc + distance both cross here
    expect(frames[2]!.conflictGenesis).toEqual([]);
    expect(frames[1]!.conflictGenesis).toContainEqual({
      a: 'ego',
      b: 'x',
      metric: 'ttc',
      threshold: 3,
      value: 2,
    });
  });
});

describe('causal channel from a live EnvSession', () => {
  it('captures the authored predicate for every fired trigger', () => {
    const dart = scenario(graph, {
      physics: { mode: 'kinematic-v1' },
      metricSubject: 'ego',
      clipSeconds: 4,
      warmupSeconds: 1,
      actors: [
        vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 10, cruiseSpeedMps: 10 }),
        vehicle(graph, { id: 'other', rsl: LANE_RIGHT, s: 40, speedMps: 8, cruiseSpeedMps: 8 }),
      ],
      interactions: [
        {
          id: 'brake-now',
          actorId: 'ego',
          trigger: { kind: 'at', t: 0.5 },
          verb: 'speed',
          target: { mode: 'stop' },
          dynamics: { shape: 'linear', constraint: 'rate', value: 3 },
        },
      ],
    });
    const env = new EnvSession({
      input: dart,
      graph,
      episode: { decisionHz: 10, goal: { interactionId: 'brake-now' } },
    });
    env.reset();
    let result = env.step({});
    let guard = 0;
    while (!result.terminated && !result.truncated && guard < 60) {
      result = env.step({});
      guard += 1;
    }
    const channel = result.info.causalChannel();
    const fired = channel.frames.flatMap((f) => f.triggers).filter((t) => t.kind === 'fired');
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.every((t) => t.condition !== undefined && t.condition.includes('"kind":"at"'))).toBe(true);
  });
});

describe('historical trace digest stability', () => {
  /**
   * The engine's own trace must not move when the causal channel exists
   * alongside it: the channel is optional trace-side state (ambientActorIds
   * precedent), so a rc.45 trace without it digests identically before and
   * after rl-env ever runs.
   */
  it('leaves a generated rc.45 trace digest unchanged with and without the channel', () => {
    const input = scenario(graph, {
      physics: { mode: 'kinematic-v1' },
      metricSubject: 'ego',
      clipSeconds: 3,
      warmupSeconds: 1,
      actors: [
        vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 10, cruiseSpeedMps: 10 }),
        vehicle(graph, { id: 'other', rsl: LANE_RIGHT, s: 40, speedMps: 8, cruiseSpeedMps: 8 }),
      ],
      interactions: [
        {
          id: 'stop-at-1',
          actorId: 'ego',
          trigger: { kind: 'at', t: 1 },
          verb: 'speed',
          target: { mode: 'stop' },
          dynamics: { shape: 'linear', constraint: 'rate', value: 3 },
        },
      ],
    });
    const { trace } = runSimulation(input, { graph });
    const baseline = traceDigest(trace);

    // Canonical serialization is stable under re-quantization.
    expect(traceDigest(JSON.parse(new TextDecoder().decode(serializeTrace(trace))) as typeof trace)).toBe(baseline);

    // Attaching the channel produces a superset object; the original trace is untouched.
    const env = new EnvSession({ input, graph, episode: { decisionHz: 10 } });
    env.reset();
    let result = env.step({});
    while (!result.truncated && !result.terminated) result = env.step({});
    const attached = { ...trace, ...result.info.causalChannel() };
    expect(traceDigest(trace)).toBe(baseline);
    expect('causalVersion' in attached).toBe(true);
    // And a trace that never carries the channel has no causal key at all.
    expect(Object.keys(trace)).not.toContain('causalVersion');
    expect(canonicalJson(trace)).not.toContain('"causalVersion"');
  });
});
