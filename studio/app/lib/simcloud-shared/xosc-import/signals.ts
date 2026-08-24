/**
 * Traffic-signal actions → `JunctionSignalPlan[]`.
 *
 * The inverse of `xosc-writer/signals.ts`, and the hardest inversion in this
 * module because the writer UNROLLS a plan: a fixed-time cycle leaves the
 * editor as a program and arrives in the file as a flat list of per-boundary
 * `TrafficSignalStateAction` events. Getting a plan back means re-folding those
 * boundaries into phases.
 *
 * ## What the file does and does not carry
 *
 * A `program` plan's event names encode the junction and movement
 * (`signal_<junction>_<movement>_t<tenths>`), so both come back — but both were
 * SANITIZED to identifier characters on the way out and the writer joined them
 * with `_` after sanitizing, so the boundary between them is not recoverable.
 * The importer splits at the FIRST underscore, which is exact for the derived
 * junction ids we author (they carry no underscore) and otherwise mis-places
 * the boundary while still re-exporting the identical event name — because
 * sanitizing an already-sanitized pair and re-joining it is the same string.
 *
 * A `static` plan's Init actions and a `scripted` plan's clip events carry NO
 * junction id at all: the file names bulbs and nothing else. Those junctions
 * are SYNTHESIZED (`imported_junction_N`) with one movement per bulb, and the
 * synthesis is reported. It re-exports byte-identically because the junction id
 * never appears in a static or scripted emission.
 *
 * ## The hold tail
 *
 * The last observed boundary has no successor inside the scenario, so its phase
 * duration is unknowable: the file cannot say whether the cycle restarted just
 * after the window closed or ran for an hour. The refold gives it
 * {@link SIGNAL_IMPORT_HOLD_TAIL_S}, the same 3600 s "holds from here" the
 * signal timeline uses, rather than inventing a period that would make the
 * junction repeat on a schedule nobody authored.
 */

import type { BehaviorSignalState, BehaviorTrigger } from "../scenario-behavior";
import {
  SIGNAL_PLAN_SCHEMA_VERSION,
  type JunctionMovementBinding,
  type JunctionSignalPlan,
  type SceneClip,
  type SignalPhaseInterval,
} from "../scenario-signals";
import { attrString, childEl, descendantEl, findAllEl, type XmlElement } from "../xosc/xml-dom";
import type { ImportDiagnosticCollector } from "./diagnostics";
import {
  readCondition,
  signalStateFromLampString,
  triggerConditions,
  type ReadConditionContext,
} from "./triggers";

/**
 * How long the last observed phase holds, in the reconstructed cycle.
 *
 * Mirrors `SIGNAL_HOLD_TAIL_S` in
 * `apps/web/app/lib/scenario-editor/signal-timeline-model.ts` — the same
 * convention, for the same reason: past the last boundary the plan says "this
 * state holds", not "the cycle restarts".
 */
export const SIGNAL_IMPORT_HOLD_TAIL_S = 3600;

const PROGRAM_EVENT_NAME = /^signal_(.+)_t(-?\d+)$/;
const SCRIPTED_EVENT_PREFIX = "signal_clip_";

export type ReadSignalStateAction = { signalId: string; state: BehaviorSignalState };

/** Every `TrafficSignalStateAction` under an element, in document order. */
export function readSignalStateActions(holder: XmlElement | null): ReadSignalStateAction[] {
  const out: ReadSignalStateAction[] = [];
  for (const action of findAllEl(holder, "TrafficSignalStateAction")) {
    const signalId = attrString(action, "name");
    const state = signalStateFromLampString(attrString(action, "state"));
    if (signalId && state) out.push({ signalId, state });
  }
  return out;
}

type MovementAccum = {
  movementId: string;
  heads: string[];
  /** Set once a static Init action claims this movement. */
  staticState: BehaviorSignalState | null;
};

type JunctionAccum = {
  junctionId: string;
  synthesized: boolean;
  movements: MovementAccum[];
  transitions: Array<{ t: number; movementId: string; state: BehaviorSignalState }>;
  /** Static entries in Init order — the order the writer will re-emit them in. */
  staticOrder: string[];
  scripted: SceneClip[];
};

export type SignalImportInput = {
  /** Init `TrafficSignalStateAction`s, in file order. */
  initActions: readonly ReadSignalStateAction[];
  /** `<Event>` children of the `scene_group` maneuver, in file order. */
  sceneEvents: readonly XmlElement[];
  diagnostics: ImportDiagnosticCollector;
  /** Trigger context for scripted scene clips (no `self`, explicit actors). */
  triggerContext: ReadConditionContext;
};

export type SignalImportResult = {
  plans: JunctionSignalPlan[];
  /** Every OpenDRIVE signal id the file names, in first-seen order. */
  signalIds: string[];
  /** Which reconstructed junction owns a bulb, for `signal_state` triggers. */
  junctionBySignalId: Map<string, string>;
};

function movementIdForHeads(heads: readonly string[]): string {
  return `movement_${heads.join("_")}`;
}

function bindingFor(movement: MovementAccum): JunctionMovementBinding {
  return {
    movement_id: movement.movementId,
    // Nothing in the file describes the junction's lane topology, so the
    // derived fields carry the movement id itself rather than a made-up
    // approach: they are cosmetic or re-derivable, and `signal_ids` — the only
    // field the runtime resolves through — is exact.
    approach_id: movement.movementId,
    turn: "straight",
    label: movement.movementId,
    approach_lane_rsls: [],
    exit_lane_rsls: [],
    signal_ids: [...movement.heads],
    approach_heading_deg: null,
    exit_heading_deg: null,
    conflicts_with: [],
  };
}

/**
 * Re-fold per-boundary transitions into a fixed-time cycle.
 *
 * Every movement's state is written into EVERY phase from the first boundary
 * onward, not just into the phase that changed it. `movementStateAt` resolves a
 * missing movement by walking BACKWARD through the cycle and wrapping past the
 * end, so a sparse phase list would make the last phase's colour leak back to
 * t=0 and produce a transition the original file never contained.
 */
export function refoldProgram(
  transitions: ReadonlyArray<{ t: number; movementId: string; state: BehaviorSignalState }>,
): SignalPhaseInterval[] {
  const boundaries = [...new Set(transitions.map((entry) => entry.t))].sort((a, b) => a - b);
  const current = new Map<string, BehaviorSignalState>();
  const cycle: SignalPhaseInterval[] = [];
  for (const [index, t] of boundaries.entries()) {
    for (const entry of transitions) {
      if (entry.t === t) current.set(entry.movementId, entry.state);
    }
    const next = boundaries[index + 1];
    const duration =
      next === undefined
        ? SIGNAL_IMPORT_HOLD_TAIL_S
        : Math.round((next - t) * 1000) / 1000;
    if (duration <= 0) continue;
    cycle.push({ duration_s: duration, states: Object.fromEntries(current) });
  }
  return cycle;
}

export function importSignalPlans(input: SignalImportInput): SignalImportResult {
  const junctions: JunctionAccum[] = [];
  const signalIds: string[] = [];
  const seenSignalIds = new Set<string>();
  const noteSignalId = (id: string): void => {
    if (seenSignalIds.has(id)) return;
    seenSignalIds.add(id);
    signalIds.push(id);
  };

  const junctionFor = (junctionId: string, synthesized: boolean): JunctionAccum => {
    const existing = junctions.find((entry) => entry.junctionId === junctionId);
    if (existing) return existing;
    const created: JunctionAccum = {
      junctionId,
      synthesized,
      movements: [],
      transitions: [],
      staticOrder: [],
      scripted: [],
    };
    junctions.push(created);
    return created;
  };

  const movementFor = (
    junction: JunctionAccum,
    movementId: string,
    heads: readonly string[],
  ): MovementAccum => {
    const existing = junction.movements.find((entry) => entry.movementId === movementId);
    if (existing) {
      for (const head of heads) if (!existing.heads.includes(head)) existing.heads.push(head);
      return existing;
    }
    const created: MovementAccum = { movementId, heads: [...heads], staticState: null };
    junction.movements.push(created);
    return created;
  };

  // -----------------------------------------------------------------------
  // Pass 1 — program transitions. These are the only events that name their
  // junction, so they define the junctions everything else attaches to.
  // -----------------------------------------------------------------------
  const scriptedEvents: XmlElement[] = [];
  for (const event of input.sceneEvents) {
    const name = attrString(event, "name") ?? "";
    if (name.startsWith(SCRIPTED_EVENT_PREFIX)) {
      scriptedEvents.push(event);
      continue;
    }
    const match = PROGRAM_EVENT_NAME.exec(name);
    const actions = readSignalStateActions(event);
    if (!match || actions.length === 0) {
      input.diagnostics.add(
        "unknown_action",
        `scene event "${name}" is neither a signal program transition nor a scripted signal clip, and was not imported`,
      );
      continue;
    }
    const prefix = match[1]!;
    const split = prefix.indexOf("_");
    // See the module doc: any consistent split re-exports the same event name.
    const junctionId = split < 0 ? prefix : prefix.slice(0, split);
    const movementId = split < 0 ? prefix : prefix.slice(split + 1);
    const timeCondition = descendantEl(
      childEl(event, "StartTrigger"),
      "ConditionGroup",
      "Condition",
      "ByValueCondition",
      "SimulationTimeCondition",
    );
    const t = Number(attrString(timeCondition, "value") ?? Number(match[2]!) / 10);
    if (!Number.isFinite(t)) {
      input.diagnostics.add(
        "unknown_condition",
        `signal transition "${name}" carries no readable simulation time and was not imported`,
      );
      continue;
    }
    const state = actions[0]!.state;
    const heads = actions.map((entry) => entry.signalId);
    for (const head of heads) noteSignalId(head);
    const junction = junctionFor(junctionId, false);
    movementFor(junction, movementId, heads);
    junction.transitions.push({ t, movementId, state });
  }

  // -----------------------------------------------------------------------
  // Pass 2 — scripted clips. Their event name carries the clip id and nothing
  // else, so they are attributed to a junction through their signal heads.
  // -----------------------------------------------------------------------
  for (const event of scriptedEvents) {
    const name = attrString(event, "name") ?? "";
    const clipId = name.slice(SCRIPTED_EVENT_PREFIX.length);
    const actions = readSignalStateActions(event);
    if (actions.length === 0) {
      input.diagnostics.add(
        "unknown_action",
        `scripted signal clip "${clipId}" commands no signal head and was not imported`,
      );
      continue;
    }
    const heads = actions.map((entry) => entry.signalId);
    for (const head of heads) noteSignalId(head);
    const state = actions[0]!.state;
    if (actions.some((entry) => entry.state !== state)) {
      input.diagnostics.add(
        "imported_approximation",
        `scripted signal clip "${clipId}" drives its heads to more than one colour, which no single scene action can express; it imports as "${state}" for all of them`,
      );
    }

    let trigger: BehaviorTrigger | null = null;
    for (const condition of triggerConditions(childEl(event, "StartTrigger"))) {
      const read = readCondition(condition, input.triggerContext);
      if (read.kind === "trigger") {
        trigger = read.trigger;
        break;
      }
      input.diagnostics.add(
        "unknown_condition",
        `scripted signal clip "${clipId}" is gated on a condition this importer has no inverse for (${read.kind === "unsupported" ? read.element : "cut-in gap"})`,
      );
    }
    if (!trigger) {
      input.diagnostics.add(
        "unknown_condition",
        `scripted signal clip "${clipId}" has no readable start condition and was not imported`,
      );
      continue;
    }

    // The junction that already owns exactly these heads, if any; otherwise a
    // synthesized one. A junction running a program is a legal owner — a
    // `scripted` plan layers its overrides on a program baseline.
    const owner =
      junctions.find((junction) =>
        junction.movements.some(
          (movement) =>
            movement.heads.length === heads.length &&
            movement.heads.every((head, index) => head === heads[index]),
        ),
      ) ??
      junctions.find((junction) => {
        const all = junction.movements.flatMap((movement) => movement.heads);
        return all.length === heads.length && all.every((head, index) => head === heads[index]);
      }) ??
      junctionFor(`imported_junction_${junctions.length + 1}`, true);

    const exact = owner.movements.find(
      (movement) =>
        movement.heads.length === heads.length &&
        movement.heads.every((head, index) => head === heads[index]),
    );
    const coversWholeJunction =
      owner.movements.length > 1 &&
      owner.movements.flatMap((movement) => movement.heads).join(" ") ===
        heads.join(" ");

    const movement = exact ?? (coversWholeJunction ? null : movementFor(owner, movementIdForHeads(heads), heads));
    owner.scripted.push({
      id: clipId,
      enabled: true,
      trigger,
      // The writer never emits a scene clip's end, so every imported clip runs
      // to completion. See the loss list in `index.ts`.
      end: { kind: "completion" },
      action:
        movement === null
          ? { kind: "set_junction_state", state }
          : { kind: "set_movement_state", movement_id: movement.movementId, state },
    });
  }

  // -----------------------------------------------------------------------
  // Pass 3 — Init actions, which are a `static` baseline. A junction running a
  // program never emits one, so only program-free junctions can claim them.
  // -----------------------------------------------------------------------
  const claimableMovements = (): Array<{ junction: JunctionAccum; movement: MovementAccum }> =>
    junctions
      .filter((junction) => junction.transitions.length === 0)
      .flatMap((junction) =>
        junction.movements
          .filter((movement) => movement.staticState === null)
          .map((movement) => ({ junction, movement })),
      );

  let index = 0;
  let syntheticStatic: JunctionAccum | null = null;
  while (index < input.initActions.length) {
    const head = input.initActions[index]!;
    noteSignalId(head.signalId);
    // The writer emits a movement's heads consecutively, all at one colour, so
    // a run that matches a known movement's whole head list IS that movement.
    const run = claimableMovements().find(({ movement }) => {
      if (movement.heads[0] !== head.signalId) return false;
      return movement.heads.every((expected, offset) => {
        const entry = input.initActions[index + offset];
        return entry !== undefined && entry.signalId === expected && entry.state === head.state;
      });
    });
    if (run) {
      run.movement.staticState = head.state;
      run.junction.staticOrder.push(run.movement.movementId);
      for (const id of run.movement.heads) noteSignalId(id);
      index += run.movement.heads.length;
      continue;
    }
    if (!syntheticStatic) {
      syntheticStatic = junctionFor(`imported_junction_${junctions.length + 1}`, true);
    }
    // A bulb commanded twice in Init means two movements share it; give each
    // its own so both actions come back rather than one overwriting the other.
    let movementId = movementIdForHeads([head.signalId]);
    let suffix = 2;
    while (
      syntheticStatic.movements.some((movement) => movement.movementId === movementId)
    ) {
      movementId = `${movementIdForHeads([head.signalId])}_${suffix}`;
      suffix += 1;
    }
    const movement = movementFor(syntheticStatic, movementId, [head.signalId]);
    movement.staticState = head.state;
    syntheticStatic.staticOrder.push(movementId);
    index += 1;
  }

  // -----------------------------------------------------------------------
  // Assembly
  // -----------------------------------------------------------------------
  const plans: JunctionSignalPlan[] = [];
  const junctionBySignalId = new Map<string, string>();
  for (const junction of junctions) {
    for (const movement of junction.movements) {
      for (const signalId of movement.heads) {
        if (!junctionBySignalId.has(signalId)) {
          junctionBySignalId.set(signalId, junction.junctionId);
        }
      }
    }

    const staticStates: Record<string, BehaviorSignalState> = {};
    for (const movementId of junction.staticOrder) {
      const movement = junction.movements.find((entry) => entry.movementId === movementId);
      if (movement?.staticState) staticStates[movementId] = movement.staticState;
    }
    const hasStatic = Object.keys(staticStates).length > 0;
    const cycle = junction.transitions.length > 0 ? refoldProgram(junction.transitions) : [];

    const mode: JunctionSignalPlan["mode"] =
      junction.scripted.length > 0
        ? "scripted"
        : cycle.length > 0
          ? "program"
          : hasStatic
            ? "static"
            : "map_default";
    if (mode === "map_default") continue;

    if (junction.synthesized) {
      input.diagnostics.add(
        "signal_junction_synthesized",
        "the file names signal bulbs but not the junction that owns them, so this plan was rebuilt under a synthesized junction id with one movement per bulb",
        { junctionId: junction.junctionId },
      );
    }
    if (cycle.length > 0) {
      input.diagnostics.add(
        "imported_approximation",
        `the cycle was re-folded from ${junction.transitions.length} unrolled boundary event(s); its offset and period are not recoverable, so it is imported at offset 0 with the last phase holding for ${SIGNAL_IMPORT_HOLD_TAIL_S}s`,
        { junctionId: junction.junctionId },
      );
    }

    plans.push({
      schema_version: SIGNAL_PLAN_SCHEMA_VERSION,
      junction_id: junction.junctionId,
      mode,
      movements: junction.movements.map(bindingFor),
      ...(hasStatic ? { static: staticStates } : {}),
      ...(cycle.length > 0 ? { program: { offset_s: 0, cycle } } : {}),
      ...(junction.scripted.length > 0 ? { scripted: junction.scripted } : {}),
    });
  }

  return { plans, signalIds, junctionBySignalId };
}
