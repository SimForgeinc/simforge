/**
 * Backend-neutral physics acceptance contracts.
 *
 * These functions validate observations produced by any motion backend. They
 * deliberately do not know how a solver works, which prevents a backend from
 * grading itself by its own internal state rather than observable outcomes.
 */

export const PHYSICS_VALIDATION_CONTRACT_VERSION = 'uniscenarios.physics-validation/v1' as const;

export const PHYSICS_VALIDATION_GATES = {
  repeatRuns: 10,
  convergence: {
    coarseSubstepS: 0.005,
    fineSubstepS: 0.0025,
    finalPositionM: 0.02,
    finalSpeedMps: 0.05,
    finalYawRad: 0.1 * Math.PI / 180,
  },
  referenceRelativeTolerance: 0.10,
  skidpadRelativeTolerance: 0.05,
  stepSteerYawGainRelativeTolerance: 0.10,
  frictionCircleSlack: 0.02,
  collisionOnsetToleranceS: 0.005,
  performance: { actors: 10, durationS: 20, wallClockMs: 1000, minimumRealtimeFactor: 20 },
  openScenarioReplay: { rmsePositionM: 0.1, p95PositionM: 0.2, p95HeadingDeg: 1 },
} as const;

export interface VehicleObservation {
  readonly t: number;
  readonly xM: number;
  readonly yM: number;
  readonly speedMps: number;
  readonly yawRad: number;
  readonly sideslipRad?: number;
}

export interface ValidationFinding {
  readonly gate: string;
  readonly status: 'pass' | 'fail' | 'not-run';
  readonly measured?: number;
  readonly limit?: number;
  readonly detail: string;
}

export interface ValidationReport {
  readonly contract: typeof PHYSICS_VALIDATION_CONTRACT_VERSION;
  readonly ok: boolean;
  readonly findings: ValidationFinding[];
}

const finding = (
  gate: string,
  pass: boolean,
  measured: number,
  limit: number,
  detail: string,
): ValidationFinding => ({ gate, status: pass ? 'pass' : 'fail', measured, limit, detail });

export function report(findings: ValidationFinding[]): ValidationReport {
  return {
    contract: PHYSICS_VALIDATION_CONTRACT_VERSION,
    ok: findings.every((entry) => entry.status === 'pass'),
    findings,
  };
}

function angleDifference(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

/** Compare the final non-contact state from 5 ms and 2.5 ms integrations. */
export function validateTimestepConvergence(
  coarse: VehicleObservation,
  fine: VehicleObservation,
): ValidationReport {
  const gates = PHYSICS_VALIDATION_GATES.convergence;
  const position = Math.hypot(coarse.xM - fine.xM, coarse.yM - fine.yM);
  const speed = Math.abs(coarse.speedMps - fine.speedMps);
  const yaw = angleDifference(coarse.yawRad, fine.yawRad);
  return report([
    finding('convergence.final-position', position <= gates.finalPositionM, position, gates.finalPositionM, '5 ms vs 2.5 ms final position'),
    finding('convergence.final-speed', speed <= gates.finalSpeedMps, speed, gates.finalSpeedMps, '5 ms vs 2.5 ms final speed'),
    finding('convergence.final-yaw', yaw <= gates.finalYawRad, yaw, gates.finalYawRad, '5 ms vs 2.5 ms final yaw'),
  ]);
}

/** Exact bytes are required across ten repeats and actor declaration order. */
export function validateDeterminism(repeats: readonly Uint8Array[], permutedActors: Uint8Array): ValidationReport {
  const required = PHYSICS_VALIDATION_GATES.repeatRuns;
  const same = (a: Uint8Array, b: Uint8Array): boolean =>
    a.byteLength === b.byteLength && a.every((value, index) => value === b[index]);
  const countOk = repeats.length === required;
  const repeatOk = countOk && repeats.slice(1).every((bytes) => same(bytes, repeats[0]!));
  const permutationOk = repeats.length > 0 && same(repeats[0]!, permutedActors);
  return report([
    finding('determinism.repeat-count', countOk, repeats.length, required, 'required independent serializations'),
    finding('determinism.repeat-bytes', repeatOk, repeatOk ? 0 : 1, 0, 'all repeat bytes must match'),
    finding('determinism.actor-permutation', permutationOk, permutationOk ? 0 : 1, 0, 'actor declaration order must not change bytes'),
  ]);
}

/** Acceleration, coast drag, and 100-0 braking use the same ±10% reference gate. */
export function validateReferenceValue(gate: 'acceleration' | 'coast' | 'braking-100-0', measured: number, reference: number): ValidationFinding {
  const relativeError = reference === 0 ? Math.abs(measured) : Math.abs(measured - reference) / Math.abs(reference);
  return finding(`reference.${gate}`, relativeError <= PHYSICS_VALIDATION_GATES.referenceRelativeTolerance, relativeError, PHYSICS_VALIDATION_GATES.referenceRelativeTolerance, `${measured} vs declared reference ${reference}`);
}

/**
 * Compare one measured maneuver figure against an external, cited reference
 * carried by `fixtures/physics/golden-maneuvers.v1.json`. Either a relative
 * band (`comparison: 'within'`, default) or a hard ceiling
 * (`comparison: 'at-most'`) is enforced; the reference itself always comes
 * from published data, never from the implementation under test.
 */
export function validateGoldenReference(
  gate: string,
  measured: number,
  reference: {
    readonly value: number;
    readonly tolerancePercent?: number;
    readonly comparison?: 'within' | 'at-most';
  },
): ValidationFinding {
  const comparison = reference.comparison ?? 'within';
  const tolerancePercent = reference.tolerancePercent ?? 10;
  const limit = comparison === 'at-most'
    ? reference.value
    : (tolerancePercent / 100) * reference.value;
  const pass = comparison === 'at-most'
    ? measured <= reference.value
    : Math.abs(measured - reference.value) <= limit;
  return finding(
    gate,
    pass,
    measured,
    limit,
    comparison === 'at-most'
      ? `measured ${measured.toFixed(3)} must be ≤ cited reference ${reference.value}`
      : `measured ${measured.toFixed(3)} vs cited reference ${reference.value} ±${tolerancePercent}%`,
  );
}

export interface FrictionObservation {
  readonly mu: number;
  readonly normalForceN: number;
  readonly longitudinalForceN: number;
  readonly lateralForceN: number;
}

/** Enforce the tire friction circle, including split-mu observations per tire/axle. */
export function validateFrictionCircle(observations: readonly FrictionObservation[]): ValidationFinding {
  const worst = observations.reduce((maximum, sample) => {
    const capacity = sample.mu * sample.normalForceN;
    if (capacity <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(maximum, Math.hypot(sample.longitudinalForceN, sample.lateralForceN) / capacity);
  }, 0);
  const limit = 1 + PHYSICS_VALIDATION_GATES.frictionCircleSlack;
  return finding('friction.resultant', worst <= limit, worst, limit, 'resultant tire force / (mu * Fz)');
}

/** Lower friction may never produce a shorter otherwise-identical stop. */
export function validateStoppingDistanceMonotonicity(samples: readonly { mu: number; stoppingDistanceM: number }[]): ValidationFinding {
  const ordered = [...samples].sort((a, b) => a.mu - b.mu);
  let worstViolation = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    worstViolation = Math.max(worstViolation, ordered[i]!.stoppingDistanceM - ordered[i - 1]!.stoppingDistanceM);
  }
  return finding('friction.stopping-monotonicity', worstViolation <= 0, worstViolation, 0, 'stopping distance must not grow with higher mu');
}

/** Placeholder until collision impulses are validated quantitatively. */
export function validateCollisionOnset(observedS: number | null, referenceS: number): ValidationFinding {
  const error = observedS === null ? Number.POSITIVE_INFINITY : Math.abs(observedS - referenceS);
  return finding('collision.onset-placeholder', error <= PHYSICS_VALIDATION_GATES.collisionOnsetToleranceS, error, PHYSICS_VALIDATION_GATES.collisionOnsetToleranceS, 'impulse magnitude/restitution gate intentionally deferred');
}

export function validatePerformance(actorCount: number, durationS: number, wallClockMs: number): ValidationReport {
  const gates = PHYSICS_VALIDATION_GATES.performance;
  const realtimeFactor = durationS / (wallClockMs / 1000);
  return report([
    finding('performance.actor-count', actorCount >= gates.actors, actorCount, gates.actors, 'dynamic actors in benchmark'),
    finding('performance.duration', durationS >= gates.durationS, durationS, gates.durationS, 'simulated seconds'),
    finding('performance.wall-clock', wallClockMs <= gates.wallClockMs, wallClockMs, gates.wallClockMs, 'offline benchmark milliseconds'),
    finding('performance.realtime-factor', realtimeFactor >= gates.minimumRealtimeFactor, realtimeFactor, gates.minimumRealtimeFactor, 'simulated time / wall time'),
  ]);
}
