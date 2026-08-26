import {
  createFixedStepSimulation,
  type SimScenarioInput,
} from '@simforge/engine';
import { describe, expect, it } from 'vitest';

import { scenario, syntheticGraph, vehicle } from '../fixture.js';
import {
  WorldSession,
  replayWorldSessionLog,
  type WorldSessionLog,
} from '../world-session.js';

const graph = syntheticGraph();

function input(): SimScenarioInput {
  return scenario(graph, {
    actors: [vehicle(graph, { id: 'ego', s: 20, speedMps: 10, cruiseSpeedMps: 10 })],
  });
}

function replayWithTruth(log: WorldSessionLog): { readonly frames: Uint8Array[]; readonly world: WorldSession } {
  const world = new WorldSession({
    input: input(),
    graph,
    mode: log.mode,
    horizonSeconds: log.horizonSeconds,
  });
  const truth = world.subscribeTruth({ capacity: 256 });
  for (const entry of log.entries) {
    if (entry.kind === 'advance') world.advance(entry.ticks);
    else world.applyCommand(entry.clientId, entry.seq, entry.command);
  }
  return { frames: truth.drain(), world };
}

function applySequence(world: WorldSession): void {
  world.advance(25);
  expect(world.applyCommand('driver', 0, {
    kind: 'spawn',
    spawn: { kind: 'car', pose: { x: 300, z: 3.5 } },
  })).toEqual({ ok: true, actorIds: ['ws:0001'] });
  world.advance(10);
  expect(world.applyCommand('driver', 1, {
    kind: 'act',
    actorId: 'ws:0001',
    action: { targetSpeedMps: 6 },
  }).ok).toBe(true);
  world.advance(20);
  expect(world.applyCommand('driver', 2, { kind: 'despawn', actorId: 'ws:0001' }).ok).toBe(true);
  world.advance(3);
}

describe('world session live mode', () => {
  it('mutates actors without changing incumbent runtime state at the boundary', () => {
    const world = new WorldSession({ input: input(), graph, mode: 'live' });
    world.advance(2_000);
    const before = world.snapshot().actors.find((actor) => actor.id === 'ego')!;

    expect(world.applyCommand('driver', 0, {
      kind: 'spawn',
      spawn: { kind: 'car', pose: { x: 300, z: 3.5 } },
    }).ok).toBe(true);

    const after = world.snapshot().actors.find((actor) => actor.id === 'ego')!;
    expect(after).toEqual(before);
    expect(world.snapshot().actors.find((actor) => actor.id === 'ws:0001')).toMatchObject({ present: true });
  });

  it('advances beyond the old 120-second horizon without retaining trace tracks', () => {
    const authored = input();
    const sim = createFixedStepSimulation(authored, { graph, guards: 'skip', mode: 'live' });
    const targetSeconds = 180;
    const ticks = Math.round(authored.warmupSeconds / authored.dt) + 1 + Math.ceil(targetSeconds / authored.dt);
    const progress = sim.advance(ticks, { trace: true });

    expect(progress.done).toBe(false);
    expect(progress.trace).toBeNull();
    expect(progress.recordedUntil).toBeNull();
    expect(sim.peek().tS).toBeGreaterThan(179);
  });

  it('replays the command log to byte-identical truth frames', () => {
    const world = new WorldSession({ input: input(), graph, mode: 'live' });
    const truth = world.subscribeTruth({ capacity: 256 });
    applySequence(world);
    const frames = truth.drain();
    const log = world.exportLog();

    const replayed = replayWithTruth(log);
    expect(replayed.frames).toEqual(frames);
    expect(replayed.world.snapshot()).toEqual(world.snapshot());
    expect(replayed.world.digest()).toBe(log.digest);

    const verified = replayWorldSessionLog(log, { input: input(), graph });
    expect(verified).toEqual({ digest: log.digest, outcomesMatch: true, divergedAt: null });
  });
});
