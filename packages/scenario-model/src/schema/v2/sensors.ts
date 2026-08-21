/** Sensors rigidly mounted to an actor. */

import { z } from 'zod';

import { EntityIdSchema, Vec3Schema } from '../v1.js';

/** Actor classes that currently have a supported physical dash-camera mount. */
export const DASH_CAMERA_ACTOR_CLASSES = [
  'car',
  'truck',
  'bus',
  'van',
  'motorcycle',
] as const;

export type DashCameraActorClass = (typeof DASH_CAMERA_ACTOR_CLASSES)[number];

/** Euler orientation in the actor-local frame, in radians. */
export const SensorRotationSchema = z.strictObject({
  yawRad: z.number().min(-Math.PI).max(Math.PI).default(0),
  pitchRad: z.number().min(-Math.PI / 2).max(Math.PI / 2).default(0),
  rollRad: z.number().min(-Math.PI).max(Math.PI).default(0),
});

/**
 * Rigid mount in actor-local metres: +X forward, +Y up and +Z left.
 * Rotation is applied yaw (+Y), pitch (+Z), then roll (+X).
 */
export const SensorMountSchema = z.strictObject({
  position: Vec3Schema,
  rotation: SensorRotationSchema.prefault({}),
});

/**
 * A named point on an actor's authored bounding box. Rig presets use anchors
 * instead of baking one vehicle's dimensions into every physical mount.
 */
export const VehicleAnchorSchema = z.strictObject({
  longitudinal: z.enum(['front', 'center', 'rear']),
  vertical: z.enum(['bottom', 'center', 'top']),
  lateral: z.enum(['left', 'center', 'right']),
});

/**
 * A preset-only mount. `offset` is in the canonical actor frame after the
 * anchor has been resolved: +X forward, +Y up and +Z left.
 */
export const VehicleAnchorMountSchema = z.strictObject({
  anchor: VehicleAnchorSchema,
  offset: Vec3Schema.prefault({ x: 0, y: 0, z: 0 }),
  rotation: SensorRotationSchema.prefault({}),
});

/** Serializable mount accepted by a rig template before actor dimensions are known. */
export const SensorRigMountSchema = z.union([SensorMountSchema, VehicleAnchorMountSchema]);

export const DashCameraIntrinsicsSchema = z.strictObject({
  horizontalFovDeg: z.number().min(10).max(170).default(90),
  /** Vertical half-extent matters for a low sun and for a tall near target. */
  verticalFovDeg: z.number().min(5).max(170).default(60),
  nearM: z.number().positive().max(10).default(0.05),
  farM: z.number().positive().max(100_000).default(1_000),
  aspectRatio: z.number().positive().max(10).default(1.777778),
}).check((ctx) => {
  if (ctx.value.farM <= ctx.value.nearM) {
    ctx.issues.push({
      code: 'custom',
      message: 'farM must be greater than nearM',
      path: ['farM'],
      input: ctx.value.farM,
    });
  }
});

/**
 * What the detector can and cannot do — the *authored* half of perception.
 *
 * Every field is a physical limit of the device, not a tuning constant, and the
 * simulator turns each one into a closed-form range:
 *
 * - `contrastThreshold` (ε) with Koschmieder's law gives the fog range
 *   `V · ln(1/ε) / 3.912`. The default 0.02 is the classical visual-range
 *   threshold, so a nominal detector sees exactly as far as the weather report
 *   says the visibility is.
 * - `minAngularSizeRad` gives the clear-air range `targetHeight / θ`.
 * - `minIlluminationFrac` gives the night range.
 *
 * `sensitivity` is how the modality responds to each degradation. `0` means
 * immune — the honest way to say a radar does not care about fog, without the
 * simulator branching on sensor type anywhere.
 */
export const SensorSensitivitySchema = z.strictObject({
  atmosphere: z.number().min(0).max(8).default(1),
  illumination: z.number().min(0).max(8).default(1),
  glare: z.number().min(0).max(8).default(1),
});

export const DetectionModelSchema = z.strictObject({
  contrastThreshold: z.number().gt(0).max(1).default(0.02),
  minAngularSizeRad: z.number().gt(0).max(1).default(0.0045),
  minIlluminationFrac: z.number().gt(0).max(1).default(0.02),
  /** Confidence at or above which the target is reported. */
  detectConfidence: z.number().min(0).max(1).default(0.5),
  /** Confidence at or above which it is reported, but degraded. */
  degradedConfidence: z.number().min(0).max(1).default(0.2),
  sensitivity: SensorSensitivitySchema.prefault({}),
  /** Debounce, seconds; a changed status must persist this long to be reported. */
  latchS: z.number().min(0).max(10).default(0),
}).check((ctx) => {
  if (ctx.value.degradedConfidence >= ctx.value.detectConfidence) {
    ctx.issues.push({
      code: 'custom',
      message: 'degradedConfidence must be below detectConfidence',
      path: ['degradedConfidence'],
      input: ctx.value.degradedConfidence,
    });
  }
});

/** A passive imager: fog, rain, darkness and a bright source in frame all hurt it. */
export const DashCameraSensorSchema = z.strictObject({
  id: EntityIdSchema,
  type: z.literal('dash_camera'),
  label: z.string().min(1).max(200).optional(),
  enabled: z.boolean().default(true),
  mount: SensorMountSchema,
  camera: DashCameraIntrinsicsSchema.prefault({}),
  detection: DetectionModelSchema.prefault({}),
});

/** Angular/range envelope for the active modalities. */
export const ActiveSensorFieldSchema = z.strictObject({
  horizontalFovDeg: z.number().min(5).max(360).default(120),
  verticalFovDeg: z.number().min(2).max(180).default(40),
  nearM: z.number().positive().max(10).default(0.5),
  farM: z.number().positive().max(100_000).default(200),
}).check((ctx) => {
  if (ctx.value.farM <= ctx.value.nearM) {
    ctx.issues.push({
      code: 'custom', message: 'farM must be greater than nearM', path: ['farM'], input: ctx.value.farM,
    });
  }
});

/** Active, so darkness is irrelevant; scatter in fog is worse than a camera's. */
export const LidarSensorSchema = z.strictObject({
  id: EntityIdSchema,
  type: z.literal('lidar'),
  label: z.string().min(1).max(200).optional(),
  enabled: z.boolean().default(true),
  mount: SensorMountSchema,
  field: ActiveSensorFieldSchema.prefault({}),
  detection: DetectionModelSchema.prefault({
    minAngularSizeRad: 0.002,
    minIlluminationFrac: 0.000001,
    sensitivity: { atmosphere: 1.6, illumination: 0, glare: 0.15 },
  }),
});

/** Millimetre wave: nearly blind to weather and light, coarse in angle. */
export const RadarSensorSchema = z.strictObject({
  id: EntityIdSchema,
  type: z.literal('radar'),
  label: z.string().min(1).max(200).optional(),
  enabled: z.boolean().default(true),
  mount: SensorMountSchema,
  field: ActiveSensorFieldSchema.prefault({ horizontalFovDeg: 40, verticalFovDeg: 20 }),
  detection: DetectionModelSchema.prefault({
    minAngularSizeRad: 0.02,
    minIlluminationFrac: 0.000001,
    sensitivity: { atmosphere: 0.05, illumination: 0, glare: 0 },
  }),
});

export const ActorSensorSchema = z.discriminatedUnion('type', [
  DashCameraSensorSchema,
  LidarSensorSchema,
  RadarSensorSchema,
]);

export type SensorRotation = z.infer<typeof SensorRotationSchema>;
export type SensorMount = z.infer<typeof SensorMountSchema>;
export type VehicleAnchor = z.infer<typeof VehicleAnchorSchema>;
export type VehicleAnchorMount = z.infer<typeof VehicleAnchorMountSchema>;
export type SensorRigMount = z.infer<typeof SensorRigMountSchema>;
export type DashCameraIntrinsics = z.infer<typeof DashCameraIntrinsicsSchema>;
export type DashCameraSensor = z.infer<typeof DashCameraSensorSchema>;
export type LidarSensor = z.infer<typeof LidarSensorSchema>;
export type RadarSensor = z.infer<typeof RadarSensorSchema>;
export type ActiveSensorField = z.infer<typeof ActiveSensorFieldSchema>;
export type SensorDetectionModel = z.infer<typeof DetectionModelSchema>;
export type SensorSensitivity = z.infer<typeof SensorSensitivitySchema>;
export type ActorSensor = z.infer<typeof ActorSensorSchema>;

/**
 * Convert a resolved canonical mount into the Three.js scene frame.
 *
 * Reflecting +Z-left to scene -Z also conjugates the authored Euler rotations:
 * yaw and roll change sign while pitch remains unchanged.
 */
export function sensorMountScenePose(mount: SensorMount): SensorMount {
  return {
    position: {
      x: mount.position.x,
      y: mount.position.y,
      z: -mount.position.z,
    },
    rotation: {
      yawRad: -mount.rotation.yawRad,
      pitchRad: mount.rotation.pitchRad,
      rollRad: -mount.rotation.rollRad,
    },
  };
}

/**
 * The angular/range envelope of any sensor, whatever its modality names the
 * block. Consumers that only need "how far, how wide" read this instead of
 * switching on `type`.
 */
export function sensorAperture(sensor: ActorSensor): {
  horizontalFovDeg: number;
  verticalFovDeg: number;
  nearM: number;
  farM: number;
} {
  if (sensor.type === 'dash_camera') {
    return {
      horizontalFovDeg: sensor.camera.horizontalFovDeg,
      verticalFovDeg: sensor.camera.verticalFovDeg,
      nearM: sensor.camera.nearM,
      farM: sensor.camera.farM,
    };
  }
  return { ...sensor.field };
}

export function isDashCamera(sensor: ActorSensor): sensor is DashCameraSensor {
  return sensor.type === 'dash_camera';
}

/** Deterministic discovery: authoring order, optionally including disabled sensors. */
export function dashCameras(
  actor: { sensors: readonly ActorSensor[] },
  options: { includeDisabled?: boolean } = {},
): DashCameraSensor[] {
  return actor.sensors.filter(
    (sensor): sensor is DashCameraSensor =>
      isDashCamera(sensor) && (options.includeDisabled === true || sensor.enabled),
  );
}

export function firstEnabledDashCamera(
  actor: { sensors: readonly ActorSensor[] },
): DashCameraSensor | undefined {
  return dashCameras(actor)[0];
}

export interface ActorForDashCamera {
  class: string;
  dims?: { length: number; width: number; height: number };
}

/* -------------------------------------------------- map/percept divergence */

/**
 * The declarative way to say *the HD map disagrees with the world here*.
 *
 * This is a typed, first-class template field rather than a bag under
 * `environment.extensions`, deliberately. `extensions` is documented as
 * "nothing in this package interprets these" — hiding a first-class fact in an
 * uninterpreted bag is exactly the undiscoverability failure this repo keeps
 * running into (reverse motion reachable only through
 * `extensions.motionSemantics` and therefore never used; a whole construction
 * catalog under names no author reaches for; `sensors` silently stripped by the
 * engine's input parser). Adding the typed field, or dropping the capability,
 * are the only two honest options.
 *
 * Exposure is **recorded, not fed back**. The simulator has no lane-keeping
 * perception controller to mislead, so manufacturing a steering error out of a
 * faded line would be a fiction dressed as a measurement. What the layer gives
 * an author is the ability to *require* that the ego drove through the
 * disagreement, which is a fact, and to grade on it.
 */
export const MAP_DIVERGENCE_KINDS = [
  /** Markings present but low contrast — worn paint. */
  'lane_markings_faded',
  /** Markings hidden by snow, mud or debris. */
  'lane_markings_obscured',
  /** Freshly painted lines that do not agree with the HD map. */
  'lane_markings_repainted',
  /** The map's centreline is laterally displaced from the built lane. */
  'lane_geometry_shifted',
  /** The world has a usable lane the map does not contain. */
  'lane_missing_from_map',
  /** The map contains a lane that no longer exists in the world. */
  'lane_absent_in_world',
  /** Retroreflective delineators pointing the wrong way. */
  'reflectors_misaligned',
  /** A surface classified as the wrong thing — a private driveway read as road. */
  'surface_misclassified',
] as const;

export const MapDivergenceKindSchema = z.enum(MAP_DIVERGENCE_KINDS);

/**
 * Where the disagreement is, in the template's portable vocabulary.
 *
 * `corridor` is a longitudinal interval of the matched corridor as a fraction
 * of its length, so it retargets onto any site; `aroundRole` follows an actor,
 * for the cases where the divergence is defined relative to a participant.
 */
export const MapDivergenceExtentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('corridor'),
    /** Start and end as fractions of the matched corridor, 0..1. */
    fromFrac: z.number().min(0).max(1).default(0),
    toFrac: z.number().min(0).max(1).default(1),
    /** Restrict to one lane index in the corridor's lateral frame. */
    lane: z.number().int().min(-8).max(8).optional(),
  }).check((ctx) => {
    if (ctx.value.toFrac <= ctx.value.fromFrac) {
      ctx.issues.push({
        code: 'custom', message: 'toFrac must exceed fromFrac', path: ['toFrac'], input: ctx.value.toFrac,
      });
    }
  }),
  z.strictObject({
    kind: z.literal('aroundRole'),
    role: z.string().min(1).max(64),
    radiusM: z.number().positive().max(500).default(25),
  }),
]);

export const MapDivergenceSchema = z.strictObject({
  id: EntityIdSchema,
  kind: MapDivergenceKindSchema,
  extent: MapDivergenceExtentSchema,
  /** 0 = cosmetic, 1 = the map is unusable here. */
  severity: z.number().min(0).max(1).default(1),
  /** For `lane_geometry_shifted`: how far the map is wrong, metres. */
  lateralErrorM: z.number().min(0).max(20).optional(),
  /** Roles whose exposure is tracked. Empty means every actor. */
  observers: z.array(z.string().min(1).max(64)).max(64).default([]),
  label: z.string().max(200).optional(),
}).check((ctx) => {
  if (ctx.value.kind === 'lane_geometry_shifted' && ctx.value.lateralErrorM === undefined) {
    ctx.issues.push({
      code: 'custom',
      message: 'lane_geometry_shifted must state how far the map is wrong (lateralErrorM)',
      path: ['lateralErrorM'],
      input: ctx.value.lateralErrorM,
    });
  }
});

/**
 * The template's `perception` block.
 *
 * The *atmosphere* is deliberately absent: fog, rain, darkness and sun angle
 * are already `environment.weather`, `environment.sunElevationDeg` and
 * `environment.sunAzimuthDeg`, and the materializer derives the sensor-facing
 * numbers from those. Re-declaring them here would create two sources of truth
 * for the same fact.
 */
export const TemplatePerceptionSchema = z.strictObject({
  mapDivergences: z.array(MapDivergenceSchema).max(64).default([]),
});

export type MapDivergence = z.infer<typeof MapDivergenceSchema>;
export type MapDivergenceKind = z.infer<typeof MapDivergenceKindSchema>;
export type MapDivergenceExtent = z.infer<typeof MapDivergenceExtentSchema>;
export type TemplatePerception = z.infer<typeof TemplatePerceptionSchema>;

export function supportsDashCamera(actor: Pick<ActorForDashCamera, 'class'>): boolean {
  return (DASH_CAMERA_ACTOR_CLASSES as readonly string[]).includes(actor.class);
}

/** Stable, schema-legal sensor id. It is generated once when the sensor is added. */
export function newSensorId(): string {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `dash-camera-${time}-${random}`.slice(0, 64);
}

/** A forward-facing windscreen/dash mount scaled to the actor's authored box. */
export function defaultDashCamera(actor: ActorForDashCamera, id: string = newSensorId()): DashCameraSensor {
  if (!supportsDashCamera(actor)) {
    throw new Error(`dash cameras are not supported on actor class "${actor.class}"`);
  }
  const length = actor.dims?.length ?? 4.8;
  const height = actor.dims?.height ?? 1.5;
  return {
    id,
    type: 'dash_camera',
    enabled: true,
    mount: {
      position: {
        x: Math.max(0, length / 2 - 0.35),
        y: Math.max(0.5, height * 0.72),
        z: 0,
      },
      rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
    },
    camera: {
      horizontalFovDeg: 90,
      verticalFovDeg: 60,
      nearM: 0.05,
      farM: 1_000,
      aspectRatio: 1.777778,
    },
    detection: DetectionModelSchema.parse({}),
  };
}
