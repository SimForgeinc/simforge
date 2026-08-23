import { create } from "zustand";

/**
 * Authoring-aid state for the drive-by-points placement band (plan §6, item 5).
 *
 * Deliberately NOT on the actor draft. Whether an author wants their clicks
 * clamped into the feasible range is a property of how they are working, not of
 * the scenario: it must not travel with the draft, appear in an export, or make
 * two scenarios differ because one was authored with the aid on. Dedicated
 * store rather than threaded props because the toggle lives in the points panel,
 * the clamp happens in the placement controller, and the band is drawn by the
 * map overlay hook — three places, one truth.
 *
 * `clampNotice` is the "moved to feasible range" line. It clears on the next
 * placement that lands inside the band on its own, which is what makes it brief
 * without a timer: the author's next good click is the acknowledgement.
 */
interface PlacementBandState {
  /** Actors whose clamp the author has switched off. Absent = clamping on. */
  clampDisabledActorIds: ReadonlySet<string>;
  clampNotice: string | null;
  toggleClamp: (actorId: string) => void;
  setClampNotice: (notice: string | null) => void;
  reset: () => void;
}

export const usePlacementBandStore = create<PlacementBandState>()((set) => ({
  clampDisabledActorIds: new Set<string>(),
  clampNotice: null,
  toggleClamp: (actorId) =>
    set((state) => {
      const next = new Set(state.clampDisabledActorIds);
      if (next.has(actorId)) next.delete(actorId);
      else next.add(actorId);
      // Turning the aid off with a stale "moved to feasible range" line still on
      // screen would leave the editor explaining a rule it is no longer applying.
      return { clampDisabledActorIds: next, clampNotice: null };
    }),
  setClampNotice: (notice) => set({ clampNotice: notice }),
  reset: () =>
    set({ clampDisabledActorIds: new Set<string>(), clampNotice: null }),
}));

/** Whether clicks for this actor should be clamped into the feasible band. */
export function placementClampEnabled(
  disabled: ReadonlySet<string>,
  actorId: string | null | undefined,
): boolean {
  return actorId != null && !disabled.has(actorId);
}
