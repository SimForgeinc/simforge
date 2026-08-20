import { describe, expect, it } from 'vitest';

import { buildOccluders } from '../sim/visibility.js';
import type { ActorRuntime } from '../sim/state.js';
import { computeMetrics, newMetricAccumulator, observeTick } from '../trace/metrics.js';
import { evaluateMetrics } from '../trace/evaluate.js';
import { safeParseSimScenarioInput } from '../schema/input.js';
import { LANE_LEFT, syntheticGraph, vehicle } from './fixtures/scenarios.js';

function actor(id: string, x: number, speedMps = 0): ActorRuntime {
  return {
    id,
    kind: 'vehicle',
    dims: { l: 4, w: 2, h: 1.5 },
    tags: [],
    static: false,
    rules: {
      obeySignals: true,
      yield: true,
      yieldToVehicles: true,
      yieldToPedestrians: true,
      collisionAvoidance: true,
      aggression: 0.5,
      speedFactor: 1,
    },
    cruiseSpeedMps: speedMps,
    cruiseOverrideMps: speedMps,
    route: {} as ActorRuntime['route'],
    routeS: x,
    timedRoute: null,
    bestEffortWorldPath: false,
    remainingTurns: [],
    speedMps,
    accelMps2: 0,
    lateralOffsetM: 0,
    lateralReferenceOffsetM: 0,
    lateralReferenceRateMps: 0,
    lateralReferenceAccelMps2: 0,
    lateralRateMps: 0,
    position: { x, y: 0 },
    headingRad: 0,
    present: true,
    retired: false,
    longCmd: null,
    latCmd: null,
    untilByAxis: new Map(),
    stateKeys: new Map(),
    roadControlStates: new Map(),
    motionDirection: 1,
    pendingMotionDirection: null,
    hasMoved: false,
    standstillSinceS: null,
    requiredDecelMax: 0,
  };
}

const onAxis = buildOccluders([
  {
    id: 'wall',
    obb: { center: { x: 20, z: 0 }, lengthM: 8, widthM: 2, heightM: 2, headingRad: 0 },
  },
]);

const offAxis = buildOccluders([
  {
    id: 'off-axis-wall',
    obb: { center: { x: 20, z: 50 }, lengthM: 8, widthM: 2, heightM: 2, headingRad: 0 },
  },
]);

function observe(acc: ReturnType<typeof newMetricAccumulator>, t: number, egoX: number, targetX: number, occluders = onAxis): void {
  observeTick(acc, t, [actor('ego', egoX, 10), actor('target', targetX, 0)], new Set(), occluders);
}

describe('declared occlusion metrics', () => {
  it('treats actors beyond the operational visibility range as not visible', () => {
    const acc = newMetricAccumulator(['ego', 'target'], [
      { observer: 'ego', target: 'target', occluderId: 'off-axis-wall' },
    ]);
    observeTick(acc, 0, [actor('ego', 0, 5), actor('target', 40, 0)], new Set(), offAxis, 20);
    observeTick(acc, 1, [actor('ego', 25, 5), actor('target', 40, 0)], new Set(), offAxis, 20);
    const metric = computeMetrics(acc, 4).declaredOcclusion?.[0];
    expect(metric?.firstBlockedT).toBe(0);
    expect(metric?.losOpenT).toBe(1);
  });

  it('rejects an occlusion pair whose observer/target actor references are unknown', () => {
    const graph = syntheticGraph();
    const ego = vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 0, speedMps: 10 });
    const parsed = safeParseSimScenarioInput({
      mapId: 'synthetic-straight',
      actors: [ego],
      interactions: [],
      occluders: [],
      occlusionPairs: [{ observer: 'ghost', target: 'target', occluderId: undefined }],
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'occlusionPairs.0.observer', message: expect.stringContaining('unknown actor ghost') }),
          expect.objectContaining({ path: 'occlusionPairs.0.target', message: expect.stringContaining('unknown actor target') }),
        ]),
      );
    }
  });

  it('rejects an occlusion pair whose occluder reference resolves to neither id nor group', () => {
    const graph = syntheticGraph();
    const ego = vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 0, speedMps: 10 });
    const target = vehicle(graph, { id: 'target', rsl: LANE_LEFT, s: 40, speedMps: 0 });
    const parsed = safeParseSimScenarioInput({
      mapId: 'synthetic-straight',
      actors: [ego, target],
      interactions: [],
      occluders: [
        { id: 'real-wall', obb: { center: { x: 20, z: 0 }, lengthM: 8, widthM: 2, heightM: 2, headingRad: 0 } },
      ],
      occlusionPairs: [{ observer: 'ego', target: 'target', occluderId: 'missing-wall' }],
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'occlusionPairs.0.occluderId', message: expect.stringContaining('unknown occluder') }),
        ]),
      );
    }
  });

  it('rejects ambiguous references when a concrete occluder id collides with a group id', () => {
    const graph = syntheticGraph();
    const ego = vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 0, speedMps: 10 });
    const target = vehicle(graph, { id: 'target', rsl: LANE_LEFT, s: 40, speedMps: 0 });
    const parsed = safeParseSimScenarioInput({
      mapId: 'synthetic-straight',
      actors: [ego, target],
      interactions: [],
      occluders: [
        { id: 'parked-row', obb: { center: { x: 5, z: 50 }, lengthM: 8, widthM: 2, heightM: 2, headingRad: 0 } },
        { id: 'parked-row-0', groupId: 'parked-row', obb: { center: { x: 20, z: 0 }, lengthM: 8, widthM: 2, heightM: 2, headingRad: 0 } },
      ],
      occlusionPairs: [{ observer: 'ego', target: 'target', occluderId: 'parked-row' }],
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'occluders.1.groupId', message: expect.stringContaining('collides') }),
        ]),
      );
    }
  });

  it('expands a repeated prop group reference to all concrete occluder members', () => {
    const group = buildOccluders([
      { id: 'parked-row-0', groupId: 'parked-row', obb: { center: { x: 20, z: 0 }, lengthM: 8, widthM: 2, heightM: 2, headingRad: 0 } },
      { id: 'parked-row-1', groupId: 'parked-row', obb: { center: { x: 20, z: 50 }, lengthM: 8, widthM: 2, heightM: 2, headingRad: 0 } },
    ]);
    const acc = newMetricAccumulator(['ego', 'target'], [
      { observer: 'ego', target: 'target', occluderId: 'parked-row' },
    ]);

    observe(acc, 0, 0, 40, group); // blocked by parked-row-0
    observe(acc, 2.6, 26, 40, group); // clear after passing the row
    observe(acc, 3.4, 34, 40, group); // closest criticality sample

    const metrics = computeMetrics(acc, 4);
    const predictedConflictT = metrics.minTTC!.t + metrics.minTTC!.value;
    expect(metrics.occluderIneffective).toEqual([]);
    expect(metrics.declaredOcclusion).toEqual([
      expect.objectContaining({
        observer: 'ego',
        target: 'target',
        occluderId: 'parked-row',
        status: 'revealed_before_conflict',
        firstBlockedT: 0,
        losOpenT: 2.6,
        conflictT: predictedConflictT,
        revealToConflictS: expect.closeTo(predictedConflictT - 2.6, 6),
      }),
    ]);
    expect(metrics.revealToConflict).toEqual(
      expect.objectContaining({
        observer: 'ego',
        target: 'target',
        pair: ['ego', 'target'],
        occluderId: 'parked-row',
        relevantOccluderIds: ['parked-row-0', 'parked-row-1'],
        firstBlockedT: 0,
        losOpenT: 2.6,
        conflictT: predictedConflictT,
      }),
    );
  });

  it('marks a declared pair ineffective when it was never blocked before conflict', () => {
    const acc = newMetricAccumulator(['ego', 'target'], [
      { observer: 'ego', target: 'target', occluderId: 'off-axis-wall' },
    ]);
    observe(acc, 0, 0, 40, offAxis);
    observe(acc, 2, 20, 40, offAxis);

    const metrics = computeMetrics(acc, 3);
    const predictedConflictT = metrics.minTTC!.t + metrics.minTTC!.value;
    expect(metrics.revealToConflict).toBeNull();
    expect(metrics.declaredOcclusion).toEqual([
      expect.objectContaining({
        observer: 'ego',
        target: 'target',
        status: 'never_blocked_before_conflict',
        conflictT: predictedConflictT,
      }),
    ]);
    expect(metrics.occluderIneffective).toEqual([
      {
        observer: 'ego',
        target: 'target',
        pair: ['ego', 'target'],
        conflictT: predictedConflictT,
        occluderId: 'off-axis-wall',
        relevantOccluderIds: ['off-axis-wall'],
        reason: 'never_blocked_before_conflict',
      },
    ]);
    expect(evaluateMetrics(metrics, 3).findings.map((finding) => finding.code)).toContain('occlusion_unproven');
  });

  it('still marks ineffective when first blockage happens only after conflict', () => {
    const acc = newMetricAccumulator(['ego', 'target'], [{ observer: 'ego', target: 'target', occluderId: 'wall' }]);
    observeTick(acc, 0, [actor('ego', 0, 0), actor('target', 8, 0)], new Set(), onAxis); // clear, closest sample
    observeTick(acc, 2, [actor('ego', 30, 0), actor('target', 8, 0)], new Set(), onAxis); // blocked too late

    const metrics = computeMetrics(acc, 3);
    expect(metrics.revealToConflict).toBeNull();
    expect(metrics.occluderIneffective).toEqual([
      {
        observer: 'ego',
        target: 'target',
        pair: ['ego', 'target'],
        conflictT: 0,
        firstBlockedT: 2,
        occluderId: 'wall',
        relevantOccluderIds: ['wall'],
        reason: 'never_blocked_before_conflict',
      },
    ]);
  });

  it('does not reuse an older open transition after clear-then-reblock before conflict', () => {
    const acc = newMetricAccumulator(['ego', 'target'], [{ observer: 'ego', target: 'target', occluderId: 'wall' }]);
    observe(acc, 0, 0, 40); // blocked
    observe(acc, 1, 30, 50); // clear/open transition
    observe(acc, 2, 18, 30); // re-blocked before conflict
    observe(acc, 3, 19, 25); // closest criticality sample while still blocked

    const metrics = computeMetrics(acc, 4);
    expect(metrics.revealToConflict).toBeNull();
    expect(metrics.occluderIneffective).toEqual([]);
    expect(metrics.declaredOcclusion).toEqual([
      expect.objectContaining({ status: 'blocked_at_conflict', losOpenT: null }),
    ]);
  });

  it('reports reveal only after a blocked-to-clear transition before conflict', () => {
    const acc = newMetricAccumulator(['ego', 'target'], [{ observer: 'ego', target: 'target', occluderId: 'wall' }]);
    observe(acc, 0, 0, 40);
    observe(acc, 2.6, 26, 40);
    observe(acc, 3.4, 34, 40);

    const metrics = computeMetrics(acc, 4);
    const predictedConflictT = metrics.minTTC!.t + metrics.minTTC!.value;
    expect(metrics.occluderIneffective).toEqual([]);
    expect(metrics.revealToConflict).toEqual(
      expect.objectContaining({
        observer: 'ego',
        target: 'target',
        pair: ['ego', 'target'],
        occluderId: 'wall',
        relevantOccluderIds: ['wall'],
        firstBlockedT: 0,
        losOpenT: 2.6,
        conflictT: predictedConflictT,
      }),
    );
    expect(metrics.revealToConflict!.value).toBeCloseTo(predictedConflictT - 2.6, 6);
    expect(evaluateMetrics(metrics, 4).findings.map((finding) => finding.code)).not.toContain('occlusion_unproven');
  });

  it('reports every declaration even when only one occluder is effective', () => {
    const both = buildOccluders([
      { id: 'wall', obb: { center: { x: 20, z: 0 }, lengthM: 8, widthM: 2, heightM: 2, headingRad: 0 } },
      { id: 'off-axis-wall', obb: { center: { x: 20, z: 50 }, lengthM: 8, widthM: 2, heightM: 2, headingRad: 0 } },
    ]);
    const acc = newMetricAccumulator(['ego', 'target'], [
      { observer: 'ego', target: 'target', occluderId: 'wall' },
      { observer: 'ego', target: 'target', occluderId: 'off-axis-wall' },
    ]);
    observe(acc, 0, 0, 40, both);
    observe(acc, 2.6, 26, 40, both);
    observe(acc, 3.4, 34, 40, both);

    const metrics = computeMetrics(acc, 4);
    expect(metrics.declaredOcclusion?.map((entry) => [entry.occluderId, entry.status])).toEqual([
      ['off-axis-wall', 'never_blocked_before_conflict'],
      ['wall', 'revealed_before_conflict'],
    ]);
  });

  it('distinguishes an unresolved occluder from a pair that was never observable', () => {
    const missingOccluder = newMetricAccumulator(['ego', 'target'], [
      { observer: 'ego', target: 'target', occluderId: 'wall' },
    ]);
    observe(missingOccluder, 0, 0, 40, []);
    const missingOccluderMetrics = computeMetrics(missingOccluder, 4);
    expect(missingOccluderMetrics.declaredOcclusion).toEqual([
      expect.objectContaining({
        status: 'occluder_unobserved',
        conflictT: missingOccluderMetrics.minTTC!.t + missingOccluderMetrics.minTTC!.value,
      }),
    ]);

    const missingPair = newMetricAccumulator(['ego', 'target'], [
      { observer: 'ego', target: 'target', occluderId: 'wall' },
    ]);
    expect(computeMetrics(missingPair, 4).declaredOcclusion).toEqual([
      expect.objectContaining({ status: 'pair_unobserved', conflictT: null }),
    ]);
  });

  it('preserves observer/target direction even when lexical pair ordering differs', () => {
    const acc = newMetricAccumulator(['a-target', 'z-observer'], [
      { observer: 'z-observer', target: 'a-target', occluderId: 'wall' },
    ]);
    observeTick(acc, 0, [actor('z-observer', 0, 10), actor('a-target', 40, 0)], new Set(), onAxis);
    observeTick(acc, 2.6, [actor('z-observer', 26, 10), actor('a-target', 40, 0)], new Set(), onAxis);
    observeTick(acc, 3.4, [actor('z-observer', 34, 10), actor('a-target', 40, 0)], new Set(), onAxis);

    const metrics = computeMetrics(acc, 4);
    expect(metrics.revealToConflict).toEqual(expect.objectContaining({
      observer: 'z-observer',
      target: 'a-target',
      pair: ['a-target', 'z-observer'],
    }));
  });
});
