import { MathUtils, PerspectiveCamera, Quaternion, Vector3 } from 'three';

export type CameraDragButton = 0 | 1 | 2;

export interface EyeOrbitDelta {
  yaw: number;
  pitch: number;
}

export interface CameraControlPreferences {
  reverseHorizontalLook: boolean;
  reverseVerticalLook: boolean;
  reverseHorizontalPan: boolean;
  reverseVerticalPan: boolean;
  horizontalLookSensitivity: number;
  verticalLookSensitivity: number;
  middlePanSensitivity: number;
  rightPanSensitivity: number;
  wheelZoomSensitivity: number;
  keyboardMoveSensitivity: number;
  keyboardTurnSensitivity: number;
}

export const DEFAULT_CAMERA_CONTROL_PREFERENCES: Readonly<CameraControlPreferences> = Object.freeze({
  reverseHorizontalLook: false,
  reverseVerticalLook: false,
  reverseHorizontalPan: false,
  reverseVerticalPan: false,
  horizontalLookSensitivity: 100,
  verticalLookSensitivity: 100,
  middlePanSensitivity: 100,
  rightPanSensitivity: 100,
  wheelZoomSensitivity: 100,
  keyboardMoveSensitivity: 100,
  keyboardTurnSensitivity: 100,
});

export function cameraSensitivityMultiplier(percent: number): number {
  return MathUtils.clamp(Number.isFinite(percent) ? percent : 100, 25, 300) / 100;
}

/** User-facing look speed: 100% preserves the historical 0.4 multiplier. */
export function cameraLookSensitivityMultiplier(percent: number): number {
  return MathUtils.clamp(Number.isFinite(percent) ? percent : 100, 25, 750) * 0.004;
}

const UP = new Vector3(0, 1, 0);
const _direction = new Vector3();
const _right = new Vector3();
const _rotation = new Quaternion();

/** Convert pointer travel to look angles without coupling either axis. */
export function cameraLookDrag(
  dx: number,
  dy: number,
  speed: number,
  damping: number,
  preferences: Pick<CameraControlPreferences, 'reverseHorizontalLook' | 'reverseVerticalLook'>
    & Partial<Pick<CameraControlPreferences, 'horizontalLookSensitivity' | 'verticalLookSensitivity'>> = DEFAULT_CAMERA_CONTROL_PREFERENCES,
): EyeOrbitDelta {
  const scale = speed / Math.max(damping, 1e-3);
  return {
    yaw: dx * scale * (preferences.reverseHorizontalLook ? 1 : -1)
      * cameraLookSensitivityMultiplier(
        preferences.horizontalLookSensitivity ?? DEFAULT_CAMERA_CONTROL_PREFERENCES.horizontalLookSensitivity,
      ),
    pitch: dy * scale * (preferences.reverseVerticalLook ? 1 : -1)
      * cameraLookSensitivityMultiplier(
        preferences.verticalLookSensitivity ?? DEFAULT_CAMERA_CONTROL_PREFERENCES.verticalLookSensitivity,
      ),
  };
}

/** Convert middle/right pointer travel with independent screen-axis signs. */
export function cameraPanDrag(
  button: 1 | 2,
  dx: number,
  dy: number,
  rightPanScale: number,
  preferences: Pick<CameraControlPreferences, 'reverseHorizontalPan' | 'reverseVerticalPan'>
    & Partial<Pick<CameraControlPreferences, 'middlePanSensitivity' | 'rightPanSensitivity'>> = DEFAULT_CAMERA_CONTROL_PREFERENCES,
): { dx: number; dy: number } {
  const sensitivity = button === 2
    ? preferences.rightPanSensitivity ?? 100
    : preferences.middlePanSensitivity ?? 100;
  const scale = (button === 2 ? rightPanScale : 1) * cameraSensitivityMultiplier(sensitivity);
  return {
    dx: dx * scale * (preferences.reverseHorizontalPan ? -1 : 1),
    dy: dy * scale * (preferences.reverseVerticalPan ? -1 : 1),
  };
}

export function cameraWheelDollyScale(deltaY: number, zoomSpeed: number, sensitivityPercent: number): number {
  if (deltaY === 0) return 1;
  const factor = Math.pow(0.95, zoomSpeed * cameraSensitivityMultiplier(sensitivityPercent));
  return deltaY > 0 ? 1 / factor : factor;
}

export function cameraKeyboardMagnitude(baseMagnitude: number, sensitivityPercent: number): number {
  return baseMagnitude * cameraSensitivityMultiplier(sensitivityPercent);
}


/** @deprecated Use cameraLookDrag with explicit preferences. */
export const invertedOrbitDrag = cameraLookDrag;
/** @deprecated Use cameraPanDrag with explicit preferences. */
export const invertedPanDrag = cameraPanDrag;

/**
 * Rotate view direction about the camera eye. The eye position is never
 * written, while target distance remains stable for zoom and pan semantics.
 */
export function applyEyeOrbit(
  camera: PerspectiveCamera,
  target: Vector3,
  delta: EyeOrbitDelta,
  minPitch = -Math.PI / 2 + 0.01,
  maxPitch = -0.02,
): void {
  const distance = Math.max(1e-6, camera.position.distanceTo(target));
  camera.getWorldDirection(_direction).normalize();
  if (delta.yaw !== 0) {
    _rotation.setFromAxisAngle(UP, delta.yaw);
    _direction.applyQuaternion(_rotation).normalize();
  }
  const currentPitch = Math.asin(MathUtils.clamp(_direction.y, -1, 1));
  const pitch = MathUtils.clamp(currentPitch + delta.pitch, minPitch, maxPitch) - currentPitch;
  if (Math.abs(pitch) > 1e-12) {
    _right.crossVectors(_direction, UP).normalize();
    _rotation.setFromAxisAngle(_right, pitch);
    _direction.applyQuaternion(_rotation).normalize();
  }
  target.copy(camera.position).addScaledVector(_direction, distance);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
}

export function crossedCameraDragThreshold(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  threshold = 5,
): boolean {
  return Math.abs(currentX - startX) > threshold || Math.abs(currentY - startY) > threshold;
}

/** Consume a queued angle monotonically, with no overshoot. */
export function dampedEyeOrbitStep(remaining: number, dt: number, response = 55): number {
  if (Math.abs(remaining) < 1e-7) return remaining;
  return remaining * MathUtils.clamp(1 - Math.exp(-Math.max(0, dt) * response), 0, 1);
}
