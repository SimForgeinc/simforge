import { z } from "zod";
import { DIVERT_TAIL_MAX_M, divertTailLengthM } from "./divert-tail";
import { laneTravelIncreasesSByConvention } from "./map-topology/lane-travel";
import type {
  ScenarioEditorActorDraft,
  ScenarioEditorRoadAnchor,
  ScenarioEditorTimedWaypoint,
  TimedInstructionIntent,
  TimedInstructionPrimitiveId,
} from "./scenario-editor";

/**
 * Unified per-actor BEHAVIOR PROGRAM (plan 2026-07-24, section 3).
 *
 * One control model replaces the three that cannot compose today: legacy
 * `timeline` clips (16 actions, no UI), `timedInstructions` (9 lane-graph
 * primitives whose compiler wipes competing fields) and freeform
 * `timed_waypoints`. A program is an ordered list of clips; every clip starts
 * on a TRIGGER (a time, a spatial event, a relation to another actor, or a
 * signal state) and runs an ACTION drawn from the union of everything the
 * worker already executes.
 *
 * ## Two conventions worth stating up front
 *
 * 1. **snake_case wire fields.** The plan sketch uses camelCase
 *    (`clipId`, `conflictPolicy`). This module uses snake_case instead,
 *    matching what it is grafted onto: `ScenarioEditorTimelineClipSchema`
 *    (`start_time`, `end_time`, `target_actor_id`, `following_distance_m`),
 *    the actor draft (`speed_kph`, `is_static`, `collision_target_id`) and the
 *    Python worker, which reads these dicts straight off the spec
 *    (`state.spec.get("collision_target_id")`). Mixing cases inside one actor
 *    dict is the bigger cost. Units are carried in the field name
 *    (`_kph`, `_m`, `_s`) exactly as the draft already does.
 *
 * 2. **No runtime import of `scenario-editor.ts`.** The actor draft schema
 *    imports `ActorBehaviorProgramSchema` from here, so importing anything
 *    back at runtime would form an ES module cycle: whichever module loads
 *    first hands the other a half-initialised namespace and the zod consts
 *    blow up in their temporal dead zone. `BehaviorRoadAnchorSchema` /
 *    `BehaviorWaypointSchema` are therefore declared here as structural twins
 *    of `ScenarioEditorRoadAnchorSchema` / `ScenarioEditorTimedWaypointSchema`,
 *    and the only imports from the editor module are `import type` (erased at
 *    compile time). The twins are pinned to their originals by the
 *    compile-time assertions at the bottom of this section — drift fails
 *    `pnpm typecheck`, not a test.
 *
 * Strictness: the closed vocabularies (trigger kinds, action kinds, clip end
 * kinds) are `.strict()` so a misspelled parameter is a loud authoring error.
 * The open data shapes (points, anchors, waypoints, the clip and the program)
 * strip unknown keys instead, so a worker or generator that carries an extra
 * field does not fail the draft parse.
 */

export const ACTOR_BEHAVIOR_SCHEMA_VERSION = "simforge.actor-behavior.v1";

/** `at_time` triggers live on the same 0.1 s grid as `TimedInstructionIntent.timestampSeconds`. */
export const BEHAVIOR_TIME_QUANTUM_S = 0.1;

function isQuantizedToTimeGrid(value: number): boolean {
  // Same tolerance the timed-instruction validator uses (timed-instructions.ts:145).
  return Math.abs(value * 10 - Math.round(value * 10)) <= 1e-6;
}

/** Snap a legacy wall-clock time onto the 0.1 s authoring grid. */
export function quantizeBehaviorTimeSeconds(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Shared value shapes (structural twins of the editor's — see the header note)
// ---------------------------------------------------------------------------

export const BehaviorMapPointSchema = z.object({
  x: z.number(),
  y: z.number(),
  /** Intended elevation (world meters); disambiguates stacked geometry. */
  z: z.number().optional(),
});
export type BehaviorMapPoint = z.infer<typeof BehaviorMapPointSchema>;

/** Twin of `ScenarioEditorRoadAnchorSchema`. Keep the two in lockstep. */
export const BehaviorRoadAnchorSchema = z.object({
  road_id: z.string(),
  s_fraction: z.number().min(0).max(1).default(0.5),
  lane_id: z.number().int().nullable().optional(),
  section_id: z.number().int().nullable().optional(),
  speed_kph: z.number().min(0).nullable().optional(),
  resolution_mode: z.literal("runtime_exact").optional(),
  /** Authoritative WORLD position — the `world_anchor` doctrine applies here too. */
  world_anchor: z
    .object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
      yaw: z.number(),
    })
    .optional(),
});
export type BehaviorRoadAnchor = z.infer<typeof BehaviorRoadAnchorSchema>;

/**
 * Twin of `ScenarioEditorTimedWaypointSchema`, with `time` relaxed to optional:
 * a freeform (untimed) path carries ordering only, while a timed path carries
 * absolute seconds on every vertex.
 */
export const BehaviorWaypointSchema = BehaviorMapPointSchema.extend({
  time: z.number().min(0).optional(),
  /** Controls the segment from the previous waypoint to this one. */
  speed_kph: z.number().min(0).nullable().optional(),
  /** Controls the segment from the previous waypoint to this one. */
  direction: z.enum(["forward", "reverse"]).optional(),
});
export type BehaviorWaypoint = z.infer<typeof BehaviorWaypointSchema>;

type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

// Compile-time proof the local twins stay interchangeable with the editor's.
export type _BehaviorAnchorAcceptsEditorAnchor = Assert<
  Extends<ScenarioEditorRoadAnchor, BehaviorRoadAnchor>
>;
export type _EditorAnchorAcceptsBehaviorAnchor = Assert<
  Extends<BehaviorRoadAnchor, ScenarioEditorRoadAnchor>
>;
export type _BehaviorWaypointAcceptsEditorWaypoint = Assert<
  Extends<ScenarioEditorTimedWaypoint, BehaviorWaypoint>
>;

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/**
 * Who a trigger or action is about. `"self"` is the owning actor — the default
 * wherever it reads naturally ("when *I* reach…") — and `{actor_id}` points at
 * any other actor in the draft, generalizing today's `collision_target_id`.
 */
export const BehaviorActorRefSchema = z.union([
  z.literal("self"),
  z.object({ actor_id: z.string().trim().min(1) }).strict(),
]);
export type BehaviorActorRef = z.infer<typeof BehaviorActorRefSchema>;

export function behaviorActorRef(actorId: string): BehaviorActorRef {
  return { actor_id: actorId };
}

/**
 * A traffic-signal group. Signals are authored per junction at movement level
 * (plan section 4.3) by `JunctionSignalPlan` in `scenario-signals.ts`, and
 * `movement_id` here is exactly that module's `MovementId`
 * (`"<road>.<section>.<side>:<turn>"`) — this schema stays declared here because
 * the trigger union needs it and `scenario-signals.ts` imports from this module,
 * not the other way round.
 *
 * Resolution rules and the three reference shapes (movement / single bulb /
 * whole junction) are documented on `resolveBehaviorSignalRef`.
 */
export const BehaviorSignalRefSchema = z
  .object({
    junction_id: z.string().trim().min(1),
    /** Approach + turn movement (e.g. `"N:through"`). Omit for the whole junction. */
    movement_id: z.string().trim().min(1).optional(),
    /** A single signal head, when the author points at one bulb. */
    signal_id: z.string().trim().min(1).optional(),
  })
  .strict();
export type BehaviorSignalRef = z.infer<typeof BehaviorSignalRefSchema>;

export const BehaviorSignalStateSchema = z.enum(["red", "yellow", "green"]);
export type BehaviorSignalState = z.infer<typeof BehaviorSignalStateSchema>;

// ---------------------------------------------------------------------------
// Triggers (plan 3.1) — one member per ScenarioRunner 1.0 condition we author to
// ---------------------------------------------------------------------------

export const BEHAVIOR_TRIGGER_KINDS = [
  "at_time",
  "after_clip",
  "reach",
  "proximity",
  "ttc",
  "headway",
  "speed",
  "standstill",
  "signal_state",
] as const;
export const BehaviorTriggerKindSchema = z.enum(BEHAVIOR_TRIGGER_KINDS);
export type BehaviorTriggerKind = z.infer<typeof BehaviorTriggerKindSchema>;

/** OSC `SimulationTimeCondition`. */
export const AtTimeTriggerSchema = z
  .object({
    kind: z.literal("at_time"),
    t: z
      .number()
      .min(0)
      .refine(isQuantizedToTimeGrid, {
        message: `t must be quantized to ${BEHAVIOR_TIME_QUANTUM_S}s`,
      }),
  })
  .strict();

/** OSC `StoryboardElementStateCondition` (endOfStoryboardElement + delay). */
export const AfterClipTriggerSchema = z
  .object({
    kind: z.literal("after_clip"),
    clip_id: z.string().trim().min(1),
    /** Seconds after the referenced clip ends. Not grid-quantized: the clip's own end is not. */
    delay_s: z.number().min(0).optional(),
  })
  .strict();

/** OSC `ReachPositionCondition`. */
export const ReachTriggerSchema = z
  .object({
    kind: z.literal("reach"),
    point: BehaviorMapPointSchema,
    radius_m: z.number().positive(),
    actor: BehaviorActorRefSchema.default("self"),
  })
  .strict();

/** OSC `RelativeDistanceCondition`. */
export const ProximityTriggerSchema = z
  .object({
    kind: z.literal("proximity"),
    other: BehaviorActorRefSchema,
    distance_m: z.number().positive(),
    mode: z.enum(["closer", "farther"]).default("closer"),
    /** The measured-from actor; the plan's sketch fixes this to self. */
    actor: BehaviorActorRefSchema.default("self"),
  })
  .strict();

/** OSC `TimeToCollisionCondition`. */
export const TtcTriggerSchema = z
  .object({
    kind: z.literal("ttc"),
    other: BehaviorActorRefSchema,
    seconds: z.number().positive(),
    actor: BehaviorActorRefSchema.default("self"),
  })
  .strict();

/** OSC `TimeHeadwayCondition`. */
export const HeadwayTriggerSchema = z
  .object({
    kind: z.literal("headway"),
    other: BehaviorActorRefSchema,
    seconds: z.number().positive(),
    actor: BehaviorActorRefSchema.default("self"),
  })
  .strict();

/** OSC `SpeedCondition`. */
export const SpeedTriggerSchema = z
  .object({
    kind: z.literal("speed"),
    kph: z.number().min(0),
    rule: z.enum(["above", "below"]),
    actor: BehaviorActorRefSchema.default("self"),
  })
  .strict();

/** OSC `StandStillCondition`. */
export const StandstillTriggerSchema = z
  .object({
    kind: z.literal("standstill"),
    seconds: z.number().positive(),
    actor: BehaviorActorRefSchema.default("self"),
  })
  .strict();

/** OSC `TrafficSignalCondition`. */
export const SignalStateTriggerSchema = z
  .object({
    kind: z.literal("signal_state"),
    signal: BehaviorSignalRefSchema,
    state: BehaviorSignalStateSchema,
  })
  .strict();

export const BehaviorTriggerSchema = z.discriminatedUnion("kind", [
  AtTimeTriggerSchema,
  AfterClipTriggerSchema,
  ReachTriggerSchema,
  ProximityTriggerSchema,
  TtcTriggerSchema,
  HeadwayTriggerSchema,
  SpeedTriggerSchema,
  StandstillTriggerSchema,
  SignalStateTriggerSchema,
]);
export type BehaviorTrigger = z.infer<typeof BehaviorTriggerSchema>;

export const DEFAULT_BEHAVIOR_TRIGGER: BehaviorTrigger = { kind: "at_time", t: 0 };

// ---------------------------------------------------------------------------
// Actions (plan 3.2)
// ---------------------------------------------------------------------------

export const BEHAVIOR_ACTION_KINDS = [
  // Longitudinal
  "cruise",
  "stop",
  "creep",
  "reverse",
  "hold",
  // Lateral
  "lane_change",
  "lane_offset",
  // Junction
  "turn_at_next_intersection",
  // Routing
  "follow_route",
  "follow_path",
  "go_to",
  "divert_path",
  // Interactive
  "yield_to",
  "follow_actor",
  "intercept",
  "cut_in",
  // Avoidance
  "avoid",
  // Handoff
  "autopilot",
  // Walker
  "walk_path",
] as const;
export const BehaviorActionKindSchema = z.enum(BEHAVIOR_ACTION_KINDS);
export type BehaviorActionKind = z.infer<typeof BehaviorActionKindSchema>;

/**
 * Route actions whose geometry is stored on the actor itself. They can only
 * serve as the actor's base clip, never as a later interaction.
 */
export const ACTOR_ROUTE_ACTION_KINDS = [
  "follow_route",
  "follow_path",
  "walk_path",
] as const satisfies readonly BehaviorActionKind[];

/** Worker defaults preserved verbatim from `actor_control.py` so migration is faithful. */
export const LEGACY_CREEP_SPEED_KPH = 5;
export const LEGACY_REVERSE_SPEED_KPH = 10;
export const LEGACY_FOLLOWING_DISTANCE_M = 5;
export const LEGACY_STOP_DECEL_WINDOW_S = 3;

/** Steady lane-keeping at a target speed. OSC `SpeedAction`. */
export const CruiseActionSchema = z
  .object({
    kind: z.literal("cruise"),
    speed_kph: z.number().min(0),
  })
  .strict();

/**
 * Controlled deceleration to a standstill. OSC `SpeedAction` to 0 with shaped
 * dynamics. `decel_window_s` is the worker's existing ramp knob
 * (`decel_window_seconds` on legacy clips, `brakingWindowSeconds` on legacy
 * instructions); `deceleration_mps2` is the OSC-native alternative.
 */
export const StopActionSchema = z
  .object({
    kind: z.literal("stop"),
    decel_window_s: z.number().positive().optional(),
    deceleration_mps2: z.number().positive().optional(),
  })
  .strict();

/** Crawl forward. OSC `SpeedAction` at a low target. */
export const CreepActionSchema = z
  .object({
    kind: z.literal("creep"),
    speed_kph: z.number().min(0).default(LEGACY_CREEP_SPEED_KPH),
  })
  .strict();

/** Back up. `distance_m` ends the maneuver spatially (the clip `end` cannot). */
export const ReverseActionSchema = z
  .object({
    kind: z.literal("reverse"),
    speed_kph: z.number().min(0).default(LEGACY_REVERSE_SPEED_KPH),
    distance_m: z.number().positive().optional(),
  })
  .strict();

/**
 * Stand still under the brake. Deliberately parameterless: how long is the
 * clip's `end`, so the two can never disagree. OSC `StandStill` via speed 0.
 */
export const HoldActionSchema = z
  .object({
    kind: z.literal("hold"),
  })
  .strict();

/** OSC `LaneChangeAction`. */
export const LaneChangeActionSchema = z
  .object({
    kind: z.literal("lane_change"),
    direction: z.enum(["left", "right"]),
    transition_m: z.number().positive().optional(),
  })
  .strict();

/**
 * Lateral nudge within the lane — the authored, parameterized replacement for
 * the legacy constant-steer `swerve`. Positive `offset_m` is LEFT of the lane
 * centerline AS THE ACTOR DRIVES IT, which is what both runtimes implement.
 *
 * That is NOT the frame OSC's `LaneOffsetAction` uses — see `laneFrameSign`,
 * which converts between them. Calling this the "OSC road-frame convention"
 * (as this comment once did) is what produced the exporter mirroring bug.
 */
export const LaneOffsetActionSchema = z
  .object({
    kind: z.literal("lane_offset"),
    offset_m: z.number(),
    transition_m: z.number().positive().optional(),
    /** Auto-return to lane center this many seconds after the offset is reached. */
    return_after_s: z.number().positive().optional(),
  })
  .strict();

/**
 * Sign converting a TRAVEL-relative lateral value to the lane REFERENCE-LINE
 * frame, and back — it is its own inverse.
 *
 * Every lateral value in this schema is relative to the way the actor drives:
 * `offset_m` positive is the driver's left, `lane_change`/`cut_in` `side:
 * "left"` is the driver's left. OpenSCENARIO expresses both against the lane
 * reference line, and OpenDRIVE's left-side convention runs positive-id lanes
 * AGAINST +s. On those lanes the frames are mirror images.
 *
 * Measured (esmini v3.1.0, Munich_Phase_1A, actor on lane +2): an authored
 * +1.2 m emitted unchanged executed 1.2 m to the driver's RIGHT, and a
 * `cut_in` authored to the left moved the actor away from its target and across
 * the road centre line onto lane -1.
 *
 * Lane-id sign is a property of the MAP, not the scenario: Belmont stores
 * 342/342 positive-id driving lanes against travel, Munich 195/195, and 0/194
 * and 0/344 of their negative-id lanes. So this is a convention conversion, not
 * a per-map calibration.
 */
export function laneFrameSign(laneId: number | null | undefined): 1 | -1 {
  return laneTravelIncreasesSByConvention(laneId) ? 1 : -1;
}

/** OSC route via `AssignRouteAction` / `FollowTrajectoryAction`. */
export const TurnAtNextIntersectionActionSchema = z
  .object({
    kind: z.literal("turn_at_next_intersection"),
    // `u_turn` is here because the corpus contains one (E6) and the one-motion
    // model has nowhere else to put it: `deriveRunway` already routes the intent
    // and `fitRunwayTurns` already recovers it at 0.00 m residual, so without it
    // in the clip vocabulary a u-turn can only be said as the out-and-back anchor
    // pair §2.2 deletes. Spelled with an underscore to match `RunwayTurnIntent`,
    // which is what an authored direction is handed to.
    direction: z.enum(["left", "right", "straight", "u_turn"]),
  })
  .strict();

/** Road-anchored route. Anchor cap is 32 (plan 4.2 raises the editor's 5). */
export const BEHAVIOR_ROUTE_ANCHOR_CAP = 32;
export const FollowRouteActionSchema = z
  .object({
    kind: z.literal("follow_route"),
    anchors: z.array(BehaviorRoadAnchorSchema).min(1).max(BEHAVIOR_ROUTE_ANCHOR_CAP),
    speed_kph: z.number().min(0).optional(),
  })
  .strict();

/**
 * Freeform world-space path. `timed: true` means the waypoint `time` values are
 * a real schedule to interpolate (today's `timed_path`); `timed: false` means
 * ordering only (today's `path`). OSC `FollowTrajectoryAction`.
 */
export const FollowPathActionSchema = z
  .object({
    kind: z.literal("follow_path"),
    waypoints: z.array(BehaviorWaypointSchema).min(1),
    timed: z.boolean().default(false),
    speed_kph: z.number().min(0).optional(),
  })
  .strict();

/**
 * Leave the route mid-run and trace a line the author drew. OSC
 * `FollowTrajectoryAction`, issued partway through the story rather than at the
 * start of it.
 *
 * The three ways this differs from `follow_path`, all deliberate:
 *
 * - **The waypoints are the CLIP's.** `follow_path` may only restate the actor's
 *   own placement — the worker rejects anything else — because it IS the route.
 *   These are new geometry that did not exist before the clip fired.
 * - **No `speed_kph`.** The base clip already answered "how fast", and a path
 *   decides WHERE. A second opinion here is a conflict with no tiebreak, so the
 *   field is absent rather than optional.
 * - **No `timed`.** A schedule is a contract about arrival times solved at
 *   generation time; this fires off a trigger, so there is no generation-time
 *   moment at which those times could be solved.
 *
 * `anchor_from_actor` is not a field because it cannot be one: the first point
 * is wherever the actor IS when the clip fires, which only the runtime knows.
 * The editor draws from its predicted position; the runtime prepends its real
 * one. The authored waypoints are the rest of the line.
 *
 * Terminal by construction. Nothing defines a way back onto the lane graph, so
 * the picker refuses to add a clip after one — see `timeline-model`.
 */
/**
 * One tail vertex, in the actor's own frame at trigger time.
 *
 * `forward_m` along the heading, `lateral_m` to the LEFT — the same handedness as
 * `lane_offset`, so "positive is left" means one thing across the vocabulary.
 */
export const DivertTailPointSchema = z
  .object({
    forward_m: z.number(),
    lateral_m: z.number(),
    /** Controls the segment from the previous vertex to this one. */
    speed_kph: z.number().min(0).nullable().optional(),
    direction: z.enum(["forward", "reverse"]).optional(),
  })
  .strict();

/**
 * Leave the lane for a short tail, then rejoin or end held.
 *
 * `tail` is the target shape (§2.3): authored relative to the pose at trigger, so
 * it survives cross-map transfer, which an absolute polyline never can.
 * `waypoints` is the absolute form the corpus still carries and is accepted until
 * the 21 `carries_own_path` actors are converted.
 *
 * "Exactly one of the two" and the tail length cap are enforced on the CLIP, not
 * here — see the note on `FollowActorActionSchema`: an action that `superRefine`s
 * becomes a `ZodEffects` and can no longer sit inside a discriminated union, which
 * costs the whole vocabulary its exhaustiveness checking.
 */
export const DivertPathActionSchema = z
  .object({
    kind: z.literal("divert_path"),
    waypoints: z.array(BehaviorWaypointSchema).min(1).optional(),
    tail: z.array(DivertTailPointSchema).min(1).optional(),
    /**
     * What happens at the end of the tail.
     *
     * Absent means `end_clip`: the car is left where the tail put it, which is
     * what a divert does today. Optional rather than defaulted so the field's
     * arrival changes no existing CONSTRUCTOR — a `.default()` makes the key
     * required in the output type, which would force every place that builds a
     * divert clip to name a value it has no opinion about.
     */
    rejoin: z.enum(["nearest_lane", "end_clip"]).optional(),
  })
  .strict();

/** Drive to a single world point. OSC `AcquirePositionAction`. */
export const GoToActionSchema = z
  .object({
    kind: z.literal("go_to"),
    point: BehaviorMapPointSchema,
    speed_kph: z.number().min(0).optional(),
  })
  .strict();

/** Give way to another actor, stopping if it is inside `gap_m`. */
export const YieldToActionSchema = z
  .object({
    kind: z.literal("yield_to"),
    actor: BehaviorActorRefSchema,
    gap_m: z.number().positive().default(LEGACY_FOLLOWING_DISTANCE_M),
    max_wait_s: z.number().positive().optional(),
  })
  .strict();

/**
 * Civilised chase: track another actor at a headway (preferred) or a fixed
 * distance (what the legacy `chase_actor` clip carried). At least one of the
 * two must be present — enforced on the clip, not here, so the action stays a
 * ZodObject and remains usable inside the discriminated union.
 */
export const FollowActorActionSchema = z
  .object({
    kind: z.literal("follow_actor"),
    actor: BehaviorActorRefSchema,
    headway_s: z.number().positive().optional(),
    distance_m: z.number().positive().optional(),
    max_speed_kph: z.number().min(0).optional(),
  })
  .strict();

/** Today's `ram_actor`: drive at another actor, no following gap. */
export const InterceptActionSchema = z
  .object({
    kind: z.literal("intercept"),
    actor: BehaviorActorRefSchema,
    speed_kph: z.number().min(0).optional(),
  })
  .strict();

/** Lane change relative to a target actor. OSC `LaneChangeAction` + trigger. */
export const CutInActionSchema = z
  .object({
    kind: z.literal("cut_in"),
    actor: BehaviorActorRefSchema,
    side: z.enum(["left", "right"]),
    gap_m: z.number().positive().optional(),
    transition_m: z.number().positive().optional(),
  })
  .strict();

/** Swerve around an obstacle and return to lane. Composed from lane_offset at runtime. */
export const AvoidActionSchema = z
  .object({
    kind: z.literal("avoid"),
    target: BehaviorActorRefSchema,
    side: z.enum(["left", "right"]),
    clearance_m: z.number().positive(),
  })
  .strict();

/**
 * Hand control to / take it back from the Traffic Manager.
 *
 * `speed_kph` is the TM's desired speed, and it lives here for the same reason
 * `cruise`'s does: speed is motion, and motion is authored on the clip. It used
 * to be reachable only as `draft.speed_kph` through the actor panel's speed
 * slider — a second authoring surface for a value the baseline owns. The worker
 * still reads it off the actor spec (`spawn_actor_helpers.py`
 * `_apply_tm_speed_target`), which `placementFieldsFromBaseClip` writes, so this
 * is an editor-side move only.
 *
 * Optional because a program authored before the field existed simply has no
 * opinion, and `undefined` must keep meaning "whatever the actor already had"
 * rather than 0 kph — which is a car that never moves.
 */
export const AutopilotActionSchema = z
  .object({
    kind: z.literal("autopilot"),
    enabled: z.boolean(),
    speed_kph: z.number().min(0).optional(),
  })
  .strict();

/**
 * Walker path. The plan's `cross_when(trigger)` is NOT a separate action: it is
 * exactly this action carried by a non-`at_time` trigger (typically
 * `proximity` to the ego), which is what the hardcoded walker-conflict trigger
 * in `actor_control.py:_maintain_walker_conflict_trigger` does today. Modelling
 * it as a composite keeps one crossing implementation and lets any trigger arm
 * a crossing. See `crossWhenClip()`.
 */
export const WalkPathActionSchema = z
  .object({
    kind: z.literal("walk_path"),
    waypoints: z.array(BehaviorWaypointSchema).min(1),
    speed_kph: z.number().min(0).optional(),
  })
  .strict();

export const BehaviorActionSchema = z.discriminatedUnion("kind", [
  CruiseActionSchema,
  StopActionSchema,
  CreepActionSchema,
  ReverseActionSchema,
  HoldActionSchema,
  LaneChangeActionSchema,
  LaneOffsetActionSchema,
  TurnAtNextIntersectionActionSchema,
  FollowRouteActionSchema,
  FollowPathActionSchema,
  DivertPathActionSchema,
  GoToActionSchema,
  YieldToActionSchema,
  FollowActorActionSchema,
  InterceptActionSchema,
  CutInActionSchema,
  AvoidActionSchema,
  AutopilotActionSchema,
  WalkPathActionSchema,
]);
export type BehaviorAction = z.infer<typeof BehaviorActionSchema>;

// ---------------------------------------------------------------------------
// Clips and the program
// ---------------------------------------------------------------------------

/**
 * Which completion, for an action whose native reading has none.
 *
 * Most actions know when they are done (`stop` has stopped, `lane_change` has
 * changed lane) and `{kind: "completion"}` asks that question. A `cruise` does
 * not: our reading is "hold this speed until something else commands one", so a
 * cruise on `completion` runs until it is superseded — which is what the
 * editor's own `+` clip means and must keep meaning.
 *
 * OpenSCENARIO reads the same maneuver differently: a `SpeedAction` COMPLETES
 * when the vehicle reaches the target, and esmini ends the event there, so an
 * event chained after it runs. `on: "target_speed"` carries that reading, and
 * only the .xosc importer sets it — see `xosc-import/index.ts`, loss 7.
 */
export const BEHAVIOR_CLIP_END_ON_TARGET_SPEED = "target_speed";

export const BehaviorClipEndSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("duration"), seconds: z.number().positive() }).strict(),
  z.object({ kind: z.literal("until_trigger"), trigger: BehaviorTriggerSchema }).strict(),
  /** Maneuver-defined end: the action runs until it completes (the default). */
  z
    .object({
      kind: z.literal("completion"),
      on: z.literal(BEHAVIOR_CLIP_END_ON_TARGET_SPEED).optional(),
    })
    .strict(),
]);
export type BehaviorClipEnd = z.infer<typeof BehaviorClipEndSchema>;

export const DEFAULT_BEHAVIOR_CLIP_END: BehaviorClipEnd = { kind: "completion" };

/** Export fidelity, computed by the writer and cached on the clip for the dock badge. */
export const BehaviorFidelitySchema = z.enum(["faithful", "approximated", "captured_only"]);
export type BehaviorFidelity = z.infer<typeof BehaviorFidelitySchema>;

export const BehaviorClipRoleSchema = z.enum(["base", "interaction"]);
export type BehaviorClipRole = z.infer<typeof BehaviorClipRoleSchema>;

export const BehaviorClipSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().optional(),
    enabled: z.boolean().default(true),
    /** Authoring-side identity; stripped before clips enter the runtime payload. */
    role: BehaviorClipRoleSchema.optional(),
    trigger: BehaviorTriggerSchema.default(DEFAULT_BEHAVIOR_TRIGGER),
    end: BehaviorClipEndSchema.default(DEFAULT_BEHAVIOR_CLIP_END),
    action: BehaviorActionSchema,
    fidelity: BehaviorFidelitySchema.optional(),
  })
  .superRefine((clip, ctx) => {
    if (
      clip.action.kind === "follow_actor" &&
      clip.action.headway_s == null &&
      clip.action.distance_m == null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "follow_actor requires headway_s or distance_m",
      });
    }
    if (clip.action.kind === "divert_path") {
      const hasWaypoints = (clip.action.waypoints?.length ?? 0) > 0;
      const hasTail = (clip.action.tail?.length ?? 0) > 0;
      if (hasWaypoints === hasTail) {
        // Both is as wrong as neither: whichever form the executor happened to
        // prefer would silently become the answer and the other would be a drawn
        // path that does nothing.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["action", "tail"],
          message: hasTail
            ? "divert_path carries both `tail` and `waypoints`; it must carry exactly one"
            : "divert_path needs a `tail` (relative, preferred) or `waypoints` (absolute)",
        });
      } else if (hasTail) {
        // The cap is §2.3's design statement made enforceable: a tail is a
        // departure from a route, not a route. It applies only to `tail` because
        // capping the legacy absolute form retroactively would fail-closed on
        // scenarios that already work — that is a migration decision, not a
        // schema one.
        const lengthM = divertTailLengthM(clip.action.tail!);
        if (lengthM > DIVERT_TAIL_MAX_M) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["action", "tail"],
            message:
              `divert tail runs ${lengthM.toFixed(1)} m along the path, beyond the ` +
              `${DIVERT_TAIL_MAX_M} m a tail may be. A tail is a departure from a route, not a route.`,
          });
        }
      }
    }
    if (clip.trigger.kind === "after_clip" && clip.trigger.clip_id === clip.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trigger", "clip_id"],
        message: "after_clip cannot reference its own clip",
      });
    }
  });
export type BehaviorClip = z.infer<typeof BehaviorClipSchema>;

/**
 * The per-actor program. `conflict_policy` is fixed at `"overwrite"` — OSC
 * `Event` priority `overwrite`, i.e. a later clip taking the same control
 * channel supersedes the running one. The literal is a schema field rather
 * than an implicit rule so the day a second policy exists, drafts written
 * today keep meaning what they meant.
 */
export const ActorBehaviorProgramSchema = z
  .object({
    schema_version: z.literal(ACTOR_BEHAVIOR_SCHEMA_VERSION).default(ACTOR_BEHAVIOR_SCHEMA_VERSION),
    clips: z.array(BehaviorClipSchema).default([]),
    conflict_policy: z.literal("overwrite").default("overwrite"),
  })
  .superRefine((program, ctx) => {
    const baseIndexes = program.clips.flatMap((clip, index) =>
      clip.role === "base" ? [index] : [],
    );
    for (const index of baseIndexes.slice(1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clips", index, "role"],
        message: 'At most one clip may have role "base".',
      });
    }

    program.clips.forEach((clip, index) => {
      if (
        clip.role !== "interaction" ||
        !(ACTOR_ROUTE_ACTION_KINDS as readonly BehaviorActionKind[]).includes(
          clip.action.kind,
        )
      ) {
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clips", index, "action", "kind"],
        message: `${clip.action.kind} is a route, not an interaction: its waypoints live on the actor, so it is only legal as the base clip.`,
      });
    });
  });
export type ActorBehaviorProgram = z.infer<typeof ActorBehaviorProgramSchema>;

export function emptyActorBehaviorProgram(): ActorBehaviorProgram {
  return {
    schema_version: ACTOR_BEHAVIOR_SCHEMA_VERSION,
    clips: [],
    conflict_policy: "overwrite",
  };
}

/**
 * `cross_when(trigger)` sugar: a walker crossing armed by a condition instead
 * of a wall clock. Sugar only — the result is an ordinary `walk_path` clip.
 */
export function crossWhenClip(args: {
  id: string;
  trigger: BehaviorTrigger;
  waypoints: BehaviorWaypoint[];
  speed_kph?: number;
  label?: string;
}): BehaviorClip {
  return {
    id: args.id,
    ...(args.label === undefined ? {} : { label: args.label }),
    enabled: true,
    trigger: args.trigger,
    end: { kind: "completion" },
    action: {
      kind: "walk_path",
      waypoints: args.waypoints,
      ...(args.speed_kph === undefined ? {} : { speed_kph: args.speed_kph }),
    },
  };
}

// ---------------------------------------------------------------------------
// Reaction profile (ACTOR-level, not a clip)
// ---------------------------------------------------------------------------

/**
 * The actor's reactive safety layer — one authored knob generalizing today's
 * per-actor booleans `reactive_braking` (full obstacle scan) and `anti_plow`
 * (worker-only, stopped-vehicles-only scan).
 *
 * It is an actor field, not a clip, because it is a standing property of the
 * actor rather than a scheduled maneuver: it must be able to interrupt
 * whatever clip is running (plan 7.3 — the reactive layer outranks clips
 * unless the clip is `intercept`).
 *
 * `exempt_actor_ids` carries today's `collision_target_id` semantics: brake for
 * everything EXCEPT these actors (pursuit obstacle scan skips them and the
 * Traffic Manager gets a per-pair `collision_detection(ego, target, False)`).
 */
export const ReactionProfileModeSchema = z.enum(["none", "brake", "brake_and_swerve"]);
export type ReactionProfileMode = z.infer<typeof ReactionProfileModeSchema>;

export const DEFAULT_REACTION_AGGRESSIVENESS = 0.5;

export const ReactionProfileSchema = z
  .object({
    mode: ReactionProfileModeSchema,
    /** Scales the bounded lateral swerve offset: 0 = minimum, 1 = maximum. */
    aggressiveness: z.number().min(0).max(1).default(DEFAULT_REACTION_AGGRESSIVENESS),
    /** Actors this one is ALLOWED to hit — the intended conflict. */
    exempt_actor_ids: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();
export type ReactionProfile = z.infer<typeof ReactionProfileSchema>;

// ---------------------------------------------------------------------------
// Legacy → behavior mapping tables (plan 3.3)
// ---------------------------------------------------------------------------

/**
 * Distance at which a migrated conflict walker is released to cross. The legacy
 * mechanism is not a fixed distance at all — it solves
 * `ego_distance <= ego_speed * (walk_time + lead)` every tick — so this is the
 * plan's authored stand-in (section 4.4's worked example uses 15 m), not a
 * conversion. Re-authoring the exact release is a phase-2 trigger-evaluator
 * concern.
 */
export const LEGACY_WALKER_CONFLICT_TRIGGER_DISTANCE_M = 15;

/** Approximated metric offset for the legacy constant-steer `swerve` action. */
export const LEGACY_SWERVE_OFFSET_M = -1;

// ---------------------------------------------------------------------------
// Migration (plan 3.3)
// ---------------------------------------------------------------------------

export interface ActorBehaviorMigrationContext {
  /**
   * The other actors in the same draft. Needed only to reconstruct the walker
   * conflict trigger, which is expressed on the EGO (`collision_target_id`)
   * but must become a trigger on the WALKER. Omit it and a conflict walker
   * migrates to a plain time-triggered crossing — its authored schedule.
   */
  actors?: readonly ScenarioEditorActorDraft[];
}

export interface ActorBehaviorMigrationResult {
  behavior: ActorBehaviorProgram;
  /** `null` when the actor carries no reactive flags and no collision pair. */
  reaction_profile: ReactionProfile | null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Loose reads of the legacy authored keys the schema no longer declares.
 *
 * The migrate* functions accept BOTH shapes: a raw stored record still carrying
 * the keys top-level (the load path, pre-strip) and a runtime/wire actor whose
 * boundary expansion re-materialized them. Deliberately tolerant rather than
 * parsed through the versioned legacy schema: the preview engine feeds these
 * functions arbitrary spec dicts and has always ignored malformed entries
 * rather than thrown. Strictness lives at the load boundary
 * (`readLegacyActorMotion` in `migrateLegacyScenarioEditorActor`'s caller).
 */
function legacyRecordOf(draft: ScenarioEditorActorDraft): Record<string, unknown> {
  return draft as unknown as Record<string, unknown>;
}

function legacyTimelineOf(draft: ScenarioEditorActorDraft): Record<string, unknown>[] {
  const raw = legacyRecordOf(draft).timeline;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === "object" && !Array.isArray(entry),
  );
}

function legacyTimedInstructionIntentsOf(
  draft: ScenarioEditorActorDraft,
): TimedInstructionIntent[] {
  const raw = legacyRecordOf(draft).timedInstructions as
    | { intent?: unknown }
    | undefined;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.intent)) return [];
  return raw.intent as TimedInstructionIntent[];
}

function legacyCollisionTargetIdOf(
  draft: ScenarioEditorActorDraft,
): string | undefined {
  const record = legacyRecordOf(draft);
  const direct = record.collision_target_id;
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  const envelope = record.legacy_wire as { collision_target_id?: unknown } | undefined;
  const fromEnvelope =
    envelope && typeof envelope === "object" ? envelope.collision_target_id : undefined;
  return typeof fromEnvelope === "string" && fromEnvelope.trim().length > 0
    ? fromEnvelope.trim()
    : undefined;
}

function legacyReactionFlagOf(
  draft: ScenarioEditorActorDraft,
  key: "reactive_braking" | "anti_plow",
): boolean {
  const record = legacyRecordOf(draft);
  if (record[key] === true) return true;
  const envelope = record.legacy_wire as Record<string, unknown> | undefined;
  return !!envelope && typeof envelope === "object" && envelope[key] === true;
}

function readPositive(value: unknown): number | undefined {
  const parsed = readNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function clipEndFromLegacySpan(startTime: number, endTime: unknown): BehaviorClipEnd {
  const end = readNumber(endTime);
  if (end === undefined) return { kind: "completion" };
  const seconds = Math.round((end - startTime) * 1000) / 1000;
  if (seconds <= 0) return { kind: "completion" };
  return { kind: "duration", seconds };
}

function actionFromLegacyTimelineClip(
  clip: Record<string, unknown>,
  draft: ScenarioEditorActorDraft,
): BehaviorAction {
  const action = String(clip.action ?? "");
  const targetSpeedKph = readNumber(clip.target_speed_kph);
  const targetActorId =
    typeof clip.target_actor_id === "string" && clip.target_actor_id.trim().length > 0
      ? clip.target_actor_id.trim()
      : undefined;
  const followingDistanceM = readPositive(clip.following_distance_m);
  const fallbackCruise: BehaviorAction = {
    kind: "cruise",
    speed_kph: targetSpeedKph ?? draft.speed_kph,
  };

  switch (action) {
    case "follow_route": {
      const anchors = (draft.route ?? []).slice(0, BEHAVIOR_ROUTE_ANCHOR_CAP);
      if (anchors.length === 0) return fallbackCruise;
      return {
        kind: "follow_route",
        anchors,
        ...(targetSpeedKph === undefined ? {} : { speed_kph: targetSpeedKph }),
      };
    }
    case "set_speed":
      return fallbackCruise;
    case "stop": {
      const decelWindowS = readPositive(clip.decel_window_seconds);
      return {
        kind: "stop",
        ...(decelWindowS === undefined ? {} : { decel_window_s: decelWindowS }),
      };
    }
    case "hold_position":
      return { kind: "hold" };
    case "enable_autopilot":
      return { kind: "autopilot", enabled: true };
    case "disable_autopilot":
      return { kind: "autopilot", enabled: false };
    case "lane_change_left":
      return { kind: "lane_change", direction: "left" };
    case "lane_change_right":
      return { kind: "lane_change", direction: "right" };
    case "turn_left_at_next_intersection":
      return { kind: "turn_at_next_intersection", direction: "left" };
    case "turn_right_at_next_intersection":
      return { kind: "turn_at_next_intersection", direction: "right" };
    case "chase_actor": {
      if (!targetActorId) return fallbackCruise;
      return {
        kind: "follow_actor",
        actor: behaviorActorRef(targetActorId),
        distance_m: followingDistanceM ?? LEGACY_FOLLOWING_DISTANCE_M,
        ...(targetSpeedKph === undefined ? {} : { max_speed_kph: targetSpeedKph }),
      };
    }
    case "ram_actor": {
      if (!targetActorId) return fallbackCruise;
      return {
        kind: "intercept",
        actor: behaviorActorRef(targetActorId),
        ...(targetSpeedKph === undefined ? {} : { speed_kph: targetSpeedKph }),
      };
    }
    case "yield_to_actor": {
      if (!targetActorId) return fallbackCruise;
      return {
        kind: "yield_to",
        actor: behaviorActorRef(targetActorId),
        gap_m: followingDistanceM ?? LEGACY_FOLLOWING_DISTANCE_M,
      };
    }
    case "drive_reverse":
      return { kind: "reverse", speed_kph: targetSpeedKph ?? LEGACY_REVERSE_SPEED_KPH };
    case "creep_forward":
      return { kind: "creep", speed_kph: targetSpeedKph ?? LEGACY_CREEP_SPEED_KPH };
    case "swerve":
      return { kind: "lane_offset", offset_m: LEGACY_SWERVE_OFFSET_M };
    default:
      // Unknown legacy action: the worker logs "Unsupported timeline action
      // ignored" and does nothing, so migrate it to the actor's own cruise
      // rather than inventing a maneuver.
      return fallbackCruise;
  }
}

function actionFromLegacyInstruction(
  primitiveId: TimedInstructionPrimitiveId,
  args: Record<string, unknown>,
  draft: ScenarioEditorActorDraft,
): BehaviorAction {
  const speedKph = readNumber(args.speedKph);
  switch (primitiveId) {
    case "lane_follow":
    case "set_speed":
      return { kind: "cruise", speed_kph: speedKph ?? draft.speed_kph };
    case "turn_left_at_next_intersection":
      return { kind: "turn_at_next_intersection", direction: "left" };
    case "turn_right_at_next_intersection":
      return { kind: "turn_at_next_intersection", direction: "right" };
    case "go_straight_at_next_intersection":
      return { kind: "turn_at_next_intersection", direction: "straight" };
    case "lane_change_left":
    case "lane_change_right": {
      const transitionM = readPositive(args.transitionMeters);
      return {
        kind: "lane_change",
        direction: primitiveId === "lane_change_left" ? "left" : "right",
        ...(transitionM === undefined ? {} : { transition_m: transitionM }),
      };
    }
    case "stop": {
      const decelWindowS = readPositive(args.brakingWindowSeconds);
      return {
        kind: "stop",
        ...(decelWindowS === undefined ? {} : { decel_window_s: decelWindowS }),
      };
    }
    case "hold_position":
      return { kind: "hold" };
  }
}

/** The ego that declared THIS actor as its intended conflict, if any. */
function conflictEgoFor(
  draft: ScenarioEditorActorDraft,
  context: ActorBehaviorMigrationContext | undefined,
): ScenarioEditorActorDraft | undefined {
  if (!context?.actors) return undefined;
  return context.actors.find(
    (candidate) =>
      candidate.id !== draft.id && legacyCollisionTargetIdOf(candidate) === draft.id,
  );
}

function uniqueClipId(used: Set<string>, candidate: string): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let suffix = 2;
  while (used.has(`${candidate}#${suffix}`)) suffix += 1;
  const id = `${candidate}#${suffix}`;
  used.add(id);
  return id;
}

/**
 * Migrate one legacy actor draft to a behavior program (plan 3.3).
 *
 * Pure and non-destructive: the draft is only read. The legacy keys are gone
 * from the actor schema (schema-prune, wave 2b), so they are read LOOSELY off
 * the record — this function accepts both a raw stored record still carrying
 * them and a runtime actor whose boundary expansion re-materialized them.
 * Stripping is the caller's job (`migrateLegacyScenarioEditorActor`).
 *
 * Clip order is legacy `timeline` (verbatim) → `timedInstructions` rows (by
 * timestamp, then `rowOrder`) → the single path clip. Clip ids are preserved
 * from their legacy source so `after_clip` references and undo history stay
 * stable; collisions get a `#n` suffix.
 */
export function migrateActorDraftToBehaviorProgram(
  draft: ScenarioEditorActorDraft,
  context?: ActorBehaviorMigrationContext,
): ActorBehaviorProgram {
  const clips: BehaviorClip[] = [];
  const usedIds = new Set<string>();

  for (const [index, clip] of legacyTimelineOf(draft).entries()) {
    const startTime = quantizeBehaviorTimeSeconds(readNumber(clip.start_time) ?? 0);
    const id = uniqueClipId(
      usedIds,
      typeof clip.id === "string" && clip.id.trim().length > 0
        ? clip.id.trim()
        : `bhv_timeline_${index}`,
    );
    clips.push({
      id,
      enabled: clip.enabled !== false,
      trigger: { kind: "at_time", t: startTime },
      end: clipEndFromLegacySpan(startTime, clip.end_time),
      action: actionFromLegacyTimelineClip(clip, draft),
    });
  }

  const intents = [...legacyTimedInstructionIntentsOf(draft)].sort(
    (left, right) =>
      left.timestampSeconds - right.timestampSeconds || left.rowOrder - right.rowOrder,
  );
  for (const [index, intent] of intents.entries()) {
    const startTime = quantizeBehaviorTimeSeconds(intent.timestampSeconds);
    const durationSeconds = readPositive(intent.args?.durationSeconds);
    const id = uniqueClipId(usedIds, intent.id || `bhv_instruction_${index}`);
    clips.push({
      id,
      enabled: intent.enabled !== false,
      trigger: { kind: "at_time", t: startTime },
      end:
        durationSeconds === undefined
          ? { kind: "completion" }
          : { kind: "duration", seconds: durationSeconds },
      action: actionFromLegacyInstruction(
        intent.primitiveId,
        (intent.args ?? {}) as Record<string, unknown>,
        draft,
      ),
    });
  }

  const waypoints = draft.timed_waypoints ?? [];
  if (waypoints.length > 0) {
    const id = uniqueClipId(usedIds, `bhv_path_${draft.id}`);
    const conflictEgo = draft.kind === "walker" ? conflictEgoFor(draft, context) : undefined;
    const trigger: BehaviorTrigger = conflictEgo
      ? {
          kind: "proximity",
          actor: "self",
          other: behaviorActorRef(conflictEgo.id),
          distance_m: LEGACY_WALKER_CONFLICT_TRIGGER_DISTANCE_M,
          mode: "closer",
        }
      : { kind: "at_time", t: 0 };

    clips.push(
      draft.kind === "walker"
        ? crossWhenClip({ id, trigger, waypoints: [...waypoints], speed_kph: draft.speed_kph })
        : {
            id,
            enabled: true,
            trigger,
            end: { kind: "completion" },
            action: {
              kind: "follow_path",
              waypoints: [...waypoints],
              timed: draft.placement_mode === "timed_path",
            },
          },
    );
  }

  return {
    schema_version: ACTOR_BEHAVIOR_SCHEMA_VERSION,
    clips,
    conflict_policy: "overwrite",
  };
}

/**
 * Derive the actor-level reaction profile from the legacy per-actor booleans.
 *
 * - `reactive_braking: true` → `mode: "brake"`.
 * - `anti_plow: true` (worker-only legacy flag) → `mode: "brake"`. The
 *   narrower stopped-vehicles-only scan is NOT representable as a mode; the
 *   flag is preserved in the migration's `legacy_wire` envelope and re-emitted
 *   on the wire (`expandLegacyWireActor`), where the worker's
 *   `anti_plow_enabled` still reads it — so nothing is lost and no new wire
 *   field exists.
 * - `collision_target_id` → `exempt_actor_ids`. It never meant "chase this
 *   actor" — it means "brake for everyone except this one" (pursuit obstacle
 *   scan skip + Traffic Manager per-pair `collision_detection(…, False)`), so
 *   it migrates to the exemption list, not to an `intercept` clip. Authored
 *   ramming still comes from the legacy `ram_actor` timeline action.
 * - A collision pair with no braking flag yields `mode: "none"` plus the
 *   exemption: the TM pair-disable applies to TM-driven actors whose braking
 *   is not an authored knob at all.
 *
 * Returns `null` when the actor carries none of the three.
 */
export function migrateActorDraftReactionProfile(
  draft: ScenarioEditorActorDraft,
): ReactionProfile | null {
  const reactiveBraking = legacyReactionFlagOf(draft, "reactive_braking");
  const antiPlow = legacyReactionFlagOf(draft, "anti_plow");
  const targetId = legacyCollisionTargetIdOf(draft);
  const exemptActorIds = targetId ? [targetId] : [];

  if (!reactiveBraking && !antiPlow && exemptActorIds.length === 0) return null;

  return {
    mode: reactiveBraking || antiPlow ? "brake" : "none",
    aggressiveness: DEFAULT_REACTION_AGGRESSIVENESS,
    exempt_actor_ids: exemptActorIds,
  };
}

/**
 * Whole-actor migration: the behavior program plus the actor-level reaction
 * profile. Returns a patch for the draft; it never mutates its input.
 */
export function migrateActorDraft(
  draft: ScenarioEditorActorDraft,
  context?: ActorBehaviorMigrationContext,
): ActorBehaviorMigrationResult {
  return {
    behavior: migrateActorDraftToBehaviorProgram(draft, context),
    reaction_profile: migrateActorDraftReactionProfile(draft),
  };
}

// ---------------------------------------------------------------------------
// Resolved firing events (worker → editor, additive)
// ---------------------------------------------------------------------------

/**
 * A condition trigger's RESOLVED firing time, reported by the worker in the
 * preview timeline artifact's additive `behavior_events` array.
 *
 * A condition-triggered clip has no authored start — the dock draws it armed at
 * t=0. After a preview run these events say when each one actually fired, which
 * the dock overlays as a ghost marker on the owning actor's lane.
 *
 * Deliberately NOT `.strict()`, unlike every other schema in this module: these
 * come off a worker artifact rather than out of our own editor, so a worker that
 * ships a new field must not invalidate the whole array for an older web build.
 * Unknown keys are stripped. `kind` is an open string for the same reason — the
 * editor only distinguishes `trigger_fired` today and ignores kinds it does not
 * know.
 */
/**
 * The trigger's condition evaluated true. Emitted for EVERY armed clip that
 * fires on a tick — including clips that then lose their control channel to a
 * later-declared one, so a `trigger_fired` without a matching
 * `clip_started` means "your condition fired but something else was driving".
 */
export const BEHAVIOR_EVENT_TRIGGER_FIRED = "trigger_fired";
/** The clip actually took its control channel and began running. */
export const BEHAVIOR_EVENT_CLIP_STARTED = "clip_started";
/** The clip released its channel — on its duration, its `until_trigger`, or preemption. */
export const BEHAVIOR_EVENT_CLIP_ENDED = "clip_ended";

export const BehaviorEventSchema = z.object({
  actor_id: z.string().trim().min(1),
  clip_id: z.string().trim().min(1),
  kind: z.string().trim().min(1),
  /** Seconds from the start of the run. */
  t: z.number().min(0),
});
export type BehaviorEvent = z.infer<typeof BehaviorEventSchema>;

/**
 * Read a `behavior_events` array off an arbitrary artifact body.
 *
 * Absent, malformed, or not-an-array input yields `[]` — the ghost-marker
 * feature is additive, so a worker that predates it (or a partly-written
 * artifact) must degrade to "no markers" rather than failing the playback load
 * that carries it. Individual malformed entries are dropped for the same reason.
 */
export function readBehaviorEvents(input: unknown): BehaviorEvent[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const raw = (input as Record<string, unknown>).behavior_events;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = BehaviorEventSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}
