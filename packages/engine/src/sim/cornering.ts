import { angleDelta, clamp } from '../core/math.js';
import type { Route } from '../map/route.js';

const CURVATURE_WINDOW_M = 12;
const CURVATURE_SAMPLE_STEP_M = 2;
const MIN_CURVATURE_PER_M = (2 * Math.PI / 180) / CURVATURE_WINDOW_M;
const ENVELOPE_RESPONSE_S = 1;

export interface CornerSpeedInput {
  readonly route: Route;
  readonly routeS: number;
  readonly currentSpeedMps: number;
  readonly desiredSpeedMps: number;
  readonly comfortableLateralAccelerationMps2: number;
  readonly comfortableDecelerationMps2: number;
  readonly physicalLateralAccelerationMps2: number;
  readonly physicalDecelerationMps2: number;
}

/**
 * One actor-profile-aware corner-speed planner shared by kinematic and dynamic
 * motion. Curvature is measured over a road-scale chord instead of adjacent
 * polyline vertices, so a tessellation seam cannot masquerade as a hairpin.
 */
export interface CorneringPlan {
  readonly speedLimitMps: number;
  /** Maximum longitudinal acceleration that still follows the speed envelope. */
  readonly accelerationCapMps2: number;
}

export function corneringPlan(input: CornerSpeedInput): CorneringPlan {
  const desired = Math.max(0, input.desiredSpeedMps);
  if (desired === 0 || input.route.lengthM <= 0) {
    return {
      speedLimitMps: desired,
      accelerationCapMps2: (desired - input.currentSpeedMps) / ENVELOPE_RESPONSE_S,
    };
  }

  const lateralBudgetMps2 = Math.max(0.5, Math.min(
    input.comfortableLateralAccelerationMps2,
    input.physicalLateralAccelerationMps2 * 0.8,
  ));
  const brakingBudgetMps2 = Math.max(0.5, Math.min(
    input.comfortableDecelerationMps2,
    input.physicalDecelerationMps2 * 0.8,
  ));
  const brakingDistanceM = input.currentSpeedMps ** 2 / (2 * brakingBudgetMps2);
  const horizonM = clamp(brakingDistanceM + 18, 25, 80);
  const endS = Math.min(input.route.lengthM, input.routeS + horizonM);
  let capMps = desired;

  for (
    let centerS = Math.min(endS, input.routeS + CURVATURE_SAMPLE_STEP_M);
    centerS <= endS + 1e-9;
    centerS = Math.min(endS, centerS + CURVATURE_SAMPLE_STEP_M)
  ) {
    const beforeS = Math.max(0, centerS - CURVATURE_WINDOW_M / 2);
    const afterS = Math.min(input.route.lengthM, centerS + CURVATURE_WINDOW_M / 2);
    const spanM = afterS - beforeS;
    if (spanM > 1e-6) {
      const beforeHeading = input.route.poseAt(beforeS).headingRad;
      const afterHeading = input.route.poseAt(afterS).headingRad;
      const curvaturePerM = Math.abs(angleDelta(beforeHeading, afterHeading)) / spanM;
      if (curvaturePerM >= MIN_CURVATURE_PER_M) {
        const turnSpeedMps = Math.sqrt(lateralBudgetMps2 / curvaturePerM);
        const distanceToCurveM = Math.max(0, beforeS - input.routeS);
        const approachSpeedMps = Math.sqrt(
          turnSpeedMps ** 2 + 2 * brakingBudgetMps2 * distanceToCurveM,
        );
        capMps = Math.min(capMps, approachSpeedMps);
      }
    }
    if (centerS >= endS) break;
  }

  const speedLimitMps = clamp(capMps, 0, desired);
  return {
    speedLimitMps,
    // Do not dilute the free-flow controller when there is no upcoming curve:
    // this planner is a cap, not a second cruise convergence law. Once a curve
    // does lower the envelope, approach it gradually so a force-based vehicle
    // does not try to erase the whole speed error in one fixed simulation tick.
    accelerationCapMps2: speedLimitMps < desired
      ? (speedLimitMps - input.currentSpeedMps) / ENVELOPE_RESPONSE_S
      : Number.POSITIVE_INFINITY,
  };
}

/** Convenience for diagnostics and callers that only need the speed envelope. */
export function cornerSpeedLimitMps(input: CornerSpeedInput): number {
  return corneringPlan(input).speedLimitMps;
}
