import type { Environment, TimeOfDay } from "@simforge/scenario";

export const SCENE_TIME_EXTENSION_KEY = "org.simforge.sceneTime.v1" as const;

export const MINUTES_PER_DAY = 24 * 60;

const PRESET_MINUTES: Readonly<Record<TimeOfDay, number>> = {
  dawn: 6 * 60,
  morning: 9 * 60,
  noon: 12 * 60,
  afternoon: 15 * 60,
  dusk: 18 * 60,
  night: 0,
  night_lit: 21 * 60,
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeSceneMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 12 * 60;
  return ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

export function localSceneMinutes(date = new Date()): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** Exact authored clock time, or null for legacy preset-only environments. */
export function resolveExactSceneMinutes(environment: Environment): number | null {
  const stored = environment.extensions?.[SCENE_TIME_EXTENSION_KEY];
  const minutes = isRecord(stored) ? stored.minutes : null;
  return typeof minutes === "number" && Number.isFinite(minutes)
    ? normalizeSceneMinutes(minutes)
    : null;
}

/** Slider value for both precise and legacy preset-only documents. */
export function resolveSceneSliderMinutes(environment: Environment): number {
  return resolveExactSceneMinutes(environment) ?? PRESET_MINUTES[environment.timeOfDay];
}

export function timeOfDayForSceneMinutes(minutes: number): TimeOfDay {
  const value = normalizeSceneMinutes(minutes);
  if (value < 5 * 60) return "night_lit";
  if (value < 7 * 60) return "dawn";
  if (value < 10 * 60) return "morning";
  if (value < 14 * 60) return "noon";
  if (value < 17 * 60) return "afternoon";
  if (value < 19 * 60) return "dusk";
  return "night_lit";
}

export function sunAnglesForSceneMinutes(minutes: number): {
  readonly azimuthDeg: number;
  readonly elevationDeg: number;
} {
  const value = normalizeSceneMinutes(minutes);
  const daylightProgress = (value - 6 * 60) / (12 * 60);
  const elevationDeg = Math.max(-12, 65 * Math.sin(Math.PI * daylightProgress));
  return {
    azimuthDeg: value / 4,
    elevationDeg: Math.round(elevationDeg * 100) / 100,
  };
}

/**
 * Save a precise wall-clock time while keeping the portable time preset and
 * simulator sun angles synchronized for exports and non-Three.js runtimes.
 */
export function withSceneMinutes(environment: Environment, minutes: number): Environment {
  const normalized = normalizeSceneMinutes(minutes);
  const sun = sunAnglesForSceneMinutes(normalized);
  const previous = environment.extensions?.[SCENE_TIME_EXTENSION_KEY];

  return {
    ...environment,
    timeOfDay: timeOfDayForSceneMinutes(normalized),
    sunAzimuthDeg: sun.azimuthDeg,
    sunElevationDeg: sun.elevationDeg,
    extensions: {
      ...environment.extensions,
      [SCENE_TIME_EXTENSION_KEY]: {
        ...(isRecord(previous) ? previous : {}),
        minutes: normalized,
      },
    },
  };
}

export function sceneTimeSignature(environment: Environment): string {
  const exact = resolveExactSceneMinutes(environment);
  return exact === null ? `preset:${environment.timeOfDay}` : `clock:${exact}`;
}

export function formatSceneTime(minutes: number): string {
  const normalized = normalizeSceneMinutes(minutes);
  const hours = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const suffix = hours < 12 ? "AM" : "PM";
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}
