import {
  UNISCENARIO_AUTHORING_QUALITY_IDS,
  type UniScenarioAuthoringQuality,
} from "@/app/lib/uniscenario/contracts";

export const RENDERING_PREFERENCE_STORAGE_KEY =
  "simforge.rendering-preference.v1";

export const OPEN_RENDERING_PREFERENCE_EVENT =
  "simforge:open-rendering-preference";
export const RENDERING_PREFERENCE_CHANGE_EVENT =
  "simforge:rendering-preference-change";

export type RenderingPreference = UniScenarioAuthoringQuality;

function isRenderingPreference(value: unknown): value is RenderingPreference {
  return UNISCENARIO_AUTHORING_QUALITY_IDS.some((quality) => quality === value);
}

export function usesLightweightRendering(preference: RenderingPreference): boolean {
  return preference !== "high";
}

export function readRenderingPreference(
  storage?: Pick<Storage, "getItem"> | null,
): RenderingPreference | null {
  try {
    const browserStorage =
      storage === undefined
        ? typeof window === "undefined"
          ? null
          : window.localStorage
        : storage;
    if (!browserStorage) return null;
    const stored = browserStorage.getItem(RENDERING_PREFERENCE_STORAGE_KEY);
    return isRenderingPreference(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function saveRenderingPreference(
  preference: RenderingPreference,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const browserStorage =
      storage === undefined
        ? typeof window === "undefined"
          ? null
          : window.localStorage
        : storage;
    browserStorage?.setItem(RENDERING_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // The current session can still use the selection when browser storage is
    // disabled. A future visit will ask again because it cannot be persisted.
  }
  if (storage === undefined && typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<RenderingPreference>(RENDERING_PREFERENCE_CHANGE_EVENT, {
        detail: preference,
      }),
    );
  }
}

/** Ask the dashboard-level gate to reopen the same chooser used on first run. */
export function requestRenderingPreferenceSelection(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_RENDERING_PREFERENCE_EVENT));
}
