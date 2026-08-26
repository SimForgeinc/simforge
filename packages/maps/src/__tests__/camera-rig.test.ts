import { describe, expect, it } from 'vitest';
import { findRigFeature, resolveCameraPose, type PoleCamera, type PoleCameraRig } from '../camera-rig.js';
import type { SignalFeature } from '../signals.js';

const CAMERA: PoleCamera = {
  id: 'channel-a',
  headingDeg: 0,
  pitchDeg: 0,
  mountHeightM: 7,
  intrinsics: { fx: 800, fy: 500, cx: 640, cy: 500, width: 1280, height: 1000 },
};

function feature(id = 'pole-a', position: [number, number, number] = [10, 2, 20]): SignalFeature {
  return {
    id,
    name: 'Traffic Light',
    featureKind: 'signal',
    category: 'traffic_light',
    roadId: '1',
    s: 0,
    t: 0,
    dynamic: true,
    height: 1,
    width: 0.5,
    zOffset: 4.5,
    mutcdCode: null,
    signDescription: null,
    signGroup: null,
    lonLat: [0, 0],
    localPosition: [0, 0],
    position,
    scenePosition: position,
    withinExtents: true,
    properties: {},
  };
}

describe('resolveCameraPose', () => {
  it('is deterministic and uses the explicit camera mounting height rather than signal zOffset', () => {
    const pole = feature();
    const first = resolveCameraPose(pole, CAMERA);
    const second = resolveCameraPose(pole, CAMERA);

    expect(second).toEqual(first);
    expect(first.position).toEqual([10, 9, 20]);
    expect(first.position[1]).not.toBe(pole.position[1] + pole.zOffset);
  });

  it('maps compass headings into the y-up scene and negative pitch downward', () => {
    const northDown = resolveCameraPose(feature(), { ...CAMERA, pitchDeg: -30 });
    const east = resolveCameraPose(feature(), { ...CAMERA, headingDeg: 90 });
    expect(northDown.yawDeg).toBe(-90);

    expect(northDown.target[0]).toBeCloseTo(northDown.position[0], 12);
    expect(northDown.target[1]).toBeLessThan(northDown.position[1]);
    expect(northDown.target[2]).toBeLessThan(northDown.position[2]);
    expect(east.target[0]).toBeGreaterThan(east.position[0]);
    expect(east.target[2]).toBeCloseTo(east.position[2], 12);
  });

  it('derives vertical field of view from image height and fy', () => {
    const pose = resolveCameraPose(feature(), CAMERA);

    expect(pose.verticalFovDeg).toBeCloseTo(90, 12);
  });

  it('applies terrain, orientation, and extrinsic corrections without mutating config', () => {
    const camera: PoleCamera = {
      ...CAMERA,
      headingDeg: 80,
      pitchDeg: -20,
      correction: { yawDeg: 5, pitchDeg: 2, heightM: 0.4, forwardM: 2 },
    };
    const pose = resolveCameraPose(feature(), camera, { groundHeight: 12, poleHeadingDeg: 5 });

    expect(pose.yawDeg).toBe(0);
    expect(pose.pitchDeg).toBe(-18);
    expect(pose.position[0]).toBeCloseTo(12, 12);
    expect(pose.position[1]).toBeCloseTo(19.4, 12);
    expect(pose.position[2]).toBeCloseTo(20, 12);
    expect(camera.correction).toEqual({ yawDeg: 5, pitchDeg: 2, heightM: 0.4, forwardM: 2 });
  });
});

describe('findRigFeature', () => {
  it('matches only the stable feature id and returns null on a miss', () => {
    const exact = feature('372');
    const nearby = feature('nearby', [10.01, 2, 20.01]);
    const rig: PoleCameraRig = { featureId: '372', cameras: [CAMERA] };

    expect(findRigFeature([nearby, exact], rig)).toBe(exact);
    expect(findRigFeature([nearby], rig)).toBeNull();
  });
});
