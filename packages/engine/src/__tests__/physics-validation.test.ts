import { describe, expect, it } from 'vitest';
import { contentHash } from '../core/hash.js';
import { parseSimScenarioInput, resolvePhysicsConfig } from '../schema/input.js';
import {
  validateCollisionOnset,
  validateDeterminism,
  validateFrictionCircle,
  validatePerformance,
  validateReferenceValue,
  validateStoppingDistanceMonotonicity,
  validateTimestepConvergence,
} from '../validation/physics.js';

const legacy = {
  actors: [{ id: 'ego', kind: 'car', initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0 }, behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] } } }],
};

describe('physics provenance contract', () => {
  it('does not materialize the new dynamic default or perturb parsed JSON', () => {
    const parsed = parseSimScenarioInput(legacy);
    expect(parsed).not.toHaveProperty('physics');
    expect(resolvePhysicsConfig(parsed)).toEqual({ mode: 'dynamic-v1' });
    expect(contentHash(parsed)).toBe(contentHash({ ...parsed }));
  });

  it('accepts an explicit dynamic profile and rejects unknown modes', () => {
    const parsed = parseSimScenarioInput({ ...legacy, physics: { mode: 'dynamic-v1', substepS: 0.005, vehicleProfiles: { ego: { massKg: 1500, tireMu: 0.9 } } } });
    expect(resolvePhysicsConfig(parsed).mode).toBe('dynamic-v1');
    expect(() => parseSimScenarioInput({ ...legacy, physics: { mode: 'magic' } })).toThrow();
  });
});

describe('golden maneuver gates', () => {
  it('covers determinism and non-contact convergence', () => {
    const bytes = new TextEncoder().encode('trace');
    expect(validateDeterminism(Array.from({ length: 10 }, () => bytes), bytes).ok).toBe(true);
    expect(validateTimestepConvergence(
      { t: 10, xM: 100, yM: 1, speedMps: 20, yawRad: 0.1 },
      { t: 10, xM: 100.01, yM: 1, speedMps: 20.02, yawRad: 0.1005 },
    ).ok).toBe(true);
  });

  it('covers longitudinal, friction, collision placeholder, and performance gates', () => {
    expect(validateReferenceValue('braking-100-0', 36, 35).status).toBe('pass');
    expect(validateFrictionCircle([{ mu: 1, normalForceN: 4000, longitudinalForceN: 3900, lateralForceN: 0 }]).status).toBe('pass');
    expect(validateStoppingDistanceMonotonicity([{ mu: 0.4, stoppingDistanceM: 80 }, { mu: 0.8, stoppingDistanceM: 42 }]).status).toBe('pass');
    expect(validateCollisionOnset(1.004, 1).status).toBe('pass');
    expect(validatePerformance(10, 20, 900).ok).toBe(true);
  });
});
