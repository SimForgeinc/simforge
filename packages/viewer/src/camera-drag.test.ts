import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  applyEyeOrbit,
  cameraKeyboardMagnitude,
  cameraLookDrag,
  cameraLookSensitivityMultiplier,
  cameraPanDrag,
  cameraWheelDollyScale,
  crossedCameraDragThreshold,
  DEFAULT_CAMERA_CONTROL_PREFERENCES,
} from './camera-drag';

describe('eye-orbit and inverted camera drags', () => {
  it('defaults both look axes to a displayed 100% and an internal 0.4 multiplier', () => {
    expect(DEFAULT_CAMERA_CONTROL_PREFERENCES).toMatchObject({
      horizontalLookSensitivity: 100,
      verticalLookSensitivity: 100,
    });
    expect(cameraLookSensitivityMultiplier(100)).toBe(0.4);
    expect(cameraLookSensitivityMultiplier(200)).toBe(0.8);
  });

  it('keeps the camera eye byte-for-byte invariant while changing orientation and target', () => {
    const camera = new PerspectiveCamera(55, 1.6, 0.1, 1000);
    camera.position.set(12, 30, 45);
    const target = new Vector3(3, 2, -8);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
    const eye = camera.position.toArray();
    const quaternion = camera.quaternion.toArray();
    const distance = camera.position.distanceTo(target);
    applyEyeOrbit(camera, target, { yaw: 0.18, pitch: 0.07 });
    expect(camera.position.toArray()).toEqual(eye);
    expect(camera.quaternion.toArray()).not.toEqual(quaternion);
    expect(camera.position.distanceTo(target)).toBeCloseTo(distance, 10);
  });

  it('applies each look preference once and independently', () => {
    const defaults = cameraLookDrag(12, -7, 0.001125, 0.12);
    expect(defaults.yaw).toBeLessThan(0);
    expect(defaults.pitch).toBeGreaterThan(0);
    const ordinary = cameraLookDrag(12, -7, 0.001125, 0.12, {
      reverseHorizontalLook: false,
      reverseVerticalLook: false,
    });
    expect(ordinary.yaw).toBeCloseTo(defaults.yaw, 12);
    expect(ordinary.pitch).toBeCloseTo(defaults.pitch, 12);
    const both = cameraLookDrag(12, -7, 0.001125, 0.12, {
      reverseHorizontalLook: true,
      reverseVerticalLook: true,
    });
    expect(both.yaw).toBeCloseTo(-defaults.yaw, 12);
    expect(both.pitch).toBeCloseTo(-defaults.pitch, 12);
  });

  it('keeps horizontal and vertical pan directions independent for mouse and touch deltas', () => {
    expect(cameraPanDrag(1, 12, -7, 0.25)).toEqual({ dx: 12, dy: -7 });
    expect(cameraPanDrag(2, 12, -7, 0.25)).toEqual({ dx: 3, dy: -1.75 });
    expect(cameraPanDrag(1, 12, -7, 0.25, { reverseHorizontalPan: true, reverseVerticalPan: false }))
      .toEqual({ dx: -12, dy: -7 });
    expect(cameraPanDrag(1, 12, -7, 0.25, { reverseHorizontalPan: false, reverseVerticalPan: true }))
      .toEqual({ dx: 12, dy: 7 });
    expect(cameraPanDrag(2, 12, -7, 0.25, { reverseHorizontalPan: true, reverseVerticalPan: true }))
      .toEqual({ dx: -3, dy: 1.75 });
  });

  it.each([25, 100, 300])('scales every movement family by %i%% without changing its sign', (percent) => {
    const multiplier = percent / 100;
    const look = cameraLookDrag(12, -7, 0.001125, 0.12, {
      reverseHorizontalLook: true,
      reverseVerticalLook: false,
      horizontalLookSensitivity: percent,
      verticalLookSensitivity: percent,
    });
    const baseLook = cameraLookDrag(12, -7, 0.001125, 0.12, {
      reverseHorizontalLook: true,
      reverseVerticalLook: false,
      horizontalLookSensitivity: 100,
      verticalLookSensitivity: 100,
    });
    expect(look.yaw).toBeCloseTo(baseLook.yaw * multiplier, 12);
    expect(look.pitch).toBeCloseTo(baseLook.pitch * multiplier, 12);

    const middle = cameraPanDrag(1, 12, -7, 0.25, {
      reverseHorizontalPan: true,
      reverseVerticalPan: true,
      middlePanSensitivity: percent,
      rightPanSensitivity: 100,
    });
    const right = cameraPanDrag(2, 12, -7, 0.25, {
      reverseHorizontalPan: true,
      reverseVerticalPan: true,
      middlePanSensitivity: 100,
      rightPanSensitivity: percent,
    });
    expect(middle.dx).toBeCloseTo(-12 * multiplier, 12);
    expect(middle.dy).toBeCloseTo(7 * multiplier, 12);
    expect(right.dx).toBeCloseTo(-3 * multiplier, 12);
    expect(right.dy).toBeCloseTo(1.75 * multiplier, 12);

    const wheelLog = Math.abs(Math.log(cameraWheelDollyScale(1, 0.9, percent)));
    const baseWheelLog = Math.abs(Math.log(cameraWheelDollyScale(1, 0.9, 100)));
    expect(wheelLog).toBeCloseTo(baseWheelLog * multiplier, 12);
    expect(cameraKeyboardMagnitude(8, percent)).toBeCloseTo(8 * multiplier, 12); // WASD
    expect(cameraKeyboardMagnitude(-1.35, percent)).toBeCloseTo(-1.35 * multiplier, 12); // Q/E
  });

  it('keeps middle and right pan sensitivity independent', () => {
    const preferences = {
      reverseHorizontalPan: true,
      reverseVerticalPan: true,
      middlePanSensitivity: 300,
      rightPanSensitivity: 25,
    };
    expect(cameraPanDrag(1, 10, 0, 0.25, preferences).dx).toBe(-30);
    expect(cameraPanDrag(2, 10, 0, 0.25, preferences).dx).toBe(-0.625);
    expect(cameraWheelDollyScale(0, 0.9, 300)).toBe(1);
  });

  it('separates ordinary clicks from camera drags at the shared editor threshold', () => {
    expect(crossedCameraDragThreshold(10, 10, 15, 15)).toBe(false);
    expect(crossedCameraDragThreshold(10, 10, 16, 10)).toBe(true);
    expect(crossedCameraDragThreshold(10, 10, 10, 4)).toBe(true);
  });
});
