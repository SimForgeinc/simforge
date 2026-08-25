/**
 * `RoleBinding` — how an actor attaches to matched road structure.
 *
 * v1 placed entities at absolute scene coordinates. v2 places *roles*: "the car
 * that turns across ego from the opposing arm" is a description that survives
 * being moved to another junction, whereas `x: 118.25, z: -402.5` is not.
 *
 * ## FramePose
 *
 * Every pose is `(laneOffset k, s, tFrac, headingOffsetRad)` in the AnchorFrame
 * the matcher establishes:
 *
 * - `k` — signed same-direction lane index. 0 is the reference lane, +1 is one
 *   lane to the left of it, −1 one to the right (the same handedness as the
 *   scene frame's heading convention).
 * - `s` — arc length along the reference path from the frame origin, metres.
 *   May be an expression, which is how "one junction-size back from the stop
 *   line" is written portably.
 * - `tFrac` — lateral offset **as a fraction of local lane width**, not metres.
 *   This is the whole reason a cyclist hugging the kerb stays hugging the kerb
 *   on a 2.7 m lane and on a 3.9 m lane.
 * - `headingOffsetRad` — yaw relative to the lane tangent.
 *
 * ## Kinds
 *
 * `on_reference`, `lane_offset`, `at_lane_drop`, `opposing`, `conflicting_gate`,
 * `on_crossing`, `in_parking_zone`, `relative_to`. The interesting one is `conflicting_gate`:
 * it names a junction movement (`from`, `turn`) rather than a position, and the
 * solver places the actor by backing up from the precomputed conflict point —
 * which is how arrival criticality is preserved across maps.
 */

import { z } from 'zod';

import { DriverProfileSchema } from '../../driver-profiles.js';
import { ExprSchema, NumberOrExprSchema } from '../../expr/index.js';
import { LaneRefSchema as V1LaneRefSchema, PoseSchema as V1PoseSchema } from '../v1.js';
import { ApproachRelationSchema, TurnDirectionSchema } from './anchor.js';
import { FeatureRefSchema, RoleIdSchema, RoleRefSchema, V2ExtensionsSchema } from './common.js';
import { ActorSensorSchema, type ActorSensor } from './sensors.js';

/** Actor classes. Drives dynamics limits, footprint, and occluder height. */
export const ACTOR_CLASSES = [
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
/** Actor class. */
export const ActorClassSchema = z.enum(ACTOR_CLASSES);

/** Nominal footprints, metres, used by spawn-overlap and runway checks when no
 * `dims` override is given. Deliberately generous rather than average: a false
 * "these two spawn on top of each other" is cheap, a missed one is a broken clip. */
export const DEFAULT_ACTOR_DIMS: Record<
  z.infer<typeof ActorClassSchema>,
  { length: number; width: number; height: number }
> = {
  car: { length: 4.8, width: 1.9, height: 1.5 },
  truck: { length: 9.5, width: 2.5, height: 3.5 },
  bus: { length: 12.0, width: 2.55, height: 3.2 },
  van: { length: 5.5, width: 2.0, height: 2.2 },
  motorcycle: { length: 2.2, width: 0.8, height: 1.5 },
  bicycle: { length: 1.8, width: 0.6, height: 1.7 },
  pedestrian: { length: 0.6, width: 0.6, height: 1.75 },
  scooter: { length: 1.2, width: 0.6, height: 1.7 },
  sidewalk_robot: { length: 0.85, width: 0.6, height: 0.85 },
  drone: { length: 1.0, width: 1.0, height: 0.45 },
  animal: { length: 1.2, width: 0.5, height: 1.0 },
  static_object: { length: 1.0, width: 1.0, height: 1.0 },
};

/** Which actor classes are legal on a pedestrian-only surface. */
export const VRU_CLASSES = new Set(['pedestrian', 'bicycle', 'scooter', 'sidewalk_robot', 'drone', 'animal']);

/** Explicit bounding box, overriding the catalog model's own. */
export const V2DimensionsSchema = z.strictObject({
  length: z.number().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
});

/** What kind of thing fills the role, and (optionally) exactly which model. */
export const ActorSpecSchema = z.strictObject({
  class: ActorClassSchema,
  /**
   * Catalog id. Resolved against the prop/vehicle catalog **at author time** —
   * a silent substitution turns an occluding box truck into a sedan and deletes
   * the point of the scenario, so an unresolvable id must fail loudly.
   */
  catalogId: z.string().min(1).max(200).optional(),
  dims: V2DimensionsSchema.optional(),
  /**
   * Parked/stopped context actor: collides and occludes, but is not a metric
   * participant. Use this for roadside queues and parked vehicles whose purpose
   * is to reveal/hide the incident actor, not to become the incident pair.
   */
  static: z.boolean().default(false),
  /** Physical sensors mounted to this actor. Empty for legacy templates. */
  sensors: z.array(ActorSensorSchema).default([]),
}).check((ctx) => {
  const ids = new Set<string>();
  ctx.value.sensors.forEach((sensor: ActorSensor, index: number) => {
    if (ids.has(sensor.id)) {
      ctx.issues.push({
        code: 'custom',
        message: `duplicate sensor id "${sensor.id}"`,
        path: ['sensors', index, 'id'],
        input: sensor.id,
      });
    }
    ids.add(sensor.id);
  });
});

/** A pose in the AnchorFrame. See the module docs for the convention. */
const TFracOrExprSchema = z.union([z.number().min(-1).max(1), ExprSchema]);

export const FramePoseSchema = z.strictObject({
  /** Signed same-direction lane index; 0 is the reference lane. */
  laneOffset: z.number().int().min(-8).max(8).default(0),
  /** Arc length from the frame origin, metres. Negative is upstream. */
  s: NumberOrExprSchema,
  /** Lateral offset as a fraction of local lane width, −1..1 (0 = centre). May be parameterised. */
  tFrac: TFracOrExprSchema.default(0),
  /** Yaw relative to the lane tangent, radians. */
  headingOffsetRad: z.number().min(-Math.PI).max(Math.PI).default(0),
});

/**
 * The concrete lane chain a map-bound actor follows from its authored pose.
 *
 * This is spawn state, not choreography: changing it in the timeline would
 * imply an event at t=0 and force every consumer to rediscover the actor's
 * initial route by scanning interactions.
 */
export const SceneAbsoluteInitialRouteSchema = z.strictObject({
  mode: z.literal('lanePath'),
  lanes: z.array(z.string().min(1)).min(1).max(128),
});

/** A frame-relative pose. */
export type FramePose = z.infer<typeof FramePoseSchema>;
/** A frame-relative pose as authored. */
export type FramePoseInput = z.input<typeof FramePoseSchema>;

const roleBase = {
  id: RoleIdSchema,
  actor: ActorSpecSchema,
  /** Author-facing name, e.g. "oncoming left-turner". */
  label: z.string().max(200).optional(),
  /**
   * Initial speed, kph. Expressions are the norm here:
   * `clamp(0.9 * lane.speedLimitKph, 25, 65)`.
   */
  initialSpeedKph: NumberOrExprSchema.optional(),
  /** Driver policy for moving road actors. Appearance and physical dimensions remain independent. */
  driverProfile: DriverProfileSchema.optional(),
  /** Physical movement-control requirement resolved against the concrete gate.
   * `uncontrolled` means this movement has priority at a minor-stop junction;
   * it must not silently inherit a stop sign from another arm. */
  requiredMovementControl: z.enum(['stop', 'uncontrolled']).optional(),
  /** Require this actor and the referenced role to resolve onto the same
   * junction-free local corridor segment. */
  requiredSameSegmentAs: RoleRefSchema.optional(),
  /** Require the concrete lanes to share one OpenDRIVE road and lane section;
   * useful for opposite directions whose directional segment ids differ. */
  requiredSameRoadSectionAs: RoleRefSchema.optional(),
  /** Hard local travel-heading relation after both roles bind. */
  requiredHeadingRelation: z.strictObject({
    role: RoleRefSchema,
    relation: z.enum(['parallel', 'antiparallel']),
    maxErrorDeg: z.number().min(0).max(45),
  }).optional(),
  /**
   * `cosmetic` roles may be dropped by degradation when a site cannot hold
   * them; `required` roles failing to bind makes the site infeasible.
   */
  essentiality: z.enum(['required', 'preferred', 'cosmetic']).default('required'),
  extensions: V2ExtensionsSchema.optional(),
};

/** On the reference lane itself. The ego's usual binding. */
export const OnReferenceRoleSchema = z.strictObject({
  ...roleBase,
  kind: z.literal('on_reference'),
  pose: FramePoseSchema,
});

/** On a lane `k` over from the reference lane, same direction. */
export const LaneOffsetRoleSchema = z.strictObject({
  ...roleBase,
  kind: z.literal('lane_offset'),
  /** Lane index relative to the reference lane. */
  k: z.number().int().min(-8).max(8),
  /** What to do when the site has no such lane. */
  onMissing: z.enum(['clamp', 'drop', 'fail']).default('fail'),
  /** `pose.laneOffset` is ignored for this kind; `k` wins. */
  pose: FramePoseSchema,
});

/**
 * On one of the two lanes that define a matched lane-drop taper.
 *
 * Unlike `lane_offset`, this binding is structural rather than positional: the
 * matcher resolves the exact lane named by the `lane_drop:<rsl>` feature and
 * its immediately adjacent, legally reachable continuing sibling.
 */
export const AtLaneDropRoleSchema = z.strictObject({
  ...roleBase,
  kind: z.literal('at_lane_drop'),
  feature: FeatureRefSchema,
  lane: z.enum(['terminating', 'continuing_sibling']),
  pose: FramePoseSchema,
});

/** On an opposing-direction lane. */
export const OpposingRoleSchema = z.strictObject({
  ...roleBase,
  kind: z.literal('opposing'),
  /** Lane index counted from the centreline into the opposing carriageway. */
  k: z.number().int().min(0).max(8).default(0),
  pose: FramePoseSchema,
});

/**
 * At a junction gate whose movement conflicts with the reference path.
 *
 * Placed by backing up from the precomputed conflict point until the declared
 * arrival relation holds — never by a literal `s`.
 */
export const ConflictingGateRoleSchema = z.strictObject({
  ...roleBase,
  kind: z.literal('conflicting_gate'),
  /** The junction feature this gate belongs to. */
  feature: FeatureRefSchema,
  from: ApproachRelationSchema,
  turn: TurnDirectionSchema,
  /**
   * The arrival relation to solve for. Omit it and the actor is placed at
   * `fallbackPose` (or the gate entry) with no timing guarantee — which is
   * almost always a mistake for a critical scenario.
   */
  arriveAtConflict: z
    .strictObject({
      relativeTo: RoleRefSchema,
      /** Seconds this actor reaches the conflict point after `relativeTo`. */
      deltaT: NumberOrExprSchema,
    })
    .optional(),
  /** Minimum connected approach distance required before the conflict gate. */
  requiredUpstreamRunwayM: NumberOrExprSchema.optional(),
  /** Used when `arriveAtConflict` is absent, or as the solver's starting guess. */
  fallbackPose: FramePoseSchema.optional(),
});

/** On a pedestrian crossing, parameterised by fraction across. */
export const OnCrossingRoleSchema = z.strictObject({
  ...roleBase,
  kind: z.literal('on_crossing'),
  feature: FeatureRefSchema,
  /** Where along the crossing the actor starts, 0 = near kerb, 1 = far kerb. */
  startFrac: z.number().min(0).max(1).default(0),
  /** Which way it faces/walks. */
  direction: z.enum(['near_to_far', 'far_to_near']).default('near_to_far'),
  /** Lateral position within the crossing width, fraction. */
  lateralFrac: z.number().min(-1).max(1).default(0),
});

/** In a parking zone — parked, or about to pull out. */
export const InParkingZoneRoleSchema = z.strictObject({
  ...roleBase,
  kind: z.literal('in_parking_zone'),
  feature: FeatureRefSchema,
  /**
   * Which space. `first`/`last` are relative to the corridor direction;
   * a number counts from the zone start. `any` lets the solver choose.
   */
  slot: z.union([z.number().int().min(0), z.enum(['first', 'last', 'any'])]).default('any'),
  /** Metres from the zone start, when the slot should be picked by distance. */
  offsetM: NumberOrExprSchema.optional(),
  /** Faces along the corridor, or backed in. */
  facing: z.enum(['with_traffic', 'against_traffic', 'perpendicular']).default('with_traffic'),
});

/** Positioned relative to another role: `dLane` lanes over, `dsM` metres along. */
export const RelativeToRoleSchema = z.strictObject({
  ...roleBase,
  kind: z.literal('relative_to'),
  ref: RoleRefSchema,
  /** Lane delta relative to `ref` (positive = to its left). */
  dLane: z.number().int().min(-8).max(8).default(0),
  /** Longitudinal delta, metres (positive = ahead of `ref`). */
  dsM: NumberOrExprSchema,
  /** Lateral offset within the resulting lane, fraction of width. */
  tFrac: z.number().min(-1).max(1).default(0),
  headingOffsetRad: z.number().min(-Math.PI).max(Math.PI).default(0),
});

/**
 * A pose in absolute scene coordinates — **not portable**.
 *
 * This kind exists for exactly one reason: a v1 document is a list of
 * absolutely-posed entities, and migrating one has to preserve those poses
 * without inventing frame coordinates it cannot know (converting `(x, y, z)` to
 * `(k, s, tFrac)` requires the map's lane graph, which lives in `map-intel`,
 * not here). Rather than guess — and silently move a car into a hedge — the
 * migration keeps the exact v1 pose in a role kind whose name says it does not
 * transfer.
 *
 * The structural validator reports `non_portable_role` for every one of these,
 * and `pin_required` when the anchor is not pinned, so a migrated document is
 * loud about being map-bound until an author (or `map-intel`'s anchor-lift)
 * rebinds it.
 */
export const SceneAbsoluteRoleSchema = z.strictObject({
  ...roleBase,
  kind: z.literal('scene_absolute'),
  /** Scene-frame pose, metres y-up, heading CCW about +Y — the v1 convention. */
  pose: V1PoseSchema,
  /** The v1 lane anchor, when the entity was placed by lane snapping. */
  laneRef: V1LaneRefSchema.optional(),
  /** Exact map-bound route available synchronously to playback and overlays. */
  initialRoute: SceneAbsoluteInitialRouteSchema.optional(),
});

/** Any role binding. */
export const RoleBindingSchema = z.discriminatedUnion('kind', [
  OnReferenceRoleSchema,
  LaneOffsetRoleSchema,
  AtLaneDropRoleSchema,
  OpposingRoleSchema,
  ConflictingGateRoleSchema,
  OnCrossingRoleSchema,
  InParkingZoneRoleSchema,
  RelativeToRoleSchema,
  SceneAbsoluteRoleSchema,
]);

/** Role kinds that survive retargeting onto another map. */
export const PORTABLE_ROLE_KINDS = [
  'on_reference',
  'lane_offset',
  'at_lane_drop',
  'opposing',
  'conflicting_gate',
  'on_crossing',
  'in_parking_zone',
  'relative_to',
] as const;

/** A role binding. */
export type RoleBinding = z.infer<typeof RoleBindingSchema>;
/** A role binding as authored. */
export type RoleBindingInput = z.input<typeof RoleBindingSchema>;
/** Actor specification. */
export type ActorSpec = z.infer<typeof ActorSpecSchema>;
/** Actor class. */
export type ActorClass = z.infer<typeof ActorClassSchema>;
/** Initial route owned by a map-bound actor rather than the timeline. */
export type SceneAbsoluteInitialRoute = z.infer<typeof SceneAbsoluteInitialRouteSchema>;

/** The pose a role declares, when its kind has one. */
export function rolePose(role: RoleBinding): FramePose | undefined {
  switch (role.kind) {
    case 'on_reference':
    case 'opposing':
      return role.pose;
    case 'lane_offset':
      return { ...role.pose, laneOffset: role.k };
    case 'at_lane_drop':
      return role.pose;
    case 'conflicting_gate':
      return role.fallbackPose;
    case 'on_crossing':
    case 'in_parking_zone':
    case 'relative_to':
    case 'scene_absolute':
      return undefined;
  }
}

/** True when the role can be re-placed on another map. */
export function isPortableRole(role: RoleBinding): boolean {
  return role.kind !== 'scene_absolute';
}

/** Footprint used by geometric checks: explicit dims, else the class default. */
export function roleDims(role: RoleBinding): { length: number; width: number; height: number } {
  return role.actor.dims ?? DEFAULT_ACTOR_DIMS[role.actor.class];
}
