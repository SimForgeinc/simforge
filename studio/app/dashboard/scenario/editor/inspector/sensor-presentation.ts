import {
  instantiateSensorRig,
  matchSensorMountPreset,
  sensorAperture,
  SENSOR_MOUNT_PRESETS,
  type ActorSensor,
  type SensorMountPreset,
  type SensorRigActor,
  type SensorRigPreset,
} from "@simforge-oss/scenario";

/**
 * Presentation vocabulary for the sensor editor.
 *
 * The document stores radians, metres and a discriminated union; an author
 * thinks in "a wide camera on the roof pointing left". Everything here is the
 * translation between the two, kept out of the components so the arithmetic is
 * testable without rendering a panel.
 */

export const RAD_TO_DEG = 180 / Math.PI;
export const DEG_TO_RAD = Math.PI / 180;

export type SensorModality = ActorSensor["type"];

const MODALITY_LABELS: Readonly<Record<SensorModality, string>> = {
  dash_camera: "Camera",
  lidar: "LiDAR",
  radar: "Radar",
};

export function modalityLabel(type: SensorModality) {
  return MODALITY_LABELS[type];
}

/** The name shown for a sensor: the author's label, else its modality. */
export function sensorName(sensor: ActorSensor) {
  return sensor.label ?? modalityLabel(sensor.type);
}

export interface SensorCounts {
  readonly camera: number;
  readonly lidar: number;
  readonly radar: number;
  readonly total: number;
}

export function sensorCounts(
  sensors: readonly { type: SensorModality }[],
): SensorCounts {
  let camera = 0;
  let lidar = 0;
  let radar = 0;
  for (const sensor of sensors) {
    if (sensor.type === "dash_camera") camera += 1;
    else if (sensor.type === "lidar") lidar += 1;
    else radar += 1;
  }
  return { camera, lidar, radar, total: sensors.length };
}

/**
 * Counts as prose, omitting the modalities that are absent.
 *
 * The old panel always printed "1 camera · 0 LiDAR · 0 radar", which wrapped to
 * three lines in a 192px rail to say almost nothing.
 */
export function sensorCountSummary(counts: SensorCounts) {
  const parts: string[] = [];
  if (counts.camera) parts.push(`${counts.camera} camera${counts.camera === 1 ? "" : "s"}`);
  if (counts.lidar) parts.push(`${counts.lidar} LiDAR`);
  if (counts.radar) parts.push(`${counts.radar} radar`);
  return parts.join(" · ");
}

/**
 * Named directions, so aiming a sensor is a click rather than a radian.
 *
 * Yaw is a right-handed rotation about +Y in a frame whose +Z points left, so
 * a POSITIVE yaw turns the sensor toward the vehicle's right. The built-in
 * Tesla rig is the reference: its "Left Forward" camera is authored at -60°.
 */
export const SENSOR_AIM_PRESETS: readonly { id: string; label: string; yawDeg: number }[] = [
  { id: "forward", label: "Forward", yawDeg: 0 },
  { id: "forward-left", label: "Fwd left", yawDeg: -45 },
  { id: "left", label: "Left", yawDeg: -90 },
  { id: "rear-left", label: "Rear left", yawDeg: -135 },
  { id: "rear", label: "Rear", yawDeg: 180 },
  { id: "rear-right", label: "Rear right", yawDeg: 135 },
  { id: "right", label: "Right", yawDeg: 90 },
  { id: "forward-right", label: "Fwd right", yawDeg: 45 },
];

/** The aim chip that matches this yaw, within half a degree of rounding. */
export function matchAimPreset(yawRad: number) {
  const yawDeg = yawRad * RAD_TO_DEG;
  return SENSOR_AIM_PRESETS.find((preset) => {
    const delta = Math.abs(normalizeDeg(preset.yawDeg - yawDeg));
    return delta < 0.5;
  });
}

function normalizeDeg(deg: number) {
  const wrapped = ((deg + 180) % 360 + 360) % 360 - 180;
  return wrapped;
}

/**
 * Angular width presets per modality.
 *
 * A camera's useful range is a lens choice; an active sensor's is a beam
 * pattern, and only LiDAR meaningfully sweeps the full circle.
 */
export const CAMERA_FOV_PRESETS: readonly { label: string; horizontalFovDeg: number }[] = [
  { label: "Tele 30°", horizontalFovDeg: 30 },
  { label: "Narrow 50°", horizontalFovDeg: 50 },
  { label: "Normal 70°", horizontalFovDeg: 70 },
  { label: "Wide 90°", horizontalFovDeg: 90 },
  { label: "Ultra 120°", horizontalFovDeg: 120 },
];

export const ACTIVE_FOV_PRESETS: readonly { label: string; horizontalFovDeg: number }[] = [
  { label: "Beam 20°", horizontalFovDeg: 20 },
  { label: "Narrow 40°", horizontalFovDeg: 40 },
  { label: "Wide 120°", horizontalFovDeg: 120 },
  { label: "Surround 360°", horizontalFovDeg: 360 },
];

export function fovPresetsFor(type: SensorModality) {
  return type === "dash_camera" ? CAMERA_FOV_PRESETS : ACTIVE_FOV_PRESETS;
}

/** The mount chip that matches this sensor's position on this actor's box. */
export function mountPresetFor(
  sensor: ActorSensor,
  actor: SensorRigActor,
): SensorMountPreset | undefined {
  return matchSensorMountPreset(sensor.mount, actor);
}

export { SENSOR_MOUNT_PRESETS };

/**
 * Which built-in rig, if any, this actor is currently wearing.
 *
 * A rig is authoring-time only: applying one flattens it into plain sensors and
 * the preset identity is not stored. Recognising it back means the panel can
 * say "Tesla HW3" instead of "9 sensors", and can mark the applied card, so
 * comparison is by shape — modality order, mount and aperture — never by id,
 * which is minted fresh on every application.
 */
export function appliedRigPreset(
  sensors: readonly ActorSensor[],
  actor: SensorRigActor,
  presets: readonly SensorRigPreset[],
): SensorRigPreset | undefined {
  if (sensors.length === 0) return undefined;
  return presets.find((preset) => {
    if (preset.sensors.length !== sensors.length) return false;
    let instantiated: readonly ActorSensor[];
    try {
      instantiated = instantiateSensorRig(preset, actor);
    } catch {
      return false;
    }
    return instantiated.every((expected, index) => {
      const actual = sensors[index];
      return actual !== undefined && sameSensorShape(expected, actual);
    });
  });
}

function sameSensorShape(left: ActorSensor, right: ActorSensor) {
  if (left.type !== right.type) return false;
  if (!closeTo(left.mount.position.x, right.mount.position.x)) return false;
  if (!closeTo(left.mount.position.y, right.mount.position.y)) return false;
  if (!closeTo(left.mount.position.z, right.mount.position.z)) return false;
  if (!closeTo(left.mount.rotation.yawRad, right.mount.rotation.yawRad)) return false;
  if (!closeTo(left.mount.rotation.pitchRad, right.mount.rotation.pitchRad)) return false;
  const expected = sensorAperture(left);
  const actual = sensorAperture(right);
  return closeTo(expected.horizontalFovDeg, actual.horizontalFovDeg)
    && closeTo(expected.verticalFovDeg, actual.verticalFovDeg)
    && closeTo(expected.farM, actual.farM);
}

function closeTo(left: number, right: number) {
  return Math.abs(left - right) < 1e-3;
}

export function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/** Round to whole degrees for display without letting -0 reach the DOM. */
export function deg(radians: number) {
  const rounded = Math.round(radians * RAD_TO_DEG);
  return Object.is(rounded, -0) ? 0 : rounded;
}
