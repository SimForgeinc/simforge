import * as THREE from 'three/webgpu';
import type { CameraMode, InputState } from './camera-mode';
import { OrbitMode } from './orbit-mode';

export type CameraModeName = 'orbit';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

export class CameraController {
  private active: CameraMode;
  private camera: THREE.PerspectiveCamera;
  private input: InputState = {
    keys: new Set(),
    mouseDown: new Set(),
    mouseDX: 0, mouseDY: 0,
    scrollDelta: 0,
    shiftKey: false,
  };
  private _onModeChange: ((mode: CameraModeName) => void) | null = null;

  // Scene geometry used for mode transitions
  private groundY = 0;
  private sceneExtent = 100;
  private initialTarget = new THREE.Vector3();
  private initialPosition = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, el: HTMLElement) {
    this.camera = camera;
    this.active = new OrbitMode();
    this.active.activate(camera, new THREE.Vector3(0, 0, 0));
    this.bind(el);
  }

  get modeName(): CameraModeName {
    return this.active.name;
  }

  onModeChange(cb: (mode: CameraModeName) => void): void {
    this._onModeChange = cb;
  }

  /** Store scene geometry so mode transitions can place the camera sensibly. */
  setSceneBounds(groundY: number, extent: number): void {
    this.groundY = groundY;
    this.sceneExtent = extent;
  }

  switchMode(name: CameraModeName): void {
    if (this.active.name === name) return;
    const target = this.active.getTarget();
    this.active.deactivate();

    this.active = new OrbitMode();
    this.active.activate(this.camera, target);
    this._onModeChange?.(name);
  }

  update(dt: number): void {
    this.active.update(dt, this.input);
    this.input.mouseDX = 0;
    this.input.mouseDY = 0;
    this.input.scrollDelta = 0;
  }

  getTarget(): THREE.Vector3 {
    return this.active.getTarget();
  }

  /** Re-sync the orbit controller with the camera's current position/target after external repositioning. */
  resetToCamera(target?: THREE.Vector3): void {
    const lookTarget = target ?? new THREE.Vector3();
    this.initialTarget.copy(lookTarget);
    this.initialPosition.copy(this.camera.position);
    this.active.deactivate();
    this.active = new OrbitMode();
    this.active.activate(this.camera, lookTarget);
    this._onModeChange?.('orbit');
  }

  /** Fly to a specific position in orbit mode. Switches to orbit if in another mode. */
  flyTo(target: THREE.Vector3, radius?: number): void {
    if (this.active.name !== 'orbit') {
      this.switchMode('orbit');
    }
    (this.active as OrbitMode).flyTo(target, radius);
  }

  /** Return to the initial orbit view. */
  resetView(): void {
    this.camera.position.copy(this.initialPosition);
    this.active.deactivate();
    this.active = new OrbitMode();
    this.active.activate(this.camera, this.initialTarget.clone());
    this._onModeChange?.('orbit');
  }

  // Stored references so listeners can be removed in dispose()
  private _abortCtrl = new AbortController();

  private bind(el: HTMLElement): void {
    const o = { signal: this._abortCtrl.signal } as const;

    el.addEventListener('contextmenu', (e) => e.preventDefault(), o);

    window.addEventListener('keydown', (e) => {
      // Don't steal keys (W/A/S/D, etc.) while the user is typing in a text
      // field — search panels, AI search, modal inputs, etc.
      if (isEditableTarget(e.target)) return;

      this.input.keys.add(e.key.toLowerCase());
      this.input.shiftKey = e.shiftKey;

      if (e.key === '1') this.switchMode('orbit');
    }, o);

    // Always process keyup, even if the user has since focused an input —
    // otherwise a key pressed in the viewer and released over an input would
    // stay "held" and the camera would drift forever.
    window.addEventListener('keyup', (e) => {
      this.input.keys.delete(e.key.toLowerCase());
      this.input.shiftKey = e.shiftKey;
    }, o);

    el.addEventListener('mousedown', (e) => {
      this.input.mouseDown.add(e.button);
    }, o);

    window.addEventListener('mouseup', (e) => {
      this.input.mouseDown.delete(e.button);
    }, o);

    el.addEventListener('mousemove', (e) => {
      this.input.mouseDX += e.movementX;
      this.input.mouseDY += e.movementY;
    }, o);

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.input.scrollDelta += e.deltaY;
    }, { passive: false, signal: this._abortCtrl.signal });

    // Touch support
    let lastTouch: Touch | null = null;
    el.addEventListener('touchstart', (e) => {
      lastTouch = e.touches[0] ?? null;
      this.input.mouseDown.add(0);
    }, o);
    el.addEventListener('touchmove', (e) => {
      if (lastTouch && e.touches[0]) {
        this.input.mouseDX += e.touches[0].clientX - lastTouch.clientX;
        this.input.mouseDY += e.touches[0].clientY - lastTouch.clientY;
        lastTouch = e.touches[0];
      }
    }, o);
    el.addEventListener('touchend', () => {
      lastTouch = null;
      this.input.mouseDown.delete(0);
    }, o);
  }

  dispose(): void {
    this._abortCtrl.abort();
    this.active.deactivate();
  }
}
