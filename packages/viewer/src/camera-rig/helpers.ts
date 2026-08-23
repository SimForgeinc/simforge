import {
  CameraHelper,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  SphereGeometry,
  Vector3,
} from 'three';
import type { AuthoredCamera } from './model';

/** Editor-only camera bodies and frusta. Never included in simulation/export. */
export class AuthoredCameraHelpers {
  readonly group = new Group();
  private readonly resources: Array<{ helper: CameraHelper; body: Mesh; camera: PerspectiveCamera }> = [];

  constructor() {
    this.group.name = 'studio-authored-camera-helpers';
  }

  sync(cameras: readonly AuthoredCamera[], activeId?: string): void {
    this.clear();
    for (const view of cameras) {
      const camera = new PerspectiveCamera(view.fov, 16 / 9, 0.2, 80);
      camera.position.fromArray(view.position as [number, number, number]);
      camera.lookAt(new Vector3().fromArray(view.target as [number, number, number]));
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      const helper = new CameraHelper(camera);
      const active = view.id === activeId;
      const color = new Color(active ? 0x55d6ff : 0x8e9bac);
      const material = helper.material as unknown as { color?: Color; transparent?: boolean; opacity?: number };
      material.color?.copy(color);
      material.transparent = true;
      material.opacity = active ? 0.9 : 0.45;
      helper.userData.cameraId = view.id;
      const body = new Mesh(
        new SphereGeometry(active ? 0.28 : 0.2, 10, 6),
        new MeshBasicMaterial({ color, depthTest: false }),
      );
      body.position.copy(camera.position);
      body.userData.cameraId = view.id;
      this.group.add(helper, body);
      this.resources.push({ helper, body, camera });
    }
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }

  private clear(): void {
    this.group.clear();
    for (const resource of this.resources) {
      resource.helper.dispose();
      resource.body.geometry.dispose();
      (resource.body.material as MeshBasicMaterial).dispose();
    }
    this.resources.length = 0;
  }
}
