export type Point2 = {
  x: number;
  y: number;
};

export type Point3 = Point2 & {
  z?: number;
};

export type SensorPose = {
  x: number;
  y: number;
  z: number;
  roll: number;
  pitch: number;
  yaw: number;
};

export type RuntimePoint = Point3 & {
  readonly frame?: "runtime";
};

export type EditorLocalPoint = Point3 & {
  readonly frame?: "editor-local";
};

export type CarlaPoint = Point3 & {
  readonly frame?: "carla";
};

export type WorldSensorPose = SensorPose & {
  readonly frame?: "world-sensor-editor-local";
};

export type CarlaPose = SensorPose & {
  readonly frame?: "carla";
};

export function normalizeYawDegrees(value: number) {
  return ((value % 360) + 360) % 360;
}

function copyOptionalZ<T extends Point3>(point: T, y: number): Point3 {
  return point.z == null
    ? { x: point.x, y }
    : { x: point.x, y, z: point.z };
}

export function runtimePointToEditorLocalPoint(point: RuntimePoint): EditorLocalPoint {
  return copyOptionalZ(point, -point.y) as EditorLocalPoint;
}

export function editorLocalPointToRuntimePoint(point: EditorLocalPoint): RuntimePoint {
  return copyOptionalZ(point, -point.y) as RuntimePoint;
}

export function runtimePointToCarlaPoint(point: RuntimePoint): CarlaPoint {
  return copyOptionalZ(point, -point.y) as CarlaPoint;
}

export function carlaPointToRuntimePoint(point: CarlaPoint): RuntimePoint {
  return copyOptionalZ(point, -point.y) as RuntimePoint;
}

export function editorLocalPointToCarlaPoint(point: EditorLocalPoint): CarlaPoint {
  return copyOptionalZ(point, point.y) as CarlaPoint;
}

export function carlaPointToEditorLocalPoint(point: CarlaPoint): EditorLocalPoint {
  return copyOptionalZ(point, point.y) as EditorLocalPoint;
}

export function runtimeYawToCarlaYaw(yaw: number) {
  return normalizeYawDegrees(-yaw);
}

export function carlaYawToRuntimeYaw(yaw: number) {
  return normalizeYawDegrees(-yaw);
}

export function worldCameraVisualYawToCarlaYaw(yaw: number) {
  return normalizeYawDegrees(270 - yaw);
}

export function carlaYawToWorldCameraVisualYaw(yaw: number) {
  return normalizeYawDegrees(270 - yaw);
}

export function visualYawFromRuntimeVector(vector: Point2) {
  if (Math.hypot(vector.x, vector.y) <= 1e-9) return 0;
  return normalizeYawDegrees(Math.atan2(vector.y, vector.x) * (180 / Math.PI) + 270);
}

export function worldSensorVisualForwardVector(yaw: number) {
  const radians = normalizeYawDegrees(yaw) * (Math.PI / 180);
  return {
    x: -Math.sin(radians),
    y: -Math.cos(radians),
  };
}

export function carlaYawForwardVector(yaw: number) {
  const radians = normalizeYawDegrees(yaw) * (Math.PI / 180);
  return {
    x: Math.cos(radians),
    y: Math.sin(radians),
  };
}

export function worldSensorPoseToCarlaPose(pose: WorldSensorPose): CarlaPose {
  return {
    x: pose.x,
    y: pose.y,
    z: pose.z,
    roll: pose.roll,
    pitch: pose.pitch,
    yaw: worldCameraVisualYawToCarlaYaw(pose.yaw),
  } as CarlaPose;
}
