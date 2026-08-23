import type { LintActorKind } from "./types";

export interface LintThreshold {
  warning: number;
  violation: number;
  /**
   * A warning window must be longer than this duration. Violations are always
   * immediate. Used by the default longitudinal-jerk warning.
   */
  warningMinDurationS: number;
}

type PartialThreshold = Partial<LintThreshold>;

export interface LintConfig {
  /**
   * Centered time window used before finite differencing. The 0.4 s default
   * attenuates the noise that raw 20 Hz position/yaw differencing amplifies
   * while retaining sub-second braking and steering events.
   */
  smoothingWindowS?: number;
  /** Motion below this speed retains the most recent meaningful heading. */
  stationarySpeedEpsilonMps?: number;
  thresholds?: {
    vehicle?: {
      longitudinalAcceleration?: PartialThreshold;
      longitudinalDeceleration?: PartialThreshold;
      lateralAcceleration?: PartialThreshold;
      longitudinalJerk?: PartialThreshold;
    };
    walker?: {
      speed?: PartialThreshold;
    };
  };
  discontinuities?: {
    /** Position jump floor in meters. */
    positionJumpFloorM?: number;
    /** Multiplier in max(speed * dt * multiplier, floor). */
    positionSpeedMultiplier?: number;
    /** Absolute implied speed change bound in m/s². */
    speedAccelerationMps2?: number;
    /** Absolute single-sample heading change bound in radians. */
    headingJumpRad?: number;
  };
}

export interface ResolvedLintConfig {
  smoothingWindowS: number;
  stationarySpeedEpsilonMps: number;
  thresholds: {
    vehicle: {
      longitudinalAcceleration: LintThreshold;
      longitudinalDeceleration: LintThreshold;
      lateralAcceleration: LintThreshold;
      longitudinalJerk: LintThreshold;
    };
    walker: {
      speed: LintThreshold;
    };
  };
  discontinuities: {
    positionJumpFloorM: number;
    positionSpeedMultiplier: number;
    speedAccelerationMps2: number;
    headingJumpRad: number;
  };
}

/**
 * Defensible comfort-oriented defaults, NOT ISO-prescribed values.
 *
 * Discontinuity bounds are data-integrity/physical-plausibility checks rather
 * than comfort limits and therefore always produce violation severity.
 */
export const DEFAULT_LINT_CONFIG: ResolvedLintConfig = {
  smoothingWindowS: 0.4,
  stationarySpeedEpsilonMps: 0.1,
  thresholds: {
    vehicle: {
      longitudinalAcceleration: {
        warning: 2.5,
        violation: 4,
        warningMinDurationS: 0,
      },
      longitudinalDeceleration: {
        warning: 3.5,
        violation: 9,
        warningMinDurationS: 0,
      },
      lateralAcceleration: {
        warning: 3,
        violation: 6,
        warningMinDurationS: 0,
      },
      longitudinalJerk: {
        warning: 2,
        violation: 10,
        warningMinDurationS: 0.5,
      },
    },
    walker: {
      speed: {
        warning: 3,
        violation: 7,
        warningMinDurationS: 0,
      },
    },
  },
  discontinuities: {
    positionJumpFloorM: 2,
    positionSpeedMultiplier: 3,
    speedAccelerationMps2: 15,
    headingJumpRad: Math.PI / 2,
  },
};

function mergeThreshold(
  defaults: LintThreshold,
  override: PartialThreshold | undefined,
): LintThreshold {
  return {
    warning: override?.warning ?? defaults.warning,
    violation: override?.violation ?? defaults.violation,
    warningMinDurationS:
      override?.warningMinDurationS ?? defaults.warningMinDurationS,
  };
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function assertThreshold(
  kind: LintActorKind,
  name: string,
  threshold: LintThreshold,
): void {
  assertPositiveFinite(`${kind}.${name}.warning`, threshold.warning);
  assertPositiveFinite(`${kind}.${name}.violation`, threshold.violation);
  if (threshold.warning >= threshold.violation) {
    throw new RangeError(
      `${kind}.${name}.warning must be less than its violation threshold`,
    );
  }
  if (
    !Number.isFinite(threshold.warningMinDurationS) ||
    threshold.warningMinDurationS < 0
  ) {
    throw new RangeError(
      `${kind}.${name}.warningMinDurationS must be finite and non-negative`,
    );
  }
}

/** Resolve a deep-partial override without mutating the exported defaults. */
export function resolveLintConfig(config: LintConfig = {}): ResolvedLintConfig {
  const vehicle = config.thresholds?.vehicle;
  const walker = config.thresholds?.walker;
  const resolved: ResolvedLintConfig = {
    smoothingWindowS:
      config.smoothingWindowS ?? DEFAULT_LINT_CONFIG.smoothingWindowS,
    stationarySpeedEpsilonMps:
      config.stationarySpeedEpsilonMps ??
      DEFAULT_LINT_CONFIG.stationarySpeedEpsilonMps,
    thresholds: {
      vehicle: {
        longitudinalAcceleration: mergeThreshold(
          DEFAULT_LINT_CONFIG.thresholds.vehicle.longitudinalAcceleration,
          vehicle?.longitudinalAcceleration,
        ),
        longitudinalDeceleration: mergeThreshold(
          DEFAULT_LINT_CONFIG.thresholds.vehicle.longitudinalDeceleration,
          vehicle?.longitudinalDeceleration,
        ),
        lateralAcceleration: mergeThreshold(
          DEFAULT_LINT_CONFIG.thresholds.vehicle.lateralAcceleration,
          vehicle?.lateralAcceleration,
        ),
        longitudinalJerk: mergeThreshold(
          DEFAULT_LINT_CONFIG.thresholds.vehicle.longitudinalJerk,
          vehicle?.longitudinalJerk,
        ),
      },
      walker: {
        speed: mergeThreshold(
          DEFAULT_LINT_CONFIG.thresholds.walker.speed,
          walker?.speed,
        ),
      },
    },
    discontinuities: {
      positionJumpFloorM:
        config.discontinuities?.positionJumpFloorM ??
        DEFAULT_LINT_CONFIG.discontinuities.positionJumpFloorM,
      positionSpeedMultiplier:
        config.discontinuities?.positionSpeedMultiplier ??
        DEFAULT_LINT_CONFIG.discontinuities.positionSpeedMultiplier,
      speedAccelerationMps2:
        config.discontinuities?.speedAccelerationMps2 ??
        DEFAULT_LINT_CONFIG.discontinuities.speedAccelerationMps2,
      headingJumpRad:
        config.discontinuities?.headingJumpRad ??
        DEFAULT_LINT_CONFIG.discontinuities.headingJumpRad,
    },
  };

  assertPositiveFinite("smoothingWindowS", resolved.smoothingWindowS);
  assertPositiveFinite(
    "stationarySpeedEpsilonMps",
    resolved.stationarySpeedEpsilonMps,
  );
  for (const [name, threshold] of Object.entries(
    resolved.thresholds.vehicle,
  )) {
    assertThreshold("vehicle", name, threshold);
  }
  assertThreshold("walker", "speed", resolved.thresholds.walker.speed);
  for (const [name, value] of Object.entries(resolved.discontinuities)) {
    assertPositiveFinite(`discontinuities.${name}`, value);
  }

  return resolved;
}
