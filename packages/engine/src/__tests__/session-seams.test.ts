/**
 * Phase-1 RL seams on the fixed-step session: enriched `peek()` snapshots
 * (acceleration, lateral state, route arc length) and `drainEvents()`.
 *
 * The contract the rl-env rollout loop relies on:
 *  - snapshot fields are present and correct on a synthetic input;
 *  - draining returns each event exactly once, then nothing;
 *  - draining mid-episode never changes trace content — the digest of a fully
 *    drained episode is byte-equal to one that was never drained.
 */
import { createFixedStepSimulation } from '../sim/engine.js';
import { serializeTrace, traceDigest } from '../trace/gzip.js';
import { describe, expect, it } from 'vitest';

import type { ActionHook, ActionOverride } from '../sim/engine.js';
import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';

const graph = syntheticGraph();
const DT = 0.02;

function twoCarScenario() {
  return scenario(graph, {
    physics: { mode: 'dynamic-v1' },
    metricSubject: 'ego',
    actors: [
      vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 10, cruiseSpeedMps: 10 }),
      vehicle(graph, { id: 'other', rsl: LANE_RIGHT, s: 30, speedMps: 8, cruiseSpeedMps: 8 }),
    ],
  });
}

/** Constant-throttle plan so acceleration is a known nonzero value. */
const brakeHook: ActionHook = ({ actorId }): ActionOverride | undefined =>
  actorId === 'ego' ? { targetAccelerationMps2: -2 } : undefined;

describe('session peek enrichment', () => {
  it('reports accel, lateral state and route-s in snapshots', () => {
    const session = createFixedStepSimulation(twoCarScenario(), {
      graph,
      guards: 'collect',
      actionHook: brakeHook,
    });
    // Step into the recorded clip (fixture default warm-up is 5 s).
    session.advance(Math.round(5.5 / DT));
    const snap = session.peek();
    expect(snap.tS).toBeCloseTo(0.5, 1);
    for (const actor of snap.actors) {
      expect(Number.isFinite(actor.accelMps2)).toBe(true);
      expect(Number.isFinite(actor.lateralOffsetM)).toBe(true);
      expect(Number.isFinite(actor.lateralRateMps)).toBe(true);
      expect(actor.s).toBeGreaterThan(0);
      if (actor.id === 'ego') {
        // Braking at a constant setpoint: acceleration must be negative.
        expect(actor.accelMps2).toBeLessThan(0);
        // Straight fixture lane: lateral offset stays centered.
        expect(Math.abs(actor.lateralOffsetM)).toBeLessThan(0.5);
      }
    }
  });

  it('keeps route-s monotonic under forward motion', () => {
    const session = createFixedStepSimulation(twoCarScenario(), { graph, guards: 'collect' });
    let lastS = new Map<string, number>();
    for (let i = 0; i < 50; i += 1) {
      session.advance(10);
      for (const a of session.peek().actors) {
        const prev = lastS.get(a.id);
        if (prev !== undefined) expect(a.s).toBeGreaterThanOrEqual(prev - 1e-9);
        lastS.set(a.id, a.s);
      }
    }
  });
});

/** Scenario whose `at t=1` speed trigger guarantees session-side events. */
function eventfulScenario() {
  return scenario(graph, {
    physics: { mode: 'dynamic-v1' },
    metricSubject: 'ego',
    actors: [
      vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 10, cruiseSpeedMps: 10 }),
      vehicle(graph, { id: 'other', rsl: LANE_RIGHT, s: 30, speedMps: 8, cruiseSpeedMps: 8 }),
    ],
    interactions: [
      {
        id: 'brake-at-1s',
        actorId: 'ego',
        trigger: { kind: 'at', t: 1 },
        verb: 'speed',
        target: { mode: 'stop' },
        dynamics: { shape: 'linear', constraint: 'rate', value: 3 },
      },
    ],
  });
}

function runEpisode(drainEvery: number | null) {
  const session = createFixedStepSimulation(eventfulScenario(), { graph, guards: 'collect' });
  let drainedTotal = 0;
  let ticks = 0;
  while (!session.done) {
    session.advance(13);
    ticks += 13;
    if (drainEvery !== null && ticks % drainEvery === 0) {
      drainedTotal += session.drainEvents().length;
    }
  }
  const trace = session.advance(0).trace!;
  return { digest: traceDigest(trace), drainedTotal };
}

describe('drainEvents', () => {
  it('returns events once then empty', () => {
    const session = createFixedStepSimulation(eventfulScenario(), { graph, guards: 'collect' });
    while (!session.done) session.advance(50);
    const first = session.drainEvents();
    expect(first.some((e) => e.kind === 'trigger_fired')).toBe(true);
    expect(session.drainEvents()).toEqual([]);
    // Event order is record order, which is tick order.
    for (let i = 1; i < first.length; i += 1) {
      expect(first[i]!.t).toBeGreaterThanOrEqual(first[i - 1]!.t);
    }
  });

  it('does not change the trace digest when drained mid-episode', () => {
    const undrained = runEpisode(null);
    const drained = runEpisode(26);
    expect(drained.digest).toBe(undrained.digest);
    expect(drained.drainedTotal).toBeGreaterThan(0);
  });

  it('leaves the serialized event list identical to the trace build', () => {
    const session = createFixedStepSimulation(eventfulScenario(), { graph, guards: 'collect' });
    session.advance(Math.round(6 / DT));
    const drained = [...session.drainEvents()];
    const trace = session.advance(0, { trace: true }).trace!;
    for (const event of drained) expect(trace.events).toContainEqual(event);
    expect(trace.events.length).toBeGreaterThanOrEqual(drained.length);
  });
});
