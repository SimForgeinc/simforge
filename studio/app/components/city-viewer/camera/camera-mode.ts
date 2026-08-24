import * as THREE from 'three/webgpu';

export interface InputState {
  keys: Set<string>;
  mouseDown: Set<number>;
  mouseDX: number;
  mouseDY: number;
  scrollDelta: number;
  shiftKey: boolean;
}

export interface CameraMode {
  readonly name: 'orbit';
  activate(camera: THREE.PerspectiveCamera, target: THREE.Vector3): void;
  deactivate(): void;
  update(dt: number, input: InputState): void;
  getTarget(): THREE.Vector3;
}
