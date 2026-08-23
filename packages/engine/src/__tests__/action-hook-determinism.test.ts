/**
 * Phase-0 determinism identity: an externally injected action sequence must
 * produce byte-identical traces across repeated runs and across a fresh
 * session replay of the same action channel. This is the contract the RL
 * action loop (rl-plan Phase 1/2) relies on — the hook is the only coupling
 * between a policy and the engine, so it must not leak wall time, iteration
 * order, or session identity into the result.
 */
import {
  createFixedStepSimulation,
} from '../sim/engine.js';
import { serializeTrace, traceDigest } from '../trace/gzip.js';
import { describe, expect, it } from 'vitest';

import type { ActionHook, ActionOverride } from '../sim/engine.js';
import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';

const graph = syntheticGraph();

function twoCarScenario() {
  return scenario(graph, {
    // The hook drives setpoints into the force backend, so select it.
    physics: { mode: 'dynamic-v1' },
    metricSubject: 'ego',
    actors: [
      vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 10, cruiseSpeedMps: 10 }),
      vehicle(graph, { id: 'other', rsl: LANE_RIGHT, s: 30, speedMps: 8, cruiseSpeedMps: 8 }),
    ],
  });
}

const DT = 0.02;

/**
 * A fixed, precomputed action sequence. Indexed purely by simulation time —
 * never by call count or wall clock — which is what makes replay exact.
 */
const SPEED_PLAN_MPS: readonly number[] = Array.from(
  { length: Math.ceil(25 / DT) + 1 },
  (_, tick) => 8 + 4 * Math.sin(tick / 37) + (tick % 11) * 0.1,
);

/** Ego-only setpoint override drawn from the fixed plan table. */
function egoSpeedPlanHook(tickOf: (tS: number) => number): ActionHook {
  return ({ actorId, tS }): ActionOverride | undefined => {
    if (actorId !== 'ego') return undefined;
    return { targetSpeedMps: SPEED_PLAN_MPS[tickOf(tS)]! };
  };
}

function runEpisodeWith(hook: ActionHook) {
  const input = twoCarScenario();
  const session = createFixedStepSimulation(input, { graph, guards: 'collect', actionHook: hook });
  let progress = session.advance(7);
  while (!progress.done) progress = session.advance(7);
  return { input, trace: progress.trace!, done: progress.done };
}

describe('action-hook determinism identity', () => {
  it('injects setpoint actions and yields byte-equal traces across runs', () => {
    const first = runEpisodeWith(egoSpeedPlanHook((tS) => Math.round(tS / DT)));
    const second = runEpisodeWith(egoSpeedPlanHook((tS) => Math.round(tS / DT)));
    expect(first.done).toBe(true);
    expect(second.done).toBe(true);
    expect(traceDigest(first.trace)).toBe(traceDigest(second.trace));
    expect(traceDigest(first.trace)).not.toBe(
      traceDigest(runEpisodeWith(() => undefined).trace),
    );
    // …and the injected plan lifts the body above its authored cruise speed.
    const speeds = first.trace.ticks.actors.ego!.speedMps;
    expect(Math.max(...speeds)).toBeGreaterThan(10.5);
  });

  it('replays the same actions through a fresh session to an equal digest', () => {
    // A different (but still pure) time index proves the channel, not the
    // closure identity, determines the result.
    const recorded = runEpisodeWith(egoSpeedPlanHook((tS) => Math.round((tS + 5) / DT)));
    const replayed = runEpisodeWith(egoSpeedPlanHook((tS) => Math.round((tS + 5) / DT)));
    expect(traceDigest(recorded.trace)).toBe(traceDigest(replayed.trace));
  });

  it('keeps mid-episode stepping trace-free and snapshots identical state', () => {
    const a = createFixedStepSimulation(twoCarScenario(), {
      graph, guards: 'collect', actionHook: egoSpeedPlanHook((tS) => Math.round(tS / DT)),
    });
    const b = createFixedStepSimulation(twoCarScenario(), {
      graph, guards: 'collect', actionHook: egoSpeedPlanHook((tS) => Math.round(tS / DT)),
    });
    for (let batch = 0; batch < 40; batch += 1) {
      const pa = a.advance(3);
      const pb = b.advance(3);
      // Stepping batches never pay for buildTrace until the episode ends.
      if (!pa.done) expect(pa.trace).toBeNull();
      if (!pb.done) expect(pb.trace).toBeNull();
      expect(a.peek()).toEqual(b.peek());
      expect(a.peek().done).toBe(false);
    }
    const finalA = a.advance(10_000);
    const finalB = b.advance(10_000);
    expect(finalA.done).toBe(true);
    expect(finalB.done).toBe(true);
    expect(traceDigest(finalA.trace!)).toBe(traceDigest(finalB.trace!));
    const snapshot = a.peek();
    expect(snapshot.done).toBe(true);
    expect(snapshot.minima.length).toBeGreaterThan(0);
    expect(snapshot.actors.map((actor) => actor.id)).toEqual(['ego', 'other']);
  });

  it('passes raw VehicleControl through with steer clamp/lag intact and stays deterministic', () => {
    let steerRequests = 0;
    // Constant full-left steer request between t = 1 s and 5 s; the backend's
    // rate limit and lag shape how fast the wheel actually reaches the clamp.
    const controlHook: ActionHook = ({ actorId, tS }): ActionOverride | undefined => {
      if (actorId !== 'ego') return undefined;
      const tick = Math.round(tS / DT);
      if (tick < 50 || tick > 250) return undefined;
      steerRequests += 1;
      return { control: { throttle: 0.35, brake: 0, steer: -1 } };
    };
    const first = createFixedStepSimulation(twoCarScenario(), { graph, guards: 'collect', actionHook: controlHook });
    const second = createFixedStepSimulation(twoCarScenario(), { graph, guards: 'collect', actionHook: controlHook });
    const pa = first.advance(10_000);
    const pb = second.advance(10_000);
    expect(pa.done && pb.done).toBe(true);
    expect(traceDigest(pa.trace!)).toBe(traceDigest(pb.trace!));
    expect(steerRequests).toBeGreaterThan(200);
    // The passthrough steering must have turned the body left of its lane.
    const headings = pa.trace!.ticks.actors.ego!.headingRad;
    expect(Math.min(...headings)).toBeLessThan(-0.05);
  });
});
