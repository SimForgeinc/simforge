/**
 * Environment-preset input handling for scenario drafts.
 *
 * The schema of record is `EnvironmentPresetSchema` from `@simforge/studio-shared` —
 * a struct of up to three enum selections (`lighting`, `weather`,
 * `roadSurface`) plus an optional `intentPrompt`. That struct is what the
 * xosc writer (`xosc-writer/environment.ts`) and the CARLA worker's
 * `apply_environment_preset` both consume.
 *
 * Drafts arrive carrying the preset in more than one spelling, though:
 *
 *   - the editor UI writes `renderConfig.environmentPreset` (the struct);
 *   - API authors (the scenario-eval fleet among them) write a top-level
 *     `environment_preset` / `environmentPreset`, either as the struct or as
 *     a short NAME like `"storm"`, `"rain"`, `"night_rain"`
 *     (scripts/agent/scenario-eval/case-format.md documents the name form);
 *   - persisted v3 drafts carry it as `setup.environment` (written by
 *     `toScenarioSetupJson`).
 *
 * Until scenario-eval defect #24 every one of these except a
 * `renderConfig.environmentPreset` riding a fully-valid render config was
 * silently discarded between PUT draft and export-compile, so every scenario
 * validated as clear noon (`environment_defaulted`). This module is the one
 * place all the spellings funnel through.
 *
 * Name mapping is deterministic keyword tokenization, not NLP: the name is
 * split on `_`/`-`/whitespace and each token maps onto at most one selection
 * per category. `"night_rain"` → NIGHT + RAINING. A name with NO recognized
 * token resolves to nothing — callers at the write boundary must REJECT it
 * (never silently drop it), which `resolveEnvironmentPresetInput` supports by
 * distinguishing "no preset" from "unintelligible preset".
 */
import {
  EnvironmentPresetSchema,
  type EnvironmentPreset,
  type EnvironmentPresetLighting,
  type EnvironmentPresetRoadSurface,
  type EnvironmentPresetWeather,
} from "@simforge/studio-shared";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

const LIGHTING_TOKENS: Readonly<Record<string, EnvironmentPresetLighting>> = {
  night: "NIGHT",
  midnight: "NIGHT",
  sunrise: "SUNRISE",
  dawn: "SUNRISE",
  sunset: "SUNSET",
  dusk: "TWILIGHT",
  evening: "TWILIGHT",
  twilight: "TWILIGHT",
  noon: "ZENITH",
  midday: "ZENITH",
  morning: "MID_MORNING",
  afternoon: "AFTERNOON",
  golden: "GOLDEN_HOUR",
};

type WeatherSelection = {
  weather: EnvironmentPresetWeather;
  roadSurface?: EnvironmentPresetRoadSurface;
};

const WEATHER_TOKENS: Readonly<Record<string, WeatherSelection>> = {
  rain: { weather: "RAINING" },
  rainy: { weather: "RAINING" },
  raining: { weather: "RAINING" },
  drizzle: { weather: "RAINING" },
  // A storm is heavy rain on an already-wet road; PUDDLES is the closest the
  // road-surface vocabulary gets to that.
  storm: { weather: "RAINING", roadSurface: "PUDDLES" },
  stormy: { weather: "RAINING", roadSurface: "PUDDLES" },
  thunderstorm: { weather: "RAINING", roadSurface: "PUDDLES" },
  downpour: { weather: "RAINING", roadSurface: "PUDDLES" },
  snow: { weather: "SNOW_FALLING", roadSurface: "SNOW_ON_GROUND" },
  snowing: { weather: "SNOW_FALLING", roadSurface: "SNOW_ON_GROUND" },
  blizzard: { weather: "SNOW_FALLING", roadSurface: "SNOW_ON_GROUND" },
  fog: { weather: "FOG" },
  foggy: { weather: "FOG" },
  mist: { weather: "FOG" },
  misty: { weather: "FOG" },
  haze: { weather: "FOG" },
  overcast: { weather: "OVERCAST" },
  cloudy: { weather: "OVERCAST" },
  clear: { weather: "CLEAR_SKY" },
  sunny: { weather: "CLEAR_SKY" },
};

const ROAD_SURFACE_TOKENS: Readonly<Record<string, EnvironmentPresetRoadSurface>> = {
  wet: "PUDDLES",
  puddles: "PUDDLES",
  dry: "DRY_ROAD",
  sand: "SAND_ON_GROUND",
  sandy: "SAND_ON_GROUND",
};

/**
 * Map a preset NAME ("storm", "night_rain", "heavy-rain") onto the struct.
 * Returns null when no token is recognized; the first recognized token per
 * category wins, unrecognized modifier tokens ("heavy") are ignored.
 */
export function environmentPresetFromName(name: string): EnvironmentPreset | null {
  const tokens = name
    .trim()
    .toLowerCase()
    .split(/[\s_\-/]+/)
    .filter(Boolean);

  const preset: EnvironmentPreset = {};
  for (const token of tokens) {
    if (preset.lighting === undefined && LIGHTING_TOKENS[token]) {
      preset.lighting = LIGHTING_TOKENS[token];
      continue;
    }
    const weather = WEATHER_TOKENS[token];
    if (preset.weather === undefined && weather) {
      preset.weather = weather.weather;
      if (preset.roadSurface === undefined && weather.roadSurface) {
        preset.roadSurface = weather.roadSurface;
      }
      continue;
    }
    const surface = ROAD_SURFACE_TOKENS[token];
    if (surface) {
      // An explicit surface token always wins over one implied by weather.
      preset.roadSurface = surface;
    }
  }

  return preset.lighting !== undefined ||
    preset.weather !== undefined ||
    preset.roadSurface !== undefined
    ? preset
    : null;
}

export type EnvironmentPresetInput =
  | { present: false }
  | { present: true; path: string; value: unknown };

/**
 * Find the environment preset an incoming draft carries, wherever it spelled
 * it. Reports presence separately from validity so the write boundary can
 * reject an unintelligible preset instead of dropping it.
 */
export function readEnvironmentPresetInput(
  draft: Record<string, unknown>,
): EnvironmentPresetInput {
  const setup = asRecord(draft.setup);
  if (hasOwn(setup, "environment")) {
    return { present: true, path: "setup.environment", value: setup.environment };
  }
  const setupRenderConfig = asRecord(setup.renderConfig);
  if (hasOwn(setupRenderConfig, "environmentPreset")) {
    return {
      present: true,
      path: "setup.renderConfig.environmentPreset",
      value: setupRenderConfig.environmentPreset,
    };
  }
  const renderConfig = asRecord(draft.renderConfig);
  if (hasOwn(renderConfig, "environmentPreset")) {
    return {
      present: true,
      path: "renderConfig.environmentPreset",
      value: renderConfig.environmentPreset,
    };
  }
  for (const key of ["environmentPreset", "environment_preset"] as const) {
    if (hasOwn(draft, key)) {
      return { present: true, path: key, value: draft[key] };
    }
  }
  return { present: false };
}

export type ResolvedEnvironmentPreset =
  | { ok: true; preset: EnvironmentPreset | null }
  | { ok: false; reason: string };

/**
 * Resolve one authored preset value (struct or name) to the struct of record.
 *
 * `{ ok: true, preset: null }` means "no preset" (null / empty string / empty
 * struct — a legitimate way to clear it). `{ ok: false }` means the author
 * clearly TRIED to set one and it cannot be understood; the write boundary
 * must surface that instead of exporting clear noon.
 */
export function resolveEnvironmentPresetInput(value: unknown): ResolvedEnvironmentPreset {
  if (value == null) return { ok: true, preset: null };

  if (typeof value === "string") {
    if (!value.trim()) return { ok: true, preset: null };
    const named = environmentPresetFromName(value);
    return named
      ? { ok: true, preset: named }
      : {
          ok: false,
          reason: `"${value}" is not a recognized environment preset name; use the {lighting, weather, roadSurface} struct or a name built from tokens like "night", "rain", "storm", "fog", "snow", "clear".`,
        };
  }

  const parsed = EnvironmentPresetSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `${issue?.path.join(".") || "environment preset"}: ${issue?.message ?? "does not match EnvironmentPresetSchema"}`,
    };
  }
  const preset = parsed.data;
  const empty =
    preset.lighting === undefined &&
    preset.weather === undefined &&
    preset.roadSurface === undefined &&
    preset.intentPrompt === undefined;
  if (!empty) return { ok: true, preset };

  // The schema strips unknown keys, so a struct with only misspelled fields
  // parses to {}. Treat a literal {} as clearing; anything else as an error.
  return Object.keys(asRecord(value)).length === 0
    ? { ok: true, preset: null }
    : {
        ok: false,
        reason:
          "the environment preset struct carries none of lighting/weather/roadSurface/intentPrompt (misspelled field names are stripped, not saved).",
      };
}

/**
 * Lenient form for draft NORMALIZATION (the read path): anything that cannot
 * be resolved reads as "no preset". Persisted drafts must keep opening even if
 * this vocabulary shifts under them; strictness belongs to the write boundary.
 */
export function lenientEnvironmentPreset(value: unknown): EnvironmentPreset | null {
  const resolved = resolveEnvironmentPresetInput(value);
  return resolved.ok ? resolved.preset : null;
}
