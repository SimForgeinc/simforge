import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseSimScenarioInput, type SimScenarioInput } from '@simforge-oss/engine';

import { LANE_LEFT, scenario, syntheticGraph, vehicle } from '../fixture.js';
import { encodeTruthFrame, TruthStreamClient, type TruthFrame } from '../truth-stream.js';
import { WorldSession } from '../world-session.js';

const graph = syntheticGraph();

function signalizedInput(): SimScenarioInput {
  const base = scenario(graph, {
    warmupSeconds: 0,
    actors: [
      vehicle(graph, { id: 'alpha', s: 20, speedMps: 4, cruiseSpeedMps: 4 }),
      vehicle(graph, { id: 'bravo', s: 60, speedMps: 5, cruiseSpeedMps: 5 }),
      vehicle(graph, { id: 'charlie', s: 100, speedMps: 6, cruiseSpeedMps: 6 }),
    ],
  });
  return parseSimScenarioInput({
    ...base,
    signalPrograms: [{
      id: 'junction-main',
      phases: [
        { phase: 'green', durationS: 0.04 },
        { phase: 'red', durationS: 1 },
      ],
      loop: false,
      stopLines: [{ rsl: LANE_LEFT, s: 200 }],
    }],
  });
}

function decodeOne(bytes: Uint8Array): TruthFrame {
  const frames = new TruthStreamClient().push(bytes);
  expect(frames).toHaveLength(1);
  return frames[0]!;
}

function runBytes(ticks: number): Uint8Array[] {
  const world = new WorldSession({ input: signalizedInput(), graph });
  const subscription = world.subscribeTruth();
  world.advance(ticks);
  return subscription.drain();
}

describe('world-session live truth stream', () => {
  it('emits one authoritative all-actor frame per committed tick with signal transitions', () => {
    const world = new WorldSession({ input: signalizedInput(), graph });
    const subscription = world.subscribeTruth();
    const phases: string[] = [];

    for (let expectedTick = 1; expectedTick <= 5; expectedTick += 1) {
      const authoritative = world.advance(1);
      const bytes = subscription.read();
      expect(bytes).not.toBeNull();
      const frame = decodeOne(bytes!);
      expect(frame.tick).toBe(expectedTick);
      expect(frame.timeSec).toBeCloseTo(authoritative.tS, 8);
      expect(frame.scene.tick).toBe(frame.tick);
      expect(frame.scene.t).toBe(frame.timeSec);
      expect(frame.scene.actors).toHaveLength(3);
      expect(frame.actors).toHaveLength(3);

      for (const state of authoritative.actors) {
        const sceneActor = frame.scene.actors.find((actor) => actor.id === state.id);
        expect(sceneActor, `scene actor ${state.id}`).toBeDefined();
        expect(sceneActor!.position[0]).toBeCloseTo(state.x, 6);
        expect(sceneActor!.position[2]).toBeCloseTo(state.z, 6);
        expect(sceneActor!.yawRad).toBeCloseTo(state.headingRad, 6);
        const metadata = frame.actors.find((actor) => actor.id === state.id);
        expect(metadata).toEqual(expect.objectContaining({
          class: 'car',
          dims: { l: 4.5, w: 1.9, h: 1.5 },
        }));
      }
      phases.push(frame.signals[0]!.phase);
    }

    expect(phases).toEqual(['green', 'red', 'red', 'red', 'red']);
    expect(subscription.stats()).toEqual({ queued: 0, dropped: 0 });
  });

  it('fans one encoding out as byte-identical frames to concurrent subscribers', () => {
    const world = new WorldSession({ input: signalizedInput(), graph });
    const first = world.subscribeTruth();
    const second = world.subscribeTruth();
    world.advance(8);
    const firstBytes = first.drain();
    const secondBytes = second.drain();
    expect(firstBytes).toHaveLength(8);
    expect(secondBytes).toHaveLength(8);
    for (let i = 0; i < firstBytes.length; i += 1) {
      expect(Buffer.compare(Buffer.from(firstBytes[i]!), Buffer.from(secondBytes[i]!))).toBe(0);
    }
  });

  it('carries runtime spawn and despawn lifecycle with spawn-record dimensions', () => {
    const world = new WorldSession({ input: signalizedInput(), graph });
    const subscription = world.subscribeTruth();
    world.advance(1);
    subscription.drain();

    const spawned = world.applyCommand('c0001', 0, {
      kind: 'spawn',
      spawn: {
        id: 'delivery',
        kind: 'truck',
        pose: { x: 160, z: 3.5 },
        dims: { l: 7.2, w: 2.4, h: 3.1 },
      },
    });
    expect(spawned.ok).toBe(true);
    world.advance(1);
    const spawnFrame = decodeOne(subscription.read()!);
    expect(spawnFrame.scene.actors.find((actor) => actor.id === 'delivery')?.kind).toBe('spawn');
    expect(spawnFrame.actors.find((actor) => actor.id === 'delivery')).toEqual(expect.objectContaining({
      class: 'truck',
      dims: { l: 7.2, w: 2.4, h: 3.1 },
    }));

    expect(world.applyCommand('c0001', 1, { kind: 'despawn', actorId: 'delivery' }).ok).toBe(true);
    world.advance(1);
    const despawnFrame = decodeOne(subscription.read()!);
    expect(despawnFrame.scene.actors.find((actor) => actor.id === 'delivery')?.kind).toBe('despawn');
    expect(despawnFrame.actors.find((actor) => actor.id === 'delivery')?.dims).toEqual({
      l: 7.2,
      w: 2.4,
      h: 3.1,
    });
  });

  it('keeps the frozen framed-msgpack bytes exact and reassembles every one-byte boundary', () => {
    const fixture: TruthFrame = {
      tick: 7,
      timeSec: 0.35,
      scene: { tick: 7, t: 0.35, actors: [] },
      signals: [],
      actors: [],
    };
    const framed = encodeTruthFrame(fixture);
    expect(Buffer.from(framed).toString('hex')).toBe(
      '4900000085a47469636b07a774696d65536563cb3fd6666666666666a57363656e6583a47469636b07a174cb3fd6666666666666a66163746f727390a77369676e616c7390a66163746f727390',
    );

    const client = new TruthStreamClient();
    const decoded: TruthFrame[] = [];
    for (const byte of framed) decoded.push(...client.push(Uint8Array.of(byte)));
    expect(decoded).toEqual([fixture]);
  });

  it('drops oldest frames for a slow consumer and reports the exact cumulative count', () => {
    const world = new WorldSession({ input: signalizedInput(), graph });
    const slow = world.subscribeTruth({ capacity: 2 });
    world.advance(5);
    expect(slow.stats()).toEqual({ queued: 2, dropped: 3 });
    expect(slow.drain().map((bytes) => decodeOne(bytes).tick)).toEqual([4, 5]);
    expect(slow.stats()).toEqual({ queued: 0, dropped: 3 });
  });

  it('produces an identical framed-msgpack byte stream on two scripted runs', () => {
    const first = Buffer.concat(runBytes(12).map((bytes) => Buffer.from(bytes)));
    const second = Buffer.concat(runBytes(12).map((bytes) => Buffer.from(bytes)));
    const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
    expect(Buffer.compare(first, second)).toBe(0);
    expect(digest(first)).toBe(digest(second));
  });
});
