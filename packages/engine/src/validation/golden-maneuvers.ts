/**
 * Golden-maneuver runner for the dynamic-v1 default profile.
 *
 * Executes the measurable maneuvers declared by
 * `fixtures/physics/golden-maneuvers.v1.json` against `DynamicV1Backend`
 * running the generic passenger-car class profile, and compares the measured
 * figures with the published, cited references carried in that fixture. The
 * references are external measurements/regulatory figures — they are never
 * derived from the solver under test (see `docs/physics-validation.md`).
 */

import { DynamicV1Backend, GENERIC_PASSENGER_CAR_PROFILE } from '../sim/dynamic-v1.js';
import type { MotionIntent } from '../sim/motion-backend.js';
import {
  report,
  validateGoldenReference,
  type ValidationFinding,
  type ValidationReport,
} from './physics.js';

const STEP_S = 0.01;
const KMH_TO_MPS = 1 / 3.6;

function registeredBackend(): DynamicV1Backend {
  const backend = new DynamicV1Backend();
  backend.register({
    actorId: 'car',
    kind: 'car',
    dimensions: { l: 4.5, w: 1.9 },
    state: { x: 0, y: 0, yawRad: 0, longitudinalVelocityMps: 0 },
  });
  return backend;
}

function straightIntent(targetSpeedMps: number, targetAccelerationMps2: number): MotionIntent {
  return {
    targetSpeedMps,
    targetAccelerationMps2,
    previewPoint: { x: 5_000, y: 0 },
    previewHeadingRad: 0,
  };
}

function stateAt(x: number, speedMps: number): Parameters<DynamicV1Backend['setState']>[1] {
  return {
    x,
    y: 0,
    yawRad: 0,
    longitudinalVelocityMps: speedMps,
    lateralVelocityMps: 0,
    yawRateRadps: 0,
    steerRad: 0,
    wheelAngularSpeedRadps: speedMps / GENERIC_PASSENGER_CAR_PROFILE.wheelRadiusM,
    longitudinalAccelerationMps2: 0,
  };
}

/** Full-throttle launch; returns the time to reach 100 km/h. */
export function measureZeroTo100kmhTimeS(): number {
  const backend = registeredBackend();
  const intent = straightIntent(40, GENERIC_PASSENGER_CAR_PROFILE.maxLongitudinalAccelMps2);
  for (let t = STEP_S; t <= 30 + 1e-9; t += STEP_S) {
    backend.step('car', intent, STEP_S, 1);
    if (backend.state('car')!.longitudinalVelocityMps >= 100 * KMH_TO_MPS) return t;
  }
  throw new Error('golden maneuver: vehicle never reached 100 km/h');
}

/**
 * Coastdown from 100 km/h with pedals released; returns the deceleration
 * sampled at the moment speed crosses 80 km/h.
 */
export function measureCoastdownDecelAt80kmhMps2(): number {
  const backend = registeredBackend();
  // Pedals released via the control passthrough: zero force request, and the
  // road load (drag + rolling resistance) decelerates the body.
  const coast: MotionIntent = {
    targetSpeedMps: 0,
    targetAccelerationMps2: 0,
    previewPoint: { x: 5_000, y: 0 },
    previewHeadingRad: 0,
    control: { throttle: 0, brake: 0, steer: 0 },
  };
  backend.setState('car', stateAt(0, 100 * KMH_TO_MPS));
  let previousSpeed = 100 * KMH_TO_MPS;
  for (let t = STEP_S; t <= 60 + 1e-9; t += STEP_S) {
    backend.step('car', coast, STEP_S, 1);
    const speed = backend.state('car')!.longitudinalVelocityMps;
    if (speed <= 80 * KMH_TO_MPS) {
      return (previousSpeed - speed) / STEP_S;
    }
    previousSpeed = speed;
  }
  throw new Error('golden maneuver: vehicle never coasted down to 80 km/h');
}

/** Full-service brake from 100 km/h; returns the stopping distance. */
export function measureBraking100To0DistanceM(): number {
  const backend = registeredBackend();
  backend.setState('car', stateAt(0, 100 * KMH_TO_MPS));
  const intent = straightIntent(0, -GENERIC_PASSENGER_CAR_PROFILE.maxLongitudinalDecelMps2);
  for (let t = STEP_S; t <= 30 + 1e-9; t += STEP_S) {
    backend.step('car', intent, STEP_S, 1);
    if (backend.state('car')!.longitudinalVelocityMps <= 1e-6) {
      return backend.state('car')!.x;
    }
  }
  throw new Error('golden maneuver: vehicle never stopped');
}

const SKIDPAD_SPEEDS_MPS = [10, 14, 18, 22] as const;
const SKIDPAD_STEERS = [0.03, 0.05, 0.07, 0.09] as const;
const SKIDPAD_SETTLE_S = 8;
const SKIDPAD_SAMPLE_S = 4;
const SIDESLIP_LIMIT_RAD = 0.26;

/** Steady-state lateral acceleration for one (speed, steer) circle point. */
function skidpadPoint(speedMps: number, steer: number): number {
  const backend = registeredBackend();
  backend.setState('car', stateAt(0, speedMps));
  // Raw actuator request: the skidpad holds a fixed hand-wheel angle, which
  // is exactly what the control passthrough expresses (throttle covers road
  // load so the speed stays put through the turn).
  const circle: MotionIntent = {
    ...straightIntent(speedMps, 0),
    control: { throttle: 0.2, brake: 0, steer },
  };
  let samples = 0;
  let sumLateralG = 0;
  for (let t = STEP_S; t <= SKIDPAD_SETTLE_S + SKIDPAD_SAMPLE_S + 1e-9; t += STEP_S) {
    const result = backend.step('car', circle, STEP_S, 1);
    if (t < SKIDPAD_SETTLE_S) continue;
    const state = result.state;
    // Bounded-sideslip assertion: a drifting/spinning body is not a skidpad.
    const sideslip = Math.abs(
      Math.atan2(state.lateralVelocityMps, Math.abs(state.longitudinalVelocityMps)),
    );
    if (sideslip > SIDESLIP_LIMIT_RAD) continue;
    sumLateralG += Math.abs(state.longitudinalVelocityMps * state.yawRateRadps) / 9.80665;
    samples += 1;
  }
  return samples > 0 ? sumLateralG / samples : 0;
}

/**
 * Maximum sustained lateral acceleration over a speed/steer sweep on a
 * constant-radius circle, in g.
 */
export function measureSkidpadMaxLateralG(): number {
  let maxG = 0;
  for (const speedMps of SKIDPAD_SPEEDS_MPS) {
    for (const steer of SKIDPAD_STEERS) {
      maxG = Math.max(maxG, skidpadPoint(speedMps, steer));
    }
  }
  return maxG;
}

function findingsFor(
  gate: string,
  fixtureCase: GoldenManeuverFixture['cases'][number],
  measured: number,
): ValidationFinding[] {
  return (fixtureCase.references ?? []).map((reference) =>
    validateGoldenReference(`${gate}:${reference.metric}`, measured, reference));
}

/**
 * Run every maneuver case the fixture carries references for and compare each
 * declared metric. Cases without references are reported `not-run` so absence
 * of a result is never read as a pass.
 */
export function validateGoldenManeuvers(fixture: GoldenManeuverFixture): ValidationReport {
  const findings: ValidationFinding[] = [];
  for (const fixtureCase of fixture.cases) {
    switch (fixtureCase.id) {
      case 'straight-line-acceleration':
        findings.push(...findingsFor(fixtureCase.id, fixtureCase, measureZeroTo100kmhTimeS()));
        break;
      case 'straight-line-coast':
        findings.push(...findingsFor(fixtureCase.id, fixtureCase, measureCoastdownDecelAt80kmhMps2()));
        break;
      case 'braking-100-to-0':
        findings.push(...findingsFor(fixtureCase.id, fixtureCase, measureBraking100To0DistanceM()));
        break;
      case 'constant-radius-skidpad':
        findings.push(...findingsFor(fixtureCase.id, fixtureCase, measureSkidpadMaxLateralG()));
        break;
      default:
        findings.push({
          gate: fixtureCase.id,
          status: 'not-run',
          detail: 'no executable reference comparison wired for this case yet',
        });
    }
  }
  return report(findings);
}

/** One reference row as persisted in the golden fixture JSON. */
export interface GoldenManeuverReference {
  readonly metric: string;
  readonly value: number;
  readonly tolerancePercent?: number;
  readonly comparison?: 'within' | 'at-most';
}

/** The subset of the golden fixture this runner consumes. */
export interface GoldenManeuverFixture {
  readonly schema: string;
  readonly cases: readonly {
    readonly id: string;
    readonly family: string;
    readonly assertions?: readonly string[];
    readonly references?: readonly GoldenManeuverReference[];
    readonly substepsS?: readonly number[];
  }[];
}
