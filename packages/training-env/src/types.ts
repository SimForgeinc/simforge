/**
 * Environment-level contracts for the SimForge RL core.
 *
 * Everything here is deterministic: no wall clock, no `Math.random`, no
 * iteration-order dependence. A policy that replays the same action sequence
 * against the same seed observes byte-identical episodes.
 */

import type { Vec2, VehicleControl } from '@simforge-oss/engine';

/** One policy decision, applied to the metric-subject actor via the engine's action hook. */
export interface EnvAction {
  /** Setpoint override; `undefined` fields keep the authored choreography. */
  readonly targetSpeedMps?: number;
  readonly targetAccelerationMps2?: number;
  readonly motionDirection?: -1 | 1;
  /**
   * Pure-pursuit steering override: aim the dynamic backend's bicycle
   * steering at this world-frame point/heading instead of the authored
   * route (set together by the trajectory executor; see
   * `@simforge-oss/engine` sim/trajectory-follower.ts).
   */
  readonly previewPoint?: Vec2;
  readonly previewHeadingRad?: number;
  /**
   * Low-level control passthrough (steer/pedals) into the force-based backend.
   * Stays inside the profile's steer clamp/rate/lag and jerk envelope.
   */
  readonly control?: VehicleControl;
}

/** Provisional reward weights. Documented as provisional in rl-plan Phase 1; tune before Phase 3 training. */
export interface RewardConfig {
  /** Applied once when a collision involving the ego terminates the episode. */
  collisionPenalty: number;
  /** Applied once when the configured goal (trigger fire or route end) is met. */
  goalBonus: number;
  /** Per metre of ego route progress within one decision interval. */
  progressWeight: number;
  /** Per-decision penalty weight on standing too close to any other actor. */
  proximityWeight: number;
  /** Actors closer than this contribute the proximity penalty. */
  proximityRangeM: number;
  /** Per-decision penalty weight on absolute longitudinal acceleration. */
  comfortAccelWeight: number;
}

export const DEFAULT_REWARD_CONFIG: RewardConfig = {
  collisionPenalty: -10,
  goalBonus: 10,
  progressWeight: 0.05,
  proximityWeight: 0.02,
  proximityRangeM: 15,
  comfortAccelWeight: 0.005,
};

/** Ego-centric BEV raster geometry. The raster itself is built by `BevRasterBuilder`. */
export interface BevConfig {
  /** Metres per cell edge. */
  resolutionM: number;
  /** Forward extent from the ego bumper origin, metres. */
  forwardM: number;
  /** Backward extent behind the ego, metres. */
  backwardM: number;
  /** Half-width of the raster either side of the ego, metres. */
  halfWidthM: number;
  /** Half-width used when stamping lane surface polygons. */
  laneHalfWidthM: number;
}

export const DEFAULT_BEV_CONFIG: BevConfig = {
  resolutionM: 0.25,
  forwardM: 40,
  backwardM: 10,
  halfWidthM: 20,
  laneHalfWidthM: 1.75,
};

/** Observation-channel switches. Each builder stays behind its own interface so Phase 7 can add pixel channels without touching EnvSession. */
export interface ObservationConfig {
  stateVector: boolean;
  /** Object-list gating range when an actor declares no sensors. */
  objectListRangeM: number;
  bev: Partial<BevConfig> | null;
}
export const DEFAULT_OBSERVATION_CONFIG: ObservationConfig = {
  stateVector: true,
  objectListRangeM: 60,
  bev: null,
};

/**
 * Episode timing and termination policy.
 *
 * `decisionHz` must divide the engine's 50 Hz tick evenly so decision
 * boundaries land exactly on integer ticks — time is derived from integer
 * tick indices, never accumulated.
 */
export interface EpisodeConfig {
  decisionHz: number;
  /** Overrides the input's authored clip length. */
  clipSeconds?: number;
  /** Warm-up ticks are consumed inside `reset` and never policy-visible. Default true. */
  warmupExcluded?: boolean;
  /** Truncate after this many decisions even if clip time remains. */
  maxDecisions?: number;
  /**
   * Goal definition for the completion bonus / `terminated` flag: a trigger
   * with this interaction id firing, and/or the ego running out of route.
   */
  goal?: { interactionId?: string; routeEnd?: boolean };
  reward?: Partial<RewardConfig>;
  observation?: Partial<ObservationConfig>;
}

/** Perception-gated object entry, sorted by range then id. */
export interface PerceivedObject {
  readonly id: string;
  /** Range from the ego reference point, metres. */
  readonly rangeM: number;
  /** Bearing from the ego heading, radians, positive left, wrapped to [-π, π). */
  readonly bearingRad: number;
  /** Range rate (negative = closing), m/s. */
  readonly rangeRateMps: number;
  /** Geometric line of sight was clear at this decision. */
  readonly lineOfSight: boolean;
}

/** Version 1 observation bundle. Every field is optional by config, never by surprise. */
export interface Observation {
  readonly tS: number;
  readonly stateVector: Float64Array | null;
  readonly objects: readonly PerceivedObject[];
  readonly bev: BevRaster | null;
}

/** Ego-centric BEV raster: row-major `[row][col]`, channel-last within each cell. Row 0 is farthest forward. */
export interface BevRaster {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly resolutionM: number;
  readonly data: Float32Array;
}
