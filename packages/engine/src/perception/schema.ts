/**
 * The perception input contract: sensors, atmosphere, and map/percept divergence.
 *
 * This module is deliberately free of imports from `schema/input.ts` — the
 * dependency runs the other way, so that `SimScenarioInput` can embed these
 * without a module cycle. The handful of shared primitives are re-stated here
 * with the same grammar as the engine's core schema.
 *
 * ## What this layer is, and is not
 *
 * It is **not** a renderer or a sensor simulator. There is no image, no point
 * cloud and no noise process. What it models is the one thing a scenario can
 * actually be graded on: *whether a declared sensor reports a given actor at a
 * given tick, and if not, which physical term prevented it*. Everything here is
 * a closed-form function of the tick's geometry and the authored atmosphere, so
 * a re-run of the same input hash produces a bit-identical channel.
 *
 * ## Frames
 *
 * Mounts use the actor-local convention shared with `scenario-model`:
 * `+x` forward, `+y` up, `+z` left. The engine plane is `(x, y)` (x east,
 * y north), so a mount's `position.z` is a *left* offset in that plane and
 * `position.y` is a height above ground.
 */

import { z } from 'zod';

const finite = z.number().finite();
const nonNeg = finite.min(0);
const positive = finite.gt(0);
const unit = finite.min(0).max(1);

/**
 * The same reference-token grammar as `idSchema` in `schema/input.ts`. It is
 * restated rather than imported because `input.ts` imports *this* file.
 */
export const perceptionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/, 'id must be a printable reference token');

/** A ground-plane point in the scene frame (`{x, z}`, y-up), as elsewhere. */
const perceptionScenePointSchema = z.strictObject({ x: finite, z: finite });

/* ------------------------------------------------------------------ mounts */

/** Euler orientation in the actor-local frame, radians. Yaw is the boresight. */
export const sensorRotationSchema = z.strictObject({
  yawRad: finite.min(-Math.PI).max(Math.PI).default(0),
  pitchRad: finite.min(-Math.PI / 2).max(Math.PI / 2).default(0),
  rollRad: finite.min(-Math.PI).max(Math.PI).default(0),
});

/** Rigid mount in actor-local metres: `+x` forward, `+y` up, `+z` left. */
export const sensorMountSchema = z.strictObject({
  position: z.strictObject({ x: finite, y: finite, z: finite }),
  rotation: sensorRotationSchema.default({ yawRad: 0, pitchRad: 0, rollRad: 0 }),
});

/* ---------------------------------------------------------------- aperture */

/**
 * The hard geometric gate. A target outside the aperture is not "hard to see",
 * it is *not observable at all*, and the recorded reason says which bound it
 * fell outside — `out_of_fov` and `atmospheric_attenuation` are different
 * failures and an author grading a fog scenario must be able to tell them apart.
 */
export const sensorApertureSchema = z.strictObject({
  horizontalFovDeg: finite.gt(0).max(360).default(90),
  verticalFovDeg: finite.gt(0).max(180).default(60),
  nearM: positive.max(10).default(0.05),
  farM: positive.max(100_000).default(1_000),
}).superRefine((v, ctx) => {
  if (v.farM <= v.nearM) {
    ctx.addIssue({ code: 'custom', path: ['farM'], message: 'farM must be greater than nearM' });
  }
});

/* --------------------------------------------------------- detection model */

/**
 * How the modality responds to each degradation term. `0` means immune — that
 * is the honest way to say a radar does not care about fog, without special
 * casing radar anywhere in the evaluator.
 */
export const sensorSensitivitySchema = z.strictObject({
  /** Response to fog/precipitation extinction. */
  atmosphere: nonNeg.max(8).default(1),
  /** Response to scene illumination. */
  illumination: nonNeg.max(8).default(1),
  /** Response to a bright source near the target's bearing. */
  glare: nonNeg.max(8).default(1),
});

/**
 * The detector's own thresholds. Every one of these is a *physical* limit of
 * the device, so the degradation curves below are pure optics rather than a
 * tuned fudge:
 *
 * - `contrastThreshold` (ε) with Koschmieder's law fixes the fog detection
 *   range at `V · ln(1/ε) / 3.912`; ε = 0.02 is the classical visual-range
 *   threshold, so a nominal detector sees exactly as far as the authored
 *   `fogVisibilityM` and a better one sees proportionally further.
 * - `minAngularSizeRad` fixes the clear-air range at `targetHeight / θ_min`.
 * - `minIlluminationFrac` fixes the night range.
 */
export const detectionModelSchema = z.strictObject({
  /** Smallest apparent contrast the detector can exploit, 0..1. */
  contrastThreshold: finite.gt(0).max(1).default(0.02),
  /** Smallest resolvable angular height of a target, radians. */
  minAngularSizeRad: finite.gt(0).max(1).default(0.0045),
  /** Scene illumination, as a fraction of full daylight, below which it is blind. */
  minIlluminationFrac: finite.gt(0).max(1).default(0.02),
  /** Confidence at or above which the target is reported as `detected`. */
  detectConfidence: unit.default(0.5),
  /** Confidence at or above which the target is reported as `degraded`. */
  degradedConfidence: unit.default(0.2),
  sensitivity: sensorSensitivitySchema.default({ atmosphere: 1, illumination: 1, glare: 1 }),
  /**
   * Debounce, seconds. A changed status must persist this long before it is
   * reported. Counted in whole ticks, so it cannot drift.
   */
  latchS: nonNeg.max(10).default(0),
}).superRefine((v, ctx) => {
  if (v.degradedConfidence >= v.detectConfidence) {
    ctx.addIssue({
      code: 'custom',
      path: ['degradedConfidence'],
      message: 'degradedConfidence must be below detectConfidence',
    });
  }
});

/* ----------------------------------------------------------------- sensors */

const sensorBase = {
  id: perceptionIdSchema,
  label: z.string().min(1).max(200).optional(),
  enabled: z.boolean().default(true),
  mount: sensorMountSchema,
  aperture: sensorApertureSchema.default({ horizontalFovDeg: 90, verticalFovDeg: 60, nearM: 0.05, farM: 1_000 }),
};

/**
 * A passive imager. Everything hurts it: fog, rain, darkness, and a bright
 * source in frame.
 */
export const dashCameraSensorSchema = z.strictObject({
  ...sensorBase,
  type: z.literal('dash_camera'),
  /** Render-facing only; the detector is parameterised by angular size. */
  aspectRatio: positive.max(10).default(1.777778),
  detection: detectionModelSchema.default({
    contrastThreshold: 0.02,
    minAngularSizeRad: 0.0045,
    minIlluminationFrac: 0.02,
    detectConfidence: 0.5,
    degradedConfidence: 0.2,
    sensitivity: { atmosphere: 1, illumination: 1, glare: 1 },
    latchS: 0,
  }),
});

/** Active, so darkness is irrelevant; scatter in fog is worse than a camera's. */
export const lidarSensorSchema = z.strictObject({
  ...sensorBase,
  type: z.literal('lidar'),
  detection: detectionModelSchema.default({
    contrastThreshold: 0.02,
    minAngularSizeRad: 0.002,
    minIlluminationFrac: 0.000001,
    detectConfidence: 0.5,
    degradedConfidence: 0.2,
    sensitivity: { atmosphere: 1.6, illumination: 0, glare: 0.15 },
    latchS: 0,
  }),
});

/** Millimetre wave: nearly blind to weather and light, coarse in angle. */
export const radarSensorSchema = z.strictObject({
  ...sensorBase,
  type: z.literal('radar'),
  detection: detectionModelSchema.default({
    contrastThreshold: 0.02,
    minAngularSizeRad: 0.02,
    minIlluminationFrac: 0.000001,
    detectConfidence: 0.5,
    degradedConfidence: 0.2,
    sensitivity: { atmosphere: 0.05, illumination: 0, glare: 0 },
    latchS: 0,
  }),
});

export const simSensorSchema = z.discriminatedUnion('type', [
  dashCameraSensorSchema,
  lidarSensorSchema,
  radarSensorSchema,
]);
export type SimSensor = z.infer<typeof simSensorSchema>;
export type SensorMount = z.infer<typeof sensorMountSchema>;
export type SensorAperture = z.infer<typeof sensorApertureSchema>;
export type DetectionModel = z.infer<typeof detectionModelSchema>;

/* -------------------------------------------------------------- atmosphere */

/**
 * The air between the sensor and the world.
 *
 * `fogVisibilityM` is the meteorological visibility — the range at which a
 * black target's apparent contrast falls to 5%. It is the single number every
 * weather report already publishes, which is why it, and not an invented
 * "fog density 0..1", is the authored quantity.
 */
export const atmosphereSchema = z.strictObject({
  fogVisibilityM: positive.max(100_000).default(20_000),
  /** Precipitation rate, mm/h. Scatters and streaks, on top of the extinction. */
  precipitationMmPerH: nonNeg.max(400).default(0),
  /** Scene illumination as a fraction of full daylight. */
  illuminationFrac: unit.default(1),
  /**
   * The sun, in the engine's local `(x, y)` plane. `azimuthRad` is the compass
   * direction *towards* the sun measured CCW from `+x`; `elevationRad` is its
   * height above the horizon. A low sun ahead is the glare case; a high sun is
   * geometrically incapable of being in frame and therefore costs nothing.
   */
  sun: z.strictObject({
    azimuthRad: finite,
    elevationRad: finite.min(-Math.PI / 2).max(Math.PI / 2),
    /** Angular radius of the blinding disc, radians. */
    halfAngleRad: positive.max(1.5).default(0.35),
    /** Confidence lost when the target sits exactly on the source, 0..1. */
    intensity: unit.default(0.9),
  }).optional(),
});
export type Atmosphere = z.infer<typeof atmosphereSchema>;

/**
 * Glare from an actor's own lamps — the flashing-emergency-lights case.
 *
 * The trigger is an actor state key, not a hard-coded actor class, so
 * `set(lights.emergency, true)` on any actor is what arms it and the author
 * keeps control of which lamp counts.
 */
export const emissiveGlareSchema = z.strictObject({
  /** Actor state keys whose truthy value means "this actor is emitting". */
  stateKeys: z.array(z.string().min(1).max(64)).max(8).default(['lights.emergency']),
  halfAngleRad: positive.max(1.5).default(0.25),
  intensity: unit.default(0.85),
  /** Beyond this range the lamp no longer saturates the detector. */
  rangeM: positive.max(2_000).default(80),
  /** Height of the beacon above the emitting actor's ground plane, metres. */
  heightM: nonNeg.max(10).default(1.6),
});
export type EmissiveGlare = z.infer<typeof emissiveGlareSchema>;

/* --------------------------------------------------- map/percept divergence */

/**
 * The declarative way to say *the HD map disagrees with the world here*.
 *
 * These are recorded exposures, not forces. The engine has no lane-keeping
 * perception controller to mislead, so pretending a faded line steers the car
 * would be a fiction; what the layer does instead is make the disagreement a
 * first-class, requireable fact, so a scenario can assert "the ego drove
 * through 40 m of repainted lane that the map does not know about".
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
export const mapDivergenceKindSchema = z.enum(MAP_DIVERGENCE_KINDS);
export type MapDivergenceKind = z.infer<typeof mapDivergenceKindSchema>;

/** Where the disagreement is. Lane extents need no geometry lookup. */
export const mapDivergenceExtentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('lane'),
    rsl: z.string().min(1),
    sMin: nonNeg.optional(),
    sMax: nonNeg.optional(),
  }),
  z.strictObject({ kind: z.literal('circle'), center: perceptionScenePointSchema, radiusM: positive }),
]);
export type MapDivergenceExtent = z.infer<typeof mapDivergenceExtentSchema>;

export const mapDivergenceSchema = z.strictObject({
  id: perceptionIdSchema,
  kind: mapDivergenceKindSchema,
  extent: mapDivergenceExtentSchema,
  /** 0 = cosmetic, 1 = the map is unusable here. */
  severity: unit.default(1),
  /** For `lane_geometry_shifted`: how far the map is wrong, metres. */
  lateralErrorM: nonNeg.max(20).optional(),
  /** Actors whose exposure is tracked. Empty means every actor with a sensor. */
  observers: z.array(perceptionIdSchema).max(64).default([]),
  label: z.string().max(200).optional(),
}).superRefine((v, ctx) => {
  if (v.kind === 'lane_geometry_shifted' && v.lateralErrorM === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['lateralErrorM'],
      message: 'lane_geometry_shifted must state how far the map is wrong',
    });
  }
  if (v.extent.kind === 'lane' && v.extent.sMin !== undefined && v.extent.sMax !== undefined && v.extent.sMax <= v.extent.sMin) {
    ctx.addIssue({ code: 'custom', path: ['extent', 'sMax'], message: 'sMax must exceed sMin' });
  }
});
export type MapDivergence = z.infer<typeof mapDivergenceSchema>;

/* ------------------------------------------------------------ the envelope */

/**
 * The whole perception block. It is optional on `SimScenarioInput` on purpose:
 * parsing a historical document must not materialize a new property and thereby
 * change its input hash — the same rule `physics` and `nearMissCriteria` follow.
 */
export const perceptionConfigSchema = z.strictObject({
  atmosphere: atmosphereSchema.default({ fogVisibilityM: 20_000, precipitationMmPerH: 0, illuminationFrac: 1 }),
  emissiveGlare: emissiveGlareSchema.default({
    stateKeys: ['lights.emergency'],
    halfAngleRad: 0.25,
    intensity: 0.85,
    rangeM: 80,
    heightM: 1.6,
  }),
  mapDivergences: z.array(mapDivergenceSchema).max(64).default([]),
});
export type PerceptionConfig = z.infer<typeof perceptionConfigSchema>;

/** The block used when a document declares sensors but no `perception`. */
export const DEFAULT_PERCEPTION_CONFIG: PerceptionConfig = perceptionConfigSchema.parse({});
