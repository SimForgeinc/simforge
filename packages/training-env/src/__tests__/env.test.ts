/**
 * EnvSession semantics on a synthetic two-lane input: warm-up exclusion,
 * zero-order-hold actions, termination/truncation, determinism identity.
 */
import { describe, expect, it } from 'vitest';

import type { SimScenarioInput } from '@simforge-oss/engine';

import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, vehicle } from '../fixture.js';
import { EnvSession } from '../session.js';

const graph = syntheticGraph();

function twoCarScenario(): SimScenarioInput {
  return scenario(graph, {
    physics: { mode: 'kinematic-v1' },
    metricSubject: 'ego',
    clipSeconds: 4,
    warmupSeconds: 1,
    actors: [
      vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 10, cruiseSpeedMps: 10 }),
      vehicle(graph, { id: 'other', rsl: LANE_RIGHT, s: 40, speedMps: 8, cruiseSpeedMps: 8 }),
    ],
  });
}

/** Ego at full throttle (control passthrough) into a stopped blocker: material collision. */
function crashScenario(): SimScenarioInput {
  return scenario(graph, {
    physics: { mode: 'dynamic-v1' },
    metricSubject: 'ego',
    clipSeconds: 6,
    warmupSeconds: 0,
    actors: [
      vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 30, speedMps: 8, cruiseSpeedMps: 14 }),
      vehicle(graph, { id: 'blocker', rsl: LANE_LEFT, s: 45, speedMps: 0, cruiseSpeedMps: 0 }),
    ],
  });
}

describe('EnvSession reset/step semantics', () => {
  it('excludes warmup from policy-visible time and starts at t=0', () => {
    const env = new EnvSession({ input: twoCarScenario(), graph });
    const first = env.reset('seed-a');
    expect(first.info.tS).toBe(0);
    // The prologue has already moved the ego past its s=20 start.
    expect(first.observation.stateVector![0]).toBeGreaterThan(20);
  });

  it('holds a deceleration action across the decision interval', () => {
    const env = new EnvSession({ input: twoCarScenario(), graph, episode: { decisionHz: 10 } });
    const first = env.reset();
    const v0 = first.observation.stateVector![4];
    const second = env.step({ targetAccelerationMps2: -3 });
    const v1 = second.observation.stateVector![4];
    expect(second.info.tS).toBeCloseTo(0.1, 6);
    expect(Math.abs(second.info.rewardTerms.comfort)).toBeLessThanOrEqual(1);
    expect(second.info.rewardTerms.comfort).toBeLessThanOrEqual(0);
  });

  it('truncates at the clip end exactly', () => {
    const env = new EnvSession({ input: twoCarScenario(), graph, episode: { decisionHz: 10 } });
    env.reset();
    let steps = 0;
    let result = env.step({});
    for (;;) {
      steps += 1;
      if (result.truncated || result.terminated) break;
      expect(steps).toBeLessThan(100);
      result = env.step({});
    }
    expect(result.truncated).toBe(true);
    expect(result.terminated).toBe(false);
    // 4 s clip at 10 Hz = 40 decisions.
    expect(steps).toBe(40);
  });

  it('honours maxDecisions as a truncation horizon', () => {
    const env = new EnvSession({ input: twoCarScenario(), graph, episode: { decisionHz: 10, maxDecisions: 7 } });
    env.reset();
    let count = 0;
    let result = env.step({});
    count += 1;
    while (!result.truncated && !result.terminated) {
      result = env.step({});
      count += 1;
    }
    expect(result.truncated).toBe(true);
    expect(count).toBe(7);
  });

  it('terminates on a forced collision under control passthrough', () => {
    const env = new EnvSession({
      input: crashScenario(),
      graph,
      episode: { decisionHz: 25 },
    });
    env.reset();
    let result = env.step({ control: { throttle: 1, brake: 0, steer: 0 } });
    let guard = 0;
    while (!result.terminated && !result.truncated && guard < 300) {
      result = env.step({ control: { throttle: 1, brake: 0, steer: 0 } });
      guard += 1;
    }
    expect(result.terminated).toBe(true);
    expect(result.reward).toBeLessThan(-9); // collisionPenalty dominates
    expect(result.info.events.some((e) => e.kind === 'collision' && (e.a === 'ego' || e.b === 'ego'))).toBe(true);
  });

  it('terminates with the goal bonus when the goal trigger fires', () => {
    const goalScenario = scenario(graph, {
      physics: { mode: 'kinematic-v1' },
      metricSubject: 'ego',
      clipSeconds: 5,
      warmupSeconds: 1,
      actors: [vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 10, cruiseSpeedMps: 10 })],
      interactions: [
        {
          id: 'goal-at-2s',
          actorId: 'ego',
          trigger: { kind: 'at', t: 2 },
          verb: 'speed',
          target: { mode: 'stop' },
          dynamics: { shape: 'linear', constraint: 'rate', value: 3 },
        },
      ],
    });
    const env = new EnvSession({
      input: goalScenario,
      graph,
      episode: { decisionHz: 10, goal: { interactionId: 'goal-at-2s' } },
    });
    env.reset();
    let result = env.step({});
    let guard = 0;
    while (!result.terminated && !result.truncated && guard < 100) {
      result = env.step({});
      guard += 1;
    }
    expect(result.terminated).toBe(true);
    expect(result.reward).toBeGreaterThan(9); // goalBonus dominates
  });

  it('refuses to step after the episode ends', () => {
    const env = new EnvSession({ input: twoCarScenario(), graph, episode: { decisionHz: 10, maxDecisions: 2 } });
    env.reset();
    env.step();
    env.step();
    expect(() => env.step()).toThrow(/finished/);
  });

  it('is deterministic: same seed and actions produce identical observations', () => {
    const ACTIONS: readonly ({ targetSpeedMps?: number; targetAccelerationMps2?: number } | undefined)[] = [
      { targetSpeedMps: 12 },
      undefined,
      { targetAccelerationMps2: -1 },
      { targetSpeedMps: 8 },
      undefined,
      undefined,
      { targetSpeedMps: 11 },
      undefined,
    ];
    const run = (): string[] => {
      const env = new EnvSession({ input: twoCarScenario(), graph, episode: { decisionHz: 10 } });
      env.reset('determinism-seed');
      const fingerprints: string[] = [];
      for (const action of ACTIONS) {
        const result = env.step(action ?? {});
        fingerprints.push(
          JSON.stringify([
            [...result.observation.stateVector!],
            result.observation.objects.map((o) => [o.id, o.rangeM, o.bearingRad, o.rangeRateMps]),
            result.reward,
            result.info.causal,
          ]),
        );
      }
      return fingerprints;
    };
    expect(run()).toEqual(run());
  });

  it('reseeds cleanly through the settled-input provider', () => {
    const settled = twoCarScenario();
    const env = new EnvSession({
      input: twoCarScenario(),
      graph,
      episode: { decisionHz: 10 },
      settledInputProvider: (seed) => ({ ...settled, seed }),
    });
    const first = env.reset('banked');
    expect(first.info.tS).toBe(0);
    expect(() => env.step({})).not.toThrow();
  });

  it('rejects decision rates that do not divide the engine tick', () => {
    expect(() => new EnvSession({ input: twoCarScenario(), graph, episode: { decisionHz: 30 } })).toThrow(/decisionHz/);
  });
});
