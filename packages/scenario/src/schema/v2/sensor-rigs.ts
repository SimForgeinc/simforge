/** Canonical actor-mounted perception rig presets. */

import { z } from 'zod';

import { EntityIdSchema } from '../v1.js';

import {
  ActorSensorSchema,
  DashCameraSensorSchema,
  LidarSensorSchema,
  RadarSensorSchema,
  SensorMountSchema,
  SensorRigMountSchema,
  newSensorId,
  supportsDashCamera,
  type ActorForDashCamera,
  type ActorSensor,
  type DashCameraSensor,
  type LidarSensor,
  type RadarSensor,
  type SensorMount,
  type SensorRigMount,
  type VehicleAnchor,
  type VehicleAnchorMount,
} from './sensors.js';
import {
  ActorClassSchema,
  DEFAULT_ACTOR_DIMS,
  type ActorSpec,
} from './roles.js';

export const SensorRigCameraTemplateSchema = DashCameraSensorSchema
  .omit({ mount: true })
  .extend({ mount: SensorRigMountSchema });
export const SensorRigLidarTemplateSchema = LidarSensorSchema
  .omit({ mount: true })
  .extend({ mount: SensorRigMountSchema });
export const SensorRigRadarTemplateSchema = RadarSensorSchema
  .omit({ mount: true })
  .extend({ mount: SensorRigMountSchema });

export const SensorRigSensorTemplateSchema = z.discriminatedUnion('type', [
  SensorRigCameraTemplateSchema,
  SensorRigLidarTemplateSchema,
  SensorRigRadarTemplateSchema,
]);

/** A serializable rig definition. Template sensor ids identify preset slots only. */
export const SensorRigPresetSchema = z.strictObject({
  id: EntityIdSchema,
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(1_000).optional(),
  compatibleActorClasses: z.array(ActorClassSchema).min(1),
  sensors: z.array(SensorRigSensorTemplateSchema).min(1).max(32),
}).check((ctx) => {
  const ids = new Set<string>();
  ctx.value.sensors.forEach((sensor, index) => {
    if (ids.has(sensor.id)) {
      ctx.issues.push({
        code: 'custom',
        message: `duplicate preset sensor id "${sensor.id}"`,
        path: ['sensors', index, 'id'],
        input: sensor.id,
      });
    }
    ids.add(sensor.id);
  });
});

export type SensorRigCameraTemplate = z.infer<typeof SensorRigCameraTemplateSchema>;
export type SensorRigLidarTemplate = z.infer<typeof SensorRigLidarTemplateSchema>;
export type SensorRigRadarTemplate = z.infer<typeof SensorRigRadarTemplateSchema>;
export type SensorRigSensorTemplate = z.infer<typeof SensorRigSensorTemplateSchema>;
export type SensorRigPreset = z.infer<typeof SensorRigPresetSchema>;
export type SensorRigActor = Pick<ActorSpec, 'class' | 'dims'>;
/**
 * Anything a mount can be resolved against.
 *
 * Deliberately looser than `SensorRigActor`: placing a sensor only needs a box
 * and a class name, and callers outside the document layer (recording stores,
 * import adapters) legitimately hold a plain string class.
 */
export type SensorMountActor = { class: string; dims?: ActorSpec['dims'] };
export type SensorRigIdFactory = (
  template: SensorRigSensorTemplate,
  index: number,
  preset: SensorRigPreset,
) => string;

const REFERENCE_CAR_DIMS = DEFAULT_ACTOR_DIMS.car;

function anchorPosition(
  anchor: VehicleAnchor,
  dims: { length: number; width: number; height: number },
): { x: number; y: number; z: number } {
  return {
    x: anchor.longitudinal === 'front'
      ? dims.length / 2
      : anchor.longitudinal === 'rear'
        ? -dims.length / 2
        : 0,
    y: anchor.vertical === 'top'
      ? dims.height
      : anchor.vertical === 'center'
        ? dims.height / 2
        : 0,
    z: anchor.lateral === 'left'
      ? dims.width / 2
      : anchor.lateral === 'right'
        ? -dims.width / 2
        : 0,
  };
}

function rounded(value: number): number {
  const result = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(result, -0) ? 0 : result;
}

function mountFromV1(
  anchor: VehicleAnchor,
  pose: { x: number; lateralRight: number; up: number; yawDeg?: number },
): SensorRigMount {
  const base = anchorPosition(anchor, REFERENCE_CAR_DIMS);
  return {
    anchor,
    offset: {
      x: rounded(pose.x - base.x),
      y: rounded(pose.up - base.y),
      z: rounded(-pose.lateralRight - base.z),
    },
    rotation: {
      yawRad: (pose.yawDeg ?? 0) * Math.PI / 180,
      pitchRad: 0,
      rollRad: 0,
    },
  };
}

function verticalFov(horizontalFovDeg: number, aspectRatio: number): number {
  const halfHorizontalRad = horizontalFovDeg * Math.PI / 360;
  return 2 * Math.atan(Math.tan(halfHorizontalRad) / aspectRatio) * 180 / Math.PI;
}

function camera(
  id: string,
  label: string,
  mount: SensorRigMount,
  options: { fov?: number; width?: number; height?: number } = {},
): SensorRigCameraTemplate {
  const horizontalFovDeg = options.fov ?? 90;
  const aspectRatio = (options.width ?? 854) / (options.height ?? 480);
  return SensorRigCameraTemplateSchema.parse({
    id,
    type: 'dash_camera',
    label,
    enabled: true,
    mount,
    camera: {
      horizontalFovDeg,
      verticalFovDeg: verticalFov(horizontalFovDeg, aspectRatio),
      nearM: 0.05,
      farM: 1_000,
      aspectRatio,
    },
  });
}

function lidar(
  id: string,
  label: string,
  mount: SensorRigMount,
  options: { range?: number; upperFov?: number; lowerFov?: number } = {},
): SensorRigLidarTemplate {
  return SensorRigLidarTemplateSchema.parse({
    id,
    type: 'lidar',
    label,
    enabled: true,
    mount,
    field: {
      horizontalFovDeg: 360,
      verticalFovDeg: options.upperFov !== undefined && options.lowerFov !== undefined
        ? options.upperFov - options.lowerFov
        : 40,
      nearM: 0.5,
      farM: options.range ?? 100,
    },
  });
}

function radar(
  id: string,
  label: string,
  mount: SensorRigMount,
): SensorRigRadarTemplate {
  return SensorRigRadarTemplateSchema.parse({
    id,
    type: 'radar',
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

const FRONT_TOP_CENTER: VehicleAnchor = {
  longitudinal: 'front', vertical: 'top', lateral: 'center',
};
const FRONT_BOTTOM_CENTER: VehicleAnchor = {
  longitudinal: 'front', vertical: 'bottom', lateral: 'center',
};
const REAR_TOP_CENTER: VehicleAnchor = {
  longitudinal: 'rear', vertical: 'top', lateral: 'center',
};
const CENTER_TOP_CENTER: VehicleAnchor = {
  longitudinal: 'center', vertical: 'top', lateral: 'center',
};
const FRONT_TOP_LEFT: VehicleAnchor = {
  longitudinal: 'front', vertical: 'top', lateral: 'left',
};
const FRONT_TOP_RIGHT: VehicleAnchor = {
  longitudinal: 'front', vertical: 'top', lateral: 'right',
};
const CENTER_TOP_LEFT: VehicleAnchor = {
  longitudinal: 'center', vertical: 'top', lateral: 'left',
};
const CENTER_TOP_RIGHT: VehicleAnchor = {
  longitudinal: 'center', vertical: 'top', lateral: 'right',
};
const REAR_TOP_LEFT: VehicleAnchor = {
  longitudinal: 'rear', vertical: 'top', lateral: 'left',
};
const REAR_TOP_RIGHT: VehicleAnchor = {
  longitudinal: 'rear', vertical: 'top', lateral: 'right',
};
const CENTER_BOTTOM_LEFT: VehicleAnchor = {
  longitudinal: 'center', vertical: 'bottom', lateral: 'left',
};
const CENTER_BOTTOM_RIGHT: VehicleAnchor = {
  longitudinal: 'center', vertical: 'bottom', lateral: 'right',
};

const BASIC_DASH_CAMERA = SensorRigPresetSchema.parse({
  id: 'basic-dash-camera',
  name: 'Basic Dash Camera',
  compatibleActorClasses: ['car', 'truck', 'bus', 'van', 'motorcycle'],
  sensors: [
    camera('dashcam-front', 'Front Camera', mountFromV1(FRONT_TOP_CENTER, {
      x: 1.6, lateralRight: 0, up: 1.7,
    })),
  ],
});

const TESLA_HW3 = SensorRigPresetSchema.parse({
  id: 'tesla-hw3',
  name: 'Tesla Autopilot HW3',
  compatibleActorClasses: ['car'],
  sensors: [
    camera('tesla-front-narrow', 'Front Narrow', mountFromV1(FRONT_TOP_CENTER, {
      x: 1.6, lateralRight: 0, up: 1.7,
    }), { fov: 35 }),
    camera('tesla-front-main', 'Front Main', mountFromV1(FRONT_TOP_CENTER, {
      x: 1.6, lateralRight: 0, up: 1.7,
    }), { fov: 50 }),
    camera('tesla-front-wide', 'Front Wide', mountFromV1(FRONT_TOP_CENTER, {
      x: 1.6, lateralRight: 0, up: 1.7,
    }), { fov: 120 }),
    camera('tesla-left-fwd', 'Left Forward', mountFromV1(FRONT_TOP_LEFT, {
      x: 0.9, lateralRight: -1, up: 1.3, yawDeg: -60,
    }), { fov: 80 }),
    camera('tesla-left-rear', 'Left Rear', mountFromV1(REAR_TOP_LEFT, {
      x: -0.5, lateralRight: -1, up: 1.3, yawDeg: -120,
    }), { fov: 80 }),
    camera('tesla-right-fwd', 'Right Forward', mountFromV1(FRONT_TOP_RIGHT, {
      x: 0.9, lateralRight: 1, up: 1.3, yawDeg: 60,
    }), { fov: 80 }),
    camera('tesla-right-rear', 'Right Rear', mountFromV1(REAR_TOP_RIGHT, {
      x: -0.5, lateralRight: 1, up: 1.3, yawDeg: 120,
    }), { fov: 80 }),
    camera('tesla-rear', 'Rear', mountFromV1(REAR_TOP_CENTER, {
      x: -2, lateralRight: 0, up: 1.5, yawDeg: 180,
    }), { fov: 50 }),
    radar('tesla-radar-fwd', 'Forward Radar', mountFromV1(FRONT_BOTTOM_CENTER, {
      x: 2, lateralRight: 0, up: 0.5,
    })),
  ],
});

const WAYMO_5TH_GEN = SensorRigPresetSchema.parse({
  id: 'waymo-5th-gen',
  name: 'Waymo 5th Gen (Simplified)',
  compatibleActorClasses: ['car', 'van'],
  sensors: [
    camera('waymo-front', 'Front', mountFromV1(FRONT_TOP_CENTER, {
      x: 1.5, lateralRight: 0, up: 2,
    }), { fov: 50, width: 1920, height: 1280 }),
    camera('waymo-front-left', 'Front Left', mountFromV1(FRONT_TOP_LEFT, {
      x: 1.2, lateralRight: -0.8, up: 2, yawDeg: -45,
    }), { fov: 70 }),
    camera('waymo-front-right', 'Front Right', mountFromV1(FRONT_TOP_RIGHT, {
      x: 1.2, lateralRight: 0.8, up: 2, yawDeg: 45,
    }), { fov: 70 }),
    camera('waymo-left', 'Left', mountFromV1(CENTER_TOP_LEFT, {
      x: 0, lateralRight: -1, up: 2, yawDeg: -90,
    }), { fov: 70 }),
    camera('waymo-right', 'Right', mountFromV1(CENTER_TOP_RIGHT, {
      x: 0, lateralRight: 1, up: 2, yawDeg: 90,
    }), { fov: 70 }),
    lidar('waymo-lidar-top', 'Top LiDAR', mountFromV1(CENTER_TOP_CENTER, {
      x: 0, lateralRight: 0, up: 2.5,
    }), { range: 75 }),
    lidar('waymo-lidar-front', 'Front LiDAR', mountFromV1(FRONT_BOTTOM_CENTER, {
      x: 2, lateralRight: 0, up: 0.8,
    }), { range: 50 }),
    lidar('waymo-lidar-left', 'Left LiDAR', mountFromV1(CENTER_BOTTOM_LEFT, {
      x: 0, lateralRight: -1, up: 1,
    }), { range: 50 }),
    lidar('waymo-lidar-right', 'Right LiDAR', mountFromV1(CENTER_BOTTOM_RIGHT, {
      x: 0, lateralRight: 1, up: 1,
    }), { range: 50 }),
  ],
});

const NVIDIA_SDG_AV = SensorRigPresetSchema.parse({
  id: 'nvidia-sdg-av',
  name: 'NVIDIA Sensor Config',
  compatibleActorClasses: ['car', 'van', 'truck'],
  sensors: [
    camera('camera_front_center', 'Front Center', mountFromV1(FRONT_TOP_CENTER, {
      x: 2.1, lateralRight: 0, up: 1.45,
    }), { fov: 120, width: 1920, height: 1208 }),
    camera('camera_front_left', 'Front Left', mountFromV1(FRONT_TOP_LEFT, {
      x: 2, lateralRight: -0.42, up: 1.43, yawDeg: -50,
    }), { fov: 120, width: 1920, height: 1208 }),
    camera('camera_front_right', 'Front Right', mountFromV1(FRONT_TOP_RIGHT, {
      x: 2, lateralRight: 0.42, up: 1.43, yawDeg: 50,
    }), { fov: 120, width: 1920, height: 1208 }),
    camera('camera_left_side', 'Left Side', mountFromV1(CENTER_TOP_LEFT, {
      x: 0.2, lateralRight: -0.95, up: 1.35, yawDeg: -90,
    }), { fov: 120, width: 1920, height: 1208 }),
    camera('camera_right_side', 'Right Side', mountFromV1(CENTER_TOP_RIGHT, {
      x: 0.2, lateralRight: 0.95, up: 1.35, yawDeg: 90,
    }), { fov: 120, width: 1920, height: 1208 }),
    camera('camera_rear_left', 'Rear Left', mountFromV1(REAR_TOP_LEFT, {
      x: -1, lateralRight: -0.38, up: 1.33, yawDeg: -140,
    }), { fov: 120, width: 1920, height: 1208 }),
    camera('camera_rear_right', 'Rear Right', mountFromV1(REAR_TOP_RIGHT, {
      x: -1, lateralRight: 0.38, up: 1.33, yawDeg: 140,
    }), { fov: 120, width: 1920, height: 1208 }),
    lidar('lidar_roof_center', 'Roof Center LiDAR', mountFromV1(CENTER_TOP_CENTER, {
      x: 0.15, lateralRight: 0, up: 1.85,
    }), { range: 250, upperFov: 10, lowerFov: -30 }),
  ],
});

const ALPAMAYO_PAI = SensorRigPresetSchema.parse({
  id: 'alpamayo-pai',
  name: 'Alpamayo PAI 4-Camera',
  compatibleActorClasses: ['car'],
  sensors: [
    camera('camera_front_wide_120fov', 'Front Wide 120 FOV', mountFromV1(FRONT_TOP_CENTER, {
      x: 2.05, lateralRight: 0, up: 1.5,
    }), { fov: 120, width: 1920, height: 1208 }),
    camera('camera_cross_left_120fov', 'Cross Left 120 FOV', mountFromV1(FRONT_TOP_LEFT, {
      x: 1.9, lateralRight: -0.42, up: 1.46, yawDeg: -55,
    }), { fov: 120, width: 1920, height: 1208 }),
    camera('camera_cross_right_120fov', 'Cross Right 120 FOV', mountFromV1(FRONT_TOP_RIGHT, {
      x: 1.9, lateralRight: 0.42, up: 1.46, yawDeg: 55,
    }), { fov: 120, width: 1920, height: 1208 }),
    camera('camera_front_tele_30fov', 'Front Tele 30 FOV', mountFromV1(FRONT_TOP_CENTER, {
      x: 2.08, lateralRight: 0, up: 1.52,
    }), { fov: 30, width: 1920, height: 1208 }),
  ],
});

/* ----------------------------------------------- Alpamayo model-input rigs */

/**
 * Upstream Alpamayo 1.5 camera-index convention
 * (NVlabs/alpamayo1.5 `load_physical_aiavdataset.py`). The inference wire
 * (`adapters/alpamayo` `act.obs.cameras[].camera_id`) identifies cameras only
 * by these integers and sorts ascending; sensor ids in the Alpamayo rig
 * presets below are exactly these dataset camera names so bridges can map a
 * rendered frame to its model slot with a table lookup.
 */
export const ALPAMAYO_CAMERA_INDEX = Object.freeze({
  camera_cross_left_120fov: 0,
  camera_front_wide_120fov: 1,
  camera_cross_right_120fov: 2,
  camera_rear_left_70fov: 3,
  camera_rear_tele_30fov: 4,
  camera_rear_right_70fov: 5,
  camera_front_tele_30fov: 6,
} as const);

export type AlpamayoCameraName = keyof typeof ALPAMAYO_CAMERA_INDEX;

/**
 * Model-native render size: 512*384 == 196,608 px == the upstream Qwen image
 * processor's MAX_PIXELS, so frames rendered at this size are never resized
 * by the model server (adapters/alpamayo obs.py uses the same constant for
 * its synthetic profiles and latency benchmarks).
 *
 * Honest approximation vs the real PhysicalAI-AV rig: the dataset cameras
 * are 1920x1208 (aspect ~1.589). We keep each camera's HORIZONTAL FoV and
 * render at 4:3, so the authored vertical FoV is wider than the calibrated
 * rig (120° wide/cross: ~104.9° vs ~94.9°; 30° tele: ~22.6° vs ~19.0°) and
 * frames show more sky/hood than the training distribution. Mounts are
 * authored approximations of the rig geometry, not the per-vehicle
 * calibration shipped inside the gated dataset (the wire protocol carries no
 * extrinsics/intrinsics — cameras are identified by index only), so pose
 * error degrades trajectory quality gracefully rather than causing
 * shape/contract failures.
 */
export const ALPAMAYO_RENDER_WIDTH = 512;
export const ALPAMAYO_RENDER_HEIGHT = 384;

const ALPAMAYO_CAMERA_TEMPLATES: Readonly<
  Partial<Record<AlpamayoCameraName, SensorRigCameraTemplate>>
> = Object.freeze({
  camera_cross_left_120fov: camera(
    'camera_cross_left_120fov', 'Cross Left 120 FOV',
    mountFromV1(FRONT_TOP_LEFT, { x: 1.9, lateralRight: -0.42, up: 1.46, yawDeg: -55 }),
    { fov: 120, width: ALPAMAYO_RENDER_WIDTH, height: ALPAMAYO_RENDER_HEIGHT },
  ),
  camera_front_wide_120fov: camera(
    'camera_front_wide_120fov', 'Front Wide 120 FOV',
    mountFromV1(FRONT_TOP_CENTER, { x: 2.05, lateralRight: 0, up: 1.5 }),
    { fov: 120, width: ALPAMAYO_RENDER_WIDTH, height: ALPAMAYO_RENDER_HEIGHT },
  ),
  camera_cross_right_120fov: camera(
    'camera_cross_right_120fov', 'Cross Right 120 FOV',
    mountFromV1(FRONT_TOP_RIGHT, { x: 1.9, lateralRight: 0.42, up: 1.46, yawDeg: 55 }),
    { fov: 120, width: ALPAMAYO_RENDER_WIDTH, height: ALPAMAYO_RENDER_HEIGHT },
  ),
  camera_front_tele_30fov: camera(
    'camera_front_tele_30fov', 'Front Tele 30 FOV',
    mountFromV1(FRONT_TOP_CENTER, { x: 2.08, lateralRight: 0, up: 1.52 }),
    { fov: 30, width: ALPAMAYO_RENDER_WIDTH, height: ALPAMAYO_RENDER_HEIGHT },
  ),
});

/**
 * Build a model-input rig preset from dataset camera names. Sensors are
 * ordered camera-index ascending so rig registration order (and therefore
 * shm frame-bundle entry order) matches the model server's sorted camera
 * order without a bridge-side reorder.
 */
export function buildAlpamayoRigPreset(
  id: string,
  name: string,
  cameraNames: readonly AlpamayoCameraName[],
  description?: string,
): SensorRigPreset {
  const sensors = [...cameraNames]
    .sort((a, b) => ALPAMAYO_CAMERA_INDEX[a] - ALPAMAYO_CAMERA_INDEX[b])
    .map((cameraName) => {
      const template = ALPAMAYO_CAMERA_TEMPLATES[cameraName];
      if (!template) {
        throw new Error(`no authored Alpamayo camera template for "${cameraName}"`);
      }
      return template;
    });
  return SensorRigPresetSchema.parse({
    id,
    name,
    ...(description === undefined ? {} : { description }),
    compatibleActorClasses: ['car'],
    sensors,
  });
}

/** Recommended closed-loop profile: NF4 act p50 1.41 s, peak 8.7 GB VRAM. */
const ALPAMAYO_2CAM = buildAlpamayoRigPreset(
  'alpamayo-2cam',
  'Alpamayo 2-Camera (front wide + tele)',
  ['camera_front_wide_120fov', 'camera_front_tele_30fov'],
  'Lean Alpamayo 1.5 input rig: camera indices [1, 6] at the model-native '
  + '512x384 render size. Recommended NF4 closed-loop profile.',
);

/** Dataset-default eval profile: indices [0, 1, 2, 6], NF4 act p50 ~2.4 s. */
const ALPAMAYO_4CAM = buildAlpamayoRigPreset(
  'alpamayo-4cam',
  'Alpamayo 4-Camera (dataset default)',
  [
    'camera_cross_left_120fov',
    'camera_front_wide_120fov',
    'camera_cross_right_120fov',
    'camera_front_tele_30fov',
  ],
  'Alpamayo 1.5 dataset-default input rig: camera indices [0, 1, 2, 6] at '
  + 'the model-native 512x384 render size.',
);

export const BUILT_IN_SENSOR_RIGS: readonly SensorRigPreset[] = Object.freeze([
  BASIC_DASH_CAMERA,
  TESLA_HW3,
  WAYMO_5TH_GEN,
  NVIDIA_SDG_AV,
  ALPAMAYO_PAI,
  ALPAMAYO_2CAM,
  ALPAMAYO_4CAM,
]);

const BUILT_IN_SENSOR_RIGS_BY_ID: Readonly<Record<string, SensorRigPreset>> = {
  'basic-dash-camera': BASIC_DASH_CAMERA,
  'tesla-hw3': TESLA_HW3,
  'waymo-5th-gen': WAYMO_5TH_GEN,
  'nvidia-sdg-av': NVIDIA_SDG_AV,
  'alpamayo-pai': ALPAMAYO_PAI,
  'alpamayo-2cam': ALPAMAYO_2CAM,
  'alpamayo-4cam': ALPAMAYO_4CAM,
};

export function sensorRigPreset(id: string): SensorRigPreset | undefined {
  return BUILT_IN_SENSOR_RIGS_BY_ID[id];
}

/** Resolve a fixed or vehicle-anchored preset mount to an actor-local numeric mount. */
export function resolveSensorRigMount(
  mount: SensorRigMount,
  actor: SensorMountActor,
): SensorMount {
  if ('position' in mount) return SensorMountSchema.parse(mount);

  // An unrecognised class still gets a plausible box rather than undefined dims.
  const dims = actor.dims ?? DEFAULT_ACTOR_DIMS[actor.class as ActorSpec['class']] ?? DEFAULT_ACTOR_DIMS.car;
  const base = anchorPosition(mount.anchor, dims);
  return SensorMountSchema.parse({
    position: {
      x: rounded(base.x + mount.offset.x),
      y: rounded(base.y + mount.offset.y),
      z: rounded(base.z + mount.offset.z),
    },
    rotation: mount.rotation,
  });
}

export type SensorMountPreset = {
  id: string;
  label: string;
  mount: VehicleAnchorMount;
};

/** Physical mounting choices scale with the carrier instead of one catalog model. */
export const SENSOR_MOUNT_PRESETS: readonly SensorMountPreset[] = Object.freeze([
  {
    id: 'roof-centre',
    label: 'Roof',
    mount: {
      anchor: { longitudinal: 'center', vertical: 'top', lateral: 'center' },
      offset: { x: 0, y: 0.15, z: 0 },
      rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
    },
  },
  {
    id: 'windscreen',
    label: 'Windscreen',
    mount: {
      anchor: { longitudinal: 'front', vertical: 'top', lateral: 'center' },
      offset: { x: -0.35, y: -0.25, z: 0 },
      rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
    },
  },
  {
    id: 'front-bumper',
    label: 'Front bumper',
    mount: {
      anchor: { longitudinal: 'front', vertical: 'bottom', lateral: 'center' },
      offset: { x: 0, y: 0.5, z: 0 },
      rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
    },
  },
  {
    id: 'rear-bumper',
    label: 'Rear bumper',
    mount: {
      anchor: { longitudinal: 'rear', vertical: 'bottom', lateral: 'center' },
      offset: { x: 0, y: 0.5, z: 0 },
      rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
    },
  },
  {
    id: 'left-mirror',
    label: 'Left mirror',
    mount: {
      anchor: { longitudinal: 'front', vertical: 'top', lateral: 'left' },
      offset: { x: -0.6, y: -0.35, z: 0.08 },
      rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
    },
  },
  {
    id: 'right-mirror',
    label: 'Right mirror',
    mount: {
      anchor: { longitudinal: 'front', vertical: 'top', lateral: 'right' },
      offset: { x: -0.6, y: -0.35, z: -0.08 },
      rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
    },
  },
]);

const SENSOR_MOUNT_PRESETS_BY_ID: Readonly<Record<string, SensorMountPreset>> =
  Object.fromEntries(SENSOR_MOUNT_PRESETS.map((preset) => [preset.id, preset]));

/** Resolve one author-facing mounting choice against the carrier's dimensions. */
export function resolveSensorMountPreset(
  presetOrId: SensorMountPreset | string,
  actor: SensorMountActor,
): SensorMount {
  const preset = typeof presetOrId === 'string'
    ? SENSOR_MOUNT_PRESETS_BY_ID[presetOrId]
    : presetOrId;
  if (!preset) throw new Error(`unknown sensor mount preset "${presetOrId}"`);
  return resolveSensorRigMount(preset.mount, actor);
}

/**
 * Rotation is deliberately absent from matching: mounting position and aim are
 * independent authoring choices, and changing one must not clear the other.
 */
export function matchSensorMountPreset(
  mount: SensorMount,
  actor: SensorMountActor,
): SensorMountPreset | undefined {
  return SENSOR_MOUNT_PRESETS.find((preset) => {
    const resolved = resolveSensorMountPreset(preset, actor);
    return rounded(resolved.position.x - mount.position.x) === 0
      && rounded(resolved.position.y - mount.position.y) === 0
      && rounded(resolved.position.z - mount.position.z) === 0;
  });
}

let generatedSensorSequence = 0;

function generatedSensorId(): string {
  generatedSensorSequence += 1;
  return `sensor-${Date.now().toString(36)}-${generatedSensorSequence.toString(36)}`;
}

/**
 * Mint actor-owned sensor identities and resolve every preset anchor. The
 * returned values are fully parsed ActorSensors and no longer depend on a rig.
 */
export function instantiateSensorRig(
  presetOrId: SensorRigPreset | string,
  actor: SensorRigActor,
  idFactory: SensorRigIdFactory = generatedSensorId,
): ActorSensor[] {
  const preset = typeof presetOrId === 'string'
    ? sensorRigPreset(presetOrId)
    : SensorRigPresetSchema.parse(presetOrId);
  if (!preset) throw new Error(`unknown sensor rig preset "${presetOrId}"`);
  if (!preset.compatibleActorClasses.includes(actor.class)) {
    throw new Error(`sensor rig "${preset.id}" is not compatible with actor class "${actor.class}"`);
  }

  const ids = new Set<string>();
  return preset.sensors.map((template, index) => {
    const id = idFactory(template, index, preset);
    if (ids.has(id)) throw new Error(`sensor id factory produced duplicate id "${id}"`);
    ids.add(id);

    const { mount, ...sensor } = template;
    return ActorSensorSchema.parse({
      ...sensor,
      id,
      mount: resolveSensorRigMount(mount, actor),
    });
  });
}

/**
 * Sensor constructors, defined here rather than beside their schemas because
 * every default lands on a named mount: adding a sensor and then reading its
 * position back must show "Roof", not "Custom", or the named vocabulary is a
 * lie the first time an author uses it.
 */

/** A forward-facing windscreen mount scaled to the actor's authored box. */
export function defaultDashCamera(
  actor: SensorMountActor,
  id: string = newSensorId('dash_camera'),
): DashCameraSensor {
  if (!supportsDashCamera(actor)) {
    throw new Error(`dash cameras are not supported on actor class "${actor.class}"`);
  }
  return DashCameraSensorSchema.parse({
    id,
    type: 'dash_camera',
    enabled: true,
    mount: resolveSensorMountPreset('windscreen', actor),
  });
}

/**
 * Active sensors need no windscreen, so ActorSpec intentionally permits this
 * mount on every class; authored dimensions win over the reference box.
 */
export function defaultLidar(
  actor: SensorMountActor,
  id: string = newSensorId('lidar'),
): LidarSensor {
  return LidarSensorSchema.parse({
    id,
    type: 'lidar',
    enabled: true,
    mount: resolveSensorMountPreset('roof-centre', actor),
    field: { horizontalFovDeg: 360 },
  });
}

/** A forward active sensor above road spray and below the windscreen. */
export function defaultRadar(
  actor: SensorMountActor,
  id: string = newSensorId('radar'),
): RadarSensor {
  return RadarSensorSchema.parse({
    id,
    type: 'radar',
    enabled: true,
    mount: resolveSensorMountPreset('front-bumper', actor),
  });
}
