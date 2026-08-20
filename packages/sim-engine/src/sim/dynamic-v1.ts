import { angleDelta, clamp, normalizeAngle } from '../core/math.js';
import type { ActorKind, VehiclePhysicsProfile } from '../schema/input.js';
import type {
  MotionActorInitialization,
  MotionBackend,
  MotionIntent,
  MotionStepResult,
  PhysicsTelemetrySample,
  VehicleControl,
  VehicleMotionState,
} from './motion-backend.js';
import {
  solvePlanarCollisions,
  type CollisionImpulse,
  type PlanarCollisionBody,
  type PlanarStaticCollider,
} from './collision-response.js';

const G = 9.80665;
export const DYNAMIC_V1_DEFAULT_SUBSTEP_S = 0.005;
/**
 * Clothed body sliding on asphalt. Chosen to be recognisably slower than a
 * braking tyre and faster than ice; it governs how far a struck body travels
 * after the impulse, not any injury or damage claim.
 */
const SLIDING_FRICTION_COEFFICIENT = 0.55;
/**
 * The sideways velocity a walker can still catch itself from, in m/s. A contact
 * that *adds* more than this takes the body down.
 *
 * Human balance recovery, not a crash-load threshold: a stumble is recoverable,
 * being hit by a car at any real speed is not. It is measured against the
 * velocity the contact added rather than the impulse it carried, so a walker who
 * strides into a parked car — same order of impulse, but only their own momentum
 * being arrested — keeps their feet.
 */
export const BALANCE_RECOVERY_DELTA_V_MPS = 0.6;

export interface ResolvedVehiclePhysicsProfile {
  readonly kind: ActorKind;
  readonly dynamicsModel: 'single-track' | 'pedestrian-agent';
  readonly massKg: number;
  readonly yawInertiaKgM2: number;
  readonly wheelbaseM: number;
  readonly cgToFrontM: number;
  readonly cgHeightM: number;
  readonly wheelRadiusM: number;
  readonly corneringStiffnessFrontNPerRad: number;
  readonly corneringStiffnessRearNPerRad: number;
  readonly dragCoefficientNPerMps2: number;
  readonly rollingResistanceCoefficient: number;
  readonly maxDriveForceN: number;
  readonly maxBrakeForceN: number;
  readonly maxSteerRad: number;
  readonly steerRateRadPerS: number;
  readonly steerTimeConstantS: number;
  readonly tireMu: number;
  readonly maxLongitudinalAccelMps2: number;
  readonly maxLongitudinalDecelMps2: number;
  readonly maxJerkMps3: number;
  readonly maxLateralAccelerationMps2: number;
  readonly maxYawRateRadps: number;
}

/** Calibrated generic 1.5-tonne passenger car; not a make/model claim. */
export const GENERIC_PASSENGER_CAR_PROFILE: ResolvedVehiclePhysicsProfile = {
  kind: 'car',
  dynamicsModel: 'single-track',
  massKg: 1_500,
  yawInertiaKgM2: 2_500,
  wheelbaseM: 2.7,
  cgToFrontM: 1.2,
  cgHeightM: 0.55,
  wheelRadiusM: 0.31,
  corneringStiffnessFrontNPerRad: 82_000,
  corneringStiffnessRearNPerRad: 88_000,
  dragCoefficientNPerMps2: 0.42,
  rollingResistanceCoefficient: 0.012,
  maxDriveForceN: 5_500,
  maxBrakeForceN: 13_500,
  maxSteerRad: 0.58,
  steerRateRadPerS: 4.5,
  steerTimeConstantS: 0.12,
  tireMu: 1,
  maxLongitudinalAccelMps2: 3.7,
  maxLongitudinalDecelMps2: 9,
  maxJerkMps3: 8,
  maxLateralAccelerationMps2: 7,
  maxYawRateRadps: 1.8,
};

/** Class-level effective parameters. They model a representative class, not a
 * particular make. Values are deliberately conservative and remain overrideable
 * per actor through the hash-covered physics profile envelope. */
export const ACTOR_PHYSICS_PROFILES: Readonly<Record<Exclude<ActorKind, 'static_object'>, ResolvedVehiclePhysicsProfile>> = {
  vehicle: { ...GENERIC_PASSENGER_CAR_PROFILE, kind: 'vehicle' },
  car: GENERIC_PASSENGER_CAR_PROFILE,
  van: {
    ...GENERIC_PASSENGER_CAR_PROFILE, kind: 'van', massKg: 2_600, yawInertiaKgM2: 5_200,
    wheelbaseM: 3.35, cgToFrontM: 1.55, cgHeightM: 0.78, wheelRadiusM: 0.36,
    corneringStiffnessFrontNPerRad: 105_000, corneringStiffnessRearNPerRad: 118_000,
    dragCoefficientNPerMps2: 0.72, rollingResistanceCoefficient: 0.014,
    maxDriveForceN: 7_500, maxBrakeForceN: 22_000, maxSteerRad: 0.54,
    steerRateRadPerS: 2.5, steerTimeConstantS: 0.2, tireMu: 0.92,
    maxLongitudinalAccelMps2: 2.5, maxLongitudinalDecelMps2: 7.2,
    maxJerkMps3: 5, maxLateralAccelerationMps2: 5, maxYawRateRadps: 1.25,
  },
  truck: {
    ...GENERIC_PASSENGER_CAR_PROFILE, kind: 'truck', massKg: 12_000, yawInertiaKgM2: 48_000,
    wheelbaseM: 5.2, cgToFrontM: 2.25, cgHeightM: 1.25, wheelRadiusM: 0.5,
    corneringStiffnessFrontNPerRad: 230_000, corneringStiffnessRearNPerRad: 310_000,
    dragCoefficientNPerMps2: 2.1, rollingResistanceCoefficient: 0.009,
    maxDriveForceN: 42_000, maxBrakeForceN: 92_000, maxSteerRad: 0.44,
    steerRateRadPerS: 0.75, steerTimeConstantS: 0.38, tireMu: 0.78,
    maxLongitudinalAccelMps2: 1.5, maxLongitudinalDecelMps2: 5.5,
    maxJerkMps3: 2.5, maxLateralAccelerationMps2: 3.1, maxYawRateRadps: 0.65,
  },
  bus: {
    ...GENERIC_PASSENGER_CAR_PROFILE, kind: 'bus', massKg: 13_500, yawInertiaKgM2: 66_000,
    wheelbaseM: 6.0, cgToFrontM: 2.7, cgHeightM: 1.15, wheelRadiusM: 0.51,
    corneringStiffnessFrontNPerRad: 250_000, corneringStiffnessRearNPerRad: 330_000,
    dragCoefficientNPerMps2: 1.85, rollingResistanceCoefficient: 0.01,
    maxDriveForceN: 39_000, maxBrakeForceN: 105_000, maxSteerRad: 0.46,
    steerRateRadPerS: 0.68, steerTimeConstantS: 0.42, tireMu: 0.8,
    maxLongitudinalAccelMps2: 1.35, maxLongitudinalDecelMps2: 5.2,
    maxJerkMps3: 2.2, maxLateralAccelerationMps2: 2.8, maxYawRateRadps: 0.58,
  },
  motorcycle: {
    ...GENERIC_PASSENGER_CAR_PROFILE, kind: 'motorcycle', massKg: 240, yawInertiaKgM2: 145,
    wheelbaseM: 1.45, cgToFrontM: 0.68, cgHeightM: 0.58, wheelRadiusM: 0.3,
    corneringStiffnessFrontNPerRad: 14_000, corneringStiffnessRearNPerRad: 17_000,
    dragCoefficientNPerMps2: 0.28, rollingResistanceCoefficient: 0.015,
    maxDriveForceN: 1_750, maxBrakeForceN: 2_200, maxSteerRad: 0.62,
    steerRateRadPerS: 3.2, steerTimeConstantS: 0.16, tireMu: 0.95,
    maxLongitudinalAccelMps2: 4.8, maxLongitudinalDecelMps2: 8.2,
    maxJerkMps3: 7, maxLateralAccelerationMps2: 6.5, maxYawRateRadps: 2.4,
  },
  bicycle: {
    ...GENERIC_PASSENGER_CAR_PROFILE, kind: 'bicycle', massKg: 95, yawInertiaKgM2: 28,
    wheelbaseM: 1.08, cgToFrontM: 0.48, cgHeightM: 0.75, wheelRadiusM: 0.34,
    corneringStiffnessFrontNPerRad: 1_100, corneringStiffnessRearNPerRad: 1_350,
    dragCoefficientNPerMps2: 0.3, rollingResistanceCoefficient: 0.006,
    maxDriveForceN: 420, maxBrakeForceN: 750, maxSteerRad: 0.7,
    steerRateRadPerS: 2.2, steerTimeConstantS: 0.24, tireMu: 0.82,
    maxLongitudinalAccelMps2: 1.8, maxLongitudinalDecelMps2: 5,
    maxJerkMps3: 3.5, maxLateralAccelerationMps2: 3.5, maxYawRateRadps: 2.1,
  },
  scooter: {
    ...GENERIC_PASSENGER_CAR_PROFILE, kind: 'scooter', massKg: 115, yawInertiaKgM2: 34,
    wheelbaseM: 1.15, cgToFrontM: 0.52, cgHeightM: 0.67, wheelRadiusM: 0.25,
    corneringStiffnessFrontNPerRad: 1_800, corneringStiffnessRearNPerRad: 2_100,
    dragCoefficientNPerMps2: 0.32, rollingResistanceCoefficient: 0.012,
    maxDriveForceN: 620, maxBrakeForceN: 950, maxSteerRad: 0.68,
    steerRateRadPerS: 2.5, steerTimeConstantS: 0.2, tireMu: 0.86,
    maxLongitudinalAccelMps2: 2.4, maxLongitudinalDecelMps2: 5.8,
    maxJerkMps3: 4, maxLateralAccelerationMps2: 3.8, maxYawRateRadps: 2.2,
  },
  sidewalk_robot: {
    ...GENERIC_PASSENGER_CAR_PROFILE, kind: 'sidewalk_robot', dynamicsModel: 'pedestrian-agent',
    massKg: 70, yawInertiaKgM2: 18, wheelbaseM: 0.55, cgToFrontM: 0.28,
    cgHeightM: 0.4, wheelRadiusM: 0.11, corneringStiffnessFrontNPerRad: 1,
    corneringStiffnessRearNPerRad: 1, dragCoefficientNPerMps2: 0.09,
    rollingResistanceCoefficient: 0.012, maxDriveForceN: 420, maxBrakeForceN: 650,
    maxSteerRad: 0.01, steerRateRadPerS: 0.01, steerTimeConstantS: 0.2,
    tireMu: 0.85, maxLongitudinalAccelMps2: 1.8, maxLongitudinalDecelMps2: 3.5,
    maxJerkMps3: 4, maxLateralAccelerationMps2: 2, maxYawRateRadps: 3,
  },
  drone: {
    ...GENERIC_PASSENGER_CAR_PROFILE, kind: 'drone', dynamicsModel: 'pedestrian-agent',
    massKg: 12, yawInertiaKgM2: 4, wheelbaseM: 0.5, cgToFrontM: 0.25,
    cgHeightM: 0.25, wheelRadiusM: 0.08, corneringStiffnessFrontNPerRad: 1,
    corneringStiffnessRearNPerRad: 1, dragCoefficientNPerMps2: 0.16,
    rollingResistanceCoefficient: 0, maxDriveForceN: 500, maxBrakeForceN: 600,
    maxSteerRad: 0.01, steerRateRadPerS: 0.01, steerTimeConstantS: 0.1,
    tireMu: 1, maxLongitudinalAccelMps2: 3, maxLongitudinalDecelMps2: 5,
    maxJerkMps3: 8, maxLateralAccelerationMps2: 4, maxYawRateRadps: 4,
  },
  pedestrian: {
    ...GENERIC_PASSENGER_CAR_PROFILE, kind: 'pedestrian', dynamicsModel: 'pedestrian-agent',
    massKg: 78, yawInertiaKgM2: 9, wheelbaseM: 0.5, cgToFrontM: 0.25,
    cgHeightM: 0.9, wheelRadiusM: 0.16, corneringStiffnessFrontNPerRad: 1,
    corneringStiffnessRearNPerRad: 1, dragCoefficientNPerMps2: 0.08,
    rollingResistanceCoefficient: 0, maxDriveForceN: 350, maxBrakeForceN: 500,
    maxSteerRad: 0.01, steerRateRadPerS: 0.01, steerTimeConstantS: 0.25,
    tireMu: 0.9, maxLongitudinalAccelMps2: 1.6, maxLongitudinalDecelMps2: 3.2,
    maxJerkMps3: 4, maxLateralAccelerationMps2: 1.8, maxYawRateRadps: 3,
  },
  animal: {
    ...GENERIC_PASSENGER_CAR_PROFILE, kind: 'animal', dynamicsModel: 'pedestrian-agent',
    massKg: 45, yawInertiaKgM2: 5, wheelbaseM: 0.5, cgToFrontM: 0.25,
    cgHeightM: 0.5, wheelRadiusM: 0.14, corneringStiffnessFrontNPerRad: 1,
    corneringStiffnessRearNPerRad: 1, dragCoefficientNPerMps2: 0.08,
    rollingResistanceCoefficient: 0, maxDriveForceN: 310, maxBrakeForceN: 390,
    maxSteerRad: 0.01, steerRateRadPerS: 0.01, steerTimeConstantS: 0.2,
    tireMu: 0.9, maxLongitudinalAccelMps2: 2.5, maxLongitudinalDecelMps2: 3.8,
    maxJerkMps3: 5, maxLateralAccelerationMps2: 2.5, maxYawRateRadps: 3.5,
  },
};

export function resolveVehiclePhysicsProfile(
  override: VehiclePhysicsProfile | undefined,
): ResolvedVehiclePhysicsProfile {
  return resolveActorPhysicsProfile('car', override);
}

export function resolveActorPhysicsProfile(
  kind: Exclude<ActorKind, 'static_object'>,
  override: VehiclePhysicsProfile | undefined,
): ResolvedVehiclePhysicsProfile {
  const profile = { ...ACTOR_PHYSICS_PROFILES[kind], ...override };
  // The schema validates authored input. These relational checks also protect
  // direct library callers and keep axle geometry physically meaningful.
  if (profile.cgToFrontM >= profile.wheelbaseM) {
    throw new Error('dynamic-v1 cgToFrontM must be less than wheelbaseM');
  }
  return profile;
}

interface MutableVehicleState {
  x: number;
  y: number;
  yawRad: number;
  longitudinalVelocityMps: number;
  lateralVelocityMps: number;
  yawRateRadps: number;
  steerRad: number;
  wheelAngularSpeedRadps: number;
  longitudinalAccelerationMps2: number;
}

interface VehicleEntry {
  readonly profile: ResolvedVehiclePhysicsProfile;
  readonly state: MutableVehicleState;
  previous: Pick<MutableVehicleState, 'x' | 'y' | 'yawRad'>;
  telemetry: PhysicsTelemetrySample;
  commandedAccelerationMps2: number;
}

const ZERO_CONTROL: VehicleControl = { throttle: 0, brake: 0, steer: 0 };

function zeroTelemetry(substepS: number): PhysicsTelemetrySample {
  return {
    control: ZERO_CONTROL,
    longitudinalForceN: 0,
    frontLateralForceN: 0,
    rearLateralForceN: 0,
    frontNormalForceN: 0,
    rearNormalForceN: 0,
    tireUtilization: 0,
    substeps: 0,
    substepS,
    collisionImpulseNs: 0,
    collisionCount: 0,
  };
}

function controlFor(
  state: MutableVehicleState,
  profile: ResolvedVehiclePhysicsProfile,
  intent: MotionIntent,
): VehicleControl {
  const direction = intent.motionDirection ?? 1;
  const travelSpeed = direction * state.longitudinalVelocityMps;
  const speedError = intent.targetSpeedMps - travelSpeed;
  const desiredAccel = clamp(
    intent.targetAccelerationMps2 + 1.25 * speedError,
    -profile.maxLongitudinalDecelMps2,
    profile.maxLongitudinalAccelMps2,
  );
  const resistance =
    profile.dragCoefficientNPerMps2 * travelSpeed ** 2 +
    profile.rollingResistanceCoefficient * profile.massKg * G;
  const requestedForce = profile.massKg * desiredAccel + resistance;
  const throttle = clamp(requestedForce / profile.maxDriveForceN, 0, 1);
  const brake = clamp(-requestedForce / profile.maxBrakeForceN, 0, 1);

  const dx = intent.previewPoint.x - state.x;
  const dy = intent.previewPoint.y - state.y;
  const previewDistance = Math.max(Math.hypot(dx, dy), 1);
  const bearing = Math.atan2(dy, dx);
  const trackingYaw = normalizeAngle(state.yawRad + (direction < 0 ? Math.PI : 0));
  const alpha = angleDelta(trackingYaw, bearing);
  const purePursuit = Math.atan2(2 * profile.wheelbaseM * Math.sin(alpha), previewDistance);
  const headingCorrection = 0.35 * angleDelta(trackingYaw, intent.previewHeadingRad);
  const steerRad = clamp(direction * (purePursuit + headingCorrection), -profile.maxSteerRad, profile.maxSteerRad);
  return { throttle, brake, steer: steerRad / profile.maxSteerRad };
}

function frictionEllipseLateral(
  desiredFy: number,
  fx: number,
  normalN: number,
  mu: number,
): { force: number; utilization: number } {
  const capacity = Math.max(mu * normalN, 1);
  const remaining = Math.sqrt(Math.max(0, capacity * capacity - fx * fx));
  const force = clamp(desiredFy, -remaining, remaining);
  return { force, utilization: Math.hypot(fx, force) / capacity };
}

/** Deterministic planar bicycle solver with a WASM-friendly numeric boundary. */
export class DynamicV1Backend implements MotionBackend {
  readonly id = 'dynamic-v1';
  readonly version = 1;
  readonly substepS: number;
  private readonly vehicles = new Map<string, VehicleEntry>();

  constructor(substepS = DYNAMIC_V1_DEFAULT_SUBSTEP_S) {
    if (!(substepS > 0)) throw new Error('dynamic-v1 substepS must be positive');
    this.substepS = substepS;
  }

  register(input: MotionActorInitialization): void {
    const u = (input.motionDirection ?? 1) * Math.abs(input.state.longitudinalVelocityMps);
    if (input.kind === 'static_object') throw new Error('fixed static actors cannot be registered with dynamic-v1');
    const profile = resolveActorPhysicsProfile(input.kind ?? 'car', input.profile);
    this.vehicles.set(input.actorId, {
      profile,
      state: {
        x: input.state.x,
        y: input.state.y,
        yawRad: input.state.yawRad,
        longitudinalVelocityMps: u,
        lateralVelocityMps: input.state.lateralVelocityMps ?? 0,
        yawRateRadps: input.state.yawRateRadps ?? 0,
        steerRad: input.state.steerRad ?? 0,
        wheelAngularSpeedRadps: input.state.wheelAngularSpeedRadps ?? u / profile.wheelRadiusM,
        longitudinalAccelerationMps2: input.state.longitudinalAccelerationMps2 ?? 0,
      },
      previous: { x: input.state.x, y: input.state.y, yawRad: input.state.yawRad },
      telemetry: zeroTelemetry(this.substepS),
      commandedAccelerationMps2: input.state.longitudinalAccelerationMps2 ?? 0,
    });
    const dimensions = input.dimensions ?? { l: 4.8, w: 1.9 };
    this.registerDimensions(input.actorId, dimensions.l, dimensions.w);
  }

  state(actorId: string): VehicleMotionState | undefined {
    const value = this.vehicles.get(actorId)?.state;
    return value ? { ...value } : undefined;
  }

  setState(actorId: string, state: VehicleMotionState): void {
    const entry = this.vehicles.get(actorId);
    if (!entry) throw new Error(`dynamic-v1 actor is not registered: ${actorId}`);
    entry.previous = { x: state.x, y: state.y, yawRad: state.yawRad };
    Object.assign(entry.state, state);
    entry.commandedAccelerationMps2 = state.longitudinalAccelerationMps2;
  }

  telemetry(actorId: string): PhysicsTelemetrySample | undefined {
    const value = this.vehicles.get(actorId)?.telemetry;
    return value ? { ...value, control: { ...value.control } } : undefined;
  }

  profile(actorId: string): ResolvedVehiclePhysicsProfile | undefined {
    return this.vehicles.get(actorId)?.profile;
  }

  step(actorId: string, intent: MotionIntent, dtS: number, frictionScale: number): MotionStepResult {
    const entry = this.vehicles.get(actorId);
    if (!entry) throw new Error(`dynamic-v1 actor is not registered: ${actorId}`);
    if (!(dtS > 0)) throw new Error('dynamic-v1 step dtS must be positive');
    const count = Math.max(1, Math.ceil(dtS / this.substepS - 1e-12));
    const h = dtS / count;
    entry.previous = { x: entry.state.x, y: entry.state.y, yawRad: entry.state.yawRad };
    let telemetry = zeroTelemetry(h);
    for (let i = 0; i < count; i++) telemetry = this.integrate(entry, intent, h, frictionScale);
    entry.telemetry = { ...telemetry, substeps: count, substepS: h };
    return { state: { ...entry.state }, telemetry: entry.telemetry };
  }

  /**
   * Resolve actor/actor and actor/static contacts after every synchronized
   * engine tick. This deliberately remains a plain-data seam so a future
   * pinned WASM implementation can replace it without changing choreography.
   */
  resolveCollisions(
    activeActorIds: ReadonlySet<string>,
    staticColliders: readonly PlanarStaticCollider[],
    dtS: number,
  ): CollisionImpulse[] {
    const bodies: PlanarCollisionBody[] = [];
    for (const actorId of [...activeActorIds].sort()) {
      const entry = this.vehicles.get(actorId);
      if (!entry) continue;
      const p = entry.profile;
      const s = entry.state;
      const cos = Math.cos(s.yawRad);
      const sin = Math.sin(s.yawRad);
      // Actor dimensions are supplied by the engine as static colliders for
      // fallbacks, but dynamic footprint dimensions are registered below.
      const dimensions = this.dimensions.get(actorId);
      if (!dimensions) continue;
      bodies.push({
        id: actorId,
        lengthM: dimensions.lengthM,
        widthM: dimensions.widthM,
        inverseMass: 1 / p.massKg,
        inverseInertia: 1 / p.yawInertiaKgM2,
        previous: entry.previous,
        x: s.x,
        y: s.y,
        yawRad: s.yawRad,
        vx: s.longitudinalVelocityMps * cos - s.lateralVelocityMps * sin,
        vy: s.longitudinalVelocityMps * sin + s.lateralVelocityMps * cos,
        angularVelocity: s.yawRateRadps,
      });
    }
    const impulses = solvePlanarCollisions(bodies, staticColliders, dtS);
    const impulseByActor = new Map<string, { total: number; count: number }>();
    for (const impulse of impulses) {
      for (const id of [impulse.a, impulse.b]) {
        if (!this.vehicles.has(id)) continue;
        const value = impulseByActor.get(id) ?? { total: 0, count: 0 };
        value.total += impulse.normalImpulseNs;
        value.count += 1;
        impulseByActor.set(id, value);
      }
    }
    for (const body of bodies) {
      const entry = this.vehicles.get(body.id)!;
      const s = entry.state;
      s.x = body.x;
      s.y = body.y;
      s.yawRad = normalizeAngle(body.yawRad);
      const cos = Math.cos(s.yawRad);
      const sin = Math.sin(s.yawRad);
      s.longitudinalVelocityMps = body.vx * cos + body.vy * sin;
      s.lateralVelocityMps = -body.vx * sin + body.vy * cos;
      s.yawRateRadps = body.angularVelocity;
      const contact = impulseByActor.get(body.id);
      entry.telemetry = {
        ...entry.telemetry,
        collisionImpulseNs: contact?.total ?? 0,
        collisionCount: contact?.count ?? 0,
      };
    }
    return impulses;
  }

  private readonly dimensions = new Map<string, { lengthM: number; widthM: number }>();

  registerDimensions(actorId: string, lengthM: number, widthM: number): void {
    this.dimensions.set(actorId, { lengthM, widthM });
  }

  private integrate(
    entry: VehicleEntry,
    intent: MotionIntent,
    h: number,
    frictionScale: number,
  ): PhysicsTelemetrySample {
    if (entry.profile.dynamicsModel === 'pedestrian-agent') {
      return intent.downed
        ? this.integrateDowned(entry, h, frictionScale)
        : this.integratePedestrian(entry, intent, h, frictionScale);
    }
    const s = entry.state;
    const p = entry.profile;
    const boundedIntent = this.boundedIntent(entry, intent, h);
    const control = controlFor(s, p, boundedIntent);
    const steerTarget = control.steer * p.maxSteerRad;
    const steerDerivative = clamp(
      (steerTarget - s.steerRad) / p.steerTimeConstantS,
      -p.steerRateRadPerS,
      p.steerRateRadPerS,
    );
    s.steerRad = clamp(s.steerRad + steerDerivative * h, -p.maxSteerRad, p.maxSteerRad);

    const motionDirection = intent.motionDirection ?? 1;
    const driveN = motionDirection * control.throttle * p.maxDriveForceN;
    const brakeN = control.brake * p.maxBrakeForceN;
    const direction = Math.abs(s.longitudinalVelocityMps) > 0.05
      ? Math.sign(s.longitudinalVelocityMps)
      : motionDirection;
    const dragN = p.dragCoefficientNPerMps2 * s.longitudinalVelocityMps * Math.abs(s.longitudinalVelocityMps);
    const rollingN = p.rollingResistanceCoefficient * p.massKg * G *
      Math.tanh(s.longitudinalVelocityMps / 0.1);
    const requestedFx = driveN - direction * brakeN - dragN - rollingN;
    const requestedAx = requestedFx / p.massKg;

    const lf = p.cgToFrontM;
    const lr = p.wheelbaseM - lf;
    const frontNormal = clamp(
      (p.massKg * G * lr - p.massKg * requestedAx * p.cgHeightM) / p.wheelbaseM,
      0.1 * p.massKg * G,
      0.9 * p.massKg * G,
    );
    const rearNormal = p.massKg * G - frontNormal;
    const mu = Math.max(0.05, p.tireMu * frictionScale);

    // Rear-wheel drive and a 60/40 front/rear brake balance. The longitudinal
    // allocations share the same friction circles as lateral tyre forces.
    const frontFxRequest = control.brake > 0 ? -direction * brakeN * 0.6 : 0;
    const rearFxRequest = requestedFx - frontFxRequest;
    const frontFx = clamp(frontFxRequest, -mu * frontNormal, mu * frontNormal);
    const rearFx = clamp(rearFxRequest, -mu * rearNormal, mu * rearNormal);

    const speedForSlip = Math.max(Math.abs(s.longitudinalVelocityMps), 0.75);
    // The steer contribution to front-tyre slip is signed by the direction of
    // travel, and this is not a detail: a tyre is symmetric, so the lateral slip
    // velocity it sees from a steer angle `d` is `-u * sin(d)`, which changes
    // sign with `u`. Dropping that sign makes a reversing car respond to
    // steering the wrong way — the controller's correction becomes positive
    // feedback, the steer saturates, and the body peels off its path. That is
    // the whole reason reverse manoeuvres were uncontrollable under this
    // backend. Forward motion is untouched (`direction` is +1).
    //
    // Everything else here is already direction-agnostic: the yaw-rate and
    // sideslip terms enter through `atan2(.., |u|)`, whose sign is carried by
    // the numerator.
    const frontSlip = Math.atan2(
      s.lateralVelocityMps + lf * s.yawRateRadps,
      speedForSlip,
    ) - direction * s.steerRad;
    const rearSlip = Math.atan2(
      s.lateralVelocityMps - lr * s.yawRateRadps,
      speedForSlip,
    );
    const front = frictionEllipseLateral(
      -p.corneringStiffnessFrontNPerRad * frontSlip,
      frontFx,
      frontNormal,
      mu,
    );
    const rear = frictionEllipseLateral(
      -p.corneringStiffnessRearNPerRad * rearSlip,
      rearFx,
      rearNormal,
      mu,
    );

    const rawLateralN = rear.force + front.force * Math.cos(s.steerRad);
    const lateralScale = Math.abs(rawLateralN) > p.massKg * p.maxLateralAccelerationMps2
      ? p.massKg * p.maxLateralAccelerationMps2 / Math.abs(rawLateralN)
      : 1;
    const frontFy = front.force * lateralScale;
    const rearFy = rear.force * lateralScale;

    const cosSteer = Math.cos(s.steerRad);
    const sinSteer = Math.sin(s.steerRad);
    const totalFx = rearFx + frontFx * cosSteer - frontFy * sinSteer;
    const uDot = totalFx / p.massKg + s.lateralVelocityMps * s.yawRateRadps;
    const vDot = (rearFy + frontFy * cosSteer + frontFx * sinSteer) / p.massKg -
      s.longitudinalVelocityMps * s.yawRateRadps;
    const yawDot = (lf * (frontFy * cosSteer + frontFx * sinSteer) - lr * rearFy) /
      p.yawInertiaKgM2;

    const oldU = s.longitudinalVelocityMps;
    const oldV = s.lateralVelocityMps;
    const oldYawRate = s.yawRateRadps;
    const oldYaw = s.yawRad;
    s.longitudinalVelocityMps += uDot * h;
    if (motionDirection * s.longitudinalVelocityMps < 0) s.longitudinalVelocityMps = 0;
    s.lateralVelocityMps += vDot * h;
    s.yawRateRadps = clamp(s.yawRateRadps + yawDot * h, -p.maxYawRateRadps, p.maxYawRateRadps);
    s.yawRad = normalizeAngle(oldYaw + 0.5 * (oldYawRate + s.yawRateRadps) * h);
    const oldWorldX = oldU * Math.cos(oldYaw) - oldV * Math.sin(oldYaw);
    const oldWorldY = oldU * Math.sin(oldYaw) + oldV * Math.cos(oldYaw);
    const newWorldX = s.longitudinalVelocityMps * Math.cos(s.yawRad) - s.lateralVelocityMps * Math.sin(s.yawRad);
    const newWorldY = s.longitudinalVelocityMps * Math.sin(s.yawRad) + s.lateralVelocityMps * Math.cos(s.yawRad);
    s.x += 0.5 * (oldWorldX + newWorldX) * h;
    s.y += 0.5 * (oldWorldY + newWorldY) * h;
    s.longitudinalAccelerationMps2 = uDot;

    // Wheel state is an aggregate driven-wheel speed. A short tyre relaxation
    // time captures launch/braking lag without introducing a stiff slip solver.
    const rollingOmega = s.longitudinalVelocityMps / p.wheelRadiusM;
    const wheelTauS = control.brake > 0 ? 0.035 : 0.08;
    s.wheelAngularSpeedRadps += (rollingOmega - s.wheelAngularSpeedRadps) * (h / wheelTauS);
    if (s.longitudinalVelocityMps === 0 && control.brake > 0) s.wheelAngularSpeedRadps = 0;

    return {
      control,
      longitudinalForceN: totalFx,
      frontLateralForceN: frontFy,
      rearLateralForceN: rearFy,
      frontNormalForceN: frontNormal,
      rearNormalForceN: rearNormal,
      tireUtilization: Math.max(front.utilization, rear.utilization),
      substeps: 1,
      substepS: h,
      collisionImpulseNs: 0,
      collisionCount: 0,
    };
  }

  private boundedIntent(entry: VehicleEntry, intent: MotionIntent, h: number): MotionIntent {
    const p = entry.profile;
    const requested = clamp(intent.targetAccelerationMps2, -p.maxLongitudinalDecelMps2, p.maxLongitudinalAccelMps2);
    const delta = clamp(requested - entry.commandedAccelerationMps2, -p.maxJerkMps3 * h, p.maxJerkMps3 * h);
    entry.commandedAccelerationMps2 += delta;
    return { ...intent, targetAccelerationMps2: entry.commandedAccelerationMps2 };
  }

  /**
   * A body that is off its feet. It has no gait and no route: whatever the
   * contact impulse gave it is carried in the plane and rubbed off by sliding
   * friction against the ground, in body axes so the solver's lateral component
   * survives. Yaw is held — a planar state has no roll axis to fall about, so
   * the pose stays the one it was struck in and renderers lay the model down
   * from `downedAtS`.
   */
  private integrateDowned(
    entry: VehicleEntry,
    h: number,
    frictionScale: number,
  ): PhysicsTelemetrySample {
    const s = entry.state;
    const p = entry.profile;
    const startSpeed = Math.hypot(s.longitudinalVelocityMps, s.lateralVelocityMps);
    // Sliding body against asphalt, not a shoe pushing off it.
    const decel = SLIDING_FRICTION_COEFFICIENT * G * Math.max(0.05, frictionScale);
    const endSpeed = Math.max(0, startSpeed - decel * h);
    const scale = startSpeed > 1e-9 ? endSpeed / startSpeed : 0;
    // Midpoint of the interval, so coming to rest does not overshoot.
    const averageScale = startSpeed > 1e-9 ? 0.5 * (1 + scale) : 0;
    const vxBody = s.longitudinalVelocityMps * averageScale;
    const vyBody = s.lateralVelocityMps * averageScale;
    const cos = Math.cos(s.yawRad);
    const sin = Math.sin(s.yawRad);
    s.x += (vxBody * cos - vyBody * sin) * h;
    s.y += (vxBody * sin + vyBody * cos) * h;
    s.longitudinalVelocityMps *= scale;
    s.lateralVelocityMps *= scale;
    s.longitudinalAccelerationMps2 = (endSpeed - startSpeed) / h;
    s.yawRateRadps = 0;
    s.steerRad = 0;
    s.wheelAngularSpeedRadps = 0;
    return {
      control: { throttle: 0, brake: 0, steer: 0 },
      longitudinalForceN: s.longitudinalAccelerationMps2 * p.massKg,
      frontLateralForceN: 0, rearLateralForceN: 0,
      frontNormalForceN: p.massKg * G, rearNormalForceN: 0,
      tireUtilization: 0, substeps: 1, substepS: h,
      collisionImpulseNs: 0, collisionCount: 0,
    };
  }

  /** Bounded social-force-style point agent for walkers and animals. It owns
   * continuous velocity/heading state but intentionally has no wheel or tyre
   * semantics. */
  private integratePedestrian(
    entry: VehicleEntry,
    intent: MotionIntent,
    h: number,
    frictionScale: number,
  ): PhysicsTelemetrySample {
    const s = entry.state;
    const p = entry.profile;
    const bounded = this.boundedIntent(entry, intent, h);
    const speedError = bounded.targetSpeedMps - (bounded.motionDirection ?? 1) * s.longitudinalVelocityMps;
    const accel = clamp(
      bounded.targetAccelerationMps2 + 1.5 * speedError,
      -p.maxLongitudinalDecelMps2 * frictionScale,
      p.maxLongitudinalAccelMps2 * frictionScale,
    );
    const desiredHeading = Math.atan2(bounded.previewPoint.y - s.y, bounded.previewPoint.x - s.x);
    const yawRate = clamp(angleDelta(s.yawRad, desiredHeading) / 0.22, -p.maxYawRateRadps, p.maxYawRateRadps);
    const oldSpeed = s.longitudinalVelocityMps;
    s.longitudinalVelocityMps = Math.max(0, oldSpeed + accel * h);
    s.longitudinalAccelerationMps2 = accel;
    s.yawRateRadps = yawRate;
    s.yawRad = normalizeAngle(s.yawRad + yawRate * h);
    s.lateralVelocityMps = 0;
    s.steerRad = 0;
    s.wheelAngularSpeedRadps = 0;
    const averageSpeed = 0.5 * (oldSpeed + s.longitudinalVelocityMps);
    s.x += Math.cos(s.yawRad) * averageSpeed * h;
    s.y += Math.sin(s.yawRad) * averageSpeed * h;
    const force = accel * p.massKg;
    return {
      control: { throttle: accel > 0 ? accel / p.maxLongitudinalAccelMps2 : 0, brake: accel < 0 ? -accel / p.maxLongitudinalDecelMps2 : 0, steer: yawRate / p.maxYawRateRadps },
      longitudinalForceN: force, frontLateralForceN: 0, rearLateralForceN: 0,
      frontNormalForceN: p.massKg * G, rearNormalForceN: 0,
      tireUtilization: 0, substeps: 1, substepS: h,
      collisionImpulseNs: 0, collisionCount: 0,
    };
  }
}
