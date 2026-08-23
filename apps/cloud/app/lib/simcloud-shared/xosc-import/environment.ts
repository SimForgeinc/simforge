/**
 * `<EnvironmentAction>` → the draft's `EnvironmentPreset`.
 *
 * The inverse of `apps/web/app/lib/scenario-editor/xosc-writer/environment.ts`,
 * and the tables below are that module's tables read backwards. They are
 * duplicated rather than imported because the writer lives in `apps/web` and
 * this has to run node-side; the anti-drift guard is a round-trip test that
 * sweeps every lighting band, every weather state and every road surface
 * through the real writer and back (`apps/web/test/unit/scenario-editor/
 * xosc-import/round-trip.test.ts`). If a writer value changes without this
 * changing, that sweep fails.
 *
 * The writer's mapping is deliberately coarse (nine lighting bands and five
 * weather states onto a clock, a sun vector, a visual range and a friction
 * factor), but it is INJECTIVE, so the inverse is exact rather than nearest-
 * match: every band has a distinct clock, every weather state a distinct
 * (cloudState, precipitationType, visualRange) triple, every surface a distinct
 * friction. An element that matches none of them yields `null` for that field
 * and an `imported_approximation` from the caller, never a guess.
 */

import type {
  EnvironmentPreset,
  EnvironmentPresetLighting,
  EnvironmentPresetRoadSurface,
  EnvironmentPresetWeather,
} from "../environment-preset";
import { attrNumber, attrString, childEl, type XmlElement } from "../xosc/xml-dom";

/** Clock → lighting band. The writer's `LIGHTING` table, keyed by its clock. */
const LIGHTING_BY_CLOCK: Readonly<Record<string, EnvironmentPresetLighting>> = {
  "05:30:00": "BLUE_HOUR",
  "06:15:00": "SUNRISE",
  "09:30:00": "MID_MORNING",
  "12:00:00": "ZENITH",
  "15:00:00": "AFTERNOON",
  "18:00:00": "GOLDEN_HOUR",
  "19:00:00": "SUNSET",
  "19:45:00": "TWILIGHT",
  "22:00:00": "NIGHT",
};

/**
 * The writer's no-preset fallback block.
 *
 * It shares ZENITH's clock, which is why the sun vector is part of the match:
 * `12:00:00` at elevation 1.31 / azimuth 0 is "this draft carried no preset",
 * while `12:00:00` at elevation 1.48 / azimuth 3.14 is an authored ZENITH. Read
 * the wrong one and every legacy scenario re-exports as an explicit noon.
 */
const DEFAULT_CLOCK = "12:00:00";
const DEFAULT_SUN_ELEVATION_RAD = 1.31;
const DEFAULT_SUN_AZIMUTH_RAD = 0;

const ZENITH_SUN_ELEVATION_RAD = 1.48;

type WeatherKey = `${string}|${string}|${number}`;

const WEATHER_BY_KEY: Readonly<Record<string, EnvironmentPresetWeather>> = {
  "free|dry|1000": "CLEAR_SKY",
  "overcast|dry|2000": "OVERCAST",
  "rainy|rain|600": "RAINING",
  "cloudy|snow|400": "SNOW_FALLING",
  "cloudy|dry|80": "FOG",
};

const ROAD_SURFACE_BY_FRICTION: ReadonlyArray<
  readonly [friction: number, surface: EnvironmentPresetRoadSurface]
> = [
  [1, "DRY_ROAD"],
  [0.7, "PUDDLES"],
  [0.6, "SAND_ON_GROUND"],
  [0.4, "SNOW_ON_GROUND"],
];

export type ImportedEnvironment = {
  /**
   * The authored preset, or `null` when the block is byte-for-byte the writer's
   * no-preset fallback — in which case the draft it came from carried none and
   * the honest import carries none either.
   */
  preset: EnvironmentPreset | null;
  /** Fields present in the file that matched no known writer value. */
  unmatched: string[];
};

function weatherKey(
  cloudState: string,
  precipitationType: string,
  visualRange: number,
): WeatherKey {
  return `${cloudState}|${precipitationType}|${visualRange}`;
}

/**
 * Read the `<Environment>` element of an `Init` `GlobalAction`.
 *
 * Returns `null` for the whole thing when there is no environment block at all,
 * which the caller reports rather than defaulting silently.
 */
export function importEnvironment(environment: XmlElement | null): ImportedEnvironment | null {
  if (!environment) return null;

  const unmatched: string[] = [];
  const timeOfDay = childEl(environment, "TimeOfDay");
  const weatherEl = childEl(environment, "Weather");
  const sun = childEl(weatherEl, "Sun");
  const fog = childEl(weatherEl, "Fog");
  const precipitation = childEl(weatherEl, "Precipitation");
  const roadCondition = childEl(environment, "RoadCondition");

  const dateTime = attrString(timeOfDay, "dateTime") ?? "";
  const clock = dateTime.includes("T") ? dateTime.slice(dateTime.indexOf("T") + 1) : "";
  const sunElevation = attrNumber(sun, "elevation");
  const sunAzimuth = attrNumber(sun, "azimuth");

  const isWriterDefaultLighting =
    clock === DEFAULT_CLOCK &&
    sunElevation === DEFAULT_SUN_ELEVATION_RAD &&
    sunAzimuth === DEFAULT_SUN_AZIMUTH_RAD;

  let lighting: EnvironmentPresetLighting | undefined;
  if (!isWriterDefaultLighting) {
    const candidate = LIGHTING_BY_CLOCK[clock];
    // ZENITH is the one band that shares the fallback's clock, so it only
    // resolves when the sun vector agrees with it too.
    const zenithMismatch =
      candidate === "ZENITH" && sunElevation !== ZENITH_SUN_ELEVATION_RAD;
    if (candidate && !zenithMismatch) lighting = candidate;
    else unmatched.push(`TimeOfDay dateTime="${dateTime}"`);
  }

  const cloudState = attrString(weatherEl, "cloudState") ?? "";
  const precipitationType = attrString(precipitation, "precipitationType") ?? "";
  const visualRange = attrNumber(fog, "visualRange");
  let weather: EnvironmentPresetWeather | undefined;
  if (visualRange !== null) {
    const matched = WEATHER_BY_KEY[weatherKey(cloudState, precipitationType, visualRange)];
    if (matched) weather = matched;
    else unmatched.push(`Weather cloudState="${cloudState}" visualRange="${visualRange}"`);
  } else {
    unmatched.push("Weather is missing a Fog visualRange");
  }

  const friction = attrNumber(roadCondition, "frictionScaleFactor");
  let roadSurface: EnvironmentPresetRoadSurface | undefined;
  if (friction !== null) {
    const matched = ROAD_SURFACE_BY_FRICTION.find(([value]) => value === friction);
    if (matched) roadSurface = matched[1];
    else unmatched.push(`RoadCondition frictionScaleFactor="${friction}"`);
  }

  // The writer's own no-preset output: clear sky, dry road, fallback sun. A
  // preset naming those three would re-export identically, but claiming the
  // author picked them when they did not is the invention this module refuses.
  const isWriterDefaultBlock =
    lighting === undefined && weather === "CLEAR_SKY" && roadSurface === "DRY_ROAD";
  if (isWriterDefaultBlock) return { preset: null, unmatched };

  const preset: EnvironmentPreset = {
    ...(lighting === undefined ? {} : { lighting }),
    ...(weather === undefined ? {} : { weather }),
    ...(roadSurface === undefined ? {} : { roadSurface }),
  };
  const empty =
    preset.lighting === undefined &&
    preset.weather === undefined &&
    preset.roadSurface === undefined;
  return { preset: empty ? null : preset, unmatched };
}
