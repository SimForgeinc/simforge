import {
  BUILT_IN_SENSOR_RIGS,
  SensorRigCameraTemplateSchema,
  SensorRigLidarTemplateSchema,
  SensorRigPresetSchema,
  SensorRigRadarTemplateSchema,
  type SensorRigMount,
  type SensorRigPreset,
} from "@uniscenarios/scenario-model";

const MM_TO_M = 1 / 1_000;
const DEG_TO_RAD = Math.PI / 180;
const CAMERA_ASPECT_RATIO = 16 / 9;

/** Convert Pronto's millimetre vehicle frame into the canonical sensor frame. */
function prontoMount(
  longitudinalMm: number,
  lateralRightMm: number,
  upMm: number,
  yawDeg = 0,
  pitchDeg = 0,
  rollDeg = 0,
): SensorRigMount {
  return {
    position: {
      x: longitudinalMm * MM_TO_M,
      y: upMm * MM_TO_M,
      z: -lateralRightMm * MM_TO_M,
    },
    rotation: {
      yawRad: yawDeg * DEG_TO_RAD,
      pitchRad: pitchDeg * DEG_TO_RAD,
      rollRad: rollDeg * DEG_TO_RAD,
    },
  };
}

function verticalCameraFov(horizontalFovDeg: number): number {
  const halfHorizontal = horizontalFovDeg * Math.PI / 360;
  return 2 * Math.atan(Math.tan(halfHorizontal) / CAMERA_ASPECT_RATIO) / DEG_TO_RAD;
}

function camera(
  id: string,
  label: string,
  fov: number,
  mount: SensorRigMount,
) {
  return SensorRigCameraTemplateSchema.parse({
    id,
    type: "dash_camera",
    label,
    enabled: true,
    mount,
    camera: {
      horizontalFovDeg: fov,
      verticalFovDeg: verticalCameraFov(fov),
      nearM: 0.05,
      farM: 1_000,
      aspectRatio: CAMERA_ASPECT_RATIO,
    },
  });
}

function lidar(
  id: string,
  label: string,
  horizontalFovDeg: number,
  verticalFovDeg: number,
  mount: SensorRigMount,
) {
  return SensorRigLidarTemplateSchema.parse({
    id,
    type: "lidar",
    label,
    enabled: true,
    mount,
    field: {
      horizontalFovDeg,
      verticalFovDeg,
      nearM: 0.5,
      farM: 200,
    },
  });
}

function radar(id: string, label: string, mount: SensorRigMount) {
  return SensorRigRadarTemplateSchema.parse({
    id,
    type: "radar",
    label,
    enabled: true,
    mount,
    field: {
      horizontalFovDeg: 30,
      verticalFovDeg: 30,
      nearM: 0.5,
      farM: 100,
    },
  });
}

/** Pronto sensor suite, port configuration E. */
export const PRONTO_SENSOR_RIG: SensorRigPreset = SensorRigPresetSchema.parse({
  id: "pronto-port-e",
  name: "Pronto Rig",
  description: "Port configuration E · 8 cameras · 6 LiDAR · 4 radar",
  compatibleActorClasses: ["car"],
  sensors: [
    camera("pronto-cam0", "CAM0 — Front Driver", 120, prontoMount(-150.9, -795.8, 51.7, 122, 25)),
    camera("pronto-cam1", "CAM1 — Front Center", 120, prontoMount(-150.8, 0, 51.7, 0, 10)),
    camera("pronto-cam2", "CAM2 — Rear Driver", 120, prontoMount(-2460.3, -795.8, 51.7, 60, 25)),
    camera("pronto-cam3", "CAM3 — Front Driver Falcon", 30, prontoMount(-48.4, -595.3, 72.7)),
    camera("pronto-cam4", "CAM4 — Rear Passenger", 120, prontoMount(-2460.3, 795.8, 51.7, -60, 25)),
    camera("pronto-cam5", "CAM5 — Rear Center", 120, prontoMount(-2460.3, 0, 51.7, 180, 10)),
    camera("pronto-cam6", "CAM6 — Front Passenger", 120, prontoMount(-150.8, 798.5, 51.7, -122, 25)),
    camera("pronto-cam7", "CAM7 — Front Passenger Falcon", 60, prontoMount(-61.6, 592.7, 72.7, 0, 5)),
    lidar("pronto-lidar-front-left", "Front left — Seyond Falcon", 120, 25, prontoMount(-115.9, -477.2, 127.8)),
    lidar("pronto-lidar-front-left-wide", "Front left wide — Seyond Robin W", 120, 70, prontoMount(-134.3, -767.1, 78.6, 120)),
    lidar("pronto-lidar-front-right", "Front right — Seyond Falcon", 120, 25, prontoMount(-115.9, 479.8, 127.8)),
    lidar("pronto-lidar-front-right-wide", "Front right wide — Seyond Robin W", 120, 70, prontoMount(-134.2, 769.8, 78.6, -120)),
    lidar("pronto-lidar-rear-left", "Rear left — Seyond Robin W", 120, 70, prontoMount(-2476.9, -767.1, 78.6, 60)),
    lidar("pronto-lidar-rear-right", "Rear right — Seyond Robin W", 120, 70, prontoMount(-2476.9, 767.1, 78.6, -60)),
    radar("pronto-rad-01", "RAD-01 — Altos V4", prontoMount(-59.3, -487.1, 74.8)),
    radar("pronto-rad-02", "RAD-02 — Altos V4", prontoMount(-59.3, 469.9, 74.8)),
    radar("pronto-rad-03", "RAD-03 — Altos RF6", prontoMount(-2587.1, -461, 31.5, 160)),
    radar("pronto-rad-04", "RAD-04 — Altos RF6", prontoMount(-2537.4, 514.2, 31.5, -160)),
  ],
});

export const EDITOR_SENSOR_RIGS: readonly SensorRigPreset[] = Object.freeze([
  ...BUILT_IN_SENSOR_RIGS,
  PRONTO_SENSOR_RIG,
]);
