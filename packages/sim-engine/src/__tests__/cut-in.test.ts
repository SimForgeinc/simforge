/**
 * C2 cut-in composed from primitives: `changeLane` on a `when(distance ≤ X)`
 * trigger. This is the archetype the R157 grids parameterise by lateral
 * velocity, so the assertions are on the lateral profile, not just the outcome.
 */

import { describe, expect, it } from 'vitest';
import { runSimulation } from '../sim/engine.js';
import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';
import { LANE_LEFT_2 } from './fixtures/synthetic-map.js';

const graph = syntheticGraph();

function cutInScenario(lateralRateMps: number, triggerDistanceM = 25) {
  return scenario(graph, {
    metricSubject: 'ego',
    clipSeconds: lateralRateMps < 0.6 ? 25 : 20,
    // The challenger overtakes in the adjacent lane, then cuts in when it is
    // within `triggerDistanceM` of the ego.
    actors: [
      vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 90, speedMps: 14, cruiseSpeedMps: 14 }),
      vehicle(graph, { id: 'challenger', rsl: LANE_RIGHT, s: 20, speedMps: 18, cruiseSpeedMps: 18 }),
    ],
    interactions: [
      {
        id: 'cut-in',
        actorId: 'challenger',
        trigger: {
          kind: 'when',
          condition: {
            kind: 'distance',
            a: 'challenger',
            b: 'ego',
            mode: 'euclidean',
            cmp: 'lte',
            value: triggerDistanceM,
          },
          byLatest: 15,
          ifNever: 'skip',
        },
        verb: 'changeLane',
        target: { mode: 'left', count: 1 },
        dynamics: { shape: 'sinusoidal', constraint: 'rate', value: lateralRateMps },
      },
    ],
  });
}

describe('cut-in composition', () => {
  it('changes lane on a distance trigger and lands on the target lane', () => {
    const { trace } = runSimulation(cutInScenario(1.0), { graph });
    const track = trace.ticks.actors['challenger']!;

    const fired = trace.events.find((e) => e.kind === 'trigger_fired' && e.interactionId === 'cut-in');
    expect(fired).toBeDefined();

    const laneChange = trace.events.find((e) => e.kind === 'lane_change');
    expect(laneChange).toMatchObject({ actorId: 'challenger', toRsl: LANE_LEFT, legal: true });

    // Starts in the right lane (y = -3.5) and finishes in the left (y = 0).
    expect(track.y[0]!).toBeCloseTo(-3.5, 3);
    const completed = trace.events.find((event) => event.kind === 'interaction_completed' && event.interactionId === 'cut-in')!;
    expect(completed).toMatchObject({ finalLateralOffsetM: 0 });
    // The actor keeps its travelled station through the route hand-off and
    // therefore reaches the directed successor during the remainder of the clip.
    expect([LANE_LEFT, LANE_LEFT_2]).toContain(track.laneRsl[track.laneRsl.length - 1]);
  });

  it('respects the commanded lateral velocity', () => {
    for (const rate of [0.4, 1.0]) {
      const { trace } = runSimulation(cutInScenario(rate), { graph });
      const track = trace.ticks.actors['challenger']!;
      const completed = trace.events.find((event) => event.kind === 'interaction_completed' && event.interactionId === 'cut-in')!;
      const completedIndex = trace.ticks.t.findIndex((time) => time >= completed.t - 1e-9);
      let peak = 0;
      for (let i = 1; i <= completedIndex; i++) peak = Math.max(peak, Math.abs(track.lateralOffsetM[i]! - track.lateralOffsetM[i - 1]!) / 0.02);
      // `rate` under a `sinusoidal` shape means *peak* lateral velocity.
      expect(peak).toBeLessThanOrEqual(rate * 1.05);
      expect(peak).toBeGreaterThan(rate * 0.8);
    }
  });

  it('a slower lateral velocity takes proportionally longer', () => {
    const duration = (rate: number) => {
      const { trace } = runSimulation(cutInScenario(rate), { graph });
      const track = trace.ticks.actors['challenger']!;
      const start = track.y.findIndex((y) => y > -3.45);
      const end = track.y.findIndex((y) => y > -0.05);
      return (end - start) * 0.02;
    };
    const slow = duration(0.4);
    const fast = duration(1.0);
    // The authored rate remains monotone, while the force-based steering
    // plant adds finite settling time at both rates. It therefore must be
    // materially slower, but no longer has the exact inverse-duration ratio
    // of the removed kinematic sampler.
    expect(slow / fast).toBeGreaterThan(1.3);
    expect(slow / fast).toBeLessThan(3.0);
  });

  it('records a preemption when a second interaction takes the lateral axis', () => {
    const input = scenario(graph, {
      actors: [
        vehicle(graph, { id: 'challenger', rsl: LANE_RIGHT, s: 40, speedMps: 14, cruiseSpeedMps: 14 }),
      ],
      interactions: [
        {
          id: 'drift',
          actorId: 'challenger',
          trigger: { kind: 'at', t: 1 },
          verb: 'laneOffset',
          target: { mode: 'meters', value: 1.2 },
          dynamics: { shape: 'linear', constraint: 'rate', value: 0.3 },
        },
        {
          id: 'swerve-back',
          actorId: 'challenger',
          trigger: { kind: 'at', t: 3 },
          verb: 'laneOffset',
          target: { mode: 'fraction', value: -0.25 },
          dynamics: { shape: 'cubic', constraint: 'time', value: 2 },
        },
      ],
    });
    const { trace } = runSimulation(input, { graph });
    const preemption = trace.events.find((e) => e.kind === 'preemption');
    expect(preemption).toMatchObject({
      axis: 'lateral',
      byInteractionId: 'swerve-back',
      preemptedInteractionId: 'drift',
    });
    const track = trace.ticks.actors['challenger']!;
    const completed = trace.events.find((event) => event.kind === 'interaction_completed' && event.interactionId === 'swerve-back');
    const completedIndex = trace.ticks.t.findIndex((time) => time >= completed!.t - 1e-9);
    // At completion the actor is -0.25 of a 3.5 m lane from its centre. Later
    // world Y may change as that retained offset follows curved lane geometry.
    expect(track.y[completedIndex]!).toBeCloseTo(-3.5 - 0.875, 1);
  });

  it('aborts an in-progress true lane change back to its source route', () => {
    const input = scenario(graph, {
      // The abort window depends on the physical body's lateral progress, so
      // the force backend is selected explicitly rather than inherited.
      physics: { mode: 'dynamic-v1' },
      actors: [
        vehicle(graph, { id: 'challenger', rsl: LANE_RIGHT, s: 40, speedMps: 14, cruiseSpeedMps: 14 }),
      ],
      interactions: [
        {
          id: 'incursion',
          actorId: 'challenger',
          trigger: { kind: 'at', t: 1 },
          verb: 'changeLane',
          target: { mode: 'lane', rsl: LANE_LEFT },
          dynamics: { shape: 'sinusoidal', constraint: 'rate', value: 0.65 },
        },
        {
          id: 'abort-to-source',
          actorId: 'challenger',
          trigger: { kind: 'at', t: 3.5 },
          verb: 'changeLane',
          target: { mode: 'lane', rsl: LANE_RIGHT },
          dynamics: { shape: 'sinusoidal', constraint: 'rate', value: 0.65 },
        },
      ],
    });

    const { trace, issues } = runSimulation(input, { graph, guards: 'collect' });
    const track = trace.ticks.actors.challenger!;
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    // The incursion must be material before it is reversed. Do not count the
    // former pre-command centreline hunting as lane-change displacement.
    expect(Math.max(...track.y)).toBeGreaterThan(-3.1);
    const completed = trace.events.find((event) => event.kind === 'interaction_completed' && event.interactionId === 'abort-to-source')!;
    expect(completed).toMatchObject({ finalLateralOffsetM: 0 });
    expect(track.laneRsl.at(-1)).toBe(LANE_RIGHT);
    expect(trace.events).toContainEqual(expect.objectContaining({
      kind: 'preemption',
      byInteractionId: 'abort-to-source',
      preemptedInteractionId: 'incursion',
    }));
    expect(trace.events).toContainEqual(expect.objectContaining({
      kind: 'lane_change', actorId: 'challenger', toRsl: LANE_RIGHT, legal: true,
    }));
  });
});
