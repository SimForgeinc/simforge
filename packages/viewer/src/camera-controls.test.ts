import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraRig } from './camera-controls';
import { DEFAULT_CAMERA_CONTROL_PREFERENCES } from './camera-drag';
import { CAMERA_ORBIT_EVENT } from './camera-events';

class FakeTarget {
  readonly style: Record<string, string> = {};
  readonly clientHeight = 100;
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  private readonly captures = new Set<number>();

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  dispatchEvent(event: Event): boolean {
    this.dispatch(event.type, event as unknown as Record<string, unknown>);
    return true;
  }

  setPointerCapture(id: number): void { this.captures.add(id); }
  releasePointerCapture(id: number): void { this.captures.delete(id); }
  hasPointerCapture(id: number): boolean { return this.captures.has(id); }
  requestPointerLock(): Promise<void> { return Promise.resolve(); }
}

function pose(camera: PerspectiveCamera): { position: Vector3; quaternion: number[] } {
  return { position: camera.position.clone(), quaternion: camera.quaternion.toArray() };
}

describe('CameraRig eye-orbit and inverted drags', () => {
  let fakeWindow: FakeTarget;
  let fakeDocument: FakeTarget & { pointerLockElement: unknown; exitPointerLock: () => void };

  beforeEach(() => {
    fakeWindow = new FakeTarget();
    fakeDocument = Object.assign(new FakeTarget(), {
      pointerLockElement: null as unknown,
      exitPointerLock: () => {},
    });
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', fakeDocument);
  });

  afterEach(() => vi.unstubAllGlobals());

  function rigFixture() {
    const dom = new FakeTarget();
    const camera = new PerspectiveCamera(55, 2, 0.1, 1000);
    camera.position.set(20, 25, 60);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const rig = new CameraRig(camera, dom as unknown as HTMLElement);
    rig.setView(camera.position, new Vector3(0, 0, 0));
    return { dom, camera, rig };
  }

  it('keeps exact camera transform and target for an ordinary left click', () => {
    const { dom, camera, rig } = rigFixture();
    const initial = pose(camera);
    const initialTarget = rig.target.toArray();

    dom.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 20, clientY: 20 });
    expect(pose(camera)).toEqual(initial);
    dom.dispatch('pointermove', { pointerId: 1, clientX: 25, clientY: 25, movementX: 5, movementY: 5 });
    rig.update(1 / 60);
    expect(pose(camera)).toEqual(initial);
    expect(rig.target.toArray()).toEqual(initialTarget);
    dom.dispatch('pointerup', { pointerId: 1, button: 0, clientX: 25, clientY: 25 });
    rig.dispose();
  });

  it('left drag rotates only orientation/target about an invariant eye', () => {
    const { dom, camera, rig } = rigFixture();
    const onOrbit = vi.fn();
    dom.addEventListener(CAMERA_ORBIT_EVENT, onOrbit);
    const eye = camera.position.toArray();
    const quaternion = camera.quaternion.toArray();
    dom.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 20, clientY: 20 });
    dom.dispatch('pointermove', { pointerId: 1, clientX: 30, clientY: 24, movementX: 10, movementY: 4 });
    rig.update(1 / 60);
    expect(camera.position.toArray()).toEqual(eye);
    expect(camera.quaternion.toArray()).not.toEqual(quaternion);
    expect(onOrbit).toHaveBeenCalledOnce();
    dom.dispatch('pointerup', { pointerId: 1, button: 0, clientX: 30, clientY: 24 });
    rig.dispose();
  });

  it('middle and right drags share the default direction and keep RMB precise', () => {
    const middle = rigFixture();
    const middleStart = middle.camera.position.clone();
    middle.dom.dispatch('pointerdown', { pointerId: 1, button: 1, clientX: 20, clientY: 20 });
    middle.dom.dispatch('pointermove', { pointerId: 1, clientX: 32, clientY: 13, movementX: 12, movementY: -7 });
    middle.rig.update(1 / 60);
    const middleDelta = middle.camera.position.clone().sub(middleStart);
    expect(middleDelta.x).toBeLessThan(0);
    middle.rig.dispose();

    const right = rigFixture();
    const rightStart = right.camera.position.clone();
    right.dom.dispatch('pointerdown', { pointerId: 1, button: 2, clientX: 20, clientY: 20 });
    right.dom.dispatch('pointermove', { pointerId: 1, clientX: 32, clientY: 13, movementX: 12, movementY: -7 });
    right.rig.update(1 / 60);
    const rightDelta = right.camera.position.clone().sub(rightStart);
    expect(rightDelta.x).toBeLessThan(0);
    expect(Math.abs(rightDelta.x)).toBeLessThan(Math.abs(middleDelta.x));
    right.rig.dispose();
  });

  it('changes preferences without snapping and applies each sign exactly once', () => {
    const reversed = rigFixture();
    const initial = pose(reversed.camera);
    const initialTarget = reversed.rig.target.toArray();
    reversed.rig.setControlPreferences({
      ...DEFAULT_CAMERA_CONTROL_PREFERENCES,
      reverseHorizontalLook: false,
      reverseVerticalLook: true,
      reverseHorizontalPan: true,
      reverseVerticalPan: false,
    });
    expect(pose(reversed.camera)).toEqual(initial);
    expect(reversed.rig.target.toArray()).toEqual(initialTarget);
    expect(reversed.rig.getControlPreferences()).toEqual({
      ...DEFAULT_CAMERA_CONTROL_PREFERENCES,
      reverseHorizontalLook: false,
      reverseVerticalLook: true,
      reverseHorizontalPan: true,
      reverseVerticalPan: false,
    });

    const start = reversed.camera.position.clone();
    reversed.dom.dispatch('pointerdown', { pointerId: 1, button: 1, clientX: 20, clientY: 20 });
    reversed.dom.dispatch('pointermove', { pointerId: 1, clientX: 32, clientY: 13, movementX: 12, movementY: -7 });
    reversed.rig.update(1 / 60);
    expect(reversed.camera.position.x - start.x).toBeGreaterThan(0);
    reversed.rig.dispose();
  });

  it('only suppresses context menu after a right-button camera drag', () => {
    const { dom, rig } = rigFixture();
    const ordinary = { preventDefault: vi.fn() };
    dom.dispatch('contextmenu', ordinary);
    expect(ordinary.preventDefault).not.toHaveBeenCalled();
    dom.dispatch('pointerdown', { pointerId: 1, button: 2, clientX: 20, clientY: 20 });
    dom.dispatch('pointermove', { pointerId: 1, clientX: 30, clientY: 20, movementX: 10, movementY: 0 });
    dom.dispatch('pointerup', { pointerId: 1, button: 2, clientX: 30, clientY: 20 });
    const dragged = { preventDefault: vi.fn() };
    dom.dispatch('contextmenu', dragged);
    expect(dragged.preventDefault).toHaveBeenCalledOnce();
    rig.dispose();
  });
});
