/**
 * Mutable per-tick simulation state.
 *
 * Runtime objects are plain mutable records rather than immutable snapshots:
 * the engine is a tight fixed-step loop and allocation churn shows up directly
 * in the ticks/sec budget. Determinism comes from *iteration order* (every fan
 * out is over a sorted id list) not from immutability.
 */

import type { Vec2 } from '../core/math.js';
import type { Route } from '../map/route.js';
import type { LaneRsl } from '../map/topology.js';
import type {
  ActorKind,
  ActorRules,
  Dims,
  Dynamics,
  Interaction,
  TurnRelation,
} from '../schema/input.js';

/** The five axes. `set` owns one axis per key so two `set`s of different keys
 * coexist, matching "one axis, one owner" without over-serialising state. */
export type AxisId = 'longitudinal' | 'lateral' | 'route' | 'existence' | `state:${string}`;

export function axisOf(interaction: Interaction): AxisId {
  switch (interaction.verb) {
    case 'speed':
    case 'gap':
      return 'longitudinal';
    case 'changeLane':
    case 'laneOffset':
      return 'lateral';
    case 'route':
      return 'route';
    case 'exist':
      return 'existence';
    case 'set':
      return `state:${interaction.target.key}`;
  }
}

export interface LongitudinalCommand {
  readonly kind: 'speed' | 'gap';
  readonly interactionId: string;
  readonly firedAt: number;
  readonly dynamics: Dynamics;
  /** Speed at fire time, m/s — the profile's start value. */
  readonly v0: number;
  /** Profile duration in seconds, frozen at fire time. */
  duration: number;
  /** Resolved absolute target, m/s. Re-evaluated per tick for `match`/`gap`. */
  target: number;
  /** `gap` only. */
  readonly gap?: { actorId: string; value: number; mode: 'time' | 'distance' };
  /** `speed` only — kept so `match` can be re-resolved. */
  readonly speedTarget?: Interaction & { verb: 'speed' };
  /** `speed` only — cruise state to restore when an explicit `until` releases it. */
  readonly priorCruiseOverrideMps?: number | null;
}

export interface LateralCommand {
  readonly kind: 'changeLane' | 'laneOffset';
  readonly interactionId: string;
  readonly firedAt: number;
  readonly dynamics: Dynamics;
  readonly from: number;
  readonly to: number;
  duration: number;
  /** `changeLane` only: the route to adopt once the profile completes. */
  pending?: { route: Route; s: number; separationM: number; targetRsl: LaneRsl | null };
  /** Remaining lane changes for a multi-lane `count`. */
  remaining: number;
  side?: 'left' | 'right';
  done: boolean;
}

/** Per-actor memory for a static stop control. Each actor stops once, dwells,
 * then remains released for that control id. */
export interface RoadControlRuntimeState {
  stoppedSinceS: number | null;
  released: boolean;
  /** First tick at rest at this control. Used for deterministic FIFO order. */
  arrivedAtS: number | null;
  /** Release/commit time; retained until the actor clears the junction. */
  releasedAtS: number | null;
  /** A red/stop release includes a small seeded perception/start delay. */
  proceedAfterS: number | null;
  /** True after this actor has been held by a signal indication. */
  wasBlocked: boolean;
}

/** Small deterministic variation, not a second simulation model. The same
 * profile is used by authored and ambient road actors whenever an explicit
 * timeline command is not owning longitudinal motion. */
export interface DriverBehaviorProfile {
  readonly naturalistic: boolean;
  readonly desiredSpeedFactor: number;
  readonly timeHeadwayS: number;
  readonly minimumGapM: number;
  readonly accelScale: number;
  readonly comfortBrakeScale: number;
  readonly reactionTimeS: number;
  readonly startDelayS: number;
  readonly comfortableLateralAccelerationMps2: number;
  readonly comfortableDecelerationMps2: number;
}

export interface ActorRuntime {
  readonly id: string;
  readonly kind: ActorKind;
  readonly dims: Dims;
  readonly tags: readonly string[];
  /** Excluded from pair metrics; still collides and occludes. */
  readonly static: boolean;
  rules: ActorRules;
  readonly driver?: DriverBehaviorProfile;
  /** Free-flow cruise speed, m/s (recomputed when `speedFactor` changes). */
  cruiseSpeedMps: number;
  cruiseOverrideMps: number | null;

  route: Route;
  routeS: number;
  /** Exact absolute-time world keyframes; cleared permanently on collision. */
  timedRoute: readonly { timeS: number; point: Vec2 }[] | null;
  /** Literal editor-authored polyline: bypass traffic governors, but not physical contact. */
  bestEffortWorldPath: boolean;
  /** Remaining turn preferences, consumed when a route is rebuilt. */
  remainingTurns: TurnRelation[];

  speedMps: number;
  accelMps2: number;
  /** Measured body offset from the active route. Dynamic backends alone own it. */
  lateralOffsetM: number;
  /** Authored minimum-jerk reference, independent of the measured body pose. */
  lateralReferenceOffsetM: number;
  lateralReferenceRateMps: number;
  lateralReferenceAccelMps2: number;
  /** Stable lane-relative offset retained after a completed laneOffset action. */
  lateralRestOffsetM?: number;
  lateralRateMps: number;
  /** Lateral acceleration retained so the fixed-step controller can bound jerk. */
  lateralAccelMps2?: number;

  position: Vec2;
  headingRad: number;

  present: boolean;
  /** `true` once route motion finished; a pedestrian may remain visibly present. */
  retired: boolean;

  longCmd: LongitudinalCommand | null;
  latCmd: LateralCommand | null;
  /** `until` conditions keyed by axis, released when satisfied. */
  untilByAxis: Map<AxisId, { interactionId: string; condition: NonNullable<Interaction['until']> }>;

  /** `set()` registry — the authoritative store for `lights.*`, `doors.*`, … */
  stateKeys: Map<string, boolean | number | string>;

  /** Static stop-sign progress keyed by RoadControl.id. */
  roadControlStates: Map<string, RoadControlRuntimeState>;

  /**
   * Selected gear. `1` = forward, `-1` = reverse.
   *
   * Reverse is a *gear*, not a negative speed. `speedMps` is a magnitude
   * everywhere downstream — TTC, required-decel, min-clearance, the exporters —
   * so signing it would quietly corrupt all of them. The direction of travel
   * lives here instead, and the whole engine reads it through
   * `isReverseMotion()`.
   *
   * The governing invariant: **the route is the path the body travels**. In
   * reverse the body traverses that same path rear-first, so `routeS` still
   * advances and the body heading is `routeTangent + PI`. The heading is never
   * flipped away from that — an oriented bounding box, a clearance measurement
   * and a render all read `headingRad` directly.
   */
  motionDirection: 1 | -1;
  /**
   * Whether this body has ever actually driven.
   *
   * Before it has, its heading is a *placement* — whichever way the author or
   * the materializer happened to point a parked car — and selecting reverse
   * means "you are parked nose-in, come out backwards", so the heading is
   * re-derived from the route. After it has driven, the heading is a physical
   * outcome that cannot be rewritten, and selecting reverse means "back down
   * the path you just came up", so the route is reversed instead. Both give
   * `heading == routeTangent + PI`; only one of them is legal at a time.
   */
  hasMoved: boolean;
  /**
   * A gear selection that has been requested but not yet engaged.
   *
   * A gearbox cannot select reverse at road speed. Applying the request
   * immediately would teleport momentum (the dynamic solver clamps
   * `direction * v < 0` to zero), so the request is held here until the body is
   * at rest and engaged then. `null` means no shift is outstanding.
   */
  pendingMotionDirection: 1 | -1 | null;

  standstillSinceS: number | null;
  /** Running max of the decel that would have been required to stay safe. */
  requiredDecelMax: number;
  /** Latched after the first material contact; propulsion never resumes. */
  crashDisabledAtS?: number | null;
  crashDisabledReason?: string | null;
  /**
   * When a vulnerable body was knocked off its feet, or `null`/absent while it
   * is still standing.
   *
   * `crashDisabledAtS` already stops propulsion on contact, but a walker is a
   * bounded point agent that re-asserts its own velocity every substep: it
   * absorbs any impulse and keeps facing its route. That is right for a shove
   * it could recover from and wrong for being run over, so past a balance
   * threshold the body stops steering and carries the impulse instead. Renderers
   * derive fall progress from this timestamp; the engine keeps the body planar.
   */
  downedAtS?: number | null;
  /** The other body in the contact that took this one down. */
  downedByActorId?: string | null;
}

/** Circumscribed radius used by the coarse pair metrics (TTC, min distance). */
export function actorRadius(a: { dims: Dims }): number {
  return Math.hypot(a.dims.l, a.dims.w) / 2;
}

export interface WorldState {
  t: number;
  readonly dt: number;
  readonly actors: ActorRuntime[];
  readonly byId: Map<string, ActorRuntime>;
  /** Pairs that are currently overlapping, so a collision fires once. */
  readonly activeCollisions: Set<string>;
}
