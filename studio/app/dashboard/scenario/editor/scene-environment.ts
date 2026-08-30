import type {
  CityViewer,
  CityWeatherAppearance,
  WeatherParticleBudget,
} from "@simforge-oss/viewer";
import type {
  Environment,
  TimeOfDay,
  Weather,
} from "@simforge-oss/scenario";
import { resolveEditorLightingRenderScales } from "@simforge-oss/scenario/contracts";
import type { DirectionalLight } from "three";
import type { ScenarioAuthoringQuality } from "@/app/lib/scenario/contracts";
import { resolveEditorWeatherControls } from "./weather-controls";
import {
  resolveExactSceneMinutes,
  sunAnglesForSceneMinutes,
} from "./scene-time";

type PrecipitationKind = "rain" | "snow" | "sleet";

type EditorSnowSurfaceAppearance = CityWeatherAppearance["surface"] & {
  /** Physical snow depth for renderer effects that distinguish a dusting from deep accumulation. */
  readonly snowDepthM: number;
  /** 0 is loose fresh snow; 1 is densely compacted snow or sleet. */
  readonly snowCompaction: number;
};

type EditorCloudAppearance = {
  /** Fraction of the sky occupied by the cloud field. */
  readonly coverage: number;
  /** Visual density of clouds inside the occupied sky. */
  readonly opacity?: number;
  /** Signed cloud-bank animation direction and strength. */
  readonly wind?: number;
  /** Neutral weather tint for the cloud field. */
  readonly color?: number;
  /** `low` is available in the renderer's weather-quality contract. */
  readonly budget?: WeatherParticleBudget | "low";
} | null;

/**
 * Extends the installed renderer contract while it accepts the visual surface
 * treatment structurally. The renderer uses these physical fields when its
 * snow-depth material treatment is available.
 */
export type EditorSceneEnvironmentAppearance = Omit<
  CityWeatherAppearance,
  "clouds" | "surface"
> & {
  readonly clouds: EditorCloudAppearance;
  readonly surface: EditorSnowSurfaceAppearance;
};

const TIME_ILLUMINATION = {
  dawn: 0.25,
  morning: 0.9,
  noon: 1,
  afternoon: 0.9,
  dusk: 0.2,
  night: 0.012,
  night_lit: 0.05,
} as const satisfies Record<TimeOfDay, number>;

const TIME_SKY = {
  dawn: 0x75606f,
  morning: null,
  noon: null,
  afternoon: null,
  dusk: 0x433b55,
  night: 0x07111f,
  night_lit: 0x0d1b30,
} as const satisfies Record<TimeOfDay, number | null>;

const TIME_SUN = {
  dawn: 0xffb16a,
  morning: 0xffdfb7,
  noon: 0xfff4df,
  afternoon: 0xffd39c,
  dusk: 0xff8751,
  night: 0x8ea8d4,
  night_lit: 0xa6b9dc,
} as const satisfies Record<TimeOfDay, number>;

type WeatherProfile = {
  readonly backgroundColor: number | null;
  readonly backgroundBlurriness: number;
  readonly clouds: EditorCloudAppearance;
  readonly haze: number;
  readonly illuminationScale: number;
  readonly precipitation: {
    readonly kind: PrecipitationKind;
    readonly intensity: number;
  } | null;
  readonly sunTint: number | null;
  readonly sunTintMix: number;
  readonly visibilityM: number;
  readonly wetness: number;
};

/**
 * These are visual realizations of the canonical environment presets. The
 * scenario keeps the portable preset; the renderer receives independent air,
 * precipitation and surface values so rain can darken the road and snow can
 * accumulate rather than merely changing the sky color.
 */
const WEATHER = {
  clear: {
    backgroundColor: null,
    backgroundBlurriness: 0.05,
    clouds: null,
    haze: 0,
    illuminationScale: 1,
    precipitation: null,
    sunTint: null,
    sunTintMix: 0,
    visibilityM: 20_000,
    wetness: 0,
  },
  cloudy: {
    backgroundColor: 0x7a8791,
    backgroundBlurriness: 0.35,
    clouds: {
      coverage: 0.65,
      opacity: 0.38,
      wind: 0.12,
      color: 0x8a99a5,
      budget: "low",
    },
    haze: 0.025,
    illuminationScale: 0.8,
    precipitation: null,
    sunTint: 0xcbd3d9,
    sunTintMix: 0.45,
    visibilityM: 20_000,
    wetness: 0,
  },
  overcast: {
    backgroundColor: 0x59656e,
    backgroundBlurriness: 0.5,
    clouds: {
      coverage: 0.9,
      opacity: 0.65,
      wind: 0.22,
      color: 0x75838e,
      budget: "medium",
    },
    haze: 0.07,
    illuminationScale: 0.6,
    precipitation: null,
    sunTint: 0xbfc9d0,
    sunTintMix: 0.65,
    visibilityM: 15_000,
    wetness: 0.06,
  },
  light_rain: {
    backgroundColor: 0x4c5c68,
    backgroundBlurriness: 0.55,
    clouds: {
      coverage: 0.88,
      opacity: 0.62,
      wind: 0.38,
      color: 0x637681,
      budget: "high",
    },
    haze: 0.14,
    illuminationScale: 0.72,
    precipitation: { kind: "rain", intensity: 0.48 },
    sunTint: 0xb4c5d0,
    sunTintMix: 0.7,
    visibilityM: 4_000,
    wetness: 0.62,
  },
  heavy_rain: {
    backgroundColor: 0x35434f,
    backgroundBlurriness: 0.7,
    clouds: {
      coverage: 0.96,
      opacity: 0.78,
      wind: 0.55,
      color: 0x4d5e6b,
      budget: "high",
    },
    haze: 0.3,
    illuminationScale: 0.45,
    precipitation: { kind: "rain", intensity: 1 },
    sunTint: 0xa9bac7,
    sunTintMix: 0.8,
    visibilityM: 800,
    wetness: 0.98,
  },
  wet_road: {
    backgroundColor: 0x657581,
    backgroundBlurriness: 0.42,
    clouds: {
      coverage: 0.58,
      opacity: 0.36,
      wind: 0.12,
      color: 0x8797a2,
      budget: "low",
    },
    haze: 0.04,
    illuminationScale: 0.82,
    precipitation: null,
    sunTint: 0xc2d0d8,
    sunTintMix: 0.45,
    visibilityM: 8_000,
    wetness: 0.86,
  },
  fog_light: {
    backgroundColor: 0xbfc9cd,
    backgroundBlurriness: 0.72,
    clouds: {
      coverage: 0.84,
      opacity: 0.47,
      wind: 0.08,
      color: 0xb0bac0,
      budget: "medium",
    },
    haze: 0.56,
    illuminationScale: 0.6,
    precipitation: null,
    sunTint: 0xd8dde0,
    sunTintMix: 0.8,
    visibilityM: 400,
    wetness: 0.12,
  },
  fog_dense: {
    backgroundColor: 0xaab4b8,
    backgroundBlurriness: 0.9,
    clouds: {
      coverage: 0.94,
      opacity: 0.65,
      wind: 0.04,
      color: 0xa4afb4,
      budget: "medium",
    },
    haze: 0.88,
    illuminationScale: 0.35,
    precipitation: null,
    sunTint: 0xd1d7da,
    sunTintMix: 0.9,
    visibilityM: 60,
    wetness: 0.22,
  },
  snow: {
    backgroundColor: 0xb8c5cb,
    backgroundBlurriness: 0.6,
    clouds: {
      coverage: 0.87,
      opacity: 0.58,
      wind: -0.18,
      color: 0xb5c0c8,
      budget: "medium",
    },
    haze: 0.24,
    illuminationScale: 0.7,
    precipitation: { kind: "snow", intensity: 0.62 },
    sunTint: 0xe4edf2,
    sunTintMix: 0.72,
    visibilityM: 500,
    wetness: 0.08,
  },
  sleet: {
    backgroundColor: 0x687780,
    backgroundBlurriness: 0.65,
    clouds: {
      coverage: 0.92,
      opacity: 0.68,
      wind: 0.3,
      color: 0x77868e,
      budget: "high",
    },
    haze: 0.25,
    illuminationScale: 0.6,
    precipitation: { kind: "sleet", intensity: 0.7 },
    sunTint: 0xc7d4dc,
    sunTintMix: 0.75,
    visibilityM: 900,
    wetness: 0.58,
  },
} as const satisfies Record<Weather, WeatherProfile>;

const DAY_SKY = 0x88a9bd;
const CLOCK_LIGHTING_ANCHORS = [
  { minutes: 0, preset: "night_lit" },
  { minutes: 5 * 60, preset: "night" },
  { minutes: 6 * 60, preset: "dawn" },
  { minutes: 9 * 60, preset: "morning" },
  { minutes: 12 * 60, preset: "noon" },
  { minutes: 15 * 60, preset: "afternoon" },
  { minutes: 18 * 60, preset: "dusk" },
  { minutes: 20 * 60, preset: "night_lit" },
  { minutes: 24 * 60, preset: "night_lit" },
] as const satisfies ReadonlyArray<{ minutes: number; preset: TimeOfDay }>;
const MAX_EDITOR_FOG_DISTANCE_M = 6_000;
const WIND_STRENGTH = {
  calm: 0,
  breezy: 0.42,
  strong: 0.9,
} as const;
const SNOW_SURFACE = {
  none: { snowCoverage: 0, snowDepthM: 0, snowCompaction: 0 },
  dusting: { snowCoverage: 0.18, snowDepthM: 0.015, snowCompaction: 0.2 },
  covered: { snowCoverage: 0.58, snowDepthM: 0.075, snowCompaction: 0.4 },
  deep: { snowCoverage: 0.94, snowDepthM: 0.18, snowCompaction: 0.55 },
} as const;
const SLEET_SNOW_COMPACTION = 0.85;

export function resolveEditorSceneEnvironment(
  environment: Environment,
): EditorSceneEnvironmentAppearance {
  const weather = WEATHER[environment.weather];
  const controls = resolveEditorWeatherControls(environment);
  const exactSceneMinutes = resolveExactSceneMinutes(environment);
  const clock = exactSceneMinutes === null
    ? {
        illumination: TIME_ILLUMINATION[environment.timeOfDay],
        sky: TIME_SKY[environment.timeOfDay],
        sun: TIME_SUN[environment.timeOfDay],
      }
    : resolveClockLighting(exactSceneMinutes);
  const illumination = Math.max(
    0.001,
    clock.illumination * weather.illuminationScale,
  );
  const backgroundColor = composeSkyColor(clock.sky, weather.backgroundColor);
  const fog = weather.visibilityM < MAX_EDITOR_FOG_DISTANCE_M
    ? {
        color: backgroundColor ?? weather.backgroundColor ?? DAY_SKY,
        haze: weather.haze,
        visibilityM: weather.visibilityM,
      }
    : null;
  const rootIllumination = Math.sqrt(illumination);
  const snowy = environment.weather === "snow" || environment.weather === "sleet";
  const selectedSnowSurface = snowy
    ? SNOW_SURFACE[controls.snowCover]
    : SNOW_SURFACE.none;
  const snowSurface = environment.weather === "sleet"
    ? {
        ...selectedSnowSurface,
        snowCompaction: Math.max(
          selectedSnowSurface.snowCompaction,
          SLEET_SNOW_COMPACTION,
        ),
      }
    : selectedSnowSurface;

  const overrides = resolveEditorLightingRenderScales(environment);
  const hazeOverride = overrides.haze;
  const visibilityOverride = overrides.visibilityM;
  // An authored visibility or haze creates fog the preset never asked for, so
  // the block is rebuilt rather than patched.
  const authoredFog = hazeOverride === undefined && visibilityOverride === undefined
    ? fog
    : {
        color: fog?.color ?? backgroundColor ?? weather.backgroundColor ?? DAY_SKY,
        haze: hazeOverride ?? fog?.haze ?? 0,
        visibilityM: visibilityOverride ?? fog?.visibilityM ?? MAX_EDITOR_FOG_DISTANCE_M,
      };

  return {
    backgroundColor,
    backgroundBlurriness: weather.backgroundBlurriness,
    backgroundIntensityScale: (0.35 + 0.65 * rootIllumination) * (overrides.sky ?? 1),
    environmentIntensityScale: (0.22 + 0.78 * rootIllumination) * (overrides.ambient ?? 1),
    exposureScale: (0.48 + 0.52 * rootIllumination) * (overrides.exposure ?? 1),
    clouds: weather.clouds,
    fog: authoredFog === null
      || (authoredFog.visibilityM >= MAX_EDITOR_FOG_DISTANCE_M && authoredFog.haze <= 0)
      ? null
      : authoredFog,
    precipitation: weather.precipitation
      ? {
          ...weather.precipitation,
          budget: "high",
          wind: WIND_STRENGTH[controls.wind],
        }
      : null,
    sunColor: warmedSunColor(
      weather.sunTint === null
        ? clock.sun
        : mixHex(clock.sun, weather.sunTint, weather.sunTintMix),
      overrides.sunWarmth,
    ),
    sunIntensityScale: illumination * (overrides.sun ?? 1),
    surface: {
      ...snowSurface,
      wetness: weather.wetness,
    },
  };
}

/** Sun tints for the ends of the warmth control. */
const COOL_SUN = 0xbfd4ff;
const WARM_SUN = 0xffb057;

/**
 * Applies the authored sun warmth.
 *
 * Warmth is expressed as a signed nudge rather than a colour picker: the
 * preset's tint already carries the time of day, and an author asking for
 * "warmer" wants to keep that relationship, not replace it with an absolute
 * hue they then have to re-pick every time the clock moves.
 */
function warmedSunColor(preset: number, warmth: number | undefined): number {
  if (warmth === undefined || warmth === 0) return preset;
  return warmth > 0
    ? mixHex(preset, WARM_SUN, Math.min(1, warmth))
    : mixHex(preset, COOL_SUN, Math.min(1, -warmth));
}

export function applyEditorSceneEnvironment(
  viewer: CityViewer,
  environment: Environment,
  options: {
    readonly quality: ScenarioAuthoringQuality;
    readonly reducedMotion?: boolean;
  },
): () => void {
  const appearance = resolveEditorSceneEnvironment(environment);
  const particleBudget: WeatherParticleBudget = options.reducedMotion
    || options.quality === "roads-only"
    || options.quality === "ultra-low-3d"
    ? "off"
    : options.quality === "high"
      ? "high"
      : "medium";
  const rendererAppearance: EditorSceneEnvironmentAppearance = {
    ...appearance,
    clouds: appearance.clouds
      ? { ...appearance.clouds, budget: particleBudget }
      : null,
    precipitation: appearance.precipitation
      ? { ...appearance.precipitation, budget: particleBudget }
      : null,
  };
  viewer.setWeatherAppearance(rendererAppearance);
  const restoreSun = applyEditorSceneSunPosition(viewer, environment);

  return () => {
    restoreSun();
    viewer.setWeatherAppearance(null);
  };
}

/** Pin renderer-owned weather animation to fixed scenario time during capture. */
export function setEditorSceneEnvironmentTime(
  viewer: CityViewer,
  timeSeconds: number | null,
): void {
  viewer.setWeatherTimeSeconds(timeSeconds);
}

function composeSkyColor(
  timeColor: number | null,
  weatherColor: number | null,
): number | null {
  if (timeColor === null) return weatherColor;
  if (weatherColor === null) return timeColor;
  return mixHex(timeColor, weatherColor, 0.68);
}

function resolveClockLighting(minutes: number): {
  readonly illumination: number;
  readonly sky: number | null;
  readonly sun: number;
} {
  const upperIndex = CLOCK_LIGHTING_ANCHORS.findIndex((anchor) => anchor.minutes >= minutes);
  const upper = CLOCK_LIGHTING_ANCHORS[Math.max(1, upperIndex)]!;
  const lower = CLOCK_LIGHTING_ANCHORS[Math.max(0, Math.max(1, upperIndex) - 1)]!;
  const span = Math.max(1, upper.minutes - lower.minutes);
  const amount = Math.max(0, Math.min(1, (minutes - lower.minutes) / span));
  const lowerSky = TIME_SKY[lower.preset];
  const upperSky = TIME_SKY[upper.preset];

  return {
    illumination:
      TIME_ILLUMINATION[lower.preset]
      + (TIME_ILLUMINATION[upper.preset] - TIME_ILLUMINATION[lower.preset]) * amount,
    sky: lowerSky === null && upperSky === null
      ? null
      : mixHex(lowerSky ?? DAY_SKY, upperSky ?? DAY_SKY, amount),
    sun: mixHex(TIME_SUN[lower.preset], TIME_SUN[upper.preset], amount),
  };
}

function applyEditorSceneSunPosition(
  viewer: CityViewer,
  environment: Environment,
): () => void {
  const exactMinutes = resolveExactSceneMinutes(environment);
  if (exactMinutes === null) return () => undefined;

  const sun = viewer.scene?.getObjectByName("sun") as DirectionalLight | undefined;
  if (!sun?.isDirectionalLight) return () => undefined;

  const previousPosition = sun.position.clone();
  const target = sun.target.position;
  const radius = Math.max(1, previousPosition.distanceTo(target));
  const authoredAzimuth = environment.sunAzimuthDeg;
  const authoredElevation = environment.sunElevationDeg;
  const fallback = sunAnglesForSceneMinutes(exactMinutes);
  const azimuthDeg = typeof authoredAzimuth === "number"
    ? authoredAzimuth
    : fallback.azimuthDeg;
  const elevationDeg = typeof authoredElevation === "number"
    ? authoredElevation
    : fallback.elevationDeg;
  const azimuth = azimuthDeg * Math.PI / 180;
  const elevation = elevationDeg * Math.PI / 180;
  const horizontal = Math.cos(elevation) * radius;

  sun.position.set(
    target.x + horizontal * Math.sin(azimuth),
    target.y + radius * Math.sin(elevation),
    target.z + horizontal * Math.cos(azimuth),
  );
  sun.updateMatrixWorld();

  return () => {
    sun.position.copy(previousPosition);
    sun.updateMatrixWorld();
  };
}

function mixHex(from: number, to: number, amount: number): number {
  const channel = (shift: number) => Math.round(
    ((from >> shift) & 0xff) * (1 - amount) + ((to >> shift) & 0xff) * amount,
  );
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}
