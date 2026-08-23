/**
 * The timeline: triggers, the seven verbs, dynamics.
 *
 * Per `docs/research/interactions-and-edge-cases.md` §The interaction model, the
 * atomic unit is `{actor, trigger, verb, target, dynamics?, until?}` and the
 * governing rule is **one axis, one owner; later preempts earlier**. There are
 * no priorities and no nesting — that is the esmini lesson: action-level
 * replacement beats event priority, because priority semantics are only
 * comprehensible to the person who wrote the spec.
 *
 * ## Why `verb` is a discriminant, not a name
 *
 * `target` and `dynamics` are siblings of `verb` in the emitted JSON (that is
 * the shape the research fixed and the shape an LLM emits), but their *types*
 * depend on the verb, so the schema is a discriminated union on `verb`. A
 * `speed` target and a `changeLane` target can therefore never be confused, and
 * the JSON Schema published for constrained decoding narrows the whole object
 * the moment the model emits the verb token.
 *
 * ## Dynamics
 *
 * `{shape, constraint, value}` — uniform across the four continuous verbs. It is
 * marked optional here and **required by the structural validator** rather than
 * by zod, deliberately: a missing `dynamics` is the single most common
 * LLM-authoring mistake, and a repair loop can act on
 * `{code: 'dynamics_required', path: 'choreography.interactions.3'}` where it
 * cannot act on a union-discrimination failure. Same reasoning for `byLatest`.
 *
 * ## Conditions are shallow
 *
 * `and` / `or` / `not` take *leaf* conditions only. Arbitrary nesting reads
 * fine and is a nightmare to explain in a timeline UI, to solve for, and to
 * validate; one level covers every condition in the taxonomy.
 */

import { z } from 'zod';

import { NumberOrExprSchema } from '../../expr/index.js';
import { TurnDirectionSchema } from './anchor.js';
import {
  ActorRefSchema,
  FeatureRefSchema,
  InteractionIdSchema,
  InteractionRefSchema,
  RoleRefSchema,
} from './common.js';
import { FramePoseSchema, SceneAbsoluteInitialRouteSchema } from './roles.js';
import { SetValueSchema } from './set-keys.js';

/** Comparison operators available to threshold conditions. */
export const COMPARE_OPS = ['<', '<=', '>', '>='] as const;
/** A threshold comparison. */
export const CompareOpSchema = z.enum(COMPARE_OPS);

/** Signal phases a condition can wait for. */
export const SIGNAL_PHASES = [
  'green',
  'yellow',
  'red',
  'flashing_yellow',
  'flashing_red',
  'off',
  'green_arrow',
  'yellow_arrow',
  'red_x',
  'proceed',
  'stop',
] as const;
/** A signal phase. */
export const SignalPhaseSchema = z.enum(SIGNAL_PHASES);

/** Reference to a traffic signal: a map handle, or a junction feature + approach. */
export const SignalApproachSchema = z.union([
  z.enum(['subject', 'opposing', 'left', 'right']),
  // Already-persisted documents used `ego`; accept it only at the read boundary.
  z.literal('ego').transform(() => 'subject' as const),
]);
/** The junction arm a signal is read from, after the legacy spelling is normalized. */
export type SignalApproach = z.output<typeof SignalApproachSchema>;
export const SignalRefSchema = z.union([
  z.strictObject({ handle: z.string().min(1).max(200) }),
  z.strictObject({ feature: FeatureRefSchema, approach: SignalApproachSchema }),
  z.strictObject({ control: z.string().min(1).max(128) }),
]);

/** A point a condition can be measured against. */
export const PointRefSchema = z.union([
  z.strictObject({ role: RoleRefSchema }),
  z.strictObject({ feature: FeatureRefSchema, at: z.enum(['entry', 'center', 'exit']).default('entry') }),
  z.strictObject({ pose: FramePoseSchema }),
]);

/** Distance between two things, along the lane or straight-line. */
export const DistanceConditionSchema = z.strictObject({
  kind: z.literal('distance'),
  from: RoleRefSchema,
  to: PointRefSchema,
  measure: z.enum(['alongLane', 'euclidean']).default('alongLane'),
  op: CompareOpSchema,
  valueM: NumberOrExprSchema,
  /**
   * Optional dead-band around the threshold. A proximity trigger enters only
   * after crossing `valueM - hysteresisM` (`<=`) or `valueM + hysteresisM`
   * (`>=`). This prevents placement/float jitter at the boundary from choosing
   * a different trigger tick in preview and playback.
   */
  hysteresisM: NumberOrExprSchema.optional(),
});

/** Time to collision between two actors. The critical band is 1.2–2.5 s. */
export const TtcConditionSchema = z.strictObject({
  kind: z.literal('ttc'),
  of: RoleRefSchema,
  to: RoleRefSchema,
  op: CompareOpSchema,
  valueS: NumberOrExprSchema,
});

/** Time headway (gap / speed), the car-following measure. */
export const HeadwayConditionSchema = z.strictObject({
  kind: z.literal('headway'),
  of: RoleRefSchema,
  to: RoleRefSchema,
  op: CompareOpSchema,
  valueS: NumberOrExprSchema,
});

/** An actor reaches a place. */
export const ReachesConditionSchema = z.strictObject({
  kind: z.literal('reaches'),
  of: RoleRefSchema,
  region: PointRefSchema,
  /** Tolerance radius, metres. */
  toleranceM: NumberOrExprSchema.optional(),
});

/** An actor's speed crosses a threshold. */
export const SpeedConditionSchema = z.strictObject({
  kind: z.literal('speed'),
  of: RoleRefSchema,
  op: CompareOpSchema,
  valueKph: NumberOrExprSchema,
});

/** A traffic signal is in a phase (optionally for a minimum duration). */
export const SignalConditionSchema = z.strictObject({
  kind: z.literal('signal'),
  signal: SignalRefSchema,
  phase: SignalPhaseSchema,
  minDurationS: NumberOrExprSchema.optional(),
});

/**
 * Line of sight. The occlusion-aware condition — the one that makes
 * "step out when the driver cannot see you yet" expressible.
 */
export const VisibleConditionSchema = z.strictObject({
  kind: z.literal('visible'),
  of: RoleRefSchema,
  to: RoleRefSchema,
  visible: z.boolean().default(true),
  /** Fraction of the target's silhouette that must be unoccluded, 0..1. */
  minFraction: z.number().min(0).max(1).optional(),
});

/**
 * The *perception* counterpart of `visible`.
 *
 * `visible` is pure plan-view geometry and is unaffected by weather: it answers
 * "is anything in the way". `detected` asks the observer's declared sensor
 * suite instead, so an actor in clear line of sight but lost in fog, glare or
 * darkness reads `false`. That difference is what makes "the ego cannot see the
 * pedestrian it is looking straight at" expressible.
 *
 * Omitting `sensor` takes the suite's best opinion, which is what a fused stack
 * reports; naming one grades a single modality.
 */
export const DetectedConditionSchema = z.strictObject({
  kind: z.literal('detected'),
  of: RoleRefSchema,
  by: RoleRefSchema,
  /** Sensor id on `by`. Omitted means any of its sensors. */
  sensor: z.string().min(1).max(128).optional(),
  detected: z.boolean().default(true),
});

/** An actor has been stationary for a while. */
export const StandstillConditionSchema = z.strictObject({
  kind: z.literal('standstill'),
  of: RoleRefSchema,
  forS: NumberOrExprSchema,
});

/** A collision involving an actor. */
export const CollisionConditionSchema = z.strictObject({
  kind: z.literal('collision'),
  of: RoleRefSchema,
  with: z.union([RoleRefSchema, z.literal('any')]).default('any'),
});

/** Every non-logical condition. */
export const LeafConditionSchema = z.discriminatedUnion('kind', [
  DistanceConditionSchema,
  TtcConditionSchema,
  HeadwayConditionSchema,
  ReachesConditionSchema,
  SpeedConditionSchema,
  SignalConditionSchema,
  VisibleConditionSchema,
  DetectedConditionSchema,
  StandstillConditionSchema,
  CollisionConditionSchema,
]);

/** `and`/`or` over leaf conditions. One level only — see the module docs. */
export const LogicalConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('and'),
    operands: z.array(LeafConditionSchema).min(2).max(8),
  }),
  z.strictObject({
    kind: z.literal('or'),
    operands: z.array(LeafConditionSchema).min(2).max(8),
  }),
  z.strictObject({ kind: z.literal('not'), operand: LeafConditionSchema }),
]);

/** Any condition. */
export const ConditionSchema = z.union([LeafConditionSchema, LogicalConditionSchema]);

/** Fire at a wall-clock time on the clip timeline (t = 0 is the first recorded frame). */
export const AtTriggerSchema = z.strictObject({
  kind: z.literal('at'),
  /** Seconds. Negative values reach into the unrecorded warm-up. */
  t: NumberOrExprSchema,
});

/** Fire relative to another interaction. */
export const AfterTriggerSchema = z.strictObject({
  kind: z.literal('after'),
  of: InteractionRefSchema,
  /** Which end of the referenced interaction to measure from. */
  event: z.enum(['start', 'end']).default('start'),
  delayS: NumberOrExprSchema.default(0),
});

/**
 * Fire when a condition holds.
 *
 * `byLatest` is the deadline: a condition that never becomes true is a silent
 * bug, so every `when` must say by when it expects to fire and what to do if it
 * does not (`skip` the interaction, or `fire` it anyway at the deadline).
 */
export const WhenTriggerSchema = z.strictObject({
  kind: z.literal('when'),
  condition: ConditionSchema,
  /**
   * Deadline in seconds on the clip timeline. Structurally required — see the
   * module docs for why it is not a zod requirement.
   */
  byLatest: NumberOrExprSchema.optional(),
  ifNever: z.enum(['skip', 'fire']).default('skip'),
});

/**
 * The arrival solver — back-solve the start so `of` reaches `at` at a declared
 * criticality relative to `syncWith`.
 *
 * Without this, roughly four out of five generated scenarios are trivially
 * non-critical: the challenger is simply somewhere else when the ego arrives.
 * Exactly one of `ttc` / `deltaT` must be given; `ttc` is the criticality band
 * (1.2–2.5 s is where interesting things happen), `deltaT` the arrival offset.
 */
export const ArrivalTriggerSchema = z
  .strictObject({
    kind: z.literal('arrival'),
    of: RoleRefSchema,
    /** The conflict point / feature both actors are heading for. */
    at: PointRefSchema,
    syncWith: RoleRefSchema,
    ttc: NumberOrExprSchema.optional(),
    deltaT: NumberOrExprSchema.optional(),
  })
  .check((ctx) => {
    const { ttc, deltaT } = ctx.value;
    if ((ttc === undefined) === (deltaT === undefined)) {
      ctx.issues.push({
        code: 'custom',
        message: 'arrival needs exactly one of `ttc` or `deltaT`',
        path: [],
        input: ctx.value,
      });
    }
  });

/** Any trigger. */
export const TriggerSchema = z.discriminatedUnion('kind', [
  AtTriggerSchema,
  AfterTriggerSchema,
  WhenTriggerSchema,
  ArrivalTriggerSchema,
]);

/** Interpolation shape of a continuous change. */
export const DYNAMICS_SHAPES = ['step', 'linear', 'sinusoidal', 'cubic'] as const;
/** How the change is bounded: by rate, by duration, or by distance travelled. */
export const DYNAMICS_CONSTRAINTS = ['rate', 'time', 'distance'] as const;

/**
 * Uniform dynamics for continuous verbs.
 *
 * `constraint: 'rate'` with `shape: 'linear'` on a `changeLane` is exactly
 * UN R157's lateral-velocity parameterisation (0.3–1.5 m/s), which is why this
 * one shape covers cut-ins as well as it covers braking profiles.
 */
export const DynamicsSchema = z.strictObject({
  shape: z.enum(DYNAMICS_SHAPES),
  constraint: z.enum(DYNAMICS_CONSTRAINTS),
  /** Rate (unit/s), seconds, or metres, depending on `constraint`. */
  value: NumberOrExprSchema,
});

/** Driver intent used to shape a lateral manoeuvre independently of its clip. */
export const MANEUVER_STYLES = ['cautious', 'normal', 'assertive'] as const;
export const ManeuverStyleSchema = z.enum(MANEUVER_STYLES);
const lateralManeuverFields = {
  /** Physical target duration; the timeline clip remains only an eligibility window. */
  maneuverDurationS: NumberOrExprSchema.optional(),
  maneuverStyle: ManeuverStyleSchema.optional(),
};

/** What a `speed` interaction aims for. */
export const SpeedTargetSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('absolute'), valueKph: NumberOrExprSchema }),
  z.strictObject({ mode: z.literal('delta'), deltaKph: NumberOrExprSchema }),
  z.strictObject({ mode: z.literal('factor'), factor: NumberOrExprSchema }),
  z.strictObject({
    mode: z.literal('match'),
    role: RoleRefSchema,
    offsetKph: NumberOrExprSchema.optional(),
  }),
  z.strictObject({ mode: z.literal('stop') }),
  /** Return to whatever the actor's speed was before the last `speed` action. */
  z.strictObject({ mode: z.literal('resume') }),
]);

/** What a `gap` interaction holds. */
export const GapTargetSchema = z.strictObject({
  role: RoleRefSchema,
  value: NumberOrExprSchema,
  unit: z.enum(['time', 'distance']),
});

/** Which lane a `changeLane` moves to. */
export const LaneTargetSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('relative'), dk: z.number().int().min(-4).max(4) }),
  z.strictObject({ mode: z.literal('absolute'), k: z.number().int().min(-8).max(8) }),
  z.strictObject({ mode: z.literal('toRole'), role: RoleRefSchema }),
]);

/** Where a `laneOffset` puts the actor within its lane. */
export const LaneOffsetTargetSchema = z.strictObject({
  /** Fraction of lane width from the reference, −1..1. */
  tFrac: NumberOrExprSchema,
  reference: z.enum(['lane_center', 'lane_edge_left', 'lane_edge_right']).default('lane_center'),
});

/** Where a `route` interaction sends the actor. */
export const RouteTargetSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('turn'), feature: FeatureRefSchema, turn: TurnDirectionSchema }),
  /** Map-bound editor intent: choose this direction at the next junction at runtime. */
  z.strictObject({ mode: z.literal('nextJunction'), turn: z.enum(['straight', 'left', 'right']) }),
  z.strictObject({ mode: z.literal('toFeature'), feature: FeatureRefSchema }),
  z.strictObject({
    mode: z.literal('crossing'),
    feature: FeatureRefSchema,
    fromFrac: z.number().min(0).max(1).default(0),
    toFrac: z.number().min(0).max(1).default(1),
  }),
  /** Frame-relative polyline: jaywalking, work-zone weaves, parking manoeuvres. */
  z.strictObject({ mode: z.literal('polyline'), points: z.array(FramePoseSchema).min(2).max(32) }),
  /** Exact scene-space points authored against a pinned map revision. */
  z.strictObject({
    mode: z.literal('customRoute'),
    /**
     * One point is a complete route: the actor stands there. Time is not a
     * factor here, so a second copy of the same point would say nothing extra.
     */
    points: z.array(z.strictObject({
      x: z.number().finite(),
      z: z.number().finite(),
    })).min(1).max(128),
  }),
  /**
   * Exact scene-space keyframes. Unlike `customRoute`, time owns motion: the
   * actor is linearly interpolated between these positions and its inherent
   * cruise speed and longitudinal commands are ignored until contact occurs.
   */
  z.strictObject({
    mode: z.literal('customTimedRoute'),
    /**
     * One keyframe is a complete route: the actor holds that spot for the whole
     * clip. Repeated positions at later times are meaningful here — unlike
     * `customRoute`, they are how an author writes a dwell.
     */
    points: z.array(z.strictObject({
      timeS: z.number().finite().min(0),
      x: z.number().finite(),
      z: z.number().finite(),
    })).min(1).max(1024),
  }),
  /**
   * Exact map-bound lane chain authored by Studio placement. This target is
   * only portable together with scene_absolute roles and deliberately retains
   * the concrete directed-road choice for deterministic save/reopen playback.
   */
  SceneAbsoluteInitialRouteSchema,
  /** Drive to a specific pose and stop being routed. */
  z.strictObject({ mode: z.literal('acquire'), pose: FramePoseSchema }),
  /**
   * Re-solved, contact-free pedestrian crossing intent. Unlike a baked
   * polyline this stays valid when the target route/speed or site changes.
   */
  z.strictObject({
    mode: z.literal('nearMiss'),
    target: RoleRefSchema,
    clearanceM: NumberOrExprSchema.default(0.5),
    pass: z.enum(['front', 'behind', 'auto']).default('auto'),
    minSpeedKph: NumberOrExprSchema.default(1.8),
    maxSpeedKph: NumberOrExprSchema.default(10.8),
    deadlineS: NumberOrExprSchema.optional(),
  }),
]);

/** Existence target. Teleports are only expressible as `absent` → `present`. */
export const ExistTargetSchema = z.strictObject({ state: z.enum(['present', 'absent']) });

/** A typed discrete-state assignment; `key` is checked against the registry. */
export const SetTargetSchema = z.strictObject({
  key: z.string().min(1).max(200),
  value: SetValueSchema,
});

const interactionBase = {
  id: InteractionIdSchema,
  /** The role that performs it, or `@world` for `env.*` / `signal:*` sets. */
  actor: ActorRefSchema,
  trigger: TriggerSchema,
  /** When the action stops owning its axis. Absent = until preempted or clip end. */
  until: TriggerSchema.optional(),
  label: z.string().max(200).optional(),
};

/** Longitudinal: accelerate, brake, stop, creep, resume. */
export const SpeedInteractionSchema = z.strictObject({
  ...interactionBase,
  verb: z.literal('speed'),
  target: SpeedTargetSchema,
  dynamics: DynamicsSchema.optional(),
});

/** Longitudinal: follow at a gap (car-following, ACC, tailgating, queues). */
export const GapInteractionSchema = z.strictObject({
  ...interactionBase,
  verb: z.literal('gap'),
  target: GapTargetSchema,
  dynamics: DynamicsSchema.optional(),
});

/** Lateral: cut-in, cut-out, merge, overtake leg, swerve. */
export const ChangeLaneInteractionSchema = z.strictObject({
  ...interactionBase,
  verb: z.literal('changeLane'),
  target: LaneTargetSchema,
  dynamics: DynamicsSchema.optional(),
  ...lateralManeuverFields,
});

/** Lateral: drift, encroachment, partial blockage, edge-riding. */
export const LaneOffsetInteractionSchema = z.strictObject({
  ...interactionBase,
  verb: z.literal('laneOffset'),
  target: LaneOffsetTargetSchema,
  dynamics: DynamicsSchema.optional(),
  ...lateralManeuverFields,
});

/** Topology: turns, paths, crossings, jaywalk polylines. */
export const RouteInteractionSchema = z.strictObject({
  ...interactionBase,
  verb: z.literal('route'),
  target: RouteTargetSchema,
});

/** Existence: spawn and despawn, visible on the timeline. */
export const ExistInteractionSchema = z.strictObject({
  ...interactionBase,
  verb: z.literal('exist'),
  target: ExistTargetSchema,
});

/** Discrete state: rules, lights, doors, articulated pose, signals, environment. */
export const SetInteractionSchema = z.strictObject({
  ...interactionBase,
  verb: z.literal('set'),
  target: SetTargetSchema,
});

/** Any interaction. */
export const InteractionSchema = z.discriminatedUnion('verb', [
  SpeedInteractionSchema,
  GapInteractionSchema,
  ChangeLaneInteractionSchema,
  LaneOffsetInteractionSchema,
  RouteInteractionSchema,
  ExistInteractionSchema,
  SetInteractionSchema,
]);

/** The seven verbs. */
export const VERBS = [
  'speed',
  'gap',
  'changeLane',
  'laneOffset',
  'route',
  'exist',
  'set',
] as const;
/** A verb name. */
export type Verb = (typeof VERBS)[number];

/** Verbs that describe a continuous change and therefore require `dynamics`. */
export const CONTINUOUS_VERBS: readonly Verb[] = ['speed', 'gap', 'changeLane', 'laneOffset'];

/** The five control axes. `state:<key>` is one axis per settable key. */
export type Axis = 'longitudinal' | 'lateral' | 'topology' | 'existence' | `state:${string}`;

/** Which axis an interaction owns while it is active. */
export function interactionAxis(interaction: Interaction): Axis {
  switch (interaction.verb) {
    case 'speed':
    case 'gap':
      return 'longitudinal';
    case 'changeLane':
    case 'laneOffset':
      return 'lateral';
    case 'route':
      return 'topology';
    case 'exist':
      return 'existence';
    case 'set':
      return `state:${interaction.target.key}`;
  }
}

/** The clip timeline block. */
export const ChoreographySchema = z.strictObject({
  /**
   * Recorded clip length in seconds. 20 s is the research default, not a
   * quality floor: compact mechanisms may use a three-second clip when they
   * still carry pre-event, reveal/conflict, and stable-aftermath evidence.
   * The unrecorded warm-up lets actors reach speed instead of appearing at
   * 60 kph from a standstill.
   */
  clipSeconds: z.number().min(3).max(120).default(20),
  /** Unrecorded warm-up length, seconds. Triggers may fire from `-warmupSeconds`. */
  warmupSeconds: z.number().min(0).max(30).default(5),
  interactions: z.array(InteractionSchema).max(256).default([]),
});

/** An interaction. */
export type Interaction = z.infer<typeof InteractionSchema>;
/** An interaction as authored. */
export type InteractionInput = z.input<typeof InteractionSchema>;
/** Any trigger. */
export type Trigger = z.infer<typeof TriggerSchema>;
/** Any condition. */
export type Condition = z.infer<typeof ConditionSchema>;
/** A leaf (non-logical) condition. */
export type LeafCondition = z.infer<typeof LeafConditionSchema>;
/** Uniform dynamics. */
export type Dynamics = z.infer<typeof DynamicsSchema>;
/** The timeline block. */
export type Choreography = z.infer<typeof ChoreographySchema>;
/** A reference to a measurable point. */
export type PointRef = z.infer<typeof PointRefSchema>;
/** A reference to a traffic signal. */
export type SignalRef = z.infer<typeof SignalRefSchema>;

/** Leaf conditions inside a condition, flattened (shallow by construction). */
export function conditionLeaves(condition: Condition): LeafCondition[] {
  if (condition.kind === 'and' || condition.kind === 'or') return [...condition.operands];
  if (condition.kind === 'not') return [condition.operand];
  return [condition];
}
