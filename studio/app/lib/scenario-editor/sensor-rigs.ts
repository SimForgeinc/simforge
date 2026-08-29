import {
  type Sensor,
} from "@simforge-oss/scenario/contracts";

export type SensorRig = {
  id: string;
  name: string;
  sensors: Sensor[];
  isBuiltIn: boolean;
};

function cam(
  id: string,
  label: string,
  pose: { x: number; y: number; z: number; pitch?: number; yaw?: number },
  opts: {
    fov?: number;
    width?: number;
    height?: number;
    attachment?: Sensor["attachmentType"];
    modality?: Sensor["outputModality"];
    mountId?: string;
    mountLabel?: string;
    mountRole?: Sensor["mountRole"];
    supportedOutputModalities?: Sensor["supportedOutputModalities"];
  } = {},
): Sensor {
  return {
    id,
    label,
    sensorCategory: "camera",
    outputModality: opts.modality ?? "rgb",
    mountId: opts.mountId,
    mountLabel: opts.mountLabel ?? label,
    mountRole: opts.mountRole,
    supportedOutputModalities: opts.supportedOutputModalities,
    attachTo: "subject",
    attachmentType: opts.attachment ?? "rigid",
    pose: {
      x: pose.x,
      y: pose.y,
      z: pose.z,
      roll: 0,
      pitch: pose.pitch ?? 0,
      yaw: pose.yaw ?? 0,
    },
    updateRate: 30,
    width: opts.width ?? 854,
    height: opts.height ?? 480,
    fov: opts.fov ?? 90,
  };
}

function lidar(
  id: string,
  label: string,
  pose: { x: number; y: number; z: number; yaw?: number },
  opts: {
    channels?: number;
    range?: number;
    pointsPerSecond?: number;
    rotationFrequency?: number;
    upperFov?: number;
    horizontalFov?: number;
    lowerFov?: number;
    updateRate?: number;
  } = {},
): Sensor {
  return {
    id,
    label,
    sensorCategory: "lidar",
    outputModality: "point_cloud",
    attachTo: "subject",
    attachmentType: "rigid",
    pose: { x: pose.x, y: pose.y, z: pose.z, roll: 0, pitch: 0, yaw: pose.yaw ?? 0 },
    updateRate: opts.updateRate ?? 20,
    channels: opts.channels ?? 64,
    range: opts.range ?? 100,
    pointsPerSecond: opts.pointsPerSecond ?? 1_200_000,
    rotationFrequency: opts.rotationFrequency ?? 20,
    horizontalFov: opts.horizontalFov,
    upperFov: opts.upperFov,
    lowerFov: opts.lowerFov,
  };
}

function radar(
  id: string,
  label: string,
  pose: { x: number; y: number; z: number; yaw?: number },
): Sensor {
  return {
    id,
    label,
    sensorCategory: "radar",
    outputModality: "radar_data",
    attachTo: "subject",
    attachmentType: "rigid",
    pose: { x: pose.x, y: pose.y, z: pose.z, roll: 0, pitch: 0, yaw: pose.yaw ?? 0 },
    updateRate: 20,
    horizontalFov: 30,
    verticalFov: 30,
    radarRange: 100,
  };
}

export const PRESET_BASIC_DASHCAM: SensorRig = {
  id: "preset-basic-dashcam",
  name: "Basic Dash Cam",
  isBuiltIn: true,
  sensors: [cam("dashcam-front", "Front Camera", { x: 1.6, y: 0, z: 1.7 })],
};

export const TRAILING_CAMERA_SENSOR = cam(
  "trailing-camera",
  "Trailing",
  { x: -5.5, y: 0, z: 2.8, pitch: 15 },
  {
    attachment: "spring_arm_ghost",
    mountId: "preview_trailing",
    mountRole: "preview",
    supportedOutputModalities: ["rgb"],
  },
);

export const PRESET_TESLA_HW3: SensorRig = {
  id: "preset-tesla-hw3",
  name: "Tesla Autopilot HW3",
  isBuiltIn: true,
  sensors: [
    TRAILING_CAMERA_SENSOR,
    cam("tesla-front-narrow", "Front Narrow", { x: 1.6, y: 0, z: 1.7 }, { fov: 35 }),
    cam("tesla-front-main", "Front Main", { x: 1.6, y: 0, z: 1.7 }, { fov: 50 }),
    cam("tesla-front-wide", "Front Wide", { x: 1.6, y: 0, z: 1.7 }, { fov: 120 }),
    cam("tesla-left-fwd", "Left Forward", { x: 0.9, y: -1, z: 1.3, yaw: -60 }, { fov: 80 }),
    cam("tesla-left-rear", "Left Rear", { x: -0.5, y: -1, z: 1.3, yaw: -120 }, { fov: 80 }),
    cam("tesla-right-fwd", "Right Forward", { x: 0.9, y: 1, z: 1.3, yaw: 60 }, { fov: 80 }),
    cam("tesla-right-rear", "Right Rear", { x: -0.5, y: 1, z: 1.3, yaw: 120 }, { fov: 80 }),
    cam("tesla-rear", "Rear", { x: -2, y: 0, z: 1.5, yaw: 180 }, { fov: 50 }),
    radar("tesla-radar-fwd", "Forward Radar", { x: 2, y: 0, z: 0.5 }),
  ],
};

export const PRESET_WAYMO_5TH_GEN: SensorRig = {
  id: "preset-waymo-5th-gen",
  name: "Waymo 5th Gen (Simplified)",
  isBuiltIn: true,
  sensors: [
    TRAILING_CAMERA_SENSOR,
    cam("waymo-front", "Front", { x: 1.5, y: 0, z: 2 }, { fov: 50, width: 1920, height: 1280 }),
    cam("waymo-front-left", "Front Left", { x: 1.2, y: -0.8, z: 2, yaw: -45 }, { fov: 70 }),
    cam("waymo-front-right", "Front Right", { x: 1.2, y: 0.8, z: 2, yaw: 45 }, { fov: 70 }),
    cam("waymo-left", "Left", { x: 0, y: -1, z: 2, yaw: -90 }, { fov: 70 }),
    cam("waymo-right", "Right", { x: 0, y: 1, z: 2, yaw: 90 }, { fov: 70 }),
    lidar("waymo-lidar-top", "Top LiDAR", { x: 0, y: 0, z: 2.5 }, { channels: 64, range: 75 }),
    lidar("waymo-lidar-front", "Front LiDAR", { x: 2, y: 0, z: 0.8 }, { channels: 32, range: 50 }),
    lidar("waymo-lidar-left", "Left LiDAR", { x: 0, y: -1, z: 1 }, { channels: 32, range: 50 }),
    lidar("waymo-lidar-right", "Right LiDAR", { x: 0, y: 1, z: 1 }, { channels: 32, range: 50 }),
  ],
};

export const PRESET_TRAILING_CAMERA: SensorRig = {
  id: "preset-trailing-camera",
  name: "Trailing Camera",
  isBuiltIn: true,
  sensors: [TRAILING_CAMERA_SENSOR],
};

export const PRESET_SDG_AV: SensorRig = {
  id: "preset-sdg-av",
  name: "NVIDIA Sensor Config",
  isBuiltIn: true,
  sensors: [
    TRAILING_CAMERA_SENSOR,
    cam("camera_front_center", "Front Center", { x: 2.1, y: 0.0, z: 1.45 }, {
      width: 1920,
      height: 1208,
      fov: 120,
      mountId: "front_center",
      mountRole: "sdg_primary",
      supportedOutputModalities: ["rgb", "depth", "semantic_segmentation", "instance_segmentation", "normals"],
    }),
    cam("camera_front_left", "Front Left", { x: 2.0, y: -0.42, z: 1.43, yaw: -50.0 }, {
      width: 1920,
      height: 1208,
      fov: 120,
      mountId: "front_left",
      mountRole: "perception",
      supportedOutputModalities: ["rgb", "depth", "semantic_segmentation", "instance_segmentation", "normals"],
    }),
    cam("camera_front_right", "Front Right", { x: 2.0, y: 0.42, z: 1.43, yaw: 50.0 }, {
      width: 1920,
      height: 1208,
      fov: 120,
      mountId: "front_right",
      mountRole: "perception",
      supportedOutputModalities: ["rgb", "depth", "semantic_segmentation", "instance_segmentation", "normals"],
    }),
    cam("camera_left_side", "Left Side", { x: 0.2, y: -0.95, z: 1.35, yaw: -90.0 }, {
      width: 1920,
      height: 1208,
      fov: 120,
      mountId: "left_side",
      mountRole: "perception",
      supportedOutputModalities: ["rgb", "depth", "semantic_segmentation", "instance_segmentation", "normals"],
    }),
    cam("camera_right_side", "Right Side", { x: 0.2, y: 0.95, z: 1.35, yaw: 90.0 }, {
      width: 1920,
      height: 1208,
      fov: 120,
      mountId: "right_side",
      mountRole: "perception",
      supportedOutputModalities: ["rgb", "depth", "semantic_segmentation", "instance_segmentation", "normals"],
    }),
    cam("camera_rear_left", "Rear Left", { x: -1.0, y: -0.38, z: 1.33, yaw: -140.0 }, {
      width: 1920,
      height: 1208,
      fov: 120,
      mountId: "rear_left",
      mountRole: "perception",
      supportedOutputModalities: ["rgb", "depth", "semantic_segmentation", "instance_segmentation", "normals"],
    }),
    cam("camera_rear_right", "Rear Right", { x: -1.0, y: 0.38, z: 1.33, yaw: 140.0 }, {
      width: 1920,
      height: 1208,
      fov: 120,
      mountId: "rear_right",
      mountRole: "perception",
      supportedOutputModalities: ["rgb", "depth", "semantic_segmentation", "instance_segmentation", "normals"],
    }),
    lidar("lidar_roof_center", "Roof Center LiDAR", { x: 0.15, y: 0.0, z: 1.85 }, {
      channels: 128,
      range: 250,
      pointsPerSecond: 1_310_720,
      rotationFrequency: 10,
      upperFov: 10,
      lowerFov: -30,
      updateRate: 10,
    }),
  ],
};

/**
 * Pronto port configuration E. Source positions are millimetres relative to
 * the roof-platform datum. Values below are canonical vehicle-relative metres:
 * platform datum x=1.31775 m from vehicle center, z=1.65 m above ground.
 */
export const PRESET_PRONTO: SensorRig = {
  id: "preset-pronto",
  name: "Pronto Rig",
  isBuiltIn: true,
  sensors: [
    cam("pronto-cam0", "CAM0", { x: 1.16685, y: -0.7958, z: 1.7017, yaw: 122, pitch: 25 }, {
      fov: 120,
      mountId: "pronto-cam0",
      mountLabel: "Front Driver",
      mountRole: "perception",
    }),
    cam("pronto-cam1", "CAM1", { x: 1.16695, y: 0, z: 1.7017, pitch: 10 }, {
      fov: 120,
      mountId: "pronto-cam1",
      mountLabel: "Front Center",
      mountRole: "perception",
    }),
    cam("pronto-cam2", "CAM2", { x: -1.14255, y: -0.7958, z: 1.7017, yaw: 60, pitch: 25 }, {
      fov: 120,
      mountId: "pronto-cam2",
      mountLabel: "Rear Driver",
      mountRole: "perception",
    }),
    cam("pronto-cam3", "CAM3", { x: 1.26935, y: -0.5953, z: 1.7227 }, {
      fov: 30,
      mountId: "pronto-cam3",
      mountLabel: "Front Driver — Falcon mount",
      mountRole: "perception",
    }),
    cam("pronto-cam4", "CAM4", { x: -1.14255, y: 0.7958, z: 1.7017, yaw: -60, pitch: 25 }, {
      fov: 120,
      mountId: "pronto-cam4",
      mountLabel: "Rear Passenger",
      mountRole: "perception",
    }),
    cam("pronto-cam5", "CAM5", { x: -1.14255, y: 0, z: 1.7017, yaw: 180, pitch: 10 }, {
      fov: 120,
      mountId: "pronto-cam5",
      mountLabel: "Rear Center",
      mountRole: "perception",
    }),
    cam("pronto-cam6", "CAM6", { x: 1.16695, y: 0.7985, z: 1.7017, yaw: -122, pitch: 25 }, {
      fov: 120,
      mountId: "pronto-cam6",
      mountLabel: "Front Passenger",
      mountRole: "perception",
    }),
    cam("pronto-cam7", "CAM7", { x: 1.25615, y: 0.5927, z: 1.7227, pitch: 5 }, {
      fov: 60,
      mountId: "pronto-cam7",
      mountLabel: "Front Passenger — Falcon mount",
      mountRole: "perception",
    }),
    lidar(
      "pronto-lidar-front-left",
      "Front left — Seyond Falcon",
      { x: 1.20185, y: -0.4772, z: 1.7778 },
      { horizontalFov: 120, upperFov: 12.5, lowerFov: -12.5 },
    ),
    lidar(
      "pronto-lidar-front-left-wide",
      "Front left wide — Seyond Robin W",
      { x: 1.18345, y: -0.7671, z: 1.7286, yaw: 120 },
      { horizontalFov: 120, upperFov: 35, lowerFov: -35 },
    ),
    lidar(
      "pronto-lidar-front-right",
      "Front right — Seyond Falcon",
      { x: 1.20185, y: 0.4798, z: 1.7778 },
      { horizontalFov: 120, upperFov: 12.5, lowerFov: -12.5 },
    ),
    lidar(
      "pronto-lidar-front-right-wide",
      "Front right wide — Seyond Robin W",
      { x: 1.18355, y: 0.7698, z: 1.7286, yaw: -120 },
      { horizontalFov: 120, upperFov: 35, lowerFov: -35 },
    ),
    lidar(
      "pronto-lidar-rear-left",
      "Rear left — Seyond Robin W",
      { x: -1.15915, y: -0.7671, z: 1.7286, yaw: 60 },
      { horizontalFov: 120, upperFov: 35, lowerFov: -35 },
    ),
    lidar(
      "pronto-lidar-rear-right",
      "Rear right — Seyond Robin W",
      { x: -1.15915, y: 0.7671, z: 1.7286, yaw: -60 },
      { horizontalFov: 120, upperFov: 35, lowerFov: -35 },
    ),
    radar("pronto-rad-01", "RAD-01 — Altos V4", { x: 1.25845, y: -0.4871, z: 1.7248 }),
    radar("pronto-rad-02", "RAD-02 — Altos V4", { x: 1.25845, y: 0.4699, z: 1.7248 }),
    radar("pronto-rad-03", "RAD-03 — Altos RF6", { x: -1.26935, y: -0.461, z: 1.6815, yaw: 160 }),
    radar("pronto-rad-04", "RAD-04 — Altos RF6", { x: -1.21965, y: 0.5142, z: 1.6815, yaw: -160 }),
  ],
};

export const ALPAMAYO_PAI_CAMERA_MOUNT_IDS = [
  "camera_front_wide_120fov",
  "camera_cross_left_120fov",
  "camera_cross_right_120fov",
  "camera_front_tele_30fov",
] as const;

export const PRESET_ALPAMAYO_PAI: SensorRig = {
  id: "preset-alpamayo-pai",
  name: "Alpamayo PAI 4-Camera",
  isBuiltIn: true,
  sensors: [
    cam("camera_front_wide_120fov", "Front Wide 120 FOV", { x: 2.05, y: 0, z: 1.5 }, {
      width: 1920,
      height: 1208,
      fov: 120,
      mountId: "camera_front_wide_120fov",
      mountRole: "alpamayo_pai",
      supportedOutputModalities: ["rgb"],
    }),
    cam("camera_cross_left_120fov", "Cross Left 120 FOV", { x: 1.9, y: -0.42, z: 1.46, yaw: -55 }, {
      width: 1920,
      height: 1208,
      fov: 120,
      mountId: "camera_cross_left_120fov",
      mountRole: "alpamayo_pai",
      supportedOutputModalities: ["rgb"],
    }),
    cam("camera_cross_right_120fov", "Cross Right 120 FOV", { x: 1.9, y: 0.42, z: 1.46, yaw: 55 }, {
      width: 1920,
      height: 1208,
      fov: 120,
      mountId: "camera_cross_right_120fov",
      mountRole: "alpamayo_pai",
      supportedOutputModalities: ["rgb"],
    }),
    cam("camera_front_tele_30fov", "Front Tele 30 FOV", { x: 2.08, y: 0, z: 1.52 }, {
      width: 1920,
      height: 1208,
      fov: 30,
      mountId: "camera_front_tele_30fov",
      mountRole: "alpamayo_pai",
      supportedOutputModalities: ["rgb"],
    }),
  ],
};

export const BUILT_IN_RIGS: SensorRig[] = [
  PRESET_BASIC_DASHCAM,
  PRESET_TESLA_HW3,
  PRESET_WAYMO_5TH_GEN,
  PRESET_SDG_AV,
  PRESET_PRONTO,
  PRESET_ALPAMAYO_PAI,
  PRESET_TRAILING_CAMERA,
];

export const PRESET_SENSOR_RIG_IMAGES: Record<string, string> = {
  "preset-basic-dashcam": "/scenario-editor/sensor-rigs/presets/basic-dash-cam.png",
  "preset-tesla-hw3": "/scenario-editor/sensor-rigs/presets/tesla-autopilot-hw3.png",
  "preset-waymo-5th-gen": "/scenario-editor/sensor-rigs/presets/waymo-5th-gen.png",
  "preset-sdg-av": "/scenario-editor/sensor-rigs/presets/sdg-sensor-config.png",
  "preset-alpamayo-pai": "/scenario-editor/sensor-rigs/sensor-rig-overview.png",
  "preset-trailing-camera": "/scenario-editor/sensor-rigs/presets/trailing-camera.png",
};

/** Detect which built-in preset matches an actor's sensor list (by label + category). */
export function identifyRigPreset(sensors: Sensor[]): SensorRig | null {
  if (sensors.length === 0) return null;
  return (
    BUILT_IN_RIGS.find(
      (rig) =>
        rig.sensors.length === sensors.length &&
        rig.sensors.every(
          (rigSensor, i) =>
            sensors[i]?.label === rigSensor.label &&
            sensors[i]?.sensorCategory === rigSensor.sensorCategory,
        ),
    ) ?? null
  );
}

/** Create fresh sensor instances from a preset rig (new UUIDs for each sensor). */
export function sensorsFromPreset(rig: SensorRig): Sensor[] {
  return rig.sensors.map((sensor) => ({ ...sensor, id: crypto.randomUUID() }));
}

export function cloneRigWithNewIds(rig: SensorRig, newRigId?: string): SensorRig {
  return {
    id: newRigId ?? crypto.randomUUID(),
    name: rig.name,
    isBuiltIn: false,
    sensors: rig.sensors.map((sensor) => ({
      ...sensor,
      id: crypto.randomUUID(),
    })),
  };
}
