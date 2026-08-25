/**
 * One light's timing, and the junction follows: green, yellow, red.
 *
 * Three numbers, and they mean exactly what they say — how long the light you
 * clicked is green, how long it is yellow, how long it is red. The cycle is
 * their sum. Nothing else is asked of the author, and nothing else needs to be:
 * while your light is red, every approach that crosses it takes a turn inside
 * that red window, in the order the junction's geometry allows.
 *
 * ## Why this shape and not the previous one
 *
 * The first version asked for green, yellow, ALL-RED and OFFSET, and derived the
 * red window from however many conflict groups the junction happened to have.
 * That is how a traffic engineer parameterises a controller, and it was the
 * wrong surface for an author: "all-red" is jargon, "offset" only means anything
 * across a coordinated corridor, and the one quantity a person actually pictures
 * — how long am I stopped at this light — was the one number they could not
 * type. Now red is an input and the cycle is G + Y + R, full stop.
 *
 * ## The conflict guarantee
 *
 * Only ONE group is ever green in any interval, and the groups come from the
 * shared `deriveConflictFreeGroups` — the same partition
 * `detectSignalPlanWarnings` checks against. So a compiled cycle cannot raise
 * `conflicting_green`, by construction rather than by testing.
 *
 * ## No schema change
 *
 * The output is a plain `SignalPhaseProgram`. The worker executor, the xosc
 * writer and the browser preview engine consume it unchanged, and the timeline
 * lane decompiles it into bands like any other program.
 */

import {
  deriveConflictFreeGroups,
  type BehaviorSignalState,
  type JunctionMovementBinding,
  type SignalPhaseInterval,
  type SignalPhaseProgram,
} from "@simforge/studio-shared";

/** The three numbers an author types. Seconds. */
export type ReferenceCycleTiming = {
  greenS: number;
  yellowS: number;
  redS: number;
};

/**
 * Sized for a SCENARIO, not for a real intersection.
 *
 * A default scenario runs 20 s. Real-world timings (20 s green, 30 s red) give a
 * 53 s cycle, so a scenario would end before the light had finished its first
 * red — the author sets a timing, presses play, and watches nothing happen. Ten
 * green, five yellow, five red is one complete cycle inside the default
 * duration, which is what makes the numbers legible the moment they are typed.
 *
 * Deliberately not realistic. An author who wants survey-true timings can type
 * them; an author who wants to SEE the light change cannot discover that they
 * need a 60 s scenario first.
 */
export const DEFAULT_REFERENCE_TIMING: ReferenceCycleTiming = {
  greenS: 10,
  yellowS: 5,
  redS: 5,
};

/**
 * Bounds, wide enough not to argue with a real intersection and tight enough
 * that a mid-typing value cannot compile something the schema rejects
 * (`duration_s` must be positive).
 */
export const MIN_GREEN_S = 1;
export const MAX_GREEN_S = 600;
export const MIN_YELLOW_S = 0;
export const MAX_YELLOW_S = 15;
export const MIN_RED_S = 1;
export const MAX_RED_S = 600;

/** Smallest slice worth emitting; also the floor for a shared red window. */
const MIN_SLICE_S = 0.5;

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

export type CompileReferenceCycleInput = {
  movements: readonly JunctionMovementBinding[];
  /** Every movement the clicked head drives. */
  referenceMovementIds: readonly string[];
  timing: ReferenceCycleTiming;
};

/**
 * The groups this model phases: conflict-free AND head-fused.
 *
 * `unionSharedHeads` matters here in a way it does not for a generic cycle
 * synthesizer. Two movements that resolve to the same physical head cannot show
 * different colours — the runtime echo is `signal_plan_shared_head_conflict` —
 * and the raw conflict partition happily puts them in different groups, which on
 * Di Rosa produced 32 `shared_signal_heads` warnings on an otherwise ordinary
 * Apply and a plan the worker could not honour.
 *
 * Fusing costs some parallelism: two approaches wired to one head now green
 * together whether or not their paths conflict. That is the correct trade for a
 * surface whose unit IS the head — the author is timing a light, and a light
 * shows one colour.
 */
function referenceGroups(
  movements: readonly JunctionMovementBinding[],
): string[][] {
  return deriveConflictFreeGroups(movements, { unionSharedHeads: true });
}

/** Which conflict-free group holds the clicked light. Falls back to the first. */
export function referenceGroupIndex(
  groups: readonly string[][],
  referenceMovementIds: readonly string[],
): number {
  const wanted = referenceMovementIds
    .map((id) => String(id).trim())
    .filter(Boolean);
  if (wanted.length === 0) return 0;
  const at = groups.findIndex((group) => group.some((id) => wanted.includes(id)));
  return at === -1 ? 0 : at;
}

/**
 * Compile the junction from the clicked light's three numbers.
 *
 * The reference group leads — green, then yellow — and every other group takes
 * an equal share of the red window that follows. `null` when there is nothing to
 * phase, matching the schema's `cycle.min(1)`.
 */
export function compileReferenceCycle({
  movements,
  referenceMovementIds,
  timing,
}: CompileReferenceCycleInput): SignalPhaseProgram | null {
  if (movements.length === 0) return null;
  const { greenS, yellowS, redS } = clampReferenceTiming(timing);

  const groups = referenceGroups(movements);
  if (groups.length === 0) return null;
  const referenceAt = referenceGroupIndex(groups, referenceMovementIds);
  const reference = groups[referenceAt]!;
  const others = groups.filter((_, index) => index !== referenceAt);

  const allRed = Object.fromEntries(
    movements.map((movement) => [movement.movement_id, "red" as BehaviorSignalState]),
  );
  const withGroup = (group: readonly string[], state: BehaviorSignalState) => ({
    ...allRed,
    ...Object.fromEntries(group.map((movementId) => [movementId, state])),
  });

  const cycle: SignalPhaseInterval[] = [
    { duration_s: greenS, label: "Green", states: withGroup(reference, "green") },
  ];
  if (yellowS >= MIN_SLICE_S) {
    cycle.push({
      duration_s: yellowS,
      label: "Yellow",
      states: withGroup(reference, "yellow"),
    });
  }

  if (others.length === 0) {
    // Nothing conflicts here, so the red window is simply a stop: an all-red
    // hold rather than an invented cross movement.
    cycle.push({ duration_s: redS, label: "Red", states: { ...allRed } });
  } else {
    // The others share the red window. Remainders land on the LAST slot so the
    // cycle sums to exactly green + yellow + red rather than drifting by a tenth
    // per group — the sum is what the author typed and it has to hold.
    const slot = redS / others.length;
    let spent = 0;
    for (const [index, group] of others.entries()) {
      const last = index === others.length - 1;
      const share = round(last ? redS - spent : slot);
      spent = round(spent + share);
      const green = round(share - yellowS);
      if (yellowS >= MIN_SLICE_S && green >= MIN_SLICE_S) {
        cycle.push({
          duration_s: green,
          label: `Cross ${index + 1}`,
          states: withGroup(group, "green"),
        });
        cycle.push({
          duration_s: yellowS,
          label: `Cross ${index + 1} yellow`,
          states: withGroup(group, "yellow"),
        });
        continue;
      }
      // Too short to split: give the whole slot to green rather than emit a
      // sliver the schema would round to nothing.
      cycle.push({
        duration_s: share,
        label: `Cross ${index + 1}`,
        states: withGroup(group, "green"),
      });
    }
  }

  return { cycle, offset_s: 0 };
}

/**
 * Recover the three numbers from a program, and say whether they still explain
 * it.
 *
 * Derived rather than stored, so the inputs cannot drift from what will run.
 * `generated: false` means the program has since been hand-edited or painted and
 * these numbers only describe part of it — the card says so instead of quietly
 * offering to overwrite the author's work.
 */
export function readReferenceTiming(input: {
  movements: readonly JunctionMovementBinding[];
  referenceMovementIds: readonly string[];
  program: SignalPhaseProgram | null | undefined;
}): { timing: ReferenceCycleTiming; generated: boolean } {
  const program = input.program;
  if (!program || program.cycle.length === 0) {
    return { timing: { ...DEFAULT_REFERENCE_TIMING }, generated: false };
  }
  const wanted = input.referenceMovementIds
    .map((id) => String(id).trim())
    .filter(Boolean);
  // Measure the reference GROUP, not every movement the head drives.
  //
  // On a real junction one head can drive movements that land in two different
  // conflict groups (Di Rosa does this), and those groups green at different
  // times. Summing "any phase where any of this head's movements is green" then
  // counts two separate greens as one long one, the derived numbers stop
  // describing the program, and the card decides it was hand-edited — which is
  // exactly what it reported after a perfectly ordinary Apply.
  const groups = referenceGroups(input.movements);
  const referenceGroup = groups[referenceGroupIndex(groups, wanted)] ?? wanted;
  const isState = (phase: SignalPhaseInterval, state: BehaviorSignalState) =>
    referenceGroup.some((id) => phase.states[id] === state);

  const total = program.cycle.reduce((sum, phase) => sum + phase.duration_s, 0);
  const green = program.cycle
    .filter((phase) => isState(phase, "green"))
    .reduce((sum, phase) => sum + phase.duration_s, 0);
  const yellow = program.cycle
    .filter((phase) => isState(phase, "yellow"))
    .reduce((sum, phase) => sum + phase.duration_s, 0);

  const timing = clampReferenceTiming({
    greenS: green || DEFAULT_REFERENCE_TIMING.greenS,
    yellowS: yellow,
    redS: round(total - green - yellow) || DEFAULT_REFERENCE_TIMING.redS,
  });

  const rebuilt = compileReferenceCycle({
    movements: input.movements,
    referenceMovementIds: wanted,
    timing,
  });
  return { timing, generated: rebuilt != null && sameProgram(rebuilt, program) };
}

function sameProgram(left: SignalPhaseProgram, right: SignalPhaseProgram): boolean {
  if (left.cycle.length !== right.cycle.length) return false;
  if (left.offset_s !== right.offset_s) return false;
  return left.cycle.every((phase, index) => {
    const other = right.cycle[index]!;
    if (phase.duration_s !== other.duration_s) return false;
    const keys = Object.keys(phase.states);
    if (keys.length !== Object.keys(other.states).length) return false;
    return keys.every((key) => phase.states[key] === other.states[key]);
  });
}

/** Total cycle length — what the author typed, added up. */
export function referenceCycleSeconds(timing: ReferenceCycleTiming): number {
  const { greenS, yellowS, redS } = clampReferenceTiming(timing);
  return round(greenS + yellowS + redS);
}

/**
 * How many other approaches share the red window. Zero means nothing crosses.
 *
 * Independent of WHICH light is the reference: every group but one shares the
 * red, whichever one is leading.
 */
export function crossingGroupCount(
  movements: readonly JunctionMovementBinding[],
): number {
  const groups = referenceGroups(movements);
  if (groups.length === 0) return 0;
  return Math.max(0, groups.length - 1);
}
