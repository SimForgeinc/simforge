import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  SphereGeometry,
  Vector3,
} from 'three';

export interface ViewerPoint3 {
  x: number;
  y: number;
  z: number;
}

export interface ViewerPin {
  id: string;
  position: ViewerPoint3;
  highlighted?: boolean;
}

export interface ViewerPath {
  id: string;
  points: ViewerPoint3[];
  color?: string;
  highlighted?: boolean;
  arrow?: boolean;
}

export interface ViewerMarker {
  id: string;
  position: ViewerPoint3;
  color?: string;
  shape?: 'sphere' | 'box' | 'capsule' | 'cross';
  yawRad?: number | null;
}

export interface ViewerOverlayState {
  pins?: ViewerPin[];
  paths?: ViewerPath[];
  markers?: ViewerMarker[];
}

export type ViewerGroundHeightSampler = (x: number, z: number) => number | null;

const DEFAULT_PIN = '#f97316';
const DEFAULT_PATH = '#38bdf8';
const DEFAULT_MARKER = '#ef4444';

function material(color: string): MeshBasicMaterial {
  return new MeshBasicMaterial({ color: new Color(color), depthTest: true, toneMapped: false });
}

function disposeObject(root: Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const entry of materials) entry.dispose();
  });
}

function segmentBetween(
  from: Vector3,
  to: Vector3,
  radius: number,
  color: string,
): Mesh | null {
  const direction = to.clone().sub(from);
  const length = direction.length();
  if (length <= 1e-4) return null;
  const mesh = new Mesh(new CylinderGeometry(radius, radius, length, 8), material(color));
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.multiplyScalar(1 / length));
  return mesh;
}

/**
 * Small, renderer-agnostic scene layer for editor pins, paths, and diagnostics.
 * It deliberately uses unlit WebGL-compatible primitives: overlays remain
 * readable in every fidelity tier and never force the optional WebGPU path.
 */
export class ViewerOverlayLayer {
  readonly group = new Group();

  constructor(private readonly sampleGroundHeight: ViewerGroundHeightSampler) {
    this.group.name = 'viewer-overlays';
  }

  set(state: ViewerOverlayState): void {
    this.clear();
    for (const pin of state.pins ?? []) this.addPin(pin);
    for (const path of state.paths ?? []) this.addPath(path);
    for (const marker of state.markers ?? []) this.addMarker(marker);
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      disposeObject(child);
    }
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }

  private groundPoint(point: ViewerPoint3, lift = 0): Vector3 {
    const sampled = this.sampleGroundHeight(point.x, point.z);
    return new Vector3(point.x, (sampled ?? point.y) + lift, point.z);
  }

  private addPin(pin: ViewerPin): void {
    const root = new Group();
    root.name = `pin:${pin.id}`;
    const color = pin.highlighted ? '#facc15' : DEFAULT_PIN;
    const base = this.groundPoint(pin.position, 0.05);
    const height = pin.highlighted ? 4.2 : 3.4;
    const shaft = new Mesh(new CylinderGeometry(0.12, 0.12, height, 8), material(color));
    shaft.position.copy(base).add(new Vector3(0, height / 2, 0));
    const head = new Mesh(new SphereGeometry(pin.highlighted ? 0.62 : 0.48, 12, 8), material(color));
    head.position.copy(base).add(new Vector3(0, height, 0));
    root.add(shaft, head);
    this.group.add(root);
  }

  private addPath(path: ViewerPath): void {
    if (path.points.length < 2) return;
    const root = new Group();
    root.name = `path:${path.id}`;
    const color = path.color ?? DEFAULT_PATH;
    const radius = path.highlighted ? 0.22 : 0.14;
    const points = path.points.map((point) => this.groundPoint(point, radius + 0.04));
    for (let index = 1; index < points.length; index += 1) {
      const segment = segmentBetween(points[index - 1]!, points[index]!, radius, color);
      if (segment) root.add(segment);
    }
    if (path.arrow && points.length >= 2) {
      const tip = points.at(-1)!;
      const previous = points.at(-2)!;
      const direction = tip.clone().sub(previous);
      const length = direction.length();
      if (length > 1e-4) {
        const cone = new Mesh(new ConeGeometry(radius * 2.8, radius * 6, 10), material(color));
        cone.position.copy(tip);
        cone.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.multiplyScalar(1 / length));
        root.add(cone);
      }
    }
    this.group.add(root);
  }

  private addMarker(marker: ViewerMarker): void {
    const root = new Group();
    root.name = `marker:${marker.id}`;
    const color = marker.color ?? DEFAULT_MARKER;
    const shape = marker.shape ?? 'sphere';
    const position = this.groundPoint(marker.position, shape === 'sphere' ? 0.45 : 0.65);
    if (shape === 'cross') {
      const first = segmentBetween(
        position.clone().add(new Vector3(-0.7, 0, -0.7)),
        position.clone().add(new Vector3(0.7, 0, 0.7)),
        0.14,
        color,
      );
      const second = segmentBetween(
        position.clone().add(new Vector3(-0.7, 0, 0.7)),
        position.clone().add(new Vector3(0.7, 0, -0.7)),
        0.14,
        color,
      );
      if (first) root.add(first);
      if (second) root.add(second);
    } else {
      const geometry = shape === 'box'
        ? new BoxGeometry(1.8, 1.3, 3.8)
        : shape === 'capsule'
          ? new CapsuleGeometry(0.45, 1.2, 4, 8)
          : new SphereGeometry(0.45, 12, 8);
      const mesh = new Mesh(geometry, material(color));
      mesh.position.copy(position);
      if (marker.yawRad != null) mesh.rotation.y = marker.yawRad;
      root.add(mesh);
    }
    this.group.add(root);
  }
}
