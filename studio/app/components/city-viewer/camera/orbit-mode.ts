import * as THREE from 'three/webgpu';
import type { CameraMode, InputState } from './camera-mode';

// Speed caps (per frame, before smoothing)
const MAX_ROTATE_DELTA = 15;   // max pixels of mouse movement applied per frame
const MAX_PAN_SPEED = 150;     // max pan units per second
const MAX_SCROLL_DELTA = 150;  // max scroll delta per frame

// Cinematic spring constant — lower = slower/smoother ease-out
const SPRING_K = 3.5;

export class OrbitMode implements CameraMode {
  readonly name = 'orbit' as const;
  private camera!: THREE.PerspectiveCamera;

  // Target values (what the user is requesting via input)
  private targetPosition = new THREE.Vector3();
  private targetSpherical = new THREE.Spherical(300, Math.PI / 3, 0);

  // Current smoothed values (what the camera actually uses)
  private currentPosition = new THREE.Vector3();
  private spherical = new THREE.Spherical(300, Math.PI / 3, 0);

  private _right = new THREE.Vector3();
  private _up = new THREE.Vector3();
  private _fwd = new THREE.Vector3();
  private _offset = new THREE.Vector3();

  activate(camera: THREE.PerspectiveCamera, target: THREE.Vector3): void {
    this.camera = camera;
    this.targetPosition.copy(target);
    this.currentPosition.copy(target);
    const offset = camera.position.clone().sub(target);
    this.spherical.setFromVector3(offset);
    this.targetSpherical.copy(this.spherical);
  }

  deactivate(): void {}

  update(dt: number, input: InputState): void {
    const alpha = 1 - Math.exp(-SPRING_K * dt);

    // --- Rotation (left-drag) with clamped delta ---
    if (input.mouseDown.has(0)) {
      const dx = Math.max(-MAX_ROTATE_DELTA, Math.min(MAX_ROTATE_DELTA, input.mouseDX));
      const dy = Math.max(-MAX_ROTATE_DELTA, Math.min(MAX_ROTATE_DELTA, input.mouseDY));
      this.targetSpherical.theta -= dx * 0.003;
      this.targetSpherical.phi -= dy * 0.003;
      this.targetSpherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, this.targetSpherical.phi));
    }

    // --- Pan (right-drag) with clamped speed ---
    if (input.mouseDown.has(2)) {
      const panSpeed = this.spherical.radius * 0.001;
      const dx = Math.max(-MAX_ROTATE_DELTA, Math.min(MAX_ROTATE_DELTA, input.mouseDX));
      const dy = Math.max(-MAX_ROTATE_DELTA, Math.min(MAX_ROTATE_DELTA, input.mouseDY));
      this._right.setFromMatrixColumn(this.camera.matrix, 0);
      this._up.setFromMatrixColumn(this.camera.matrix, 1);
      this.targetPosition.addScaledVector(this._right, -dx * panSpeed);
      this.targetPosition.addScaledVector(this._up, dy * panSpeed);
    }

    // --- Zoom (scroll) with clamped delta ---
    if (input.scrollDelta !== 0) {
      const scroll = Math.max(-MAX_SCROLL_DELTA, Math.min(MAX_SCROLL_DELTA, input.scrollDelta));
      const factor = 1 + scroll * 0.001;
      this.targetSpherical.radius = Math.max(1, Math.min(10000, this.targetSpherical.radius * factor));
    }

    // --- Keyboard pan (WASD) with capped speed ---
    const kSpeed = Math.min(this.spherical.radius * 0.5, MAX_PAN_SPEED) * dt;
    this._right.setFromMatrixColumn(this.camera.matrix, 0);
    this._fwd.setFromMatrixColumn(this.camera.matrix, 2).negate();
    this._fwd.y = 0; this._fwd.normalize();
    if (input.keys.has('w') || input.keys.has('arrowup')) this.targetPosition.addScaledVector(this._fwd, kSpeed);
    if (input.keys.has('s') || input.keys.has('arrowdown')) this.targetPosition.addScaledVector(this._fwd, -kSpeed);
    if (input.keys.has('a') || input.keys.has('arrowleft')) this.targetPosition.addScaledVector(this._right, -kSpeed);
    if (input.keys.has('d') || input.keys.has('arrowright')) this.targetPosition.addScaledVector(this._right, kSpeed);

    // --- Spring smoothing (cinematic ease-out) ---
    this.currentPosition.lerp(this.targetPosition, alpha);
    this.spherical.radius += (this.targetSpherical.radius - this.spherical.radius) * alpha;
    this.spherical.phi += (this.targetSpherical.phi - this.spherical.phi) * alpha;
    this.spherical.theta += (this.targetSpherical.theta - this.spherical.theta) * alpha;

    // --- Apply ---
    this._offset.setFromSpherical(this.spherical);
    this.camera.position.copy(this.currentPosition).add(this._offset);
    this.camera.lookAt(this.currentPosition);
  }

  /** Smoothly fly to a new orbit target. Spring interpolation handles the animation. */
  flyTo(target: THREE.Vector3, radius?: number): void {
    this.targetPosition.copy(target);
    if (radius !== undefined) {
      this.targetSpherical.radius = Math.max(1, Math.min(10000, radius));
    }
    // Slightly overhead viewing angle for good spatial context
    this.targetSpherical.phi = Math.PI / 3.5;
  }

  getTarget(): THREE.Vector3 {
    return this.targetPosition.clone();
  }
}
