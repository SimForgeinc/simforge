/**
 * What a trigger picker needs in order to reference a signal, and nothing more.
 *
 * ## The seam, and why it points this way
 *
 * v1 already discovered this boundary. `timeline-model.ts:491` defines
 * `SignalTriggerTarget` as ids and labels only — no plan, no phase program, no
 * movement bindings — and its docblock records the reason: *"the picker needs a
 * junction to be referenceable before anyone authors a plan for it, and the
 * movement table is all it reads."* The same file's `runtimeBlockReason` records
 * that the `signal_state` blocker was deliberately **removed** because "its
 * evaluator shipped with the signal plans". So v1 had already pushed signal
 * evaluation out of the timeline and left only a structural payload at the seam.
 *
 * This is that payload, unchanged in shape and re-derived from v2's projection.
 * It is the only type the behaviour and timeline layers need from this folder,
 * which is what lets the dependency run one way: they consume
 * {@link SignalTriggerTarget}, and nothing outside `lib/uniscenario/signals/**`
 * imports a stage, a clip, a cycle or a control index.
 *
 * ## Two grains, both offered, because they answer different questions
 *
 * A trigger can reasonably say either:
 *
 * - *"when junction 100 lets the cross street through"* — the junction grain; or
 * - *"when the northbound protected left goes green"* — the **stage** grain.
 *
 * v1 offered the second at the *movement* grain. In v2 a movement is not the
 * thing a clip commands — a controller stage is — so {@link signalTriggerTargets}
 * reports stages under the `movements` key. The key name is kept because it is
 * v1's wire shape and the picker's rendering does not change; what changed is
 * that each entry is now a grain the compiler can actually hold at one
 * indication, so a trigger written against it cannot reference something with no
 * single state.
 */

import type { EditorSignalIndex } from "./stages";
import { orderedStages } from "./stages";

/**
 * One referenceable signal, in v1's wire shape.
 *
 * Snake_case is deliberate: this is the shape v1's trigger picker already
 * consumes, and preserving it makes porting that picker a store swap rather than
 * an API rewrite. Nothing else in this folder uses snake_case.
 */
export type SignalTriggerTarget = {
  junction_id: string;
  label: string;
  movements: ReadonlyArray<{ movement_id: string; label: string }>;
};

/**
 * Every junction a trigger may reference, whether or not a plan exists for it.
 *
 * Unplanned junctions are included on purpose — that is v1's rule and it is
 * still right. A junction runs the map's own baseline timing when no plan
 * governs it, so "when this light goes green" is a perfectly well-defined
 * trigger against an unplanned junction; requiring a plan first would make the
 * author author timing they did not want in order to reference timing that was
 * already running.
 *
 * Unsignalized junctions are excluded: there is no state to wait for.
 */
export function signalTriggerTargets(index: EditorSignalIndex): SignalTriggerTarget[] {
  const targets: SignalTriggerTarget[] = [];
  for (const junction of index.projection.junctions) {
    if (!junction.signalized) continue;
    const stages = orderedStages(index, junction.junctionId).filter(
      (stage) => stage.headIds.length > 0,
    );
    if (stages.length === 0) continue;
    targets.push({
      junction_id: junction.junctionId,
      label: junctionLabel(index, junction.junctionId, stages.length),
      movements: stages.map((stage) => ({
        movement_id: stage.id,
        label: stageLabel(index, stage.id, stage.headIds),
      })),
    });
  }
  return targets;
}

/**
 * A junction's name for a dropdown.
 *
 * There is no street name anywhere in the signal data — `map_versions.locality`
 * is the closest thing and it names the whole map, not the corner. So the label
 * is the junction id plus the one fact that distinguishes a big intersection
 * from a small one, which is what an author scanning a list actually needs.
 * Inventing "Yale St at College Ave" from `uniscenario-map-intel`'s search index
 * is possible and belongs in the picker, not here — this module has no map-intel
 * dependency and should not grow one.
 */
function junctionLabel(index: EditorSignalIndex, junctionId: string, stageCount: number): string {
  const junction = index.junctionById.get(junctionId);
  const heads = junction?.headIds.length ?? 0;
  return `Junction ${junctionId} · ${heads} head${heads === 1 ? "" : "s"}, ${stageCount} stage${stageCount === 1 ? "" : "s"}`;
}

/** A stage's name: its id plus the heads it commands, which is what it *is*. */
function stageLabel(
  index: EditorSignalIndex,
  controllerId: string,
  headIds: readonly string[],
): string {
  const turns = [
    ...new Set(
      (index.controllerById.get(controllerId)?.movementIds ?? []).flatMap(
        (movementId) => index.movementById.get(movementId)?.turnRelations ?? [],
      ),
    ),
  ].sort();
  const heads = headIds.length <= 3 ? headIds.join(", ") : `${headIds.length} heads`;
  return turns.length > 0 ? `Stage ${controllerId} · ${turns.join("/")} (${heads})` : `Stage ${controllerId} · ${heads}`;
}
