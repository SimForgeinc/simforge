import {
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Vector3,
  type Scene,
  type WebGLRenderer,
} from "three";
import { captureLinearDepthMeters } from "./depth-pass";
import type { LidarPoint } from "./ply";

export type CubeFaceName = "px" | "nx" | "py" | "ny" | "pz" | "nz";
export type DepthCubeFace = Readonly<{ width: number; height: number; depthM: Float32Array }>;
export type DepthCube = Readonly<Record<CubeFaceName, DepthCubeFace>>;

const FACE_ORDER: readonly CubeFaceName[] = ["px", "nx", "py", "ny", "pz", "nz"];
const FACE_ORIENTATION: Readonly<Record<CubeFaceName, readonly [Vector3, Vector3]>> = {
  px: [new Vector3(1, 0, 0), new Vector3(0, 0, 1)],
  nx: [new Vector3(-1, 0, 0), new Vector3(0, 0, 1)],
  py: [new Vector3(0, 1, 0), new Vector3(0, 0, 1)],
  ny: [new Vector3(0, -1, 0), new Vector3(0, 0, 1)],
  pz: [new Vector3(0, 0, 1), new Vector3(1, 0, 0)],
  nz: [new Vector3(0, 0, -1), new Vector3(-1, 0, 0)],
};

export function captureDepthCube(input: Readonly<{
  renderer: WebGLRenderer;
  scene: Scene;
  sensorWorldMatrix: Matrix4;
  resolution: number;
  nearM: number;
  farM: number;
}>): DepthCube {
  if (!Number.isSafeInteger(input.resolution) || input.resolution <= 0) throw new Error("Cube resolution must be a positive integer.");
  const faces = {} as Record<CubeFaceName, DepthCubeFace>;
  for (const { name, camera } of createCubeFaceCameras(input.sensorWorldMatrix, input.nearM, input.farM)) {
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
      }),
    };
  }
  return faces;
}

export function createCubeFaceCameras(
  sensorWorldMatrix: Matrix4,
  nearM: number,
  farM: number,
): readonly Readonly<{ name: CubeFaceName; camera: PerspectiveCamera }>[] {
  if (!(nearM > 0) || !(farM > nearM)) throw new Error("Cube clipping planes are invalid.");
  const position = new Vector3();
  const orientation = new Quaternion();
  sensorWorldMatrix.decompose(position, orientation, new Vector3());
  return FACE_ORDER.map((name) => {
    const [localDirection, localUp] = FACE_ORIENTATION[name];
    const direction = localDirection.clone().applyQuaternion(orientation);
    const camera = new PerspectiveCamera(90, 1, nearM, farM);
    camera.position.copy(position);
    camera.up.copy(localUp).applyQuaternion(orientation);
    camera.lookAt(position.clone().add(direction));
    camera.updateMatrixWorld(true);
    return Object.freeze({ name, camera });
  });
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
  if (!Number.isSafeInteger(input.channels) || input.channels <= 0) throw new Error("Lidar channels must be positive.");
  const scalars = [input.rangeM, input.pointsPerSecond, input.rotationFrequencyHz, input.fps];
  if (!Number.isSafeInteger(input.pointsPerSecond) || !scalars.every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Lidar rates and range must be finite and positive.");
  }
  if (!Number.isSafeInteger(input.outputFrameIndex) || input.outputFrameIndex < 0) throw new Error("Lidar frame index must be non-negative.");
  if (!Number.isFinite(input.lowerFovDeg) || !Number.isFinite(input.upperFovDeg) || input.upperFovDeg < input.lowerFovDeg) {
    throw new Error("Lidar vertical FOV is invalid.");
  }
  const count = Math.max(1, Math.round(input.pointsPerSecond / input.fps));
  const azimuthSteps = Math.ceil(count / input.channels);
  const startAzimuth = input.outputFrameIndex * 2 * Math.PI * input.rotationFrequencyHz / input.fps;
  const sweep = 2 * Math.PI * Math.min(1, input.rotationFrequencyHz / input.fps);
  const points: LidarPoint[] = [];
  for (let sample = 0; sample < count; sample += 1) {
    const channel = sample % input.channels;
    const altitudeDeg = input.channels === 1
      ? (input.lowerFovDeg + input.upperFovDeg) / 2
      : input.lowerFovDeg + channel * (input.upperFovDeg - input.lowerFovDeg) / (input.channels - 1);
    const altitude = altitudeDeg * Math.PI / 180;
    const azimuth = startAzimuth + sweep * (Math.floor(sample / input.channels) + 0.5) / azimuthSteps;
    const cosAltitude = Math.cos(altitude);
    const direction = {
      x: cosAltitude * Math.cos(azimuth),
      y: cosAltitude * Math.sin(azimuth),
      z: Math.sin(altitude),
    };
    const hit = unprojectCubeDepth(input.faces, direction);
    if (!hit || hit.depthM > input.rangeM) continue;
    // Internal rays are (forward,left,up); PLY follows the bridge's canonical
    // (forward,up,left) column basis.
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

/** Convert a cube-face camera-space depth sample into radial ray depth. */
export function unprojectCubeDepth(
  faces: DepthCube,
  direction: Readonly<{ x: number; y: number; z: number }>,
): CubeDepthHit | null {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 0) || !Number.isFinite(length)) throw new Error("Ray direction must be finite and non-zero.");
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
    major = ax;
    face = x >= 0 ? "px" : "nx";
    u = x >= 0 ? -y / ax : y / ax;
    v = z / ax;
  } else if (ay >= az) {
    major = ay;
    face = y >= 0 ? "py" : "ny";
    u = y >= 0 ? x / ay : -x / ay;
    v = z / ay;
  } else {
    major = az;
    face = z >= 0 ? "pz" : "nz";
    u = -y / az;
    v = z >= 0 ? -x / az : x / az;
  }
  const image = faces[face];
  if (image.depthM.length !== image.width * image.height) throw new Error(`Cube face ${face} dimensions are invalid.`);
  const column = Math.min(image.width - 1, Math.max(0, Math.floor((u * 0.5 + 0.5) * image.width)));
  const row = Math.min(image.height - 1, Math.max(0, Math.floor((0.5 - v * 0.5) * image.height)));
  const pixelIndex = row * image.width + column;
  const cameraDepth = image.depthM[pixelIndex] ?? Number.POSITIVE_INFINITY;
  const depthM = cameraDepth / major;
  return Number.isFinite(depthM) && depthM >= 0 ? { face, pixelIndex, depthM } : null;
}
