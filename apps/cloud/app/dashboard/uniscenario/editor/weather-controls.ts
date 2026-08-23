import type { Environment, Weather } from "@uniscenarios/scenario-model";

export const WEATHER_APPEARANCE_EXTENSION_KEY =
  "org.simforge.weatherAppearance.v1" as const;

export type WindPreset = "calm" | "breezy" | "strong";

export type SnowCoverPreset = "none" | "dusting" | "covered" | "deep";

export type EditorWeatherControls = Readonly<{
  wind: WindPreset;
  snowCover: SnowCoverPreset;
}>;

const WIND_PRESETS = new Set<WindPreset>(["calm", "breezy", "strong"]);
const SNOW_COVER_PRESETS = new Set<SnowCoverPreset>([
  "none",
  "dusting",
  "covered",
  "deep",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultWind(weather: Weather): WindPreset {
  switch (weather) {
    case "light_rain":
    case "heavy_rain":
    case "snow":
    case "sleet":
      return "breezy";
    default:
      return "calm";
  }
}

function defaultSnowCover(weather: Weather): SnowCoverPreset {
  switch (weather) {
    case "snow":
      return "covered";
    case "sleet":
      return "dusting";
    default:
      return "none";
  }
}

/**
 * Resolves the editor-only appearance choices without making them part of the
 * execution environment. Invalid or legacy extension values safely fall back
 * to the scene's weather-appropriate defaults.
 */
export function resolveEditorWeatherControls(
  environment: Environment,
): EditorWeatherControls {
  const stored = environment.extensions?.[WEATHER_APPEARANCE_EXTENSION_KEY];
  const appearance = isRecord(stored) ? stored : undefined;
  const wind = appearance?.wind;
  const snowCover = appearance?.snowCover;

  return {
    wind: typeof wind === "string" && WIND_PRESETS.has(wind as WindPreset)
      ? (wind as WindPreset)
      : defaultWind(environment.weather),
    snowCover:
      typeof snowCover === "string" && SNOW_COVER_PRESETS.has(snowCover as SnowCoverPreset)
        ? (snowCover as SnowCoverPreset)
        : defaultSnowCover(environment.weather),
  };
}

/** Writes only the appearance extension, retaining every execution field and unrelated extension. */
export function withEditorWeatherControls(
  environment: Environment,
  patch: Partial<EditorWeatherControls>,
): Environment {
  const current = resolveEditorWeatherControls(environment);
  const priorAppearance = environment.extensions?.[WEATHER_APPEARANCE_EXTENSION_KEY];
  const preservedAppearance = isRecord(priorAppearance) ? priorAppearance : {};

  return {
    ...environment,
    extensions: {
      ...environment.extensions,
      [WEATHER_APPEARANCE_EXTENSION_KEY]: {
        ...preservedAppearance,
        ...current,
        ...patch,
      },
    },
  };
}

/** A stable, compact dependency key for consumers of the editor appearance. */
export function editorWeatherControlSignature(environment: Environment): string {
  const { wind, snowCover } = resolveEditorWeatherControls(environment);
  return `${wind}:${snowCover}`;
}
