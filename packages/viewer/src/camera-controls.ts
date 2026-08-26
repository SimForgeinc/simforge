import { Euler, MathUtils, PerspectiveCamera, Vector2, Vector3 } from 'three';
import {
  applyEyeOrbit,
  cameraLookSensitivityMultiplier,
  cameraLookDrag,
  cameraKeyboardMagnitude,
  cameraPanDrag,
  cameraSensitivityMultiplier,
  cameraWheelDollyScale,
  crossedCameraDragThreshold,
  DEFAULT_CAMERA_CONTROL_PREFERENCES,
  dampedEyeOrbitStep,
  type CameraControlPreferences,
} from './camera-drag';
import { CAMERA_ORBIT_EVENT } from './camera-events';

export type CameraMode = 'orbit' | 'fly';

/** Framework-neutral camera pose used by Studio viewpoints and capture tools. */
export interface CameraView {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  fov: number;
}

export type CameraPoseConstraint = (
  camera: PerspectiveCamera,
  target: Vector3,
) => void;

const _euler = new Euler();
const _dir = new Vector3();
const _right = new Vector3();
const _move = new Vector3();
const UP = new Vector3(0, 1, 0);

/**
 * One rig, two modes.
 *
 * City: WASD/arrow keys pan, Q/E rotates, LMB drag orbits,
 * MMB/RMB drag pans, and the wheel zooms. Fly: pointer-lock mouse look with WASD/QE,
 * shift to sprint. Both modes share
 * the same camera and hand over the pose on toggle, so switching never jumps.
 */
export class CameraRig {
  mode: CameraMode = 'orbit';
  readonly target = new Vector3();

  minDistance = 2;
  maxDistance = 4000;
  // Deliberately restrained for large city maps: a full-width drag should
  // reframe the city, not spin past the intended heading.
  orbitSpeed = 0.001125;
  panSpeed = 1;
  /** RMB is a precision pan; MMB keeps the faster city-navigation rate. */
  rightPanScale = 0.25;
  zoomSpeed = 0.9;
  flySpeed = 40;
  lookSpeed = 0.0022;
  damping = 0.12;
  /** Ground-plane travel as a fraction of camera distance per second. */
  cityPanSpeed = 0.72;
  /** Keyboard rotation speed, radians per second. */
  cityRotateSpeed = 1.35;

  private readonly camera: PerspectiveCamera;
  private readonly dom: HTMLElement;
  private readonly panOffset = new Vector3();
  private readonly pointers = new Map<number, Vector2>();
  private readonly keys = new Set<string>();
  private readonly euler = { yaw: 0, pitch: 0 };
  private readonly velocity = new Vector3();
  private dollyScale = 1;
  private dragButton = -1;
  private pointerLocked = false;
  private poseConstraint: CameraPoseConstraint | null = null;
  private dragPress: Vector2 | null = null;
  private cameraDragging = false;
  private suppressNextContextMenu = false;
  private stableYawRemaining = 0;
  private stablePitchRemaining = 0;
  private enabled = true;
  private disposed = false;
  private controlPreferences: CameraControlPreferences = { ...DEFAULT_CAMERA_CONTROL_PREFERENCES };

  constructor(camera: PerspectiveCamera, dom: HTMLElement) {
    this.camera = camera;
    this.dom = dom;
    dom.style.touchAction = 'none';
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.syncFromCamera();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.keys.clear();
      this.pointers.clear();
      this.velocity.set(0, 0, 0);
      this.dragPress = null;
      this.cameraDragging = false;
      this.stableYawRemaining = 0;
      this.stablePitchRemaining = 0;
      if (this.pointerLocked) document.exitPointerLock();
    }
  }

  /** Changes future input signs only; the current pose and queued motion stay untouched. */
  setControlPreferences(preferences: CameraControlPreferences): void {
    const sensitivity = (value: number): number => cameraSensitivityMultiplier(value) * 100;
    const lookSensitivity = (value: number): number => cameraLookSensitivityMultiplier(value) * 250;
    this.controlPreferences = {
      ...preferences,
      horizontalLookSensitivity: lookSensitivity(preferences.horizontalLookSensitivity),
      verticalLookSensitivity: lookSensitivity(preferences.verticalLookSensitivity),
      middlePanSensitivity: sensitivity(preferences.middlePanSensitivity),
      rightPanSensitivity: sensitivity(preferences.rightPanSensitivity),
      wheelZoomSensitivity: sensitivity(preferences.wheelZoomSensitivity),
      keyboardMoveSensitivity: sensitivity(preferences.keyboardMoveSensitivity),
      keyboardTurnSensitivity: sensitivity(preferences.keyboardTurnSensitivity),
    };
  }

  getControlPreferences(): CameraControlPreferences {
    return { ...this.controlPreferences };
  }

  /** Install map-derived eye/target limits applied after every camera mutation. */
  setPoseConstraint(constraint: CameraPoseConstraint | null): void {
    this.poseConstraint = constraint;
    this.applyPoseConstraint();
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'fly') {
      this.camera.getWorldDirection(_dir);
      this.euler.yaw = Math.atan2(-_dir.x, -_dir.z);
      this.euler.pitch = Math.asin(MathUtils.clamp(_dir.y, -1, 1));
      this.velocity.set(0, 0, 0);
    } else {
      // Re-anchor the orbit target in front of wherever we flew to.
      this.camera.getWorldDirection(_dir);
      const distance = Math.min(this.maxDistance, Math.max(this.minDistance, 60));
      this.target.copy(this.camera.position).addScaledVector(_dir, distance);
      this.syncFromCamera();
    }
  }

  toggleMode(): CameraMode {
    this.setMode(this.mode === 'orbit' ? 'fly' : 'orbit');
    return this.mode;
  }

  /** Places the camera at `position` looking at `target` (orbit mode). */
  setView(position: Vector3, target: Vector3): void {
    this.camera.position.copy(position);
    this.target.copy(target);
    this.applyPoseConstraint();
    this.camera.lookAt(this.target);
    this.syncFromCamera();
  }

  /** Capture the exact editable view without exposing mutable Three.js objects. */
  getView(): CameraView {
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.target.x, this.target.y, this.target.z],
      fov: this.camera.fov,
    };
  }

  /** Restore a captured view, including its perspective field of view. */
  applyView(view: CameraView): void {
    this.camera.fov = MathUtils.clamp(view.fov, 10, 120);
    this.camera.updateProjectionMatrix();
    this.setView(
      new Vector3(view.position[0], view.position[1], view.position[2]),
      new Vector3(view.target[0], view.target[1], view.target[2]),
    );
  }

  private syncFromCamera(): void {
    this.panOffset.set(0, 0, 0);
    this.dollyScale = 1;
    this.stableYawRemaining = 0;
    this.stablePitchRemaining = 0;
  }

  update(dt: number): void {
    if (this.mode === 'orbit') this.updateOrbit(dt);
    else this.updateFly(dt);
    this.applyPoseConstraint();
    if (this.mode === 'orbit') this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld(true);
  }

  private applyPoseConstraint(): void {
    this.poseConstraint?.(this.camera, this.target);
  }

  private updateOrbit(dt: number): void {
    // A click remains byte-for-byte camera neutral until it becomes a drag.
    if (this.dragPress && !this.cameraDragging) return;
    this.updateCityNavigation(dt);

    const yaw = dampedEyeOrbitStep(this.stableYawRemaining, dt);
    const pitch = dampedEyeOrbitStep(this.stablePitchRemaining, dt);
    this.stableYawRemaining -= yaw;
    this.stablePitchRemaining -= pitch;
    if (Math.abs(this.stableYawRemaining) < 1e-7) this.stableYawRemaining = 0;
    if (Math.abs(this.stablePitchRemaining) < 1e-7) this.stablePitchRemaining = 0;
    applyEyeOrbit(this.camera, this.target, { yaw, pitch });

    if (this.dollyScale !== 1) {
      _dir.copy(this.camera.position).sub(this.target);
      const radius = MathUtils.clamp(
        _dir.length() * this.dollyScale,
        this.minDistance,
        this.maxDistance,
      );
      if (_dir.lengthSq() > 1e-12) {
        _dir.setLength(radius);
        this.camera.position.copy(this.target).add(_dir);
      }
      this.dollyScale = 1;
    }

    if (this.panOffset.lengthSq() > 1e-12) {
      this.target.add(this.panOffset);
      this.camera.position.add(this.panOffset);
      this.panOffset.multiplyScalar(1 - this.damping);
    }
    this.camera.updateMatrixWorld(true);
  }

  private updateCityNavigation(dt: number): void {
    const keys = this.keys;
    const rotate = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
    const tilt = (keys.has('PageDown') ? 1 : 0) - (keys.has('PageUp') ? 1 : 0);
    if (rotate !== 0 || tilt !== 0) {
      applyEyeOrbit(this.camera, this.target, {
        yaw: cameraKeyboardMagnitude(
          rotate * this.cityRotateSpeed * dt,
          this.controlPreferences.keyboardTurnSensitivity,
        ),
        pitch: cameraKeyboardMagnitude(
          tilt * this.cityRotateSpeed * 0.7 * dt,
          this.controlPreferences.keyboardTurnSensitivity,
        ),
      });
    }

    let horizontal =
      (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
      (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    let vertical =
      (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
      (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    if (horizontal === 0 && vertical === 0) return;
    const length = Math.hypot(horizontal, vertical);
    horizontal /= length;
    vertical /= length;
    const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.5 : 1;
    const distance = cameraKeyboardMagnitude(
      Math.max(8, this.camera.position.distanceTo(this.target)) * this.cityPanSpeed * boost * dt,
      this.controlPreferences.keyboardMoveSensitivity,
    );
    this.camera.getWorldDirection(_dir);
    _right.crossVectors(_dir, UP).normalize();
    const forward = _dir.clone().setY(0).normalize();
    _move.copy(_right).multiplyScalar(horizontal * distance).addScaledVector(forward, vertical * distance);
    this.target.add(_move);
    this.camera.position.add(_move);
  }

  private updateFly(dt: number): void {
    _euler.set(this.euler.pitch, this.euler.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(_euler);

    const keys = this.keys;
    const fx = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    const fz = (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0);
    const fy =
      (keys.has('KeyE') || keys.has('Space') ? 1 : 0) -
      (keys.has('KeyQ') || keys.has('ControlLeft') ? 1 : 0);
    const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1;

    _dir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    _right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    _move.set(0, 0, 0).addScaledVector(_dir, -fz).addScaledVector(_right, fx).addScaledVector(UP, fy);
    if (_move.lengthSq() > 0) _move.normalize().multiplyScalar(
      cameraKeyboardMagnitude(this.flySpeed * sprint, this.controlPreferences.keyboardMoveSensitivity),
    );

    // Critically-ish damped approach so key taps do not snap the camera.
    const blend = 1 - Math.exp(-dt * 12);
    this.velocity.lerp(_move, blend);
    this.camera.position.addScaledVector(this.velocity, dt);
  }

  private onContextMenu = (event: Event): void => {
    if (!this.suppressNextContextMenu) return;
    event.preventDefault();
    this.suppressNextContextMenu = false;
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    // Never inherit suppression from an earlier gesture whose platform did
    // not emit a contextmenu event after pointer-up.
    this.suppressNextContextMenu = false;
    this.dom.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, new Vector2(event.clientX, event.clientY));
    this.dragButton = event.button;
    if (this.mode === 'orbit' && (event.button === 0 || event.button === 1 || event.button === 2)) {
      this.dragPress = new Vector2(event.clientX, event.clientY);
      this.cameraDragging = false;
    }
    if (this.mode === 'fly' && !this.pointerLocked) void this.dom.requestPointerLock();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.enabled) return;
    if (this.mode === 'fly') {
      if (!this.pointerLocked) return;
      this.euler.yaw += event.movementX * this.lookSpeed
        * (this.controlPreferences.reverseHorizontalLook ? 1 : -1)
        * cameraLookSensitivityMultiplier(this.controlPreferences.horizontalLookSensitivity);
      this.euler.pitch = MathUtils.clamp(
        this.euler.pitch + event.movementY * this.lookSpeed
          * (this.controlPreferences.reverseVerticalLook ? 1 : -1)
          * cameraLookSensitivityMultiplier(this.controlPreferences.verticalLookSensitivity),
        -Math.PI / 2 + 0.01,
        Math.PI / 2 - 0.01,
      );
      return;
    }
    const previous = this.pointers.get(event.pointerId);
    if (!previous) return;
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    previous.set(event.clientX, event.clientY);
    if (!this.cameraDragging) {
      const press = this.dragPress;
      if (!press || !crossedCameraDragThreshold(press.x, press.y, event.clientX, event.clientY)) return;
      this.cameraDragging = true;
      if (this.dragButton === 0 || this.dragButton === 2) {
        this.dom.dispatchEvent(new Event(CAMERA_ORBIT_EVENT, { bubbles: true }));
      }
      this.stableYawRemaining = 0;
      this.stablePitchRemaining = 0;
      this.panOffset.set(0, 0, 0);
      this.dollyScale = 1;
      if (this.dragButton === 2) this.suppressNextContextMenu = true;
    }
    if (this.pointers.size >= 2 || this.dragButton === 1) {
      const delta = cameraPanDrag(1, dx, dy, this.rightPanScale, this.controlPreferences);
      this.pan(delta.dx, delta.dy);
    } else if (this.dragButton === 0 || this.dragButton === 2) {
      const delta = cameraLookDrag(dx, dy, this.orbitSpeed, this.damping, this.controlPreferences);
      this.stableYawRemaining += delta.yaw;
      this.stablePitchRemaining += delta.pitch;
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size === 0) {
      this.dragButton = -1;
      this.dragPress = null;
      this.cameraDragging = false;
    }
    if (this.dom.hasPointerCapture(event.pointerId)) this.dom.releasePointerCapture(event.pointerId);
  };

  private pan(dx: number, dy: number): void {
    const height = this.dom.clientHeight || 1;
    const radius = this.camera.position.distanceTo(this.target);
    const scale = (2 * radius * Math.tan(MathUtils.degToRad(this.camera.fov * 0.5))) / height;
    this.camera.getWorldDirection(_dir);
    _right.crossVectors(_dir, UP).normalize();
    _move.copy(_right).multiplyScalar(-dx * scale * this.panSpeed);
    const forward = _dir.clone().setY(0).normalize();
    _move.addScaledVector(forward, -dy * scale * this.panSpeed);
    this.panOffset.add(_move);
  }

  private onWheel = (event: WheelEvent): void => {
    if (!this.enabled) return;
    event.preventDefault();
    if (this.mode === 'orbit') {
      this.dollyScale *= cameraWheelDollyScale(
        event.deltaY,
        this.zoomSpeed,
        this.controlPreferences.wheelZoomSensitivity,
      );
    } else {
      const sensitivity = cameraSensitivityMultiplier(this.controlPreferences.wheelZoomSensitivity);
      const flyFactor = event.deltaY > 0 ? Math.pow(0.9, sensitivity) : Math.pow(1.1, sensitivity);
      this.flySpeed = MathUtils.clamp(this.flySpeed * flyFactor, 1, 800);
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled) return;
    if (isTypingTarget(event.target)) return;
    this.keys.add(event.code);
    if (
      this.mode === 'orbit' &&
      (event.code.startsWith('Arrow') || event.code === 'PageUp' || event.code === 'PageDown')
    ) {
      event.preventDefault();
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.dom;
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('pointercancel', this.onPointerUp);
    this.dom.removeEventListener('wheel', this.onWheel);
    this.dom.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    if (this.pointerLocked) document.exitPointerLock();
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element?.tagName) return false;
  const tag = element.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable;
}
