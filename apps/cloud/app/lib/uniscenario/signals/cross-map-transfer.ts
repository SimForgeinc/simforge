/**
 * Carrying a signal plan onto another map version.
 *
 * ## What v1 needed, and what v2 makes unnecessary
 *
 * v1's `cross-map-signal-transfer.ts` (507 lines) had to rewrite ids. Its plans
 * keyed on `movement_id` strings it minted from OpenDRIVE road ids, and those
 * renumber across a UE5 rebuild — so a transfer meant re-deriving the target's
 * movement tables (`readSignalMovementTables`, which pulled a topology bundle, a
 * semantic graph publication and a XODR through a sha256 identity gate), then
 * matching source movements to target movements, then rewriting every plan and
 * every actor behaviour that referenced a signal state. If any input could not
 * be read it had to **fail the transfer explicitly**, because a silently
 * unenforceable signal plan is worse than a refused one.
 *
 * v2 keeps the failure discipline and drops the rewriting. Two reasons:
 *
 * 1. **Nothing is rewritten in place.** A `MapSignalPlan` binds to
 *    `{ mapId, junctionId, controlDigest }`. A different map version is a
 *    different `mapId` and a different digest, so the plan does not *become*
 *    invalid — it is already, provably, not about the target map, and
 *    `compileMapSignalPlans` says so with `map_signal_plan_map_mismatch`. There
 *    is no id to renumber because the plan never carried a derived id.
 * 2. **Matching is a projection lookup, not a derivation.** The target's stages,
 *    heads and turn relations arrive in an
 *    {@link EditorSignalControlProjection} built once per map version. v1's
 *    three-artifact read with its identity gate has no analogue to port.
 *
 * So what remains is the genuinely hard part v1 also had: deciding **which
 * junction on the target corresponds to the source's**, and whether the
 * correspondence is close enough that the author's timing still means what they
 * meant. That is a judgement, so this module produces a scored proposal and
 * never applies one.
 *
 * ## Timing transfers; stage identity does not
 *
 * The transferable content of a plan is the author's *timing* — how long green,
 * how long yellow, how long red, and which approach leads. Controller ids are
 * the target map's own and must not be carried across. So a transfer
 * decompiles the source plan to a cycle, reads the three numbers back out of it,
 * and recompiles them against the target junction's stages. A source plan that
 * was hand-painted rather than generated cannot survive that round trip, and
 * {@link proposeSignalPlanTransfer} reports it as `hand_painted` rather than
 * approximating it.
 */

import type { MapSignalPlan } from "@uniscenarios/scenario-model";

import { buildMapSignalPlan, decompilePlanToCycle, layOutCycle, type CycleCoverage } from "./plan";
import {
  compileReferenceCycle,
  readReferenceTiming,
  type ReferenceCycleTiming,
} from "./reference-cycle";
import { orderedStages, type EditorSignalIndex } from "./stages";

/** Why a junction on the target was proposed, and how confident that is. */
export type JunctionMatchBasis =
  /** Same junction id on both maps — the same map rebuilt, ids preserved. */
  | "same_junction_id"
  /** Same stage count and same set of turn relations per stage. */
  | "stage_shape"
  /** Same stage count only. */
  | "stage_count";

export type JunctionMatchCandidate = {
  readonly targetJunctionId: string;
  readonly basis: JunctionMatchBasis;
  /** `0`–`1`. Ordering only; do not render it as a percentage of anything. */
  readonly score: number;
  readonly targetStageCount: number;
  readonly sourceStageCount: number;
};

const BASIS_SCORE: Readonly<Record<JunctionMatchBasis, number>> = {
  same_junction_id: 1,
  stage_shape: 0.7,
  stage_count: 0.4,
};

/** The turn relations a junction's stages serve, as a comparable signature. */
function stageSignature(index: EditorSignalIndex, junctionId: string): string[] {
  return orderedStages(index, junctionId)
    .map((stage) =>
      [
        ...new Set(
          stage.movementIds.flatMap(
            (movementId) => index.movementById.get(movementId)?.turnRelations ?? [],
          ),
        ),
      ]
        .sort()
        .join("+"),
    )
    .sort();
}

/**
 * Rank the target's junctions as homes for a source junction's timing.
 *
 * Ranked, not chosen. A wrong junction is a plan that times the wrong
 * intersection — it compiles, it runs, and it is silently about somewhere else,
 * which is the failure mode v1's own header calls out as worse than a refusal.
 * The caller shows these and an author picks.
 */
export function matchJunctions(input: {
  readonly source: EditorSignalIndex;
  readonly target: EditorSignalIndex;
  readonly sourceJunctionId: string;
}): JunctionMatchCandidate[] {
  const sourceStages = orderedStages(input.source, input.sourceJunctionId);
  const sourceSignature = stageSignature(input.source, input.sourceJunctionId).join("|");
  const sourceStageCount = sourceStages.length;
  if (sourceStageCount === 0) return [];

  const candidates: JunctionMatchCandidate[] = [];
  for (const junction of input.target.projection.junctions) {
    if (!junction.signalized) continue;
    const targetStages = orderedStages(input.target, junction.junctionId);
    if (targetStages.length === 0) continue;
    const basis: JunctionMatchBasis | null =
      junction.junctionId === input.sourceJunctionId
        ? "same_junction_id"
        : stageSignature(input.target, junction.junctionId).join("|") === sourceSignature
          ? "stage_shape"
          : targetStages.length === sourceStageCount
            ? "stage_count"
            : null;
    if (!basis) continue;
    candidates.push({
      targetJunctionId: junction.junctionId,
      basis,
      score: BASIS_SCORE[basis],
      targetStageCount: targetStages.length,
      sourceStageCount,
    });
  }
  return candidates.sort(
    (left, right) =>
      right.score - left.score || left.targetJunctionId.localeCompare(right.targetJunctionId),
  );
}

export type SignalPlanTransferProposal =
  | {
      readonly ok: true;
      readonly plan: MapSignalPlan;
      readonly targetJunctionId: string;
      readonly timing: ReferenceCycleTiming;
      /** The head on the target whose stage leads the recompiled cycle. */
      readonly referenceHeadId: string;
      /** True when the layout hit the 256-clip cap on the target. */
      readonly truncated: boolean;
      /**
       * Stage-count mismatch between source and target.
       *
       * The timing still applies — green, yellow and red are the author's — but
       * the red window is divided among a different number of crossing stages,
       * so individual cross greens change length. Reported so the panel can say
       * so rather than presenting a silently different junction as a transfer.
       */
      readonly stageCountChanged: boolean;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "no_source_plan"
        /** The source plan is not a generated cycle, so it has no timing to carry. */
        | "hand_painted"
        /** No junction on the target is a defensible home for it. */
        | "no_target_junction"
        /** The chosen target junction declares no usable stage. */
        | "target_unsignalized";
      readonly message: string;
    };

/**
 * Propose the source plan's timing, recompiled against a target junction.
 *
 * Explicitly a proposal: nothing is written, and `ok: false` is a normal
 * outcome the caller must render rather than swallow. That is v1's rule, kept —
 * its `readSignalMovementTables` returned `null` on any unreadable input
 * precisely so a transfer would fail loudly instead of emitting a plan the
 * worker could not honour.
 */
export function proposeSignalPlanTransfer(input: {
  readonly source: EditorSignalIndex;
  readonly target: EditorSignalIndex;
  readonly sourcePlan: MapSignalPlan | null;
  readonly targetJunctionId: string | null;
  readonly clipSeconds: number;
  readonly coverage: CycleCoverage;
}): SignalPlanTransferProposal {
  if (!input.sourcePlan || input.sourcePlan.clips.length === 0) {
    return {
      ok: false,
      reason: "no_source_plan",
      message: "This junction has no authored signal plan to carry across.",
    };
  }

  const sourceJunctionId = input.sourcePlan.binding.junctionId;
  const sourceCycle = decompilePlanToCycle(input.source, input.sourcePlan);
  const sourceLeadHeadId = sourceCycle[0]?.headId ?? input.sourcePlan.clips[0]!.reference.headId;
  const { timing, generated } = readReferenceTiming({
    index: input.source,
    junctionId: sourceJunctionId,
    referenceHeadId: sourceLeadHeadId,
    cycle: sourceCycle,
  });
  if (!generated) {
    return {
      ok: false,
      reason: "hand_painted",
      message:
        "This plan was painted or hand-edited rather than generated from a timing, so there is no green/yellow/red to carry to another map. Re-author it on the target junction.",
    };
  }

  const targetJunctionId =
    input.targetJunctionId ??
    matchJunctions({
      source: input.source,
      target: input.target,
      sourceJunctionId,
    })[0]?.targetJunctionId ??
    null;
  if (!targetJunctionId) {
    return {
      ok: false,
      reason: "no_target_junction",
      message: "No signalized junction on the target map matches this one's stage layout.",
    };
  }

  const targetStages = orderedStages(input.target, targetJunctionId).filter(
    (stage) => stage.headIds.length > 0 && stage.movementIds.length > 0,
  );
  if (targetStages.length === 0) {
    return {
      ok: false,
      reason: "target_unsignalized",
      message: `Junction "${targetJunctionId}" on the target map declares no controllable signal stage.`,
    };
  }

  // The lead is the target's first declared stage: the source's controller id is
  // meaningless here, and the map's own stage order is the only non-arbitrary
  // choice available.
  const referenceHeadId = [...targetStages[0]!.headIds].sort()[0]!;
  const cycle = compileReferenceCycle({
    index: input.target,
    junctionId: targetJunctionId,
    referenceHeadId,
    timing,
  });
  const layout = layOutCycle({
    cycle,
    clipSeconds: input.clipSeconds,
    coverage: input.coverage,
    junctionId: targetJunctionId,
  });

  return {
    ok: true,
    plan: buildMapSignalPlan({
      projection: input.target.projection,
      junctionId: targetJunctionId,
      clips: layout.clips,
    }),
    targetJunctionId,
    timing,
    referenceHeadId,
    truncated: layout.truncated,
    stageCountChanged:
      targetStages.length !== orderedStages(input.source, sourceJunctionId).length,
  };
}
