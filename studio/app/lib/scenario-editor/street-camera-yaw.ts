import type { Sensor } from "@simforge/studio-shared";

export const STREET_CAMERA_YAW_BASIS_VERSION = "simforge.street-camera-yaw.v2";
export const STREET_CAMERA_CLOCKWISE_OFFSET_DEGREES = -90;

export function normalizeYawDegrees(value: number) {
  return ((value % 360) + 360) % 360;
}

export function rotateStreetCameraYawClockwise(yaw: number) {
  return normalizeYawDegrees(yaw + STREET_CAMERA_CLOCKWISE_OFFSET_DEGREES);
}

export function isWorldStreetCameraSensor(
  sensor: Pick<Sensor, "attachTo" | "label" | "mountLabel" | "sensorCategory">,
) {
  if (sensor.sensorCategory !== "camera" || sensor.attachTo !== "world") {
    return false;
  }
  const label = `${sensor.label ?? ""} ${sensor.mountLabel ?? ""}`.toLowerCase();
  return label.includes("street camera");
}

export function upgradeLegacyStreetCameraYaw(sensor: Sensor): Sensor {
  if (!isWorldStreetCameraSensor(sensor)) return sensor;
  return {
    ...sensor,
    pose: {
      ...sensor.pose,
      yaw: rotateStreetCameraYawClockwise(sensor.pose.yaw),
    },
  };
}

export function upgradeLegacyStreetCameraYaws(sensors: Sensor[]): Sensor[] {
  return sensors.map(upgradeLegacyStreetCameraYaw);
}
