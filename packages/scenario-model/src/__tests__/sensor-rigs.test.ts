import { describe, expect, it } from 'vitest';

import {
  ActorSensorSchema,
  BUILT_IN_SENSOR_RIGS,
  SensorRigPresetSchema,
  instantiateSensorRig,
  resolveSensorRigMount,
  sensorMountScenePose,
  sensorRigPreset,
  type SensorRigActor,
} from '../index.js';

describe('canonical sensor rig presets', () => {
  it('serializes all five built-ins without presentation cameras', () => {
    expect(BUILT_IN_SENSOR_RIGS.map((preset) => preset.id)).toEqual([
      'basic-dash-camera',
      'tesla-hw3',
      'waymo-5th-gen',
      'nvidia-sdg-av',
      'alpamayo-pai',
    ]);

    for (const preset of BUILT_IN_SENSOR_RIGS) {
      expect(SensorRigPresetSchema.parse(JSON.parse(JSON.stringify(preset)))).toEqual(preset);
      expect(preset.sensors.some((sensor) => sensor.id.includes('trailing'))).toBe(false);
    }

    expect(new Set(sensorRigPreset('tesla-hw3')?.sensors.map((sensor) => sensor.type)))
      .toEqual(new Set(['dash_camera', 'radar']));
    expect(new Set(sensorRigPreset('waymo-5th-gen')?.sensors.map((sensor) => sensor.type)))
      .toEqual(new Set(['dash_camera', 'lidar']));
    expect(new Set(sensorRigPreset('nvidia-sdg-av')?.sensors.map((sensor) => sensor.type)))
      .toEqual(new Set(['dash_camera', 'lidar']));
  });

  it('mints supplied identities and returns schema-valid numeric actor sensors', () => {
    const preset = sensorRigPreset('waymo-5th-gen')!;
    const sensors = instantiateSensorRig(
      preset,
      { class: 'car' },
      (_template, index) => `waymo-runtime-${index}`,
    );

    expect(sensors.map((sensor) => sensor.id)).toEqual(
      preset.sensors.map((_sensor, index) => `waymo-runtime-${index}`),
    );
    expect(sensors.map((sensor) => sensor.id)).not.toEqual(
      preset.sensors.map((sensor) => sensor.id),
    );
    for (const sensor of sensors) {
      expect(ActorSensorSchema.parse(sensor)).toEqual(sensor);
      expect('position' in sensor.mount).toBe(true);
    }
  });

  it('keeps authored left/right mounts canonical and reflects left into negative scene Z', () => {
    const sensors = instantiateSensorRig(
      'tesla-hw3',
      { class: 'car' },
      (template) => `runtime-${template.id}`,
    );
    const left = sensors.find((sensor) => sensor.label === 'Left Forward')!;
    const right = sensors.find((sensor) => sensor.label === 'Right Forward')!;

    expect(left.mount.position.z).toBe(1);
    expect(right.mount.position.z).toBe(-1);
    expect(sensorMountScenePose(left.mount).position.z).toBe(-1);
    expect(sensorMountScenePose(right.mount).position.z).toBe(1);
    expect(sensorMountScenePose(left.mount).rotation).toEqual({
      yawRad: -left.mount.rotation.yawRad,
      pitchRad: left.mount.rotation.pitchRad,
      rollRad: -left.mount.rotation.rollRad,
    });
  });

  it('resolves compact, sedan, van and truck dimensions deterministically', () => {
    const mount = sensorRigPreset('basic-dash-camera')!.sensors[0]!.mount;
    const cases: Array<{
      actor: SensorRigActor;
      expected: { x: number; y: number; z: number };
    }> = [
      {
        actor: { class: 'car', dims: { length: 3.6, width: 1.65, height: 1.4 } },
        expected: { x: 1, y: 1.6, z: 0 },
      },
      {
        actor: { class: 'car', dims: { length: 4.8, width: 1.9, height: 1.5 } },
        expected: { x: 1.6, y: 1.7, z: 0 },
      },
      {
        actor: { class: 'van', dims: { length: 5.5, width: 2, height: 2.2 } },
        expected: { x: 1.95, y: 2.4, z: 0 },
      },
      {
        actor: { class: 'truck', dims: { length: 9.5, width: 2.5, height: 3.5 } },
        expected: { x: 3.95, y: 3.7, z: 0 },
      },
    ];

    for (const { actor, expected } of cases) {
      expect(resolveSensorRigMount(mount, actor).position).toEqual(expected);
      expect(resolveSensorRigMount(mount, actor).position).toEqual(expected);
    }
  });

  it('rejects unknown, incompatible and duplicate minted identities', () => {
    expect(() => instantiateSensorRig('missing-rig', { class: 'car' }))
      .toThrow(/unknown sensor rig preset/);
    expect(() => instantiateSensorRig('tesla-hw3', { class: 'truck' }))
      .toThrow(/not compatible/);
    expect(() => instantiateSensorRig('waymo-5th-gen', { class: 'car' }, () => 'duplicate'))
      .toThrow(/duplicate id/);
  });
});
