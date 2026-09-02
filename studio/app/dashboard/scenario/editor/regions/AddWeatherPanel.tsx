"use client";

import {
  Clock3,
  Cloud,
  CloudFog,
  CloudRain,
  CloudRainWind,
  CloudSnow,
  CloudSun,
  Droplets,
  Layers,
  RotateCcw,
  Snowflake,
  Sun,
  Wind,
} from "lucide-react";
import type { CSSProperties } from "react";
import type { EditorDocument } from "@simforge-oss/editor";
import type { Weather } from "@simforge-oss/scenario";
import {
  LIGHTING_FIELDS,
  LIGHTING_RANGES,
  resolveEditorLightingOverrides,
  withEditorLightingOverrides,
  type LightingField,
} from "@simforge-oss/scenario/contracts";

import {
  resolveEditorWeatherControls,
  withEditorWeatherControls,
  type SnowCoverPreset,
  type WindPreset,
} from "../weather-controls";
import {
  formatSceneTime,
  localSceneMinutes,
  resolveSceneSliderMinutes,
  withSceneMinutes,
} from "../scene-time";
import {
  matchesSearch,
  PanelSection,
  PanelTile,
  PanelTileGrid,
  type SceneSearchResult,
} from "./panel-tiles";

interface WeatherChoice {
  value: Weather;
  label: string;
  detail: string;
  icon: typeof Sun;
}

/** Every weather the scene can be authored in, as things you pick by sight. */
const WEATHER_CHOICES: readonly WeatherChoice[] = [
  { value: "clear", label: "Clear", detail: "Dry, hard shadows", icon: Sun },
  { value: "cloudy", label: "Cloudy", detail: "Soft shadows", icon: CloudSun },
  { value: "overcast", label: "Overcast", detail: "Flat light", icon: Cloud },
  { value: "light_rain", label: "Rain", detail: "Wet road, spray", icon: CloudRain },
  { value: "heavy_rain", label: "Heavy rain", detail: "Standing water", icon: CloudRainWind },
  { value: "wet_road", label: "Wet road", detail: "Rain has stopped", icon: Droplets },
  { value: "fog_light", label: "Fog", detail: "Reduced range", icon: CloudFog },
  { value: "fog_dense", label: "Dense fog", detail: "Near-zero range", icon: CloudFog },
  { value: "snow", label: "Snow", detail: "Falling snow", icon: Snowflake },
  { value: "sleet", label: "Sleet", detail: "Snow and rain", icon: CloudSnow },
];

const WIND_CHOICES: readonly { value: WindPreset; label: string; detail: string }[] = [
  { value: "calm", label: "Calm", detail: "No drift" },
  { value: "breezy", label: "Breezy", detail: "Angled fall" },
  { value: "strong", label: "Strong", detail: "Driven sideways" },
];

const SNOW_COVER_CHOICES: readonly { value: SnowCoverPreset; label: string; detail: string }[] = [
  { value: "none", label: "None", detail: "Bare road" },
  { value: "dusting", label: "Dusting", detail: "Thin cover" },
  { value: "covered", label: "Covered", detail: "Full cover" },
  { value: "deep", label: "Deep", detail: "Deep cover" },
];

const WIND_WEATHER: readonly Weather[] = ["light_rain", "heavy_rain", "snow", "sleet"];
const SNOW_COVER_WEATHER: readonly Weather[] = ["snow", "sleet"];

/**
 * Weather hits for the universal search. The panel owns the vocabulary, so a
 * search for "rain" finds the weather tile without the search surface knowing
 * that weather exists.
 */
export function weatherSearchResults(
  query: string,
  document: EditorDocument | null,
): SceneSearchResult[] {
  if (!document) return [];
  const environment = document.data.environment;
  const controls = resolveEditorWeatherControls(environment);
  const results: SceneSearchResult[] = [];
  for (const choice of WEATHER_CHOICES) {
    if (!matchesSearch(query, choice.label, choice.detail, "weather", choice.value)) continue;
    const Icon = choice.icon;
    results.push({
      id: `weather.${choice.value}`,
      label: choice.label,
      detail: choice.detail,
      group: "Weather",
      icon: <Icon aria-hidden="true" size={22} strokeWidth={1.6} />,
      active: environment.weather === choice.value,
      apply: () => document.setEnvironment({ ...document.data.environment, weather: choice.value }),
    });
  }
  for (const choice of WIND_CHOICES) {
    if (!matchesSearch(query, choice.label, choice.detail, "wind")) continue;
    results.push({
      id: `wind.${choice.value}`,
      label: `${choice.label} wind`,
      detail: choice.detail,
      group: "Weather",
      icon: <Wind aria-hidden="true" size={22} strokeWidth={1.6} />,
      active: controls.wind === choice.value,
      apply: () => document.setEnvironment(
        withEditorWeatherControls(document.data.environment, { wind: choice.value }),
      ),
    });
  }
  for (const choice of SNOW_COVER_CHOICES) {
    if (!matchesSearch(query, choice.label, choice.detail, "snow cover")) continue;
    results.push({
      id: `snow.${choice.value}`,
      label: `${choice.label} snow`,
      detail: choice.detail,
      group: "Weather",
      icon: <Layers aria-hidden="true" size={22} strokeWidth={1.6} />,
      active: controls.snowCover === choice.value,
      apply: () => document.setEnvironment(
        withEditorWeatherControls(document.data.environment, { snowCover: choice.value }),
      ),
    });
  }
  return results;
}

/**
 * Weather as a gallery, in the add-actor panel.
 *
 * The scene's weather is chosen the same way its cars are: look at the tiles,
 * click the one you want. Time of day stays a slider — it is continuous, and no
 * grid of six labels can say 4:37 PM.
 */
export function AddWeatherPanel({ document }: { document: EditorDocument | null }) {
  const environment = document?.data.environment ?? null;
  if (!document || !environment) {
    return (
      <p style={styles.unavailable} data-testid="add-weather-unavailable">
        Weather becomes editable once the scenario finishes loading.
      </p>
    );
  }

  const controls = resolveEditorWeatherControls(environment);
  const sceneMinutes = resolveSceneSliderMinutes(environment);
  const showWind = WIND_WEATHER.includes(environment.weather);
  const showSnowCover = SNOW_COVER_WEATHER.includes(environment.weather);

  return (
    <div data-testid="add-weather-panel">
      <PanelSection count={WEATHER_CHOICES.length} label="Weather" testId="weather-section-weather">
        <PanelTileGrid>
          {WEATHER_CHOICES.map((choice, index) => {
            const Icon = choice.icon;
            return (
              <PanelTile
                active={environment.weather === choice.value}
                detail={choice.detail}
                icon={<Icon aria-hidden="true" size={22} strokeWidth={1.6} />}
                index={index}
                key={choice.value}
                label={choice.label}
                onChoose={() => document.setEnvironment({ ...document.data.environment, weather: choice.value })}
                testId={`weather-${choice.value}`}
              />
            );
          })}
        </PanelTileGrid>
      </PanelSection>

      {showWind ? (
        <PanelSection label="Wind" testId="weather-section-wind">
          <PanelTileGrid>
            {WIND_CHOICES.map((choice, index) => (
              <PanelTile
                active={controls.wind === choice.value}
                detail={choice.detail}
                icon={<Wind aria-hidden="true" size={22} strokeWidth={1.6} />}
                index={index}
                key={choice.value}
                label={choice.label}
                onChoose={() => document.setEnvironment(
                  withEditorWeatherControls(document.data.environment, { wind: choice.value }),
                )}
                testId={`weather-wind-${choice.value}`}
              />
            ))}
          </PanelTileGrid>
        </PanelSection>
      ) : null}

      {showSnowCover ? (
        <PanelSection label="Snow level" testId="weather-section-snow">
          <PanelTileGrid>
            {SNOW_COVER_CHOICES.map((choice, index) => (
              <PanelTile
                active={controls.snowCover === choice.value}
                detail={choice.detail}
                icon={<Layers aria-hidden="true" size={22} strokeWidth={1.6} />}
                index={index}
                key={choice.value}
                label={choice.label}
                onChoose={() => document.setEnvironment(
                  withEditorWeatherControls(document.data.environment, { snowCover: choice.value }),
                )}
                testId={`weather-snow-${choice.value}`}
              />
            ))}
          </PanelTileGrid>
        </PanelSection>
      ) : null}

      <PanelSection label="Time of day" testId="weather-section-time">
        <div style={styles.timeRow}>
          <span style={styles.timeValue}>{formatSceneTime(sceneMinutes)}</span>
          <button
            className="actor-chip"
            onClick={() => document.setEnvironment(withSceneMinutes(document.data.environment, localSceneMinutes()))}
            style={styles.timeNow}
            type="button"
          >
            <Clock3 aria-hidden="true" size={11} />
            <span>Now</span>
          </button>
        </div>
        <input
          aria-label="Scene time"
          max={24 * 60 - 1}
          min={0}
          onChange={(event) => document.setEnvironment(
            withSceneMinutes(document.data.environment, Number(event.currentTarget.value)),
          )}
          step={5}
          style={styles.timeSlider}
          type="range"
          value={sceneMinutes}
        />
        <div style={styles.timeScale}>
          <span>12 AM</span>
          <span>6 AM</span>
          <span>12 PM</span>
          <span>6 PM</span>
          <span>12 AM</span>
        </div>
      </PanelSection>

      <LightingSection document={document} />
    </div>
  );
}


interface LightingControl {
  readonly field: LightingField;
  readonly label: string;
  readonly detail: string;
  /** Renders the authored number the way an author reads it. */
  readonly format: (value: number) => string;
}

/**
 * The numbers an author reaches for when a preset is close but not the shot.
 *
 * Every one is an override: the row reads "Preset" until it is touched, and the
 * reset returns it to whatever the weather and clock resolved to. That is what
 * keeps a scenario portable — nothing here is required for the scene to be
 * described, so an untouched scenario carries no lighting block at all.
 */
const LIGHTING_CONTROLS: readonly LightingControl[] = [
  {
    field: "ambient",
    label: "Ambient light",
    detail: "Sky fill on everything the sun misses",
    format: (value) => `${Math.round(value * 100)}%`,
  },
  {
    field: "sun",
    label: "Sun intensity",
    detail: "Strength of the direct beam",
    format: (value) => `${Math.round(value * 100)}%`,
  },
  {
    field: "sunWarmth",
    label: "Sun warmth",
    detail: "Cool blue through to warm amber",
    format: (value) => (value === 0 ? "Neutral" : `${value > 0 ? "+" : ""}${Math.round(value * 100)}`),
  },
  {
    field: "exposure",
    label: "Exposure",
    detail: "Tone-mapping stop for the whole frame",
    format: (value) => `${value.toFixed(2)}x`,
  },
  {
    field: "sky",
    label: "Sky brightness",
    detail: "How bright the dome itself reads",
    format: (value) => `${Math.round(value * 100)}%`,
  },
  {
    field: "haze",
    label: "Haze",
    detail: "Atmospheric scatter near the horizon",
    format: (value) => `${Math.round(value * 100)}%`,
  },
  {
    field: "visibilityM",
    label: "Visibility",
    detail: "Meteorological (Koschmieder) range; clear air is 80 km",
    format: (value) => (value >= LIGHTING_RANGES.visibilityM.max
      ? "Unlimited"
      : value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} km` : `${Math.round(value)} m`),
  },
];

function LightingSection({ document }: { document: EditorDocument }) {
  const environment = document.data.environment;
  const overrides = resolveEditorLightingOverrides(environment);
  const authoredCount = Object.keys(overrides).length;

  return (
    <PanelSection
      count={authoredCount === 0 ? undefined : authoredCount}
      label="Lighting"
      testId="weather-section-lighting"
    >
      <div style={styles.lightingNote}>
        {authoredCount === 0
          ? "Following the weather and clock. Move a slider to take manual control."
          : `${authoredCount} authored ${authoredCount === 1 ? "override" : "overrides"} on top of the preset.`}
        {authoredCount > 0 ? (
          <button
            onClick={() => document.setEnvironment(
              withEditorLightingOverrides(
                document.data.environment,
                Object.fromEntries(LIGHTING_FIELDS.map((field) => [field, undefined])),
              ),
            )}
            style={styles.lightingResetAll}
            type="button"
          >
            <RotateCcw aria-hidden="true" size={10} />
            <span>Reset all</span>
          </button>
        ) : null}
      </div>

      {LIGHTING_CONTROLS.map((control) => {
        const range = LIGHTING_RANGES[control.field];
        const authored = overrides[control.field];
        const value = authored ?? range.neutral;
        return (
          <div key={control.field} style={styles.lightingRow}>
            <div style={styles.lightingHead}>
              <span style={styles.lightingLabel}>{control.label}</span>
              <span
                data-testid={`lighting-value-${control.field}`}
                style={authored === undefined ? styles.lightingPreset : styles.lightingValue}
              >
                {authored === undefined ? "Preset" : control.format(authored)}
              </span>
              {authored === undefined ? null : (
                <button
                  aria-label={`Reset ${control.label}`}
                  onClick={() => document.setEnvironment(
                    withEditorLightingOverrides(document.data.environment, {
                      [control.field]: undefined,
                    }),
                  )}
                  style={styles.lightingReset}
                  type="button"
                >
                  <RotateCcw aria-hidden="true" size={9} />
                </button>
              )}
            </div>
            <input
              aria-label={control.label}
              max={range.max}
              min={range.min}
              onChange={(event) => document.setEnvironment(
                withEditorLightingOverrides(document.data.environment, {
                  [control.field]: Number(event.currentTarget.value),
                }),
              )}
              step={range.step}
              style={styles.timeSlider}
              type="range"
              value={value}
            />
            <p style={styles.lightingDetail}>{control.detail}</p>
          </div>
        );
      })}

      <SunDirectionRows document={document} />
    </PanelSection>
  );
}

/**
 * Sun direction.
 *
 * Unlike everything above, these are execution-schema fields, not renderer
 * knobs: the sensor model reads them for glare. The clock recomputes them on
 * every change, so the row says as much rather than pretending an authored
 * angle survives a time-of-day edit.
 */
function SunDirectionRows({ document }: { document: EditorDocument }) {
  const environment = document.data.environment;
  const azimuth = typeof environment.sunAzimuthDeg === "number"
    ? environment.sunAzimuthDeg
    : null;
  const elevation = typeof environment.sunElevationDeg === "number"
    ? environment.sunElevationDeg
    : null;

  return (
    <>
      <div style={styles.lightingRow}>
        <div style={styles.lightingHead}>
          <span style={styles.lightingLabel}>Sun azimuth</span>
          <span data-testid="lighting-value-sunAzimuthDeg" style={styles.lightingValue}>
            {azimuth === null ? "From clock" : `${Math.round(azimuth)}\u00b0`}
          </span>
        </div>
        <input
          aria-label="Sun azimuth"
          max={360}
          min={0}
          onChange={(event) => document.setEnvironment({
            ...document.data.environment,
            sunAzimuthDeg: Number(event.currentTarget.value),
          })}
          step={1}
          style={styles.timeSlider}
          type="range"
          value={azimuth ?? 180}
        />
        <p style={styles.lightingDetail}>Clockwise from the corridor, not the compass</p>
      </div>

      <div style={styles.lightingRow}>
        <div style={styles.lightingHead}>
          <span style={styles.lightingLabel}>Sun elevation</span>
          <span data-testid="lighting-value-sunElevationDeg" style={styles.lightingValue}>
            {elevation === null ? "From clock" : `${Math.round(elevation)}\u00b0`}
          </span>
        </div>
        <input
          aria-label="Sun elevation"
          max={90}
          min={-20}
          onChange={(event) => document.setEnvironment({
            ...document.data.environment,
            sunElevationDeg: Number(event.currentTarget.value),
          })}
          step={1}
          style={styles.timeSlider}
          type="range"
          value={elevation ?? 45}
        />
        <p style={styles.lightingDetail}>Below 0 is under the horizon; moving the clock recomputes both</p>
      </div>
    </>
  );
}

const styles: Record<string, CSSProperties> = {
  lightingNote: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, margin: "2px 0 10px", color: "#8d97a5", fontSize: 9, lineHeight: 1.5 },
  lightingResetAll: { display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, minHeight: 22, padding: "3px 8px", border: "1px solid rgba(255,255,255,.12)", borderRadius: 999, background: "rgba(255,255,255,.045)", color: "#9aa3b0", font: "inherit", fontSize: 9, cursor: "pointer" },
  lightingRow: { marginBottom: 12 },
  lightingHead: { display: "flex", alignItems: "center", gap: 6, marginBottom: 3 },
  lightingLabel: { flex: 1, color: "#dfe4ec", fontSize: 10, fontWeight: 600 },
  lightingValue: { color: "#E8E044", fontSize: 10, fontWeight: 620, fontVariantNumeric: "tabular-nums" },
  lightingPreset: { color: "#737c89", fontSize: 9 },
  lightingReset: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, padding: 0, border: "1px solid rgba(255,255,255,.12)", borderRadius: 999, background: "transparent", color: "#9aa3b0", cursor: "pointer" },
  lightingDetail: { margin: "2px 0 0", color: "#737c89", fontSize: 8, lineHeight: 1.5 },
  unavailable: { padding: "10px 0", color: "#8d97a5", fontSize: 10, lineHeight: 1.5 },
  timeRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 },
  timeValue: { color: "#eef1f6", fontSize: 13, fontWeight: 620, fontVariantNumeric: "tabular-nums" },
  timeNow: { display: "inline-flex", alignItems: "center", gap: 5, minHeight: 24, padding: "4px 9px", border: "1px solid rgba(255,255,255,.12)", borderRadius: 999, background: "rgba(255,255,255,.045)", color: "#9aa3b0", font: "inherit", fontSize: 9, cursor: "pointer" },
  timeSlider: { width: "100%", height: 18, accentColor: "#E8E044", cursor: "pointer" },
  timeScale: { display: "flex", justifyContent: "space-between", marginTop: 2, color: "#737c89", fontSize: 8 },
};
