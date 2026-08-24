import { create } from "zustand";

/**
 * Which way the primary map is being looked at: flat, or orbitable with real
 * models on the road.
 *
 * One piece of state, everything else derived from it. The two actor renderers
 * are never both on — `mapViewMode` gates each, and that is the whole mechanism.
 * There is deliberately no zoom threshold, no cross-fade and no LOD swap: once
 * the user has said "3D", the interface does not get to quietly change its mind
 * because they zoomed out.
 *
 * The map instance itself is never remounted across a toggle. Sources, tiles, GL
 * context and viewport all survive; only layer visibility and the camera change.
 * Selection, the playhead, playback state, the active tool and the undo stack
 * survive for free, because all of them live in stores that know nothing about
 * the map.
 *
 * ## Persistence
 *
 * One `localStorage` key, global rather than per-scenario, **defaulting to 2D**.
 * 2D is the authoring view and what every existing user expects; per-scenario
 * memory would make the same scenario open differently for two people, which is
 * worse than one stable default.
 *
 * The remembered pitch/bearing is what makes `3D -> 2D -> 3D` return to the angle
 * you were working at instead of resetting.
 */

/**
 * `twin` is the streamed 3D digital twin — the real city geometry from the map
 * viewer, not MapLibre. It is a THIRD surface rather than a variant of `3d`,
 * because `3d` is a three.js custom layer inside MapLibre's WebGL2 context
 * while the twin is a `three/webgpu` renderer on its own canvas. The two cannot
 * share a context, so they cannot be the same mode.
 */
export type MapViewMode = "2d" | "3d" | "twin";

/**
 * What the map opens as before anyone has chosen.
 *
 * 3D. A scenario is a thing that happens on a road at a scale a person can see
 * from a car, and the flat view answers a different question — it is a plan, not
 * a scene. It also puts the pitched camera on the default path, which is the one
 * with `useHorizonSafeDragPan` panning it and MAX_3D_PITCH available.
 *
 * A stored preference still wins: this is the value for a browser that has never
 * touched the toggle, not an override of one that has.
 */
export const DEFAULT_MAP_VIEW_MODE: MapViewMode = "3d";

const STORAGE_KEY = "simforge.editor.map-view-mode";

/** A first look at 3D that shows depth without tipping into a driver's view. */
export const DEFAULT_3D_PITCH = 50;
export const DEFAULT_3D_BEARING = 0;
/**
 * How far the camera may tip toward the ground plane.
 *
 * 75° left 15° of leeway short of horizontal, which is not enough to get the
 * camera down to where a driver sits — the angle a scenario is actually judged
 * from. Half of that remaining leeway is given back here. MapLibre's own hard
 * ceiling is 85°, and going the whole way there puts the horizon at the very
 * top of the canvas with most of the frame spent on sky.
 */
export const MAX_3D_PITCH = 82.5;

/** Long enough to read as a camera move, short enough not to be in the way. */
export const MAP_VIEW_MODE_EASE_MS = 420;

interface MapViewModeState {
  mode: MapViewMode;
  /** Pitch/bearing the user last worked at in 3D. */
  pitch: number;
  bearing: number;
  /**
   * Keep the map centred on the selected actor while the timeline plays.
   *
   * This is the docked 3D panel's follow camera, and the one capability the map
   * did not already have — which is why it was ported here rather than lost when
   * that panel was retired. Deliberately NOT persisted: it is a thing you switch
   * on to watch one run, not a preference.
   */
  followSelectedActor: boolean;
  /**
   * Whether the digital twin is offered at all.
   *
   * Off by default, and the toggle simply does not draw a Twin button until it
   * is on. The twin is unfinished work — a tile stream and a WebGPU context
   * behind a button that most of the time shows an empty scene — and a control
   * that is present but not ready is worse than one that is absent: it reads as
   * a broken feature rather than an unbuilt one.
   *
   * Persisted like the mode, so switching it on in Settings survives a reload.
   */
  twinEnabled: boolean;
  /** False until `hydrateFromStorage` has run, so SSR and the client agree. */
  hydrated: boolean;
  /**
   * Bring up a view that shows the world in three dimensions, and report which
   * one the author ended up on.
   *
   * Path drawing calls this: you are tracing where a car will drive, and a
   * pitched view of the road is a better surface for that than a flat one.
   *
   * It targets `3d` — MapLibre with real vehicle and signal models — and NOT
   * the twin. The twin is behind an experimental toggle and gated on a per-map
   * artifact, so preferring it meant the gesture usually asked for a surface it
   * could not have. `3d` has neither gate: it is the same MapLibre instance,
   * the same click router and the same overlays, so drawing works there
   * unconditionally.
   *
   * An author already in a spatial mode is left where they are — including in
   * the twin, which draws paths perfectly well when it is switched on. Yanking
   * someone out of the view they chose is worse than the view being imperfect.
   */
  preferSpatialSurface: () => MapViewMode;
  setMode: (mode: MapViewMode) => void;
  setTwinEnabled: (enabled: boolean) => void;
  toggleMode: () => void;
  setFollowSelectedActor: (follow: boolean) => void;
  rememberCamera: (camera: { pitch: number; bearing: number }) => void;
  hydrateFromStorage: () => void;
}

interface PersistedShape {
  mode?: unknown;
  pitch?: unknown;
  bearing?: unknown;
  twinEnabled?: unknown;
}

function clampPitch(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_3D_PITCH;
  return Math.min(MAX_3D_PITCH, Math.max(0, value));
}

function normalizeBearing(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_3D_BEARING;
  const wrapped = value % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

export function parsePersistedMapViewMode(raw: string | null): {
  mode: MapViewMode;
  pitch: number;
  bearing: number;
  twinEnabled: boolean;
} {
  const fallback = {
    mode: DEFAULT_MAP_VIEW_MODE,
    pitch: DEFAULT_3D_PITCH,
    bearing: DEFAULT_3D_BEARING,
    twinEnabled: false,
  };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as PersistedShape;
    const twinEnabled = parsed.twinEnabled === true;
    // `2d` is listed explicitly rather than being the else-branch: it is now a
    // CHOICE the author made and a record has to be able to hold it, while an
    // unreadable mode falls back to the default like every other bad field.
    const mode =
      parsed.mode === "3d" || parsed.mode === "twin" || parsed.mode === "2d"
        ? parsed.mode
        : fallback.mode;
    return {
      // A stored `twin` with the setting off would restore a mode whose button
      // is no longer on screen — a view you cannot leave the way you entered.
      mode: mode === "twin" && !twinEnabled ? "3d" : mode,
      pitch: clampPitch(parsed.pitch),
      bearing: normalizeBearing(parsed.bearing),
      twinEnabled,
    };
  } catch {
    return fallback;
  }
}

function persist(
  state: Pick<MapViewModeState, "mode" | "pitch" | "bearing" | "twinEnabled">,
) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        mode: state.mode,
        pitch: state.pitch,
        bearing: state.bearing,
        twinEnabled: state.twinEnabled,
      }),
    );
  } catch {
    // A private-mode browser with storage disabled still gets a working toggle,
    // it just does not remember it.
  }
}

export const useMapViewModeStore = create<MapViewModeState>()((set, get) => ({
  mode: DEFAULT_MAP_VIEW_MODE,
  pitch: DEFAULT_3D_PITCH,
  bearing: DEFAULT_3D_BEARING,
  followSelectedActor: false,
  twinEnabled: false,
  hydrated: false,
  preferSpatialSurface: () => {
    if (get().mode === "2d") get().setMode("3d");
    // Read the mode back rather than assuming the set took. `setMode` can
    // refuse silently, and a caller whose job is to say which surface the
    // author is drawing on must not report one they were not given.
    return get().mode;
  },
  setMode: (mode) => {
    if (get().mode === mode) return;
    // The last word on whether the twin is reachable. The toggle already hides
    // its button, but the mode is also settable from a restored preference and
    // from `toggleMode`, and a disabled twin must not be reachable by any of
    // them.
    if (mode === "twin" && !get().twinEnabled) return;
    // Follow is a 3D camera behaviour; leaving 3D releases it rather than
    // leaving it armed to grab the camera the next time you come back.
    set(mode === "2d" ? { mode, followSelectedActor: false } : { mode });
    persist({ ...get() });
  },
  toggleMode: () => {
    // Shift+D stays a 2D<->3D flip. The twin is a deliberate destination you
    // click into, not somewhere to land by mashing a shortcut — it starts a
    // tile stream and a WebGPU context.
    get().setMode(get().mode === "3d" ? "2d" : "3d");
  },
  setTwinEnabled: (enabled) => {
    if (get().twinEnabled === enabled) return;
    // Switching it off while standing in the twin would strand the author in a
    // view with no button to leave by, so the mode comes back to 3D with it.
    const leavingTwin = !enabled && get().mode === "twin";
    set(leavingTwin ? { twinEnabled: enabled, mode: "3d" } : { twinEnabled: enabled });
    persist({ ...get() });
  },
  setFollowSelectedActor: (follow) => set({ followSelectedActor: follow }),
  rememberCamera: ({ pitch, bearing }) => {
    const next = { pitch: clampPitch(pitch), bearing: normalizeBearing(bearing) };
    const current = get();
    if (current.pitch === next.pitch && current.bearing === next.bearing) return;
    set(next);
    persist({ ...get(), ...next });
  },
  hydrateFromStorage: () => {
    if (get().hydrated || typeof window === "undefined") return;
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      raw = null;
    }
    set({ ...parsePersistedMapViewMode(raw), hydrated: true });
  },
}));
