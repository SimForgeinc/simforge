import { describe, expect, it } from 'vitest';

import {
  LIDAR_CHANNELS,
  LIDAR_POINTS_PER_SECOND,
  TRAILING_PREVIEW_CAMERA_PRESET,
  materializeSensorRig,
} from '../contracts.js';

describe('sensor materialization contract', () => {
  it('selects the production camera rates and per-rig resolutions', () => {
    const dimensions = (rigId: string) => materializeSensorRig(rigId)
      .filter((sensor) => sensor.type === 'dash_camera')
      .map(({ widthPx, heightPx, updateRateHz }) => [widthPx, heightPx, updateRateHz]);

    expect(dimensions('basic-dash-camera')).toEqual([[854, 480, 30]]);
    expect(dimensions('nvidia-sdg-av')).toEqual(expect.arrayContaining([[1920, 1208, 30]]));
    expect(dimensions('waymo-5th-gen')).toContainEqual([1920, 1280, 30]);
    expect(dimensions('alpamayo-2cam')).toEqual(expect.arrayContaining([[512, 384, 30]]));
  });

  it('materializes lidar and radar acquisition parameters', () => {
    const sensors = materializeSensorRig('waymo-5th-gen');
    const lidar = sensors.find((sensor) => sensor.type === 'lidar');
    const radar = materializeSensorRig('tesla-hw3').find((sensor) => sensor.type === 'radar');

    expect(lidar).toMatchObject({
      updateRateHz: 20,
      channels: LIDAR_CHANNELS,
      pointsPerSecond: LIDAR_POINTS_PER_SECOND,
      rotationFrequencyHz: 20,
    });
    expect(radar).toMatchObject({ updateRateHz: 20 });
  });

  it('exports the trailing camera as an optional canonical-frame overlay', () => {
    expect(TRAILING_PREVIEW_CAMERA_PRESET).toMatchObject({
      attachmentType: 'spring_arm_ghost',
      mount: {
        position: { x: -5.5, y: 2.8, z: 0 },
        rotation: { pitchRad: Math.PI / 12 },
      },
      updateRateHz: 30,
      widthPx: 854,
      heightPx: 480,
      horizontalFovDeg: 90,
    });
    expect(materializeSensorRig('tesla-hw3').some((sensor) => sensor.templateId === 'trailing-camera')).toBe(false);
  });
});
