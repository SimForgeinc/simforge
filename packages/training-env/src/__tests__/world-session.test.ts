/**
 * World-session server v1: two simulated clients (tick-owner + controller)
 * drive a scenario with runtime spawn/act/despawn; the session log replays to
 * the identical trace digest; a partially-invalid batch is rejected atomically.
 */
import { describe, expect, it } from 'vitest';

import type { SimScenarioInput } from '@simforge/engine';

import { LANE_RIGHT, scenario, syntheticGraph, vehicle } from '../fixture.js';
import { EnvServer } from '../env-server.js';
import { WorldRegistry, registerWorldOps } from '../session-registry.js';
import { WorldSession, replayWorldSessionLog, type WorldSnapshot } from '../world-session.js';

const graph = syntheticGraph();

function egoInput(): SimScenarioInput {
  return scenario(graph, {
    actors: [vehicle(graph, { id: 'ego', s: 20, speedMps: 10, cruiseSpeedMps: 10 })],
  });
}

function actorOf(snapshot: WorldSnapshot, id: string) {
  const actor = snapshot.actors.find((a) => a.id === id);
  expect(actor, `actor ${id} in snapshot`).toBeDefined();
  return actor!;
}

describe('world session: two clients drive a scenario', () => {
  const registry = new WorldRegistry([{ input: egoInput(), graph }]);
  const { worldId, clientId: owner } = registry.createWorld({ role: 'tick-owner' });
  const { clientId: controller } = registry.join(worldId, 'actor-controller');
  const { clientId: observer } = registry.join(worldId, 'observer');

  it('spawns an arbitrary actor at runtime, lane-snapped, with a stable id', () => {
    // Controller queues; nothing mutates until the owner's tick boundary.
    const { seq } = registry.enqueue(worldId, controller, {
      kind: 'spawn',
      spawn: { kind: 'car', pose: { x: 200, z: 3.5 } },
    });
    expect(seq).toBe(0);
    expect(registry.snapshot(worldId, observer).actors.some((a) => a.id.startsWith('ws:'))).toBe(false);

    const result = registry.advance(worldId, owner, 5);
    expect(result.results).toEqual([
      expect.objectContaining({ clientId: controller, seq: 0, ok: true, actorIds: ['ws:0001'] }),
    ]);
    const spawned = actorOf(registry.snapshot(worldId, observer), 'ws:0001');
    expect(spawned.present).toBe(true);
    expect(spawned.laneRsl).toBe(LANE_RIGHT);
    expect(spawned.z).toBeCloseTo(3.5, 3);
    expect(result.events.some((e) => e.kind === 'spawn' && e.actorId === 'ws:0001')).toBe(true);
  });

  it('applies controller actions at tick boundaries (zero-order hold)', () => {
    registry.enqueue(worldId, controller, { kind: 'act', actorId: 'ws:0001', action: { targetSpeedMps: 5 } });
    registry.advance(worldId, owner, 50); // 1 s at 50 Hz
    const driven = actorOf(registry.snapshot(worldId, observer), 'ws:0001');
    expect(driven.speedMps).toBeGreaterThan(1);
  });

  it('spawns a second actor for the despawn scenario', () => {
    registry.enqueue(worldId, controller, { kind: 'spawn', spawn: { kind: 'car', pose: { x: 380, z: 3.5 } } });
    const results = registry.advance(worldId, owner, 1).results;
    expect(results[0]).toEqual(expect.objectContaining({ ok: true, actorIds: ['ws:0002'] }));
  });

  it('despawns with trace semantics (present flips, despawn event emitted)', () => {
    registry.enqueue(worldId, controller, { kind: 'despawn', actorId: 'ws:0002' });
    const result = registry.advance(worldId, owner, 5);
    expect(result.results[0]!.ok).toBe(true);
    expect(actorOf(registry.snapshot(worldId, observer), 'ws:0002').present).toBe(false);
    expect(result.events.some((e) => e.kind === 'despawn' && e.actorId === 'ws:0002')).toBe(true);
  });

  it('enforces roles: observers cannot command, non-owners cannot advance', () => {
    expect(() => registry.enqueue(worldId, observer, { kind: 'despawn', actorId: 'ego' })).toThrow(/observer/);
    expect(() => registry.advance(worldId, controller, 1)).toThrow(/not the tick-owner/);
    expect(() => registry.join(worldId, 'tick-owner')).toThrow(/already has tick-owner/);
  });

  it('orders queued commands deterministically by (clientId, seq)', () => {
    const { clientId: late } = registry.join(worldId, 'actor-controller');
    // Enqueue interleaved and out of client order: late first, then controller.
    registry.enqueue(worldId, late, { kind: 'act', actorId: 'ego', action: null });
    registry.enqueue(worldId, controller, { kind: 'act', actorId: 'ego', action: null });
    registry.enqueue(worldId, late, { kind: 'act', actorId: 'ego', action: null });
    const applied = registry.advance(worldId, owner, 1).results.map((r) => [r.clientId, r.seq]);
    expect(applied).toEqual([[controller, 4], [late, 0], [late, 1]]);
  });

  it('hands tick ownership over on leave + claim', () => {
    registry.leave(worldId, owner);
    expect(() => registry.advance(worldId, controller, 1)).toThrow(/vacant/);
    registry.claimTickOwnership(worldId, controller);
    expect(registry.advance(worldId, controller, 1).tick).toBeGreaterThan(0);
  });

  it('replays the exported session log to the identical trace digest', () => {
    const log = registry.exportLog(worldId, controller);
    expect(log.entries.length).toBeGreaterThan(5);
    const replayed = replayWorldSessionLog(log, { input: egoInput(), graph });
    expect(replayed.outcomesMatch).toBe(true);
    expect(replayed.divergedAt).toBeNull();
    expect(replayed.digest).toBe(log.digest);
  });
});

describe('structural rebuild continuity', () => {
  it('keeps pre-existing actors bit-identical at the spawn boundary', () => {
    const world = new WorldSession({ input: egoInput(), graph });
    world.advance(25); // 0.5 s: the ego is mid-motion, not at an authored rest point
    const before = world.snapshot().actors.find((a) => a.id === 'ego')!;
    const outcome = world.applyCommand('c0001', 0, {
      kind: 'spawn',
      spawn: { kind: 'car', pose: { x: 300, z: 3.5 } },
    });
    expect(outcome.ok).toBe(true);
    // The command rebuilt the engine and replayed to the current tick; the
    // deterministic engine must land the ego on the exact same bits.
    const after = world.snapshot().actors.find((a) => a.id === 'ego')!;
    expect(after.x).toBe(before.x);
    expect(after.z).toBe(before.z);
    expect(after.headingRad).toBe(before.headingRad);
    expect(after.speedMps).toBe(before.speedMps);
    expect(after.s).toBe(before.s);
  });
});

describe('batch atomicity', () => {
  it('rejects a partially-invalid batch without touching the world', () => {
    const world = new WorldSession({ input: egoInput(), graph });
    world.advance(5);
    const before = world.snapshot();
    const digestBefore = world.digest();
    const ego = before.actors.find((a) => a.id === 'ego')!;

    // Op 1 is valid; op 2 spawns on top of the ego at its *current* pose.
    const outcome = world.applyCommand('c0001', 0, {
      kind: 'batch',
      ops: [
        { kind: 'spawn', spawn: { kind: 'car', pose: { x: 300, z: 3.5 } } },
        { kind: 'spawn', spawn: { kind: 'car', pose: { x: ego.x, z: ego.z } } },
      ],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/overlaps ego/);

    // Nothing applied: no ws actor, digest untouched, id counter unconsumed.
    expect(world.snapshot().actors).toHaveLength(before.actors.length);
    expect(world.digest()).toBe(digestBefore);

    const retry = world.applyCommand('c0001', 1, {
      kind: 'batch',
      ops: [
        { kind: 'spawn', spawn: { kind: 'car', pose: { x: 300, z: 3.5 } } },
        { kind: 'spawn', spawn: { kind: 'truck', pose: { x: 350, z: 3.5 } } },
      ],
    });
    expect(retry).toEqual({ ok: true, actorIds: ['ws:0001', 'ws:0002'] });
    world.advance(5);
    expect(world.snapshot().actors.filter((a) => a.present)).toHaveLength(3);

    // Rejected batches are part of the deterministic history too.
    const replayed = replayWorldSessionLog(world.exportLog(), { input: egoInput(), graph });
    expect(replayed.outcomesMatch).toBe(true);
    expect(replayed.digest).toBe(world.digest());
  });

  it('rejects despawn of an actor that is not present', () => {
    const world = new WorldSession({ input: egoInput(), graph });
    const outcome = world.applyCommand('c0001', 0, {
      kind: 'batch',
      ops: [
        { kind: 'spawn', spawn: { kind: 'car', pose: { x: 300, z: 3.5 } } },
        { kind: 'despawn', actorId: 'ghost' },
      ],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/ghost is not present/);
    expect(world.snapshot().actors).toHaveLength(1);
  });

  it('rejects a spawn with no drivable lane in reach', () => {
    const world = new WorldSession({ input: egoInput(), graph });
    const outcome = world.applyCommand('c0001', 0, {
      kind: 'spawn',
      spawn: { kind: 'car', pose: { x: 200, z: 500 } },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/no drivable lane/);
  });
});

describe('world.* wire ops through the env-server extension seam', () => {
  it('serves world ops next to the core dispatch', () => {
    const input = egoInput();
    const server = new EnvServer({
      episodes: [{ input, graph, mapId: 'synthetic-straight', xodrSha256: null }],
    });
    registerWorldOps(server, [{ input, graph }]);

    const created = server.handle({ i: 1, op: 'world.create' });
    expect(created.ok).toBe(1);
    const { worldId, clientId } = created.r as { worldId: string; clientId: string };

    const queued = server.handle({
      i: 2,
      op: 'world.cmd',
      w: worldId,
      c: clientId,
      cmd: { kind: 'spawn', spawn: { kind: 'car', pose: { x: 200, z: 3.5 } } },
    });
    expect(queued).toEqual({ i: 2, ok: 1, r: { seq: 0 } });

    const advanced = server.handle({ i: 3, op: 'world.advance', w: worldId, c: clientId, n: 5 });
    expect(advanced.ok).toBe(1);

    const snap = server.handle({ i: 4, op: 'world.snapshot', w: worldId, c: clientId });
    expect((snap.r as WorldSnapshot).actors.some((a) => a.id === 'ws:0001' && a.present)).toBe(true);

    // Malformed payloads and unknown ops still come back as {ok: 0}.
    expect(server.handle({ i: 5, op: 'world.cmd', w: worldId, c: clientId, cmd: { kind: 'nope' } }).ok).toBe(0);
    expect(server.handle({ i: 6, op: 'world.nope' }).ok).toBe(0);
    // Core ops are untouched by the extension seam.
    expect(server.handle({ i: 7, op: 'ping' })).toEqual({ i: 7, ok: 1, r: { pong: true } });
  });
});
