import { z } from 'zod';

import type { Environment, TimeOfDay, Weather } from '@simforge-oss/scenario';
import {
  LIGHTING_EXTENSION_KEY,
  SCENE_TIME_EXTENSION_KEY,
  resolveEditorLightingOverrides,
} from '@simforge-oss/scenario/contracts';

/**
 * The scenario's environment as the native renderer's `Lighting` and
 * `RenderProfileConfig`.
 *
 * This is the Lookdev Lab's `settings.renderer_lighting` for the platform:
 * the same weather presets, the same NOAA solar model at the corpus site, the
 * same cinematic profile. A campaign render of "cloudy at 19:55" is the lab's
 * "cloudy at 19:55". Every value the renderer would otherwise default is sent
 * explicitly, so the manifest names the look.
 */

/** Corpus site (Palo Alto), the lab's `SITE_*`. */
export const SITE_LAT_DEG = 37.44;
export const SITE_LON_DEG = -122.14;
/** Scene clock is PDT. */
export const SITE_TZ_OFFSET_H = -7;
/** Day of year the scene clock runs on when the scenario does not say. */
export const DEFAULT_DAY_OF_YEAR = 172;

/** Renderer weather label (`render_core::weather::Weather`). */
export type NativeWeather = 'clear' | 'cloudy' | 'overcast' | 'fog' | 'rain';

export interface WeatherPreset {
  readonly weather: NativeWeather;
  readonly cloudCover: number;
  readonly visibilityM: number;
  readonly haze: number;
  readonly wetness: number;
  readonly turbidity: number;
  readonly cloudType: number;
  readonly cloudBaseM: number;
  readonly cloudTopM: number;
  readonly cloudDensity: number;
}

/** The lab's `WEATHER_PRESETS`, keyed by renderer label. */
export const WEATHER_PRESETS: Readonly<Record<NativeWeather, WeatherPreset>> = {
  clear: { weather: 'clear', cloudCover: 0, visibilityM: 80_000, haze: 0, wetness: 0, turbidity: 2.4, cloudType: 0.85, cloudBaseM: 1200, cloudTopM: 2800, cloudDensity: 1 },
  cloudy: { weather: 'cloudy', cloudCover: 0.45, visibilityM: 30_000, haze: 0.03, wetness: 0, turbidity: 2.8, cloudType: 0.85, cloudBaseM: 1200, cloudTopM: 2800, cloudDensity: 1 },
  overcast: { weather: 'overcast', cloudCover: 0.95, visibilityM: 12_000, haze: 0.10, wetness: 0.05, turbidity: 3.2, cloudType: 0.15, cloudBaseM: 700, cloudTopM: 1900, cloudDensity: 1.4 },
  fog: { weather: 'fog', cloudCover: 0.75, visibilityM: 150, haze: 0.20, wetness: 0.15, turbidity: 3.0, cloudType: 0.10, cloudBaseM: 400, cloudTopM: 1200, cloudDensity: 1.4 },
  rain: { weather: 'rain', cloudCover: 0.90, visibilityM: 3_000, haze: 0.10, wetness: 0.85, turbidity: 2.6, cloudType: 0.30, cloudBaseM: 500, cloudTopM: 2600, cloudDensity: 1.8 },
};

/**
 * Scenario weather → renderer label. The scenario has ten presets and the
 * renderer five air-mass states; the extra scenario presets are the renderer
 * state plus a wetness/visibility adjustment.
 */
export function weatherPreset(weather: Weather): WeatherPreset {
  switch (weather) {
    case 'clear': return WEATHER_PRESETS.clear;
    case 'cloudy': return WEATHER_PRESETS.cloudy;
    case 'overcast': return WEATHER_PRESETS.overcast;
    case 'light_rain': return { ...WEATHER_PRESETS.rain, cloudCover: 0.85, visibilityM: 8_000, wetness: 0.6 };
    case 'heavy_rain': return { ...WEATHER_PRESETS.rain, visibilityM: 1_500, wetness: 1 };
    case 'wet_road': return { ...WEATHER_PRESETS.overcast, wetness: 0.7 };
    case 'fog_light': return { ...WEATHER_PRESETS.fog, cloudCover: 0.6, visibilityM: 600, wetness: 0.1 };
    case 'fog_dense': return WEATHER_PRESETS.fog;
    // Snow and sleet have no air-mass state of their own in the renderer:
    // an overcast sky with a wet road is what they look like from the car.
    case 'snow': return { ...WEATHER_PRESETS.overcast, visibilityM: 2_000, wetness: 0.3 };
    case 'sleet': return { ...WEATHER_PRESETS.overcast, visibilityM: 3_000, wetness: 0.8 };
  }
}

/** Studio's slider minutes for a time-of-day preset (`scene-time.ts`). */
export const PRESET_MINUTES: Readonly<Record<TimeOfDay, number>> = {
  dawn: 6 * 60,
  morning: 9 * 60,
  noon: 12 * 60,
  afternoon: 15 * 60,
  dusk: 18 * 60,
  night: 0,
  night_lit: 21 * 60,
};

/** Studio's `org.simforge.sceneTime.v1` block: the exact authored clock. */
const SceneTimeBlock = z.object({ minutes: z.number().finite() }).passthrough();

/** Scene clock in minutes past midnight PDT: the exact authored time, else the preset's. */
export function sceneMinutes(environment: Environment): number {
  const stored = SceneTimeBlock.safeParse(environment.extensions?.[SCENE_TIME_EXTENSION_KEY]);
  if (stored.success) return ((stored.data.minutes % 1440) + 1440) % 1440;
  return PRESET_MINUTES[environment.timeOfDay];
}

/**
 * NOAA low-precision solar position at the corpus site. Elevation and
 * compass azimuth in degrees; the lab's `solar_position`, to the same
 * three decimals.
 */
export function solarPosition(timeMinutes: number, dayOfYear = DEFAULT_DAY_OF_YEAR): { elevationDeg: number; azimuthDeg: number } {
  const gamma = 2 * Math.PI / 365 * (dayOfYear - 1 + (timeMinutes / 60 - 12) / 24);
  const eqtime = 229.18 * (
    0.000075
    + 0.001868 * Math.cos(gamma)
    - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma)
    - 0.040849 * Math.sin(2 * gamma)
  );
  const decl = 0.006918
    - 0.399912 * Math.cos(gamma)
    + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma)
    + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma)
    + 0.00148 * Math.sin(3 * gamma);
  const timeOffset = eqtime + 4 * SITE_LON_DEG - 60 * SITE_TZ_OFFSET_H;
  const trueSolar = timeMinutes + timeOffset;
  const hourAngle = (trueSolar / 4 - 180) * Math.PI / 180;
  const lat = SITE_LAT_DEG * Math.PI / 180;
  const cosZenith = Math.max(-1, Math.min(1,
    Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)));
  const zenith = Math.acos(cosZenith);
  const elevation = 90 - zenith * 180 / Math.PI;
  const denom = Math.cos(lat) * Math.sin(zenith);
  let azimuth: number;
  if (Math.abs(denom) < 1e-9) {
    azimuth = 180;
  } else {
    const cosAz = Math.max(-1, Math.min(1, (Math.sin(lat) * cosZenith - Math.sin(decl)) / denom));
    azimuth = Math.acos(cosAz) * 180 / Math.PI;
    if (hourAngle > 0) azimuth = 360 - azimuth;
  }
  return {
    elevationDeg: Math.round(elevation * 1000) / 1000,
    azimuthDeg: Math.round((((azimuth % 360) + 360) % 360) * 1000) / 1000,
  };
}

/** `render_core::engine::Lighting`, wire form. */
export interface NativeLighting {
  readonly sun_elev_deg: number;
  readonly sun_azim_deg: number;
  readonly rung: 3;
  readonly weather: NativeWeather;
  readonly sun_scale: number;
  readonly ambient_scale: number;
  readonly sky_scale: number;
  readonly ev100_bias: number;
  readonly cloud_cover: number;
  readonly haze: number;
  readonly wetness: number;
  readonly atmosphere: true;
  readonly turbidity: number;
  readonly ozone_du: number;
  readonly air_density: number;
  readonly visibility_m: number;
  readonly night: {
    readonly utc_year: number;
    readonly utc_day_of_year: number;
    readonly utc_minutes: number;
    readonly latitude_deg: number;
    readonly longitude_deg: number;
    readonly elevation_m: number;
    readonly natural_ambient_lux: number;
    readonly urban_skyglow_lux: number;
    readonly limiting_magnitude: number;
    readonly fixture_budget: number;
    readonly fixture_shadow_budget: number;
    readonly window_mode: 'synthetic_facade';
    readonly cloud_quality: 'scalable';
    readonly cloud_wind_mps: readonly [number, number];
    readonly cloud_density: number;
    readonly cloud_type: number;
    readonly cloud_base_m: number;
    readonly cloud_top_m: number;
    readonly sky_display_lift: number;
    readonly exposure_offset_stops: number;
    readonly sky_debug_mode: 0;
    /** Cloud clock advance per render, s: the lab's clip setting at 30 fps. */
    readonly cloud_fixed_step_s: number;
  };
}

/** `render_core::profiles::RenderProfileConfig`, wire form: the lab's cinematic defaults. */
export const CINEMATIC_PROFILE_CONFIG = {
  cinematic: {
    aa: 'taa',
    ssr: true,
    ssao: true,
    ssaoUltra: true,
    chromaticAberration: 0,
    vignetteIntensity: 0.16,
    lensDistortion: 0.008,
    dofEnabled: false,
    dofApertureFStops: 8,
    dofFocalDistanceM: 28,
    motionShutterAngle: 0,
    motionSamples: 8,
    bloomIntensity: 0.1,
    gradingExposure: 0.35,
    gradingTemperature: 0,
    gradingTint: 0,
    gradingPostSaturation: 0.98,
    gradingContrast: 1.02,
    toneMap: 'agx',
  },
} as const;

export interface NativeLightingResolution {
  readonly lighting: NativeLighting;
  readonly profileConfig: typeof CINEMATIC_PROFILE_CONFIG;
  /** What the mapping decided, for the render manifest. */
  readonly provenance: {
    readonly weather: Weather;
    readonly preset: NativeWeather;
    readonly sceneMinutes: number;
    readonly dayOfYear: number;
    readonly sunSource: 'solar-model';
    readonly overrides: Readonly<Record<string, number>>;
  };
}

/**
 * Resolve a scenario environment into the renderer's lighting.
 *
 * The sun always comes from the solar model at the scene clock — the same
 * NOAA position the lab uses — not from the authored `sunElevationDeg`,
 * which Studio derives from a sinusoid and whose azimuth is corridor-relative.
 * Studio's lighting block (`org.simforge.lighting.v1`) is honoured as the
 * lab's normalized knobs: `sun`/`ambient` scale the resolved sources,
 * `exposure` is a bias on the meter, `visibilityM` and `haze` replace the
 * preset's air. `sky` and `sunWarmth` have no physical counterpart under the
 * atmosphere and are reported, not applied.
 */
export function resolveNativeLighting(
  environment: Environment,
  options: { readonly dayOfYear?: number; readonly cloudFixedStepS?: number } = {},
): NativeLightingResolution {
  const preset = weatherPreset(environment.weather);
  const minutes = sceneMinutes(environment);
  const dayOfYear = options.dayOfYear ?? DEFAULT_DAY_OF_YEAR;
  const sun = solarPosition(minutes, dayOfYear);
  const overrides = resolveEditorLightingOverrides(environment);
  const utcMinutes = (minutes - 60 * SITE_TZ_OFFSET_H) % 1440;
  const utcDay = 1 + ((dayOfYear - 1 + (minutes - 60 * SITE_TZ_OFFSET_H >= 1440 ? 1 : 0)) % 365);
  const lighting: NativeLighting = {
    sun_elev_deg: sun.elevationDeg,
    sun_azim_deg: sun.azimuthDeg,
    rung: 3,
    weather: preset.weather,
    sun_scale: overrides.sun ?? 1,
    ambient_scale: overrides.ambient ?? 1,
    sky_scale: overrides.sky ?? 1,
    // Studio's `exposure` is a linear multiplier on the picture; the
    // renderer's bias is in stops on EV100, where positive darkens.
    ev100_bias: overrides.exposure === undefined ? 0 : -Math.log2(overrides.exposure),
    cloud_cover: preset.cloudCover,
    haze: overrides.haze ?? preset.haze,
    wetness: preset.wetness,
    atmosphere: true,
    turbidity: preset.turbidity,
    ozone_du: 300,
    air_density: 1,
    visibility_m: overrides.visibilityM ?? preset.visibilityM,
    night: {
      utc_year: 2026,
      utc_day_of_year: utcDay,
      utc_minutes: utcMinutes,
      latitude_deg: 37.4419,
      longitude_deg: -122.143,
      elevation_m: 15,
      natural_ambient_lux: 0.002,
      urban_skyglow_lux: 0.05,
      limiting_magnitude: 6.5,
      fixture_budget: 12,
      fixture_shadow_budget: 0,
      window_mode: 'synthetic_facade',
      cloud_quality: 'scalable',
      cloud_wind_mps: [12, 4],
      cloud_density: preset.cloudDensity,
      cloud_type: preset.cloudType,
      cloud_base_m: preset.cloudBaseM,
      cloud_top_m: preset.cloudTopM,
      sky_display_lift: 120,
      exposure_offset_stops: 0,
      sky_debug_mode: 0,
      cloud_fixed_step_s: options.cloudFixedStepS ?? 1 / 30,
    },
  };
  return {
    lighting,
    profileConfig: CINEMATIC_PROFILE_CONFIG,
    provenance: {
      weather: environment.weather,
      preset: preset.weather,
      sceneMinutes: minutes,
      dayOfYear,
      sunSource: 'solar-model',
      overrides: Object.fromEntries(
        Object.entries(overrides).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
      ),
    },
  };
}

export { LIGHTING_EXTENSION_KEY };
