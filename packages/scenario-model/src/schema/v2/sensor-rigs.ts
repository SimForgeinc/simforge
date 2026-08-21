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
  type ActorSensor,
  type SensorMount,
  type SensorRigMount,
  type VehicleAnchor,
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

export const BUILT_IN_SENSOR_RIGS: readonly SensorRigPreset[] = Object.freeze([
  BASIC_DASH_CAMERA,
  TESLA_HW3,
  WAYMO_5TH_GEN,
  NVIDIA_SDG_AV,
  ALPAMAYO_PAI,
]);

const BUILT_IN_SENSOR_RIGS_BY_ID: Readonly<Record<string, SensorRigPreset>> = {
  'basic-dash-camera': BASIC_DASH_CAMERA,
  'tesla-hw3': TESLA_HW3,
  'waymo-5th-gen': WAYMO_5TH_GEN,
  'nvidia-sdg-av': NVIDIA_SDG_AV,
  'alpamayo-pai': ALPAMAYO_PAI,
};

export function sensorRigPreset(id: string): SensorRigPreset | undefined {
  return BUILT_IN_SENSOR_RIGS_BY_ID[id];
}

/** Resolve a fixed or vehicle-anchored preset mount to an actor-local numeric mount. */
export function resolveSensorRigMount(
  mount: SensorRigMount,
  actor: SensorRigActor,
): SensorMount {
  if ('position' in mount) return SensorMountSchema.parse(mount);

  const dims = actor.dims ?? DEFAULT_ACTOR_DIMS[actor.class];
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
