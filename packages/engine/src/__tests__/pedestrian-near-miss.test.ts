import { describe, expect, it } from 'vitest';
import { resolvePedestrianProjection, solvePedestrianNearMiss, verifyNearMissOutcome, type SimTrace } from '../index.js';

const request = (overrides: Record<string, unknown> = {}) => ({
  pedestrianId: 'walker', targetId: 'ego', pedestrianStart: { x: 10, z: -8 },
  pedestrianDims: { l: 0.6, w: 0.6, h: 1.75 }, targetDims: { l: 4.8, w: 1.9, h: 1.5 },
  targetTrajectory: [
    { t: 0, x: 0, z: 0 }, { t: 2, x: 10, z: 0 },
    { t: 4, x: 18, z: 4 }, { t: 6, x: 18, z: 4 },
  ],
  triggerTimeS: 0, deadlineS: 6, clearanceM: 0.5, minSpeedMps: 0.5, maxSpeedMps: 5,
  ...overrides,
});

describe('pedestrian near-miss solver', () => {
  it.each(['front', 'behind'] as const)('produces a collision-free exact-clearance %s pass', (pass) => {
    const result = solvePedestrianNearMiss(request({ pass }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.solution.pass).toBe(pass);
    expect(result.solution.predictedClearanceM).toBeCloseTo(0.5, 2);
    expect(result.solution.predictedClearanceM).toBeGreaterThan(0);
    expect(result.solution.speedMps).toBeGreaterThanOrEqual(0.5);
    expect(result.solution.speedMps).toBeLessThanOrEqual(5);
  });

  it('uses target turns/stops and is byte-deterministic', () => {
    const a = solvePedestrianNearMiss(request());
    const b = solvePedestrianNearMiss(request());
    expect(a).toEqual(b);
    expect(a.ok && a.solution.planHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('fails closed when the pedestrian cannot reach a legal near miss', () => {
    const result = solvePedestrianNearMiss(request({ minSpeedMps: 0.1, maxSpeedMps: 0.11, deadlineS: 1 }));
    expect(result).toMatchObject({ ok: false, diagnostic: { code: 'near_miss_infeasible_speed' } });
  });
});

describe('pedestrian projection', () => {
  it('describes stationary, conditional walking, stacked paths and stable parity hash', () => {
    const input = {
      actorId: 'walker', start: { x: 0, z: 0 }, clipSeconds: 10,
      movements: [
        { interactionId: 'cross', triggerTimeS: 2, speedMps: 2, points: [{ x: 0, z: 0 }, { x: 4, z: 0 }] },
        { interactionId: 'escape', triggerTimeS: 5, speedMps: 1, points: [{ x: 4, z: 0 }, { x: 4, z: 3 }] },
        { interactionId: 'never', triggerTimeS: null, speedMps: 1, points: [{ x: 4, z: 3 }, { x: 5, z: 3 }], diagnostic: 'distance trigger unresolved' },
      ],
    } as const;
    const preview = resolvePedestrianProjection(input);
    const playback = resolvePedestrianProjection(input);
    expect(preview.planHash).toBe(playback.planHash);
    expect(preview.segments.map((segment) => segment.kind)).toEqual(['stationary', 'walking', 'stationary', 'walking', 'invalid', 'stationary']);
    expect(preview.triggerPoints).toHaveLength(2);
    expect(preview.endpoint).toEqual({ x: 4, z: 3 });
  });
});

describe('near-miss outcome evidence', () => {
  it('fails intent on collision even when the requested range could include zero', () => {
    const track = { x: [0], y: [0], headingRad: [0], speedMps: [0], lateralOffsetM: [0], laneRsl: [null], s: [0], present: [1] };
    const trace = {
      header: { actorMetadata: {
        walker: { kind: 'pedestrian', dims: { l: .6, w: .6, h: 1.75 }, static: false, tags: [] },
        ego: { kind: 'car', dims: { l: 4.8, w: 1.9, h: 1.5 }, static: false, tags: [] },
      } },
      ticks: { t: [0], actors: { walker: track, ego: track } },
      metrics: { collisions: [{ t: 0, a: 'walker', b: 'ego' }] },
    } as unknown as SimTrace;
    expect(verifyNearMissOutcome(trace, { pedestrianId: 'walker', targetId: 'ego', requestedClearanceM: 0 }))
      .toMatchObject({ status: 'failed', collision: true, realizedClearanceM: 0 });
  });
});
