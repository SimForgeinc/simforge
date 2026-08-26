import { describe, expect, it } from 'vitest';

import { emitSceneState, sceneStateSchema, yawToQuaternion } from '../index.js';
import type { TraceInput } from '../emit.js';

/** Minimal trace fixture: 4 ticks @50 Hz; ped spawns late and despawns. */
function fixtureTrace(): TraceInput {
  const channel = (values: number[]) => values;
  return {
    header: {
      mapId: 'yale-st-palo-alto-ca',
      dt: 0.02,
      actorMetadata: {
        ego: {
          kind: 'car',
          dims: { l: 4.7, w: 1.82, h: 1.45 },
          static: false,
          tags: ['role:ego', 'catalog:vehicle.sedan'],
        },
        ped: { kind: 'pedestrian', dims: { l: 0.5, w: 0.45, h: 1.7 }, static: false, tags: [] },
      },
    },
    ticks: {
      t: [0, 0.02, 0.04, 0.06],
      actors: {
        // Ego drives +x (heading 0) at 10 m/s from local (100, 50).
        ego: {
          x: channel([100, 100.2, 100.4, 100.6]),
          y: channel([50, 50, 50, 50]),
          headingRad: channel([0, 0, 0, 0]),
          speedMps: channel([10, 10, 10, 10]),
          present: [true, true, true, true],
        },
        // Ped crosses heading +90° (local +y) at 2 m/s; absent on tick 0 and 3.
        ped: {
          x: channel([110, 110, 110, 110]),
          y: channel([49, 49.04, 49.08, 49.12]),
          headingRad: channel([Math.PI / 2, Math.PI / 2, Math.PI / 2, Math.PI / 2]),
          speedMps: channel([2, 2, 2, 2]),
          present: [false, true, true, false],
        },
      },
    },
  };
}

describe('emitSceneState', () => {
  const doc = emitSceneState(fixtureTrace());

  it('produces a schema-valid v1 document with stable ordering', () => {
    expect(() => sceneStateSchema.parse(doc)).not.toThrow();
    expect(doc.version).toBe('scene-state.v1');
    expect(doc.mapId).toBe('yale-st-palo-alto-ca');
    expect(doc.tickHz).toBe(50);
    expect(doc.tickCount).toBe(4);
    expect(doc.frame).toBe('scene-yup');
    expect(doc.actors.map((a) => a.id)).toEqual(['ego', 'ped']);
  });

  it('binds catalog ids from trace tags with class fallbacks', () => {
    expect(doc.actors[0]).toMatchObject({ catalogId: 'vehicle.sedan', actorClass: 'car' });
    expect(doc.actors[1]).toMatchObject({ catalogId: 'pedestrian.adult', actorClass: 'pedestrian' });
  });

  it('converts xodr-local to the y-up scene frame (z = -y)', () => {
    const ego = doc.frames[0]!.actors[0]!;
    expect(ego.position).toEqual([100, 0, -50]);
    // Heading 0 → identity quaternion, velocity straight along scene +x.
    expect(ego.rotation).toEqual([0, 0, 0, 1]);
    expect(ego.velocity).toEqual([10, 0, 0]);
  });

  it('emits spawn/update/despawn from present transitions only', () => {
    const kinds = doc.frames.map((f) => f.actors.filter((a) => a.id === 'ped').map((a) => a.kind));
    // tick0: absent before first record → nothing; t1 spawn; t2 update; t3 despawn.
    expect(kinds).toEqual([[], ['spawn'], ['update'], ['despawn']]);
    // Despawn carries the last known pose.
    const despawn = doc.frames[3]!.actors.find((a) => a.id === 'ped')!;
    expect(despawn.kind).toBe('despawn');
    expect(despawn.position).toEqual([110, 0, -49.12]);
  });

  it('maps heading to velocity through the scene-frame flip', () => {
    const ped = doc.frames[1]!.actors.find((a) => a.id === 'ped')!;
    // Local heading +90° (+y north) → scene −z at 2 m/s.
    expect(ped!.velocity).toEqual([0, 0, -2]);
  });

  it('derives weather/timeOfDay defaults for traces without conditions', () => {
    expect(doc.weather.preset).toBe('clear');
    expect(doc.timeOfDay).toBe(12);
  });

  it('derives acceleration by backward finite difference of the velocity channel', () => {
    // Ego accelerates 10 → 10.5 → 11 m/s along +x at 50 Hz: Δv = 0.5 m/s per tick
    // → 25 m/s² world-frame; first record has no prior sample and reports zeros.
    const accelDoc = emitSceneState({
      header: { mapId: 'yale-st-palo-alto-ca', dt: 0.02 },
      ticks: {
        t: [0, 0.02, 0.04],
        actors: {
          ego: {
            x: [100, 100.2, 100.41],
            y: [50, 50, 50],
            headingRad: [0, 0, 0],
            speedMps: [10, 10.5, 11],
            present: [true, true, true],
          },
        },
      },
    });
    const frames = accelDoc.frames.map((f) => f.actors[0]!);
    expect(frames[0]!.acceleration).toEqual([0, 0, 0]); // spawn/first sample
    expect(frames[1]!.acceleration).toEqual([25, 0, 0]);
    expect(frames[2]!.acceleration).toEqual([25, 0, 0]);
  });

  it('resets acceleration history on spawn so re-entering bodies never inherit it', () => {
    const doc2 = emitSceneState(fixtureTrace());
    const pedSpawn = doc2.frames[1]!.actors.find((a) => a.id === 'ped')!;
    expect(pedSpawn.kind).toBe('spawn');
    expect(pedSpawn.acceleration).toEqual([0, 0, 0]);
  });
});

describe('yawToQuaternion', () => {
  it('is exact at quarter turns', () => {
    expect(yawToQuaternion(0)).toEqual([0, 0, 0, 1]);
    const q = yawToQuaternion(Math.PI / 2);
    expect(q[1]).toBeCloseTo(Math.SQRT1_2);
    expect(q[3]).toBeCloseTo(Math.SQRT1_2);
  });
});
