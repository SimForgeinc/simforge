/**
 * Lowering the authored perception layer onto a concrete site.
 *
 * Two jobs, both pure:
 *
 * 1. **Sensors.** A role's `sensors` are portable device descriptions; the
 *    engine wants one uniform angular envelope whatever the modality names its
 *    block. Until this existed the engine's input parser *silently stripped*
 *    the field, so a template could declare a dash camera, validate clean, and
 *    simulate as though it had said nothing.
 *
 * 2. **Atmosphere.** Fog, rain, darkness and sun angle are already authored in
 *    `environment`, so they are derived from there rather than re-declared.
 *    Two sources of truth for the same fact is how a "heavy rain" preset and a
 *    `rainIntensity: 0.63` end up disagreeing.
 *
 * The mapping from preset to metres is a table in one place, on purpose: the
 * renderer, the friction model and the sensor model all have to agree on what
 * `fog_dense` means, and a preset is a name they can each resolve.
 */

import type { Environment, ActorSensor, MapDivergence, NumberOrExpr } from '@simforge/scenario';
import { sensorAperture } from '@simforge/scenario';
import type { PerceptionConfig, SimSensor } from '@simforge/engine';

/**
 * Meteorological visibility, metres, per weather preset.
 *
 * These are the ordinary meanings of the words: a "dense fog" warning is issued
 * below about 50 m, "light fog"/mist sits in the low hundreds, and heavy rain
 * cuts contrast to a few hundred metres. `20_000` is a clear day.
 */
export const WEATHER_VISIBILITY_M: Readonly<Record<string, number>> = {
  clear: 20_000,
  cloudy: 20_000,
  overcast: 15_000,
  light_rain: 4_000,
  heavy_rain: 800,
  wet_road: 8_000,
  fog_light: 400,
  fog_dense: 60,
  snow: 500,
  sleet: 900,
};

/** Precipitation rate, mm/h, per weather preset. */
export const WEATHER_PRECIPITATION_MM_PER_H: Readonly<Record<string, number>> = {
  light_rain: 2.5,
  heavy_rain: 30,
  sleet: 8,
  snow: 5,
};

/** Scene illumination as a fraction of full daylight, per time-of-day preset. */
export const TIME_OF_DAY_ILLUMINATION: Readonly<Record<string, number>> = {
  dawn: 0.25,
  morning: 0.9,
  noon: 1,
  afternoon: 0.9,
  dusk: 0.2,
  night: 0.012,
  night_lit: 0.05,
};

/** Overcast and fog also cost light, on top of the hour. */
const WEATHER_ILLUMINATION_SCALE: Readonly<Record<string, number>> = {
  overcast: 0.6,
  cloudy: 0.8,
  heavy_rain: 0.45,
  fog_light: 0.6,
  fog_dense: 0.35,
  snow: 0.7,
  sleet: 0.6,
};

export type NumberResolver = (value: NumberOrExpr, path: string) => number;

/**
 * Derive the sensor-facing atmosphere from the authored `environment` block.
 *
 * The sun becomes a glare source only when it is *above* the horizon; a high
 * sun is geometrically incapable of being in frame and therefore costs nothing,
 * which is why a sunset scenario needs no special case — it is simply a small
 * `sunElevationDeg`.
 *
 * The corridor-relative azimuth convention is preserved: `sunAzimuthDeg` is
 * measured clockwise from the corridor's forward direction, so it is rotated
 * into the engine's `(x, y)` plane against the reference heading and a glare
 * scenario stays a glare scenario on a road that runs the other way.
 */
export function atmosphereFromEnvironment(
  environment: Environment,
  referenceHeadingRad: number,
  evaluateNumber: NumberResolver,
): PerceptionConfig['atmosphere'] {
  const fogVisibilityM = WEATHER_VISIBILITY_M[environment.weather] ?? 20_000;
  const precipitationMmPerH = WEATHER_PRECIPITATION_MM_PER_H[environment.weather] ?? 0;
  const illuminationFrac = Math.min(
    1,
    Math.max(
      0.001,
      (TIME_OF_DAY_ILLUMINATION[environment.timeOfDay] ?? 1)
        * (WEATHER_ILLUMINATION_SCALE[environment.weather] ?? 1),
    ),
  );
  const elevationDeg = environment.sunElevationDeg === undefined
    ? null
    : evaluateNumber(environment.sunElevationDeg, 'environment.sunElevationDeg');
  const azimuthDeg = environment.sunAzimuthDeg === undefined
    ? null
    : evaluateNumber(environment.sunAzimuthDeg, 'environment.sunAzimuthDeg');
  const sun = elevationDeg !== null && azimuthDeg !== null && elevationDeg > 0
    ? {
        // Clockwise from corridor-forward, into CCW-from-+x engine bearings.
        azimuthRad: referenceHeadingRad - (azimuthDeg * Math.PI) / 180,
        elevationRad: (elevationDeg * Math.PI) / 180,
        halfAngleRad: 0.35,
        intensity: 0.9,
      }
    : undefined;
  return {
    fogVisibilityM,
    precipitationMmPerH,
    illuminationFrac,
    ...(sun ? { sun } : {}),
  };
}

/**
 * Lower one authored sensor to the engine's uniform shape.
 *
 * The modalities name their angular block differently (`camera` vs `field`)
 * because a camera has an aspect ratio and a radar does not; `sensorAperture`
 * is the shared accessor, so nothing here switches on `type` except to carry
 * the one camera-only field through.
 */
export function lowerSensor(sensor: ActorSensor): SimSensor {
  const aperture = sensorAperture(sensor);
  return {
    id: sensor.id,
    type: sensor.type,
    ...(sensor.label === undefined ? {} : { label: sensor.label }),
    enabled: sensor.enabled,
    mount: {
      position: { ...sensor.mount.position },
      rotation: { ...sensor.mount.rotation },
    },
    aperture: { ...aperture },
    ...(sensor.type === 'dash_camera' ? { aspectRatio: sensor.camera.aspectRatio } : {}),
    detection: {
      contrastThreshold: sensor.detection.contrastThreshold,
      minAngularSizeRad: sensor.detection.minAngularSizeRad,
      minIlluminationFrac: sensor.detection.minIlluminationFrac,
      detectConfidence: sensor.detection.detectConfidence,
      degradedConfidence: sensor.detection.degradedConfidence,
      sensitivity: { ...sensor.detection.sensitivity },
      latchS: sensor.detection.latchS,
    },
  } as SimSensor;
}

/** Lane windows a corridor-relative divergence covers, one per crossed lane. */
export interface DivergenceWindow {
  readonly rsl: string;
  readonly sMin: number;
  readonly sMax: number;
}

/**
 * Lower one declared divergence onto concrete extents.
 *
 * `corridor` is a longitudinal fraction of the reference chain, so it becomes
 * one lane window per crossed leg — `s` restarts on every lane of a chain, so
 * the interval cannot be carried across as a pair of numbers. `aroundRole`
 * becomes a circle at the role's materialized pose.
 */
export function lowerMapDivergence(
  divergence: MapDivergence,
  resolve: {
    windows: (fromFrac: number, toFrac: number, lane: number | undefined) => DivergenceWindow[];
    rolePose: (role: string) => { x: number; z: number } | undefined;
  },
): PerceptionConfig['mapDivergences'] {
  const common = {
    kind: divergence.kind,
    severity: divergence.severity,
    ...(divergence.lateralErrorM === undefined ? {} : { lateralErrorM: divergence.lateralErrorM }),
    observers: [...divergence.observers],
    ...(divergence.label === undefined ? {} : { label: divergence.label }),
  };
  if (divergence.extent.kind === 'aroundRole') {
    const pose = resolve.rolePose(divergence.extent.role);
    if (!pose) return [];
    return [{
      ...common,
      id: divergence.id,
      extent: { kind: 'circle' as const, center: { x: pose.x, z: pose.z }, radiusM: divergence.extent.radiusM },
    }];
  }
  const windows = resolve.windows(
    divergence.extent.fromFrac,
    divergence.extent.toFrac,
    divergence.extent.lane,
  );
  return windows.map((window, index) => ({
    ...common,
    id: windows.length === 1 ? divergence.id : `${divergence.id}:${index}`,
    extent: { kind: 'lane' as const, rsl: window.rsl, sMin: window.sMin, sMax: window.sMax },
  }));
}
