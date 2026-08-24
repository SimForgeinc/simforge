import { z } from "zod";
import type {
  EnvironmentPreset,
  EnvironmentPresetLighting,
  EnvironmentPresetWeather,
  EnvironmentPresetRoadSurface,
} from "./environment-preset";

/**
 * Carla engine weather config.
 * Matches the shape consumed by the Scenario Creator backend (WeatherConfig)
 * and engine_settings.weather in scenario JSON.
 */
export const CarlaWeatherSchema = z.object({
  /** Time of day in hours (0–24). Used when sun_altitude_angle/sun_azimuth_angle are not set. */
  daytime: z.number().min(0).max(24),
  rain: z.number().min(0).max(1),
  cloudiness: z.number().min(0).max(1),
  fog_density: z.number().min(0).max(1),
  precipitation_deposits: z.number().min(0).max(1),
  wetness: z.number().min(0).max(1),
  wind_intensity: z.number().min(0).max(1),
  /** Sun altitude in degrees. If set, backend uses this instead of deriving from daytime. */
  sun_altitude_angle: z.number().min(-90).max(90).optional(),
  /** Sun azimuth in degrees. If set, backend uses this instead of deriving from daytime. */
  sun_azimuth_angle: z.number().min(0).max(360).optional(),
});
export type CarlaWeather = z.infer<typeof CarlaWeatherSchema>;

/** Default daytime (hours 0–24) for each lighting preset. */
const LIGHTING_TO_DAYTIME: Record<EnvironmentPresetLighting, number> = {
  NIGHT: 0,
  BLUE_HOUR: 5,
  SUNRISE: 6,
  TWILIGHT: 6.5,
  MID_MORNING: 9,
  AFTERNOON: 14,
  ZENITH: 12,
  GOLDEN_HOUR: 17.5,
  SUNSET: 18,
};

/**
 * Converts time of day (0–24 hours) to sun altitude and azimuth in degrees.
 * Mirrors the Python time_to_sun_angles used in the Scenario Creator backend.
 */
function timeToSunAngles(hours: number): { altitude: number; azimuth: number } {
  hours = hours % 24;
  const hourAngle = (hours - 12) * 15;
  let altitude = 90 - Math.abs(hourAngle);
  altitude = Math.max(-90, Math.min(90, altitude));
  const azimuth =
    hours < 12
      ? 90 + (12 - hours) * 7.5
      : 270 - (hours - 12) * 7.5;
  return { altitude, azimuth: azimuth % 360 };
}

/**
 * Numeric weather parameters derived from weather + roadSurface presets.
 * All values 0–1. Wind is not in presets; caller can override default 0.
 */
function presetToWeatherParams(
  weather: EnvironmentPresetWeather | undefined,
  roadSurface: EnvironmentPresetRoadSurface | undefined
): Pick<
  CarlaWeather,
  "rain" | "cloudiness" | "fog_density" | "precipitation_deposits" | "wetness"
> {
  const out = {
    rain: 0,
    cloudiness: 0,
    fog_density: 0,
    precipitation_deposits: 0,
    wetness: 0,
  };

  switch (weather) {
    case "CLEAR_SKY":
      break;
    case "OVERCAST":
      out.cloudiness = 0.85;
      break;
    case "RAINING":
      out.rain = 0.55;
      out.cloudiness = 0.75;
      out.fog_density = 0.2;
      out.precipitation_deposits = 0.55;
      out.wetness = 0.75;
      break;
    case "FOG":
      out.fog_density = 0.75;
      out.cloudiness = 0.5;
      break;
    case "SNOW_FALLING":
      out.cloudiness = 0.8;
      out.precipitation_deposits = 0.6;
      out.wetness = 0.2;
      break;
    default:
      break;
  }

  switch (roadSurface) {
    case "PUDDLES":
      out.wetness = Math.max(out.wetness, 0.7);
      out.precipitation_deposits = Math.max(out.precipitation_deposits, 0.4);
      break;
    case "SNOW_ON_GROUND":
      out.precipitation_deposits = Math.max(out.precipitation_deposits, 0.8);
      break;
    case "DRY_ROAD":
      out.wetness = 0;
      break;
    case "SAND_ON_GROUND":
      // No direct CARLA equivalent; leave wetness as from weather
      break;
    default:
      break;
  }

  return out;
}

/**
 * Maps an environment preset to Carla engine weather config.
 * Used to fill engine_settings.weather in scenario JSON for the Scenario Creator backend.
 *
 * - lighting → daytime (0–24) and sun_altitude_angle / sun_azimuth_angle
 * - weather + roadSurface → rain, cloudiness, fog_density, precipitation_deposits, wetness
 * - wind_intensity has no preset; defaults to 0
 */
export function environmentPresetToCarlaWeather(
  preset: EnvironmentPreset,
  options?: { windIntensity?: number }
): CarlaWeather {
  const daytime = preset.lighting
    ? LIGHTING_TO_DAYTIME[preset.lighting]
    : 12;
  const { altitude, azimuth } = timeToSunAngles(daytime);

  const params = presetToWeatherParams(preset.weather, preset.roadSurface);

  return {
    daytime,
    sun_altitude_angle: altitude,
    sun_azimuth_angle: azimuth,
    wind_intensity: options?.windIntensity ?? 0,
    ...params,
  };
}
