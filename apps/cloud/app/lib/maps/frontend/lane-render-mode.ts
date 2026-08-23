/**
 * How lanes are drawn on the map: as filled area polygons (reconstructed from
 * the XODR widths) or as the authored centerline stripes. User-selectable via
 * the Layers panel and remembered across sessions. `filled` is the default;
 * when a map has no lane-polygon sidecar the UI falls back to `centerlines`
 * regardless of the stored preference.
 */
export type LaneRenderMode = "filled" | "centerlines";

export const DEFAULT_LANE_RENDER_MODE: LaneRenderMode = "filled";

const STORAGE_KEY = "simcloud.map.laneRenderMode";

/** Read the persisted preference (SSR-safe; falls back to the default). */
export function loadLaneRenderMode(): LaneRenderMode {
  if (typeof window === "undefined") return DEFAULT_LANE_RENDER_MODE;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "centerlines" || v === "filled" ? v : DEFAULT_LANE_RENDER_MODE;
  } catch {
    return DEFAULT_LANE_RENDER_MODE;
  }
}

/** Persist the preference (best-effort; ignores storage failures). */
export function persistLaneRenderMode(mode: LaneRenderMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore (private mode / quota)
  }
}
