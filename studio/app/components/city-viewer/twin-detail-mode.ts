/**
 * Lightweight vs heavy: an A/B switch between the twin's current renderer and
 * the one it replaced.
 *
 * `heavy` is not a quality preset — it is the *previous implementation*, kept
 * runnable so the tradeoff can be judged by looking at both rather than by
 * reading a changelog. Every optimisation landed on 2026-07-28 reads this one
 * flag, so the two paths cannot drift apart:
 *
 * | | `light` (current) | `heavy` (previous) |
 * | --- | --- | --- |
 * | Vegetation geometry | decimated client-side per LOD | untouched, full detail |
 * | Vegetation LOD error | renderer-defined curve | the manifest's own values |
 * | Vegetation culling | frustum-culled | never culled |
 * | Refinement while moving | paced on wall time | unlimited |
 * | Vegetation refinement | waits for the camera to settle | immediate |
 *
 * Measured on Belmont: `heavy` renders ~93 M triangles at ~20 fps with 100% of
 * vegetation pinned to LOD0; `light` renders ~13.7 M. The visible cost of
 * `light` is that distant vegetation reads sparser.
 *
 * Chosen by `?detail=heavy` in the URL, or the toggle in the viewer HUD, and
 * remembered in localStorage. Changing it reloads the page: decimation happens
 * at tile-load time, so a live switch would leave a mix of both pipelines in
 * the scene and measure neither.
 */

export type TwinDetailMode = "light" | "heavy";

const STORAGE_KEY = "simforge.twin.detail-mode";
const URL_PARAM = "detail";

export const DEFAULT_TWIN_DETAIL_MODE: TwinDetailMode = "light";

function parse(value: string | null): TwinDetailMode | null {
  return value === "light" || value === "heavy" ? value : null;
}

let cached: TwinDetailMode | null = null;

/**
 * Resolved once per page load, because the streaming pipeline reads it at tile
 * load time and must not see it change underneath a partially-loaded scene.
 */
export function getTwinDetailMode(): TwinDetailMode {
  if (cached) return cached;
  if (typeof window === "undefined") return DEFAULT_TWIN_DETAIL_MODE;

  const fromUrl = parse(
    new URLSearchParams(window.location.search).get(URL_PARAM),
  );
  if (fromUrl) {
    cached = fromUrl;
    return cached;
  }

  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing or a blocked store — fall through to the default.
  }
  cached = parse(stored) ?? DEFAULT_TWIN_DETAIL_MODE;
  return cached;
}

export function isHeavyTwinDetail(): boolean {
  return getTwinDetailMode() === "heavy";
}

/**
 * Persist a mode and reload so the whole scene streams through one pipeline.
 * The URL param is dropped so the stored preference is what takes effect next
 * time, rather than a stale link overriding it forever.
 */
export function setTwinDetailMode(mode: TwinDetailMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Non-fatal: the URL param still works for a one-off comparison.
  }
  cached = mode;
  const url = new URL(window.location.href);
  url.searchParams.delete(URL_PARAM);
  window.location.replace(url.toString());
}

/** Test seam. */
export function resetTwinDetailModeCache(): void {
  cached = null;
}
