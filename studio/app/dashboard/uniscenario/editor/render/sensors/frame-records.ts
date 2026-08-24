import type { BrowserRenderPass } from "@simforge/scenario";
import { Matrix4 } from "three";
import { sensorFramePath } from "./zip";

export type CanonicalMatrix = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export type CameraCalibration = Readonly<{
  intrinsicMatrix: readonly [number, number, number, number, number, number, number, number, number];
  width: number;
  height: number;
  fov: number;
  clipNear: number;
  clipFar: number;
}>;

export type AuthoredSensorTransform = Readonly<{
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
  roll: number;
}>;

/** Browser equivalent of `CarlaBackend.sensor_manifest()` frame records. */
export type BrowserSensorFrameRecord = Readonly<{
  sensorId: string;
  kind: BrowserRenderPass["modality"];
  format: "png" | "ply" | "csv";
  outputFrameIndex: number;
  scheduledTimeS: number;
  relativePath: string;
  attachTo: string;
  attachment: "rigid";
  transform: AuthoredSensorTransform;
  relativeMatrix: CanonicalMatrix;
  canonicalWorldMatrix: CanonicalMatrix;
  attributes: Readonly<Record<string, number | boolean>>;
  calibration?: CameraCalibration;
}>;

export function buildSensorFrameRecord(input: Readonly<{
  pass: BrowserRenderPass;
  outputFrameIndex: number;
  scheduledTimeS: number;
  canonicalWorldMatrix: Matrix4 | CanonicalMatrix;
}>): BrowserSensorFrameRecord {
  if (!Number.isSafeInteger(input.outputFrameIndex) || input.outputFrameIndex < 0) throw new Error("Frame index must be a non-negative integer.");
  if (!Number.isFinite(input.scheduledTimeS) || input.scheduledTimeS < 0) throw new Error("Scheduled time must be finite and non-negative.");
  const format: BrowserSensorFrameRecord["format"] =
    input.pass.modality === "lidar" ? "ply" : input.pass.modality === "radar" ? "csv" : "png";
  const base = {
    sensorId: input.pass.sensorId,
    kind: input.pass.modality,
    format,
    outputFrameIndex: input.outputFrameIndex,
    scheduledTimeS: input.scheduledTimeS,
    relativePath: sensorFramePath(input.pass.sensorId, input.outputFrameIndex, format),
    attachTo: input.pass.actorId,
    attachment: "rigid" as const,
    transform: Object.freeze({
      x: input.pass.transform.position.x,
      y: input.pass.transform.position.y,
      z: input.pass.transform.position.z,
      pitch: input.pass.transform.rotation.pitchRad,
      yaw: input.pass.transform.rotation.yawRad,
      roll: input.pass.transform.rotation.rollRad,
    }),
    relativeMatrix: canonicalRelativeMatrix(input.pass.transform),
    canonicalWorldMatrix: canonicalMatrix(input.canonicalWorldMatrix),
    attributes: Object.freeze(passAttributes(input.pass)),
  };
  const calibration = cameraCalibration(input.pass);
  return Object.freeze(calibration ? { ...base, calibration } : base);
}

function passAttributes(pass: BrowserRenderPass): Record<string, number | boolean> {
  switch (pass.modality) {
    case "rgb":
    case "depth":
    case "semantic":
    case "instance":
      return {
        width: pass.width,
        height: pass.height,
        fov: degreesToRadians(pass.horizontalFovDeg),
        clipNear: pass.nearM,
        clipFar: pass.farM,
        enablePostprocessEffects: pass.modality === "rgb",
      };
    case "lidar":
      return {
        channels: pass.channels,
        range: pass.rangeM,
        pointsPerSecond: pass.pointsPerSecond,
        rotationFrequency: pass.rotationFrequencyHz,
        upperFov: degreesToRadians(pass.upperFovDeg),
        lowerFov: degreesToRadians(pass.lowerFovDeg),
      };
    case "radar":
      return {
        horizontalFov: degreesToRadians(pass.horizontalFovDeg),
        verticalFov: degreesToRadians(pass.verticalFovDeg),
        range: pass.rangeM,
        pointsPerSecond: pass.pointsPerSecond,
      };
  }
}

function cameraCalibration(pass: BrowserRenderPass): CameraCalibration | null {
  if (pass.modality === "lidar" || pass.modality === "radar") return null;
  const fov = degreesToRadians(pass.horizontalFovDeg);
  const focal = pass.width / (2 * Math.tan(fov / 2));
  return Object.freeze({
    intrinsicMatrix: Object.freeze([
      focal, 0, pass.width / 2,
      0, focal, pass.height / 2,
      0, 0, 1,
    ]) as CameraCalibration["intrinsicMatrix"],
    width: pass.width,
    height: pass.height,
    fov,
    clipNear: pass.nearM,
    clipFar: pass.farM,
  });
}

function canonicalRelativeMatrix(transform: BrowserRenderPass["transform"]): CanonicalMatrix {
  const { pitchRad: pitch, yawRad: yaw, rollRad: roll } = transform.rotation;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  return Object.freeze([
    cy * cp,
    -cy * sp * cr + sy * sr,
    cy * sp * sr + sy * cr,
    transform.position.x,
    sp,
    cp * cr,
    -cp * sr,
    transform.position.y,
    -sy * cp,
    sy * sp * cr + cy * sr,
    -sy * sp * sr + cy * cr,
    transform.position.z,
    0, 0, 0, 1,
  ]) as CanonicalMatrix;
}

function canonicalMatrix(value: Matrix4 | CanonicalMatrix): CanonicalMatrix {
  const values = value instanceof Matrix4
    ? value.clone().transpose().toArray()
    : [...value];
  if (values.length !== 16 || values.some((item) => !Number.isFinite(item))) throw new Error("Canonical transforms must contain 16 finite values.");
  return Object.freeze(values) as unknown as CanonicalMatrix;
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}
