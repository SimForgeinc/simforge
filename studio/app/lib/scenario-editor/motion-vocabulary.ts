/**
 * Every user-facing word for how an actor moves.
 *
 * ## Why one module
 *
 * These strings were spread across `BEHAVIOR_ACTION_LABELS`,
 * `clipActionSummary`, `behavior-lane-bands`'s own second copy of "Autopilot"
 * and "Cruise", the placement panel and the picker's blockers. A rename was a
 * grep-and-pray, and the two copies had already drifted in casing. Now the
 * dock, the strip, the panels and the tests read the same function, so a word
 * can only be changed in one place.
 *
 * ## The three layers
 *
 * An actor's motion is authored in three layers, and every word here belongs to
 * exactly one of them:
 *
 *   - **Route** — where it goes. Exactly one, always first on the timeline.
 *     `behavior-base-clip.ts` calls this the base clip.
 *   - **Interactions** — what happens to it along the way. Zero or more,
 *     scheduled, layered on top of the route.
 *   - **Reactions** — what it does about things it did not plan for. A standing
 *     `reaction_profile`, not a clip, so it can interrupt either of the above.
 *
 * A word that does not tell you which layer it belongs to is a bad word. That
 * is the whole test.
 *
 * ## Labels are not identifiers
 *
 * Nothing here changes a `BehaviorActionKind`. Those values are serialized into
 * `actor_behavior`, hashed as `actor_behavior_hash`, attested on the way back,
 * persisted in every saved draft, and read by a worker in another repository —
 * and several of them are deliberately OpenSCENARIO-aligned (`lane_offset` ↔
 * `LaneOffsetAction`), which `.xosc` import and export depend on. So the
 * identifier is the wire format and this module is the language.
 */

import type {
  BaselineChoice,
  BehaviorAction,
  BehaviorActionKind,
  ScenarioEditorActorDraft,
} from "@simcloud/shared";

/** Which layer a word is being spoken in. See the header. */
export type MotionLayer = "route" | "interaction";

/**
 * The default label for each action kind.
 *
 * Read through `actionLabel`, never directly: a few kinds mean different things
 * in the two layers and this record only carries the interaction-layer reading.
 */
const ACTION_LABELS: Record<BehaviorActionKind, string> = {
  // -- Route kinds. The six an actor can open its timeline with. ------------
  /**
   * "Autopilot" read as a feature the car has. It means the Traffic Manager
   * decides where this one goes — the author is declining to say.
   */
  autopilot: "Auto",
  /** Lane-graph anchors: points, on roads. The compiled, deterministic Auto. */
  follow_route: "Road points",
  /** The same gesture, without the lane snap. */
  follow_path: "Freeform points",
  /** Named in full, because a walker's picker sits beside a vehicle's. */
  walk_path: "Walk freeform points",
  /**
   * Not a speed setting, whatever "cruise" suggests. It is the only route where
   * our own controller keeps the lane — no Traffic Manager, no drawn points.
   * The schema already had the word: `expected_maneuver: "lane_keep"`.
   */
  cruise: "Keep lane",
  /** Overridden to "Parked" in the route layer; see the overrides below. */
  hold: "Wait",

  // -- Interaction kinds. Layered on top of whatever route is running. ------
  stop: "Stop",
  creep: "Creep",
  reverse: "Reverse",
  lane_change: "Lane change",
  lane_offset: "Lane offset",
  turn_at_next_intersection: "Turn at intersection",
  go_to: "Go to point",
  /**
   * Deliberately NOT "Freeform points", though it is the same gesture and the
   * author's own word for it. Both can sit on one actor's lane — a car whose
   * route is drawn points and whose swerve is drawn points — and two identical
   * segment labels there would be unreadable. "Divert" is the difference that
   * matters: this one LEAVES a route, and owns everything after it.
   */
  divert_path: "Divert to points",
  yield_to: "Yield to",
  follow_actor: "Follow actor",
  intercept: "Intercept",
  cut_in: "Cut in",
  avoid: "Avoid",
};

/**
 * Kinds whose label depends on the layer they are spoken in.
 *
 * Only `hold` so far, and it is the reason this function takes a layer at all:
 * as a route it is a standing property (a parked car, a prop), and as an
 * interaction it is a scheduled, temporary standstill. Same identifier, and the
 * author is doing two unrelated things.
 */
const ROUTE_LAYER_LABEL_OVERRIDES: Partial<Record<BehaviorActionKind, string>> = {
  hold: "Parked",
};

/** What to call this action, in the layer the author is looking at. */
export function actionLabel(
  kind: BehaviorActionKind,
  layer: MotionLayer = "interaction",
): string {
  if (layer === "route") {
    const override = ROUTE_LAYER_LABEL_OVERRIDES[kind];
    if (override) return override;
  }
  return ACTION_LABELS[kind];
}

export type MotionActionGroupId =
  | "longitudinal"
  | "lateral"
  | "junction"
  | "routing"
  | "interactive"
  | "handoff";

/**
 * How the picker groups the actions it offers.
 *
 * The ids are unchanged so nothing keyed on them moves; only the words did.
 * "Longitudinal" and "Lateral" are vehicle-dynamics terms nobody authoring a
 * scenario says out loud, "Routing" collided with the Route layer while
 * describing the clips that OVERRIDE it, and "Interactive" was a subgroup of
 * Interactions — a distinction with no content.
 *
 * Two groups are gone rather than renamed. "Avoidance" held exactly one action,
 * which is a category error, and it belongs with the other actions that
 * reference a second actor. "Walker" held `walk_path`, which is a route rather
 * than an interaction — the picker already filters by actor kind, so a group
 * asserting the same thing was a third place for it to be said.
 */
export const MOTION_ACTION_GROUPS: ReadonlyArray<{
  id: MotionActionGroupId;
  label: string;
  kinds: readonly BehaviorActionKind[];
}> = [
  {
    id: "longitudinal",
    label: "Speed",
    kinds: ["cruise", "stop", "creep", "reverse", "hold"],
  },
  { id: "lateral", label: "Steering", kinds: ["lane_change", "lane_offset"] },
  { id: "junction", label: "Junction", kinds: ["turn_at_next_intersection"] },
  {
    id: "routing",
    label: "Redirect",
    kinds: ["follow_route", "follow_path", "walk_path", "go_to", "divert_path"],
  },
  {
    id: "interactive",
    label: "Other actors",
    kinds: ["yield_to", "follow_actor", "intercept", "cut_in", "avoid"],
  },
  { id: "handoff", label: "Hand to Auto", kinds: ["autopilot"] },
];

export function actionGroupLabel(
  id: MotionActionGroupId,
  _layer: MotionLayer = "interaction",
): string {
  const group = MOTION_ACTION_GROUPS.find((candidate) => candidate.id === id);
  return group?.label ?? id;
}

export function speedLabel(kph: number): string {
  return `${Math.round(kph)} kph`;
}

/**
 * The text drawn inside a clip segment — the label plus whatever parameter
 * makes it identifiable at a glance.
 */
export function actionSummary(
  action: BehaviorAction,
  layer: MotionLayer = "interaction",
): string {
  const label = actionLabel(action.kind, layer);
  switch (action.kind) {
    case "cruise":
      return `${label} ${speedLabel(action.speed_kph)}`;
    case "stop":
      return label;
    case "creep":
      return `${label} ${speedLabel(action.speed_kph)}`;
    case "reverse":
      return `${label} ${speedLabel(action.speed_kph)}`;
    case "hold":
      return label;
    case "lane_change":
      return `${label} ${action.direction}`;
    case "lane_offset":
      return `${label} ${action.offset_m} m`;
    case "turn_at_next_intersection":
      return `Turn ${action.direction}`;
    case "follow_route":
      return `${label} (${action.anchors.length})`;
    case "follow_path":
      return `${label} (${action.waypoints.length})`;
    case "divert_path":
      // Either form: a relative `tail` has vertices to count just as an absolute
      // waypoint list does, and a clip carrying a tail would otherwise read "(0)".
      return `${label} (${action.tail?.length ?? action.waypoints?.length ?? 0})`;
    case "go_to":
      return label;
    case "yield_to":
      return "Yield";
    case "follow_actor":
      return label;
    case "intercept":
      return label;
    case "cut_in":
      return `${label} ${action.side}`;
    case "avoid":
      return `${label} ${action.side}`;
    case "autopilot":
      return action.enabled ? `${label} on` : `${label} off`;
    case "walk_path":
      return `${label} (${action.waypoints.length})`;
  }
}

/**
 * The route an actor is running when its program does not say — read off the
 * legacy executable fields rather than off a clip.
 *
 * The strip needs this for the stretch before the first authored clip, where
 * there is no clip to summarize. It has to agree with what
 * `baseActionForDraft` would synthesize, which is why it lives beside the
 * labels rather than next to the geometry that draws it.
 */
export function impliedRouteLabel(actor: ScenarioEditorActorDraft): string {
  if (actor.autopilot) return actionLabel("autopilot", "route");
  return `${actionLabel("cruise", "route")} ${speedLabel(actor.speed_kph)}`;
}

/**
 * The three words the baseline control shows.
 *
 * Separate from `ACTION_LABELS` because these are not action kinds: they are the
 * closed set of BASELINES an author picks between (`BaselineChoice`), and each
 * one currently lands on a legacy kind that Phase G renames. Naming them here
 * keeps the module's promise — every user-facing word for how an actor moves
 * lives in one file — through that rename, and lets the tutorial's copy test
 * quote the control instead of hardcoding it.
 */
const BASELINE_LABELS: Record<BaselineChoice, string> = {
  drive: "Drive",
  walk: "Walk",
  parked: "Parked",
};

/** What the baseline control calls a choice. */
export function baselineLabel(choice: BaselineChoice): string {
  return BASELINE_LABELS[choice];
}

/** What the card says the choice means, under the buttons. */
export function baselineDescription(choice: BaselineChoice): string {
  switch (choice) {
    case "drive":
      return "Keeps its lane and goes straight. Add clips to turn, change lane or stop.";
    case "walk":
      return "Walks its crossing.";
    case "parked":
      return "Stays where it is placed.";
  }
}
