/**
 * One light's timing and phase order, and the junction follows.
 *
 * Three rows, and they mean exactly what they say — how long the light you
 * clicked is green, how long it is yellow, how long it is red. The cycle is
 * their sum, and their row order is their playback order. Nothing else is asked
 * of the author, and nothing else needs to be:
 * while your light is red, every other stage the map declares takes a turn
 * inside that red window, in the order the map declares them.
 *
 * ## Why this shape
 *
 * Carried over from v1 unchanged, because the reasoning is about people rather
 * than about data. v1's first version asked for green, yellow, ALL-RED and
 * OFFSET, which is how a traffic engineer parameterises a controller and is the
 * wrong surface for an author: "all-red" is jargon, "offset" only means anything
 * across a coordinated corridor, and the one quantity a person actually pictures
 * — how long am I stopped at this light — was the one number they could not
 * type. Red is an input and the cycle is G + Y + R, full stop.
 *
 * ## What v2 changed
 *
 * v1 emitted a `SignalPhaseProgram` whose every interval carried a
 * `Record<movementId, BehaviorSignalState>` restating all eight movements of an
 * ordinary four-way, built by `withGroup(group, state)` over an `allRedStates`
 * base. Getting those maps right *was* the difficulty, and getting them
 * consistent with the validator's own partition was the bug class.
 *
 * Here an interval names **one head and one indication** ({@link StageInterval})
 * and `evaluateSignalReferencePhase` derives the rest, fail-closed. That is not
 * a simplification of the output — it is the same executable result — but it
 * removes the redundancy that made v1's version fragile, and it means a cycle
 * this module compiles is conflict-free by construction rather than by a
 * partition agreement that had to be maintained by hand.
 *
 * The other change is the red window. v1 split it between "conflict groups"; v2
 * splits it between the map's remaining **controller stages**, which is the same
 * quantity read off the map instead of derived. See `stages.ts`.
 */

import type { EditorSignalIndex } from "./stages";
import { orderedStages } from "./stages";
import type { MapSignalIndication } from "./types";

/** The three numbers an author types. Seconds. */
export type ReferenceCycleTiming = {
  greenS: number;
  yellowS: number;
  redS: number;
};

/** The three user-facing rows in a reference light cycle. */
export type ReferenceCyclePhase = "green" | "yellow" | "red";

export const DEFAULT_REFERENCE_PHASE_ORDER: readonly ReferenceCyclePhase[] = [
  "green",
  "yellow",
  "red",
];

/**
 * Sized for a SCENARIO, not for a real intersection.
 *
 * A default clip runs 20 s. Real-world timings (20 s green, 30 s red) give a
 * 53 s cycle, so the clip would end before the light had finished its first red
 * — the author sets a timing, presses play, and watches nothing happen. Ten
 * green, five yellow, five red is one complete cycle inside the default
 * duration, which is what makes the numbers legible the moment they are typed.
 *
 * Deliberately not realistic. An author who wants survey-true timings can type
 * them; an author who wants to SEE the light change cannot discover that they
 * need a 60 s clip first.
 */
export const DEFAULT_REFERENCE_TIMING: ReferenceCycleTiming = {
  greenS: 10,
  yellowS: 5,
  redS: 5,
};

/**
 * Bounds, wide enough not to argue with a real intersection and tight enough
 * that a mid-typing value cannot compile something the schema rejects
 * (`MapSignalPlanClipSchema` requires `endS > startS`).
 */
export const MIN_GREEN_S = 1;
export const MAX_GREEN_S = 600;
export const MIN_YELLOW_S = 0;
export const MAX_YELLOW_S = 15;
export const MIN_RED_S = 1;
export const MAX_RED_S = 600;

/** Smallest slice worth emitting; also the floor for a shared red window. */
export const MIN_SLICE_S = 0.5;

/** Tenths. Finer than any authored signal timing is meaningful to, and it keeps
 * clip boundaries exactly representable so `endS === next.startS` holds. */
function round(seconds: number): number {
  return Math.round(seconds * 10) / 10;
}

function clamp(value: unknown, low: number, high: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? round(Math.min(high, Math.max(low, value)))
    : fallback;
}

export function clampReferenceTiming(
  timing: Partial<ReferenceCycleTiming>,
): ReferenceCycleTiming {
  return {
    greenS: clamp(timing.greenS, MIN_GREEN_S, MAX_GREEN_S, DEFAULT_REFERENCE_TIMING.greenS),
    // Yellow may be zero: not every authored scenario wants a clearance.
    yellowS: clamp(timing.yellowS, MIN_YELLOW_S, MAX_YELLOW_S, DEFAULT_REFERENCE_TIMING.yellowS),
    redS: clamp(timing.redS, MIN_RED_S, MAX_RED_S, DEFAULT_REFERENCE_TIMING.redS),
  };
}

/** Total cycle length — what the author typed, added up. */
export function referenceCycleSeconds(timing: ReferenceCycleTiming): number {
  const { greenS, yellowS, redS } = clampReferenceTiming(timing);
  return round(greenS + yellowS + redS);
}

/**
 * One interval of a compiled cycle: which stage leads, and what it shows.
 *
 * The direct pre-image of a {@link MapSignalPlanClip}: `controllerId` + `headId`
 * become `clip.reference`, `indication` becomes `clip.indication`, and
 * `durationS` becomes `endS - startS` once the cycle is laid out over the clip's
 * duration by `plan.ts`. Kept as a duration rather than an absolute span so one
 * compiled cycle can be repeated without recomputation.
 */
export type StageInterval = {
  /** The controller stage this interval commands. */
  readonly controllerId: string;
  /** The head within that stage a clip will name. Any of its heads would do;
   * this one is chosen deterministically so the clip list is reproducible. */
  readonly headId: string;
  readonly indication: MapSignalIndication;
  readonly durationS: number;
  /** For the phase-list editor's row label. */
  readonly label: string;
};

/** Sum of a cycle's interval durations. */
export function cycleSeconds(cycle: readonly StageInterval[]): number {
  return round(cycle.reduce((total, interval) => total + interval.durationS, 0));
}

/**
 * Deterministic representative for a stage the author did not click.
 *
 * Crossing stages need a stable reference head so re-derived plans are
 * byte-identical. The lead stage keeps the exact clicked head instead.
 */
function stageHeadId(headIds: readonly string[]): string | null {
  const sorted = [...headIds].sort();
  return sorted[0] ?? null;
}

export type CompileReferenceCycleInput = {
  readonly index: EditorSignalIndex;
  readonly junctionId: string;
  /** The head the author clicked. Its stage leads the cycle. */
  readonly referenceHeadId: string;
  readonly timing: ReferenceCycleTiming;
  /** User-selected order of the three phase rows. */
  readonly phaseOrder?: readonly ReferenceCyclePhase[];
};

/**
 * Compile the junction from the clicked light's three numbers.
 *
 * The clicked light's green and yellow phases and the crossing-stage red window
 * are emitted in the row order selected by the author.
 *
 * Returns an empty cycle when the junction declares no usable stage, which the
 * panel must treat as "nothing to author here" rather than storing a plan with
 * no clips. An all-red hold is a legitimate authored result and is *not* the
 * same thing: it appears as a single `red` interval when the junction has
 * exactly one stage.
 */
export function compileReferenceCycle({
  index,
  junctionId,
  referenceHeadId,
  timing,
  phaseOrder = DEFAULT_REFERENCE_PHASE_ORDER,
}: CompileReferenceCycleInput): StageInterval[] {
  const stages = orderedStages(index, junctionId).filter(
    (stage) => stage.headIds.length > 0 && stage.movementIds.length > 0,
  );
  if (stages.length === 0) return [];

  const { greenS, yellowS, redS } = clampReferenceTiming(timing);
  const leadAt = Math.max(
    0,
    stages.findIndex((stage) => stage.headIds.includes(referenceHeadId)),
  );
  const lead = stages[leadAt]!;
  const leadHeadId = lead.headIds.includes(referenceHeadId) ? referenceHeadId : stageHeadId(lead.headIds);
  if (!leadHeadId) return [];
  const others = stages.filter((_, at) => at !== leadAt);

  const phases: Record<ReferenceCyclePhase, StageInterval[]> = {
    green: [{
      controllerId: lead.id,
      headId: leadHeadId,
      indication: "green",
      durationS: greenS,
      label: "Green",
    }],
    yellow: [],
    red: [],
  };
  if (yellowS >= MIN_SLICE_S) {
    phases.yellow.push({
      controllerId: lead.id,
      headId: leadHeadId,
      indication: "yellow",
      durationS: yellowS,
      label: "Yellow",
    });
  }

  if (others.length === 0) {
    // Nothing else is declared here, so the red window is simply a stop. A clip
    // whose reference indication is `red` holds the WHOLE junction red — see
    // `evaluateSignalReferencePhase`, whose sibling state for a red reference is
    // red — so this is a true all-red hold rather than an invented cross stage.
    phases.red.push({
      controllerId: lead.id,
      headId: leadHeadId,
      indication: "red",
      durationS: redS,
      label: "Red",
    });
    return normalizePhaseOrder(phaseOrder).flatMap((phase) => phases[phase]);
  }

  // The others share the red window. Remainders land on the LAST slot so the
  // cycle sums to exactly green + yellow + red rather than drifting by a tenth
  // per stage — the sum is what the author typed and it has to hold.
  const slot = redS / others.length;
  let spent = 0;
  for (const [at, stage] of others.entries()) {
    const last = at === others.length - 1;
    const share = round(last ? round(redS - spent) : slot);
    spent = round(spent + share);
    const headId = stageHeadId(stage.headIds);
    if (!headId) continue;
    const green = round(share - yellowS);
    if (yellowS >= MIN_SLICE_S && green >= MIN_SLICE_S) {
      phases.red.push({
        controllerId: stage.id,
        headId,
        indication: "green",
        durationS: green,
        label: `Cross ${at + 1}`,
      });
      phases.red.push({
        controllerId: stage.id,
        headId,
        indication: "yellow",
        durationS: yellowS,
        label: `Cross ${at + 1} yellow`,
      });
      continue;
    }
    // Too short to split: give the whole slot to green rather than emit a sliver
    // that would round to a zero-length clip the schema rejects.
    phases.red.push({
      controllerId: stage.id,
      headId,
      indication: "green",
      durationS: share,
      label: `Cross ${at + 1}`,
    });
  }
  return normalizePhaseOrder(phaseOrder).flatMap((phase) => phases[phase]);
}

/**
 * Recover the three numbers from a compiled cycle, and say whether they still
 * explain it.
 *
 * Derived rather than stored, so the card's inputs cannot drift from what will
 * run. `generated: false` means the cycle has since been hand-edited or painted
 * and these numbers only describe part of it — the card says so instead of
 * quietly offering to overwrite the author's work.
 *
 * v1 had to measure the reference GROUP rather than "any phase where any of this
 * head's movements is green", because one head could drive movements in two
 * conflict groups that greened at different times and summing both counted one
 * long green. That cannot happen here: a stage is a single unit and an interval
 * names exactly one, so measuring intervals whose `controllerId` is the lead
 * stage is exact.
 */
export function readReferenceTiming(input: {
  readonly index: EditorSignalIndex;
  readonly junctionId: string;
  readonly referenceHeadId: string;
  readonly cycle: readonly StageInterval[];
}): {
  timing: ReferenceCycleTiming;
  phaseOrder: readonly ReferenceCyclePhase[];
  generated: boolean;
} {
  if (input.cycle.length === 0) {
    return {
      timing: { ...DEFAULT_REFERENCE_TIMING },
      phaseOrder: DEFAULT_REFERENCE_PHASE_ORDER,
      generated: false,
    };
  }
  const stages = orderedStages(input.index, input.junctionId);
  const lead =
    stages.find((stage) => stage.headIds.includes(input.referenceHeadId)) ?? stages[0];
  const leadId = lead?.id;

  const isLead = (interval: StageInterval) => interval.controllerId === leadId;
  const total = cycleSeconds(input.cycle);
  const green = round(
    input.cycle
      .filter((interval) => isLead(interval) && interval.indication === "green")
      .reduce((sum, interval) => sum + interval.durationS, 0),
  );
  const yellow = round(
    input.cycle
      .filter((interval) => isLead(interval) && interval.indication === "yellow")
      .reduce((sum, interval) => sum + interval.durationS, 0),
  );

  const timing = clampReferenceTiming({
    greenS: green || DEFAULT_REFERENCE_TIMING.greenS,
    yellowS: yellow,
    redS: round(total - green - yellow) || DEFAULT_REFERENCE_TIMING.redS,
  });
  const phaseOrder = phaseOrderFromCycle(input.cycle, leadId);

  const rebuilt = compileReferenceCycle({
    index: input.index,
    junctionId: input.junctionId,
    referenceHeadId: input.referenceHeadId,
    timing,
    phaseOrder,
  });
  return { timing, phaseOrder, generated: sameCycle(rebuilt, input.cycle) };
}

function normalizePhaseOrder(
  order: readonly ReferenceCyclePhase[],
): readonly ReferenceCyclePhase[] {
  const valid = new Set<ReferenceCyclePhase>();
  for (const phase of order) {
    if (DEFAULT_REFERENCE_PHASE_ORDER.includes(phase)) valid.add(phase);
  }
  for (const phase of DEFAULT_REFERENCE_PHASE_ORDER) valid.add(phase);
  return [...valid];
}

function phaseOrderFromCycle(
  cycle: readonly StageInterval[],
  leadId: string | undefined,
): readonly ReferenceCyclePhase[] {
  const firstAt = new Map<ReferenceCyclePhase, number>();
  for (const [at, interval] of cycle.entries()) {
    const phase: ReferenceCyclePhase = interval.controllerId === leadId
      && (interval.indication === "green" || interval.indication === "yellow")
      ? interval.indication
      : "red";
    if (!firstAt.has(phase)) firstAt.set(phase, at);
  }
  return [...DEFAULT_REFERENCE_PHASE_ORDER].sort(
    (left, right) => (firstAt.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (firstAt.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
}

function sameCycle(
  left: readonly StageInterval[],
  right: readonly StageInterval[],
): boolean {
  if (left.length === 0 || left.length !== right.length) return false;
  return left.every((interval, at) => {
    const other = right[at]!;
    return (
      interval.controllerId === other.controllerId &&
      interval.headId === other.headId &&
      interval.indication === other.indication &&
      interval.durationS === other.durationS
    );
  });
}

/**
 * How many other stages share the red window. Zero means nothing else is
 * declared here, so the red is a plain stop.
 *
 * Independent of WHICH light is the reference: every stage but one shares the
 * red, whichever one is leading.
 */
export function crossingStageCount(index: EditorSignalIndex, junctionId: string): number {
  const stages = orderedStages(index, junctionId).filter(
    (stage) => stage.headIds.length > 0 && stage.movementIds.length > 0,
  );
  return Math.max(0, stages.length - 1);
}

/**
 * A single-interval cycle holding one stage at one indication for the whole clip.
 *
 * v1 called this the `static` mode and seeded it with `allRedStates`. Here it is
 * just a cycle of length one, which is why there is no separate mode enum: the
 * plan shape is the same and `plan.ts` lays it out identically.
 */
export function holdCycle(input: {
  readonly index: EditorSignalIndex;
  readonly junctionId: string;
  readonly referenceHeadId: string;
  readonly indication: MapSignalIndication;
  readonly durationS: number;
}): StageInterval[] {
  const selection = orderedStages(input.index, input.junctionId).find((stage) =>
    stage.headIds.includes(input.referenceHeadId),
  );
  const headId = selection ? stageHeadId(selection.headIds) : null;
  if (!selection || !headId || input.durationS <= 0) return [];
  return [
    {
      controllerId: selection.id,
      headId,
      indication: input.indication,
      durationS: round(input.durationS),
      label: "Hold",
    },
  ];
}
