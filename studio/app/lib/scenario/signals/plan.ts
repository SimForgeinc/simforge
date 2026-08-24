/**
 * Cycles in, `MapSignalPlan` out — and back again.
 *
 * This is the module the twelve manifest items converge on, because
 * `EditorDocument.addMapSignalPlan` / `replaceMapSignalPlan` /
 * `removeMapSignalPlan` have existed since v2's document model landed and the
 * only callers in the tree are `__tests__/map-signal-plan-lifecycle.test.ts`.
 * Everything above here authors {@link StageInterval}s; everything below
 * consumes `MapSignalPlan`.
 *
 * ## The clip contract, and the three things it forbids
 *
 * `MapSignalPlanClipSchema` is strict in ways an author will hit:
 *
 * 1. **Half-open, non-overlapping.** `endS > startS`, and no clip may start
 *    before the previous one ends. So a cycle is laid out as a contiguous run
 *    of clips, and a rounding error of one tenth is a schema failure rather
 *    than a cosmetic gap.
 * 2. **256 clips maximum.** A 5-interval cycle over a 20 s clip is 8 clips; the
 *    same cycle over a 3600 s clip would be 1,440 and fail. {@link layOutCycle}
 *    truncates at the cap and reports it rather than emitting a plan the
 *    document will reject on `addMapSignalPlan`.
 * 3. **Six indications, not eleven.** See `types.ts` —
 *    `green_arrow`/`red_x`/`proceed`/`stop` belong to `trafficControls`, not to a
 *    map signal plan, and arrow *lenses* are hardware rather than timing.
 *
 * ## Gaps are meaningful, so trailing coverage is deliberate
 *
 * `compileMapSignalPlans` samples the MAP's own baseline program in every
 * interval no clip covers. That makes an uncovered tail a real authoring choice
 * — "hand the junction back to map timing after my sequence" — and not a hole.
 * {@link layOutCycle} therefore takes an explicit `coverage` rather than always
 * filling the clip: `"clip"` repeats until the clip ends, `"once"` runs the
 * cycle a single time and returns the junction to baseline afterwards.
 *
 * v1 had no such choice to offer. Its `map_default` mode forced every light
 * green and froze it, so "return to baseline" did not exist as a concept.
 */

import {
  MapSignalPlanSchema,
  type MapSignalPlan,
  type MapSignalPlanClip,
} from "@simforge/scenario";

import type { StageInterval } from "./reference-cycle";
import {
  compileReferenceCycle,
  cycleSeconds,
  DEFAULT_REFERENCE_TIMING,
} from "./reference-cycle";
import { selectSignalHead, type EditorSignalIndex } from "./stages";
import type { EditorSignalControlProjection, MapSignalIndication } from "./types";

/** `MapSignalPlanSchema` caps `clips` at 256. */
export const MAX_PLAN_CLIPS = 256;

/** How far a laid-out cycle extends across the clip's duration. */
export type CycleCoverage =
  /** Repeat the cycle until the clip ends. */
  | "clip"
  /** Run the cycle once, then return the junction to the map's own timing. */
  | "once";

function round(seconds: number): number {
  return Math.round(seconds * 10) / 10;
}

/** Deterministic clip ids: a plan re-derived from the same cycle is identical. */
function clipId(junctionId: string, ordinal: number): string {
  return `sig-${junctionId}-${String(ordinal).padStart(3, "0")}`;
}

/**
 * A plan id derived from its junction.
 *
 * One plan per junction is the only arrangement `compileMapSignalPlans` can
 * honour: it replaces the junction's programs wholesale per plan, so two plans
 * on one junction would have the second silently win. Deriving the id from the
 * junction makes that structural — {@link upsertMapSignalPlan} replaces rather
 * than appends.
 */
export function mapSignalPlanId(junctionId: string): string {
  return `junction-${junctionId}`;
}

export type LayOutCycleInput = {
  readonly cycle: readonly StageInterval[];
  /** `choreography.clipSeconds` — the authored scenario duration. */
  readonly clipSeconds: number;
  readonly coverage: CycleCoverage;
  /** Where the sequence begins. Clamped into `[0, clipSeconds)`. */
  readonly startAtS?: number;
  readonly junctionId: string;
};

export type LayOutCycleResult = {
  readonly clips: readonly MapSignalPlanClip[];
  /**
   * True when the cap stopped the layout short of `coverage`.
   *
   * The panel must say so: a silently truncated plan means the junction returns
   * to map timing part-way through a scenario, which looks like the plan simply
   * stopped working.
   */
  readonly truncated: boolean;
  /** Seconds actually covered, so the panel can show the gap it left behind. */
  readonly coveredUntilS: number;
};

/**
 * Lay a cycle out as absolute, contiguous, non-overlapping clips.
 *
 * Boundaries are accumulated by *adding durations*, not by sampling a clock, so
 * `endS` of one clip is exactly `startS` of the next and the schema's overlap
 * check cannot trip on a floating-point tail. The final clip is truncated to
 * `clipSeconds` rather than allowed to overrun; a zero-length remainder is
 * dropped rather than emitted, because `endS > startS` is a hard constraint.
 */
export function layOutCycle(input: LayOutCycleInput): LayOutCycleResult {
  const clipSeconds = round(Math.max(0, input.clipSeconds));
  const total = cycleSeconds(input.cycle);
  const startAtS = round(Math.min(Math.max(0, input.startAtS ?? 0), clipSeconds));
  if (input.cycle.length === 0 || total <= 0 || clipSeconds <= startAtS) {
    return { clips: [], truncated: false, coveredUntilS: startAtS };
  }

  const clips: MapSignalPlanClip[] = [];
  let cursor = startAtS;
  let ordinal = 0;
  let at = 0;
  let truncated = false;

  while (cursor < clipSeconds) {
    if (clips.length >= MAX_PLAN_CLIPS) {
      truncated = true;
      break;
    }
    const interval = input.cycle[at % input.cycle.length]!;
    const endS = round(Math.min(clipSeconds, round(cursor + interval.durationS)));
    if (endS > cursor) {
      clips.push({
        id: clipId(input.junctionId, ordinal),
        startS: cursor,
        endS,
        reference: { controllerId: interval.controllerId, headId: interval.headId },
        indication: interval.indication,
      });
      ordinal += 1;
    }
    cursor = endS;
    at += 1;
    // `"once"` stops at the end of the first pass; the uncovered tail is the
    // author asking for the map's own timing back.
    if (input.coverage === "once" && at >= input.cycle.length) break;
  }

  return { clips, truncated, coveredUntilS: cursor };
}

/**
 * Build a complete plan for one junction.
 *
 * Validated through `MapSignalPlanSchema` before it leaves, so a defect surfaces
 * here — where the panel can report it against the timing that caused it —
 * rather than inside `EditorDocument.addMapSignalPlan`, where the only available
 * message is that the document rejected a write.
 */
export function buildMapSignalPlan(input: {
  readonly projection: EditorSignalControlProjection;
  readonly junctionId: string;
  readonly clips: readonly MapSignalPlanClip[];
}): MapSignalPlan {
  return MapSignalPlanSchema.parse({
    id: mapSignalPlanId(input.junctionId),
    version: 1,
    binding: {
      mapId: input.projection.mapId,
      junctionId: input.junctionId,
      controlDigest: input.projection.controlDigest,
    },
    clips: [...input.clips],
  });
}

/**
 * Create the first editable cycle for a physical signal head.
 *
 * Selecting a resolved head is an authoring gesture in the editor, not a
 * read-only preview of the map baseline. Seed the same compact three-value
 * cycle the details panel displays and cover the whole scenario so the first
 * lane the author sees contains editable clips rather than locked baseline
 * spans. Existing plans are deliberately handled by the caller; this helper is
 * only the empty-junction transition.
 */
export function buildDefaultMapSignalPlanForHead(input: {
  readonly index: EditorSignalIndex;
  readonly headId: string;
  readonly clipSeconds: number;
}): MapSignalPlan | null {
  const selection = selectSignalHead(input.index, input.headId);
  if (!selection) return null;
  const cycle = compileReferenceCycle({
    index: input.index,
    junctionId: selection.junctionId,
    referenceHeadId: selection.selectedHeadId,
    timing: DEFAULT_REFERENCE_TIMING,
  });
  const layout = layOutCycle({
    cycle,
    clipSeconds: input.clipSeconds,
    coverage: "clip",
    junctionId: selection.junctionId,
  });
  if (layout.clips.length === 0) return null;
  return buildMapSignalPlan({
    projection: input.index.projection,
    junctionId: selection.junctionId,
    clips: layout.clips,
  });
}

/**
 * Whether every physical reference in a plan still resolves on this map.
 *
 * `controlDigest` is provenance, not a validity gate. The executable contract is
 * the exact map, junction, controller, and head ids checked below; rejecting an
 * otherwise resolvable plan because an unrelated road control changed made the
 * editor and browser playback disagree about valid authored signal data.
 */
export type PlanBindingVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "map_signal_plan_map_mismatch"
        | "map_signal_plan_junction_unbound"
        | "map_signal_plan_reference_unbound";
      readonly message: string;
      /** Clip ids at fault, when the fault is per-clip. */
      readonly clipIds?: readonly string[];
    };

export function checkPlanBinding(
  index: EditorSignalIndex,
  plan: MapSignalPlan,
): PlanBindingVerdict {
  const { projection } = index;
  if (plan.binding.mapId !== projection.mapId) {
    return {
      ok: false,
      code: "map_signal_plan_map_mismatch",
      message: `This signal plan belongs to map "${plan.binding.mapId}", not "${projection.mapId}".`,
    };
  }
  const junction = index.junctionById.get(plan.binding.junctionId);
  if (!junction || !junction.signalized) {
    return {
      ok: false,
      code: "map_signal_plan_junction_unbound",
      message: `Junction "${plan.binding.junctionId}" has no controllable signal programs on this map.`,
    };
  }
  const unbound = plan.clips.filter((clip) => {
    const controller = index.controllerById.get(clip.reference.controllerId);
    return (
      !controller ||
      controller.junctionId !== plan.binding.junctionId ||
      !controller.headIds.includes(clip.reference.headId)
    );
  });
  if (unbound.length > 0) {
    return {
      ok: false,
      code: "map_signal_plan_reference_unbound",
      message: `${unbound.length} clip(s) name a controller stage or head that no longer belongs to this junction.`,
      clipIds: unbound.map((clip) => clip.id),
    };
  }
  return { ok: true };
}

/**
 * Recover the editable cycle from a plan's clips.
 *
 * The inverse of {@link layOutCycle} up to repetition: consecutive clips are read
 * as intervals, and the first repetition of the opening interval ends the cycle.
 * A plan whose clips do not repeat comes back as one long "cycle", which is the
 * honest reading — a hand-painted sequence is not periodic, and
 * `readReferenceTiming` will report `generated: false` for it so the three-number
 * card offers rather than assumes.
 */
export function decompilePlanToCycle(
  index: EditorSignalIndex,
  plan: MapSignalPlan,
): StageInterval[] {
  const ordered = [...plan.clips].sort((left, right) => left.startS - right.startS);
  if (ordered.length === 0) return [];
  const first = ordered[0]!;
  const intervals: StageInterval[] = [];
  for (const [at, clip] of ordered.entries()) {
    if (
      at > 0 &&
      clip.reference.controllerId === first.reference.controllerId &&
      clip.reference.headId === first.reference.headId &&
      clip.indication === first.indication
    ) {
      break;
    }
    const controller = index.controllerById.get(clip.reference.controllerId);
    intervals.push({
      controllerId: clip.reference.controllerId,
      headId: clip.reference.headId,
      indication: clip.indication,
      durationS: round(clip.endS - clip.startS),
      label: labelForInterval(clip.indication, controller?.sequence ?? at),
    });
  }
  return intervals;
}

function labelForInterval(indication: MapSignalIndication, sequence: number): string {
  const name = indication.replace("flashing_", "Flashing ").replace(/^./, (c) => c.toUpperCase());
  return `${name} · stage ${sequence}`;
}

/**
 * Replace-or-insert a plan in a template's `mapSignalPlans`.
 *
 * Keyed on the junction rather than on the plan id, because two plans on one
 * junction is the arrangement `compileMapSignalPlans` cannot express — see
 * {@link mapSignalPlanId}. Sorted by junction id so a template's serialisation
 * does not depend on authoring order, which is what keeps `content_sha256`
 * stable across two sessions that authored the same junctions.
 */
export function upsertMapSignalPlan(
  plans: readonly MapSignalPlan[],
  next: MapSignalPlan,
): MapSignalPlan[] {
  return [
    ...plans.filter((plan) => plan.binding.junctionId !== next.binding.junctionId),
    next,
  ].sort((left, right) => left.binding.junctionId.localeCompare(right.binding.junctionId));
}

/** The plan governing a junction, if any. Absence means the map's own timing runs. */
export function planForJunction(
  plans: readonly MapSignalPlan[],
  junctionId: string,
): MapSignalPlan | null {
  return plans.find((plan) => plan.binding.junctionId === junctionId) ?? null;
}
