/**
 * Pure model for traffic-signal authoring (plan 2026-07-24, section 4.3).
 *
 * Everything the intersection panel, the canvas glyphs and the dock's SCENE
 * lane compute lives here, side-effect free, so the geometry and the cycle math
 * are unit-testable without React. The shared package owns the SCHEMA and the
 * runtime cycle math (`signalPhaseAt` / `movementStateAt` — deliberately shared
 * with the worker executor); this module owns the EDITOR's derived views of it.
 */

import {
  DEFAULT_BEHAVIOR_CLIP_END,
  DEFAULT_PHASE_GREEN_S,
  movementStateAt,
  signalProgramCycleDurationS,
  synthesizeSignalProgram,
  type BehaviorSignalState,
  type JunctionMovementBinding,
  type JunctionSignalPlan,
  type SceneClip,
  type SignalPhaseInterval,
  type SignalPhaseProgram,
  type SignalPlanMode,
  type SignalTurn,
} from "@simforge/studio-shared";

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * Signal colours, chosen to read as a traffic head on the dock's near-black
 * surface rather than to match a real lamp. `unknown` is the movement a plan
 * says nothing about: an outline, never a filled colour, because "no opinion"
 * and "authored dark" must not look alike.
 */
export const SIGNAL_STATE_COLORS: Record<BehaviorSignalState, string> = {
  red: "#F04E4E",
  yellow: "#F0B429",
  green: "#3FCF6E",
};

export const SIGNAL_UNKNOWN_COLOR = "#6B7280";

export function signalStateColor(state: BehaviorSignalState | null): string {
  return state ? SIGNAL_STATE_COLORS[state] : SIGNAL_UNKNOWN_COLOR;
}

export const SIGNAL_STATE_LABELS: Record<BehaviorSignalState, string> = {
  red: "Red",
  yellow: "Yellow",
  green: "Green",
};

/**
 * The click-through order on the movement diagram.
 *
 * Red → green → yellow, not the lamp order red → yellow → green, because the
 * authored pair is almost always red/green: putting yellow between them would
 * cost a second click on every phase an author builds. Yellow is the third
 * state you reach when you want it.
 */
const SIGNAL_STATE_CYCLE: readonly BehaviorSignalState[] = ["red", "green", "yellow"];

/** Advance one movement's colour, wrapping. `null` (unstated) enters at red. */
export function nextSignalState(
  state: BehaviorSignalState | null,
): BehaviorSignalState {
  if (!state) return "red";
  const index = SIGNAL_STATE_CYCLE.indexOf(state);
  return SIGNAL_STATE_CYCLE[(index + 1) % SIGNAL_STATE_CYCLE.length]!;
}

/**
 * `map_default` no longer means "CARLA's own timers".
 *
 * Michael's 2026-07-26 decision (traffic-light timeline plan §11): every dynamic
 * light on a junction with no authored plan is forced GREEN and frozen for the
 * whole scenario. So the label has to say what actually happens — an author
 * reading "Map default" would expect a cycle that no longer runs, and would go
 * hunting for why their ambient traffic never stops.
 *
 * `program` is labelled Timeline because that is now how it is authored (§Q6):
 * both write `mode: "program"`, and the phase list survives behind "Edit as
 * phase list" for the coordination work a timeline is genuinely bad at.
 */
export const SIGNAL_PLAN_MODE_LABELS: Record<SignalPlanMode, string> = {
  map_default: "Forced green",
  static: "Static",
  program: "Timeline",
  scripted: "Scripted",
};

export const SIGNAL_PLAN_MODE_HINTS: Record<SignalPlanMode, string> = {
  map_default:
    "Forced green (default). Every light here is frozen green for the whole scenario until you author a timeline.",
  static: "Freeze the junction in one authored state for the whole scenario.",
  program: "Paint red and green spans on the lane. The cycle is compiled from what you draw.",
  scripted: "Drive phase changes from triggers, over a static or program baseline.",
};

export const SIGNAL_TURN_LABELS: Record<SignalTurn, string> = {
  left: "Left",
  right: "Right",
  straight: "Through",
  uturn: "U-turn",
};

// ---------------------------------------------------------------------------
// Reading a plan
// ---------------------------------------------------------------------------

/** The states a plan commands at `t`, by mode. `{}` under `map_default`. */
export function planStatesAt(
  plan: JunctionSignalPlan,
  t: number,
): Record<string, BehaviorSignalState> {
  if (plan.mode === "map_default") return {};
  if (plan.mode === "static") return { ...(plan.static ?? {}) };
  const program = plan.program;
  if (!program || program.cycle.length === 0) {
    // A scripted plan may have no baseline program; its static block, if any,
    // is the baseline the worker holds between clip overrides.
    return plan.mode === "scripted" ? { ...(plan.static ?? {}) } : {};
  }
  // Every movement the cycle names, not just the bound ones: a plan whose
  // movement table was dropped by a map rebuild still commands real colours,
  // and resolving only the table would report the junction as commanding
  // nothing — which is the one thing it is definitely not doing.
  const movementIds = new Set([
    ...plan.movements.map((movement) => movement.movement_id),
    ...program.cycle.flatMap((phase) => Object.keys(phase.states)),
  ]);
  const states: Record<string, BehaviorSignalState> = {};
  for (const movementId of movementIds) {
    const state = movementStateAt(program, movementId, t);
    if (state) states[movementId] = state;
  }
  return states;
}

/**
 * One colour standing for the whole junction — the canvas glyph's fill.
 *
 * Green wins over yellow wins over red: the glyph answers "is anything moving
 * through here", and a junction with one green movement is a green junction to
 * a driver approaching it. `null` under `map_default`, or when a plan commands
 * nothing, which the glyph draws grey.
 */
export function dominantPlanState(
  plan: JunctionSignalPlan,
  t = 0,
): BehaviorSignalState | null {
  const states = Object.values(planStatesAt(plan, t));
  if (states.includes("green")) return "green";
  if (states.includes("yellow")) return "yellow";
  if (states.includes("red")) return "red";
  return null;
}

/** The state a movement holds in the interval currently being edited. */
export function movementStateInPhase(
  phase: SignalPhaseInterval | null,
  movementId: string,
): BehaviorSignalState | null {
  return phase?.states[movementId] ?? null;
}

// ---------------------------------------------------------------------------
// SCENE-lane bands
// ---------------------------------------------------------------------------

export type SignalBand = {
  movement_id: string;
  state: BehaviorSignalState;
  start_s: number;
  end_s: number;
  /** Index into `program.cycle`, for the tooltip. `null` for a static hold. */
  phase_index: number | null;
};

/**
 * Lay a plan's authored colour out across the scenario, per movement.
 *
 * `static` is one band per commanded movement spanning the whole timeline.
 * `program` repeats its cycle from `offset_s` until the timeline runs out, and
 * a phase that does not name a movement extends the previous band rather than
 * breaking it — the same "hold your colour" rule `movementStateAt` applies, so
 * the lane shows the colour sequence a viewer would actually see rather than
 * one band per interval.
 *
 * `scripted` renders its baseline here; its clips are drawn as clips.
 */
export function signalPlanBands(
  plan: JunctionSignalPlan,
  durationSeconds: number,
): SignalBand[] {
  if (plan.mode === "map_default" || durationSeconds <= 0) return [];

  const program = plan.mode === "program" || plan.mode === "scripted" ? plan.program : undefined;
  if (!program || program.cycle.length === 0) {
    return Object.entries(plan.static ?? {}).map(([movementId, state]) => ({
      movement_id: movementId,
      state,
      start_s: 0,
      end_s: durationSeconds,
      phase_index: null,
    }));
  }
  return programBands(program, plan.movements, durationSeconds);
}

/**
 * Repeating phase bands for one cycle across `durationSeconds`.
 *
 * Walks the cycle from `offset_s` rather than sampling a clock, so the band
 * edges land exactly on the authored interval boundaries with no quantisation
 * drift, and a cycle far longer than the scenario simply yields one truncated
 * band per movement. Guarded against a zero-length cycle, which would spin.
 */
export function programBands(
  program: SignalPhaseProgram,
  movements: readonly JunctionMovementBinding[],
  durationSeconds: number,
): SignalBand[] {
  const total = signalProgramCycleDurationS(program);
  if (total <= 0 || durationSeconds <= 0) return [];

  // Every movement the cycle ever names, plus every bound movement: a plan can
  // legitimately command a movement whose binding was dropped by a map rebuild,
  // and dropping it from the lane would hide authored intent.
  const movementIds = [
    ...new Set([
      ...movements.map((movement) => movement.movement_id),
      ...program.cycle.flatMap((phase) => Object.keys(phase.states)),
    ]),
  ].sort();

  const open = new Map<string, SignalBand>();
  const bands: SignalBand[] = [];
  // Seed each movement with the colour in force at t=0, so a band that starts
  // mid-cycle is drawn from 0 rather than from its next restatement.
  for (const movementId of movementIds) {
    const state = movementStateAt(program, movementId, 0);
    if (state) {
      open.set(movementId, {
        movement_id: movementId,
        state,
        start_s: 0,
        end_s: durationSeconds,
        phase_index: null,
      });
    }
  }

  // Advance to each interval boundary after t=0 and close any band whose colour
  // changes there. `cursor` is scenario time; `position` is cycle time.
  let position = program.offset_s % total;
  let index = 0;
  let cursor = 0;
  {
    let scanned = 0;
    while (scanned < total && position >= program.cycle[index]!.duration_s) {
      scanned += program.cycle[index]!.duration_s;
      position -= program.cycle[index]!.duration_s;
      index = (index + 1) % program.cycle.length;
    }
  }
  cursor = program.cycle[index]!.duration_s - position;
  index = (index + 1) % program.cycle.length;

  while (cursor < durationSeconds) {
    const phase = program.cycle[index]!;
    for (const [movementId, state] of Object.entries(phase.states)) {
      const current = open.get(movementId);
      if (current?.state === state) continue;
      if (current) {
        bands.push({ ...current, end_s: cursor });
      }
      open.set(movementId, {
        movement_id: movementId,
        state,
        start_s: cursor,
        end_s: durationSeconds,
        phase_index: index,
      });
    }
    cursor += phase.duration_s;
    index = (index + 1) % program.cycle.length;
  }

  for (const band of open.values()) {
    if (band.start_s < durationSeconds) bands.push(band);
  }
  return bands.sort(
    (left, right) =>
      left.movement_id.localeCompare(right.movement_id) || left.start_s - right.start_s,
  );
}

export type JunctionBand = {
  state: BehaviorSignalState;
  start_s: number;
  end_s: number;
};

/**
 * Reduce per-movement bands to one band sequence for the whole junction.
 *
 * One row per movement would be eight rows for an ordinary four-way and would
 * bury the actor lanes, so the SCENE lane shows the junction's DOMINANT colour
 * (`dominantPlanState`'s rule: green over yellow over red) — which answers the
 * question the lane exists for: is this junction letting anything through, and
 * when does that change.
 *
 * Sampled at each interval's MIDPOINT rather than its edge, so a zero-width
 * artefact at a boundary cannot produce a phantom band, and neighbouring
 * intervals that agree are merged.
 */
export function dominantJunctionBands(
  /** Per-movement bands — authored (`signalPlanBands`) or observed. */
  bands: ReadonlyArray<{
    state: BehaviorSignalState;
    start_s: number;
    end_s: number;
    movement_id?: string;
  }>,
  durationSeconds: number,
): JunctionBand[] {
  if (bands.length === 0 || durationSeconds <= 0) return [];
  const edges = [
    ...new Set([0, durationSeconds, ...bands.flatMap((band) => [band.start_s, band.end_s])]),
  ]
    .filter((t) => t >= 0 && t <= durationSeconds)
    .sort((left, right) => left - right);

  const merged: JunctionBand[] = [];
  for (const [at, start] of edges.slice(0, -1).entries()) {
    const end = edges[at + 1]!;
    if (end <= start) continue;
    const mid = (start + end) / 2;
    const live = bands.filter((band) => band.start_s <= mid && band.end_s > mid);
    const state = live.some((band) => band.state === "green")
      ? ("green" as const)
      : live.some((band) => band.state === "yellow")
        ? ("yellow" as const)
        : live.some((band) => band.state === "red")
          ? ("red" as const)
          : null;
    if (!state) continue;
    const last = merged[merged.length - 1];
    if (last && last.state === state && Math.abs(last.end_s - start) < 1e-6) {
      last.end_s = end;
      continue;
    }
    merged.push({ state, start_s: start, end_s: end });
  }
  return merged;
}

/** What the SCENE lane draws for one planned junction. */
export function junctionAuthoredBands(
  plan: JunctionSignalPlan,
  durationSeconds: number,
): JunctionBand[] {
  return dominantJunctionBands(signalPlanBands(plan, durationSeconds), durationSeconds);
}

// ---------------------------------------------------------------------------
// Writing a plan
// ---------------------------------------------------------------------------

/**
 * A `map_default` plan carrying a freshly derived movement table.
 *
 * Written on FIRST OPEN of an unplanned junction rather than on the first edit:
 * the table is what the panel draws, so the author sees the intersection before
 * committing to anything, and the plan they leave behind commands nothing.
 */
export function mapDefaultPlanWithMovements(
  junctionId: string,
  movements: readonly JunctionMovementBinding[],
): JunctionSignalPlan {
  return {
    schema_version: "simforge.junction-signal-plan.v1",
    junction_id: junctionId,
    mode: "map_default",
    movements: [...movements],
  };
}

/** All-red across every bound movement — the seed a static plan starts from. */
export function allRedStates(
  movements: readonly JunctionMovementBinding[],
): Record<string, BehaviorSignalState> {
  return Object.fromEntries(
    movements.map((movement) => [movement.movement_id, "red" as const]),
  );
}

/**
 * The default cycle a junction gets when the author switches it to `program`.
 *
 * Delegates to the shared `synthesizeSignalProgram`, which partitions movements
 * by greedy colouring of the SAME `conflicts_with` graph that
 * `detectSignalPlanWarnings` checks against. That shared partition is the whole
 * point: a split the panel invented itself could disagree with
 * `deriveMovementConflicts` and hand the author a default program that warns
 * about itself on arrival.
 *
 * Expect three-phase splits on a four-way with protected lefts (not two), and a
 * single standing-green phase where nothing at the junction conflicts. `null`
 * comes back when there is nothing to phase — the panel then leaves `program`
 * unset and prompts rather than storing an empty cycle, which the schema
 * rejects anyway (`cycle` is `.min(1)`).
 */
export function seedPhaseProgram(
  movements: readonly JunctionMovementBinding[],
): SignalPhaseProgram | null {
  return synthesizeSignalProgram(movements);
}

/**
 * Seed whatever the newly-picked mode needs, keeping anything already authored.
 *
 * Switching modes must never destroy work: an author who tries `program` and
 * goes back to `static` finds their static states intact, because the schema
 * carries all four blocks independently and only `mode` decides which one runs.
 */
export function planForMode(
  plan: JunctionSignalPlan,
  mode: SignalPlanMode,
): JunctionSignalPlan {
  const next: JunctionSignalPlan = { ...plan, mode };
  if ((mode === "static" || mode === "scripted") && !next.static) {
    next.static = allRedStates(plan.movements);
  }
  if (mode === "program" && (next.program?.cycle.length ?? 0) === 0) {
    const seeded = seedPhaseProgram(plan.movements);
    if (seeded) next.program = seeded;
  }
  if (mode === "scripted" && (next.scripted?.length ?? 0) === 0) {
    next.scripted = [];
  }
  return next;
}

export function withStaticState(
  plan: JunctionSignalPlan,
  movementId: string,
  state: BehaviorSignalState,
): JunctionSignalPlan {
  return { ...plan, static: { ...(plan.static ?? {}), [movementId]: state } };
}

export function withPhaseState(
  plan: JunctionSignalPlan,
  phaseIndex: number,
  movementId: string,
  state: BehaviorSignalState,
): JunctionSignalPlan {
  const program = plan.program;
  if (!program?.cycle[phaseIndex]) return plan;
  return {
    ...plan,
    program: {
      ...program,
      cycle: program.cycle.map((phase, index) =>
        index === phaseIndex
          ? { ...phase, states: { ...phase.states, [movementId]: state } }
          : phase,
      ),
    },
  };
}

export function withPhaseDuration(
  plan: JunctionSignalPlan,
  phaseIndex: number,
  durationSeconds: number,
): JunctionSignalPlan {
  const program = plan.program;
  if (!program?.cycle[phaseIndex]) return plan;
  // The schema demands a positive duration; clamping here keeps a mid-typing
  // "0" from writing a plan the draft cannot serialise.
  const duration = Math.max(0.5, Math.round(durationSeconds * 10) / 10);
  return {
    ...plan,
    program: {
      ...program,
      cycle: program.cycle.map((phase, index) =>
        index === phaseIndex ? { ...phase, duration_s: duration } : phase,
      ),
    },
  };
}

export function withCycleOffset(
  plan: JunctionSignalPlan,
  offsetSeconds: number,
): JunctionSignalPlan {
  const program = plan.program;
  if (!program) return plan;
  return {
    ...plan,
    program: {
      ...program,
      offset_s: Math.max(0, Math.round(offsetSeconds * 10) / 10),
    },
  };
}

/** Append a phase, copying the last one so the author edits rather than builds. */
export function withAddedPhase(plan: JunctionSignalPlan): JunctionSignalPlan {
  const program = plan.program ?? { cycle: [], offset_s: 0 };
  const last = program.cycle[program.cycle.length - 1];
  return {
    ...plan,
    program: {
      ...program,
      cycle: [
        ...program.cycle,
        {
          duration_s: last?.duration_s ?? DEFAULT_PHASE_GREEN_S,
          label: `Phase ${program.cycle.length + 1}`,
          states: { ...(last?.states ?? allRedStates(plan.movements)) },
        },
      ],
    },
  };
}

/** Remove a phase. The last phase is never removed — a cycle needs one. */
export function withRemovedPhase(
  plan: JunctionSignalPlan,
  phaseIndex: number,
): JunctionSignalPlan {
  const program = plan.program;
  if (!program || program.cycle.length <= 1) return plan;
  return {
    ...plan,
    program: {
      ...program,
      cycle: program.cycle.filter((_, index) => index !== phaseIndex),
    },
  };
}

export function withMovedPhase(
  plan: JunctionSignalPlan,
  phaseIndex: number,
  delta: number,
): JunctionSignalPlan {
  const program = plan.program;
  const target = phaseIndex + delta;
  if (!program || target < 0 || target >= program.cycle.length) return plan;
  const cycle = [...program.cycle];
  const [moved] = cycle.splice(phaseIndex, 1);
  cycle.splice(target, 0, moved!);
  return { ...plan, program: { ...program, cycle } };
}

let sceneClipCounter = 0;

export function nextSceneClipId(): string {
  sceneClipCounter += 1;
  const unique =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}_${sceneClipCounter}`;
  return `sig_${unique}`;
}

/**
 * The clip "Add phase change" seeds: the first movement goes red at t=0.
 *
 * Deliberately a `set_movement_state` rather than `set_junction_state` — the
 * whole point of the scripted mode is per-movement overrides, and an author who
 * wants all-red can switch the action in the inspector in one click.
 */
export function seedSceneClip(
  plan: JunctionSignalPlan,
  atSeconds: number,
): SceneClip {
  const movementId = plan.movements[0]?.movement_id;
  return {
    id: nextSceneClipId(),
    enabled: true,
    trigger: { kind: "at_time", t: Math.max(0, Math.round(atSeconds * 10) / 10) },
    end: DEFAULT_BEHAVIOR_CLIP_END,
    action: movementId
      ? { kind: "set_movement_state", movement_id: movementId, state: "red" }
      : { kind: "set_junction_state", state: "red" },
  };
}

export function withSceneClip(
  plan: JunctionSignalPlan,
  clip: SceneClip,
): JunctionSignalPlan {
  const existing = plan.scripted ?? [];
  const index = existing.findIndex((entry) => entry.id === clip.id);
  return {
    ...plan,
    scripted:
      index === -1
        ? [...existing, clip]
        : existing.map((entry, at) => (at === index ? clip : entry)),
  };
}

export function withoutSceneClip(
  plan: JunctionSignalPlan,
  clipId: string,
): JunctionSignalPlan {
  return {
    ...plan,
    scripted: (plan.scripted ?? []).filter((entry) => entry.id !== clipId),
  };
}

/** What a scene clip does, for the clip segment and the inspector header. */
export function sceneClipSummary(clip: SceneClip): string {
  const state = SIGNAL_STATE_LABELS[clip.action.state].toLowerCase();
  return clip.action.kind === "set_junction_state"
    ? `All movements ${state}`
    : `${clip.action.movement_id} ${state}`;
}

export function movementLabel(
  plan: JunctionSignalPlan,
  movementId: string,
): string {
  return (
    plan.movements.find((movement) => movement.movement_id === movementId)?.label ??
    movementId
  );
}
