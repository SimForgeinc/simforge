import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_SENSOR_RIGS,
  SENSOR_MOUNT_PRESETS,
  instantiateSensorRig,
  matchSensorMountPreset,
  resolveSensorMountPreset,
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
    ]);

    for (const preset of BUILT_IN_SENSOR_RIGS) {
      const actor = { class: preset.compatibleActorClasses[0]! };
      const sensors = instantiateSensorRig(
        preset,
        actor,
        (template, index) => `${template.type}-${index}`,
      );
      expect(sensors).toHaveLength(preset.sensors.length);
      expect(sensors.every((sensor) => 'position' in sensor.mount)).toBe(true);
    }
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
