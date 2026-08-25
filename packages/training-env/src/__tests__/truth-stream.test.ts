import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseSimScenarioInput, type SimScenarioInput } from '@simforge/engine';

import { LANE_LEFT, scenario, syntheticGraph, vehicle } from '../fixture.js';
import { TruthStreamClient, type TruthFrame } from '../truth-stream.js';
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

  it('reassembles arbitrarily split length-prefixed transport chunks', () => {
    const framed = runBytes(1)[0]!;
    const client = new TruthStreamClient();
    expect(client.push(framed.subarray(0, 2))).toEqual([]);
    expect(client.push(framed.subarray(2, 9))).toEqual([]);
    const decoded = client.push(framed.subarray(9));
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.tick).toBe(1);
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
