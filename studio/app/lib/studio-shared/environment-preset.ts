import { z } from "zod";

/**
 * Environment preset categories for scenario simulations.
 * Each environment preset is a struct with at most one preset from each category.
 */

/** Environment lighting presets. */
export const EnvironmentPresetLighting = z.enum([
  "SUNRISE",
  "SUNSET",
  "TWILIGHT",
  "MID_MORNING",
  "AFTERNOON",
  "ZENITH",
  "GOLDEN_HOUR",
  "BLUE_HOUR",
  "NIGHT",
]);
export type EnvironmentPresetLighting = z.infer<typeof EnvironmentPresetLighting>;

/** Weather presets. */
export const EnvironmentPresetWeather = z.enum([
  "CLEAR_SKY",
  "OVERCAST",
  "SNOW_FALLING",
  "RAINING",
  "FOG",
]);
export type EnvironmentPresetWeather = z.infer<typeof EnvironmentPresetWeather>;

/** Road surface condition presets. */
export const EnvironmentPresetRoadSurface = z.enum([
  "DRY_ROAD",
  "SNOW_ON_GROUND",
  "SAND_ON_GROUND",
  "PUDDLES",
]);
export type EnvironmentPresetRoadSurface = z.infer<typeof EnvironmentPresetRoadSurface>;

/**
 * Environment preset: explicit selection (lighting, weather, road surface) and/or an NLP-style text prompt.
 * Used to request one output (e.g. one video) per preset for a scenario simulation.
 * Either specify category presets, or use intentPrompt for a natural-language description (or both).
 */
export const EnvironmentPresetSchema = z.object({
  lighting: EnvironmentPresetLighting.optional(),
  weather: EnvironmentPresetWeather.optional(),
  roadSurface: EnvironmentPresetRoadSurface.optional(),
  /** Optional natural-language description of desired conditions (e.g. "sunny winter morning with light snow"). */
  intentPrompt: z.string().optional(),
});
export type EnvironmentPreset = z.infer<typeof EnvironmentPresetSchema>;

/** All lighting preset values. */
export const ENVIRONMENT_PRESET_LIGHTING_VALUES: readonly EnvironmentPresetLighting[] =
  EnvironmentPresetLighting.options;

/** All weather preset values. */
export const ENVIRONMENT_PRESET_WEATHER_VALUES: readonly EnvironmentPresetWeather[] =
  EnvironmentPresetWeather.options;

/** All road surface preset values. */
export const ENVIRONMENT_PRESET_ROAD_SURFACE_VALUES: readonly EnvironmentPresetRoadSurface[] =
  EnvironmentPresetRoadSurface.options;

/**
 * Converts an environment preset to an array of preset ID strings.
 * Used when storing which preset an artifact belongs to (immutable reference).
 */
export function environmentPresetToRef(preset: EnvironmentPreset): string[] {
  const ref: string[] = [];
  if (preset.lighting !== undefined) ref.push(preset.lighting);
  if (preset.weather !== undefined) ref.push(preset.weather);
  if (preset.roadSurface !== undefined) ref.push(preset.roadSurface);
  return ref;
}
