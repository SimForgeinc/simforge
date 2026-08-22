import { describe, expect, it } from 'vitest';
import { minimumJerkValue } from '../sim/controllers.js';
import { runSimulation } from '../sim/engine.js';
import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';

const graph = syntheticGraph();

function laneChange(durationS: number, window = { startS: 1, endS: 1.5 }) {
  return scenario(graph, {
    // These assertions are about the dynamic body's settle behavior against
    // the authored reference, so the force backend is selected explicitly.
    physics: { mode: 'dynamic-v1' },
    clipSeconds: 12,
    actors: [vehicle(graph, { id: 'ego', rsl: LANE_RIGHT, s: 20, speedMps: 10, cruiseSpeedMps: 10 })],
    interactions: [{
      id: `lane-${durationS}`,
      actorId: 'ego',
      trigger: { kind: 'at' as const, t: 1 },
      window,
      verb: 'changeLane' as const,
      target: { mode: 'lane' as const, rsl: LANE_LEFT },
      dynamics: { shape: 'sinusoidal' as const, constraint: 'time' as const, value: durationS },
    }],
  });
}

function completionTime(durationS: number): { completed: number; trace: ReturnType<typeof runSimulation>['trace']; issues: ReturnType<typeof runSimulation>['issues'] } {
  const result = runSimulation(laneChange(durationS), { graph, guards: 'collect' });
  const completed = result.trace.events.find((event) => event.kind === 'interaction_completed');
  expect(completed).toBeDefined();
  return { completed: completed!.t, trace: result.trace, issues: result.issues };
}

describe('duration-aware lateral manoeuvres', () => {
  it('executes gradual 1 s, 3 s, and 6 s requests with physical ordering', () => {
    const fast = completionTime(1);
    const normal = completionTime(3);
    const cautious = completionTime(6);

    // A one-second full-lane request exceeds the generic vehicle envelope and
    // is deliberately lengthened instead of snapping.
    expect(fast.issues).toContainEqual(expect.objectContaining({ code: 'lateral_duration_clamped' }));
    const planned = [fast, normal, cautious].map((result) => result.trace.events.find((event) => event.kind === 'lateral_maneuver_planned')!);
    expect(planned[0]!.effectiveDurationS).toBeGreaterThan(1);
    expect(planned[1]!.effectiveDurationS).toBeCloseTo(3, 9);
    expect(planned[2]!.effectiveDurationS).toBeCloseTo(6, 9);
    for (const result of [fast, normal, cautious]) {
      const track = result.trace.ticks.actors.ego!;
      const fired = result.trace.events.find((event) => event.kind === 'trigger_fired')!;
      const plan = result.trace.events.find((event) => event.kind === 'lateral_maneuver_planned')!;
      // The effective duration is the authored reference schedule. A dynamic
      // body completes only after that schedule elapsed and it physically
      // settles onto the reference; these are deliberately distinct clocks.
      const physicalDurationS = result.completed - fired.t + result.trace.header.dt;
      expect(physicalDurationS).toBeGreaterThanOrEqual(plan.effectiveDurationS - result.trace.header.dt);
      expect(physicalDurationS).toBeLessThanOrEqual(plan.effectiveDurationS + Math.max(2, plan.effectiveDurationS) + result.trace.header.dt);
      const completedIndex = result.trace.ticks.t.findIndex((time) => time >= fired.t + plan.effectiveDurationS - 1e-9);
      let peakStep = 0;
      // Exclude the terminal route-frame handoff (source offset → target
      // centreline); world position remains continuous across that relabel.
      for (let index = 1; index < completedIndex; index += 1) peakStep = Math.max(peakStep, Math.abs(track.lateralOffsetM[index]! - track.lateralOffsetM[index - 1]!));
      expect(peakStep).toBeLessThan(0.06);
      expect(result.trace.events).toContainEqual(expect.objectContaining({ kind: 'interaction_completed', finalLateralOffsetM: 0 }));
    }
  });

  it('keeps the authored reference separate from the measured dynamic body', () => {
    const { trace } = runSimulation(laneChange(3), { graph, guards: 'collect' });
    const fired = trace.events.find((event) => event.kind === 'trigger_fired')!;
    const planned = trace.events.find((event) => event.kind === 'lateral_maneuver_planned')!;
    const track = trace.ticks.actors.ego!;
    const sampleTimeS = fired.t + 0.5;
    const index = trace.ticks.t.findIndex((time) => time >= sampleTimeS - 1e-9);
    const reference = minimumJerkValue(0, 3.5, sampleTimeS - fired.t, planned.effectiveDurationS);
    // A kinematic scheduler would publish the analytic reference exactly.
    // Dynamic-v1 instead records the integrated physical body and tracks it.
    expect(Math.abs(track.lateralOffsetM[index]! - reference)).toBeGreaterThan(1e-4);
    expect(trace.events).toContainEqual(expect.objectContaining({ kind: 'interaction_completed' }));
  });

  it('does not change physical motion for a lateral action that never fires', () => {
    const baseline = laneChange(3);
    baseline.interactions = [];
    const withNeverFired = laneChange(3);
    withNeverFired.interactions[0] = {
      ...withNeverFired.interactions[0]!,
      trigger: { kind: 'at', t: 20 },
      window: { startS: 20, endS: 21 },
    };
    const a = runSimulation(baseline, { graph, guards: 'collect' }).trace.ticks.actors.ego;
    const b = runSimulation(withNeverFired, { graph, guards: 'collect' }).trace.ticks.actors.ego;
    expect(b).toEqual(a);
  });

  it('hands the route frame off without a world-pose snap', () => {
    const { trace } = runSimulation(laneChange(3), { graph, guards: 'collect' });
    const event = trace.events.find((candidate) => candidate.kind === 'lane_change')!;
    const index = trace.ticks.t.findIndex((time) => time >= event.t - 1e-9);
    const track = trace.ticks.actors.ego!;
    const stepM = Math.hypot(
      track.x[index]! - track.x[index - 1]!,
      track.y[index]! - track.y[index - 1]!,
    );
    expect(stepM).toBeLessThanOrEqual(track.speedMps[index]! * trace.header.dt + 0.05);
  });

  it('fails visibly when a dynamic body cannot settle onto the reference', () => {
    const input = laneChange(3);
    input.actors[0]!.initial.speedMps = 0;
    input.actors[0]!.behavior.cruiseSpeedMps = 0;
    input.interactions[0] = {
      ...input.interactions[0]!,
      until: { kind: 'speed', actorId: 'ego', cmp: 'gte', value: 1 },
    };
    input.interactions.push({
      id: 'accelerate-after-abort', actorId: 'ego', trigger: { kind: 'at', t: 8 },
      verb: 'speed', target: { mode: 'absolute', value: 4 },
      dynamics: { shape: 'linear', constraint: 'time', value: 0.5 },
    });
    const { trace, issues } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.events).toContainEqual(expect.objectContaining({
      kind: 'interaction_aborted', interactionId: 'lane-3', reason: 'tracking_error',
    }));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'lateral_tracking_failed' }));
    expect(trace.events).not.toContainEqual(expect.objectContaining({ kind: 'lane_change' }));
    expect(trace.events).not.toContainEqual(expect.objectContaining({
      kind: 'released', interactionId: 'lane-3', reason: 'until',
    }));
  });

  it('rejects a multi-lane count atomically when the final neighbour is missing', () => {
    const input = laneChange(6);
    const action = input.interactions[0]!;
    if (action.verb !== 'changeLane') throw new Error('fixture must contain a lane change');
    input.interactions[0] = { ...action, target: { mode: 'left', count: 2 } };
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.events).toContainEqual(expect.objectContaining({ kind: 'lane_change_rejected', interactionId: 'lane-6' }));
    expect(trace.events).toContainEqual(expect.objectContaining({ kind: 'interaction_aborted', interactionId: 'lane-6', reason: 'rejected' }));
    expect(trace.events.some((event) => event.kind === 'lane_change' || event.kind === 'interaction_completed')).toBe(false);
  });

  it('clears stale until ownership after completion and emits one release', () => {
    const input = laneChange(3);
    input.interactions[0] = {
      ...input.interactions[0]!,
      until: { kind: 'speed', actorId: 'ego', cmp: 'lte', value: 5 },
    };
    input.interactions.push({
      id: 'brake-later', actorId: 'ego', trigger: { kind: 'at', t: 8 },
      verb: 'speed', target: { mode: 'stop' }, dynamics: { shape: 'linear', constraint: 'time', value: 1 },
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    const releases = trace.events.filter((event) => event.kind === 'released' && event.interactionId === 'lane-3');
    expect(releases).toEqual([expect.objectContaining({ reason: 'complete' })]);
    expect(trace.events).not.toContainEqual(expect.objectContaining({ kind: 'interaction_aborted', interactionId: 'lane-3' }));
  });

  it('uses the half-open clip only for eligibility and completes after its end', () => {
    const { trace } = runSimulation(laneChange(3, { startS: 1, endS: 1.01 }), { graph });
    expect(trace.events).toContainEqual(expect.objectContaining({ kind: 'trigger_fired', t: 1 }));
    expect(trace.events).toContainEqual(expect.objectContaining({ kind: 'interaction_completed' }));
    const completed = trace.events.find((event) => event.kind === 'interaction_completed')!;
    expect(completed.t).toBeGreaterThan(1.01);
    expect(trace.events).not.toContainEqual(expect.objectContaining({ kind: 'interaction_aborted', reason: 'window' }));
  });

  it('is deterministic across rebuilds used by reset and seek', () => {
    const first = runSimulation(laneChange(3), { graph, guards: 'collect' });
    const second = runSimulation(laneChange(3), { graph, guards: 'collect' });
    expect(second.trace.events).toEqual(first.trace.events);
    expect(second.trace.ticks.actors.ego).toEqual(first.trace.ticks.actors.ego);
    expect(second.issues).toEqual(first.issues);
  });
});
