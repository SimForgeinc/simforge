/**
 * What clicking an intersection candidate writes (plan 2026-07-26, section P4).
 *
 * Pure: the current plan list in, the next plan list out, plus what the click
 * MEANT. The caller turns that into one `applySignalPlansChange` and one
 * selection; nothing here touches a store, so the whole commit rule is testable
 * without a map.
 *
 * ## Placement writes forced green, and that is the point
 *
 * The seed is `withTimelineMode` over the junction's own movement table, which
 * lands on `seedForcedGreenProgram`: one phase, `SIGNAL_HOLD_TAIL_S`, every
 * movement green. That is EXACTLY what an unplanned junction already does at
 * runtime, so adding a control changes nothing about the simulation until the
 * author paints. A default that silently altered the scenario's outcome would
 * make "add a control" a thing you could not safely try.
 */

import type { JunctionMovementBinding, JunctionSignalPlan } from "@simforge/studio-shared";
import { mapDefaultPlanWithMovements } from "@/app/lib/scenario-editor/signals/signal-plan-model";
import { withTimelineMode } from "@/app/lib/scenario-editor/signal-timeline-model";
import { isJunctionControlled } from "./intersection-candidates";

export type IntersectionControlPlacement = {
  plans: JunctionSignalPlan[];
  /**
   * False when the junction was already controlled. A second click on a placed
   * marker SELECTS it — re-seeding would discard authored timing, and the
   * gesture that opens a control must not be the gesture that erases it.
   */
  created: boolean;
};

export function placeIntersectionControl({
  plans,
  junctionId,
  movements,
}: {
  plans: readonly JunctionSignalPlan[];
  junctionId: string;
  /** The junction's derived movement table, from the index. */
  movements: readonly JunctionMovementBinding[];
}): IntersectionControlPlacement {
  const existing = plans.find((plan) => plan.junction_id === junctionId) ?? null;
  if (existing && isJunctionControlled(existing)) {
    return { plans: [...plans], created: false };
  }

  // An existing `map_default` plan is the movement-table cache the panel writes
  // on first open, so it is the better base: it already carries the ids the
  // author's later edits are keyed on.
  const base =
    existing ?? mapDefaultPlanWithMovements(junctionId, movements);
  const seeded = withTimelineMode(
    base.movements.length > 0
      ? base
      : { ...base, movements: [...movements] },
  );

  return {
    created: true,
    plans: existing
      ? plans.map((plan) => (plan.junction_id === junctionId ? seeded : plan))
      : [...plans, seeded],
  };
}

/**
 * Drop a junction's control entirely.
 *
 * The junction reverts to forced-green-by-default — which is what unplanned
 * means — its marker returns to the uncontrolled ring, and its SCENE-lane row
 * disappears. The plan is removed rather than reset to `map_default` so the row
 * really does go: `SceneSignalLane` filters `map_default` out, but the junction
 * list would still show it as touched.
 */
export function removeIntersectionControl({
  plans,
  junctionId,
}: {
  plans: readonly JunctionSignalPlan[];
  junctionId: string;
}): JunctionSignalPlan[] {
  return plans.filter((plan) => plan.junction_id !== junctionId);
}
