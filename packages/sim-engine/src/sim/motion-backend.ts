import type { Vec2 } from '../core/math.js';
import type { ActorKind, Dims, VehiclePhysicsProfile } from '../schema/input.js';

/**
 * Solver-neutral command produced by scenario choreography.  This is kept to
 * plain numbers so a future Rust/WASM backend can implement the same boundary
 * without depending on engine objects or route classes.
 */
export interface MotionIntent {
  /** Body longitudinal direction: +1 forward, -1 reverse. */
  readonly motionDirection?: 1 | -1;
  readonly targetSpeedMps: number;
  readonly targetAccelerationMps2: number;
  readonly previewPoint: Vec2;
  readonly previewHeadingRad: number;
  /**
   * The body is off its feet. A walker agent must stop steering toward
   * `previewPoint` and let the contact impulse carry it, or the knock it just
   * received is erased on the next substep.
   */
  readonly downed?: boolean;
}

/** Normalised actuator requests. */
export interface VehicleControl {
  readonly throttle: number;
  readonly brake: number;
  readonly steer: number;
}

export interface VehicleMotionState {
  readonly x: number;
  readonly y: number;
  readonly yawRad: number;
  /** Body-frame longitudinal velocity. */
  readonly longitudinalVelocityMps: number;
  /** Body-frame lateral velocity, positive left. */
  readonly lateralVelocityMps: number;
  readonly yawRateRadps: number;
  readonly steerRad: number;
  readonly wheelAngularSpeedRadps: number;
  readonly longitudinalAccelerationMps2: number;
}

export interface PhysicsTelemetrySample {
  readonly control: VehicleControl;
  readonly longitudinalForceN: number;
  readonly frontLateralForceN: number;
  readonly rearLateralForceN: number;
  readonly frontNormalForceN: number;
  readonly rearNormalForceN: number;
  readonly tireUtilization: number;
  readonly substeps: number;
  readonly substepS: number;
  /** Sum of normal contact impulses applied during the last engine tick. */
  readonly collisionImpulseNs: number;
  /** Number of distinct contact pairs that applied an impulse. */
  readonly collisionCount: number;
}

export interface MotionStepResult {
  readonly state: VehicleMotionState;
  readonly telemetry: PhysicsTelemetrySample;
}

export interface MotionActorInitialization {
  readonly actorId: string;
  readonly kind?: ActorKind;
  readonly dimensions?: Pick<Dims, 'l' | 'w'>;
  readonly motionDirection?: 1 | -1;
  readonly state: Pick<VehicleMotionState, 'x' | 'y' | 'yawRad' | 'longitudinalVelocityMps'> &
    Partial<Omit<VehicleMotionState, 'x' | 'y' | 'yawRad' | 'longitudinalVelocityMps'>>;
  readonly profile?: VehiclePhysicsProfile;
}

/**
 * Motion integration seam. Implementations own their continuous state; the
 * engine continues to own triggers, collision detection, routes and metrics.
 */
export interface MotionBackend {
  readonly id: string;
  readonly version: number;
  readonly substepS: number;
  register(input: MotionActorInitialization): void;
  /** Replace body state when an authored exact-time trajectory owns motion. */
  setState(actorId: string, state: VehicleMotionState): void;
  step(actorId: string, intent: MotionIntent, dtS: number, frictionScale: number): MotionStepResult;
  state(actorId: string): VehicleMotionState | undefined;
  telemetry(actorId: string): PhysicsTelemetrySample | undefined;
}
