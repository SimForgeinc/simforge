/**
 * `SimScenarioInput` — the engine's stable input contract.
 *
 * This is a **fully resolved concrete scenario**: no logical anchors, no
 * parameter references, no expressions, no map queries. Every actor already has
 * a pose, a route and numeric behaviour rules; every trigger already has
 * numeric thresholds. Producing one of these from a `ScenarioTemplate` v2 (site
 * match + parameter draw + expression evaluation) is the *adapter's* job and
 * lives in another package — this seam is what the adapter targets.
 *
 * The vocabulary mirrors `docs/research/interactions-and-edge-cases.md`
 * exactly: seven verbs over five axes, one uniform `dynamics` shape, and
 * `at | after | when` triggers (plus the pre-solved `arrival` form).
 *
 * Coordinates in this file are **scene frame** (`{x, z}`, y-up) — see
 * `src/frames.ts`.
 */

import { z } from 'zod';

import { SURFACE_KINDS } from '../environment.js';
// Perception is defined in its own module and imported *into* the input
// contract, never the other way round, so there is no schema cycle.
import { perceptionConfigSchema, simSensorSchema } from '../perception/schema.js';

/* ------------------------------------------------------------------ basics */

const finite = z.number().finite();
const nonNeg = finite.min(0);
const positive = finite.gt(0);

export const CONTROL_INDICATIONS = [
  'green', 'yellow', 'red', 'flashing_yellow', 'flashing_red', 'off',
  'green_arrow', 'yellow_arrow', 'red_x', 'proceed', 'stop',
  // Flashing arrows are the indications that change *turn* logic rather than
  // through logic: a flashing yellow arrow is the permissive left, and a
  // flashing red arrow is the stop-then-turn. Reversible-lane heads use the
  // same two. Without them a permissive-left conflict has to be faked with a
  // plain `flashing_yellow` on a head that is supposed to be an arrow.
  'flashing_yellow_arrow', 'flashing_red_arrow',
] as const;
export const controlIndicationSchema = z.enum(CONTROL_INDICATIONS);
export type ControlIndication = z.infer<typeof controlIndicationSchema>;

/** An `id` used to reference actors, interactions, signals and occluders. */
export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/, 'id must be a printable reference token');

/** A ground-plane point in the scene frame. */
export const scenePointSchema = z.object({ x: finite, z: finite });
export type ScenePoint = z.infer<typeof scenePointSchema>;

/** A lane reference: `rsl` = `road:section:lane`, `s` = arc length along it. */
export const laneRefSchema = z.object({
  rsl: z.string().min(1),
  s: nonNeg,
  /** Lateral offset as a fraction of local lane width; 0 = centreline. */
  tFrac: finite.min(-2).max(2).default(0),
});
export type LaneRef = z.infer<typeof laneRefSchema>;

export const poseSchema = z.object({ x: finite, z: finite, headingRad: finite });
export type Pose = z.infer<typeof poseSchema>;

export const dimsSchema = z.object({ l: positive, w: positive, h: positive });
export type Dims = z.infer<typeof dimsSchema>;

/* ---------------------------------------------------------------- dynamics */

/**
 * The uniform dynamics descriptor. Mandatory on every shaped verb — never
 * defaulted, per the research doc's LLM-generation rules.
 *
 * - `rate`: m/s² for `speed`/`gap`, m/s lateral velocity for `changeLane`/
 *   `laneOffset` (this is R157's lateral-velocity parameterisation).
 * - `time`: seconds to complete the transition.
 * - `distance`: metres of longitudinal travel over which to complete it.
 */
export const dynamicsSchema = z.object({
  shape: z.enum(['step', 'linear', 'sinusoidal', 'cubic']),
  constraint: z.enum(['rate', 'time', 'distance']),
  value: positive,
});
export type Dynamics = z.infer<typeof dynamicsSchema>;

/* ------------------------------------------------------------------ routes */

export const turnRelationSchema = z.enum([
  'Straight',
  'Left',
  'Right',
  'UTurnLeft',
  'UTurnRight',
]);
export type TurnRelation = z.infer<typeof turnRelationSchema>;

/**
 * How an actor's path through the network is specified.
 *
 * - `lanePath` — an explicit ordered lane chain. Fully deterministic; what
 *   adapters should emit once a site is bound.
 * - `follow` — walk successors from a start lane, taking the listed turns at
 *   junctions (missing entries fall back to `Straight`, then to the
 *   lowest-`rsl` gate). Useful for hand-authored fixtures.
 * - `polyline` — an explicit ground path in scene coordinates. The pedestrian
 *   escape hatch (crossings, jaywalk diagonals); vehicles may use it too but
 *   then have no lane identity in the trace.
 * - `timedPolyline` — exact scene-space position constraints. Time, rather
 *   than cruise speed, owns the actor through the final authored timestamp;
 *   normal physics takes over and brakes immediately afterward (or on
 *   material contact).
 */
export const routeSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('lanePath'),
    lanes: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal('follow'),
    startRsl: z.string().min(1),
    turns: z.array(turnRelationSchema).default([]),
    maxLengthM: positive.default(2000),
  }),
  z.object({
    kind: z.literal('polyline'),
    /** A single point is a zero-length route: the actor stays where it is. */
    points: z.array(scenePointSchema).min(1),
  }),
  z.object({
    kind: z.literal('timedPolyline'),
    /** A single keyframe holds the actor on that spot for the whole clip. */
    points: z.array(z.object({
      timeS: nonNeg,
      x: finite,
      z: finite,
    })).min(1),
  }),
]);
export type RouteSpec = z.infer<typeof routeSpecSchema>;

/** A route command resolved against the actor's live lane when it fires. */
export const nextJunctionRouteTargetSchema = z.object({
  kind: z.literal('nextJunction'),
  turn: turnRelationSchema,
  maxLengthM: positive.default(2000),
});
export const routeActionTargetSchema = z.union([routeSpecSchema, nextJunctionRouteTargetSchema]);
export type RouteActionTarget = z.infer<typeof routeActionTargetSchema>;

/* ------------------------------------------------------------------- rules */

/**
 * The discrete behaviour switches. `collisionAvoidance: false` is the
 * make-or-break flag from the research doc — it disables the safety governor so
 * a challenger actually commits instead of chickening out.
 */
export const actorRulesSchema = z.object({
  obeySignals: z.boolean().default(true),
  /** Legacy master switch retained for input compatibility. */
  yield: z.boolean().default(true),
  /** Yield to conflicting road users other than pedestrians/animals. */
  yieldToVehicles: z.boolean().default(true),
  /** Yield to pedestrians and animals in crossing conflicts. */
  yieldToPedestrians: z.boolean().default(true),
  collisionAvoidance: z.boolean().default(true),
  /** 0 = timid, 1 = aggressive. Scales accepted gaps and comfort decel. */
  aggression: finite.min(0).max(1).default(0.5),
  /** Multiplier on the lane speed limit for free-flow cruising. */
  speedFactor: finite.min(0).max(3).default(1),
});
export type ActorRules = z.infer<typeof actorRulesSchema>;

/* ------------------------------------------------------------------ actors */

/**
 * Semantic actor identity used by simulation, traces, and renderers.
 *
 * `vehicle` is retained as the backwards-compatible generic kind. New
 * materializers should prefer the concrete class whenever it is known.
 */
export const ACTOR_KINDS = [
  'vehicle',
  'car',
  'truck',
  'bus',
  'van',
  'motorcycle',
  'bicycle',
  'pedestrian',
  'scooter',
  'sidewalk_robot',
  'drone',
  'animal',
  'static_object',
] as const;
export const actorKindSchema = z.enum(ACTOR_KINDS);
export type ActorKind = z.infer<typeof actorKindSchema>;

/** Engine-owned defaults allow direct inputs to omit dimensions without
 * depending on the authoring-layer scenario-model package. */
export const DEFAULT_ACTOR_DIMS: Readonly<Record<ActorKind, Dims>> = {
  vehicle: { l: 4.8, w: 1.9, h: 1.5 },
  car: { l: 4.8, w: 1.9, h: 1.5 },
  truck: { l: 9.5, w: 2.5, h: 3.5 },
  bus: { l: 12, w: 2.55, h: 3.2 },
  van: { l: 5.5, w: 2, h: 2.2 },
  motorcycle: { l: 2.2, w: 0.8, h: 1.5 },
  bicycle: { l: 1.8, w: 0.6, h: 1.7 },
  pedestrian: { l: 0.6, w: 0.6, h: 1.75 },
  scooter: { l: 1.2, w: 0.6, h: 1.7 },
  sidewalk_robot: { l: 0.85, w: 0.6, h: 0.85 },
  drone: { l: 1, w: 1, h: 0.45 },
  animal: { l: 1.2, w: 0.5, h: 1 },
  static_object: { l: 1, w: 1, h: 1 },
};

/** Motion-family helpers preserve the legacy vehicle/pedestrian behaviour
 * while keeping the concrete semantic identity available end to end. */
export function isPedestrianLikeKind(kind: ActorKind): boolean {
  return kind === 'pedestrian' || kind === 'sidewalk_robot' || kind === 'drone' || kind === 'animal';
}

/**
 * Kinds that can be taken off their feet by a contact.
 *
 * Pedestrian-like minus the drone: a quadrotor holds altitude and has no stance
 * to lose, so a contact slows or stops it instead of putting it on the ground.
 */
export function isKnockdownVulnerableKind(kind: ActorKind): boolean {
  return kind === 'pedestrian' || kind === 'animal' || kind === 'sidewalk_robot';
}

export function isRoadActorKind(kind: ActorKind): boolean {
  return !isPedestrianLikeKind(kind) && kind !== 'static_object';
}

export const actorSchema = z.object({
  id: idSchema,
  kind: actorKindSchema,
  /** Defaults by semantic kind; explicit legacy dimensions remain unchanged. */
  dims: dimsSchema.optional(),
  initial: z.object({
    /**
     * Where on the lane graph the actor starts. Optional: without it the engine
     * projects `pose` onto the route's first lane. With it, `pose` is treated
     * as advisory and the lane placement wins (adapters should emit both and
     * keep them consistent).
     */
    laneRef: laneRefSchema.optional(),
    pose: poseSchema,
    speedMps: nonNeg,
  }),
  behavior: z.object({
    rules: actorRulesSchema.default({
      obeySignals: true,
      yield: true,
      yieldToVehicles: true,
      yieldToPedestrians: true,
      collisionAvoidance: true,
      aggression: 0.5,
      speedFactor: 1,
    }),
    route: routeSpecSchema,
    /** Human comfort targets supplied by the authored actor profile. */
    drivingProfile: z.strictObject({
      comfortableLateralAccelerationMps2: positive,
      comfortableDecelerationMps2: positive,
    }).optional(),
    /**
     * Free-flow cruise speed override, m/s. Without it the actor cruises at
     * `speedFactor × laneSpeedLimit`.
     */
    cruiseSpeedMps: nonNeg.optional(),
  }),
  /** `false` = starts absent, waiting for an `exist(present)` interaction. */
  presentAtStart: z.boolean().default(true),
  /**
   * Static roadside actors (parked cars, stopped queues, barriers modelled as
   * actors) still occupy space and occlude sight lines, but they are excluded
   * from episode pair metrics so they cannot steal `minTTC` from the incident
   * pair they are only meant to reveal or hide.
   */
  static: z.boolean().optional(),
  /** Free-form tags carried through to the trace header (role, class, …). */
  tags: z.array(z.string()).default([]),
  /**
   * Rigidly mounted perception sensors.
   *
   * `optional`, not `default([])`, on purpose: a defaulted array would
   * materialize a new property on every historical document and change its
   * input hash — the same rule `physics` and `nearMissCriteria` follow. The
   * sensor objects themselves are strict, so a mistyped field is an *error*
   * rather than a silently discarded declaration.
   */
  sensors: z.array(simSensorSchema).max(32).optional(),
}).transform((actor) => ({
  ...actor,
  dims: actor.dims ?? DEFAULT_ACTOR_DIMS[actor.kind],
  static: actor.kind === 'static_object' || (actor.static ?? false),
}));
export type SimActor = z.infer<typeof actorSchema>;

/* ------------------------------------------------------------------- verbs */

/** `speed(target, dyn)` — abs | ±Δ | ×k | match another actor | stop. */
export const speedTargetSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('absolute'), value: nonNeg }),
  z.object({ mode: z.literal('delta'), value: finite }),
  z.object({ mode: z.literal('factor'), value: nonNeg }),
  z.object({ mode: z.literal('match'), actorId: idSchema, offsetMps: finite.default(0) }),
  z.object({ mode: z.literal('stop') }),
]);
export type SpeedTarget = z.infer<typeof speedTargetSchema>;

export const laneChangeTargetSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('left'), count: z.number().int().min(1).max(4).default(1) }),
  z.object({ mode: z.literal('right'), count: z.number().int().min(1).max(4).default(1) }),
  z.object({ mode: z.literal('lane'), rsl: z.string().min(1) }),
  z.object({ mode: z.literal('actorLane'), actorId: idSchema }),
]);
export type LaneChangeTarget = z.infer<typeof laneChangeTargetSchema>;

/** Keys the `set` verb understands. `rules.*` and `motion.*` feed the
 * controllers; the rest are recorded state only (they exist so the renderer and
 * the exporter can read them back out of the trace).
 *
 * `motion.gear` selects forward or reverse. It lives on the `set` axis rather
 * than being a signed `speed` target because `speedMps` is a magnitude
 * everywhere downstream — TTC, min-clearance, required-decel, the exporters —
 * and signing it would corrupt all of them silently. See `sim/gear.ts`. */
export const setKeySchema = z.string().regex(
  /^(rules\.(obeySignals|yield|yieldToVehicles|yieldToPedestrians|collisionAvoidance|aggression|speedFactor)|motion\.[A-Za-z0-9_]+|lights\.[A-Za-z0-9_]+|audio\.[A-Za-z0-9_]+|doors\.[A-Za-z0-9_]+|pose\.[A-Za-z0-9_]+|env\.[A-Za-z0-9_]+|signal:[A-Za-z0-9._:@/-]+\.phase|control:[A-Za-z0-9._:@/-]+\.indication)$/,
  'unknown set() key — see the typed key registry',
);

export const verbSchema = z.discriminatedUnion('verb', [
  z.object({
    verb: z.literal('speed'),
    target: speedTargetSchema,
    dynamics: dynamicsSchema,
  }),
  z.object({
    verb: z.literal('gap'),
    target: z.object({ actorId: idSchema }),
    value: positive,
    mode: z.enum(['time', 'distance']),
    dynamics: dynamicsSchema,
  }),
  z.object({
    verb: z.literal('changeLane'),
    target: laneChangeTargetSchema,
    dynamics: dynamicsSchema,
  }),
  z.object({
    verb: z.literal('laneOffset'),
    target: z.object({ mode: z.enum(['meters', 'fraction']), value: finite }),
    dynamics: dynamicsSchema,
  }),
  z.object({
    verb: z.literal('route'),
    target: routeActionTargetSchema,
    /** Connect the actor's live pose to the first authored waypoint when the interaction fires. */
    joinFromCurrentPose: z.boolean().optional(),
    /** Follow literal world-space points without road, signal, or avoidance governors. */
    bestEffortWorldPath: z.boolean().optional(),
  }),
  z.object({ verb: z.literal('exist'), target: z.object({ state: z.enum(['present', 'absent']) }) }),
  z.object({
    verb: z.literal('set'),
    target: z.object({ key: setKeySchema, value: z.union([z.boolean(), finite, z.string()]) }),
  }),
]);
export type VerbSpec = z.infer<typeof verbSchema>;

/* ---------------------------------------------------------------- triggers */

export const regionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('circle'), center: scenePointSchema, radiusM: positive }),
  z.object({ kind: z.literal('polygon'), points: z.array(scenePointSchema).min(3) }),
  z.object({ kind: z.literal('laneWindow'), rsl: z.string().min(1), sMin: nonNeg, sMax: nonNeg }),
]);
export type Region = z.infer<typeof regionSchema>;

/* ------------------------------------------------------- surface conditions */

/**
 * A localised patch of road with different grip.
 *
 * Deliberately a `Region` and not a new spatial vocabulary: an ice patch and a
 * `reaches` trigger want to name the same shapes, and one implementation of
 * "is this actor inside that" per shape is one place for it to be wrong. See
 * `../environment.ts` for the resolution rules and the per-kind coefficients —
 * this schema is only the wire format.
 */
export const surfacePatchSchema = z.object({
  id: idSchema,
  kind: z.enum(SURFACE_KINDS),
  region: regionSchema,
  /**
   * Overrides the coefficient implied by `kind`. Present when the scenario is
   * *about* the exact value; absent when the author means "ice".
   */
  frictionScale: positive.min(0.05).max(1.5).optional(),
  /** Blend distance at the patch boundary, metres. `0` is a hard edge, as ice has. */
  edgeTaperM: nonNeg.default(0),
  label: z.string().max(200).optional(),
});
export type SurfacePatch = z.infer<typeof surfacePatchSchema>;

const cmp = z.enum(['lte', 'gte']);

/**
 * Trigger conditions. Every scalar comparison carries an explicit direction so
 * a generated scenario can never be ambiguous about which side fires.
 */
export type Condition =
  | { kind: 'distance'; a: string; b: string; mode: 'alongLane' | 'euclidean'; cmp: 'lte' | 'gte'; value: number; hysteresis?: number }
  | { kind: 'ttc'; a: string; b: string; cmp: 'lte' | 'gte'; value: number }
  | { kind: 'headway'; a: string; b: string; cmp: 'lte' | 'gte'; value: number }
  | { kind: 'reaches'; actorId: string; region: Region }
  | { kind: 'speed'; actorId: string; cmp: 'lte' | 'gte'; value: number }
  | { kind: 'standstill'; actorId: string; durationS: number }
  | { kind: 'signal'; signalId: string; phase: ControlIndication }
  | { kind: 'collision'; a?: string; b?: string }
  | { kind: 'visible'; a: string; to: string; value: boolean }
  /**
   * `detected(a, by: observer)` — the *perception* counterpart of `visible`.
   *
   * `visible` is pure plan-view geometry and is unaffected by weather. This one
   * asks the observer's declared sensor suite, so an actor in clear line of
   * sight but lost in fog, glare or darkness reads `false`. Omitting `sensor`
   * takes the suite's best opinion, which is what a fused stack reports.
   */
  | { kind: 'detected'; a: string; by: string; sensor?: string; value: boolean }
  | { kind: 'and'; of: Condition[] }
  | { kind: 'or'; of: Condition[] }
  | { kind: 'not'; of: Condition };

/**
 * `and`/`or`/`not` are **shallow** by contract (research doc): one level of
 * nesting of leaf conditions. The schema enforces that — a boolean node's
 * children must be leaves.
 */
const leafConditionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('distance'),
    a: idSchema,
    b: idSchema,
    mode: z.enum(['alongLane', 'euclidean']),
    cmp,
    value: nonNeg,
    hysteresis: nonNeg.optional(),
  }),
  z.object({ kind: z.literal('ttc'), a: idSchema, b: idSchema, cmp, value: nonNeg }),
  z.object({ kind: z.literal('headway'), a: idSchema, b: idSchema, cmp, value: nonNeg }),
  z.object({ kind: z.literal('reaches'), actorId: idSchema, region: regionSchema }),
  z.object({ kind: z.literal('speed'), actorId: idSchema, cmp, value: nonNeg }),
  z.object({ kind: z.literal('standstill'), actorId: idSchema, durationS: nonNeg }),
  z.object({
    kind: z.literal('signal'),
    signalId: idSchema,
    phase: controlIndicationSchema,
  }),
  z.object({ kind: z.literal('collision'), a: idSchema.optional(), b: idSchema.optional() }),
  z.object({ kind: z.literal('visible'), a: idSchema, to: idSchema, value: z.boolean() }),
  z.object({
    kind: z.literal('detected'),
    a: idSchema,
    by: idSchema,
    sensor: idSchema.optional(),
    value: z.boolean(),
  }),
]);

export const conditionSchema: z.ZodType<Condition> = z.union([
  leafConditionSchema,
  z.object({ kind: z.literal('and'), of: z.array(leafConditionSchema).min(1).max(8) }),
  z.object({ kind: z.literal('or'), of: z.array(leafConditionSchema).min(1).max(8) }),
  z.object({ kind: z.literal('not'), of: leafConditionSchema }),
]) as unknown as z.ZodType<Condition>;

/** Where the arrival solver aims the actor. */
export const arrivalPointSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('point'),
    at: scenePointSchema,
    /**
     * Optional proof that this point was authored from a reference-frame
     * cross-section. Each station is the same longitudinal cross-section on a
     * concrete lane. An actor route containing one of those lanes therefore
     * resolves the arrival semantically, even when the authored point is one or
     * more lane widths away from its centreline.
     */
    referenceFrame: z
      .object({
        stations: z.array(z.object({ rsl: z.string().min(1), s: nonNeg })).min(1),
      })
      .optional(),
  }),
  z.object({ kind: z.literal('laneS'), rsl: z.string().min(1), s: nonNeg }),
]);
export type ArrivalPoint = z.infer<typeof arrivalPointSchema>;

/**
 * The arrival spec. Exactly one of `ttc` / `deltaT`:
 *
 * - `ttc: 1.5` — when `of` reaches the conflict point, `syncWith` is 1.5 s away
 *   from it (the Euro-NCAP / Scenic reading of "declared criticality").
 * - `deltaT: -1.5` — `of` reaches the point 1.5 s *before* `syncWith`.
 *
 * They are the same number with opposite sign: `ttc === -deltaT`.
 */
export const arrivalSpecSchema = z
  .object({
    of: idSchema,
    at: arrivalPointSchema,
    syncWith: idSchema,
    ttc: finite.optional(),
    deltaT: finite.optional(),
  })
  .refine((v) => (v.ttc === undefined) !== (v.deltaT === undefined), {
    message: 'arrival requires exactly one of ttc | deltaT',
  });
export type ArrivalSpec = z.infer<typeof arrivalSpecSchema>;

/**
 * `when` carries a mandatory `byLatest` — a condition that never fires is a
 * silent bug, so the author must say what happens instead.
 */
export const triggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), t: finite }),
  z.object({ kind: z.literal('after'), interactionId: idSchema, event: z.enum(['start', 'end']).optional(), delayS: nonNeg.default(0) }),
  z.object({
    kind: z.literal('when'),
    condition: conditionSchema,
    byLatest: finite,
    ifNever: z.enum(['skip', 'fire']),
  }),
  z.object({ kind: z.literal('arrival'), arrival: arrivalSpecSchema }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

/* ------------------------------------------------------------ interactions */

export const interactionSchema = z.intersection(
  z.object({
    id: idSchema,
    actorId: idSchema,
    trigger: triggerSchema,
    /**
     * Half-open editor eligibility window `[startS, endS)`. The trigger is not
     * evaluated before `startS`; at `endS` an unfired interaction is skipped.
     * Once fired, the command's own dynamics determine completion.
     */
    window: z.object({ startS: finite, endS: finite }).refine(
      (value) => value.startS <= value.endS,
      { message: 'interaction window startS must be <= endS' },
    ).optional(),
    /** Releases the axis back to default behaviour when satisfied. */
    until: conditionSchema.optional(),
  }),
  verbSchema,
);
export type Interaction = z.infer<typeof interactionSchema>;

/* ----------------------------------------------------- signals & occluders */

export const signalProgramSchema = z.object({
  id: idSchema,
  /**
   * One cycle. Phases play in order from `t = -warmupSeconds + offsetS` and
   * repeat when `loop` (the default).
   */
  phases: z
    .array(z.object({ phase: controlIndicationSchema, durationS: positive }))
    .min(1),
  offsetS: finite.default(0),
  loop: z.boolean().default(true),
  /**
   * The right-of-way rule that applies while this head shows no indication.
   *
   * A dark signal is **not** an uncontrolled junction. In the jurisdictions
   * these maps come from it reverts to an all-way stop (MUTCD 4D.34, UVC
   * 11-205, Highway Code r.176), which is the opposite of "proceed". The
   * default is therefore the law, and the exceptions that genuinely exist — a
   * decommissioned head, a jurisdiction that signs the blackout as a yield —
   * have to be written down rather than assumed.
   *
   * Optional rather than defaulted for the same reason `physics` is: parsing an
   * older document must not materialize a new property and thereby change its
   * input hash. `SignalBook` applies the default at read time.
   */
  darkFallback: z.enum(['all_way_stop', 'uncontrolled', 'yield']).optional(),
  /** Minimum standstill at the line while this program is dark or flashing red. */
  darkDwellS: positive.optional(),
  /**
   * Stop lines this program controls. An actor whose route crosses one of these
   * lanes brakes for the line when the phase forbids entry.
   */
  stopLines: z
    .array(z.object({
      rsl: z.string().min(1),
      s: nonNeg,
      /**
       * Optional movement filter. A stop line only applies when the actor's
       * route continues through one of these junction lanes. This keeps a
       * protected left-turn head from stopping adjacent through traffic that
       * happens to share the same approach lane.
       */
      connectingLaneRsls: z.array(z.string().min(1)).default([]),
    }))
    .default([]),
  /** Stable binding back to the map's physical signal furniture/export ids. */
  mapBinding: z.object({
    junctionId: z.string().min(1),
    controllerIds: z.array(z.string().min(1)).default([]),
    headIds: z.array(z.string().min(1)).min(1),
    /**
     * Authoritative OpenDRIVE controller-sequence membership. A physical head
     * may occur in more than one ordered controller stage; flattening that
     * relation to `controllerIds` loses the information an exporter needs to
     * reconstruct the junction program. Programs materialized from maps always
     * populate this field. It remains optional for authored/legacy inputs.
     */
    controllerHeadGroups: z.array(z.object({
      controllerId: z.string().min(1),
      headIds: z.array(z.string().min(1)).min(1),
    })).optional(),
    /** Honest provenance for programs derived without authoritative timing. */
    timingSource: z.enum(['map', 'synthetic-default', 'authored']),
  }).superRefine((binding, ctx) => {
    if (!binding.controllerHeadGroups) return;
    const groupControllerIds = binding.controllerHeadGroups.map((group) => group.controllerId);
    if (new Set(groupControllerIds).size !== groupControllerIds.length) {
      ctx.addIssue({ code: 'custom', path: ['controllerHeadGroups'], message: 'duplicate controllerHeadGroups controllerId' });
    }
    for (let i = 0; i < binding.controllerHeadGroups.length; i += 1) {
      const ids = binding.controllerHeadGroups[i]!.headIds;
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: 'custom', path: ['controllerHeadGroups', i, 'headIds'], message: 'duplicate controller head id' });
      }
    }
    const flattenedControllers = [...new Set(groupControllerIds)].sort();
    const flattenedHeads = [...new Set(binding.controllerHeadGroups.flatMap((group) => group.headIds))].sort();
    if (JSON.stringify([...binding.controllerIds].sort()) !== JSON.stringify(flattenedControllers)) {
      ctx.addIssue({ code: 'custom', path: ['controllerIds'], message: 'controllerIds must equal controllerHeadGroups controller ids' });
    }
    if (JSON.stringify([...binding.headIds].sort()) !== JSON.stringify(flattenedHeads)) {
      ctx.addIssue({ code: 'custom', path: ['headIds'], message: 'headIds must equal controllerHeadGroups head ids' });
    }
  }).optional(),
});
export type SignalProgram = z.infer<typeof signalProgramSchema>;

/** A deterministic static right-of-way control. Unlike a traffic signal this
 * has per-actor memory: an actor must stop, dwell, then is released. */
export const roadControlSchema = z.object({
  id: idSchema,
  kind: z.literal('stop'),
  /** Minimum continuous standstill before this actor may proceed. */
  dwellS: positive.default(1),
  stopLines: z.array(z.object({
    rsl: z.string().min(1),
    s: nonNeg,
    connectingLaneRsls: z.array(z.string().min(1)).default([]),
  })).min(1),
  mapBinding: z.object({
    junctionId: z.string().min(1),
    controlIds: z.array(z.string().min(1)).min(1),
    source: z.enum(['map', 'authored']),
  }).optional(),
});
export type RoadControl = z.infer<typeof roadControlSchema>;

/**
 * One concrete, fixed catalog prop in the scene frame.
 *
 * The authoring v2 adapter expands repeated placements before this seam, so
 * every member has its own `id` and retains the author-level `groupId`. `dims`
 * are the unscaled catalog/override dimensions; consumers apply the uniform
 * `scale` exactly once. Props are fixed geometry rather than actor tracks.
 */
export const staticPropSchema = z.object({
  id: idSchema,
  groupId: idSchema.optional(),
  catalogId: z.string().min(1).max(200),
  pose: poseSchema,
  /** Rigid transform in an actor-local frame: +longitudinal forward, +lateral left. */
  attachment: z.object({
    actorId: idSchema,
    longitudinalM: finite.default(0),
    lateralM: finite.default(0),
    heightM: nonNeg.default(0),
    headingOffsetRad: finite.default(0),
  }).optional(),
  dims: dimsSchema,
  scale: positive.max(10).default(1),
  collidable: z.boolean().default(false),
  essentiality: z.enum(['required', 'preferred', 'cosmetic']).default('preferred'),
  occludes: z.object({ observer: idSchema, target: idSchema }).optional(),
  targetRevealToConflictS: nonNeg.optional(),
}).refine(
  (prop) => prop.targetRevealToConflictS === undefined || prop.occludes !== undefined,
  { message: 'targetRevealToConflictS requires occludes', path: ['targetRevealToConflictS'] },
);
export type StaticProp = z.infer<typeof staticPropSchema>;

/** Static line-of-sight blockers, in the scene frame. */
export const occluderSchema = z.object({
  /** Concrete shape id; repeated author-level props materialize as one shape per member. */
  id: idSchema,
  /** Optional author-level aggregate id shared by repeated concrete shapes. */
  groupId: idSchema.optional(),
  obb: z.object({
    center: scenePointSchema,
    lengthM: positive,
    widthM: positive,
    headingRad: finite,
    heightM: positive.default(2),
  }),
});
export type Occluder = z.infer<typeof occluderSchema>;

/** An authored line-of-sight relation the occluder layer is supposed to affect. */
export const occlusionPairSchema = z.object({
  observer: idSchema,
  target: idSchema,
  /** Concrete occluder id, groupId, or explicitly monitored actor ref (`actor:<id>`). */
  occluderId: idSchema.optional(),
});
export type OcclusionPair = z.infer<typeof occlusionPairSchema>;

/** Hash-covered semantic acceptance intent for a materialized near miss. */
export const nearMissCriterionSchema = z.object({
  interactionId: idSchema,
  pedestrianId: idSchema,
  targetId: idSchema,
  clearanceM: positive,
  toleranceM: positive.default(0.15),
  pass: z.enum(['front', 'behind']),
  planHash: z.string().regex(/^[0-9a-f]{8}$/),
  predictedClosestApproachS: nonNeg,
  predictedTimeGapS: finite,
});
export type NearMissCriterion = z.infer<typeof nearMissCriterionSchema>;

/* ------------------------------------------------ operational conditions */

/**
 * Hash-covered ambient conditions with explicit executable effects.
 *
 * The descriptive classes are retained for render/export provenance, while
 * the numeric effects prevent a catalog variant from being a metadata-only
 * claim. Adapters must choose these values deterministically.
 */
export const operationalConditionsSchema = z.object({
  weather: z.enum(['clear', 'rain', 'overcast']).default('clear'),
  timeOfDay: z.enum(['day', 'dusk', 'night', 'dawn']).default('day'),
  traffic: z.enum(['light', 'moderate', 'heavy']).default('moderate'),
  visibility: z.enum([
    'unrestricted',
    'reduced-contrast',
    'headlight-limited',
    'directional-glare',
    'dense-occlusion',
  ]).default('unrestricted'),
  effects: z.object({
    /** Maximum actor-to-actor LOS range used by visible() and reveal metrics. */
    visibilityRangeM: positive.max(10_000).default(10_000),
    /** Multiplier on physical braking capacity and hard-eligibility ceiling. */
    frictionScale: positive.min(0.1).max(1.2).default(1),
    /** Multiplier on ambient cruise speeds and lane speed limits. */
    trafficSpeedFactor: positive.min(0.1).max(1.5).default(1),
  }).default({ visibilityRangeM: 10_000, frictionScale: 1, trafficSpeedFactor: 1 }),
}).default({
  weather: 'clear',
  timeOfDay: 'day',
  traffic: 'moderate',
  visibility: 'unrestricted',
  effects: { visibilityRangeM: 10_000, frictionScale: 1, trafficSpeedFactor: 1 },
});
export type OperationalConditions = z.infer<typeof operationalConditionsSchema>;

/* -------------------------------------------------------------- physics */

/**
 * Motion semantics are named and versioned independently of the engine build.
 * `kinematic-v1` is the established route-following/choreography model.
 * `dynamic-v1` is the default for new/regenerated simulation. Immutable trace
 * replay uses the mode recorded in the trace rather than resolving this input.
 */
export const MOTION_PHYSICS_MODES = ['kinematic-v1', 'dynamic-v1'] as const;
export const motionPhysicsModeSchema = z.enum(MOTION_PHYSICS_MODES);
export type MotionPhysicsMode = z.infer<typeof motionPhysicsModeSchema>;
export const DEFAULT_MOTION_PHYSICS_MODE: MotionPhysicsMode = 'dynamic-v1';

/**
 * Phase-0 selection envelope. The field is optional on SimScenarioInput on
 * purpose: parsing an older document must not materialize a new property and
 * thereby change its input hash. A new simulation of that document uses the
 * current default; immutable trace replay instead honors recorded provenance.
 *
 * Vehicle-profile payloads are versioned by the selected solver. Keeping the
 * envelope JSON-shaped permits dynamic-v1 to evolve its profile contract while
 * still binding the exact payload into trace provenance by content digest.
 */
export const vehiclePhysicsProfileSchema = z.object({
  massKg: positive.optional(),
  yawInertiaKgM2: positive.optional(),
  wheelbaseM: positive.optional(),
  cgToFrontM: positive.optional(),
  cgHeightM: nonNeg.optional(),
  wheelRadiusM: positive.optional(),
  corneringStiffnessFrontNPerRad: positive.optional(),
  corneringStiffnessRearNPerRad: positive.optional(),
  dragCoefficientNPerMps2: nonNeg.optional(),
  rollingResistanceCoefficient: nonNeg.optional(),
  maxDriveForceN: positive.optional(),
  maxBrakeForceN: positive.optional(),
  maxSteerRad: positive.optional(),
  steerRateRadPerS: positive.optional(),
  steerTimeConstantS: positive.optional(),
  tireMu: positive.optional(),
  maxLongitudinalAccelMps2: positive.optional(),
  maxLongitudinalDecelMps2: positive.optional(),
  maxJerkMps3: positive.optional(),
  maxLateralAccelerationMps2: positive.optional(),
  maxYawRateRadps: positive.optional(),
});
export type VehiclePhysicsProfile = z.infer<typeof vehiclePhysicsProfileSchema>;

export const physicsConfigSchema = z.object({
  mode: motionPhysicsModeSchema,
  /** Dynamic solver substep. Kinematic-v1 uses the scenario dt. */
  substepS: positive.max(0.2).optional(),
  /** Per-actor physical-parameter overrides; omitted values use solver defaults. */
  vehicleProfiles: z.record(idSchema, vehiclePhysicsProfileSchema).optional(),
});
export type PhysicsConfig = z.infer<typeof physicsConfigSchema>;

export interface ResolvedPhysicsConfig {
  readonly mode: MotionPhysicsMode;
  readonly substepS?: number;
  readonly vehicleProfiles?: PhysicsConfig['vehicleProfiles'];
}

/**
 * Resolve the effective physics configuration without mutating hash-covered
 * input. An explicit selection — `kinematic-v1` or `dynamic-v1` — is honored
 * exactly, per the truth contract in `docs/physics-validation.md`: a trace for
 * an explicitly selected mode must match that mode, so no resolution step may
 * silently relabel it. Omitted physics resolves to the current default
 * (`dynamic-v1`); immutable legacy traces are instead replayed under their
 * recorded header by the evidence validator (`legacy-kinematic`).
 */
export function resolvePhysicsConfig(input: Pick<SimScenarioInput, 'physics'>): ResolvedPhysicsConfig {
  return input.physics ?? { mode: DEFAULT_MOTION_PHYSICS_MODE };
}

/* ------------------------------------------------------------- the document */

export const simScenarioInputSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    /** Informational: which map the `rsl` references belong to. */
    mapId: z.string().min(1).default('unknown'),
    /** Recorded clip length in seconds; the trace covers `t ∈ [0, clipSeconds]`. */
    clipSeconds: positive.default(20),
    /** Unrecorded prologue `t ∈ [-warmupSeconds, 0)`. */
    warmupSeconds: nonNeg.default(5),
    /** Fixed integration step, seconds. */
    dt: positive.max(0.2).default(0.02),
    seed: z.union([z.number().int(), z.string()]).default(0),
    /** Omitted means the current simulation default and stays hash-stable. */
    physics: physicsConfigSchema.optional(),
    operationalConditions: operationalConditionsSchema,
    /** Which actor the criticality metrics are reported against. */
    metricSubject: idSchema.optional(),
    actors: z.array(actorSchema).min(1),
    interactions: z.array(interactionSchema).default([]),
    signalPrograms: z.array(signalProgramSchema).default([]),
    roadControls: z.array(roadControlSchema).default([]),
    /** Localised grip: ice on the bend, a flooded dip, wet leaves under the trees. */
    surfacePatches: z.array(surfacePatchSchema).default([]),
    /** Fixed renderable catalog props, expanded to one record per concrete member. */
    props: z.array(staticPropSchema).default([]),
    occluders: z.array(occluderSchema).default([]),
    occlusionPairs: z.array(occlusionPairSchema).default([]),
    // Optional (rather than default []) so parsing historical immutable inputs
    // does not alter their content hash.
    nearMissCriteria: z.array(nearMissCriterionSchema).optional(),
    /**
     * Atmosphere, emissive glare and declared map/percept divergence. Optional
     * for the same hash-stability reason; a document that declares sensors but
     * omits this block simulates in clear air at full daylight.
     */
    perception: perceptionConfigSchema.optional(),
  })
  .superRefine((doc, ctx) => {
    const actorIds = new Set<string>();
    for (const a of doc.actors) {
      if (actorIds.has(a.id)) {
        ctx.addIssue({ code: 'custom', path: ['actors'], message: `duplicate actor id ${a.id}` });
      }
      actorIds.add(a.id);
    }
    const interactionIds = new Set<string>();
    for (let i = 0; i < doc.interactions.length; i++) {
      const it = doc.interactions[i]!;
      if (interactionIds.has(it.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['interactions', i, 'id'],
          message: `duplicate interaction id ${it.id}`,
        });
      }
      interactionIds.add(it.id);
      if (!actorIds.has(it.actorId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['interactions', i, 'actorId'],
          message: `unknown actor ${it.actorId}`,
        });
      }
    }
    for (let i = 0; i < doc.interactions.length; i++) {
      const it = doc.interactions[i]!;
      if (it.trigger.kind === 'after' && !interactionIds.has(it.trigger.interactionId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['interactions', i, 'trigger', 'interactionId'],
          message: `after() references unknown interaction ${it.trigger.interactionId}`,
        });
      }
    }
    if (doc.metricSubject !== undefined && !actorIds.has(doc.metricSubject)) {
      ctx.addIssue({ code: 'custom', path: ['metricSubject'], message: 'unknown actor' });
    }
    for (let i = 0; i < (doc.nearMissCriteria?.length ?? 0); i++) {
      const criterion = doc.nearMissCriteria![i]!;
      if (!actorIds.has(criterion.pedestrianId) || !actorIds.has(criterion.targetId)) {
        ctx.addIssue({ code: 'custom', path: ['nearMissCriteria', i], message: 'near-miss criterion references an unknown actor' });
      }
    }
    const propIds = new Set<string>();
    for (let i = 0; i < doc.props.length; i++) {
      const prop = doc.props[i]!;
      if (propIds.has(prop.id)) {
        ctx.addIssue({ code: 'custom', path: ['props', i, 'id'], message: `duplicate prop id ${prop.id}` });
      }
      propIds.add(prop.id);
      if (actorIds.has(prop.id)) {
        ctx.addIssue({ code: 'custom', path: ['props', i, 'id'], message: `prop id ${prop.id} collides with an actor id` });
      }
      if (prop.occludes && !actorIds.has(prop.occludes.observer)) {
        ctx.addIssue({ code: 'custom', path: ['props', i, 'occludes', 'observer'], message: `unknown actor ${prop.occludes.observer}` });
      }
      if (prop.occludes && !actorIds.has(prop.occludes.target)) {
        ctx.addIssue({ code: 'custom', path: ['props', i, 'occludes', 'target'], message: `unknown actor ${prop.occludes.target}` });
      }
      if (prop.attachment && !actorIds.has(prop.attachment.actorId)) {
        ctx.addIssue({ code: 'custom', path: ['props', i, 'attachment', 'actorId'], message: `unknown carrier actor ${prop.attachment.actorId}` });
      }
    }
    for (let i = 0; i < doc.props.length; i++) {
      const groupId = doc.props[i]!.groupId;
      if (groupId && propIds.has(groupId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['props', i, 'groupId'],
          message: `prop group ${groupId} collides with a concrete prop id`,
        });
      }
    }
    const occluderIds = new Set<string>();
    const occluderGroupIds = new Set<string>();
    for (let i = 0; i < doc.occluders.length; i++) {
      const o = doc.occluders[i]!;
      if (occluderIds.has(o.id)) {
        ctx.addIssue({ code: 'custom', path: ['occluders', i, 'id'], message: `duplicate occluder id ${o.id}` });
      }
      occluderIds.add(o.id);
      if (o.groupId) occluderGroupIds.add(o.groupId);
    }
    for (let i = 0; i < doc.occluders.length; i++) {
      const groupId = doc.occluders[i]!.groupId;
      if (groupId && occluderIds.has(groupId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['occluders', i, 'groupId'],
          message: `occluder group ${groupId} collides with a concrete occluder id`,
        });
      }
    }
    // Actor occluders are explicit declarations, so both parked and moving
    // actors are valid. The runtime evaluates their current OBB every tick;
    // undeclared traffic is never silently promoted to an occluder.
    const actorOccluderIds = new Set(doc.actors.map((a) => `actor:${a.id}`));
    for (let i = 0; i < doc.occlusionPairs.length; i++) {
      const pair = doc.occlusionPairs[i]!;
      if (!actorIds.has(pair.observer)) {
        ctx.addIssue({
          code: 'custom',
          path: ['occlusionPairs', i, 'observer'],
          message: `unknown actor ${pair.observer}`,
        });
      }
      if (!actorIds.has(pair.target)) {
        ctx.addIssue({
          code: 'custom',
          path: ['occlusionPairs', i, 'target'],
          message: `unknown actor ${pair.target}`,
        });
      }
      if (
        pair.occluderId !== undefined &&
        !occluderIds.has(pair.occluderId) &&
        !occluderGroupIds.has(pair.occluderId) &&
        !actorOccluderIds.has(pair.occluderId)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['occlusionPairs', i, 'occluderId'],
          message: `unknown occluder or occluder group ${pair.occluderId}`,
        });
      }
    }
    /* ------------------------------------------------------- perception --
     * A declared sensor that nothing consumes is worse than no sensor at all:
     * the document validates, simulates, and quietly behaves as though it never
     * said anything. Every reference below therefore fails loudly.
     */
    const sensorIdsByActor = new Map<string, Set<string>>();
    for (let i = 0; i < doc.actors.length; i++) {
      const actor = doc.actors[i]!;
      const ids = new Set<string>();
      for (let s = 0; s < (actor.sensors?.length ?? 0); s++) {
        const sensor = actor.sensors![s]!;
        if (ids.has(sensor.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['actors', i, 'sensors', s, 'id'],
            message: `duplicate sensor id ${sensor.id} on actor ${actor.id}`,
          });
        }
        ids.add(sensor.id);
      }
      sensorIdsByActor.set(actor.id, ids);
    }
    const perceptionConditions: Array<{ path: (string | number)[]; condition: Condition }> = [];
    for (let i = 0; i < doc.interactions.length; i++) {
      const it = doc.interactions[i]!;
      if (it.trigger.kind === 'when') {
        perceptionConditions.push({ path: ['interactions', i, 'trigger', 'condition'], condition: it.trigger.condition });
      }
      if (it.until !== undefined) {
        perceptionConditions.push({ path: ['interactions', i, 'until'], condition: it.until as Condition });
      }
    }
    for (const entry of perceptionConditions) {
      const leaves: Condition[] =
        entry.condition.kind === 'and' || entry.condition.kind === 'or'
          ? entry.condition.of
          : entry.condition.kind === 'not'
            ? [entry.condition.of]
            : [entry.condition];
      for (const leaf of leaves) {
        if (leaf.kind !== 'detected') continue;
        if (!actorIds.has(leaf.a)) {
          ctx.addIssue({ code: 'custom', path: entry.path, message: `detected() references unknown actor ${leaf.a}` });
        }
        const declared = sensorIdsByActor.get(leaf.by);
        if (declared === undefined) {
          ctx.addIssue({ code: 'custom', path: entry.path, message: `detected() references unknown observer ${leaf.by}` });
          continue;
        }
        if (declared.size === 0) {
          ctx.addIssue({
            code: 'custom',
            path: entry.path,
            message: `detected() observer ${leaf.by} declares no sensors, so it can never detect anything`,
          });
        } else if (leaf.sensor !== undefined && !declared.has(leaf.sensor)) {
          ctx.addIssue({
            code: 'custom',
            path: entry.path,
            message: `detected() references unknown sensor ${leaf.sensor} on actor ${leaf.by}`,
          });
        }
      }
    }
    const divergenceIds = new Set<string>();
    for (let i = 0; i < (doc.perception?.mapDivergences.length ?? 0); i++) {
      const divergence = doc.perception!.mapDivergences[i]!;
      if (divergenceIds.has(divergence.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['perception', 'mapDivergences', i, 'id'],
          message: `duplicate map divergence id ${divergence.id}`,
        });
      }
      divergenceIds.add(divergence.id);
      for (let o = 0; o < divergence.observers.length; o++) {
        if (!actorIds.has(divergence.observers[o]!)) {
          ctx.addIssue({
            code: 'custom',
            path: ['perception', 'mapDivergences', i, 'observers', o],
            message: `unknown actor ${divergence.observers[o]}`,
          });
        }
      }
    }
    const signalIds = new Set(doc.signalPrograms.map((p) => p.id));
    for (let i = 0; i < doc.signalPrograms.length; i++) {
      const p = doc.signalPrograms[i]!;
      if (doc.signalPrograms.findIndex((q) => q.id === p.id) !== i) {
        ctx.addIssue({
          code: 'custom',
          path: ['signalPrograms', i, 'id'],
          message: `duplicate signal program ${p.id}`,
        });
      }
    }
    for (let i = 0; i < doc.roadControls.length; i++) {
      const control = doc.roadControls[i]!;
      if (doc.roadControls.findIndex((candidate) => candidate.id === control.id) !== i) {
        ctx.addIssue({
          code: 'custom',
          path: ['roadControls', i, 'id'],
          message: `duplicate road control ${control.id}`,
        });
      }
    }
    void signalIds;
  });

export type SimScenarioInput = z.infer<typeof simScenarioInputSchema>;
/** The pre-parse shape: everything with a default is optional. */
export type SimScenarioInputSpec = z.input<typeof simScenarioInputSchema>;

/**
 * Parse + normalise. Throws a `ZodError`; use `safeParseSimScenarioInput` when
 * you want structured issues for a repair loop.
 */
export function parseSimScenarioInput(value: unknown): SimScenarioInput {
  return simScenarioInputSchema.parse(value);
}

function byId<T extends { id: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Canonical ordering: every keyed collection sorted by id.
 *
 * The engine iterates in sorted order anyway, so normalising does not change
 * behaviour — but it makes `contentHash(input)` (and therefore
 * `trace.header.inputHash`) independent of the order an adapter happened to
 * emit its actors in. `determinism.test.ts` relies on exactly this.
 */
export function normalizeSimScenarioInput(input: SimScenarioInput): SimScenarioInput {
  return {
    ...input,
    actors: byId(input.actors),
    interactions: byId(input.interactions),
    signalPrograms: byId(input.signalPrograms),
    roadControls: byId(input.roadControls),
    props: byId(input.props),
    occluders: byId(input.occluders),
    occlusionPairs: [...input.occlusionPairs].sort(
      (a, b) =>
        a.observer.localeCompare(b.observer) ||
        a.target.localeCompare(b.target) ||
        (a.occluderId ?? '').localeCompare(b.occluderId ?? ''),
    ),
    ...(input.nearMissCriteria ? { nearMissCriteria: [...input.nearMissCriteria].sort((a, b) => a.interactionId.localeCompare(b.interactionId)) } : {}),
  };
}

/** A schema violation flattened for an unattended repair loop. */
export interface SimSchemaIssue {
  readonly code: string;
  /** Dotted path into the document, e.g. `actors.1.behavior.route.lanes`. */
  readonly path: string;
  readonly message: string;
}

export function safeParseSimScenarioInput(
  value: unknown,
): { ok: true; value: SimScenarioInput } | { ok: false; issues: SimSchemaIssue[] } {
  const r = simScenarioInputSchema.safeParse(value);
  if (r.success) return { ok: true, value: r.data };
  const issues = r.error.issues.map((i) => ({
    code: String(i.code),
    path: i.path.map((p) => String(p)).join('.'),
    message: i.message,
  }));
  return { ok: false, issues };
}
