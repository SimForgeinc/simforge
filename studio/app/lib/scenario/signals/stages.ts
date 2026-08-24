/**
 * Physical-head selection and executable signal stages.
 *
 * OpenDRIVE may publish several `<controller>` ids for the same executable
 * movement program. Yale Street does this at junction 345: controllers 1569 and
 * 1570 both command movement `signal:1477` and the same six heads. Those ids are
 * aliases, not consecutive phases. The editor therefore groups controllers by
 * their exact movement set before building cycles or timeline rows.
 *
 * Physical references remain untouched in `controllerById`; compilation still
 * validates the exact controller/head pair stored in every clip. Grouping is
 * only the authoring projection of executable stages.
 */

import type {
  EditorSignalController,
  EditorSignalControlProjection,
  EditorSignalDiagnostic,
  EditorSignalHead,
  EditorSignalJunction,
  EditorSignalMovement,
} from "./types";

/** Fast lookups over one projection. Build once per map version, not per click. */
export type EditorSignalIndex = {
  readonly projection: EditorSignalControlProjection;
  readonly headById: ReadonlyMap<string, EditorSignalHead>;
  readonly controllerById: ReadonlyMap<string, EditorSignalController>;
  readonly movementById: ReadonlyMap<string, EditorSignalMovement>;
  readonly junctionById: ReadonlyMap<string, EditorSignalJunction>;
};

export function buildEditorSignalIndex(
  projection: EditorSignalControlProjection,
): EditorSignalIndex {
  return {
    projection,
    headById: new Map(projection.heads.map((head) => [head.id, head])),
    controllerById: new Map(projection.controllers.map((controller) => [controller.id, controller])),
    movementById: new Map(projection.movements.map((movement) => [movement.id, movement])),
    junctionById: new Map(projection.junctions.map((junction) => [junction.junctionId, junction])),
  };
}

function controllerStageKey(controller: EditorSignalController): string {
  if (controller.movementIds.length === 0) return `controller:${controller.id}`;
  return `movements:${[...controller.movementIds].sort().join("\u0000")}`;
}

/**
 * A junction's distinct executable stages in stable map order.
 *
 * Controller aliases with the same movement set collapse into one stage. Their
 * head sets are unioned and the earliest sequence/id is the persisted reference.
 */
export function orderedStages(
  index: EditorSignalIndex,
  junctionId: string,
): EditorSignalController[] {
  const junction = index.junctionById.get(junctionId);
  if (!junction) return [];
  const controllers = junction.controllerIds
    .map((controllerId) => index.controllerById.get(controllerId))
    .filter((controller): controller is EditorSignalController => controller !== undefined)
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  const stages = new Map<string, EditorSignalController>();
  for (const controller of controllers) {
    const key = controllerStageKey(controller);
    const current = stages.get(key);
    if (!current) {
      stages.set(key, controller);
      continue;
    }
    stages.set(key, {
      ...current,
      headIds: [...new Set([...current.headIds, ...controller.headIds])].sort(),
      movementIds: [...new Set([...current.movementIds, ...controller.movementIds])].sort(),
    });
  }
  return [...stages.values()];
}

/** Resolve a raw controller id to its canonical executable stage. */
export function canonicalStageForController(
  index: EditorSignalIndex,
  junctionId: string,
  controllerId: string,
): EditorSignalController | null {
  const controller = index.controllerById.get(controllerId);
  if (!controller || controller.junctionId !== junctionId) return null;
  const key = controllerStageKey(controller);
  return orderedStages(index, junctionId).find((stage) => controllerStageKey(stage) === key) ?? null;
}

/**
 * What clicking one physical head resolves to.
 *
 * Mirrors `SignalReferenceSelection` from `@simforge/compiler`
 * field for field, deliberately: the panel authors against
 * this shape and the compiler validates against that one, and any divergence
 * between them would be a class of bug that only shows up at Apply. The three
 * head sets are what the 3D layer's highlight tiers consume —
 * `setTrafficLightOrbHighlights` takes exactly `selectedHeadId`,
 * `movementHeadIds` and `intersectionHeadIds`.
 */
export type SignalHeadSelection = {
  readonly selectedHeadId: string;
  readonly junctionId: string;
  /** The movement whose indication a clip on this head states. */
  readonly referenceMovementId: string;
  /** The controller stage a clip on this head names. */
  readonly referenceControllerId: string;
  /** Every stage this head belongs to, in declared order — the mode picker's rows. */
  readonly stageIds: readonly string[];
  /** Movements in the reference stage. */
  readonly stageMovementIds: readonly string[];
  /** Heads in the reference stage: they show the authored indication. */
  readonly movementHeadIds: readonly string[];
  /** Every head at the junction: the rest are held at the derived safe state. */
  readonly intersectionHeadIds: readonly string[];
  readonly diagnostics: readonly EditorSignalDiagnostic[];
};

const SELECTION_DIAGNOSTIC_CODES = new Set<EditorSignalDiagnostic["code"]>([
  "unresolved_head",
  "unresolved_movement",
  "shared_head",
  "missing_controller_stage",
]);

/**
 * Resolve a clicked head, optionally pinning which movement or stage leads.
 *
 * Returns `null` for an unresolved head rather than falling back to geometry.
 * v1 degraded to a 25 m footprint match here and reported the tier so the panel
 * could open the junction with no lead row pinned; that tier existed because
 * v1's client held only head *poses*. Here an unresolved head means the map
 * declares a `<signal>` that no `<controller>` claims, which is a map defect the
 * `unresolved_head` diagnostic already names — inventing an attribution for it
 * would hide the defect and could bind a clip to a light on another road.
 */
export function selectSignalHead(
  index: EditorSignalIndex,
  headId: string,
  preferred: {
    readonly movementId?: string | null;
    readonly controllerId?: string | null;
  } = {},
): SignalHeadSelection | null {
  const head = index.headById.get(headId);
  if (!head?.resolved) return null;

  const wantedMovement = preferred.movementId?.trim();
  const referenceMovementId =
    wantedMovement && head.movementIds.includes(wantedMovement)
      ? wantedMovement
      : head.movementIds[0];
  if (!referenceMovementId) return null;
  const movement = index.movementById.get(referenceMovementId);
  if (!movement) return null;

  // A stage is only eligible if it actually contains the clicked head: a
  // movement can span several stages, and naming one that does not own this head
  // is what `map_signal_plan_reference_unbound` rejects at compile time.
  const eligible = movement.controllerIds.filter((controllerId) =>
    index.controllerById.get(controllerId)?.headIds.includes(headId),
  );
  const wantedController = preferred.controllerId?.trim();
  if (wantedController && !eligible.includes(wantedController)) return null;
  const referenceControllerId = wantedController ?? eligible[0];
  if (!referenceControllerId) return null;
  const controller = index.controllerById.get(referenceControllerId);
  if (!controller || controller.junctionId !== movement.junctionId) return null;

  const junction = index.junctionById.get(movement.junctionId);
  const intersectionHeadIds = junction?.headIds ?? movement.headIds;
  const relatedMovementIds = junction?.movementIds ?? [movement.id];
  const stageIds = orderedStages(index, movement.junctionId)
    .filter((stage) => eligible.includes(stage.id))
    .map((stage) => stage.id);

  return {
    selectedHeadId: headId,
    junctionId: movement.junctionId,
    referenceMovementId,
    referenceControllerId,
    stageIds: stageIds.length > 0 ? stageIds : eligible,
    stageMovementIds: controller.movementIds,
    movementHeadIds: controller.headIds,
    intersectionHeadIds,
    diagnostics: index.projection.diagnostics.filter(
      (diagnostic) =>
        SELECTION_DIAGNOSTIC_CODES.has(diagnostic.code) &&
        (diagnostic.headIds?.some((id) => intersectionHeadIds.includes(id)) === true ||
          diagnostic.movementIds?.some((id) => relatedMovementIds.includes(id)) === true),
    ),
  };
}

/**
 * The stage index a head leads, within {@link orderedStages}.
 *
 * `-1` when the head belongs to no stage of that junction. Used to pick which
 * stage a freshly-typed reference cycle should lead with, so the light the
 * author clicked is the one that greens first.
 */
export function stageIndexOfHead(
  index: EditorSignalIndex,
  junctionId: string,
  headId: string,
): number {
  return orderedStages(index, junctionId).findIndex((stage) => stage.headIds.includes(headId));
}

/**
 * Heads at a junction that no stage claims.
 *
 * Surfaced so the panel can grey them rather than offer timing for a light the
 * compiler will refuse. Distinct from `head.resolved === false`, which is about
 * program membership; a head can be program-resolved at one junction and
 * unclaimed at another that also lists it.
 */
export function unclaimedHeadIds(index: EditorSignalIndex, junctionId: string): string[] {
  const junction = index.junctionById.get(junctionId);
  if (!junction) return [];
  const claimed = new Set(orderedStages(index, junctionId).flatMap((stage) => stage.headIds));
  return junction.headIds.filter((headId) => !claimed.has(headId)).sort();
}

/**
 * Pre-flight a stage against the junction's declared gate conflicts.
 *
 * The exact rule `compileMapSignalPlans` applies: a stage may not contain two
 * gates the derived topology says conflict. Reported rather than enforced,
 * because the map declared the stage and a conflicting one is an upstream
 * defect the author cannot fix from here — but they can be told before Apply
 * rather than after `map_signal_plan_controller_conflict`.
 *
 * Returns an empty list when the projection carries no conflict data
 * (`conflictSource: "none"`), because a guess would be worse than silence.
 */
export function stageConflictWarnings(
  index: EditorSignalIndex,
  junctionId: string,
  controllerId: string,
): EditorSignalDiagnostic[] {
  if (index.projection.conflictSource === "none") return [];
  const pairs = index.projection.conflictPairsByJunction[junctionId] ?? [];
  if (pairs.length === 0) return [];
  const controller = index.controllerById.get(controllerId);
  if (!controller) return [];

  // Gates the stage would run: every gate of every movement it holds.
  const gateIds = new Set(
    controller.movementIds.flatMap(
      (movementId) => index.movementById.get(movementId)?.gateIds ?? [],
    ),
  );
  const warnings: EditorSignalDiagnostic[] = [];
  for (const pair of pairs) {
    if (!gateIds.has(pair.gateA) || !gateIds.has(pair.gateB)) continue;
    warnings.push({
      code: "conflicting_controller_stage",
      message: `Controller stage ${controllerId} runs conflicting movements ${pair.gateA} and ${pair.gateB}; playback will refuse this plan.`,
      controllerIds: [controllerId],
    });
  }
  return warnings;
}
