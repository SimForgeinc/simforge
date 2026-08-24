import { describe, expect, it } from 'vitest';

import {
  ACTOR_KINDS,
  DEFAULT_ACTOR_DIMS,
  parseSimScenarioInput,
  type ActorKind,
} from '../schema/input.js';
import { limitsFor } from '../sim/controllers.js';
import { evaluateTrace } from '../trace/evaluate.js';
import { runSimulation } from '../sim/engine.js';
import { LANE_LEFT, poseOnLane, syntheticGraph } from './fixtures/scenarios.js';

function actor(kind: ActorKind, dims?: { l: number; w: number; h: number }) {
  const graph = syntheticGraph();
  return {
    id: kind,
    kind,
    ...(dims ? { dims } : {}),
    initial: {
      laneRef: { rsl: LANE_LEFT, s: 20, tFrac: 0 },
      pose: poseOnLane(graph, LANE_LEFT, 20),
      speedMps: 0,
    },
    behavior: {
      route: { kind: 'follow' as const, startRsl: LANE_LEFT, turns: [], maxLengthM: 2000 },
      cruiseSpeedMps: 0,
    },
    tags: [`class:${kind}`],
  };
}

describe('semantic actor kinds', () => {
  it('accepts every class with engine-owned default dimensions', () => {
    for (const kind of ACTOR_KINDS) {
      const input = parseSimScenarioInput({ actors: [actor(kind)] });
      expect(input.actors[0]!.kind).toBe(kind);
      expect(input.actors[0]!.dims).toEqual(DEFAULT_ACTOR_DIMS[kind]);
      expect(input.actors[0]!.static).toBe(kind === 'static_object');
    }
  });

  it('keeps legacy kinds and explicit dimensions unchanged', () => {
    const dims = { l: 6.1, w: 2.1, h: 2.4 };
    const input = parseSimScenarioInput({ actors: [actor('vehicle', dims)] });
    expect(input.actors[0]).toMatchObject({ kind: 'vehicle', dims, static: false });
  });

  it('uses concrete heavy-vehicle and vulnerable-road-user limits', () => {
    expect(limitsFor({ kind: 'bus' }).accelMax).toBeLessThan(limitsFor({ kind: 'car' }).accelMax);
    expect(limitsFor({ kind: 'truck' }).brakeHard).toBeLessThan(limitsFor({ kind: 'vehicle' }).brakeHard);
    expect(limitsFor({ kind: 'bicycle' }).lateralRateMax).toBeLessThan(limitsFor({ kind: 'motorcycle' }).lateralRateMax);
    expect(limitsFor({ kind: 'animal' })).not.toBe(limitsFor({ kind: 'pedestrian' }));
  });

  it('carries semantic identity and render metadata into the trace header', () => {
    const graph = syntheticGraph();
    const input = parseSimScenarioInput({
      mapId: 'synthetic-straight',
      clipSeconds: 1,
      warmupSeconds: 0,
      actors: [actor('bus')],
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });

    expect(trace.header.actorMetadata).toEqual({
      bus: {
        kind: 'bus',
        dims: DEFAULT_ACTOR_DIMS.bus,
        static: false,
        tags: ['class:bus'],
      },
    });
  });
});

describe('executable operational conditions', () => {
  it('parses concrete effects, executes ambient speed, and propagates them to the trace', () => {
    const graph = syntheticGraph();
    const base = actor('car');
    const input = parseSimScenarioInput({
      mapId: 'conditions',
      clipSeconds: 1,
      warmupSeconds: 0,
      dt: 0.1,
      actors: [{
        ...base,
        initial: { ...base.initial, speedMps: 0 },
        behavior: { ...base.behavior, cruiseSpeedMps: 10 },
      }],
      operationalConditions: {
        weather: 'rain',
        timeOfDay: 'night',
        traffic: 'heavy',
        visibility: 'headlight-limited',
        effects: { visibilityRangeM: 60, frictionScale: 0.7, trafficSpeedFactor: 0.5 },
      },
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.header.operationalConditions).toEqual(input.operationalConditions);
    expect(trace.ticks.actors.car!.speedMps.at(-1)).toBeLessThan(5);
    expect(trace.header.inputHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses weather friction in trace-level hard eligibility', () => {
    const graph = syntheticGraph();
    const input = parseSimScenarioInput({
      mapId: 'friction',
      clipSeconds: 10,
      warmupSeconds: 0,
      actors: [actor('car')],
      operationalConditions: {
        weather: 'rain',
        timeOfDay: 'day',
        traffic: 'light',
        visibility: 'unrestricted',
        effects: { visibilityRangeM: 10_000, frictionScale: 0.5, trafficSpeedFactor: 1 },
      },
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    const forced = {
      ...trace,
      metrics: {
        ...trace.metrics,
        minTTC: { value: 1, t: 5, pair: ['car', 'hazard'] as [string, string] },
        requiredDecelMax: { car: 5 },
      },
    };
    expect(evaluateTrace(forced).findings.map((finding) => finding.code))
      .toContain('physically_unavoidable');
  });
});
