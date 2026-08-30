import type { RenderSensorSourceHost, RenderSourceV3 } from '@simforge-oss/scenario';
import { describe, expect, it } from 'vitest';

import { createNativeCameraSchedule } from './camera-schedule.js';
import type { NativeSceneState } from './lowering.js';

const source: RenderSourceV3 = {
  actorId: 'ego',
  sensorId: 'dash-camera',
  outputName: 'ego-dash-camera-rgb',
  modality: 'rgb',
  transform: {
    position: { x: 2, y: 1.2, z: 0 },
    rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
  },
  attributes: { width: 1280, height: 720, fps: 24, horizontalFovDeg: 90, nearM: 0.05, farM: 1_000 },
};
const host: RenderSensorSourceHost = {
  sourceId: source.outputName,
  actorId: 'ego',
  vehicleAsset: { catalogAssetId: 'vehicle.sedan' },
};

function state(tick: number, position: readonly [number, number, number], headingRad: number): NativeSceneState {
  return {
    version: 'scene-state.v1', mapId: 'richmond', tick, tickHz: 24,
    weather: { preset: 'clear' }, timeOfDay: 12,
    actors: [{
      id: 'ego', kind: tick === 0 ? 'spawn' : 'update', catalogId: 'vehicle.sedan', actorClass: 'car',
      transform: {
        position,
        rotation: [0, Math.sin(headingRad / 2), 0, Math.cos(headingRad / 2)],
      },
      velocity: [1, 0, 0],
    }],
  };
}

describe('native ego-mounted camera schedule', () => {
  it('tracks the simulated host pose and composes the dash mount along its heading', () => {
    const schedule = createNativeCameraSchedule(
      [source],
      [host],
      [state(0, [10, 2, 20], 0), state(1, [11, 2, 18], Math.PI / 2)],
    );

    expect(schedule[0]![0]!.eye).toEqual([12, 3.2, 20]);
    expect(schedule[0]![0]!.target).toEqual([62, 3.2, 20]);
    expect(schedule[1]![0]!.eye[0]).toBeCloseTo(11);
    expect(schedule[1]![0]!.eye[1]).toBeCloseTo(3.2);
    expect(schedule[1]![0]!.eye[2]).toBeCloseTo(16);
    expect(schedule[1]![0]!.target[0]).toBeCloseTo(11);
    expect(schedule[1]![0]!.target[2]).toBeCloseTo(-34);
    expect(schedule[1]![0]!.eye).not.toEqual(schedule[0]![0]!.eye);
  });
});
