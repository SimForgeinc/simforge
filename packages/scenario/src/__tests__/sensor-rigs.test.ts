import { describe, expect, it } from 'vitest';

import {
  ALPAMAYO_CAMERA_INDEX,
  ALPAMAYO_RENDER_HEIGHT,
  ALPAMAYO_RENDER_WIDTH,
  BUILT_IN_SENSOR_RIGS,
  SENSOR_MOUNT_PRESETS,
  buildAlpamayoRigPreset,
  instantiateSensorRig,
  matchSensorMountPreset,
  resolveSensorMountPreset,
  sensorRigPreset,
} from '../schema/v2/sensor-rigs.js';

const bus = {
  class: 'bus' as const,
  dims: { length: 12.4, width: 2.55, height: 3.3 },
};

describe('sensor rigs', () => {
  it('keeps every built-in rig instantiable with resolved actor-owned sensors', () => {
    expect(BUILT_IN_SENSOR_RIGS.map((preset) => preset.id)).toEqual([
      'basic-dash-camera',
      'tesla-hw3',
      'waymo-5th-gen',
      'nvidia-sdg-av',
      'alpamayo-pai',
      'alpamayo-2cam',
      'alpamayo-4cam',
    ]);

    for (const preset of BUILT_IN_SENSOR_RIGS) {
      const actor = { class: 'pedestrian' as const };
      const sensors = instantiateSensorRig(
        preset,
        actor,
        (template, index) => `${template.type}-${index}`,
      );
      expect(sensors).toHaveLength(preset.sensors.length);
      expect(sensors.every((sensor) => 'position' in sensor.mount)).toBe(true);
    }
  });

  it('accepts rig templates with more than 32 sensors', () => {
    const camera = sensorRigPreset('basic-dash-camera')!.sensors[0]!;
    const preset = {
      id: 'large-rig',
      name: 'Large rig',
      sensors: Array.from({ length: 40 }, (_, index) => ({
        ...camera,
        id: `camera-${index}`,
      })),
    };
    expect(instantiateSensorRig(preset, { class: 'truck' })).toHaveLength(40);
  });

  it('round-trips every named mount on a non-reference vehicle while ignoring aim', () => {
    for (const preset of SENSOR_MOUNT_PRESETS) {
      const resolved = resolveSensorMountPreset(preset.id, bus);
      const aimed = {
        ...resolved,
        rotation: { yawRad: 0.3, pitchRad: -0.1, rollRad: 0.05 },
      };
      expect(matchSensorMountPreset(aimed, bus)?.id).toBe(preset.id);
    }
  });

  it('leaves hand-authored positions classified as custom', () => {
    expect(matchSensorMountPreset({
      position: { x: 1.234, y: 2.345, z: 0.456 },
      rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
    }, bus)).toBeUndefined();
  });
});

describe('alpamayo model-input rigs', () => {
  const expectedAspect = ALPAMAYO_RENDER_WIDTH / ALPAMAYO_RENDER_HEIGHT;

  it('authors the 2-cam profile as model camera indices [1, 6]', () => {
    const preset = sensorRigPreset('alpamayo-2cam');
    expect(preset).toBeDefined();
    expect(preset!.sensors.map((sensor) => sensor.id)).toEqual([
      'camera_front_wide_120fov',
      'camera_front_tele_30fov',
    ]);
    expect(preset!.sensors.map(
      (sensor) => ALPAMAYO_CAMERA_INDEX[sensor.id as keyof typeof ALPAMAYO_CAMERA_INDEX],
    )).toEqual([1, 6]);
  });

  it('authors the 4-cam profile as the dataset-default indices [0, 1, 2, 6]', () => {
    const preset = sensorRigPreset('alpamayo-4cam');
    expect(preset).toBeDefined();
    expect(preset!.sensors.map(
      (sensor) => ALPAMAYO_CAMERA_INDEX[sensor.id as keyof typeof ALPAMAYO_CAMERA_INDEX],
    )).toEqual([0, 1, 2, 6]);
  });

  it('keeps every camera at the model-native aspect with its rig horizontal FoV', () => {
    for (const id of ['alpamayo-2cam', 'alpamayo-4cam'] as const) {
      for (const sensor of sensorRigPreset(id)!.sensors) {
        expect(sensor.type).toBe('dash_camera');
        if (sensor.type !== 'dash_camera') continue;
        expect(sensor.camera.aspectRatio).toBeCloseTo(expectedAspect, 6);
        expect(sensor.camera.horizontalFovDeg)
          .toBe(sensor.id === 'camera_front_tele_30fov' ? 30 : 120);
      }
    }
  });

  it('sorts builder camera order by model index regardless of input order', () => {
    const preset = buildAlpamayoRigPreset('alpamayo-test', 'Test', [
      'camera_front_tele_30fov',
      'camera_cross_right_120fov',
      'camera_front_wide_120fov',
    ]);
    expect(preset.sensors.map((sensor) => sensor.id)).toEqual([
      'camera_front_wide_120fov',
      'camera_cross_right_120fov',
      'camera_front_tele_30fov',
    ]);
  });

  it('rejects camera names without an authored template', () => {
    expect(() => buildAlpamayoRigPreset('alpamayo-bad', 'Bad', ['camera_rear_left_70fov']))
      .toThrow(/no authored Alpamayo camera template/);
  });
});
