import { create } from "zustand";
import {
  withSignalPlanWarnings,
  type JunctionSignalPlan,
  type ScenarioEditorAmbientTraffic,
} from "@simforge-oss/studio-shared";
import type { NormalizedScenarioDraft } from "@/app/lib/scenario-editor/draft-normalization";
import {
  EMPTY_SIGNAL_PLAN_HISTORY,
  lastSignalEditAt,
  lastSignalUndoAt,
  pushSignalPlanHistory,
  redoSignalPlanHistory,
  undoSignalPlanHistory,
  type SignalPlanHistoryState,
} from "@/app/lib/scenario-editor/signal-plan-history";
import type { LocalTemplateRecord } from "@/app/lib/scenario-editor/types";

function samePlans(
  left: readonly JunctionSignalPlan[],
  right: readonly JunctionSignalPlan[],
): boolean {
  return left.length === right.length && JSON.stringify(left) === JSON.stringify(right);
}

interface ActorsState {
  draftMetadata: NormalizedScenarioDraft["metadata"] | null;
  semanticFormations: NormalizedScenarioDraft["semanticFormations"];
  semanticFormationSolutions: NormalizedScenarioDraft["semanticFormationSolutions"];
  /**
   * Traffic-signal authoring, one plan per junction (plan 2026-07-24 §4.3).
   *
   * Draft-level scene state, so it sits beside `semanticFormations` rather than
   * in `editorDocumentStore` — whose undo history is an actors-only envelope
   * with a persisted checksum, and widening that shape would invalidate every
   * saved history in the fleet. Signal edits are undoable through their own
   * in-memory stack instead (`signal-plan-history.ts`), which shares ⌘Z with
   * the actors stack via the dispatcher in `useEditorHotkeys`.
   */
  signalPlans: JunctionSignalPlan[];
  signalPlanHistory: SignalPlanHistoryState;
  /**
   * The scene's declarative ambient-traffic region spec
   * (`setup.scene.ambientTraffic`), or null when the draft has none.
   *
   * Draft-level scene state like `signalPlans` above. Written on draft
   * load/apply from the normalized draft, read at the payload boundary
   * (`buildRuntimeActorPayload`) and by the map model's marker expansion, so a
   * draft whose region lives only in the scene field expands identically in
   * preview, render and on the map. A pre-migration draft still carries the
   * region as an ACTOR instead; the two never coexist (the draft PUT hoist
   * removes the actor as it writes the field), so this stays null for those and
   * the legacy actor path continues to serve them.
   */
  ambientTraffic: ScenarioEditorAmbientTraffic | null;
  draftSaveState: "idle" | "saving" | "saved" | "error";
  templates: LocalTemplateRecord[];
  setDraftMetadata: (
    metadata: NormalizedScenarioDraft["metadata"] | null,
  ) => void;
  setSemanticFormations: (
    formations: NormalizedScenarioDraft["semanticFormations"],
  ) => void;
  setSemanticFormationSolutions: (
    solutions: NormalizedScenarioDraft["semanticFormationSolutions"],
  ) => void;
  /**
   * Replace the whole list — draft load, reset, and scenario switch. Clears the
   * history: undoing across a scenario switch would restore another scenario's
   * junctions onto this one.
   */
  setSignalPlans: (plans: JunctionSignalPlan[]) => void;
  /** Replace the scene's ambient region spec — draft load, apply, and reset. */
  setAmbientTraffic: (ambient: ScenarioEditorAmbientTraffic | null) => void;
  /**
   * The authoring mutation. Recomputes every plan's cached `warnings` on the
   * way out so the panel, the SCENE lane and the export manifest all read one
   * warning list that cannot drift from the plan it describes.
   *
   * Records an undo entry unless `history: false` — which is for writes the
   * author did not make, notably the `map_default` plan the intersection panel
   * seeds on first open to cache a junction's movement table. A ⌘Z that undid
   * "opened a panel" would be a bug, not a feature.
   */
  applySignalPlansChange: (
    updater: (current: JunctionSignalPlan[]) => JunctionSignalPlan[],
    options?: { label?: string; history?: boolean },
  ) => void;
  /** @returns whether anything moved, so the dispatcher can fall through. */
  undoSignalPlans: () => boolean;
  redoSignalPlans: () => boolean;
  setDraftSaveState: (
    state: "idle" | "saving" | "saved" | "error",
  ) => void;
  setTemplates: (
    templates:
      | LocalTemplateRecord[]
      | ((current: LocalTemplateRecord[]) => LocalTemplateRecord[]),
  ) => void;
}

export const useActorsStore = create<ActorsState>()((set, get) => ({
  draftMetadata: null,
  semanticFormations: [],
  semanticFormationSolutions: [],
  signalPlans: [],
  signalPlanHistory: EMPTY_SIGNAL_PLAN_HISTORY,
  ambientTraffic: null,
  draftSaveState: "idle",
  templates: [],
  setDraftMetadata: (metadata) => set({ draftMetadata: metadata }),
  setSemanticFormations: (semanticFormations) => set({ semanticFormations }),
  setSemanticFormationSolutions: (semanticFormationSolutions) => set({ semanticFormationSolutions }),
  setSignalPlans: (signalPlans) =>
    set({ signalPlans, signalPlanHistory: EMPTY_SIGNAL_PLAN_HISTORY }),
  setAmbientTraffic: (ambientTraffic) => set({ ambientTraffic }),
  applySignalPlansChange: (updater, options = {}) =>
    set((state) => {
      const next = updater(state.signalPlans).map((plan) =>
        withSignalPlanWarnings(plan),
      );
      // Compared AFTER the warning recompute, so an edit whose only effect was
      // to re-derive an identical warning list does not consume an undo slot.
      if (samePlans(state.signalPlans, next)) return {};
      if (options.history === false) return { signalPlans: next };
      return {
        signalPlans: next,
        signalPlanHistory: pushSignalPlanHistory({
          history: state.signalPlanHistory,
          label: options.label ?? "Edit signal plan",
          before: state.signalPlans,
        }),
      };
    }),
  undoSignalPlans: () => {
    const state = get();
    const result = undoSignalPlanHistory({
      history: state.signalPlanHistory,
      present: state.signalPlans,
    });
    if (!result.changed) return false;
    set({ signalPlans: result.plans, signalPlanHistory: result.history });
    return true;
  },
  redoSignalPlans: () => {
    const state = get();
    const result = redoSignalPlanHistory({
      history: state.signalPlanHistory,
      present: state.signalPlans,
    });
    if (!result.changed) return false;
    set({ signalPlans: result.plans, signalPlanHistory: result.history });
    return true;
  },
  setDraftSaveState: (saveState) => set({ draftSaveState: saveState }),
  setTemplates: (templatesOrFn) =>
    set((state) => ({
      templates:
        typeof templatesOrFn === "function"
          ? templatesOrFn(state.templates)
          : templatesOrFn,
    })),
}));

/** When the signal stack last recorded an edit. `null` when it has none. */
export function signalPlanLastEditAt(): number | null {
  return lastSignalEditAt(useActorsStore.getState().signalPlanHistory);
}

/** When the signal stack last undid an edit. `null` when there is no redo. */
export function signalPlanLastUndoAt(): number | null {
  return lastSignalUndoAt(useActorsStore.getState().signalPlanHistory);
}
