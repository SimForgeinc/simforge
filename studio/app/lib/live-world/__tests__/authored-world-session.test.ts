import { describe, expect, it } from 'vitest';
import { buildLaneGraph, parseSimScenarioInput } from '@simforge/engine';

import {
  applyEgoControl,
  authoredPlaybackBudget,
  assertControllableActor,
  createAuthoredWorldSession,
} from '../authored-world-session';

const graph = buildLaneGraph({
  source: { xodrSha256: 'fixture' },
  lanes: {},
  gates: [],
  junctions: {},
});

function input() {
  const actor = (id: string, x: number, speedMps: number) => ({
    id,
    kind: 'car' as const,
    initial: { pose: { x, z: 0, headingRad: 0 }, speedMps },
    behavior: {
      route: { kind: 'polyline' as const, points: [{ x, z: 0 }, { x: x + 200, z: 0 }] },
      cruiseSpeedMps: Math.max(speedMps, 5),
    },
  });
  return parseSimScenarioInput({
    mapId: 'authored-world-fixture',
    clipSeconds: 20,
    warmupSeconds: 0,
    dt: 0.02,
    physics: { mode: 'dynamic-v1' },
    actors: [actor('ego', 0, 0), actor('authored-other', 20, 5)],
  });
}

describe('authored world session', () => {
  it('runs all compiled actors together and applies ego input as a zero-order-hold act command', () => {
    const compiledInput = input();
    const world = createAuthoredWorldSession(compiledInput, graph);
    const before = world.snapshot();
    assertControllableActor(compiledInput, 'ego');

    const outcome = applyEgoControl(world, 'ego', {
      actorId: 'ego',
      steer: 0,
      throttle: 1,
      brake: 0,
    }, 0);
    expect(outcome).toEqual({ ok: true });
    world.advance(50);

    const after = world.snapshot();
    expect(after.tS).toBeCloseTo(1, 8);
    expect(after.actors.find((actor) => actor.id === 'ego')!.speedMps).toBeGreaterThan(0);
    expect(after.actors.find((actor) => actor.id === 'authored-other')!.x)
      .toBeGreaterThan(before.actors.find((actor) => actor.id === 'authored-other')!.x);
  });

  it('rebuilding the session restores the exact authored t=0 conditions for the 20-second clip', () => {
    const compiledInput = input();
    const first = createAuthoredWorldSession(compiledInput, graph);
    const initial = first.snapshot();
    first.advance(125);
    expect(first.time()).toBeCloseTo(2.5, 8);

    const reset = createAuthoredWorldSession(compiledInput, graph);
    expect(reset.time()).toBe(0);
    expect(reset.snapshot()).toEqual(initial);
    expect(compiledInput.clipSeconds).toBe(20);
    expect(compiledInput.dt).toBe(0.02);
  });

  it('paces fixed steps from elapsed wall time without callback-count drift', () => {
    let remainderS = 0;
    let ticks = 0;
    for (let interval = 0; interval < 20; interval += 1) {
      const budget = authoredPlaybackBudget(0.05, remainderS, 0.02, 5);
      remainderS = budget.remainderS;
      ticks += budget.ticks;
      expect(budget.lagS).toBe(0);
    }

    expect(ticks).toBe(50);
    expect(ticks * 0.02).toBeCloseTo(1, 12);
    expect(remainderS).toBeCloseTo(0, 12);
    expect(authoredPlaybackBudget(0, 0, 0.02, 5).ticks).toBe(0);
  });

  it('caps a slow interval and reports the retained wall-clock lag', () => {
    const slow = authoredPlaybackBudget(0.5, 0, 0.02, 5);
    expect(slow).toEqual({
      ticks: 5,
      remainderS: 0.4,
      lagS: 0.4,
    });

    const recovery = authoredPlaybackBudget(0.05, slow.remainderS, 0.02, 5);
    expect(recovery.ticks).toBe(5);
    expect(recovery.remainderS).toBeCloseTo(0.35, 12);
    expect(recovery.lagS).toBeCloseTo(0.34, 12);
  });
});
