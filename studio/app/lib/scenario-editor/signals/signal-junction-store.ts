import { create } from "zustand";
import type { EditorTrafficLight } from "@/app/lib/scenario-editor/signals/editor-traffic-lights";
import {
  movementsBySignalId,
  resolveSignalHead,
  type SignalJunctionIndex,
  type SignalJunctionSummary,
} from "@/app/lib/scenario-editor/signals/junction-index";

/**
 * The editor's map-scoped signal data — the signalized-junction index and the
 * physical traffic-light heads — plus the panel's selection.
 *
 * A store rather than props because the two consumers sit at opposite ends of
 * the editor: the glyph layer renders deep inside the shared `MapAssetsMap`
 * (whose prop surface is already ~120 entries and is shared with the map-assets
 * page), and the intersection panel renders in the workspace shell. Outside the
 * editor the store is simply empty, so the layer draws nothing.
 *
 * ## Why the lights live here and not on `sceneStore.bundle`
 *
 * They used to be read from `sceneStore.bundle.runtime.traffic_lights`, and the
 * bootstrap route that fills `bundle` has returned `runtime: null` since it went
 * semantic-first — so every signal surface read an empty list on every map from
 * 2026-07-12 until the 2026-07-27 audit. The heads are a property of the MAP,
 * fetched once per map asset exactly like the junction index and from the same
 * hook, so keeping them next to the index is what makes the two impossible to
 * load out of step. `bundle` remains what it says it is: the scenario's bundle.
 */

/** A junction glyph, pre-projected to lng/lat by the hook that owns the asset. */
export type SignalJunctionGlyph = {
  junction_id: string;
  lng: number;
  lat: number;
  signalized: boolean;
};

type SignalJunctionState = {
  index: SignalJunctionIndex | null;
  glyphs: SignalJunctionGlyph[];
  /**
   * The map's physical signal heads, runtime frame. The source for the 3D heads,
   * the candidate light lists, the placement ghosts and — on a map with no
   * compiled semantic graph — the positional signalization fallback.
   */
  trafficLights: EditorTrafficLight[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  /** The junction the intersection panel is open on. */
  selectedJunctionId: string | null;
  /**
   * The head the author clicked — the light the whole junction is timed from.
   *
   * Editor-local, never on the plan, for the reason `autoYellowByJunction` is
   * not stored either (timeline plan §2.6): the compiled program already says
   * what every movement does and when, so a stored reference would be a field
   * whose only job is to explain a program that explains itself — and one that
   * can therefore disagree with it after a hand edit or an import.
   *
   * The cost is honest and small: reopening a scenario forgets which light led,
   * and the collapsed junction row falls back to the subject actor's approach. The
   * TIMING is fully intact; only the choice of lead row is forgotten.
   */
  referenceSignalId: string | null;
  /** The movements that head drives — the group the lead row resolves to. */
  referenceMovementIds: string[];
  /**
   * Where that head's LAMPS are, in lng/lat — the card's anchor.
   *
   * The card used to anchor on the junction's centre marker, which put it over
   * the middle of the intersection rather than over the light being edited. The
   * housing's own position is the honest anchor: the popup belongs above the
   * thing it configures.
   */
  referenceAnchor: { lng: number; lat: number } | null;
  /**
   * The junction under the pointer, from EITHER surface.
   *
   * One field, shared by the map marker and the SCENE-lane row, is what makes
   * the cross-highlight symmetric by construction: hovering a row raises the
   * marker and brightens its 3D heads, hovering a marker raises the row, and
   * neither surface needs to know the other exists.
   */
  hoveredJunctionId: string | null;
  /** The SCENE-lane clip the panel should scroll to and highlight. */
  selectedSceneClipId: string | null;
  /**
   * Auto-yellow, per junction, default on. Editor-local on purpose: the plan
   * carries the COMPILED result, which is self-describing, so storing the
   * preference on it would give the schema a field whose only job is to explain
   * bands that already explain themselves (timeline plan §2.6).
   */
  autoYellowByJunction: Record<string, boolean>;
  setJunctionAutoYellow: (junctionId: string, enabled: boolean) => void;
  setIndex: (index: SignalJunctionIndex | null, glyphs: SignalJunctionGlyph[]) => void;
  setTrafficLights: (trafficLights: EditorTrafficLight[]) => void;
  setStatus: (status: SignalJunctionState["status"], error?: string | null) => void;
  selectJunction: (junctionId: string | null) => void;
  /**
   * Select a physical head: open its junction AND make it the reference.
   *
   * `null` clears the reference without closing the junction, which is what
   * clicking empty map means — the author is done pointing at that light, not
   * done with the intersection.
   *
   * `signalId: null` is the timeline's entry point: a band names a set of
   * movements, and on a positionally-bound junction none of them carries a head
   * id. The editor still opens on those movements; only the map anchor and the
   * 3D highlight have nothing to attach to.
   */
  selectSignalHead: (
    head: {
      signalId: string | null;
      junctionId: string;
      movementIds: readonly string[];
      anchor?: { lng: number; lat: number } | null;
    } | null,
  ) => void;
  hoverJunction: (junctionId: string | null) => void;
  selectSceneClip: (junctionId: string, clipId: string) => void;
  reset: () => void;
};

const initialState = {
  index: null,
  glyphs: [],
  trafficLights: [] as EditorTrafficLight[],
  status: "idle" as const,
  error: null,
  selectedJunctionId: null,
  referenceSignalId: null,
  referenceMovementIds: [] as string[],
  referenceAnchor: null as { lng: number; lat: number } | null,
  hoveredJunctionId: null,
  selectedSceneClipId: null,
  autoYellowByJunction: {} as Record<string, boolean>,
};

export const useSignalJunctionStore = create<SignalJunctionState>()((set) => ({
  ...initialState,
  setIndex: (index, glyphs) => set({ index, glyphs, status: "ready", error: null }),
  setTrafficLights: (trafficLights) => set({ trafficLights }),
  setStatus: (status, error = null) => set({ status, error }),
  // Moving to a different junction drops the reference: a light belongs to one
  // intersection, and letting it lead another junction's row would pin the lead
  // to a head that is not even drawn there.
  selectJunction: (selectedJunctionId) =>
    set((state) => ({
      selectedJunctionId,
      selectedSceneClipId: null,
      ...(selectedJunctionId === state.selectedJunctionId
        ? null
        : {
            referenceSignalId: null,
            referenceMovementIds: [],
            referenceAnchor: null,
          }),
    })),
  selectSignalHead: (head) =>
    set(
      head
        ? {
            selectedJunctionId: head.junctionId,
            selectedSceneClipId: null,
            referenceSignalId: head.signalId,
            referenceMovementIds: [...head.movementIds],
            referenceAnchor: head.anchor ?? null,
          }
        : {
            referenceSignalId: null,
            referenceMovementIds: [],
            referenceAnchor: null,
          },
    ),
  hoverJunction: (hoveredJunctionId) => set({ hoveredJunctionId }),
  selectSceneClip: (junctionId, clipId) =>
    set({ selectedJunctionId: junctionId, selectedSceneClipId: clipId }),
  setJunctionAutoYellow: (junctionId, enabled) =>
    set((state) => ({
      autoYellowByJunction: { ...state.autoYellowByJunction, [junctionId]: enabled },
    })),
  reset: () => set(initialState),
}));

/**
 * Resolve a clicked head against whatever the store currently holds.
 *
 * A plain function over `getState()` rather than a hook, because its caller is
 * a map click handler — not a render — and because both the click chain and any
 * future keyboard path must resolve a head identically.
 */
export function resolveHeadFromStore(
  signalId: string,
): { signalId: string; junctionId: string; movementIds: string[] } | null {
  const state = useSignalJunctionStore.getState();
  const junctions = state.index?.junctions ?? [];
  if (junctions.length === 0) return null;
  const key = String(signalId).trim();
  if (!key) return null;

  const light = state.trafficLights.find(
    (entry) => entry.opendrive_id != null && String(entry.opendrive_id).trim() === key,
  );
  const resolved = resolveSignalHead({
    bySignalId: movementsBySignalId(junctions),
    junctions,
    openDriveId: key,
    point: light ? { x: light.x, y: light.y } : null,
  });
  if (!resolved) return null;
  return {
    signalId: key,
    junctionId: resolved.junction_id,
    movementIds: resolved.movement_ids,
  };
}

/** The summary behind a junction id, or `null` when the index has not loaded. */
export function junctionSummary(
  index: SignalJunctionIndex | null,
  junctionId: string | null,
): SignalJunctionSummary | null {
  if (!index || !junctionId) return null;
  return (
    index.junctions.find((junction) => junction.junction_id === junctionId) ?? null
  );
}
