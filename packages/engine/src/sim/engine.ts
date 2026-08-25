/**
 * The deterministic fixed-step simulation loop.
 *
 * ## Tick order (this *is* the determinism contract)
 *
 * 1. Detect OBB overlaps → the tick's collision set.
 * 2. Evaluate triggers in **sorted interaction-id order**; fire, preempt, skip.
 * 3. Evaluate `until` conditions; release axes.
 * 4. **Plan** every actor from the same frozen snapshot (sorted actor-id order).
 * 5. **Apply** all plans.
 * 6. Retire actors that ran out of route.
 * 7. Record the tick when `t ≥ 0`.
 *
 * Planning and applying are separate passes so no actor ever reads a neighbour
 * that has already stepped — the result is independent of actor declaration
 * order, which `determinism.test.ts` proves by permuting the input.
 *
 * Time is computed as `(i - warmupTicks) * dt` from an integer index rather
 * than accumulated, so `t = 0` is exact and floating-point drift cannot shift a
 * trigger by a tick.
 */

import { angleDelta, clamp, obbCorners, obbOverlap, normalizeAngle, type Obb, type Vec2 } from '../core/math.js';
import { contentHash } from '../core/hash.js';
import { Rng } from '../core/rng.js';
import { localFromScene, toSceneXZ } from '../frames.js';
import { SurfaceField } from '../environment.js';
import { issue, SimEngineError, type SimIssue } from '../errors.js';
import type { LaneGraph } from '../map/lane-graph.js';
import type { LaneRsl } from '../map/topology.js';
import {
  buildFollowRoute,
  buildRoute,
  retargetToLane,
  retargetToNeighbour,
  Route,
  type RoutePose,
} from '../map/route.js';
import {
  normalizeSimScenarioInput,
  resolvePhysicsConfig,
  isKnockdownVulnerableKind,
  isPedestrianLikeKind,
  isRoadActorKind,
  type Dynamics,
  type Interaction,
  type SimActor,
  type SimScenarioInput,
  type ResolvedPhysicsConfig,
  type StaticProp,
  type TurnRelation,
} from '../schema/input.js';
import { ENGINE_VERSION } from '../version.js';
import {
  cruiseSpeed,
  distanceToStopLine,
  findLeader,
  governorCap,
  headingWithSlip,
  lateralStep,
  minimumJerkSample,
  limitsFor,
  longitudinalAccel,
  desiredGapM,
} from './controllers.js';
import { transitionDuration, transitionValue } from './dynamics.js';
import {
  GEAR_ENGAGE_SPEED_MPS,
  MOTION_GEAR_ENGAGED_KEY,
  MOTION_GEAR_KEY,
  REVERSE_SPAWN_HEADING_TOL_RAD,
  gearOfMotionDirection,
  governSpeedForGear,
  initialMotionDirection,
  motionDirectionOfGear,
} from './gear.js';
import type { CollisionImpulse } from './collision-response.js';
import {
  ACTOR_PHYSICS_PROFILES,
  BALANCE_RECOVERY_DELTA_V_MPS,
  DynamicV1Backend,
  DYNAMIC_V1_DEFAULT_SUBSTEP_S,
} from './dynamic-v1.js';
import { corneringPlan } from './cornering.js';
import type { MotionBackend, MotionIntent, PhysicsTelemetrySample, VehicleControl } from './motion-backend.js';
import { actorPhysicsBackends } from './physics-provenance.js';
import {
  articulatedDoorObb,
  alongRouteDistance,
  alongRouteGapM,
  DOOR_OPEN_DURATION_S,
  isReverseMotion,
  pairKey,
  sweptObbTimeOfImpact,
  type DoorName,
} from './pairs.js';
import { resolveOverlappingControlLanes, SignalBook } from './signals.js';
import { spatialCandidatePairs, type SpatialBounds } from './spatial.js';
import {
  axisOf,
  type ActorRuntime,
  type AxisId,
  type LateralCommand,
  type LongitudinalCommand,
  type WorldState,
} from './state.js';
import {
  makeTriggerRuntime,
  shouldFire,
  triggerPredicateValue,
  type ConditionContext,
  type TriggerRuntime,
} from './triggers.js';
import { evaluateCondition } from './triggers.js';
import { buildOccluders, hasLineOfSight, type OccluderShape } from './visibility.js';
import { DEFAULT_PERCEPTION_CONFIG } from '../perception/schema.js';
import { PerceptionRuntime, type PerceptionActorView } from '../perception/runtime.js';
import { TRACE_FORMAT_VERSION, type ActorTrack, type SignalTrack, type SimEvent, type SimTrace } from '../trace/trace.js';
import {
  buildSemanticLedger,
  semanticResolvedRouteRef,
  type TriggerTruthTransition,
} from '../trace/semantic-ledger.js';
import { computeMetrics, type MetricAccumulator, newMetricAccumulator, observeTick } from '../trace/metrics.js';
import { checkFeasibility } from '../solve/guards.js';
import { resolveArrivalTriggers, type ArrivalSolution } from '../solve/arrival.js';
import type { StaticMapCollider } from './static-colliders.js';

export interface RunOptions {
  readonly graph: LaneGraph;
  /** Deterministic low-complexity collision proxies extracted from the map. */
  readonly staticColliders?: readonly StaticMapCollider[];
  /**
   * `throw` (default) aborts on any error-severity feasibility issue, `collect`
   * runs anyway and returns them, `skip` does not check.
   */
  readonly guards?: 'throw' | 'collect' | 'skip';
  /** Pre-solve `arrival` triggers into fixed times + spawn-s offsets. */
  readonly resolveArrival?: boolean;
  /**
   * Include negative warm-up samples in trace tracks. Metrics and authored
   * triggers remain scoped to the recorded clip; this is intended for exact
   * interchange replay, where ASAM time zero is the start of warm-up.
   */
  readonly includeWarmupTrace?: boolean;
  /**
   * Deterministic per-tick action overrides applied in `planActor` before the
   * motion backend steps. See {@link ActionHook}.
   */
  readonly actionHook?: ActionHook;
  /**
   * How generated background traffic responds to a policy-controlled ego.
   *
   * `'scripted'` (default) keeps the authored-run behaviour byte-for-byte:
   * ambient actors were placed and settled against the authored choreography,
   * and their planning scans the full actor list exactly as before.
   *
   * `'reactive'` re-evaluates cruise/gap/yield control for ambient actors
   * against the current world state each planning tick, over a spatially
   * pruned nearby set (`O(actors × nearby-actors)`), and additionally treats a
   * body whose pose no longer resolves through lane storage — a dynamic ego
   * deviating from its authored route — as a physical leader/yield target.
   */
  readonly ambientReactivity?: 'scripted' | 'reactive';
}

/**
 * Context handed to an {@link ActionHook} for one actor on one planning tick.
 */
export interface ActionHookContext {
  readonly actorId: string;
  /** Simulation time of the tick being planned; negative during warm-up. */
  readonly tS: number;
}

/**
 * Caller-supplied override of the choreography intent for one actor on one
 * tick. Present fields replace the engine-computed setpoints just before the
 * motion backend steps; omitted fields keep the authored behavior.
 * `previewPoint`/`previewHeadingRad` redirect the dynamic backend's
 * pure-pursuit steering off the authored route (trajectory-following
 * executors set both; see sim/trajectory-follower.ts). `control`
 * additionally bypasses the dynamic backend's setpoint controller while
 * staying inside the profile's steer clamp/rate/lag and jerk envelope (see
 * `MotionIntent.control`).
 */
export type ActionOverride = Partial<
  Pick<MotionIntent, 'motionDirection' | 'targetSpeedMps' | 'targetAccelerationMps2' | 'previewPoint' | 'previewHeadingRad'>
> & {
  readonly control?: VehicleControl;
};

/**
 * Deterministic external action channel. The hook is consulted once per
 * actor per planning tick, in the engine's sorted-actor-id order, and never
 * reads wall time — injecting the same sequence into two sessions therefore
 * yields byte-identical traces (proven by `action-hook-determinism.test.ts`).
 */
export type ActionHook = (context: ActionHookContext) => ActionOverride | undefined;

export interface EngineTickObservation {
  /** Simulation time of the completed tick (negative during warm-up). */
  readonly tS: number;
  /** Absolute engine tick index (0 = first warm-up tick). */
  readonly tickIndex: number;
  /** Read-only per-actor state exactly as {@link peek} would report it. */
  readonly actors: readonly SessionActorSnapshot[];
}

/**
 * Deterministic per-tick observer invoked once after each completed engine
 * tick inside {@link FixedStepSimulationSession.advance}. The observer sees
 * frozen snapshot data and cannot influence simulation state, so traces are
 * byte-identical whether or not one is attached.
 */
export type TickObserver = (observation: EngineTickObservation) => void;

export interface AdvanceOptions {
  /**
   * Build the full trace before returning. Mid-episode traces are expensive;
   * leave this unset to receive a trace only once the episode is complete
   * (`done`). Interactive consumers should use {@link FixedStepSimulationSession.peek}
   * for cheap read-only state between batches.
   */
  readonly trace?: boolean;
  /** Invoked after every completed tick when set (live scene streams). */
  readonly onTick?: TickObserver;
}

/** Read-only per-actor state, safe to inspect between batches. */
export interface SessionActorSnapshot {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly headingRad: number;
  readonly speedMps: number;
  readonly accelMps2: number;
  /** Whether the actor exists in the world at this instant (spawn/despawn truth). */
  readonly present: boolean;
  /** Lane-relative lateral offset, metres (positive = left). */
  readonly lateralOffsetM: number;
  readonly lateralRateMps: number;
  /** Route arc length, metres. */
  readonly s: number;
  /** Lane the actor's current route station resolves to; `null` when freeform. */
  readonly laneRsl: string | null;
}

/** Running episode minima for one monitored pair, as of the snapshot. */
export interface SessionPairMinima {
  readonly a: string;
  readonly b: string;
  readonly minDistanceM: number;
  readonly minTtcS: number;
  readonly minPathTtcS: number;
  readonly minPetS: number;
}

/** Read-only world snapshot; never builds a trace and never mutates state. */
export interface SimulationSnapshot {
  /** Simulation time of the snapshot; negative during warm-up. */
  readonly tS: number;
  readonly done: boolean;
  readonly actors: readonly SessionActorSnapshot[];
  /** `Infinity` means the episode has not produced a sample for that pair yet. */
  readonly minima: readonly SessionPairMinima[];
}

export interface SimResult {
  /**
   * Exact canonical input executed by the engine after deterministic
   * normalization and control/arrival resolution. Persist this alongside the
   * trace: `contentHash(input)` is the identity recorded by
   * `trace.header.inputHash`.
   */
  readonly input: SimScenarioInput;
  readonly trace: SimTrace;
  readonly issues: SimIssue[];
  readonly arrival: ArrivalSolution[];
}

export interface FixedStepSimulationProgress extends Omit<SimResult, 'trace'> {
  /**
   * The full episode trace. Non-null once the episode is complete or when the
   * caller explicitly requested a mid-episode trace via `advance(…, { trace:
   * true })`; otherwise `null` so the stepping path never pays for
   * `buildTrace` per batch. Use `peek()` for cheap read-only state instead.
   */
  readonly trace: SimTrace | null;
  readonly done: boolean;
  readonly recordedUntil: number | null;
}

/**
 * A resumable view of the canonical fixed-step engine. Interactive consumers
 * may yield between batches without changing tick order or numerical results.
 * Calling `advance` after completion is safe and returns the completed trace.
 */
export interface FixedStepSimulationSession {
  readonly done: boolean;
  advance(maxTicks?: number, opts?: AdvanceOptions): FixedStepSimulationProgress;
  /** Read-only world snapshot (poses, speeds, running metric minima). */
  peek(): SimulationSnapshot;
  /**
   * The engine's own {@link SignalBook} — the same instance runtime
   * `signal:*.phase` overrides land in, so external observers snapshot
   * exactly the law the simulation obeys.
   */
  signalBook(): SignalBook;
  /**
   * Events recorded since the previous call, in record order. Purely a
   * session-side read: the trace's event list is untouched either way, so
   * digests are identical whether or not the caller drains mid-episode.
   */
  drainEvents(): readonly SimEvent[];
}

/** Moving actors this close to the end are clamped to the terminal pose. */
const ROUTE_END_SLACK_M = 0.01;
/** How far a freeform-routed body must move before its lane binding is re-solved. */
const FREEFORM_LANE_REBIND_M = 1;
/** Lookahead used for the stop-line search and the crossing-conflict scan. */
const LOOKAHEAD_M = 80;
/** Reactive ambient leader scan: how far a generated follower looks, and the
 * grid cell of the per-tick broadphase. The scan radius matches the stop-line
 * lookahead plus margin so gap control never loses a leader the scripted scan
 * would have found at planning-relevant distances. */
const REACTIVE_SCAN_RADIUS_M = LOOKAHEAD_M + 40;
const REACTIVE_GRID_CELL_M = 40;
/** Same-lane corridor used by the reactive leader observation (controllers.findLeader default). */
const LEADER_CORRIDOR_HALF_WIDTH_M = 1.6;
/** Squared scan radius so the leader loop can reject far bodies without a sqrt. */
const REACTIVE_MAX_RANGE_M2 = REACTIVE_SCAN_RADIUS_M * REACTIVE_SCAN_RADIUS_M;
/** Conflict scan: samples per actor, and the spacing between them. */
const CONFLICT_SAMPLES = 14;
const CONFLICT_STEP_M = 5;
/** Two future paths closer than this count as crossing. */
const CONFLICT_RADIUS_M = 2.5;
/** Arrival-time separation below which a yielding actor gives way. */
const CONFLICT_WINDOW_S = 2.5;
/** Below this heading difference two actors are following, not crossing. */
const CONFLICT_MIN_ANGLE_RAD = 0.4;
/** Uniform-grid size; larger than ordinary road-user footprints and one tick's motion. */
const COLLISION_GRID_CELL_M = 20;
/** Straight-ahead runway used after the final timed position releases to physics. */
const TIMED_ROUTE_RELEASE_RUNWAY_M = 2_000;

function collisionGridCells(bounds: Omit<SpatialBounds, 'id'> | SpatialBounds): string[] {
  const x0 = Math.floor(bounds.minX / COLLISION_GRID_CELL_M);
  const x1 = Math.floor(bounds.maxX / COLLISION_GRID_CELL_M);
  const y0 = Math.floor(bounds.minY / COLLISION_GRID_CELL_M);
  const y1 = Math.floor(bounds.maxY / COLLISION_GRID_CELL_M);
  const cells: string[] = [];
  for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) cells.push(`${x},${y}`);
  return cells;
}
/** Future-path bounds are up to ~65 m long; this keeps most roads in a few cells. */
const CONFLICT_GRID_CELL_M = 40;
const DYNAMIC_LATERAL_SETTLE_POSITION_M = 0.05;
const DYNAMIC_LATERAL_SETTLE_RATE_MPS = 0.1;
const DYNAMIC_LATERAL_SETTLE_HEADING_RAD = 2 * Math.PI / 180;

interface Plan {
  readonly actor: ActorRuntime;
  speed: number;
  accel: number;
  routeS: number;
  lateralOffset: number;
  lateralRate: number;
  lateralAccel: number;
  /** Authored Frenet reference; never a measured dynamic body state. */
  lateralReferenceOffset: number;
  lateralReferenceRate: number;
  lateralReferenceAccel: number;
  lateralComplete: boolean;
  lateralTrackingExpired: null | {
    positionErrorM: number;
    rateErrorMps: number;
    headingErrorRad: number;
  };
  position: Vec2;
  heading: number;
  requiredDecel: number;
  retire: boolean;
  /** Completed lane change: swap the route after the apply pass. */
  swap: { route: Route; s: number; separationM: number; targetRsl: string | null } | null;
}

interface CollisionSnapshot {
  readonly shapes: ReadonlyMap<string, Obb>;
  readonly live: boolean;
}

interface TimedRouteSample {
  readonly position: Vec2;
  readonly headingRad: number;
  readonly speedMps: number;
}

interface TimedRouteKinematics extends TimedRouteSample {
  readonly velocity: Vec2;
  readonly acceleration: Vec2;
}

const TIMED_ROUTE_SPEED_ENVELOPE_MPS: Readonly<Record<ActorRuntime['kind'], number>> = {
  vehicle: 55,
  car: 55,
  truck: 36,
  bus: 32,
  van: 45,
  motorcycle: 60,
  bicycle: 16,
  pedestrian: 4.5,
  scooter: 12,
  sidewalk_robot: 4,
  drone: 30,
  animal: 15,
  static_object: 0,
};

function timedRouteTangent(
  points: NonNullable<ActorRuntime['timedRoute']>,
  index: number,
): Vec2 {
  const point = points[index]!;
  if (index === 0) {
    const next = points[1]!;
    const dt = next.timeS - point.timeS;
    return dt > 0
      ? { x: (next.point.x - point.point.x) / dt, y: (next.point.y - point.point.y) / dt }
      : { x: 0, y: 0 };
  }
  if (index === points.length - 1) {
    const previous = points[index - 1]!;
    const dt = point.timeS - previous.timeS;
    return dt > 0
      ? { x: (point.point.x - previous.point.x) / dt, y: (point.point.y - previous.point.y) / dt }
      : { x: 0, y: 0 };
  }

  const previous = points[index - 1]!;
  const next = points[index + 1]!;
  const incomingDt = point.timeS - previous.timeS;
  const outgoingDt = next.timeS - point.timeS;
  if (incomingDt <= 0 || outgoingDt <= 0) return { x: 0, y: 0 };
  const incoming = {
    x: (point.point.x - previous.point.x) / incomingDt,
    y: (point.point.y - previous.point.y) / incomingDt,
  };
  const outgoing = {
    x: (next.point.x - point.point.x) / outgoingDt,
    y: (next.point.y - point.point.y) / outgoingDt,
  };
  const incomingSpeed = Math.hypot(incoming.x, incoming.y);
  const outgoingSpeed = Math.hypot(outgoing.x, outgoing.y);
  if (incomingSpeed < 1e-9 || outgoingSpeed < 1e-9) return { x: 0, y: 0 };
  const direction = {
    x: incoming.x / incomingSpeed + outgoing.x / outgoingSpeed,
    y: incoming.y / incomingSpeed + outgoing.y / outgoingSpeed,
  };
  const directionLength = Math.hypot(direction.x, direction.y);
  if (directionLength < 1e-6) return { x: 0, y: 0 };
  // The harmonic mean keeps the tangent below the faster adjacent segment.
  // Averaging unit directions rounds the corner without skipping the waypoint.
  const speed = (2 * incomingSpeed * outgoingSpeed) / (incomingSpeed + outgoingSpeed);
  return {
    x: direction.x / directionLength * speed,
    y: direction.y / directionLength * speed,
  };
}

function timedRouteSegmentKinematics(
  points: NonNullable<ActorRuntime['timedRoute']>,
  segmentIndex: number,
  fraction: number,
): TimedRouteKinematics {
  const from = points[segmentIndex]!;
  const to = points[segmentIndex + 1]!;
  const durationS = to.timeS - from.timeS;
  const u = clamp(fraction, 0, 1);
  const u2 = u * u;
  const u3 = u2 * u;
  const fromTangent = timedRouteTangent(points, segmentIndex);
  const toTangent = timedRouteTangent(points, segmentIndex + 1);
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  const position = {
    x: h00 * from.point.x + h10 * durationS * fromTangent.x + h01 * to.point.x + h11 * durationS * toTangent.x,
    y: h00 * from.point.y + h10 * durationS * fromTangent.y + h01 * to.point.y + h11 * durationS * toTangent.y,
  };
  const dh00 = 6 * u2 - 6 * u;
  const dh10 = 3 * u2 - 4 * u + 1;
  const dh01 = -6 * u2 + 6 * u;
  const dh11 = 3 * u2 - 2 * u;
  const velocity = durationS > 0 ? {
    x: (dh00 * from.point.x + dh10 * durationS * fromTangent.x + dh01 * to.point.x + dh11 * durationS * toTangent.x) / durationS,
    y: (dh00 * from.point.y + dh10 * durationS * fromTangent.y + dh01 * to.point.y + dh11 * durationS * toTangent.y) / durationS,
  } : { x: 0, y: 0 };
  const ddh00 = 12 * u - 6;
  const ddh10 = 6 * u - 4;
  const ddh01 = -12 * u + 6;
  const ddh11 = 6 * u - 2;
  const acceleration = durationS > 0 ? {
    x: (ddh00 * from.point.x + ddh10 * durationS * fromTangent.x + ddh01 * to.point.x + ddh11 * durationS * toTangent.x) / (durationS * durationS),
    y: (ddh00 * from.point.y + ddh10 * durationS * fromTangent.y + ddh01 * to.point.y + ddh11 * durationS * toTangent.y) / (durationS * durationS),
  } : { x: 0, y: 0 };
  const speedMps = Math.hypot(velocity.x, velocity.y);
  return {
    position,
    velocity,
    acceleration,
    speedMps,
    headingRad: speedMps > 1e-8 ? Math.atan2(velocity.y, velocity.x) : 0,
  };
}

function sampleTimedRoute(
  points: NonNullable<ActorRuntime['timedRoute']>,
  timeS: number,
  fallbackHeadingRad: number,
): TimedRouteSample {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (timeS < first.timeS) {
    const next = points[1]!;
    return {
      position: first.point,
      headingRad: Math.atan2(next.point.y - first.point.y, next.point.x - first.point.x),
      speedMps: 0,
    };
  }
  if (timeS > last.timeS) {
    const previous = points[points.length - 2]!;
    return {
      position: last.point,
      headingRad: Math.atan2(last.point.y - previous.point.y, last.point.x - previous.point.x),
      speedMps: 0,
    };
  }
  let nextIndex = 1;
  while (points[nextIndex]!.timeS < timeS) nextIndex += 1;
  const segmentIndex = nextIndex - 1;
  const from = points[segmentIndex]!;
  const to = points[nextIndex]!;
  const fraction = (timeS - from.timeS) / (to.timeS - from.timeS);
  if (Math.hypot(to.point.x - from.point.x, to.point.y - from.point.y) <= 1e-6) {
    return { position: from.point, headingRad: fallbackHeadingRad, speedMps: 0 };
  }
  const sample = timedRouteSegmentKinematics(points, segmentIndex, fraction);
  return sample.speedMps > 1e-8 ? sample : { ...sample, headingRad: fallbackHeadingRad };
}

/**
 * Timed points own pose only through their final timestamp. Once released, a
 * freeform runway gives the motion backend somewhere to continue naturally
 * with the terminal speed and heading instead of treating the last point as a
 * permanent route end.
 */
function releasedTimedRoute(
  points: NonNullable<ActorRuntime['timedRoute']>,
  fallbackHeadingRad: number,
): Route {
  const last = points.at(-1)!;
  let previous = points.at(-2)!;
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const candidate = points[index]!;
    if (Math.hypot(last.point.x - candidate.point.x, last.point.y - candidate.point.y) > 1e-6) {
      previous = candidate;
      break;
    }
  }
  const dx = last.point.x - previous.point.x;
  const dy = last.point.y - previous.point.y;
  const length = Math.hypot(dx, dy);
  const direction = length > 1e-6
    ? { x: dx / length, y: dy / length }
    : { x: Math.cos(fallbackHeadingRad), y: Math.sin(fallbackHeadingRad) };
  return Route.fromPolyline([
    last.point,
    {
      x: last.point.x + direction.x * TIMED_ROUTE_RELEASE_RUNWAY_M,
      y: last.point.y + direction.y * TIMED_ROUTE_RELEASE_RUNWAY_M,
    },
  ]);
}

function timedRouteFeasibilityIssues(
  actor: Pick<ActorRuntime, 'id' | 'kind' | 'driver' | 'timedRoute'>,
  path: string,
): SimIssue[] {
  const points = actor.timedRoute;
  if (!points || points.length < 2 || actor.kind === 'static_object') return [];
  const limits = limitsFor(actor);
  const speedEnvelopeMps = TIMED_ROUTE_SPEED_ENVELOPE_MPS[actor.kind];
  const lateralEnvelopeMps2 = Math.max(
    limits.lateralAccelMax,
    (actor.driver?.comfortableLateralAccelerationMps2 ?? limits.lateralAccelMax) * 1.5,
  );
  let maxSpeed = { value: 0, segment: 0 };
  let maxLongitudinalAcceleration = { value: 0, segment: 0 };
  let maxLateralAcceleration = { value: 0, segment: 0 };
  for (let segment = 0; segment < points.length - 1; segment += 1) {
    for (let sample = 0; sample <= 16; sample += 1) {
      const state = timedRouteSegmentKinematics(points, segment, sample / 16);
      if (state.speedMps > maxSpeed.value) maxSpeed = { value: state.speedMps, segment };
      if (state.speedMps < 1e-6) continue;
      const longitudinal = Math.abs(
        (state.velocity.x * state.acceleration.x + state.velocity.y * state.acceleration.y) / state.speedMps,
      );
      const lateral = Math.abs(
        (state.velocity.x * state.acceleration.y - state.velocity.y * state.acceleration.x) / state.speedMps,
      );
      if (longitudinal > maxLongitudinalAcceleration.value) {
        maxLongitudinalAcceleration = { value: longitudinal, segment };
      }
      if (lateral > maxLateralAcceleration.value) {
        maxLateralAcceleration = { value: lateral, segment };
      }
    }
  }

  const findings: SimIssue[] = [];
  if (maxSpeed.value > speedEnvelopeMps + 1e-6) {
    findings.push(issue(
      'timed_route_speed_unreachable',
      path,
      `timed waypoint ${maxSpeed.segment + 1} requires up to ${maxSpeed.value.toFixed(1)} m/s, above the ${speedEnvelopeMps.toFixed(1)} m/s ${actor.kind} envelope; add more time or move the point closer`,
      { actorId: actor.id, segmentIndex: maxSpeed.segment, requiredMps: maxSpeed.value, envelopeMps: speedEnvelopeMps },
      'warning',
    ));
  }
  const longitudinalEnvelopeMps2 = Math.max(limits.accelMax, limits.brakeHard);
  if (maxLongitudinalAcceleration.value > longitudinalEnvelopeMps2 + 1e-6) {
    findings.push(issue(
      'timed_route_acceleration_unreachable',
      path,
      `timed waypoint ${maxLongitudinalAcceleration.segment + 1} requires ${maxLongitudinalAcceleration.value.toFixed(1)} m/s² longitudinal acceleration, above the ${longitudinalEnvelopeMps2.toFixed(1)} m/s² ${actor.kind} envelope; add more time between points`,
      { actorId: actor.id, segmentIndex: maxLongitudinalAcceleration.segment, requiredMps2: maxLongitudinalAcceleration.value, envelopeMps2: longitudinalEnvelopeMps2 },
      'warning',
    ));
  }
  if (maxLateralAcceleration.value > lateralEnvelopeMps2 + 1e-6) {
    findings.push(issue(
      'timed_route_turn_unreachable',
      path,
      `timed waypoint ${maxLateralAcceleration.segment + 1} requires ${maxLateralAcceleration.value.toFixed(1)} m/s² lateral acceleration, above the ${lateralEnvelopeMps2.toFixed(1)} m/s² ${actor.kind} turning envelope; widen the turn or add more time`,
      { actorId: actor.id, segmentIndex: maxLateralAcceleration.segment, requiredMps2: maxLateralAcceleration.value, envelopeMps2: lateralEnvelopeMps2 },
      'warning',
    ));
  }
  return findings;
}

interface StaticCollisionShape {
  /** Namespaced collision id; concrete author identity is retained in prop metadata. */
  readonly id: string;
  readonly obb: Obb;
}

interface DoorRuntime {
  readonly actorId: string;
  readonly name: DoorName;
  from: number;
  target: number;
  startedT: number;
  durationS: number;
  transitioning: boolean;
}

export function runSimulation(input: SimScenarioInput, opts: RunOptions): SimResult {
  const sim = new Simulation(input, opts);
  return sim.run();
}

export function createFixedStepSimulation(
  input: SimScenarioInput,
  opts: RunOptions,
): FixedStepSimulationSession {
  return new Simulation(input, opts);
}

class Simulation {
  private readonly graph: LaneGraph;
  private readonly dt: number;
  private readonly warmupTicks: number;
  private readonly clipTicks: number;
  private readonly actors: ActorRuntime[] = [];
  private readonly byId = new Map<string, ActorRuntime>();
  private readonly triggers: TriggerRuntime[] = [];
  private readonly triggerById = new Map<string, TriggerRuntime>();
  private readonly signals: SignalBook;
  /** Grip as a field over the road, not one number for the whole scene. */
  private readonly surface: SurfaceField;
  private readonly occluders: OccluderShape[];
  private readonly actorOccluderIds: ReadonlySet<string>;
  private readonly collidableProps: StaticCollisionShape[];
  private readonly staticCollisionGrid = new Map<string, StaticCollisionShape[]>();
  private readonly attachedPropsByActor = new Map<string, StaticProp[]>();
  private readonly attachedOccluderIds: ReadonlySet<string>;
  private readonly events: SimEvent[] = [];
  /** Index into `events` of the first event not yet returned by `drainEvents`. */
  private drainedEventCount = 0;
  /** Predicate edge evidence, independent of action eligibility/forcing. */
  private readonly triggerTruthTransitions = new Map<string, TriggerTruthTransition[]>();
  /** Non-lateral legacy windows already released on their terminal tick. */
  private readonly releasedWindows = new Set<string>();
  private readonly lateralClampDiagnostics = new Set<string>();
  private readonly issues: SimIssue[] = [];
  private readonly tracks = new Map<string, ActorTrack>();
  /** Hash identity of the route actually owned by each actor on every sample. */
  private readonly initialRouteRefByActor = new Map<string, string>();
  private readonly routeRefByActor = new Map<string, string>();
  private readonly routeRefTracks = new Map<string, string[]>();
  private readonly signalTracks = new Map<string, SignalTrack>();
  private readonly tArray: number[] = [];
  private readonly metrics: MetricAccumulator;
  private readonly rng: Rng;
  private readonly resolvedInput: SimScenarioInput;
  private readonly physicsConfig: ResolvedPhysicsConfig;
  private readonly dynamicBackend: DynamicV1Backend | null;
  private readonly motionBackend: MotionBackend | null;
  private readonly dynamicActorIds = new Set<string>();
  private readonly physicsTelemetry = new Map<string, PhysicsTelemetrySample>();
  private readonly arrivalSolutions: ArrivalSolution[];
  /**
   * The perception pass. `null` when nothing declares a sensor or a map
   * divergence, so a document that never mentions perception produces exactly
   * the trace it produced before this layer existed.
   */
  private readonly perception: PerceptionRuntime | null;
  /** Preserve the authored-only engine path byte-for-byte unless ambient traffic exists. */
  private readonly hasAmbientTraffic: boolean;
  /**
   * Generated background road users, sorted. They are ordinary physical bodies
   * — followed, yielded to, and collidable — but they are never a subject of
   * episode criticality metrics, and the trace header publishes this set so an
   * external recomputation can make the same distinction.
   */
  private readonly ambientActorIds: string[];
  private readonly ambientActorIdSet: ReadonlySet<string>;
  /** Reactive ambient re-evaluation is active (opt-in, ambient actors only). */
  private readonly ambientReactive: boolean;
  /**
   * Per-planning-tick uniform grid of live bodies, rebuilt by
   * `buildNearbyIndex` when `ambientReactive`; queried by `nearbyActors`.
   */
  private reactiveGrid = new Map<string, ActorRuntime[]>();
  private world: WorldState;
  private conflictSamples = new Map<string, Vec2[]>();
  private conflictCandidates = new Map<string, ActorRuntime[]>();
  private collisionSnapshots = new Map<string, CollisionSnapshot>();
  private previousCollisionT: number | null = null;
  private readonly doors = new Map<string, DoorRuntime>();
  private nextTick = 0;
  private finished = false;

  constructor(rawInput: SimScenarioInput, private readonly opts: RunOptions) {
    this.graph = opts.graph;

    const normalized = normalizeSimScenarioInput(rawInput);
    const controlResolution = resolveOverlappingControlLanes(normalized, this.graph);
    const arrivalResult =
      opts.resolveArrival === false
        ? { input: controlResolution.input, solutions: [] as ArrivalSolution[], issues: [] as SimIssue[] }
        : resolveArrivalTriggers(controlResolution.input, this.graph);
    this.resolvedInput = arrivalResult.input;
    this.arrivalSolutions = arrivalResult.solutions;
    this.issues.push(...arrivalResult.issues);
    for (const repair of controlResolution.repairs) {
      this.issues.push(issue(
        'traffic_control_binding_repaired',
        `${repair.source}.${repair.controlId}`,
        `A coincident OpenDRIVE lane was bound to ${repair.routeRsl} so this route can obey the physical control. Choose an unambiguous lane when portability matters.`,
        { ...repair },
        'warning',
      ));
    }
    for (const actor of controlResolution.input.actors) {
      if (!actor.static && actor.behavior.rules.obeySignals && actor.behavior.route.kind === 'polyline') {
        this.issues.push(issue(
          'traffic_control_route_unbound',
          `actors.${actor.id}.behavior.route`,
          'This vehicle has a freeform route, so map stop signs and traffic signals cannot be applied. Move it onto a lane or choose an explicit violator profile.',
          { actorId: actor.id },
          'warning',
        ));
      }
    }

    const input = this.resolvedInput;
    this.dt = input.dt;
    this.warmupTicks = Math.round(input.warmupSeconds / input.dt);
    this.clipTicks = Math.round(input.clipSeconds / input.dt);
    this.rng = new Rng(input.seed);
    this.signals = new SignalBook(input.signalPrograms, input.warmupSeconds, input.roadControls);
    this.surface = new SurfaceField(
      input.operationalConditions.effects.frictionScale,
      input.surfacePatches,
    );
    this.physicsConfig = resolvePhysicsConfig(input);
    // An explicit `kinematic-v1` selection is honored exactly: no actor is
    // registered with the force backend and every moving body runs the
    // established route choreography. Omitted physics resolves to the
    // current default (`dynamic-v1`).
    this.dynamicBackend = this.physicsConfig.mode === 'dynamic-v1'
      ? new DynamicV1Backend(this.physicsConfig.substepS ?? DYNAMIC_V1_DEFAULT_SUBSTEP_S)
      : null;
    this.motionBackend = this.dynamicBackend;
    for (const id of this.signals.ids()) this.signalTracks.set(id, { phase: [] });
    this.attachedOccluderIds = new Set(
      input.props
        .filter((prop) => prop.attachment && input.occluders.some((occluder) => occluder.id === prop.id))
        .map((prop) => prop.id),
    );
    this.occluders = buildOccluders(input.occluders.filter((occluder) => !this.attachedOccluderIds.has(occluder.id)));
    this.actorOccluderIds = new Set(
      input.occlusionPairs
        .map((pair) => pair.occluderId)
        .filter((id): id is string => id?.startsWith('actor:') === true)
        .map((id) => id.slice('actor:'.length)),
    );
    this.collidableProps = input.props
      .filter((prop) => prop.collidable && !prop.attachment)
      .map((prop) => ({
        id: `prop:${prop.id}`,
        obb: {
          center: localFromScene(prop.pose),
          lengthM: prop.dims.l * prop.scale,
          widthM: prop.dims.w * prop.scale,
          headingRad: prop.pose.headingRad,
        },
      }));
    for (const collider of [...(opts.staticColliders ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
      this.collidableProps.push({
        id: `map:${collider.id}`,
        obb: {
          center: localFromScene(collider.obb.center),
          lengthM: collider.obb.lengthM,
          widthM: collider.obb.widthM,
          headingRad: collider.obb.headingRad,
        },
      });
    }
    for (const shape of this.collidableProps) {
      const corners = obbCorners(shape.obb);
      const minX = Math.min(...corners.map((point) => point.x));
      const maxX = Math.max(...corners.map((point) => point.x));
      const minY = Math.min(...corners.map((point) => point.y));
      const maxY = Math.max(...corners.map((point) => point.y));
      for (const cell of collisionGridCells({ minX, maxX, minY, maxY })) {
        const bucket = this.staticCollisionGrid.get(cell) ?? [];
        bucket.push(shape);
        this.staticCollisionGrid.set(cell, bucket);
      }
    }
    for (const bucket of this.staticCollisionGrid.values()) bucket.sort((a, b) => a.id.localeCompare(b.id));
    for (const prop of input.props) {
      if (!prop.attachment) continue;
      const bucket = this.attachedPropsByActor.get(prop.attachment.actorId) ?? [];
      bucket.push(prop);
      bucket.sort((a, b) => a.id.localeCompare(b.id));
      this.attachedPropsByActor.set(prop.attachment.actorId, bucket);
    }

    const guardMode = opts.guards ?? 'throw';
    if (guardMode !== 'skip') {
      const found = checkFeasibility(input, this.graph);
      this.issues.push(...found);
      if (guardMode === 'throw') {
        const errors = found.filter((i) => i.severity === 'error');
        if (errors.length > 0) {
          throw new SimEngineError(
            `scenario is infeasible: ${errors.map((e) => e.code).join(', ')}`,
            errors,
          );
        }
      }
    }

    this.ambientActorIds = input.actors
      .filter((actor) => actor.tags.includes('ambient'))
      .map((actor) => actor.id)
      .sort();
    this.ambientActorIdSet = new Set(this.ambientActorIds);
    this.hasAmbientTraffic = this.ambientActorIds.length > 0;
    this.ambientReactive = this.hasAmbientTraffic && this.opts.ambientReactivity === 'reactive';
    for (const spec of [...input.actors].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const rt = this.buildActor(spec);
      this.actors.push(rt);
      this.byId.set(rt.id, rt);
      if (this.motionBackend && !rt.static && rt.kind !== 'static_object') {
        this.dynamicActorIds.add(rt.id);
        this.motionBackend.register({
          actorId: rt.id,
          kind: rt.kind,
          dimensions: { l: rt.dims.l, w: rt.dims.w },
          motionDirection: isReverseMotion(rt) ? -1 : 1,
          state: {
            x: rt.position.x,
            y: rt.position.y,
            yawRad: rt.headingRad,
            longitudinalVelocityMps: rt.speedMps,
          },
          profile: this.physicsConfig.vehicleProfiles?.[rt.id],
        });
      }
      this.tracks.set(rt.id, {
        x: [],
        y: [],
        headingRad: [],
        speedMps: [],
        lateralOffsetM: [],
        motionDirection: [],
        laneRsl: [],
        s: [],
        present: [],
        ...(this.dynamicActorIds.has(rt.id) ? {
          physics: {
            vxBodyMps: [],
            vyBodyMps: [],
            yawRateRadps: [],
            steerRad: [],
            wheelAngularSpeedRadps: [],
            tireUtilization: [],
            frontNormalForceN: [],
            rearNormalForceN: [],
            collisionImpulseNs: [],
            collisionCount: [],
          },
        } : {}),
      });
      const initialRouteRef = semanticResolvedRouteRef(rt.route);
      this.initialRouteRefByActor.set(rt.id, initialRouteRef);
      this.routeRefByActor.set(rt.id, initialRouteRef);
      this.routeRefTracks.set(rt.id, []);
    }
    for (const it of [...input.interactions].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const tr = makeTriggerRuntime(it);
      this.triggers.push(tr);
      this.triggerById.set(it.id, tr);
    }

    // Perception is built after the actors so it can be keyed by concrete ids.
    // It stays `null` unless something actually declares a sensor or a map
    // divergence, which is what keeps every pre-existing trace byte-identical.
    const observers = [...input.actors]
      .filter((spec) => (spec.sensors?.length ?? 0) > 0)
      .map((spec) => ({ actorId: spec.id, sensors: spec.sensors! }));
    const perceptionConfig = input.perception ?? DEFAULT_PERCEPTION_CONFIG;
    this.perception =
      observers.length > 0 || perceptionConfig.mapDivergences.length > 0
        ? new PerceptionRuntime(
            perceptionConfig,
            observers,
            this.actors.map((a) => a.id),
            this.dt,
          )
        : null;

    this.metrics = newMetricAccumulator(
      this.actors.map((a) => a.id),
      input.occlusionPairs,
      input.metricSubject ?? null,
      this.ambientActorIds,
    );
    this.world = {
      t: -input.warmupSeconds,
      dt: this.dt,
      actors: this.actors,
      byId: this.byId,
      activeCollisions: new Set(),
    };
  }

  /* ------------------------------------------------------------ actor setup */

  private buildActor(spec: SimActor): ActorRuntime {
    const built = buildRoute(this.graph, spec.behavior.route);
    if (!built.ok) {
      throw new SimEngineError(built.error.reason, [
        issue(built.error.code, `actors.${spec.id}.behavior.route`, built.error.reason, built.error.detail),
      ]);
    }
    const route = built.route;
    const posePoint = localFromScene(spec.initial.pose);

    // The authored scene transform is the t=0 source of truth. Lane metadata
    // may be stale after an editor move, so it can validate the route but may
    // never relocate the visible actor when Play starts.
    const projectedSpawn = route.projectPoint(posePoint);
    let routeS = projectedSpawn.s;
    let lateral = route.lateralOffsetAt(projectedSpawn.s, posePoint);
    const laneRef = spec.initial.laneRef;
    if (laneRef) {
      const s = route.sOfLaneStorage(laneRef.rsl, laneRef.s);
      if (s === null) {
        this.issues.push(
          issue(
            'spawn_lane_not_on_route',
            `actors.${spec.id}.initial.laneRef`,
            `lane ${laneRef.rsl} is not on the actor's route; falling back to projecting the pose`,
            { rsl: laneRef.rsl },
            'warning',
          ),
        );
      } else {
        const declared = route.pointWithOffset(s, laneRef.tFrac * route.widthAt(s));
        const mismatchM = Math.hypot(declared.x - posePoint.x, declared.y - posePoint.y);
        if (mismatchM > 0.25) {
          this.issues.push(issue(
            'spawn_lane_pose_mismatch',
            `actors.${spec.id}.initial`,
            `authored pose and lane station differ by ${mismatchM.toFixed(2)} m; the authored pose is preserved and lane progress is reprojected`,
            { rsl: laneRef.rsl, authoredS: laneRef.s, projectedS: routeS, mismatchM },
            'warning',
          ));
        }
      }
    }

    // Reverse is a gear, and the route is the path the body travels: a reversing
    // body traverses that same path rear-first, so its heading is the route
    // tangent + PI. The authored pose is the t=0 source of truth for *position*,
    // but a spawn heading that contradicts the declared gear is simply wrong,
    // and keeping it silently is expensive: dynamic-v1 tracks a reversing body
    // by `yaw + PI`, so a heading left equal to the route tangent starts pure
    // pursuit 180 degrees out, saturates the steering, and detaches the body
    // from its route for the whole clip. Derive the heading, and report it.
    const motionDirection = initialMotionDirection(spec.tags);
    let spawnHeadingRad = normalizeAngle(spec.initial.pose.headingRad);
    if (motionDirection === -1) {
      const travelHeadingRad = normalizeAngle(route.poseAt(routeS).headingRad + Math.PI);
      const headingErrorRad = Math.abs(angleDelta(travelHeadingRad, spawnHeadingRad));
      if (headingErrorRad > REVERSE_SPAWN_HEADING_TOL_RAD) {
        this.issues.push(issue(
          'reverse_spawn_heading_adjusted',
          `actors.${spec.id}.initial.pose.headingRad`,
          `actor spawns in reverse gear, so its heading is the route tangent + PI; the authored heading differed by ${((headingErrorRad * 180) / Math.PI).toFixed(1)}° and was corrected`,
          { authoredRad: spawnHeadingRad, correctedRad: travelHeadingRad, errorRad: headingErrorRad },
          'warning',
        ));
      }
      spawnHeadingRad = travelHeadingRad;
    }

    const rules = { ...spec.behavior.rules };
    const rt: ActorRuntime = {
      id: spec.id,
      kind: spec.kind,
      dims: spec.dims,
      tags: spec.tags,
      static: spec.static,
      rules,
      driver: this.driverProfile(spec, rules.aggression),
      cruiseSpeedMps: 0,
      cruiseOverrideMps: spec.behavior.cruiseSpeedMps === undefined
        ? null
        : spec.behavior.cruiseSpeedMps * this.resolvedInput.operationalConditions.effects.trafficSpeedFactor,
      route,
      routeS,
      timedRoute: spec.behavior.route.kind === 'timedPolyline'
        ? spec.behavior.route.points.map((point) => ({ timeS: point.timeS, point: localFromScene(point) }))
        : null,
      bestEffortWorldPath: false,
      remainingTurns:
        spec.behavior.route.kind === 'follow' ? [...spec.behavior.route.turns] : ([] as TurnRelation[]),
      speedMps: spec.static ? 0 : spec.initial.speedMps,
      accelMps2: 0,
      lateralOffsetM: lateral,
      lateralReferenceOffsetM: lateral,
      lateralReferenceRateMps: 0,
      lateralReferenceAccelMps2: 0,
      lateralRestOffsetM: lateral,
      lateralRateMps: 0,
      lateralAccelMps2: 0,
      position: posePoint,
      headingRad: spawnHeadingRad,
      motionDirection,
      pendingMotionDirection: null,
      present: spec.presentAtStart,
      retired: false,
      longCmd: null,
      latCmd: null,
      untilByAxis: new Map(),
      stateKeys: new Map(),
      roadControlStates: new Map(),
      standstillSinceS: null,
      requiredDecelMax: 0,
      crashDisabledAtS: null,
      crashDisabledReason: null,
      hasMoved: false,
    };
    rt.cruiseSpeedMps = spec.static ? 0 : cruiseSpeed(rt, this.speedLimitAt(rt));
    this.issues.push(...timedRouteFeasibilityIssues(rt, `actors.${spec.id}.behavior.route`));
    // Seed both gear keys so a trace consumer can read the gear at t = 0 without
    // having to know that "absent means forward".
    rt.stateKeys.set(MOTION_GEAR_KEY, gearOfMotionDirection(motionDirection));
    rt.stateKeys.set(MOTION_GEAR_ENGAGED_KEY, gearOfMotionDirection(motionDirection));
    return rt;
  }

  /** Seeded, actor-local variation used by the lightweight preview driver.
   * It is independent of actor declaration order and never reads wall time. */
  private driverProfile(spec: SimActor, aggression: number): NonNullable<ActorRuntime['driver']> {
    const comfort = spec.behavior.drivingProfile ?? {
      comfortableLateralAccelerationMps2: 2.2,
      comfortableDecelerationMps2: 2.5,
    };
    if (!isRoadActorKind(spec.kind) || !this.hasAmbientTraffic) {
      return {
        naturalistic: false,
        desiredSpeedFactor: 1, timeHeadwayS: 1, minimumGapM: 1,
        accelScale: 1, comfortBrakeScale: 1, reactionTimeS: 0,
        startDelayS: 0,
        ...comfort,
      };
    }
    const random = this.rng.fork(`driver:${spec.id}`);
    return {
      naturalistic: true,
      desiredSpeedFactor: random.range(0.9, 1.02) + aggression * 0.06,
      timeHeadwayS: random.range(1.15, 1.75) - aggression * 0.35,
      minimumGapM: random.range(2, 3),
      accelScale: random.range(0.75, 1.05) + aggression * 0.1,
      comfortBrakeScale: random.range(0.85, 1.1),
      reactionTimeS: Math.max(0.25, random.range(0.4, 0.8) - aggression * 0.1),
      startDelayS: random.range(0.25, 0.65),
      ...comfort,
    };
  }

  private speedLimitAt(a: ActorRuntime): number {
    const pose = a.route.poseAt(a.routeS);
    const factor = this.resolvedInput.operationalConditions.effects.trafficSpeedFactor;
    if (!pose.rsl) return (isPedestrianLikeKind(a.kind) ? 1.4 : 13.4) * factor;
    const g = this.graph.geometry(pose.rsl);
    return (g ? g.speedLimitMps : 13.4) * factor;
  }

  /* -------------------------------------------------------------- main loop */

  run(): SimResult {
    const result = this.advance(Number.POSITIVE_INFINITY);
    return { input: result.input, trace: result.trace!, issues: result.issues, arrival: result.arrival };
  }

  get done(): boolean {
    return this.finished;
  }

  advance(maxTicks = 1, opts: AdvanceOptions = {}): FixedStepSimulationProgress {
    const budget = Number.isFinite(maxTicks) ? Math.max(0, Math.floor(maxTicks)) : Number.MAX_SAFE_INTEGER;
    const total = this.warmupTicks + this.clipTicks;
    let advanced = 0;
    while (!this.finished && this.nextTick <= total && advanced < budget) {
      const i = this.nextTick++;
      const t = (i - this.warmupTicks) * this.dt;
      this.world = { ...this.world, t };
      this.updateDoorTransitions(t);
      const collisions = this.detectCollisions(t);
      // Perception runs before the triggers that read it, from the same frozen
      // snapshot, and under exactly the guard that `record` uses — so the
      // per-sensor channel is index-aligned with `ticks.t` by construction.
      if (this.perception && (t >= 0 || this.opts.includeWarmupTrace === true)) {
        this.observePerception(t);
      }
      if (t >= 0) {
        this.evaluateWindowEnds(t);
        this.evaluateTriggers(t, collisions);
        this.evaluateUntil(t, collisions);
        this.evaluateWindowEnds(t);
      }
      // A gear change is a request held until the body is at rest, so retry it
      // every tick. That is what lets an author write `speed(stop)` followed by
      // `set(motion.gear = reverse)` without having to guess the stopping time.
      for (const a of this.actors) {
        if (a.pendingMotionDirection !== null) this.engagePendingGear(a, t);
      }
      if (t >= 0 || this.opts.includeWarmupTrace === true) {
        // Record the state *at* `t`, before this tick's integration step, so
        // the sample at `t = 0` is exactly the prologue's final state. Warm-up
        // samples are tracks only: they must not alter recorded-clip metrics.
        this.record(t, collisions, t >= 0);
      }
      if (i < total) {
        const plans = this.planAll(t);
        this.applyAll(plans, t);
      } else {
        this.finishNeverFired();
        this.finished = true;
      }
      advanced += 1;
      opts.onTick?.({ tS: t, tickIndex: i, actors: this.actorSnapshots() });
    }
    return {
      input: this.resolvedInput,
      trace: this.finished || opts.trace === true ? this.buildTrace() : null,
      issues: this.issues,
      arrival: this.arrivalSolutions,
      done: this.finished,
      recordedUntil: this.tArray.length > 0 ? this.tArray[this.tArray.length - 1]! : null,
    };
  }

  /** The engine's own SignalBook: the instance overrides land in. */
  signalBook(): SignalBook {
    return this.signals;
  }

  /** Sorted per-actor read-only snapshot shared by peek and tick observers. */
  private actorSnapshots(): SessionActorSnapshot[] {
    return [...this.actors]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((a) => ({
        id: a.id,
        x: a.position.x,
        y: a.position.y,
        headingRad: a.headingRad,
        speedMps: a.speedMps,
        accelMps2: a.accelMps2,
        present: a.present,
        lateralOffsetM: a.lateralOffsetM,
        lateralRateMps: a.lateralRateMps,
        s: a.routeS,
        laneRsl: a.route.poseAt(a.routeS).rsl ?? null,
      }));
  }

  /** Read-only world snapshot. Never calls `buildTrace` and never mutates state. */
  peek(): SimulationSnapshot {
    const actors = this.actorSnapshots();
    const minima = [...this.metrics.pairs.values()]
      .map((p) => ({
        a: p.a,
        b: p.b,
        minDistanceM: p.minDistance,
        minTtcS: p.minTtc,
        minPathTtcS: p.minPathTtc,
        minPetS: p.minPet,
      }))
      .sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b.localeCompare(y.b)));
    return { tS: this.world.t, done: this.finished, actors, minima };
  }

  /**
   * Events recorded since the previous call, in record order. Purely a
   * session-side read: the trace's event list is untouched either way, so
   * digests are identical whether or not the caller drains mid-episode.
   */
  drainEvents(): readonly SimEvent[] {
    const pending = this.events.slice(this.drainedEventCount);
    this.drainedEventCount = this.events.length;
    return pending;
  }

  /**
   * Fold the caller's action override into the choreography intent just
   * before the motion backend steps. Present override fields win; everything
   * else keeps the engine-computed setpoints.
   */
  private hookedIntent(actorId: string, tS: number, intent: MotionIntent): MotionIntent {
    const override = this.opts.actionHook?.({ actorId, tS });
    if (!override) return intent;
    return {
      ...intent,
      ...(override.motionDirection !== undefined ? { motionDirection: override.motionDirection } : {}),
      ...(override.targetSpeedMps !== undefined ? { targetSpeedMps: override.targetSpeedMps } : {}),
      ...(override.targetAccelerationMps2 !== undefined
        ? { targetAccelerationMps2: override.targetAccelerationMps2 }
        : {}),
      ...(override.previewPoint !== undefined ? { previewPoint: override.previewPoint } : {}),
      ...(override.previewHeadingRad !== undefined ? { previewHeadingRad: override.previewHeadingRad } : {}),
      ...(override.control !== undefined ? { control: override.control } : {}),
    };
  }

  /* ------------------------------------------------------------- collisions */

  private obbOf(a: ActorRuntime): Obb {
    return { center: a.position, lengthM: a.dims.l, widthM: a.dims.w, headingRad: a.headingRad };
  }

  private doorOpenness(door: DoorRuntime, t: number): number {
    if (!door.transitioning || door.durationS <= 0) return door.target;
    const u = Math.max(0, Math.min(1, (t - door.startedT) / door.durationS));
    return door.from + (door.target - door.from) * u;
  }

  private collisionShapes(a: ActorRuntime, t: number): Map<string, Obb> {
    const shapes = new Map<string, Obb>([['body', this.obbOf(a)]]);
    for (const name of ['left', 'right', 'rear'] as const) {
      const door = this.doors.get(`${a.id}|${name}`);
      if (!door) continue;
      const openness = this.doorOpenness(door, t);
      if (openness <= 1e-9 && !door.transitioning) continue;
      shapes.set(`door:${name}`, articulatedDoorObb(a, name, openness));
    }
    for (const prop of this.attachedPropsByActor.get(a.id) ?? []) {
      if (!prop.collidable) continue;
      shapes.set(`prop:${prop.id}`, this.attachedPropObb(a, prop));
    }
    return shapes;
  }

  private attachedPropObb(a: ActorRuntime, prop: StaticProp): Obb {
    const attachment = prop.attachment!;
    const cos = Math.cos(a.headingRad);
    const sin = Math.sin(a.headingRad);
    return {
      center: {
        x: a.position.x + cos * attachment.longitudinalM - sin * attachment.lateralM,
        y: a.position.y + sin * attachment.longitudinalM + cos * attachment.lateralM,
      },
      lengthM: prop.dims.l * prop.scale,
      widthM: prop.dims.w * prop.scale,
      headingRad: normalizeAngle(a.headingRad + attachment.headingOffsetRad),
    };
  }

  private updateDoorTransitions(t: number): void {
    for (const key of [...this.doors.keys()].sort()) {
      const door = this.doors.get(key)!;
      if (!door.transitioning || t < door.startedT + door.durationS) continue;
      door.from = door.target;
      door.transitioning = false;
      const actor = this.byId.get(door.actorId);
      if (!actor) continue;
      const value = door.target > 0 ? 'open' : 'closed';
      actor.stateKeys.set(`doors.${door.name}`, value);
      if (t >= 0) {
        this.events.push({ t, kind: 'state_set', actorId: actor.id, key: `doors.${door.name}`, value });
      }
    }
  }

  private occludersForTick(): readonly OccluderShape[] {
    const actorOccluders = this.actors.filter((a) =>
      (a.static || this.actorOccluderIds.has(a.id)) && a.present && !a.retired
    );
    const dynamic = actorOccluders
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((a) => {
        const obb = this.obbOf(a);
        return {
          id: `actor:${a.id}`,
          obb,
          heightM: a.dims.h,
          corners: obbCorners(obb),
        } satisfies OccluderShape;
      });
    const attached = [...this.attachedPropsByActor.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([actorId, props]) => {
        const carrier = this.byId.get(actorId);
        if (!carrier?.present || carrier.retired) return [];
        return props
          .filter((prop) => this.attachedOccluderIds.has(prop.id))
          .map((prop) => {
            const obb = this.attachedPropObb(carrier, prop);
            return {
              id: prop.id,
              obb,
              heightM: prop.dims.h * prop.scale,
              corners: obbCorners(obb),
            } satisfies OccluderShape;
          });
      });
    return [...this.occluders, ...dynamic, ...attached];
  }

  private detectCollisions(t: number): Set<string> {
    const live = this.actors.filter((a) => a.present && !a.retired);
    const detected = new Set<string>();
    const overlappingNow = new Set<string>();
    const contacts: Array<{ t: number; a: string; b: string; key: string; colliderA: string; colliderB: string }> = [];
    const currentShapes = new Map(live.map((actor) => [actor.id, this.collisionShapes(actor, t)]));
    const candidatePairs: Array<readonly [ActorRuntime, ActorRuntime]> = [];
    if (this.hasAmbientTraffic) {
      const bounds = live.map((actor) => this.sweptBounds(
        actor.id,
        currentShapes.get(actor.id)!,
        this.collisionSnapshots.get(actor.id)?.shapes,
      ));
      for (const pair of spatialCandidatePairs(bounds, COLLISION_GRID_CELL_M)) {
        const a = this.byId.get(pair.a);
        const b = this.byId.get(pair.b);
        if (a && b) candidatePairs.push([a, b]);
      }
    } else {
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) candidatePairs.push([live[i]!, live[j]!]);
      }
    }
    for (const [a, b] of candidatePairs) {
        const key = pairKey(a.id, b.id);
        const currentShapesA = currentShapes.get(a.id)!;
        const currentShapesB = currentShapes.get(b.id)!;
        let currentOverlap = false;
        let contactT: number | null = null;
        let colliderA = 'body';
        let colliderB = 'body';
        for (const [shapeA, currentA] of currentShapesA) {
          for (const [shapeB, currentB] of currentShapesB) {
            if (obbOverlap(currentA, currentB)) {
              currentOverlap = true;
              contactT = t;
              colliderA = shapeA;
              colliderB = shapeB;
            }
          }
        }
        if (currentOverlap) overlappingNow.add(key);
        const previousA = this.collisionSnapshots.get(a.id);
        const previousB = this.collisionSnapshots.get(b.id);
        if (
          this.previousCollisionT !== null &&
          previousA?.live &&
          previousB?.live
        ) {
          for (const [shapeA, currentA] of currentShapesA) {
            const priorA = previousA.shapes.get(shapeA);
            if (!priorA) continue;
            for (const [shapeB, currentB] of currentShapesB) {
              const priorB = previousB.shapes.get(shapeB);
              if (!priorB) continue;
              const hit = sweptObbTimeOfImpact(priorA, currentA, priorB, currentB);
              if (!hit) continue;
              const sweptT = this.previousCollisionT + (t - this.previousCollisionT) * hit.toi;
              if (contactT === null || sweptT < contactT) {
                contactT = sweptT;
                colliderA = shapeA;
                colliderB = shapeB;
              }
            }
          }
        }

        // A swept contact wholly inside the warm-up must not satisfy a
        // collision trigger at t=0. A box still overlapping at t=0 does.
        if (currentOverlap || (contactT !== null && (t < 0 || contactT >= 0))) detected.add(key);
        if (
          contactT !== null &&
          contactT >= 0 &&
          !this.world.activeCollisions.has(key)
        ) {
          const lo = a.id < b.id ? a.id : b.id;
          const hi = a.id < b.id ? b.id : a.id;
          contacts.push({
            t: contactT,
            a: lo,
            b: hi,
            key,
            colliderA: a.id < b.id ? colliderA : colliderB,
            colliderB: a.id < b.id ? colliderB : colliderA,
          });
        }
    }

    // Fixed props have no actor track, but authored collidable geometry still
    // participates in the same continuous collision pipeline. The `prop:`
    // namespace keeps condition/event ids unambiguous beside actor ids.
    for (const actor of live) {
      const actorShapes = currentShapes.get(actor.id)!;
      const previous = this.collisionSnapshots.get(actor.id);
      for (const prop of this.staticCollisionCandidates(actor.id, actorShapes, previous?.shapes)) {
        const key = pairKey(actor.id, prop.id);
        let currentOverlap = false;
        let contactT: number | null = null;
        let colliderActor = 'body';
        for (const [shapeName, current] of actorShapes) {
          if (obbOverlap(current, prop.obb)) {
            currentOverlap = true;
            contactT = t;
            colliderActor = shapeName;
          }
          const prior = previous?.shapes.get(shapeName);
          if (this.previousCollisionT === null || !previous?.live || !prior) continue;
          const hit = sweptObbTimeOfImpact(prior, current, prop.obb, prop.obb);
          if (!hit) continue;
          const sweptT = this.previousCollisionT + (t - this.previousCollisionT) * hit.toi;
          if (contactT === null || sweptT < contactT) {
            contactT = sweptT;
            colliderActor = shapeName;
          }
        }
        if (currentOverlap) overlappingNow.add(key);
        if (currentOverlap || (contactT !== null && (t < 0 || contactT >= 0))) detected.add(key);
        if (contactT !== null && contactT >= 0 && !this.world.activeCollisions.has(key)) {
          const actorFirst = actor.id < prop.id;
          contacts.push({
            t: contactT,
            a: actorFirst ? actor.id : prop.id,
            b: actorFirst ? prop.id : actor.id,
            key,
            colliderA: actorFirst ? colliderActor : 'static',
            colliderB: actorFirst ? 'static' : colliderActor,
          });
        }
      }
    }

    // Sub-tick contact times can differ within one integration interval. Sort
    // them explicitly so event order remains independent of actor declaration.
    contacts.sort((a, b) => a.t - b.t || a.key.localeCompare(b.key));
    for (const contact of contacts) {
      const detail = contact.colliderA === 'body' && contact.colliderB === 'body'
        ? {}
        : { colliderA: contact.colliderA, colliderB: contact.colliderB };
      this.events.push({ t: contact.t, kind: 'collision', a: contact.a, b: contact.b, ...detail });
      this.metrics.collisions.push({ t: contact.t, a: contact.a, b: contact.b, ...detail });
      for (const [actorId, otherId] of [[contact.a, contact.b], [contact.b, contact.a]] as const) {
        const actor = this.byId.get(actorId);
        if (!actor || actor.static || actor.crashDisabledAtS != null) continue;
        actor.crashDisabledAtS = contact.t;
        actor.crashDisabledReason = `material-collision:${otherId}`;
        actor.timedRoute = null;
        if (actor.latCmd) {
          this.abortLateral(actor.latCmd.interactionId, actorId, contact.t, 'collision');
        }
        actor.longCmd = null;
        actor.latCmd = null;
        actor.lateralAccelMps2 = 0;
        actor.untilByAxis.clear();
        this.events.push({ t: contact.t, kind: 'crash_disabled', actorId, otherId, reason: 'material-collision' });
      }
    }

    this.world.activeCollisions.clear();
    for (const k of [...overlappingNow].sort()) this.world.activeCollisions.add(k);
    this.collisionSnapshots = new Map(
      this.actors.map((a) => [
        a.id,
        { shapes: this.collisionShapes(a, t), live: a.present && !a.retired } satisfies CollisionSnapshot,
      ]),
    );
    this.previousCollisionT = t;
    return detected;
  }

  private staticCollisionCandidates(
    actorId: string,
    current: ReadonlyMap<string, Obb>,
    previous: ReadonlyMap<string, Obb> | undefined,
  ): readonly StaticCollisionShape[] {
    const bounds = this.sweptBounds(actorId, current, previous);
    const found = new Map<string, StaticCollisionShape>();
    for (const cell of collisionGridCells(bounds)) {
      for (const shape of this.staticCollisionGrid.get(cell) ?? []) found.set(shape.id, shape);
    }
    return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Conservative AABB for all translation and rotation between two ticks. */
  private sweptBounds(
    id: string,
    current: ReadonlyMap<string, Obb>,
    previous: ReadonlyMap<string, Obb> | undefined,
  ): SpatialBounds {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const shapes of previous ? [current, previous] : [current]) {
      for (const shape of shapes.values()) {
        // A rotating OBB never leaves its circumscribed circle. Expanding each
        // endpoint circle also encloses every linearly interpolated centre.
        const radius = Math.hypot(shape.lengthM, shape.widthM) / 2;
        minX = Math.min(minX, shape.center.x - radius);
        minY = Math.min(minY, shape.center.y - radius);
        maxX = Math.max(maxX, shape.center.x + radius);
        maxY = Math.max(maxY, shape.center.y + radius);
      }
    }
    return { id, minX, minY, maxX, maxY };
  }

  /* --------------------------------------------------------------- triggers */

  private conditionContext(t: number, collisions: ReadonlySet<string>): ConditionContext {
    return {
      t,
      world: { ...this.world, t },
      signals: this.signals,
      occluders: this.occludersForTick(),
      collisions,
      visibilityRangeM: this.resolvedInput.operationalConditions.effects.visibilityRangeM,
      ...(this.perception ? { perception: this.perception } : {}),
    };
  }

  /* -------------------------------------------------------------- perception */

  /**
   * One perception tick.
   *
   * The line-of-sight test is the engine's own occluder layer — perception does
   * not get a second, disagreeing notion of geometry — and the operational
   * visibility range still applies, so a sensor cannot see further than the
   * scenario's declared conditions allow. Everything past that gate is the
   * sensor model's own optics.
   */
  private observePerception(t: number): void {
    const occluders = this.occludersForTick();
    const views: PerceptionActorView[] = this.actors.map((a) => {
      const pose = a.route.poseAt(a.routeS);
      return {
        id: a.id,
        position: a.position,
        headingRad: a.headingRad,
        heightM: a.dims.h,
        present: a.present,
        stateKeys: a.stateKeys,
        laneRsl: pose.rsl ?? null,
        laneS: pose.laneS,
      };
    });
    this.perception!.observe(t, views, (from, to, observerId, targetId) => {
      // Neither endpoint occludes the segment between them. The engine promotes
      // every static actor to an occluder, so without this the pedestrian being
      // looked for would hide behind itself.
      const selfIds = new Set([`actor:${observerId}`, `actor:${targetId}`]);
      // Occluders ONLY — deliberately not `operationalConditions.effects
      // .visibilityRangeM`. That field is the pre-perception stand-in for
      // weather: a single hard range that a fog preset shortens. Applying it
      // here as well would attenuate the same fog twice, and worse, it would be
      // recorded as `occluded` — blaming geometry for what is actually the air.
      // A declared sensor makes its own optics the single authority on range,
      // through `aperture.farM` and the contrast model.
      return hasLineOfSight(
        from,
        to,
        occluders.filter((occluder) => !selfIds.has(occluder.id)),
      );
    });
  }

  private evaluateTriggers(t: number, collisions: ReadonlySet<string>): void {
    const ctx = this.conditionContext(t, collisions);
    for (const tr of this.triggers) {
      if (tr.status !== 'pending') continue;
      this.recordTriggerTruth(
        tr.interaction.id,
        t,
        triggerPredicateValue(ctx, tr, this.triggerById),
      );
      const window = tr.interaction.window;
      if (window && t < window.startS - 1e-9) continue;
      // Clip bounds form a half-open trigger eligibility window. Once fired,
      // the command's own dynamics—not the clip end—own its completion.
      if (window && t >= window.endS - 1e-9) {
        tr.status = 'skipped';
        this.events.push({
          t,
          kind: 'trigger_skipped',
          interactionId: tr.interaction.id,
          actorId: tr.interaction.actorId,
          reason: 'window_elapsed',
        });
        this.metrics.triggerNeverFired.push(tr.interaction.id);
        continue;
      }
      const verdict = shouldFire(ctx, tr, this.triggerById);
      if (verdict.skip) {
        tr.status = 'skipped';
        this.events.push({
          t,
          kind: 'trigger_skipped',
          interactionId: tr.interaction.id,
          actorId: tr.interaction.actorId,
          reason: tr.interaction.trigger.kind === 'when' ? 'byLatest_elapsed' : 'dependency_skipped',
        });
        this.metrics.triggerNeverFired.push(tr.interaction.id);
        continue;
      }
      // A lane-path turn is a commitment at its intended junction, not an
      // immediate re-route when the clip begins. Hold it until the actor is on
      // the final shared approach leg; if that never occurs inside the clip it
      // is missed below instead of executing later.
      const routeCommit = tr.interaction.verb !== 'route'
        ? 'ready' as const
        : this.routeCommitStatus(tr.interaction);
      if (verdict.fire && routeCommit === 'missed') {
        tr.status = 'skipped';
        this.events.push({
          t, kind: 'trigger_skipped', interactionId: tr.interaction.id,
          actorId: tr.interaction.actorId, reason: 'route_commit_missed',
        });
        this.metrics.triggerNeverFired.push(tr.interaction.id);
        continue;
      }
      if (!verdict.fire || routeCommit !== 'ready') continue;
      const targetActor = this.byId.get(tr.interaction.actorId);
      // A material crash disables every command capable of moving or
      // respawning the body, but evidence-only state changes (lights, horn,
      // doors) must still be observable when they are triggered by the impact
      // itself. The crash latch remains authoritative regardless of a later
      // rules.* state write.
      if (targetActor?.crashDisabledAtS != null && tr.interaction.verb !== 'set') {
        tr.status = 'skipped';
        this.events.push({
          t,
          kind: 'trigger_skipped',
          interactionId: tr.interaction.id,
          actorId: tr.interaction.actorId,
          reason: 'actor-crash-disabled',
        });
        this.metrics.triggerNeverFired.push(tr.interaction.id);
        continue;
      }
      tr.status = 'fired';
      tr.firedAt = t;
      tr.forced = verdict.forced;
      this.events.push({
        t,
        kind: 'trigger_fired',
        interactionId: tr.interaction.id,
        actorId: tr.interaction.actorId,
        verb: tr.interaction.verb,
        forced: verdict.forced,
      });
      this.applyInteraction(tr.interaction, t);
      const axis = axisOf(tr.interaction);
      if (axis === 'route' || axis === 'existence' || axis.startsWith('state:')) tr.endedAt = t;
    }
  }

  private recordTriggerTruth(interactionId: string, t: number, value: boolean): void {
    const transitions = this.triggerTruthTransitions.get(interactionId) ?? [];
    if (transitions.length === 0 || transitions[transitions.length - 1]!.value !== value) {
      transitions.push({ t, value });
      this.triggerTruthTransitions.set(interactionId, transitions);
    }
  }

  /** Whether a route action has reached the junction where its target path
   * diverges from the actor's current path. Identical paths are ready now. */
  private routeCommitStatus(it: Interaction & { verb: 'route' }): 'wait' | 'ready' | 'missed' {
    const actor = this.byId.get(it.actorId);
    if (!actor || actor.route.isFreeform || it.target.kind !== 'lanePath') return 'ready';
    const target = buildRoute(this.graph, it.target);
    if (!target.ok || target.route.isFreeform) return 'ready';
    const currentIndex = actor.route.legIndexAt(actor.routeS);
    const currentRsl = actor.route.legs[currentIndex]?.rsl;
    if (!currentRsl) return 'ready';
    const targetIndex = target.route.legs.findIndex((leg) => leg.rsl === currentRsl);
    if (targetIndex < 0) {
      // If these routes once shared an approach, the actor has already taken
      // the old branch. Applying now would project/teleport it onto a future
      // path and make a late timeline edit rewrite the past.
      const targetLanes = new Set(target.route.legs.map((leg) => leg.rsl));
      const passedSharedApproach = actor.route.legs
        .slice(0, currentIndex)
        .some((leg) => targetLanes.has(leg.rsl));
      return passedSharedApproach ? 'missed' : 'ready';
    }
    let shared = 0;
    while (
      actor.route.legs[currentIndex + shared]?.rsl
      && actor.route.legs[currentIndex + shared]?.rsl === target.route.legs[targetIndex + shared]?.rsl
    ) shared += 1;
    if (shared === 0 || (
      currentIndex + shared >= actor.route.legs.length
      && targetIndex + shared >= target.route.legs.length
    )) return 'ready';
    const lastShared = actor.route.legs[currentIndex + shared - 1]!;
    const commitS = lastShared.sStart + lastShared.lengthM;
    if (actor.routeS > commitS + 1e-6) return 'missed';
    const lookaheadM = clamp(actor.speedMps * 1.5, 5, 20);
    return actor.routeS >= commitS - lookaheadM ? 'ready' : 'wait';
  }

  private evaluateUntil(t: number, collisions: ReadonlySet<string>): void {
    const ctx = this.conditionContext(t, collisions);
    for (const a of this.actors) {
      if (a.untilByAxis.size === 0) continue;
      for (const axis of [...a.untilByAxis.keys()].sort()) {
        const entry = a.untilByAxis.get(axis)!;
        if (!evaluateCondition(ctx, entry.condition)) continue;
        a.untilByAxis.delete(axis);
        this.releaseAxis(a, axis, t, entry.interactionId, 'until');
      }
    }
  }

  /**
   * Existing non-lateral commands retain their authored release window.
   * Lateral clips are different: their end is only the exclusive last instant
   * at which a manoeuvre may begin, never a request to truncate body motion.
   */
  private evaluateWindowEnds(t: number): void {
    for (const tr of this.triggers) {
      const window = tr.interaction.window;
      if (tr.status !== 'fired' || !window || t < window.endS - 1e-9 || this.releasedWindows.has(tr.interaction.id)) continue;
      if (axisOf(tr.interaction) === 'lateral') continue;
      this.releasedWindows.add(tr.interaction.id);
      tr.endedAt ??= t;
      const actor = this.byId.get(tr.interaction.actorId);
      if (!actor) continue;
      const axis = axisOf(tr.interaction);
      const owner = axis === 'longitudinal' ? actor.longCmd?.interactionId : undefined;
      if (owner === tr.interaction.id) this.releaseAxis(actor, axis, t, tr.interaction.id, 'window');
    }
  }

  private releaseAxis(
    a: ActorRuntime,
    axis: AxisId,
    t: number,
    interactionId: string,
    reason: 'until' | 'complete' | 'window',
  ): void {
    if (axis === 'lateral' && reason === 'until' && a.latCmd?.interactionId === interactionId) {
      this.abortLateral(interactionId, a.id, t, reason);
    }
    if (axis === 'longitudinal') {
      const command = a.longCmd;
      if (
        reason === 'until'
        && command?.interactionId === interactionId
        && command.priorCruiseOverrideMps !== undefined
      ) {
        a.cruiseOverrideMps = command.priorCruiseOverrideMps;
        a.cruiseSpeedMps = cruiseSpeed(a, this.speedLimitAt(a));
      }
      a.longCmd = null;
    }
    else if (axis === 'lateral') a.latCmd = null;
    const untilOwner = a.untilByAxis.get(axis);
    if (untilOwner?.interactionId === interactionId) a.untilByAxis.delete(axis);
    const trigger = this.triggerById.get(interactionId);
    if (trigger) trigger.endedAt ??= t;
    this.events.push({ t, kind: 'released', actorId: a.id, axis, interactionId, reason });
  }

  private abortLateral(
    interactionId: string,
    actorId: string,
    t: number,
    reason: 'collision' | 'preempted' | 'until' | 'rejected' | 'tracking_error' | 'clip_end',
  ): void {
    const trigger = this.triggerById.get(interactionId);
    if (trigger) trigger.endedAt ??= t;
    this.events.push({ t, kind: 'interaction_aborted', interactionId, actorId, reason });
  }

  /* ----------------------------------------------------- verb → controller */

  private applyInteraction(it: Interaction, t: number): void {
    const a = this.byId.get(it.actorId);
    if (!a) return;
    if (a.crashDisabledAtS != null && it.verb !== 'set') {
      this.events.push({ t, kind: 'trigger_skipped', interactionId: it.id, actorId: a.id, reason: 'actor-crash-disabled' });
      return;
    }
    const axis = axisOf(it);
    this.preempt(a, axis, it, t);

    switch (it.verb) {
      case 'speed': {
        const target = this.resolveSpeedTarget(a, it);
        const duration = transitionDuration(it.dynamics, target - a.speedMps, Math.max(a.speedMps, 0.1));
        const cmd: LongitudinalCommand = {
          kind: 'speed',
          interactionId: it.id,
          firedAt: t,
          dynamics: it.dynamics,
          v0: a.speedMps,
          duration,
          target,
          speedTarget: it,
          priorCruiseOverrideMps: a.cruiseOverrideMps,
        };
        // A SpeedAction changes the actor's desired cruise state. The profile
        // owns how the target is reached; its editor clip is not a temporary
        // throttle press that restores the pre-action speed when it ends.
        a.cruiseOverrideMps = target;
        a.cruiseSpeedMps = target;
        a.longCmd = cmd;
        break;
      }
      case 'gap': {
        const leaderId = it.target.actorId;
        const leader = this.byId.get(leaderId);
        const gapNow = leader ? (alongRouteGapM(a, leader) ?? 0) : 0;
        const gapTarget = desiredGapM(a, it.value, it.mode, true);
        const duration = transitionDuration(it.dynamics, gapTarget - gapNow, Math.max(a.speedMps, 0.1));
        const cmd: LongitudinalCommand = {
          kind: 'gap',
          interactionId: it.id,
          firedAt: t,
          dynamics: it.dynamics,
          v0: gapNow,
          duration,
          target: gapTarget,
          gap: { actorId: leaderId, value: it.value, mode: it.mode },
        };
        a.longCmd = cmd;
        break;
      }
      case 'changeLane': {
        const cmd = this.startLaneChange(a, it, t);
        a.latCmd = cmd;
        break;
      }
      case 'laneOffset': {
        const width = a.route.widthAt(a.routeS);
        const to = it.target.mode === 'meters' ? it.target.value : it.target.value * width;
        const planned = this.boundedLateralDuration(a, it.id, it.dynamics, to - a.lateralOffsetM);
        this.events.push({ t, kind: 'lateral_maneuver_planned', actorId: a.id, interactionId: it.id, requestedDurationS: planned.requestedS, effectiveDurationS: planned.effectiveS, displacementM: to - a.lateralOffsetM });
        const cmd: LateralCommand = {
          kind: 'laneOffset',
          interactionId: it.id,
          firedAt: t,
          dynamics: it.dynamics,
          from: a.lateralOffsetM,
          to,
          duration: planned.effectiveS,
          remaining: 0,
          done: false,
        };
        a.latCmd = cmd;
        break;
      }
      case 'route': {
        const polylineTarget = it.target.kind === 'polyline' ? it.target : null;
        const joinsLivePose = it.joinFromCurrentPose === true && polylineTarget !== null;
        const target = joinsLivePose
          ? { ...polylineTarget, points: [toSceneXZ(a.position), ...polylineTarget.points] }
          : it.target;
        const currentPose = a.route.poseAt(a.routeS);
        const currentLeg = a.route.legs[currentPose.legIndex];
        const built = target.kind === 'nextJunction' && currentPose.rsl
          ? buildFollowRoute(
              this.graph,
              currentPose.rsl,
              [target.turn],
              target.maxLengthM,
              currentLeg?.reversed,
              { strictTurns: true },
            )
          : target.kind === 'nextJunction'
            ? {
                ok: false as const,
                error: {
                  code: 'route_turn_unavailable' as const,
                  reason: `actor ${a.id} has no live lane identity from which to find the next junction`,
                  detail: { actorId: a.id, requestedTurn: target.turn },
                },
              }
            : buildRoute(this.graph, target);
        if (!built.ok) {
          if (target.kind === 'nextJunction') {
            this.events.push({
              t,
              kind: 'route_change_rejected',
              actorId: a.id,
              interactionId: it.id,
              reason: built.error.reason,
              requestedTurn: target.turn,
            });
          }
          this.issues.push(
            issue(built.error.code, `interactions.${it.id}.target`, built.error.reason, built.error.detail, 'warning'),
          );
          break;
        }
        const proj = joinsLivePose ? { s: 0 } : built.route.projectPoint(a.position);
        a.route = built.route;
        a.routeS = proj.s;
        a.timedRoute = target.kind === 'timedPolyline'
          ? target.points.map((point) => ({ timeS: point.timeS, point: localFromScene(point) }))
          : null;
        this.issues.push(...timedRouteFeasibilityIssues(a, `interactions.${it.id}.target`));
        this.routeRefByActor.set(a.id, semanticResolvedRouteRef(a.route));
        a.bestEffortWorldPath = it.bestEffortWorldPath === true;
        a.lateralOffsetM = joinsLivePose ? 0 : built.route.lateralOffsetAt(proj.s, a.position);
        a.lateralReferenceOffsetM = a.lateralOffsetM;
        a.lateralReferenceRateMps = 0;
        a.lateralReferenceAccelMps2 = 0;
        a.lateralRestOffsetM = a.lateralOffsetM;
        a.remainingTurns = target.kind === 'follow' ? [...target.turns] : [];
        // Re-routing is an explicit new motion path. An actor that reached its
        // previous route end must be allowed to move again (rollback, rebound,
        // multi-leg pedestrian motion) without a fake despawn/respawn cycle.
        a.retired = false;
        break;
      }
      case 'exist': {
        const present = it.target.state === 'present';
        if (present !== a.present) {
          a.present = present;
          if (present) {
            a.retired = false;
            this.events.push({ t, kind: 'spawn', actorId: a.id });
          } else {
            this.events.push({ t, kind: 'despawn', actorId: a.id, reason: 'interaction' });
          }
        }
        break;
      }
      case 'set': {
        const { key, value } = it.target;
        a.stateKeys.set(key, value);
        const forcedSignal = /^signal:(.+)\.phase$/.exec(key);
        const forcedControl = /^control:(.+)\.indication$/.exec(key);
        if (
          (forcedSignal || forcedControl) &&
          typeof value === 'string'
        ) {
          this.signals.setOverride((forcedSignal ?? forcedControl)![1]!, value as import('../schema/input.js').ControlIndication);
        }
        this.applyStateKey(a, key, value, t);
        this.events.push({ t, kind: 'state_set', actorId: a.id, key, value });
        break;
      }
    }

    if (it.until) a.untilByAxis.set(axis, { interactionId: it.id, condition: it.until });
    else a.untilByAxis.delete(axis);
  }

  private preempt(a: ActorRuntime, axis: AxisId, it: Interaction, t: number): void {
    const previous =
      axis === 'longitudinal' ? a.longCmd?.interactionId : axis === 'lateral' ? a.latCmd?.interactionId : undefined;
    if (previous !== undefined && previous !== it.id) {
      if (axis === 'lateral') {
        this.abortLateral(previous, a.id, t, 'preempted');
      }
      this.events.push({
        t,
        kind: 'preemption',
        actorId: a.id,
        axis,
        byInteractionId: it.id,
        preemptedInteractionId: previous,
      });
    }
  }

  private applyStateKey(a: ActorRuntime, key: string, value: boolean | number | string, t: number): void {
    const doorMatch = /^doors\.(left|right|rear)$/.exec(key);
    if (doorMatch) this.applyDoorState(a, doorMatch[1] as DoorName, value, t);
    switch (key) {
      case 'rules.obeySignals':
        a.rules = { ...a.rules, obeySignals: Boolean(value) };
        break;
      case 'rules.yield':
        a.rules = { ...a.rules, yield: Boolean(value) };
        break;
      case 'rules.yieldToVehicles':
        a.rules = { ...a.rules, yieldToVehicles: Boolean(value) };
        break;
      case 'rules.yieldToPedestrians':
        a.rules = { ...a.rules, yieldToPedestrians: Boolean(value) };
        break;
      case 'rules.collisionAvoidance':
        a.rules = { ...a.rules, collisionAvoidance: Boolean(value) };
        break;
      case 'rules.aggression':
        if (typeof value === 'number') a.rules = { ...a.rules, aggression: value };
        break;
      case 'rules.speedFactor':
        if (typeof value === 'number') {
          a.rules = { ...a.rules, speedFactor: value };
          a.cruiseSpeedMps = cruiseSpeed(a, this.speedLimitAt(a));
        }
        break;
      case MOTION_GEAR_KEY: {
        // Gear selection is a *request*, not an assignment. A gearbox cannot
        // pick reverse at road speed, and forcing it would teleport momentum:
        // the dynamic solver clamps `direction * v < 0` straight to zero. Hold
        // the request until the body is at rest and engage it there.
        //
        // The request and the engagement are published as two separate state
        // keys — `motion.gear` is what the author asked for, `motion.gearEngaged`
        // is what the gearbox actually did. A shift that never engages is then
        // visible in the trace as a disagreement between them, instead of being
        // a silent no-op.
        const requested = motionDirectionOfGear(value);
        if (requested === null) break;
        a.pendingMotionDirection = requested === a.motionDirection ? null : requested;
        this.engagePendingGear(a, t);
        break;
      }
      default:
        // `lights.*`, `audio.*`, `doors.*`, `pose.*`, `env.*`, `signal:*.phase` are
        // recorded state only — the renderer and exporter read them back out of
        // the event log; no controller consumes them yet.
        break;
    }
  }

  /**
   * Last resolved lane for each actor whose route carries no lane identity,
   * with the position it was resolved at. See `freeformLaneRsl`.
   */
  private readonly freeformLaneBindings = new Map<string, { at: Vec2; rsl: LaneRsl | null }>();

  /**
   * Lane membership for an actor whose route is a freeform polyline.
   *
   * A car backing out of a driveway or a bay starts *off* the corridor and
   * crosses into the ego's lane part way through the manoeuvre; its authored
   * path is a polyline, which carries no `rsl` at all, so without this the whole
   * manoeuvre reports `laneRsl: null` and every lane-scoped consumer — conflict
   * pairing, the invariant checker, the exporters — concludes the actor was
   * never on the road. Resolving membership from the lane graph at the body's
   * actual position is what makes "it entered my lane" observable.
   *
   * `nearestLane` is a full scan, so the result is cached and only recomputed
   * once the body has moved a metre. That bounds a 20 s clip to a few dozen
   * queries per freeform actor rather than one per tick.
   */
  private freeformLaneRsl(a: ActorRuntime): LaneRsl | null {
    const cached = this.freeformLaneBindings.get(a.id);
    if (cached && Math.hypot(cached.at.x - a.position.x, cached.at.y - a.position.y) < FREEFORM_LANE_REBIND_M) {
      return cached.rsl;
    }
    const found = this.graph.nearestLane(a.position, { maxDistM: Math.max(a.dims.w, 1.5) });
    const rsl = found ? found.rsl : null;
    this.freeformLaneBindings.set(a.id, { at: { x: a.position.x, y: a.position.y }, rsl });
    return rsl;
  }

  /**
   * Engage an outstanding gear change, if the body is slow enough to allow it.
   *
   * Called on the shift request and again every tick, so an author who commands
   * `speed(stop)` and then `set(motion.gear = reverse)` gets the shift the
   * moment the car actually comes to rest, without having to guess the stopping
   * time.
   *
   * Selecting the opposite gear **reverses the route** rather than rotating the
   * body. That is the physically honest model of backing down the lane you just
   * came up: the heading is continuous (`newTangent + PI` is the old tangent),
   * `routeS` re-bases to `lengthM - s`, and the lateral offset negates because
   * "left" is measured relative to the direction of travel. Because the flipped
   * route is still a lane chain, `laneRsl`, lane width and the leader search go
   * on working throughout the manoeuvre.
   */
  private engagePendingGear(a: ActorRuntime, t: number): void {
    const next = a.pendingMotionDirection;
    if (next === null) return;
    if (next === a.motionDirection) {
      a.pendingMotionDirection = null;
      return;
    }
    if (Math.abs(a.speedMps) > GEAR_ENGAGE_SPEED_MPS) return;

    if (a.hasMoved) {
      const flipped = a.route.reversedRoute();
      a.routeS = clamp(a.route.lengthM - a.routeS, 0, flipped.lengthM);
      a.route = flipped;
      this.routeRefByActor.set(a.id, semanticResolvedRouteRef(a.route));
      a.remainingTurns = [];
      // "Left" is measured relative to the direction of travel, so flipping the
      // traversal negates every lateral quantity with it.
      a.lateralOffsetM = -a.lateralOffsetM;
      a.lateralReferenceOffsetM = -a.lateralReferenceOffsetM;
      a.lateralRestOffsetM = -(a.lateralRestOffsetM ?? 0);
      a.lateralReferenceRateMps = -a.lateralReferenceRateMps;
      a.lateralRateMps = -a.lateralRateMps;
    } else {
      // The body has never driven, so its heading is a placement rather than a
      // physical outcome: this is a car parked nose-in being told to come out
      // backwards. Keep the authored path — it is the escape path the author
      // drew — and re-derive the heading from it, which is the same
      // `routeTangent + PI` rule spawn-in-reverse actors already obey. The
      // dynamic body is re-seeded at the new yaw so pure pursuit does not start
      // 180 degrees out, which is precisely the failure this whole mechanism
      // used to exhibit.
      a.headingRad = normalizeAngle(
        a.route.poseAt(a.routeS).headingRad + (next === -1 ? Math.PI : 0),
      );
      if (this.motionBackend && this.dynamicActorIds.has(a.id)) {
        this.motionBackend.register({
          actorId: a.id,
          kind: a.kind,
          dimensions: { l: a.dims.l, w: a.dims.w },
          motionDirection: next,
          state: { x: a.position.x, y: a.position.y, yawRad: a.headingRad, longitudinalVelocityMps: 0 },
          profile: this.physicsConfig.vehicleProfiles?.[a.id],
        });
      }
    }
    a.motionDirection = next;
    a.pendingMotionDirection = null;
    // A retired actor has finished *this* route; a fresh one in the other gear
    // is new motion, so let it drive again.
    a.retired = false;
    const gear = gearOfMotionDirection(next);
    a.stateKeys.set(MOTION_GEAR_ENGAGED_KEY, gear);
    this.events.push({ t, kind: 'state_set', actorId: a.id, key: MOTION_GEAR_ENGAGED_KEY, value: gear });
  }

  private applyDoorState(a: ActorRuntime, name: DoorName, value: boolean | number | string, t: number): void {
    const key = `${a.id}|${name}`;
    const existing = this.doors.get(key);
    const current = existing ? this.doorOpenness(existing, t) : 0;
    let target: number;
    let transitioning = false;
    if (value === 'opening') {
      target = 1;
      transitioning = true;
    } else if (value === 'closing') {
      target = 0;
      transitioning = true;
    } else if (value === 'open' || value === true) {
      target = 1;
    } else if (typeof value === 'number') {
      target = Math.max(0, Math.min(1, value));
    } else {
      target = 0;
    }
    this.doors.set(key, {
      actorId: a.id,
      name,
      from: current,
      target,
      startedT: t,
      durationS: transitioning ? DOOR_OPEN_DURATION_S * Math.abs(target - current) : 0,
      transitioning,
    });

    // Collision snapshots are captured before triggers. Seed the closed/current
    // hinge pose at the trigger instant so next tick's sweep includes the
    // entire opening arc instead of treating the door as newly teleported.
    const snapshot = this.collisionSnapshots.get(a.id);
    if (snapshot?.live && !snapshot.shapes.has(`door:${name}`)) {
      const shapes = new Map(snapshot.shapes);
      shapes.set(`door:${name}`, articulatedDoorObb(a, name, current));
      this.collisionSnapshots.set(a.id, { ...snapshot, shapes });
    }
  }

  private resolveSpeedTarget(a: ActorRuntime, it: Interaction & { verb: 'speed' }): number {
    const limit = this.speedLimitAt(a);
    switch (it.target.mode) {
      case 'absolute':
        return it.target.value;
      case 'delta':
        return Math.max(0, a.speedMps + it.target.value);
      case 'factor':
        return Math.max(0, a.speedMps * it.target.value);
      case 'stop':
        return 0;
      case 'match': {
        const other = this.byId.get(it.target.actorId);
        return Math.max(0, (other?.speedMps ?? cruiseSpeed(a, limit)) + it.target.offsetMps);
      }
    }
  }

  private startLaneChange(
    a: ActorRuntime,
    it: Interaction & { verb: 'changeLane' },
    t: number,
  ): LateralCommand | null {
    const target = it.target;
    let retarget: { route: Route; s: number; separationM: number; targetRsl: string | null } | null = null;
    let side: 'left' | 'right' | undefined;
    let legal = true;

    if (target.mode === 'left' || target.mode === 'right') {
      side = target.mode;
      // Resolve the complete lane-count atomically before motion begins. OSC
      // represents count=N as one target and duration, so executing one lane
      // and then silently completing when lane N is missing is non-conformant.
      let cursorRoute = a.route;
      let cursorS = a.routeS;
      let separationM = 0;
      for (let lane = 0; lane < target.count; lane += 1) {
        const next = retargetToNeighbour(this.graph, cursorRoute, cursorS, side, {
          legalOnly: true,
          remainingTurns: a.remainingTurns,
        });
        if (!next) { legal = false; retarget = null; break; }
        separationM += next.separationM;
        cursorRoute = next.route;
        cursorS = next.s;
        retarget = { route: next.route, s: next.s, separationM, targetRsl: next.targetRsl };
      }
    } else if (target.mode === 'lane') {
      const currentRsl = a.route.poseAt(a.routeS).rsl;
      // A second true changeLane may abort an in-progress incursion by naming
      // the actor's still-active source lane. The route swap has not happened
      // yet, so a generic retarget-to-same-lane reports zero separation and
      // leaves the vehicle stranded across the boundary. Treat this as the
      // inverse lateral manoeuvre back to the source centre while retaining
      // the source route; completion still uses the ordinary route hand-off.
      if (
        currentRsl === target.rsl &&
        a.latCmd?.kind === 'changeLane' &&
        !a.latCmd.done &&
        Math.abs(a.lateralOffsetM) > 1e-3
      ) {
        retarget = {
          route: a.route,
          s: a.routeS,
          separationM: -a.lateralOffsetM,
          targetRsl: target.rsl,
        };
      } else {
        const r = retargetToLane(this.graph, a.route, a.routeS, target.rsl, {
          remainingTurns: a.remainingTurns,
        });
        if (
          r &&
          a.latCmd?.kind === 'changeLane' &&
          !a.latCmd.done &&
          Math.abs(r.separationM) <= 0.1 &&
          Math.abs(a.lateralOffsetM) > 1e-3
        ) {
          // The authored source lane may name an upstream RSL while the actor
          // has already advanced onto its directed successor. A zero-separation
          // retarget still means "abort to this source route", not "hold the
          // current partial offset".
          retarget = {
            route: a.route,
            s: a.routeS,
            separationM: -a.lateralOffsetM,
            targetRsl: currentRsl,
          };
        } else if (r) {
          retarget = { route: r.route, s: r.s, separationM: r.separationM, targetRsl: target.rsl };
        }
        else legal = false;
      }
    } else {
      const other = this.byId.get(target.actorId);
      const rsl = other ? other.route.poseAt(other.routeS).rsl : null;
      if (rsl) {
        const r = retargetToLane(this.graph, a.route, a.routeS, rsl, { remainingTurns: a.remainingTurns });
        if (r) retarget = { route: r.route, s: r.s, separationM: r.separationM, targetRsl: rsl };
      }
      if (!retarget) legal = false;
    }

    if (!retarget) {
      this.events.push({
        t,
        kind: 'lane_change_rejected',
        actorId: a.id,
        interactionId: it.id,
        reason: legal ? 'no_target_lane' : 'illegal_or_missing_neighbour',
      });
      this.issues.push(
        issue(
          'lane_change_illegal',
          `interactions.${it.id}.target`,
          `no legal lane-change target for ${a.id} at t=${t.toFixed(2)}`,
          { actorId: a.id, mode: target.mode },
          'warning',
        ),
      );
      this.abortLateral(it.id, a.id, t, 'rejected');
      return null;
    }

    const to = a.lateralOffsetM + retarget.separationM;
    const planned = this.boundedLateralDuration(a, it.id, it.dynamics, retarget.separationM);
    this.events.push({ t, kind: 'lateral_maneuver_planned', actorId: a.id, interactionId: it.id, requestedDurationS: planned.requestedS, effectiveDurationS: planned.effectiveS, displacementM: retarget.separationM });
    return {
      kind: 'changeLane',
      interactionId: it.id,
      firedAt: t,
      dynamics: it.dynamics,
      from: a.lateralOffsetM,
      to,
      duration: planned.effectiveS,
      pending: retarget,
      remaining: 0,
      side,
      done: false,
    };
  }

  private boundedLateralDuration(
    actor: ActorRuntime,
    interactionId: string,
    dynamics: Dynamics,
    displacementM: number,
  ): { requestedS: number; effectiveS: number } {
    const distanceM = Math.abs(displacementM);
    const requestedS = dynamics.constraint === 'rate' && distanceM > 1e-9
      ? distanceM * 1.875 / dynamics.value
      : transitionDuration(dynamics, displacementM, Math.max(actor.speedMps, 0.1));
    if (distanceM <= 1e-6) return { requestedS, effectiveS: requestedS };
    const limits = limitsFor(actor);
    // Analytic peaks of the minimum-jerk quintic used by lateralStep.
    const peaks = { rate: 1.875, accel: 5.773_502_692, jerk: 60 };
    const requiredS = Math.max(
      distanceM * peaks.rate / Math.max(limits.lateralRateMax, 1e-6),
      Math.sqrt(distanceM * peaks.accel / Math.max(limits.lateralAccelMax, 1e-6)),
      Math.cbrt(distanceM * peaks.jerk / Math.max(limits.lateralJerkMax, 1e-6)),
    );
    const effectiveS = Math.max(requestedS, requiredS);
    if (effectiveS > requestedS + 1e-6 && !this.lateralClampDiagnostics.has(interactionId)) {
      this.lateralClampDiagnostics.add(interactionId);
      this.issues.push(issue(
        'lateral_duration_clamped',
        `interactions.${interactionId}.dynamics.value`,
        `requested ${requestedS.toFixed(2)} s lateral manoeuvre is infeasible for ${actor.kind}; clamped to ${effectiveS.toFixed(2)} s`,
        {
          actorId: actor.id,
          requestedDurationS: requestedS,
          effectiveDurationS: effectiveS,
          displacementM,
          lateralRateMaxMps: limits.lateralRateMax,
          lateralAccelMaxMps2: limits.lateralAccelMax,
          lateralJerkMaxMps3: limits.lateralJerkMax,
        },
        'warning',
      ));
    }
    return { requestedS, effectiveS };
  }

  /* ------------------------------------------------------------- stepping */

  private planAll(t: number): Plan[] {
    this.buildConflictSamples();
    this.buildNearbyIndex();
    const plans: Plan[] = [];
    for (const a of this.actors) {
      plans.push(this.planActor(a, t));
    }
    return plans;
  }

  /**
   * The grip under one actor on this tick.
   *
   * This is the whole point of the surface field: friction is a property of
   * *where the actor is*, not of the episode. With no patches it is the
   * scene-wide weather scalar and costs one boolean.
   */
  private frictionScaleFor(a: ActorRuntime): number {
    if (this.surface.isUniform) return this.surface.baselineFrictionScale;
    const pose = a.route.isFreeform ? null : a.route.poseAt(a.routeS);
    return this.surface.frictionScaleAt({
      position: a.position,
      lane: pose?.rsl != null ? { rsl: pose.rsl, laneS: pose.laneS } : null,
    });
  }

  /** All-way-stop arbitration: first complete arrival wins; actor id is the
   * stable same-tick tie break. Only one movement enters during the short
   * intersection-clearance window. */
  private canReleaseStop(controlId: string, coordinationId: string, actorId: string, t: number): boolean {
    const coordinatedControlIds = new Set(
      this.signals.stopLines
        .filter((line) =>
          line.coordinationId === coordinationId && this.signals.authorityAt(line, t).kind === 'stop')
        .map((line) => line.controlId),
    );
    for (const actor of this.actors) {
      if (actor.id === actorId) continue;
      for (const id of coordinatedControlIds) {
        const state = actor.roadControlStates.get(id);
        if (state?.releasedAtS !== null && state?.releasedAtS !== undefined && t - state.releasedAtS < 2.5) {
          return false;
        }
      }
    }
    const waiting = this.actors
      .flatMap((actor) => [...coordinatedControlIds].map((id) => ({ actor, id, state: actor.roadControlStates.get(id) })))
      .filter((entry) => entry.state?.arrivedAtS !== null && entry.state?.arrivedAtS !== undefined && !entry.state.released)
      .sort((a, b) =>
        a.state!.arrivedAtS! - b.state!.arrivedAtS!
        || a.actor.id.localeCompare(b.actor.id)
        || a.id.localeCompare(b.id),
      );
    return waiting.length === 0 || (waiting[0]!.actor.id === actorId && waiting[0]!.id === controlId);
  }

  private buildConflictSamples(): void {
    this.conflictSamples.clear();
    this.conflictCandidates.clear();
    for (const a of this.actors) {
      if (!a.present || a.retired) continue;
      const pts: Vec2[] = [];
      for (let i = 0; i < CONFLICT_SAMPLES; i++) {
        const s = a.routeS + i * CONFLICT_STEP_M;
        if (s > a.route.lengthM) break;
        pts.push(a.route.pointWithOffset(s, a.lateralOffsetM));
      }
      this.conflictSamples.set(a.id, pts);
    }
    if (!this.hasAmbientTraffic) return;

    const bounds: SpatialBounds[] = [];
    for (const [id, points] of this.conflictSamples) {
      if (points.length === 0) continue;
      bounds.push({
        id,
        minX: Math.min(...points.map((point) => point.x)) - CONFLICT_RADIUS_M,
        minY: Math.min(...points.map((point) => point.y)) - CONFLICT_RADIUS_M,
        maxX: Math.max(...points.map((point) => point.x)) + CONFLICT_RADIUS_M,
        maxY: Math.max(...points.map((point) => point.y)) + CONFLICT_RADIUS_M,
      });
    }
    for (const pair of spatialCandidatePairs(bounds, CONFLICT_GRID_CELL_M)) {
      const a = this.byId.get(pair.a);
      const b = this.byId.get(pair.b);
      if (!a || !b) continue;
      const forA = this.conflictCandidates.get(a.id);
      if (forA) forA.push(b);
      else this.conflictCandidates.set(a.id, [b]);
      const forB = this.conflictCandidates.get(b.id);
      if (forB) forB.push(a);
      else this.conflictCandidates.set(b.id, [a]);
    }
  }

  /**
   * Reactive ambient broadphase: one uniform grid over the live bodies per
   * planning tick. Each ambient actor then gathers candidates from the fixed
   * window of cells covering `REACTIVE_SCAN_RADIUS_M` around it —
   * `O(actors × nearby-actors)` per tick, with no pairwise key allocation.
   *
   * Determinism: buckets are filled by iterating `this.actors` (sorted by id)
   * and a query visits cells in a fixed offset order, so the candidate list
   * for a given world state is identical regardless of map iteration order.
   */
  private buildNearbyIndex(): void {
    this.reactiveGrid.clear();
    if (!this.ambientReactive) return;
    for (const actor of this.actors) {
      if (!actor.present || actor.retired) continue;
      const key = `${Math.floor(actor.position.x / REACTIVE_GRID_CELL_M)},${Math.floor(actor.position.y / REACTIVE_GRID_CELL_M)}`;
      const bucket = this.reactiveGrid.get(key);
      if (bucket) bucket.push(actor);
      else this.reactiveGrid.set(key, [actor]);
    }
  }

  /** Live bodies within one scan radius of `a`, in deterministic order. */
  private nearbyActors(a: ActorRuntime): readonly ActorRuntime[] {
    const cx = Math.floor(a.position.x / REACTIVE_GRID_CELL_M);
    const cy = Math.floor(a.position.y / REACTIVE_GRID_CELL_M);
    const reach = Math.ceil(REACTIVE_SCAN_RADIUS_M / REACTIVE_GRID_CELL_M);
    const collected: ActorRuntime[] = [];
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        const bucket = this.reactiveGrid.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const other of bucket) collected.push(other);
      }
    }
    return collected;
  }

  /**
   * Leader search for one actor. Scripted mode (and every authored actor)
   * keeps the exact `controllers.findLeader` scan. A reactive ambient actor
   * scans only its nearby set, and adds a heading-space fallback: when
   * another body's pose no longer resolves through lane storage onto this
   * route — exactly what a policy-controlled ego does when it leaves its
   * choreography — it is still observed as a physical leader from where it
   * actually stands.
   */
  private findLeaderFor(
    a: ActorRuntime,
  ): { gapM: number; speedMps: number; id: string } | null {
    if (!this.ambientReactive || !this.ambientActorIdSet.has(a.id)) {
      return findLeader(a, this.actors);
    }
    const others = this.nearbyActors(a);
    let best: { gapM: number; speedMps: number; id: string } | null = null;
    const cos = Math.cos(a.headingRad);
    const sin = Math.sin(a.headingRad);
    for (const b of others) {
      if (b.id === a.id || !b.present || b.retired) continue;
      const dx = b.position.x - a.position.x;
      const dy = b.position.y - a.position.y;
      // Bodies beyond one scan radius cannot gate this tick's control.
      if (dx * dx + dy * dy > REACTIVE_MAX_RANGE_M2) continue;
      const halves = a.dims.l / 2 + b.dims.l / 2;
      const joined = alongRouteDistance(a, b);
      let gap: number;
      let lateral: number;
      if (joined === null) {
        // Lane-storage join failed — the deviating-body case. Observe it in
        // the observer's heading frame instead: O(1), no route projection,
        // and exactly the "where does that body stand right now" question
        // reactive mode exists to answer.
        const fwd = dx * cos + dy * sin;
        if (fwd <= 0) continue;
        gap = fwd - halves;
        lateral = -dx * sin + dy * cos;
      } else {
        gap = joined - halves;
        lateral = a.route.lateralOffsetAt(a.routeS + joined, b.position) - a.lateralOffsetM;
      }
      if (!Number.isFinite(lateral) || Math.abs(lateral) > LEADER_CORRIDOR_HALF_WIDTH_M) continue;
      if (best === null || gap < best.gapM) best = { gapM: gap, speedMps: b.speedMps, id: b.id };
    }
    return best;
  }

  /**
   * Crossing-path conflict: the nearest point where two future paths pass
   * within `CONFLICT_RADIUS_M`, when the other actor gets there first and the
   * arrival times are within `CONFLICT_WINDOW_S`.
   *
   * This is a coarse stand-in for a real junction conflict-point table (which
   * lives in `map-intel`'s `conflictPairs`). It is enough to make `rules.yield`
   * behave sensibly at intersections without importing that index.
   */
  private findConflict(a: ActorRuntime): { distM: number; deltaT: number; otherKind: ActorRuntime['kind'] } | null {
    const mine = this.conflictSamples.get(a.id);
    if (!mine || a.speedMps < 0.2) return null;
    let best: { distM: number; deltaT: number; otherKind: ActorRuntime['kind'] } | null = null;
    const candidates = this.hasAmbientTraffic
      ? (this.conflictCandidates.get(a.id) ?? [])
      : this.actors;
    const aIsAmbient = a.tags.includes('ambient');
    for (const b of candidates) {
      if (b.id === a.id || !b.present || b.retired) continue;
      const bIsAmbient = b.tags.includes('ambient');
      // Authored choreography always owns crossing priority over generated
      // background traffic. Rear-end following remains handled independently.
      if (!aIsAmbient && bIsAmbient) continue;
      // Roughly parallel travel is car-following, not a crossing conflict — the
      // leader term already owns it, and double-counting it would leave a
      // steady-state gap error.
      if (Math.abs(normalizeAngle(b.headingRad - a.headingRad)) < CONFLICT_MIN_ANGLE_RAD) continue;
      const theirs = this.conflictSamples.get(b.id);
      if (!theirs) continue;
      for (let i = 1; i < mine.length; i++) {
        const p = mine[i]!;
        for (let j = 0; j < theirs.length; j++) {
          const q = theirs[j]!;
          if (Math.abs(p.x - q.x) > CONFLICT_RADIUS_M || Math.abs(p.y - q.y) > CONFLICT_RADIUS_M) continue;
          if (Math.hypot(p.x - q.x, p.y - q.y) > CONFLICT_RADIUS_M) continue;
          const myDist = i * CONFLICT_STEP_M;
          const theirDist = j * CONFLICT_STEP_M;
          const myT = myDist / Math.max(a.speedMps, 0.2);
          const theirT = theirDist / Math.max(b.speedMps, 0.2);
          const authoredHasPriority = aIsAmbient && !bIsAmbient;
          if (!authoredHasPriority && theirT >= myT) continue;
          const delta = authoredHasPriority ? Math.abs(myT - theirT) : myT - theirT;
          if (delta > CONFLICT_WINDOW_S) continue;
          if (best === null || myDist < best.distM) {
            best = { distM: myDist, deltaT: delta, otherKind: b.kind };
          }
          break;
        }
        if (best) break;
      }
    }
    return best;
  }

  private planActor(a: ActorRuntime, t: number): Plan {
    const plan: Plan = {
      actor: a,
      speed: a.speedMps,
      accel: 0,
      routeS: a.routeS,
      lateralOffset: a.lateralOffsetM,
      lateralRate: a.lateralRateMps,
      lateralAccel: a.lateralAccelMps2 ?? 0,
      lateralReferenceOffset: a.lateralReferenceOffsetM,
      lateralReferenceRate: a.lateralReferenceRateMps,
      lateralReferenceAccel: a.lateralReferenceAccelMps2,
      lateralComplete: false,
      lateralTrackingExpired: null,
      position: a.position,
      heading: a.headingRad,
      requiredDecel: 0,
      retire: false,
      swap: null,
    };
    if (!a.present || a.retired) return plan;
    if (a.static) {
      plan.speed = 0;
      plan.accel = 0;
      plan.routeS = a.routeS;
      plan.lateralOffset = a.lateralOffsetM;
      plan.lateralRate = 0;
      plan.lateralAccel = 0;
      plan.position = a.position;
      plan.heading = a.headingRad;
      return plan;
    }

    if (a.crashDisabledAtS != null) {
      const frictionScale = this.frictionScaleFor(a);
      const emergencyDecel = Math.min(limitsFor(a).brakeHard * frictionScale, Math.max(0, a.speedMps / this.dt));
      const speed = Math.max(0, a.speedMps - emergencyDecel * this.dt);
      plan.accel = -emergencyDecel;
      plan.speed = speed;
      plan.routeS = a.routeS;
      if (this.motionBackend && this.dynamicActorIds.has(a.id)) {
        const result = this.motionBackend.step(a.id, this.hookedIntent(a.id, t, {
          motionDirection: isReverseMotion(a) ? -1 : 1,
          targetSpeedMps: 0,
          targetAccelerationMps2: -emergencyDecel,
          previewPoint: { x: a.position.x + Math.cos(a.headingRad), y: a.position.y + Math.sin(a.headingRad) },
          previewHeadingRad: a.headingRad,
          ...(a.downedAtS != null ? { downed: true } : {}),
        }), this.dt, frictionScale);
        plan.speed = a.downedAtS != null
          ? Math.hypot(result.state.longitudinalVelocityMps, result.state.lateralVelocityMps)
          : Math.abs(result.state.longitudinalVelocityMps);
        plan.accel = result.state.longitudinalAccelerationMps2 * (isReverseMotion(a) ? -1 : 1);
        plan.position = { x: result.state.x, y: result.state.y };
        plan.heading = result.state.yawRad;
        const projected = a.route.projectPoint(plan.position);
        plan.routeS = projected.s;
        plan.lateralOffset = a.route.lateralOffsetAt(projected.s, plan.position);
        plan.lateralRate = result.state.lateralVelocityMps;
        plan.lateralAccel = (result.state.lateralVelocityMps - a.lateralRateMps) / this.dt;
        this.physicsTelemetry.set(a.id, result.telemetry);
      }
      return plan;
    }

    if (a.timedRoute && t + this.dt <= a.timedRoute.at(-1)!.timeS + 1e-9) {
      const sampleAt = Math.min(t + this.dt, this.resolvedInput.clipSeconds);
      const sample = sampleTimedRoute(a.timedRoute, sampleAt, a.headingRad);
      const projected = a.route.projectPoint(sample.position);
      plan.position = sample.position;
      plan.heading = normalizeAngle(sample.headingRad);
      plan.speed = sample.speedMps;
      plan.accel = (sample.speedMps - a.speedMps) / this.dt;
      plan.routeS = projected.s;
      plan.lateralOffset = a.route.lateralOffsetAt(projected.s, sample.position);
      plan.lateralRate = 0;
      plan.lateralAccel = 0;
      plan.lateralReferenceOffset = plan.lateralOffset;
      plan.lateralReferenceRate = 0;
      plan.lateralReferenceAccel = 0;
      plan.retire = false;
      return plan;
    }

    if (a.timedRoute) {
      a.route = releasedTimedRoute(a.timedRoute, a.headingRad);
      a.routeS = 0;
      a.lateralOffsetM = 0;
      a.lateralReferenceOffsetM = 0;
      a.lateralRestOffsetM = 0;
      a.timedRoute = null;
      // The final timed point is a handoff to physics-controlled braking, not
      // an implicit return to cruise. Ignore commands that fired while the
      // pose constraint owned motion; later commands can take ownership again.
      a.longCmd = null;
      a.untilByAxis.delete('longitudinal');
      a.cruiseOverrideMps = 0;
      a.cruiseSpeedMps = 0;
      this.routeRefByActor.set(a.id, semanticResolvedRouteRef(a.route));
      plan.routeS = 0;
      plan.lateralOffset = 0;
      plan.lateralReferenceOffset = 0;
    }

    const lim = limitsFor(a);
    const laneSpeedLimitMps = this.speedLimitAt(a);

    // Re-resolve dynamic longitudinal targets (match / gap follow a moving ref).
    if (a.longCmd?.kind === 'speed' && a.longCmd.speedTarget?.target.mode === 'match') {
      a.longCmd.target = this.resolveSpeedTarget(a, a.longCmd.speedTarget);
      a.cruiseOverrideMps = a.longCmd.target;
      a.cruiseSpeedMps = a.longCmd.target;
    }
    if (a.longCmd?.kind === 'gap' && a.longCmd.gap) {
      a.longCmd.target = desiredGapM(a, a.longCmd.gap.value, a.longCmd.gap.mode, true);
    }

    const dynamicProfile = this.dynamicActorIds.has(a.id) ? this.dynamicBackend?.profile(a.id) : undefined;
    const desiredSpeedMps = a.longCmd?.kind === 'speed'
      ? a.longCmd.target
      : cruiseSpeed(a, laneSpeedLimitMps);
    const corner = isRoadActorKind(a.kind)
      ? corneringPlan({
          route: a.route,
          routeS: a.routeS,
          currentSpeedMps: Math.abs(a.speedMps),
          desiredSpeedMps,
          comfortableLateralAccelerationMps2: a.driver?.comfortableLateralAccelerationMps2 ?? 2.2,
          comfortableDecelerationMps2: a.driver?.comfortableDecelerationMps2 ?? 2.5,
          physicalLateralAccelerationMps2: dynamicProfile?.maxLateralAccelerationMps2 ?? lim.lateralAccelMax,
          physicalDecelerationMps2: dynamicProfile?.maxLongitudinalDecelMps2 ?? lim.brakeHard,
        })
      : { speedLimitMps: Number.POSITIVE_INFINITY, accelerationCapMps2: Number.POSITIVE_INFINITY };

    const commandedLeader =
      a.longCmd?.kind === 'gap' && a.longCmd.gap ? this.leaderFromId(a, a.longCmd.gap.actorId) : null;
    const sourceLeader = a.bestEffortWorldPath ? null : this.findLeaderFor(a);
    let targetLeader: ReturnType<typeof findLeader> = null;
    if (!a.bestEffortWorldPath && a.latCmd?.kind === 'changeLane' && a.latCmd.pending) {
      const targetRoute = a.latCmd.pending.route;
      const targetS = targetRoute.projectPoint(a.position).s;
      const targetObserver: ActorRuntime = {
        ...a,
        route: targetRoute,
        routeS: targetS,
        // Query the reserved destination corridor, not the body's current
        // cross-lane offset from that route.
        lateralOffsetM: 0,
      };
      // Reserve the destination gap from the beginning of a lane change. A
      // slow manoeuvre must not remain blind to a leader merely because its
      // route hand-off is intentionally deferred until the physical body has
      // crossed the lane marking.
      targetLeader = findLeader(targetObserver, this.actors, targetRoute.widthAt(targetS) / 2 + 0.5);
    }
    const nearestLeader = sourceLeader === null
      ? targetLeader
      : targetLeader === null || sourceLeader.gapM <= targetLeader.gapM
        ? sourceLeader
        : targetLeader;
    let accel = longitudinalAccel({
      actor: a,
      t,
      dt: this.dt,
      laneSpeedLimitMps,
      leader: commandedLeader ?? nearestLeader,
    });

    const stopLineDist = a.bestEffortWorldPath
      ? null
      : distanceToStopLine(
          a, this.signals, t, LOOKAHEAD_M, nearestLeader,
          (controlId, coordinationId, actorId, at) => this.canReleaseStop(controlId, coordinationId, actorId, at),
        );
    const conflict = a.bestEffortWorldPath ? null : this.findConflict(a);
    const gov = governorCap(a, nearestLeader, stopLineDist, conflict);
    if (gov.accelCap < accel) accel = gov.accelCap;
    if (corner.accelerationCapMps2 < accel) accel = corner.accelerationCapMps2;
    const frictionScale = this.frictionScaleFor(a);
    accel = Math.max(accel, -lim.brakeHard * frictionScale);
    // The body still brakes for a generated car in front — `accel` above is
    // untouched — but the *evidence* figure `requiredDecelMax` must keep
    // meaning "how hard the authored scenario made this actor brake". Crediting
    // background traffic with the ego's braking demand would let ambient
    // traffic manufacture the criticality the scenario is supposed to prove.
    // Ambient actors keep the full figure: it is their own honest telemetry.
    const leaderIsAmbient = nearestLeader !== null && this.ambientActorIdSet.has(nearestLeader.id);
    plan.requiredDecel = leaderIsAmbient && !this.ambientActorIdSet.has(a.id)
      ? gov.requiredDecelExcludingLeader
      : gov.requiredDecel;

    let speed = a.speedMps + accel * this.dt;
    if (speed < 0) {
      speed = 0;
      accel = -a.speedMps / this.dt;
    }
    // Reverse gear has a single ratio and runs out of engine speed well below
    // road speed. Govern the magnitude here, at the one choke point every
    // longitudinal source funnels through, so an authored target, a free-flow
    // cruise speed and a car-following output are all bounded identically —
    // rather than special-casing the authored one and letting the others
    // through.
    const gearedSpeed = governSpeedForGear(speed, a.motionDirection);
    if (gearedSpeed < speed) {
      accel = Math.max((gearedSpeed - a.speedMps) / this.dt, -lim.brakeHard * frictionScale);
      speed = Math.max(a.speedMps + accel * this.dt, 0);
    }
    plan.accel = accel;
    plan.speed = speed;
    plan.routeS = a.routeS + speed * this.dt;

    const lat = lateralStep(a, t, this.dt);
    plan.lateralReferenceOffset = lat.offset;
    plan.lateralReferenceRate = lat.rate;
    plan.lateralReferenceAccel = lat.accel;
    plan.lateralComplete = lat.complete;
    if (!this.dynamicActorIds.has(a.id) && a.latCmd?.kind === 'changeLane' && lat.complete && !a.latCmd.done) {
      plan.swap = a.latCmd.pending ?? null;
    }

    if (this.motionBackend && this.dynamicActorIds.has(a.id)) {
      const dynamicTargetSpeed = speed;
      const dynamicTargetAcceleration = accel;
      const shortSteeringLookaheadM = dynamicProfile
        ? Math.max(dynamicProfile.wheelbaseM * 0.85, Math.abs(a.speedMps) * 0.25)
        : Math.max(5, Math.abs(a.speedMps) * 0.8);
      // Tiny alternating headings in tessellated lane centrelines must not be
      // amplified into left/right steering. On a geometrically straight
      // horizon, use a longer pure-pursuit chord; retain the short horizon as
      // soon as a material bend is ahead so turn tracking is unchanged.
      const headingAtRouteS = a.route.poseAt(a.routeS).headingRad;
      const curvatureHorizonM = Math.max(10, Math.abs(a.speedMps));
      let maxHeadingChangeAheadRad = 0;
      for (let sampleM = 2.5; sampleM <= curvatureHorizonM + 1e-9; sampleM += 2.5) {
        const sampleHeading = a.route.poseAt(Math.min(a.route.lengthM, a.routeS + sampleM)).headingRad;
        maxHeadingChangeAheadRad = Math.max(
          maxHeadingChangeAheadRad,
          Math.abs(angleDelta(headingAtRouteS, sampleHeading)),
        );
      }
      const steeringLookaheadM = a.latCmd
        ? Math.max(5, Math.abs(a.speedMps) * 0.8)
        : maxHeadingChangeAheadRad < 3 * Math.PI / 180
          ? Math.max(4, Math.abs(a.speedMps) * 0.5, shortSteeringLookaheadM)
          : shortSteeringLookaheadM;
      const previewS = Math.min(
        a.route.lengthM,
        a.routeS + steeringLookaheadM,
      );
      const previewPose = a.route.poseAt(previewS);
      const previewTimeS = Math.max(0.4, (previewS - a.routeS) / Math.max(Math.abs(a.speedMps), 1));
      // A force-based body needs a spatial reference ahead of its current
      // position. Feeding it only the one-tick lateral schedule produces a
      // vanishing steering angle (centimetres of offset several metres away),
      // so project the authored transition to the same look-ahead horizon used
      // by pure pursuit. This preserves the timeline's rate/time semantics
      // without teleporting the body onto the kinematic schedule.
      const previewLateralReference = a.latCmd
        ? minimumJerkSample(
            a.latCmd.from,
            a.latCmd.to,
            t + this.dt + previewTimeS - a.latCmd.firedAt,
            a.latCmd.duration,
          )
        : {
            offset: plan.lateralReferenceOffset,
            rate: plan.lateralReferenceRate,
            accel: plan.lateralReferenceAccel,
          };
      // Dynamic-v1 owns the physical body. Pure pursuit already measures the
      // body's ordinary cross-track error from its world position to this
      // future route reference. Mirroring an idle target across the centreline
      // applies that correction twice and makes short/narrow actors hunt from
      // side to side. An active authored lateral transition still needs its
      // explicit schedule-tracking feedback to meet the commanded duration.
      const measuredTrackingErrorM = a.lateralOffsetM - a.lateralReferenceOffsetM;
      const trackingPreviewOffset = previewLateralReference.offset - (a.latCmd ? measuredTrackingErrorM : 0);
      const result = this.motionBackend.step(a.id, this.hookedIntent(a.id, t, {
        motionDirection: isReverseMotion(a) ? -1 : 1,
        targetSpeedMps: dynamicTargetSpeed,
        targetAccelerationMps2: dynamicTargetAcceleration,
        previewPoint: a.route.pointWithOffset(previewS, trackingPreviewOffset),
        // The preview point already carries the future spatial offset. Heading
        // uses the current reference rate so the controller does not apply the
        // same future lateral transition twice (bearing and body slip).
        previewHeadingRad: headingWithSlip(previewPose.headingRad, plan.lateralReferenceRate, Math.max(plan.speed, 0.5)),
      }), this.dt, frictionScale);
      const projected = a.route.projectPoint({ x: result.state.x, y: result.state.y });
      const projectedOffset = a.route.lateralOffsetAt(projected.s, {
        x: result.state.x,
        y: result.state.y,
      });
      // Permit a modest tyre/body envelope beyond the painted lane centre
      // corridor. The route remains authoritative, but a physically integrated
      // body can briefly overhang a marking while completing a real turn.
      const roadCenterAllowanceM = Math.max(0.2, a.route.widthAt(projected.s) / 2 - a.dims.w / 2 + 0.5);
      // A legal lane change deliberately leaves the source-lane envelope.
      // Expand the route corridor only as far as the active authored lateral
      // command; otherwise the safety guard would retire the actor at the lane
      // marking before it can hand off to the adjacent route.
      const commandedLateralAllowanceM = a.latCmd
        ? Math.max(Math.abs(a.latCmd.from), Math.abs(a.latCmd.to)) + a.dims.w / 2 + 0.25
        : 0;
      const allowedCenterOffsetM = Math.max(roadCenterAllowanceM, commandedLateralAllowanceM);
      if (
        this.ambientActorIdSet.has(a.id) &&
        !a.tags.includes('motion:off-road') &&
        Math.abs(projectedOffset) > allowedCenterOffsetM
      ) {
        // Never publish the first off-corridor integration for generated
        // traffic. Hold the last valid map pose and retire this ambient actor;
        // a later population refresh may replace it from a connected candidate.
        // Authored actors keep their physically integrated motion: silently
        // stopping one is a safety-policy intervention, not realistic driving.
        plan.speed = 0;
        plan.accel = -a.speedMps / this.dt;
        plan.routeS = a.routeS;
        plan.lateralOffset = a.lateralOffsetM;
        plan.lateralRate = 0;
        plan.lateralAccel = 0;
        plan.position = a.position;
        plan.heading = a.headingRad;
        plan.retire = true;
        this.events.push({
          t,
          kind: 'road_departure_prevented',
          actorId: a.id,
          laneRsl: a.route.poseAt(a.routeS).rsl,
          lateralErrorM: Math.abs(projectedOffset),
          allowedCenterOffsetM,
        });
        return plan;
      }
      plan.speed = Math.abs(result.state.longitudinalVelocityMps);
      plan.accel = result.state.longitudinalAccelerationMps2 * (isReverseMotion(a) ? -1 : 1);
      plan.routeS = projected.s;
      plan.lateralOffset = projectedOffset;
      plan.lateralRate = (projectedOffset - a.lateralOffsetM) / this.dt;
      plan.lateralAccel = (plan.lateralRate - a.lateralRateMps) / this.dt;
      plan.position = { x: result.state.x, y: result.state.y };
      plan.heading = result.state.yawRad;
      this.physicsTelemetry.set(a.id, result.telemetry);
      if (lat.complete && a.latCmd) {
        const referenceHeading = normalizeAngle(
          headingWithSlip(
            a.route.poseAt(projected.s).headingRad,
            plan.lateralReferenceRate,
            Math.max(plan.speed, 0.5),
          ) + (isReverseMotion(a) ? Math.PI : 0),
        );
        const positionErrorM = plan.lateralOffset - plan.lateralReferenceOffset;
        const rateErrorMps = plan.lateralRate - plan.lateralReferenceRate;
        const headingErrorRad = angleDelta(referenceHeading, plan.heading);
        plan.lateralComplete =
          Math.abs(positionErrorM) <= DYNAMIC_LATERAL_SETTLE_POSITION_M &&
          Math.abs(rateErrorMps) <= DYNAMIC_LATERAL_SETTLE_RATE_MPS &&
          Math.abs(headingErrorRad) <= DYNAMIC_LATERAL_SETTLE_HEADING_RAD;
        if (plan.lateralComplete && a.latCmd.kind === 'changeLane') {
          plan.swap = a.latCmd.pending ?? null;
        } else {
          const settleDeadlineS = a.latCmd.firedAt + a.latCmd.duration + Math.max(2, a.latCmd.duration);
          if (t + this.dt >= settleDeadlineS - 1e-9) {
            plan.lateralTrackingExpired = { positionErrorM, rateErrorMps, headingErrorRad };
          }
        }
      }
    }

    if (plan.routeS >= a.route.lengthM - ROUTE_END_SLACK_M) {
      plan.routeS = a.route.lengthM;
      // A route is a motion path, not an implicit lifecycle instruction. Hold
      // every semantic class at its terminal pose for truthful aftermath
      // evidence; only an explicit exist(absent) interaction may despawn it.
      plan.accel = -a.speedMps / this.dt;
      plan.speed = 0;
      plan.lateralRate = 0;
      plan.lateralAccel = 0;
      plan.retire = true;
      // The force solver can cross the terminal station within its final
      // synchronized tick. Retiring the actor must snap the rendered body to
      // the route endpoint just as the kinematic backend does, rather than
      // freezing a small dynamic overshoot forever.
      const terminalPose = a.route.poseAt(plan.routeS);
      plan.position = a.route.pointWithOffset(plan.routeS, plan.lateralOffset);
      plan.heading = normalizeAngle(
        headingWithSlip(terminalPose.headingRad, 0, 0) + (isReverseMotion(a) ? Math.PI : 0),
      );
    }

    if (!this.dynamicActorIds.has(a.id)) {
      plan.lateralOffset = plan.lateralReferenceOffset;
      plan.lateralRate = plan.lateralReferenceRate;
      plan.lateralAccel = plan.lateralReferenceAccel;
      const pose: RoutePose = a.route.poseAt(plan.routeS);
      plan.position = a.route.pointWithOffset(plan.routeS, plan.lateralOffset);
      plan.heading = normalizeAngle(
        headingWithSlip(pose.headingRad, plan.lateralRate, plan.speed) + (isReverseMotion(a) ? Math.PI : 0),
      );
    }
    return plan;
  }

  private leaderFromId(a: ActorRuntime, id: string): { gapM: number; speedMps: number } | null {
    const b = this.byId.get(id);
    if (!b || !b.present || b.retired) return null;
    const gap = alongRouteGapM(a, b);
    if (gap === null) return null;
    return { gapM: Math.max(gap, 0.05), speedMps: b.speedMps };
  }

  private applyAll(plans: readonly Plan[], t: number): void {
    for (const plan of plans) {
      const a = plan.actor;
      if (!a.present || a.retired) continue;
      a.speedMps = plan.speed;
      a.accelMps2 = plan.accel;
      a.routeS = plan.routeS;
      a.lateralOffsetM = plan.lateralOffset;
      a.lateralRateMps = plan.lateralRate;
      a.lateralAccelMps2 = plan.lateralAccel;
      a.lateralReferenceOffsetM = plan.lateralReferenceOffset;
      a.lateralReferenceRateMps = plan.lateralReferenceRate;
      a.lateralReferenceAccelMps2 = plan.lateralReferenceAccel;
      a.position = plan.position;
      a.headingRad = plan.heading;
      if (a.timedRoute && a.crashDisabledAtS == null && this.motionBackend && this.dynamicActorIds.has(a.id)) {
        const current = this.motionBackend.state(a.id);
        this.motionBackend.setState(a.id, {
          x: plan.position.x,
          y: plan.position.y,
          yawRad: plan.heading,
          longitudinalVelocityMps: plan.speed * (isReverseMotion(a) ? -1 : 1),
          lateralVelocityMps: 0,
          yawRateRadps: 0,
          steerRad: current?.steerRad ?? 0,
          wheelAngularSpeedRadps: current?.wheelAngularSpeedRadps ?? 0,
          longitudinalAccelerationMps2: plan.accel * (isReverseMotion(a) ? -1 : 1),
        });
      }
      if (t >= 0) a.requiredDecelMax = Math.max(a.requiredDecelMax, plan.requiredDecel);

      if (a.speedMps < 0.05) {
        if (a.standstillSinceS === null) a.standstillSinceS = t;
      } else {
        a.standstillSinceS = null;
      }
      // Latched once the body has actually driven. A gear change means something
      // different before and after this point — see `engagePendingGear`.
      if (a.speedMps > GEAR_ENGAGE_SPEED_MPS) a.hasMoved = true;

      if (plan.lateralTrackingExpired && a.latCmd) {
        const cmd = a.latCmd;
        const error = plan.lateralTrackingExpired;
        this.abortLateral(cmd.interactionId, a.id, t, 'tracking_error');
        this.issues.push(issue(
          'lateral_tracking_failed',
          `interactions.${cmd.interactionId}`,
          `dynamic actor ${a.id} did not physically settle onto its authored lateral reference`,
          {
            actorId: a.id,
            interactionId: cmd.interactionId,
            referenceDurationS: cmd.duration,
            positionErrorM: error.positionErrorM,
            rateErrorMps: error.rateErrorMps,
            headingErrorRad: error.headingErrorRad,
          },
          'warning',
        ));
        const untilOwner = a.untilByAxis.get('lateral');
        if (untilOwner?.interactionId === cmd.interactionId) a.untilByAxis.delete('lateral');
        a.latCmd = null;
        a.lateralReferenceOffsetM = a.lateralRestOffsetM ?? a.lateralOffsetM;
        a.lateralReferenceRateMps = 0;
        a.lateralReferenceAccelMps2 = 0;
      }

      if (!plan.lateralTrackingExpired && plan.swap && a.latCmd) {
        const cmd = a.latCmd;
        const fromRsl = a.route.poseAt(a.routeS).rsl;
        // `pending.s` is the target-route station at the *start* of the
        // manoeuvre.  Reusing it at completion teleports a moving actor back
        // to that old station, which can manufacture an overlap/contact at a
        // perfectly continuous lane change.  Project the completed world pose
        // onto the target route instead, preserving the travelled station and
        // any residual lateral offset through the route hand-off.
        const completedPosition = a.position;
        const projected = plan.swap.route.projectPoint(completedPosition);
        a.route = plan.swap.route;
        this.routeRefByActor.set(a.id, semanticResolvedRouteRef(a.route));
        a.routeS = projected.s;
        // The preflighted separation targets this route's centreline exactly.
        // Completing with a residual projection error makes the authored end
        // pose disagree with OSC even though the profile reached its target.
        a.lateralOffsetM = a.route.lateralOffsetAt(projected.s, completedPosition);
        a.lateralReferenceOffsetM = 0;
        a.lateralReferenceRateMps = 0;
        a.lateralReferenceAccelMps2 = 0;
        a.lateralRestOffsetM = 0;
        if (!this.dynamicActorIds.has(a.id)) a.lateralRateMps = 0;
        // Preserve the integrated world pose across the route-frame handoff.
        a.position = completedPosition;
        this.events.push({
          t,
          kind: 'lane_change',
          actorId: a.id,
          fromRsl,
          toRsl: plan.swap.targetRsl,
          legal: true,
        });
        a.latCmd = null;
        if (!this.dynamicActorIds.has(a.id)) a.lateralAccelMps2 = 0;
        this.events.push({ t, kind: 'interaction_completed', interactionId: cmd.interactionId, actorId: a.id, finalLateralOffsetM: 0 });
        this.releaseAxis(a, 'lateral', t, cmd.interactionId, 'complete');
      }

      if (!plan.lateralTrackingExpired && plan.lateralComplete && a.latCmd?.kind === 'laneOffset') {
        const cmd = a.latCmd;
        a.lateralReferenceOffsetM = cmd.to;
        a.lateralReferenceRateMps = 0;
        a.lateralReferenceAccelMps2 = 0;
        a.lateralRestOffsetM = cmd.to;
        if (!this.dynamicActorIds.has(a.id)) {
          a.lateralOffsetM = cmd.to;
          a.position = a.route.pointWithOffset(a.routeS, cmd.to);
          a.lateralRateMps = 0;
        }
        a.latCmd = null;
        if (!this.dynamicActorIds.has(a.id)) a.lateralAccelMps2 = 0;
        this.events.push({ t, kind: 'interaction_completed', interactionId: cmd.interactionId, actorId: a.id, finalLateralOffsetM: cmd.to });
        this.releaseAxis(a, 'lateral', t, cmd.interactionId, 'complete');
      }

      if (plan.retire) {
        a.retired = true;
      }
    }
    this.resolveDynamicContacts();
  }

  /** Resolve all moving bodies together. Only explicit fixed/static actors,
   * props, and map proxies have infinite mass. */
  private resolveDynamicContacts(): void {
    if (!this.dynamicBackend) return;
    const activeActors = this.actors
      .filter((actor) => this.dynamicActorIds.has(actor.id) && actor.present && !actor.retired);
    const active = new Set(activeActors.map((actor) => actor.id));
    const nearbyStatics = new Map<string, StaticCollisionShape>();
    for (const actor of activeActors) {
      const current = this.collisionShapes(actor, this.world.t);
      for (const shape of this.staticCollisionCandidates(
        actor.id,
        current,
        this.collisionSnapshots.get(actor.id)?.shapes,
      )) nearbyStatics.set(shape.id, shape);
    }
    const fixedActors = this.actors
      .filter((actor) => !this.dynamicActorIds.has(actor.id) && actor.present && !actor.retired)
      .map((actor) => {
        const direction = isReverseMotion(actor) ? -1 : 1;
        return {
          id: actor.id,
          obb: this.obbOf(actor),
          velocity: {
            x: Math.cos(actor.headingRad) * actor.speedMps * direction,
            y: Math.sin(actor.headingRad) * actor.speedMps * direction,
          },
        };
      });
    // The velocity each vulnerable body carried into the contact. A knockdown is
    // about what the contact *added*, so this is the baseline it is measured
    // against — see `applyKnockdowns`.
    const speedBeforeContact = new Map<string, number>();
    for (const actor of activeActors) {
      if (!isKnockdownVulnerableKind(actor.kind)) continue;
      const state = this.dynamicBackend.state(actor.id);
      if (state) {
        speedBeforeContact.set(actor.id, Math.hypot(state.longitudinalVelocityMps, state.lateralVelocityMps));
      }
    }
    const impulses = this.dynamicBackend.resolveCollisions(
      active,
      [
        ...[...nearbyStatics.values()]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((shape) => ({ id: shape.id, obb: shape.obb })),
        ...fixedActors,
      ],
      this.dt,
    );
    this.applyKnockdowns(impulses, speedBeforeContact);
    for (const actor of this.actors) {
      if (!active.has(actor.id)) continue;
      const state = this.dynamicBackend.state(actor.id)!;
      actor.position = { x: state.x, y: state.y };
      actor.headingRad = state.yawRad;
      // A body on the ground slides whichever way it was thrown, so its speed
      // is the planar magnitude. Taking the longitudinal component alone would
      // report a side impact as stationary.
      actor.speedMps = actor.downedAtS != null
        ? Math.hypot(state.longitudinalVelocityMps, state.lateralVelocityMps)
        : Math.abs(state.longitudinalVelocityMps);
      actor.lateralRateMps = state.lateralVelocityMps;
      const projected = actor.route.projectPoint(actor.position);
      actor.routeS = projected.s;
      actor.lateralOffsetM = actor.route.lateralOffsetAt(projected.s, actor.position);
      const telemetry = this.dynamicBackend.telemetry(actor.id);
      if (telemetry) this.physicsTelemetry.set(actor.id, telemetry);
    }
  }

  /**
   * Take vulnerable bodies off their feet when the contact threw them harder
   * than they could have caught themselves.
   *
   * The test is the velocity the contact *added*, not the impulse it carried.
   * Those differ in the case that matters: a walker who strides into a parked
   * car takes an impulse of the same order, but it only arrests momentum the
   * walker already had — a bump, not a knockdown — while a car striking a
   * standing pedestrian adds all of it. Comparing planar speed across the
   * contact separates the two without needing contact normals, and it keeps the
   * threshold in the units it is argued in: the sideways velocity a person can
   * still recover their balance from.
   *
   * Drones are excluded: they hold altitude and have no stance to lose.
   */
  private applyKnockdowns(
    impulses: readonly CollisionImpulse[],
    speedBeforeContact: ReadonlyMap<string, number>,
  ): void {
    if (impulses.length === 0) return;
    const normalByActor = new Map<string, { impulseNs: number; otherId: string }>();
    for (const impulse of impulses) {
      for (const [id, otherId] of [[impulse.a, impulse.b], [impulse.b, impulse.a]] as const) {
        const previous = normalByActor.get(id);
        normalByActor.set(id, {
          impulseNs: (previous?.impulseNs ?? 0) + impulse.normalImpulseNs,
          otherId: previous?.otherId ?? otherId,
        });
      }
    }
    // Sorted so the event order cannot depend on solver iteration order.
    for (const actorId of [...normalByActor.keys()].sort()) {
      const actor = this.byId.get(actorId);
      if (!actor || actor.static || actor.downedAtS != null) continue;
      if (!isKnockdownVulnerableKind(actor.kind)) continue;
      const before = speedBeforeContact.get(actorId);
      const state = this.dynamicBackend?.state(actorId);
      if (before == null || !state) continue;
      const after = Math.hypot(state.longitudinalVelocityMps, state.lateralVelocityMps);
      if (after - before < BALANCE_RECOVERY_DELTA_V_MPS) continue;
      const { impulseNs, otherId } = normalByActor.get(actorId)!;
      actor.downedAtS = this.world.t;
      actor.downedByActorId = otherId;
      // Planning routes a downed body through the crash-disabled branch, so the
      // two must never disagree. Contact detection normally sets this first;
      // assert it here so a knockdown can never leave a body still steering.
      if (actor.crashDisabledAtS == null) {
        actor.crashDisabledAtS = this.world.t;
        actor.crashDisabledReason = `material-collision:${otherId}`;
        actor.longCmd = null;
        actor.latCmd = null;
        actor.lateralAccelMps2 = 0;
        actor.untilByAxis.clear();
      }
      this.events.push({
        t: this.world.t,
        kind: 'knocked_down',
        actorId,
        otherId,
        normalImpulseNs: impulseNs,
      });
    }
  }

  /* --------------------------------------------------------------- output */

  private record(t: number, collisions: ReadonlySet<string>, observeMetrics: boolean): void {
    this.tArray.push(t);
    for (const id of this.signals.ids()) {
      const phase = this.signals.phaseAt(id, t);
      if (phase) this.signalTracks.get(id)!.phase.push(phase);
    }
    for (const a of this.actors) {
      const track = this.tracks.get(a.id)!;
      const pose = a.route.poseAt(a.routeS);
      track.x.push(a.position.x);
      track.y.push(a.position.y);
      track.headingRad.push(a.headingRad);
      track.speedMps.push(a.speedMps);
      track.lateralOffsetM.push(a.lateralOffsetM);
      track.motionDirection!.push(isReverseMotion(a) ? -1 : 1);
      // A freeform (polyline) route carries no lane identity, so a body backing
      // out of a driveway would otherwise report `null` for the whole manoeuvre
      // — including the part where it is squarely in the ego's lane. Fall back
      // to lane-graph membership at the body's actual position.
      track.laneRsl.push(pose.rsl ?? (a.route.isFreeform ? this.freeformLaneRsl(a) : null));
      track.s.push(a.routeS);
      // `retired` means motion/interaction has finished. Pedestrians remain
      // visibly present at their terminal pose until an explicit despawn.
      track.present.push(a.present ? 1 : 0);
      this.routeRefTracks.get(a.id)!.push(this.routeRefByActor.get(a.id)!);
      if (track.physics) {
        const state = this.motionBackend?.state(a.id);
        const telemetry = this.physicsTelemetry.get(a.id) ?? this.motionBackend?.telemetry(a.id);
        track.physics.vxBodyMps.push(state?.longitudinalVelocityMps ?? 0);
        track.physics.vyBodyMps.push(state?.lateralVelocityMps ?? 0);
        track.physics.yawRateRadps.push(state?.yawRateRadps ?? 0);
        track.physics.steerRad.push(state?.steerRad ?? 0);
        track.physics.wheelAngularSpeedRadps.push(state?.wheelAngularSpeedRadps ?? 0);
        track.physics.tireUtilization.push(telemetry?.tireUtilization ?? 0);
        track.physics.frontNormalForceN.push(telemetry?.frontNormalForceN ?? 0);
        track.physics.rearNormalForceN.push(telemetry?.rearNormalForceN ?? 0);
        track.physics.collisionImpulseNs.push(telemetry?.collisionImpulseNs ?? 0);
        track.physics.collisionCount.push(telemetry?.collisionCount ?? 0);
      }
    }
    if (observeMetrics) {
      observeTick(
        this.metrics,
        t,
        this.actors,
        collisions,
        this.occludersForTick(),
        this.resolvedInput.operationalConditions.effects.visibilityRangeM,
        new Map(this.actors
          .filter((actor) => actor.static)
          .map((actor) => [actor.id, this.collisionShapes(actor, t)])),
      );
    }
  }

  private finishNeverFired(): void {
    for (const tr of this.triggers) {
      if (tr.status === 'pending') {
        tr.status = 'skipped';
        this.metrics.triggerNeverFired.push(tr.interaction.id);
        this.events.push({
          t: this.resolvedInput.clipSeconds,
          kind: 'trigger_skipped',
          interactionId: tr.interaction.id,
          actorId: tr.interaction.actorId,
          reason: 'clip_ended',
        });
      }
    }
    for (const actor of this.actors) {
      if (!actor.latCmd) continue;
      this.abortLateral(actor.latCmd.interactionId, actor.id, this.resolvedInput.clipSeconds, 'clip_end');
      actor.latCmd = null;
      if (!this.dynamicActorIds.has(actor.id)) actor.lateralAccelMps2 = 0;
    }
    this.metrics.triggerNeverFired.sort();
  }

  private buildTrace(): SimTrace {
    const input = this.resolvedInput;
    const actorIds = this.actors.map((a) => a.id);
    const actorMetadata = Object.fromEntries(
      [...this.actors]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((a) => [a.id, {
          kind: a.kind,
          dims: { ...a.dims },
          static: a.static,
          tags: [...a.tags],
        }]),
    );
    const propMetadata = Object.fromEntries(
      input.props.map((prop) => [
        prop.id,
        { ...prop, dims: { ...prop.dims }, pose: { ...prop.pose } },
      ]),
    );
    const actors: Record<string, ActorTrack> = {};
    for (const id of [...actorIds].sort()) {
      const track = this.tracks.get(id)!;
      const downedAtS = this.byId.get(id)?.downedAtS;
      actors[id] = downedAtS != null ? { ...track, downSinceS: downedAtS } : track;
    }
    const signals: Record<string, SignalTrack> = {};
    for (const id of this.signals.ids()) signals[id] = this.signalTracks.get(id)!;
    for (const a of this.actors) {
      this.metrics.requiredDecelMax[a.id] = a.requiredDecelMax;
    }
    const trace: Omit<SimTrace, 'semanticLedger'> = {
      header: {
        traceVersion: TRACE_FORMAT_VERSION,
        engineVersion: ENGINE_VERSION,
        inputHash: contentHash(input),
        seed: input.seed,
        mapId: input.mapId,
        engineGraphDigest: this.graph.topologyDigest,
        topologyDigest: this.graph.topologyDigest,
        dt: this.dt,
        clipSeconds: input.clipSeconds,
        warmupSeconds: input.warmupSeconds,
        frame: 'xodr-local',
        actorIds: [...actorIds].sort(),
        actorMetadata,
        propMetadata,
        // Optional on purpose: a scenario with no ambient traffic writes the
        // exact bytes it wrote before this channel existed, so every historical
        // trace digest still reproduces.
        ...(this.ambientActorIds.length > 0 ? { ambientActorIds: [...this.ambientActorIds] } : {}),
        metricSubject: input.metricSubject ?? null,
        operationalConditions: input.operationalConditions,
        physics: {
          mode: this.physicsConfig.mode,
          solver: 'uniscenarios-sim-engine',
          solverVersion: ENGINE_VERSION,
          substepS: this.motionBackend?.substepS ?? this.dt,
          vehicleProfileDigest: this.physicsConfig.vehicleProfiles
            ? contentHash(this.physicsConfig.vehicleProfiles)
            : null,
          resolvedProfileDigest: contentHash({
            version: 1,
            profiles: ACTOR_PHYSICS_PROFILES,
            overrides: this.physicsConfig.vehicleProfiles ?? {},
          }),
          actorBackends: actorPhysicsBackends(this.actors, this.physicsConfig),
          crashes: Object.fromEntries(this.actors
            .filter((actor) => actor.crashDisabledAtS != null)
            .map((actor) => {
              const otherId = actor.crashDisabledReason?.slice('material-collision:'.length) ?? 'unknown';
              return [actor.id, { t: actor.crashDisabledAtS!, otherId, reason: 'material-collision' as const }];
            })),
        },
      },
      ticks: {
        t: this.tArray,
        actors,
        signals,
        ...(this.perception
          ? {
              sensors: this.perception.sensorTracks(),
              mapDivergence: this.perception.divergenceTracks(),
            }
          : {}),
      },
      events: this.events,
      metrics: {
        ...computeMetrics(this.metrics, input.clipSeconds),
        ...(this.perception ? { perception: this.perception.metrics() } : {}),
      },
    };
    return {
      ...trace,
      semanticLedger: buildSemanticLedger({
        trace,
        input,
        triggers: this.triggers,
        triggerTruthTransitions: this.triggerTruthTransitions,
        initialRouteRefs: this.initialRouteRefByActor,
        routeRefs: this.routeRefTracks,
        complete: this.finished,
      }),
    };
  }
}

/** Line-of-sight helper re-exported for callers building occlusion UIs. */
export { hasLineOfSight };
