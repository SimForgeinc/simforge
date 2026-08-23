import {
  DEFAULT_CAMERA_CONTROL_PREFERENCES,
  type CameraControlPreferences,
} from "@uniscenarios/city-renderer";
import type { CameraMode } from "@uniscenarios/city-renderer";

/**
 * Viewport settings: the camera-control preferences plus what the scene draws.
 *
 * `CameraControlPreferences` and `viewer.setCameraControlPreferences` already existed. Nothing outside
 * the renderer ever called the setter, so every session ran on the frozen defaults and the invert flags
 * and sensitivities were unreachable — controls that could not be corrected by anyone who disliked them.
 * This module is the persisted state behind the panel that finally drives it.
 *
 * Percentages are stored exactly as the renderer's API expects them: `setControlPreferences` does its own
 * conversion to internal multipliers, so 100 means "the default feel" and storing pre-multiplied values
 * here would be normalized a second time.
 */

/** Which scene layers the panel can toggle. Mirrors `viewer.setLayerVisible`'s accepted keys. */
export type ViewportLayerKey = "city" | "vegetation" | "road";

export type ViewportSettings = {
  cameraMode: CameraMode;
  controls: CameraControlPreferences;
  layers: Record<ViewportLayerKey, boolean>;
};

export const DEFAULT_VIEWPORT_SETTINGS: Readonly<ViewportSettings> = Object.freeze({
  cameraMode: "orbit" as CameraMode,
  controls: { ...DEFAULT_CAMERA_CONTROL_PREFERENCES },
  layers: { city: true, vegetation: true, road: true },
});

/**
 * Slider bounds, matching what the renderer actually honours.
 *
 * `cameraSensitivityMultiplier` clamps to 25–300 and `cameraLookSensitivityMultiplier` to 25–750. Using
 * wider bounds here would render a slider whose top third does nothing — the value would move, the camera
 * would not, and the control would read as broken.
 */
export const SENSITIVITY_RANGE = { min: 25, max: 300 } as const;
export const LOOK_SENSITIVITY_RANGE = { min: 25, max: 750 } as const;

const STORAGE_KEY = "uniscenario.viewport-settings.v2";
const LEGACY_STORAGE_KEY = "uniscenario.viewport-settings.v1";

/** Preserve the physical feel of v1 values after 40% became normalized 100%. */
function migrateLegacyLookSensitivity(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const source = raw as Partial<ViewportSettings>;
  if (!source.controls || typeof source.controls !== "object") return raw;
  const controls = source.controls as Partial<CameraControlPreferences>;
  const normalizeLegacy = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value / 0.4 : value;
  return {
    ...source,
    controls: {
      ...controls,
      horizontalLookSensitivity: normalizeLegacy(controls.horizontalLookSensitivity),
      verticalLookSensitivity: normalizeLegacy(controls.verticalLookSensitivity),
    },
  };
}

/**
 * Clamp a stored sensitivity, accepting only a real number.
 *
 * Deliberately not `Number(value)`: `Number(null)` is `0`, which is finite, so coercing would turn a
 * `null` — the shape "this key was absent" takes in stored JSON — into the slowest legal setting instead
 * of the default. Values are written with `JSON.stringify`, so a legitimate one always reads back as a
 * number; anything else is corruption and takes the fallback.
 *
 * A stored `0` is a number and is clamped to `min`, which is correct: zero is below the range the
 * renderer honours, not a request for the default.
 */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Rebuild settings from unknown stored JSON.
 *
 * Every field is validated against the defaults rather than spread in. Stored settings outlive the code
 * that wrote them: a renamed key, a hand-edited value, or a half-written record would otherwise reach the
 * renderer as `NaN` and leave the camera unusable with no way to tell why.
 */
export function normalizeViewportSettings(raw: unknown): ViewportSettings {
  const source = (raw ?? {}) as Partial<ViewportSettings>;
  const controls = (source.controls ?? {}) as Partial<CameraControlPreferences>;
  const layers = (source.layers ?? {}) as Partial<Record<ViewportLayerKey, boolean>>;
  const d = DEFAULT_VIEWPORT_SETTINGS;
  return {
    cameraMode: source.cameraMode === "fly" ? "fly" : "orbit",
    controls: {
      reverseHorizontalLook: bool(controls.reverseHorizontalLook, d.controls.reverseHorizontalLook),
      reverseVerticalLook: bool(controls.reverseVerticalLook, d.controls.reverseVerticalLook),
      reverseHorizontalPan: bool(controls.reverseHorizontalPan, d.controls.reverseHorizontalPan),
      reverseVerticalPan: bool(controls.reverseVerticalPan, d.controls.reverseVerticalPan),
      horizontalLookSensitivity: clamp(
        controls.horizontalLookSensitivity,
        LOOK_SENSITIVITY_RANGE.min,
        LOOK_SENSITIVITY_RANGE.max,
        d.controls.horizontalLookSensitivity,
      ),
      verticalLookSensitivity: clamp(
        controls.verticalLookSensitivity,
        LOOK_SENSITIVITY_RANGE.min,
        LOOK_SENSITIVITY_RANGE.max,
        d.controls.verticalLookSensitivity,
      ),
      middlePanSensitivity: clamp(
        controls.middlePanSensitivity,
        SENSITIVITY_RANGE.min,
        SENSITIVITY_RANGE.max,
        d.controls.middlePanSensitivity,
      ),
      rightPanSensitivity: clamp(
        controls.rightPanSensitivity,
        SENSITIVITY_RANGE.min,
        SENSITIVITY_RANGE.max,
        d.controls.rightPanSensitivity,
      ),
      wheelZoomSensitivity: clamp(
        controls.wheelZoomSensitivity,
        SENSITIVITY_RANGE.min,
        SENSITIVITY_RANGE.max,
        d.controls.wheelZoomSensitivity,
      ),
      keyboardMoveSensitivity: clamp(
        controls.keyboardMoveSensitivity,
        SENSITIVITY_RANGE.min,
        SENSITIVITY_RANGE.max,
        d.controls.keyboardMoveSensitivity,
      ),
      keyboardTurnSensitivity: clamp(
        controls.keyboardTurnSensitivity,
        SENSITIVITY_RANGE.min,
        SENSITIVITY_RANGE.max,
        d.controls.keyboardTurnSensitivity,
      ),
    },
    layers: {
      city: bool(layers.city, d.layers.city),
      vegetation: bool(layers.vegetation, d.layers.vegetation),
      road: bool(layers.road, d.layers.road),
    },
  };
}

/** Read stored settings. Returns the defaults on absent, unparseable, or unavailable storage. */
export function loadViewportSettings(): ViewportSettings {
  if (typeof window === "undefined") return normalizeViewportSettings(null);
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return normalizeViewportSettings(JSON.parse(stored));
    const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    return normalizeViewportSettings(legacy ? migrateLegacyLookSensitivity(JSON.parse(legacy)) : null);
  } catch {
    // Private-mode storage, a quota error, or malformed JSON. Defaults are always a working camera.
    return normalizeViewportSettings(null);
  }
}

/** Persist settings. Silent on failure: losing a preference must never break the editor. */
export function saveViewportSettings(settings: ViewportSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked. The in-memory settings still drive this session.
  }
}

/** Whether anything differs from the defaults — drives whether a reset is worth offering. */
export function isDefaultViewportSettings(settings: ViewportSettings): boolean {
  return (
    JSON.stringify(normalizeViewportSettings(settings)) ===
    JSON.stringify(normalizeViewportSettings(null))
  );
}
