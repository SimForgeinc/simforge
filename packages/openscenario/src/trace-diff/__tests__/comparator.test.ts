import { describe, expect, it } from 'vitest';
import { contentHash } from '@simforge-oss/engine';
import {
  buildDualTracePlaybackData,
  compareNormalizedTraces,
  headingDeltaRad,
  mapEntities,
  normalizeExternalTrace,
  toComparisonUiModel,
  wrapHeadingRad,
  type EntityMappingResult,
  type NormalizedTrace,
  type ObservableCollision,
  type ObservableSignalState,
  type RawExternalTrace,
} from '../index.js';

function raw(options: {
  id?: string;
  drift?: number;
  start?: number;
  timeOffsetS?: number;
  transform?: RawExternalTrace['frameTransform'];
  collisions?: readonly ObservableCollision[];
  durationS?: number;
  completed?: boolean;
  signals?: readonly ObservableSignalState[];
} = {}): RawExternalTrace {
  const start = options.start ?? 0;
  return {
    format: 'csv-test-v1',
    simulator: { name: 'test', version: '1' },
    frameTransform: options.transform ?? { translationM: [0, 0, 0], rotationRad: 0 },
    ...(options.timeOffsetS === undefined ? {} : { timeOffsetS: options.timeOffsetS }),
    durationS: options.durationS ?? 20,
    completed: options.completed ?? true,
    entities: [{
      id: options.id ?? 'ego',
      samples: Array.from({ length: 21 }, (_, i) => ({
        t: start + i,
        x: i + (options.drift ?? 0),
        y: 0,
        z: 0,
        headingRad: i === 0 ? Math.PI - 0.01 : -Math.PI + 0.01,
        speedMps: 1,
        accelerationMps2: 0,
        laneRsl: 'road:1:lane:-1',
        s: i,
        present: true,
      })),
    }],
    collisions: options.collisions,
    signals: options.signals,
  };
}

function normalized(input: RawExternalTrace, ids = ['ego']): { trace: NormalizedTrace; mapping: EntityMappingResult } {
  return normalizeExternalTrace(input, ids);
}

function asCanonical(external: NormalizedTrace): NormalizedTrace {
  const base = { ...external, side: 'canonical' as const, source: 'canonical' };
  return { ...base, contentHash: contentHash({ ...base, contentHash: undefined }) };
}

describe('trace normalization', () => {
  it('resamples to 50 Hz for exactly 0-20 seconds and wraps headings across pi', () => {
    const { trace } = normalized(raw());
    expect(trace.t).toHaveLength(1001);
    expect(trace.t[0]).toBe(0);
    expect(trace.t.at(-1)).toBe(20);
    expect(trace.actors.ego!.x[25]).toBeCloseTo(0.5, 8);
    expect(Math.abs(trace.actors.ego!.headingRad[25]!)).toBeGreaterThan(3);
    expect(Math.abs(headingDeltaRad(Math.PI - 0.01, -Math.PI + 0.01))).toBeCloseTo(0.02);
    expect(wrapHeadingRad(3 * Math.PI)).toBeCloseTo(-Math.PI);
  });

  it('normalizes time offsets and arbitrary map-local transforms', () => {
    const input = raw({ start: 1, timeOffsetS: -1, transform: { translationM: [10, 20, 3], rotationRad: Math.PI / 2 } });
    const { trace } = normalized(input);
    expect(trace.actors.ego!.x[0]).toBeCloseTo(10);
    expect(trace.actors.ego!.y[0]).toBeCloseTo(20);
    expect(trace.actors.ego!.z[0]).toBeCloseTo(3);
    expect(trace.actors.ego!.x.at(-1)).toBeCloseTo(10);
    expect(trace.actors.ego!.y.at(-1)).toBeCloseTo(40);
    expect(trace.completed).toBe(true);
  });

  it('maps actors deterministically and refuses ambiguous normalized names', () => {
    expect(mapEntities(['ego', 'npc'], [{ id: 'Ego' }, { id: 'npc' }]).entries).toEqual([
      { canonicalId: 'ego', externalId: 'Ego', basis: 'unique-normalized-name' },
      { canonicalId: 'npc', externalId: 'npc', basis: 'exact-id' },
    ]);
    const ambiguous = mapEntities(['actor-a', 'actora'], [{ id: 'ACTOR A' }]);
    expect(ambiguous.ambiguousExternalIds).toEqual(['ACTOR A']);
    expect(ambiguous.missingCanonicalIds).toEqual(['actor-a', 'actora']);
  });
});

describe('quantitative comparison', () => {
  it('passes identical traces and produces deterministic report and playback hashes', () => {
    const first = normalized(raw());
    const canonical = asCanonical(first.trace);
    const reportA = compareNormalizedTraces(canonical, first.trace, first.mapping);
    const reportB = compareNormalizedTraces(canonical, first.trace, first.mapping);
    expect(reportA.verdict).toBe('pass');
    expect(reportA.reportHash).toBe(reportB.reportHash);
    expect(reportA.globalMetrics.xyM.max).toBe(0);
    expect(toComparisonUiModel(reportA).status).toBe('pass');
    const playback = buildDualTracePlaybackData(canonical, first.trace);
    expect(playback.frames).toHaveLength(1001);
    expect(playback.frames[500]!.actors.ego!.positionErrorM).toBe(0);
  });

  it('detects spatial drift and classifies it as execution divergence', () => {
    const reference = normalized(raw());
    const changed = normalized(raw({ drift: 0.8 }));
    const report = compareNormalizedTraces(asCanonical(reference.trace), changed.trace, changed.mapping);
    expect(report.verdict).toBe('fail');
    expect(report.failureClasses).toContain('execution-divergence');
    expect(report.actorMetrics[0]!.xyM.rmse).toBeCloseTo(0.8, 5);
  });

  it('requires declared lane occupancy in strict trajectory mode', () => {
    const result = normalized(raw());
    const canonical = {
      ...asCanonical(result.trace),
      actors: { ego: { ...result.trace.actors.ego!, roadId: result.trace.t.map(() => '1') } },
    } satisfies NormalizedTrace;
    const noExternalLane = {
      ...result.trace,
      actors: {
        ego: { ...result.trace.actors.ego!, laneRsl: result.trace.t.map(() => null), laneId: result.trace.t.map(() => null) },
      },
    } satisfies NormalizedTrace;
    const strict = compareNormalizedTraces(canonical, noExternalLane, result.mapping);
    expect(strict.verdict).toBe('fail');
    expect(strict.findings).toContainEqual(expect.objectContaining({ code: 'actor-occupancy-missing', actorId: 'ego' }));
    expect(strict.findings).toContainEqual(expect.objectContaining({
      code: 'actor-occupancy-missing', message: expect.stringContaining('roadId'),
    }));
    const supportedActions = compareNormalizedTraces(canonical, noExternalLane, result.mapping, { profile: 'supported-actions-v1' });
    expect(supportedActions.findings.some((finding) => finding.code === 'actor-occupancy-missing')).toBe(false);
  });

  it('classifies missing actors as export loss', () => {
    const reference = normalized(raw());
    const changed = normalized({ ...raw({ id: 'other' }), entities: [] }, ['ego']);
    const report = compareNormalizedTraces(asCanonical(reference.trace), changed.trace, changed.mapping);
    expect(report.verdict).toBe('fail');
    expect(report.failureClasses).toContain('export-loss');
    expect(report.findings.some((finding) => finding.code === 'missing-external-actor')).toBe(true);
  });

  it('fails an unexpected external actor outside the canonical closure', () => {
    const canonicalNormalized = normalized(raw());
    const rogue = raw({ id: 'rogue' }).entities[0]!;
    const externalNormalized = normalized({ ...raw(), entities: [...raw().entities, rogue] });
    const report = compareNormalizedTraces(asCanonical(canonicalNormalized.trace), externalNormalized.trace, externalNormalized.mapping);
    expect(report.verdict).toBe('fail');
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'unexpected-external-actor', actorId: 'rogue', classification: 'export-loss',
    }));
  });

  it('detects collision-pair and timing mismatches', () => {
    const canonicalNormalized = normalized(raw({ collisions: [{ t: 5, actorIds: ['ego', 'npc'] }] }));
    const externalNormalized = normalized(raw({ collisions: [{ t: 5.2, actorIds: ['ego', 'npc'] }] }));
    const report = compareNormalizedTraces(asCanonical(canonicalNormalized.trace), externalNormalized.trace, externalNormalized.mapping);
    expect(report.verdict).toBe('fail');
    expect(report.collisionComparison[0]!.onsetErrorS).toBeCloseTo(0.2);
    expect(report.findings.some((finding) => finding.code === 'collision-parity')).toBe(true);
  });

  it('compares traffic-signal state edges within one fixed step', () => {
    const canonicalNormalized = normalized(raw({ signals: [
      { t: 0, signalId: 'head-1', state: 'red' },
      { t: 5, signalId: 'head-1', state: 'green' },
    ] }));
    const withinStep = normalized(raw({ signals: [
      { t: 0, signalId: 'head-1', state: 'red' },
      { t: 5.02, signalId: 'head-1', state: 'green' },
    ] }));
    const pass = compareNormalizedTraces(asCanonical(canonicalNormalized.trace), withinStep.trace, withinStep.mapping);
    expect(pass.verdict).toBe('pass');
    expect(pass.signalComparison.find((edge) => edge.key === 'head-1:green')!.onsetErrorS).toBeCloseTo(0.02);

    const missing = normalized(raw({ signals: [{ t: 0, signalId: 'head-1', state: 'red' }] }));
    const fail = compareNormalizedTraces(asCanonical(canonicalNormalized.trace), missing.trace, missing.mapping);
    expect(fail.verdict).toBe('fail');
    expect(fail.findings).toContainEqual(expect.objectContaining({ code: 'signal-parity', classification: 'export-loss' }));
  });

  it('compares event onset/order only for event kinds the runner exposes', () => {
    const result = normalized(raw());
    const canonical = {
      ...asCanonical(result.trace),
      events: [
        { t: 2, kind: 'lane-change', actorIds: ['ego'] },
        { t: 4, kind: 'indicator', actorIds: ['ego'] },
        { t: 6, kind: 'internal-only', actorIds: ['ego'] },
      ],
    } satisfies NormalizedTrace;
    const external = {
      ...result.trace,
      events: [
        { t: 2.5, kind: 'indicator', actorIds: ['ego'] },
        { t: 4.5, kind: 'lane-change', actorIds: ['ego'] },
      ],
    } satisfies NormalizedTrace;
    const report = compareNormalizedTraces(canonical, external, result.mapping, {
      profile: 'supported-actions-v1',
      observableEventKinds: ['lane-change', 'indicator'],
    });
    expect(report.eventComparison).toHaveLength(2);
    expect(report.eventComparison.every((event) => !event.orderMatches)).toBe(true);
    expect(report.findings.some((finding) => finding.code === 'event-parity')).toBe(true);
  });

  it('separates unsupported semantics and external runtime failures', () => {
    const result = normalized(raw());
    const report = compareNormalizedTraces(asCanonical(result.trace), result.trace, result.mapping, {
      unsupportedSemantics: ['Dynamic signal controller is unavailable in target'],
      externalFailure: { stage: 'runtime', message: 'esmini exited with status 1' },
    });
    expect(report.failureClasses).toEqual(['external-parse-runtime', 'unsupported-semantic']);
  });
});
