import {
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Vector3,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { captureLinearDepthMeters } from './depth-pass.js';
import type { LidarPoint } from './ply.js';
import type { RenderResourcePool } from './render-targets.js';

export type CubeFaceName = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';
export type DepthCubeFace = Readonly<{ width: number; height: number; depthM: Float32Array }>;
export type DepthCube = Readonly<Partial<Record<CubeFaceName, DepthCubeFace>>>;

const FACE_ORDER: readonly CubeFaceName[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const FACE_ORIENTATION: Readonly<Record<CubeFaceName, readonly [Vector3, Vector3]>> = {
  px: [new Vector3(1, 0, 0), new Vector3(0, 0, 1)],
  nx: [new Vector3(-1, 0, 0), new Vector3(0, 0, 1)],
  py: [new Vector3(0, 1, 0), new Vector3(0, 0, 1)],
  ny: [new Vector3(0, -1, 0), new Vector3(0, 0, 1)],
  pz: [new Vector3(0, 0, 1), new Vector3(1, 0, 0)],
  nz: [new Vector3(0, 0, -1), new Vector3(-1, 0, 0)],
};
const DEG = Math.PI / 180;

/** Reused cameras and decomposition scratch for every active-sensor scene pass. */
export class CubeCameraPool {
  private readonly cameras = Object.fromEntries(FACE_ORDER.map((face) => [face, new PerspectiveCamera(90, 1)])) as Record<CubeFaceName, PerspectiveCamera>;
  private readonly position = new Vector3();
  private readonly orientation = new Quaternion();
  private readonly scale = new Vector3();
  private readonly target = new Vector3();

  configure(world: Matrix4, nearM: number, farM: number, faces: readonly CubeFaceName[]): readonly Readonly<{ name: CubeFaceName; camera: PerspectiveCamera }>[] {
    if (!(nearM > 0) || !(farM > nearM)) throw new Error('Cube clipping planes are invalid.');
    world.decompose(this.position, this.orientation, this.scale);
    return faces.map((name) => {
      const [localDirection, localUp] = FACE_ORIENTATION[name];
      const camera = this.cameras[name];
      camera.near = nearM;
      camera.far = farM;
      camera.position.copy(this.position);
      camera.up.copy(localUp).applyQuaternion(this.orientation);
      this.target.copy(localDirection).applyQuaternion(this.orientation).add(this.position);
      camera.lookAt(this.target);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      return { name, camera };
    });
  }
}

/**
 * Conservatively identify the only cube faces an angular aperture can address.
 * Endpoints plus cube-boundary critical angles make this exact without rendering
 * the other faces. A full-azimuth automotive LiDAR normally uses four side faces,
 * adding top/bottom only when its vertical aperture crosses a 45-degree boundary.
 */
export function cubeFacesForAperture(horizontalFovDeg: number, lowerFovDeg: number, upperFovDeg: number, centreAzimuthDeg = 0): readonly CubeFaceName[] {
  if (!(horizontalFovDeg > 0 && horizontalFovDeg <= 360)) throw new Error('Horizontal FOV must be in (0, 360].');
  if (!(lowerFovDeg >= -90 && upperFovDeg <= 90 && lowerFovDeg <= upperFovDeg)) throw new Error('Vertical FOV is invalid.');
  const half = horizontalFovDeg / 2;
  const azimuths = criticalAngles(centreAzimuthDeg - half, centreAzimuthDeg + half, 45);
  const elevations = criticalAngles(lowerFovDeg, upperFovDeg, 45);
  const selected = new Set<CubeFaceName>();
  for (const azimuthDeg of azimuths) {
    for (const elevationDeg of elevations) {
      const azimuth = azimuthDeg * DEG;
      const elevation = elevationDeg * DEG;
      selected.add(faceForDirection(
        Math.cos(elevation) * Math.cos(azimuth),
        Math.cos(elevation) * Math.sin(azimuth),
        Math.sin(elevation),
      ));
    }
  }
  return FACE_ORDER.filter((face) => selected.has(face));
}

function criticalAngles(start: number, end: number, spacing: number): number[] {
  const values = new Set<number>([start, end, Math.max(start, Math.min(end, 0))]);
  for (let value = Math.ceil(start / spacing) * spacing; value <= end; value += spacing) values.add(value);
  // Offset criticals cover azimuth dominance changes at 45 + 90n.
  for (let value = Math.ceil((start - spacing) / (spacing * 2)) * spacing * 2 + spacing; value <= end; value += spacing * 2) values.add(value);
  return [...values].filter((value) => value >= start && value <= end);
}

function faceForDirection(x: number, y: number, z: number): CubeFaceName {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  if (ax >= ay && ax >= az) return x >= 0 ? 'px' : 'nx';
  if (ay >= az) return y >= 0 ? 'py' : 'ny';
  return z >= 0 ? 'pz' : 'nz';
}

export function captureDepthCube(input: Readonly<{
  renderer: WebGLRenderer;
  scene: Scene;
  sensorWorldMatrix: Matrix4;
  resolution: number;
  nearM: number;
  farM: number;
  faces: readonly CubeFaceName[];
  cameraPool: CubeCameraPool;
  renderResourcePool: RenderResourcePool;
  resourceKey: string;
  onTiming?: (stage: 'scenePass' | 'readback', milliseconds: number) => void;
}>): DepthCube {
  if (!Number.isSafeInteger(input.resolution) || input.resolution <= 0) throw new Error('Cube resolution must be a positive integer.');
  const faces: Partial<Record<CubeFaceName, DepthCubeFace>> = {};
  for (const { name, camera } of input.cameraPool.configure(input.sensorWorldMatrix, input.nearM, input.farM, input.faces)) {
    faces[name] = {
      width: input.resolution,
      height: input.resolution,
      depthM: captureLinearDepthMeters({
        renderer: input.renderer,
        scene: input.scene,
        camera,
        width: input.resolution,
        height: input.resolution,
        nearM: input.nearM,
        farM: input.farM,
        resourcePool: input.renderResourcePool,
        resourceKey: `${input.resourceKey}:${name}`,
        onTiming: input.onTiming,
      }),
    };
  }
  return faces;
}

export function captureLidarFrame(input: Readonly<{
  faces: DepthCube;
  channels: number;
  rangeM: number;
  pointsPerSecond: number;
  rotationFrequencyHz: number;
  upperFovDeg: number;
  lowerFovDeg: number;
  fps: number;
  outputFrameIndex: number;
}>): LidarPoint[] {
  if (!Number.isSafeInteger(input.channels) || input.channels <= 0) throw new Error('Lidar channels must be positive.');
  if (!Number.isSafeInteger(input.pointsPerSecond) || ![input.rangeM, input.pointsPerSecond, input.rotationFrequencyHz, input.fps].every((value) => Number.isFinite(value) && value > 0)) throw new Error('Lidar rates and range must be finite and positive.');
  if (!Number.isSafeInteger(input.outputFrameIndex) || input.outputFrameIndex < 0) throw new Error('Lidar frame index must be non-negative.');
  if (!Number.isFinite(input.lowerFovDeg) || !Number.isFinite(input.upperFovDeg) || input.upperFovDeg < input.lowerFovDeg) throw new Error('Lidar vertical FOV is invalid.');
  const count = Math.max(1, Math.round(input.pointsPerSecond / input.fps));
  const azimuthSteps = Math.ceil(count / input.channels);
  const startAzimuth = input.outputFrameIndex * 2 * Math.PI * input.rotationFrequencyHz / input.fps;
  const sweep = 2 * Math.PI * Math.min(1, input.rotationFrequencyHz / input.fps);
  const points: LidarPoint[] = [];
  for (let sample = 0; sample < count; sample += 1) {
    const channel = sample % input.channels;
    const altitude = (input.channels === 1
      ? (input.lowerFovDeg + input.upperFovDeg) / 2
      : input.lowerFovDeg + channel * (input.upperFovDeg - input.lowerFovDeg) / (input.channels - 1)) * DEG;
    const azimuth = startAzimuth + sweep * (Math.floor(sample / input.channels) + 0.5) / azimuthSteps;
    const cosAltitude = Math.cos(altitude);
    const direction = { x: cosAltitude * Math.cos(azimuth), y: cosAltitude * Math.sin(azimuth), z: Math.sin(altitude) };
    const hit = unprojectCubeDepth(input.faces, direction);
    if (!hit || hit.depthM > input.rangeM) continue;
    points.push({
      x: direction.x * hit.depthM,
      y: direction.z * hit.depthM,
      z: direction.y * hit.depthM,
      intensity: Math.max(0, Math.min(1, 1 - hit.depthM / input.rangeM)),
    });
  }
  return points;
}

export type CubeDepthHit = Readonly<{ face: CubeFaceName; pixelIndex: number; depthM: number }>;

export function unprojectCubeDepth(faces: DepthCube, direction: Readonly<{ x: number; y: number; z: number }>): CubeDepthHit | null {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 0) || !Number.isFinite(length)) throw new Error('Ray direction must be finite and non-zero.');
  const x = direction.x / length;
  const y = direction.y / length;
  const z = direction.z / length;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  let face: CubeFaceName;
  let u: number;
  let v: number;
  let major: number;
  if (ax >= ay && ax >= az) {
    major = ax; face = x >= 0 ? 'px' : 'nx'; u = x >= 0 ? -y / ax : y / ax; v = z / ax;
  } else if (ay >= az) {
    major = ay; face = y >= 0 ? 'py' : 'ny'; u = y >= 0 ? x / ay : -x / ay; v = z / ay;
  } else {
    major = az; face = z >= 0 ? 'pz' : 'nz'; u = -y / az; v = z >= 0 ? -x / az : x / az;
  }
  const image = faces[face];
  if (!image) return null;
  if (image.depthM.length !== image.width * image.height) throw new Error(`Cube face ${face} dimensions are invalid.`);
  const column = Math.min(image.width - 1, Math.max(0, Math.floor((u * 0.5 + 0.5) * image.width)));
  const row = Math.min(image.height - 1, Math.max(0, Math.floor((0.5 - v * 0.5) * image.height)));
  const pixelIndex = row * image.width + column;
  const cameraDepth = image.depthM[pixelIndex] ?? Number.POSITIVE_INFINITY;
  const depthM = cameraDepth / major;
  return Number.isFinite(depthM) && depthM >= 0 ? { face, pixelIndex, depthM } : null;
}
