import type { Matrix4, Scene, WebGLRenderer } from "three";
import { captureIdPass, decodeRgb24Ids, type IdLegend } from "./id-pass";
import type { RadarDetection } from "./csv";
import { createCubeFaceCameras, unprojectCubeDepth, type CubeFaceName, type DepthCube } from "./lidar-pass";

export type InstanceIdCube = Readonly<Record<CubeFaceName, Readonly<{
  width: number;
  height: number;
  ids: Uint32Array;
}>>>;

export type TraceVelocity = Readonly<{ x: number; y: number; z: number }>;

export function captureInstanceIdCube(input: Readonly<{
  renderer: WebGLRenderer;
  scene: Scene;
  sensorWorldMatrix: Matrix4;
  resolution: number;
  nearM: number;
  farM: number;
}>): Readonly<{ faces: InstanceIdCube; legend: IdLegend }> {
  if (!Number.isSafeInteger(input.resolution) || input.resolution <= 0) throw new Error("Cube resolution must be a positive integer.");
  const faces = {} as Record<CubeFaceName, InstanceIdCube[CubeFaceName]>;
  let legend: IdLegend | null = null;
  for (const { name, camera } of createCubeFaceCameras(input.sensorWorldMatrix, input.nearM, input.farM)) {
    const captured = captureIdPass({
      renderer: input.renderer,
      scene: input.scene,
      camera,
      width: input.resolution,
      height: input.resolution,
      nearM: input.nearM,
      farM: input.farM,
      mode: "instance",
    });
    legend ??= captured.legend;
    faces[name] = {
      width: input.resolution,
      height: input.resolution,
      ids: decodeRgb24Ids(captured.pixels),
    };
  }
  if (!legend) throw new Error("Instance cube did not render any faces.");
  return Object.freeze({ faces, legend });
}

/**
 * Sample radar detections from the depth/id cube. Velocity is authoritative
 * playback-trace velocity; positive values approach the sensor, matching CARLA.
 */
export function captureRadarFrame(input: Readonly<{
  faces: DepthCube;
  idFaces: InstanceIdCube;
  actorVelocityByInstanceId: Readonly<Record<number, TraceVelocity>>;
  sensorVelocity: TraceVelocity;
  horizontalFovDeg: number;
  verticalFovDeg: number;
  rangeM: number;
  pointsPerSecond: number;
  fps: number;
}>): RadarDetection[] {
  const scalars = [input.horizontalFovDeg, input.verticalFovDeg, input.rangeM, input.pointsPerSecond, input.fps];
  if (!scalars.every((value) => Number.isFinite(value) && value > 0) || !Number.isSafeInteger(input.pointsPerSecond)) {
    throw new Error("Radar FOV, range, and rates must be finite and positive.");
  }
  assertVelocity(input.sensorVelocity);
  const count = Math.max(1, Math.round(input.pointsPerSecond / input.fps));
  const aspect = input.horizontalFovDeg / input.verticalFovDeg;
  const columns = Math.max(1, Math.ceil(Math.sqrt(count * aspect)));
  const rows = Math.max(1, Math.ceil(count / columns));
  const horizontalFov = input.horizontalFovDeg * Math.PI / 180;
  const verticalFov = input.verticalFovDeg * Math.PI / 180;
  const detections: RadarDetection[] = [];
  for (let sample = 0; sample < count; sample += 1) {
    const column = sample % columns;
    const row = Math.floor(sample / columns);
    const azimuth = ((column + 0.5) / columns - 0.5) * horizontalFov;
    const altitude = (0.5 - (row + 0.5) / rows) * verticalFov;
    const cosAltitude = Math.cos(altitude);
    const direction = {
      x: cosAltitude * Math.cos(azimuth),
      y: cosAltitude * Math.sin(azimuth),
      z: Math.sin(altitude),
    };
    const hit = unprojectCubeDepth(input.faces, direction);
    if (!hit || hit.depthM > input.rangeM) continue;
    const idFace = input.idFaces[hit.face];
    if (idFace.width !== input.faces[hit.face].width || idFace.height !== input.faces[hit.face].height || idFace.ids.length !== idFace.width * idFace.height) {
      throw new Error(`Radar id face ${hit.face} does not match its depth face.`);
    }
    const actorVelocity = input.actorVelocityByInstanceId[idFace.ids[hit.pixelIndex] ?? 0] ?? ZERO_VELOCITY;
    assertVelocity(actorVelocity);
    const relativeX = actorVelocity.x - input.sensorVelocity.x;
    const relativeY = actorVelocity.y - input.sensorVelocity.y;
    const relativeZ = actorVelocity.z - input.sensorVelocity.z;
    detections.push({
      altitude,
      azimuth,
      depth: hit.depthM,
      velocity: -(relativeX * direction.x + relativeY * direction.y + relativeZ * direction.z),
    });
  }
  return detections;
}

const ZERO_VELOCITY: TraceVelocity = Object.freeze({ x: 0, y: 0, z: 0 });

function assertVelocity(value: TraceVelocity): void {
  if (![value.x, value.y, value.z].every(Number.isFinite)) throw new Error("Radar velocities must be finite trace values.");
}
