/**
 * Layer 5 of the PEGASUS stack: environment as variation axes.
 *
 * Presets rather than free numbers, because the renderer, the friction model
 * and the sensor model all have to agree on what "heavy rain" means; a preset
 * is a name they can each resolve, a raw `rainIntensity: 0.63` is three
 * independent guesses. The numeric fields exist for the cases where the
 * *criticality* depends on the exact value (sun-azimuth glare, friction) and
 * they accept expressions, so `env.frictionScale = param.friction` makes
 * friction a first-class sampled axis.
 *
 * `extensions` keeps this block genuinely extensible: a renderer-specific knob
 * lands there without a schema version bump, and nothing in this package reads
 * it.
 */

import { z } from 'zod';

import { NumberOrExprSchema } from '../../expr/index.js';
import { FeatureRefSchema, V2ExtensionsSchema, V2_ID_PATTERN } from './common.js';

/** Id of a {@link SurfacePatchSchema}. Same syntax as every other v2 id. */
export const SurfaceIdSchema = z
  .string()
  .regex(V2_ID_PATTERN, 'surface patch id must start with a letter and use only [A-Za-z0-9_-], max 64 chars');

/** Weather presets. Ordered roughly by severity. */
export const WEATHER_PRESETS = [
  'clear',
  'cloudy',
  'overcast',
  'light_rain',
  'heavy_rain',
  'wet_road',
  'fog_light',
  'fog_dense',
  'snow',
  'sleet',
] as const;

/** Time-of-day presets. `night_lit` is night with working street lighting. */
export const TIME_OF_DAY_PRESETS = [
  'dawn',
  'morning',
  'noon',
  'afternoon',
  'dusk',
  'night',
  'night_lit',
] as const;

/** Weather preset. */
export const WeatherSchema = z.enum(WEATHER_PRESETS);
/** Time-of-day preset. */
export const TimeOfDaySchema = z.enum(TIME_OF_DAY_PRESETS);

/**
 * What is on the road, where the road is not simply the road.
 *
 * Same argument as the weather presets: the renderer, the friction model and
 * the sensor model all have to agree on what "black ice" means, so a preset is
 * a name they can each resolve. `grit_treated` is the one entry that *improves*
 * grip — a salted strip through a snowfield is a real thing an author needs.
 */
export const SURFACE_PATCH_KINDS = [
  'ice',
  'packed_snow',
  'standing_water',
  'wet_leaves',
  'loose_gravel',
  'sand',
  'spilled_oil',
  'polished_asphalt',
  'grit_treated',
] as const;

/** Surface covering preset. */
export const SurfacePatchKindSchema = z.enum(SURFACE_PATCH_KINDS);

/**
 * A localised patch of road with different grip.
 *
 * `frictionScale` is scene-wide, which is fine for weather and useless for
 * everything else: "black ice on the bend", "a flooded dip", "wet leaves under
 * the trees" are all *regions*, and making the whole world slippery instead is
 * a different scenario in which every actor slides and nothing is a surprise.
 *
 * Positioned exactly like a role or a prop — frame-relative `atM` along the
 * corridor, optionally anchored to a named anchor feature — so "ice on the
 * bend" survives retargeting onto a map that has a different bend. It is
 * deliberately **not** an anchor clause: no map carries surface data, so a
 * `surface_patch` predicate would be unmatchable everywhere and would cost
 * every site. The scenario brings its own ice.
 */
export const SurfacePatchSchema = z.strictObject({
  id: SurfaceIdSchema,
  kind: SurfacePatchKindSchema,
  label: z.string().max(200).optional(),
  /** Start of the patch along the corridor, metres from the frame origin. Negative is upstream. */
  atM: NumberOrExprSchema,
  /** Longitudinal extent, metres. */
  lengthM: NumberOrExprSchema,
  /**
   * Anchor `atM` to a feature instead of the frame origin — "on the bend",
   * "in the dip", "across the junction". Same mechanism as a prop's `feature`.
   */
  feature: FeatureRefSchema.optional(),
  /**
   * Same-direction lane indices the patch covers, using the role convention
   * (0 = reference lane, +1 one lane left). Empty covers every same-direction
   * lane, which is what weather-like coverings actually do.
   */
  laneOffsets: z.array(z.number().int().min(-6).max(6)).max(12).default([]),
  /**
   * Overrides the coefficient implied by `kind`. Set it when the scenario is
   * *about* the exact value; leave it out and the covering decides.
   */
  frictionScale: NumberOrExprSchema.optional(),
  /**
   * Blend distance at each end, metres. A grip discontinuity between two ticks
   * is a step change in the friction circle and reads as an implausible jerk;
   * the default is nevertheless a hard edge, because a sheet of ice has one.
   */
  edgeTaperM: NumberOrExprSchema.default(0),
  /** `cosmetic` patches may be dropped by degradation; the hazard itself never should be. */
  essentiality: z.enum(['required', 'preferred', 'cosmetic']).default('required'),
  extensions: V2ExtensionsSchema.optional(),
});

/** The `environment` block. */
export const EnvironmentSchema = z.strictObject({
  weather: WeatherSchema.default('cloudy'),
  timeOfDay: TimeOfDaySchema.default('dusk'),
  /**
   * Tyre-road friction multiplier against the map's nominal value. 1 = dry
   * asphalt. Set it explicitly when the scenario is *about* friction; leave it
   * out and the preset decides.
   */
  frictionScale: NumberOrExprSchema.optional(),
  /**
   * Sun azimuth in degrees clockwise from the corridor's forward direction —
   * *frame-relative*, not compass-absolute, so a glare scenario stays a glare
   * scenario when it retargets onto a road that runs the other way.
   */
  sunAzimuthDeg: NumberOrExprSchema.optional(),
  /** Sun elevation above the horizon, degrees. Low sun is the glare case. */
  sunElevationDeg: NumberOrExprSchema.optional(),
  /**
   * Localised grip. `frictionScale` above is the whole scene; these are the
   * places where the road is different from the rest of the road.
   */
  surfacePatches: z.array(SurfacePatchSchema).max(8).default([]),
  /** Renderer/sensor-specific knobs. Nothing in this package interprets these. */
  extensions: V2ExtensionsSchema.optional(),
});

/** Resolved environment block. */
export type Environment = z.infer<typeof EnvironmentSchema>;
/** The `environment` block as authored. */
export type EnvironmentInput = z.input<typeof EnvironmentSchema>;
/** A localised surface patch. */
export type SurfacePatch = z.infer<typeof SurfacePatchSchema>;
/** A localised surface patch as authored. */
export type SurfacePatchInput = z.input<typeof SurfacePatchSchema>;
/** Surface covering preset. */
export type SurfacePatchKind = z.infer<typeof SurfacePatchKindSchema>;
/** Weather preset. */
export type Weather = z.infer<typeof WeatherSchema>;
/** Time-of-day preset. */
export type TimeOfDay = z.infer<typeof TimeOfDaySchema>;
