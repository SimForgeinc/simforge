import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  ATTEMPT_RECORD_SCHEMA,
  BENCHMARK_REPORT_SCHEMA,
  CASE_OUTCOMES,
  DEFECT_CODES,
  FUNNEL_STAGE_IDS,
  attemptDeterminism,
  balance,
  buildBenchmarkReport,
  buildDiversity,
  buildFunnel,
  buildThroughput,
  caseOutcome,
  caseResolved,
  classifyOperational,
  deterministicUnsupportedReason,
  percentile,
  perHour,
  ratio,
  summarize,
  trajectoryDistance,
  trajectoryFeatures,
  trajectoryFingerprint,
  verifyBenchmarkReport,
  wilson95,
} from './benchmark.mjs';
import { collectJobUsage, traceIdentity } from './pipeline.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const GOLDEN_TRACE = join(REPO_ROOT, 'fixtures/evidence/golden-yale-bus-stop/trace.json.gz');

// ---------------------------------------------------------------------------
// Statistics: a rate is never readable without its denominator
// ---------------------------------------------------------------------------

test('a rate always carries its denominator and reports null rather than a fake zero', () => {
  assert.deepEqual(ratio(3, 4), {
    numerator: 3,
    denominator: 4,
    value: 0.75,
    wilson95: { low: 0.300642, high: 0.954413, z: 1.959964 },
  });
  const empty = ratio(0, 0);
  assert.equal(empty.denominator, 0);
  assert.equal(empty.value, null, 'a rate over nothing must be null, not 0');
  assert.equal(empty.wilson95, null, 'an interval over zero trials is not an interval');
  const hourly = perHour(12, 0);
  assert.equal(hourly.denominatorHours, null);
  assert.equal(hourly.value, null);
  const measuredHourly = perHour(12, 4);
  assert.equal(measuredHourly.denominatorHours, 4);
  assert.equal(measuredHourly.value, 3);
});

test('Wilson 95% intervals bracket the point estimate and refuse an empty denominator', () => {
  assert.equal(wilson95(0, 0), null);
  assert.equal(wilson95(3, 2), null, 'more successes than trials is not a measurement');
  const half = wilson95(5, 10);
  assert.ok(half.low < 0.5 && half.high > 0.5);
  const certain = wilson95(10, 10);
  assert.equal(certain.high, 1);
  assert.ok(certain.low > 0.65 && certain.low < 1);
  const wide = wilson95(1, 2);
  const narrow = wilson95(50, 100);
  assert.ok(wide.high - wide.low > narrow.high - narrow.low, 'small samples must produce wider intervals');
});

test('percentiles and distribution summaries stay null when nothing was measured', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.9), 7);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5.5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1);
  assert.deepEqual(summarize([]), {
    n: 0, min: null, p50: null, p90: null, max: null, mean: null, total: null,
  });
  const summary = summarize([10, 20, 30]);
  assert.equal(summary.n, 3);
  assert.equal(summary.p50, 20);
  assert.equal(summary.total, 60);
  // Non-numeric samples are dropped, never coerced to zero.
  assert.equal(summarize([5, null, undefined, Number.NaN, 15]).n, 2);
  assert.equal(summarize([5, null, 15]).mean, 10);
});

test('balance is null below two buckets and maximal when buckets are even', () => {
  assert.equal(balance({}), null);
  assert.equal(balance({ only: 9 }), null);
  assert.equal(balance({ a: 5, b: 5 }), 1);
  assert.ok(balance({ a: 9, b: 1 }) < 0.5);
});

// ---------------------------------------------------------------------------
// Defect vocabulary
// ---------------------------------------------------------------------------

test('defect reporting uses only the vocabulary the emitting stages declare', () => {
  assert.deepEqual(DEFECT_CODES, [...DEFECT_CODES].sort());
  assert.deepEqual([...new Set(DEFECT_CODES)], DEFECT_CODES);
  // The 2D semantic oracle's codes, the deterministic validators' codes, the exporter's
  // classified render failures, and the frozen gate's own verdict.
  assert.ok(DEFECT_CODES.includes('scenario.mechanism'));
  assert.ok(DEFECT_CODES.includes('scenario.gate'));
  assert.ok(DEFECT_CODES.includes('simulation.actor.frozen_tail'));
  assert.ok(DEFECT_CODES.includes('render.camera.composition_failed'));
  assert.ok(DEFECT_CODES.includes('capture.missing_video'));
  assert.equal(DEFECT_CODES.includes('collision'), false, 'the obsolete flat taxonomy is gone');
  assert.equal(DEFECT_CODES.includes('unclassified'), false, 'unknown prose is never folded into a fake code');
  // No stage can produce a judge verdict any more, so no judge code may be reportable.
  assert.equal(DEFECT_CODES.some((code) => code.startsWith('judge.')), false);
});

test('the report surfaces defect codes no emitting stage declares', () => {
  const current = record({
    furthest: 'accepted',
    outcome: {
      censoredAtStage: null,
      operational: null,
      defectCodes: ['scenario.mechanism'],
    },
  });
  const crossContract = record({
    furthest: 'accepted',
    outcome: {
      censoredAtStage: null,
      operational: null,
      defectCodes: ['legacy.collision'],
    },
  });
  const report = buildBenchmarkReport({
    cases: [{ id: 'case', target: 5, submittedAttempts: 2, records: [current, crossContract], videos: [] }],
    target: 5,
    maxGenerationAttempts: 12,
  });
  assert.equal(report.defects.taxonomy, 'apps/showcase/server/product-contract.mjs');
  assert.deepEqual(report.defects.vocabulary, DEFECT_CODES);
  assert.deepEqual(report.defects.unknownCodes, ['legacy.collision']);
  assert.equal(report.defects.attemptsByCode['scenario.mechanism'], 1);
  assert.equal(report.defects.attemptsByCode['legacy.collision'], 1);
});

// ---------------------------------------------------------------------------
// Operational failure classification
// ---------------------------------------------------------------------------

test('infrastructure failures are classified and generator failures are not', () => {
  assert.equal(classifyOperational('HTTP 429: rate_limit_error').class, 'model-access');
  assert.equal(classifyOperational('No credential available for provider openai-codex').class, 'model-access');
  assert.equal(classifyOperational('gateway unavailable at 127.0.0.1:4141').class, 'gateway-unavailable');
  assert.equal(classifyOperational('spawn failed: ENOSPC').class, 'host-resource');
  assert.equal(classifyOperational('Execution context was destroyed').class, 'renderer-infrastructure');
  assert.equal(classifyOperational('submit case-a failed 502: bad gateway').class, 'provider-server-error',
    'classification is ordered, so the most specific infrastructure cause wins deterministically');
  assert.equal(classifyOperational('submit case-a returned no jobId').class, 'submission');
  // Real generation failures must stay in the denominator.
  assert.equal(classifyOperational('authored template violated semantic contract: ["choreography"]'), null);
  assert.equal(classifyOperational('no matching sites for authored template'), null);
  assert.equal(classifyOperational(null), null);
});

// ---------------------------------------------------------------------------
// Trajectory fingerprint and distance
// ---------------------------------------------------------------------------

function goldenTrace() {
  return JSON.parse(gunzipSync(readFileSync(GOLDEN_TRACE)).toString('utf8'));
}

test('the trajectory fingerprint reads the metric subject out of a real canonical trace', () => {
  const features = trajectoryFeatures(goldenTrace());
  assert.equal(features.subject, 'ego');
  assert.equal(features.path.length, 64, '32 samples of (x, y)');
  assert.equal(features.speed.length, 32);
  assert.ok(features.pathLengthM > 100, `expected a moving ego, measured ${features.pathLengthM} m`);
  assert.deepEqual(features.actorKinds, { bus: 1, car: 1, pedestrian: 1 });
  assert.equal(features.eventKinds.trigger_fired, 2);
  assert.equal(trajectoryFingerprint(features).length, 64);
});

test('re-encoding a video is not diversity: identical trace means identical fingerprint and zero distance', () => {
  const left = trajectoryFeatures(goldenTrace());
  const right = trajectoryFeatures(goldenTrace());
  assert.equal(trajectoryFingerprint(right), trajectoryFingerprint(left));
  assert.deepEqual(trajectoryDistance(left, right), { absoluteM: 0, shapeM: 0, speedMps: 0 });

  // Two MP4s with different bytes but the same underlying simulation.
  const fingerprint = trajectoryFingerprint(left);
  const videos = [
    { sha256: 'a'.repeat(64), cellId: 'cell-a', mapId: 'yale-street', siteId: 'site-1', trajectoryFingerprint: fingerprint, trajectoryFeatures: left },
    { sha256: 'b'.repeat(64), cellId: 'cell-a', mapId: 'yale-street', siteId: 'site-1', trajectoryFingerprint: fingerprint, trajectoryFeatures: right },
  ];
  const diversity = buildDiversity(videos, { mapUniverse: 5 });
  assert.equal(diversity.distinctVideoSha256, 2, 'the bytes really do differ');
  assert.equal(diversity.distinctTrajectoryFingerprints, 1, 'but only one scenario was produced');
  assert.equal(diversity.reencodedOnlyVideos, 1);
  assert.equal(diversity.reencodedOnlyGroups.length, 1);
  assert.equal(diversity.reencodedOnlyGroups[0].distinctVideoSha256, 2);
  assert.equal(diversity.trajectoryDistinctness.denominator, 2);
  assert.equal(diversity.trajectoryDistinctness.value, 0.5);
  assert.equal(diversity.pairwise.shapeM.max, 0, 'no trace difference means no trajectory distance');
});

test('a genuinely different realisation registers as diverse on trace, map, and site', () => {
  const base = trajectoryFeatures(goldenTrace());
  const shifted = trajectoryFeatures(goldenTrace());
  // Move the ego 40 m along x and speed it up: a different draw, not a re-encode.
  shifted.path = shifted.path.map((value, index) => (index % 2 === 0 ? value + 40 : value));
  shifted.shape = shifted.shape.map((value, index) => (index % 2 === 0 ? value * 1.5 : value));
  shifted.speed = shifted.speed.map((value) => value + 3);
  const diversity = buildDiversity([
    { sha256: 'a'.repeat(64), cellId: 'c1', mapId: 'yale-street', siteId: 's1', trajectoryFingerprint: trajectoryFingerprint(base), trajectoryFeatures: base },
    { sha256: 'b'.repeat(64), cellId: 'c2', mapId: 'el-camino-road', siteId: 's2', trajectoryFingerprint: trajectoryFingerprint(shifted), trajectoryFeatures: shifted },
  ], { mapUniverse: 5 });
  assert.equal(diversity.distinctTrajectoryFingerprints, 2);
  assert.equal(diversity.reencodedOnlyVideos, 0);
  assert.equal(diversity.pairwise.absoluteM.p50, 40);
  assert.equal(diversity.pairwise.speedMps.p50, 3);
  assert.equal(diversity.maps.distinct, 2);
  assert.deepEqual(diversity.maps.coverage, ratio(2, 5));
  assert.equal(diversity.sites.distinct, 2);
});

test('an unreadable trace yields no fingerprint instead of a shared constant', () => {
  assert.equal(trajectoryFeatures({ header: {}, ticks: { actors: {}, t: [] } }), null);
  assert.equal(trajectoryFingerprint(null), null);
  assert.equal(trajectoryDistance(null, {}), null);
  const diversity = buildDiversity([
    { sha256: 'a'.repeat(64), cellId: 'c1', mapId: 'yale-street', siteId: 's1', trajectoryFingerprint: null, trajectoryFeatures: null },
    { sha256: 'b'.repeat(64), cellId: 'c2', mapId: 'yale-street', siteId: 's1', trajectoryFingerprint: null, trajectoryFeatures: null },
  ], { mapUniverse: 5 });
  assert.equal(diversity.unfingerprintedVideos, 2);
  assert.equal(diversity.distinctTrajectoryFingerprints, 0);
  assert.equal(diversity.trajectoryDistinctness.denominator, 0);
  assert.equal(diversity.trajectoryDistinctness.value, null, 'unmeasured distinctness must not read as 0%');
  assert.equal(diversity.reencodedOnlyVideos, 0, 'unknown fingerprints are never assumed equal');
});

test('traceIdentity fingerprints a gzipped trace on disk and survives a corrupt one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'showcase-trace-identity-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const trace = goldenTrace();
  const path = join(dir, 'trace.json.gz');
  await writeFile(path, gzipSync(Buffer.from(JSON.stringify(trace))));
  const identity = await traceIdentity(path);
  assert.equal(identity.trajectoryFingerprint, trajectoryFingerprint(trajectoryFeatures(trace)));
  assert.match(identity.traceSha256, /^[a-f0-9]{64}$/);
  assert.equal(identity.inputHash, trace.header.inputHash);

  const corrupt = join(dir, 'corrupt.json.gz');
  await writeFile(corrupt, 'not gzip at all');
  assert.deepEqual(await traceIdentity(corrupt), {
    trajectoryFingerprint: null,
    trajectoryFeatures: null,
    traceSha256: null,
    inputHash: null,
    traceSeed: null,
  });
  assert.deepEqual(await traceIdentity(null), {
    trajectoryFingerprint: null,
    trajectoryFeatures: null,
    traceSha256: null,
    inputHash: null,
    traceSeed: null,
  });
});

// ---------------------------------------------------------------------------
// Funnel censoring
// ---------------------------------------------------------------------------

function record({ furthest, censoredAtStage = null, operationalClass = 'model-access', ...rest }) {
  const limit = FUNNEL_STAGE_IDS.indexOf(furthest);
  return {
    schema: ATTEMPT_RECORD_SCHEMA,
    funnel: Object.fromEntries(FUNNEL_STAGE_IDS.map((id, index) => [id, index <= limit])),
    counts: {
      gatePassed: limit >= FUNNEL_STAGE_IDS.indexOf('gate-pass') ? 1 : 0,
      eligibleCells: limit >= FUNNEL_STAGE_IDS.indexOf('eligible') ? 1 : 0,
      accepted: furthest === 'accepted' ? 1 : 0,
    },
    stages: [],
    cost: { wallS: 100, generatorWallS: 40, productWallS: 60, tokens: { inputTokens: 1000, outputTokens: 200 } },
    outcome: {
      censoredAtStage,
      operational: censoredAtStage ? { class: operationalClass, detail: 'x' } : null,
      defectCodes: [],
    },
    ...rest,
  };
}

test('the funnel is monotone and every stage row states which stage its denominator came from', () => {
  const funnel = buildFunnel([
    record({ furthest: 'accepted' }),
    record({ furthest: 'gate-pass' }),
    record({ furthest: 'author-ok' }),
  ]);
  assert.equal(funnel.monotone, true);
  assert.deepEqual(funnel.stages.map((stage) => stage.id), FUNNEL_STAGE_IDS);
  assert.equal(funnel.stages[0].denominatorStage, 'submitted attempts');
  assert.equal(funnel.stages[1].denominatorStage, 'submitted');
  assert.equal(funnel.stages.find((stage) => stage.id === 'contract-valid').denominatorStage, 'author-ok');
  const gate = funnel.stages.find((stage) => stage.id === 'gate-pass');
  assert.equal(gate.reached, 2);
  assert.equal(gate.denominator, 2, 'only the two attempts that reached cells-ok are eligible');
  assert.equal(gate.stepRate.denominator, 2);
  assert.equal(gate.stepRate.value, 1);
  for (const stage of funnel.stages) {
    assert.ok(Object.hasOwn(stage, 'denominator'), `${stage.id} must publish a denominator`);
    assert.ok(stage.reached <= stage.denominator, `${stage.id} cannot exceed its denominator`);
  }
});

test('provider failures cannot lower the generator yield', () => {
  const clean = [
    record({ furthest: 'accepted' }),
    record({ furthest: 'accepted' }),
    record({ furthest: 'cells-ok' }),
  ];
  const baseline = buildFunnel(clean);
  const baselineGate = baseline.stages.find((stage) => stage.id === 'gate-pass');
  const baselineThroughput = buildThroughput(clean, { elapsedHours: 1 });

  // Ten attempts that reached the gate and then hit a provider outage at the product decision.
  const outage = [...clean, ...Array.from({ length: 10 }, () => record({
    furthest: '3d-ok', censoredAtStage: 'accepted',
  }))];
  const degraded = buildFunnel(outage);
  const degradedGate = degraded.stages.find((stage) => stage.id === 'gate-pass');
  const degradedThroughput = buildThroughput(outage, { elapsedHours: 1 });

  assert.equal(baselineGate.stepRate.denominator, 3);
  assert.equal(degradedGate.stepRate.denominator, 13);
  assert.equal(baselineGate.stepRate.value, 0.666667);
  assert.ok(degradedGate.stepRate.value >= baselineGate.stepRate.value,
    `generator gate rate fell from ${baselineGate.stepRate.value} to ${degradedGate.stepRate.value}`);
  assert.equal(baselineThroughput.generator.yield.denominator, 3);
  assert.equal(degradedThroughput.generator.yield.denominator, 13);
  assert.ok(degradedThroughput.generator.yield.value >= baselineThroughput.generator.yield.value,
    'generator yield must not fall because a provider went down');
  assert.equal(degradedThroughput.generator.attempts, 13, 'every attempt still counts toward the generator');
  assert.equal(degradedThroughput.product.attempts, 3, 'but only uncensored attempts count toward the product');

  // The outage is reported, not hidden.
  assert.equal(degraded.denominators.operationalFailures, 10);
  const censoredStage = degraded.stages.find((stage) => stage.id === 'accepted');
  assert.equal(censoredStage.censoredHere, 10);
  assert.equal(censoredStage.denominator, 2, 'censored attempts leave the failing stage denominator');
});

test('an attempt censored early keeps the stage outcomes it did observe', () => {
  const funnel = buildFunnel([
    record({ furthest: 'contract-valid', censoredAtStage: 'cells-ok', operationalClass: 'host-resource' }),
    record({ furthest: 'accepted' }),
  ]);
  const author = funnel.stages.find((stage) => stage.id === 'author-ok');
  assert.equal(author.denominator, 2, 'both attempts were observed authoring');
  assert.equal(author.reached, 2);
  const cells = funnel.stages.find((stage) => stage.id === 'cells-ok');
  assert.equal(cells.censoredHere, 1);
  assert.equal(cells.denominator, 1, 'the censored attempt has no observed simulation outcome');
  assert.equal(cells.reached, 1);
});

test('generator and product throughput are reported against separate boundaries', () => {
  const records = [
    record({ furthest: 'accepted' }),
    record({ furthest: 'gate-pass' }),
    record({ furthest: '3d-ok', censoredAtStage: 'accepted' }),
  ];
  const throughput = buildThroughput(records, { elapsedHours: 2 });
  assert.match(throughput.generator.boundary, /semantic-2d/);
  assert.equal(throughput.generator.semantic2dAttempts, 2);
  assert.equal(throughput.generator.eligibleYield.value, 0.666667);
  assert.match(throughput.product.boundary, /75-product/);
  assert.equal(throughput.generator.attempts, 3);
  assert.equal(throughput.generator.gatePassedAttempts, 3);
  assert.equal(throughput.generator.eligibleAttempts, 2);
  assert.equal(throughput.generator.eligibleCells, 2);
  assert.equal(throughput.generator.yield.denominator, 3);
  assert.equal(throughput.generator.yield.value, 0.666667);
  assert.equal(throughput.generator.gateYield.denominator, 3);
  assert.equal(throughput.generator.gateYield.value, 1);
  assert.equal(throughput.generator.eligibleAttemptsPerHour.denominatorHours, 2);
  assert.equal(throughput.generator.eligibleAttemptsPerHour.value, 1);
  assert.equal(throughput.generator.eligibleCellsPerHour.denominatorHours, 2);
  assert.equal(throughput.generator.eligibleCellsPerHour.value, 1);
  assert.equal(throughput.generator.tokensPerEligibleAttempt, 1800);
  assert.equal(Object.hasOwn(throughput.generator, 'gatePassedCellsPerHour'), false);
  assert.equal(Object.hasOwn(throughput.generator, 'tokensPerGatePassedAttempt'), false);
  assert.equal(throughput.product.attempts, 2);
  assert.equal(throughput.product.acceptedAttempts, 1);
  assert.equal(throughput.product.yield.denominator, 2);
  assert.equal(throughput.generator.attemptsPerHour.denominatorHours, 2);
  assert.equal(throughput.generator.attemptsPerHour.value, 1.5);
  assert.equal(throughput.generator.wallS.n, 3);
  assert.equal(throughput.generator.wallS.p50, 40);
  assert.equal(throughput.product.wallS.p90, 100);
  const noWindow = buildThroughput(records, { elapsedHours: null });
  assert.equal(noWindow.generator.attemptsPerHour.denominatorHours, null);
  assert.equal(noWindow.generator.attemptsPerHour.value, null, 'no observation window means no rate');
});

// ---------------------------------------------------------------------------
// Execution conditions
// ---------------------------------------------------------------------------

test('execution keeps measured denominators and buckets unmeasured model conditions as unknown', () => {
  const records = [
    record({
      furthest: 'accepted',
      execution: { cold: true, resumed: false, resumedStages: [], coldWarmBasis: 'process job index' },
      concurrency: { activeJobsAtStart: 1, logicalCpus: 8 },
      models: {
        author: { model: 'author-a', effort: 'high' },
        engineRequested: 'compiler',
        engineResolved: 'compiler',
      },
    }),
    record({
      furthest: 'accepted',
      execution: { cold: false, resumed: true, resumedStages: ['20-author'], coldWarmBasis: 'process job index' },
      concurrency: { activeJobsAtStart: 2, logicalCpus: 8 },
      models: {
        author: { model: 'author-a', effort: 'high' },
        engineRequested: 'vista2',
        engineResolved: 'vista2',
      },
    }),
    record({ furthest: 'accepted' }),
  ];
  const report = buildBenchmarkReport({
    cases: [{ id: 'case', target: 5, submittedAttempts: 3, records, videos: [] }],
    target: 5,
    maxGenerationAttempts: 12,
  });
  const { execution } = report;
  assert.equal(execution.attempts, 3);
  assert.equal(execution.cold.denominator, 2);
  assert.equal(execution.cold.value, 0.5);
  assert.equal(execution.resumed.denominator, 2);
  assert.equal(execution.resumed.value, 0.5);
  assert.equal(execution.concurrency.load1AtStart.n, 0);
  assert.equal(execution.concurrency.load1AtStart.mean, null, 'an unmeasured load must not become zero');
  assert.equal(execution.models.author.unknown, 1);
  assert.equal(execution.models.engineRequested.unknown, 1);
  assert.equal(execution.models.engineResolved.unknown, 1);
  assert.equal(execution.models.judge, undefined, 'no judge model can be recorded any more');
  assert.equal(execution.models.productReviewVersion, undefined, 'there is no product review to version');
  const histogramTotal = (histogram) => Object.values(histogram).reduce((sum, count) => sum + count, 0);
  for (const histogram of [
    execution.concurrency.logicalCpus,
    execution.concurrency.scheduler,
    execution.models.author,
    execution.models.engineRequested,
    execution.models.engineResolved,
  ]) {
    assert.equal(histogramTotal(histogram), execution.attempts);
  }
});

// ---------------------------------------------------------------------------
// Deterministic unsupported reasons
// ---------------------------------------------------------------------------

test('a single deterministic failure is not enough to call a case unsupported', () => {
  const infeasible = record({ furthest: 'submitted', precheck: { feasible: false, missing: ['tram_track'] } });
  assert.deepEqual(attemptDeterminism(infeasible), { reason: 'precheck-infeasible', evidence: ['tram_track'] });
  assert.equal(deterministicUnsupportedReason([infeasible]), null, 'one attempt is a data point, not a verdict');
  const twice = deterministicUnsupportedReason([infeasible, { ...infeasible }]);
  assert.equal(twice.reason, 'precheck-infeasible');
  assert.equal(twice.agreeingAttempts, 2);
  assert.deepEqual(twice.evidence, ['tram_track']);
  assert.ok(twice.detail.length > 0);
});

test('attempts must agree on the same evidence, not merely fail at the same stage', () => {
  const left = record({ furthest: 'submitted', precheck: { feasible: false, missing: ['tram_track'] } });
  const right = record({ furthest: 'submitted', precheck: { feasible: false, missing: ['roundabout'] } });
  assert.equal(deterministicUnsupportedReason([left, right]), null);
  assert.equal(deterministicUnsupportedReason([left, right, { ...right }]).evidence[0], 'roundabout');
});

test('each deterministic unsupported reason is recognised from its own evidence', () => {
  const noSites = record({ furthest: 'contract-valid', counts: { sitesMatched: 0 }, maps: ['yale-street'] });
  assert.deepEqual(attemptDeterminism(noSites), { reason: 'no-matching-sites', evidence: ['yale-street'] });

  const contract = record({ furthest: 'author-ok', contractFailures: ['choreography.interactions', 'props.bus'] });
  assert.deepEqual(attemptDeterminism(contract), {
    reason: 'contract-unsatisfiable', evidence: ['choreography.interactions', 'props.bus'],
  });

  const gate = record({
    furthest: 'cells-ok',
    cells: [{ gateFirstFailure: 'C2' }, { gateFirstFailure: 'C2' }],
  });
  assert.deepEqual(attemptDeterminism(gate), { reason: 'gate-unreachable', evidence: ['C2'] });

  // Cells failing different criteria is not a deterministic blocker.
  assert.equal(attemptDeterminism(record({
    furthest: 'cells-ok', cells: [{ gateFirstFailure: 'C2' }, { gateFirstFailure: 'C4' }],
  })), null);
});

test('an operationally censored attempt never contributes to an unsupported verdict', () => {
  const censored = record({
    furthest: 'submitted',
    censoredAtStage: 'author-ok',
    precheck: { feasible: false, missing: ['tram_track'] },
  });
  assert.equal(attemptDeterminism(censored), null);
  assert.equal(deterministicUnsupportedReason([censored, { ...censored }]), null,
    'a provider outage must never be read as an unsupported scenario');
});

// ---------------------------------------------------------------------------
// Case outcomes
// ---------------------------------------------------------------------------

test('every case lands in exactly one outcome and only three of them are terminal', () => {
  assert.equal(caseOutcome({ acceptedVideos: 5, target: 5 }), 'accepted');
  assert.equal(caseOutcome({ acceptedVideos: 0, target: 5, submittedAttempts: 0 }), 'pending');
  assert.equal(caseOutcome({ acceptedVideos: 1, target: 5, submittedAttempts: 3, activeAttempts: 1 }), 'attempting');
  assert.equal(caseOutcome({
    acceptedVideos: 0,
    target: 5,
    submittedAttempts: 12,
    unproductiveStreak: 12,
    maxGenerationAttempts: 12,
  }), 'exhausted');
  assert.equal(caseOutcome({
    acceptedVideos: 0, target: 5, submittedAttempts: 4, unsupportedReason: 'precheck-infeasible',
  }), 'unsupported');
  // An active attempt outranks an unsupported verdict: the evidence is still moving.
  assert.equal(caseOutcome({
    acceptedVideos: 0, target: 5, submittedAttempts: 4, activeAttempts: 1, unsupportedReason: 'precheck-infeasible',
  }), 'attempting');
  // Operational failures alone never exhaust the consecutive unproductive budget.
  assert.equal(caseOutcome({
    acceptedVideos: 0,
    target: 5,
    submittedAttempts: 12,
    unproductiveStreak: 2,
    maxGenerationAttempts: 12,
  }), 'attempting');
  assert.deepEqual(CASE_OUTCOMES.filter(caseResolved), ['accepted', 'exhausted', 'unsupported']);
});

test('exhaustion follows the consecutive unproductive streak, not lifetime attempts', () => {
  const afterAProductiveAttempt = {
    acceptedVideos: 1,
    target: 5,
    submittedAttempts: 20,
    maxGenerationAttempts: 12,
  };
  assert.equal(caseOutcome({ ...afterAProductiveAttempt, unproductiveStreak: 11 }), 'attempting');
  assert.equal(caseOutcome({ ...afterAProductiveAttempt, unproductiveStreak: 12 }), 'exhausted');
  assert.equal(caseOutcome({
    ...afterAProductiveAttempt,
    unproductiveStreak: 11,
    operationalFailures: 100,
  }), 'attempting', 'operational failures never consume the generation budget');
});

// ---------------------------------------------------------------------------
// Full corpus report
// ---------------------------------------------------------------------------

const MAPS = ['yale-street', 'belmont-research-center', 'el-camino-road', 'easterbrook-discovery-school', 'richmond-field-station'];

function corpusFixture(entries = 67) {
  const features = trajectoryFeatures(goldenTrace());
  return Array.from({ length: entries }, (_, index) => {
    const mapId = MAPS[index % MAPS.length];
    const siteId = `site-${index % 4}`;
    const base = { id: `case-${index}`, title: `Case ${index}`, index, priority: 90, target: 5 };
    if (index < 30) {
      return {
        ...base,
        acceptedVideos: 5,
        submittedAttempts: 3,
        records: [1, 2, 3].map(() => record({ furthest: 'accepted' })),
        videos: Array.from({ length: 5 }, (_, video) => ({
          sha256: createHash('sha256').update(`${index}:${video}`).digest('hex'),
          cellId: `${mapId}-${siteId}-${video}`,
          mapId,
          siteId,
          trajectoryFingerprint: createHash('sha256').update(`trace:${index}:${video}`).digest('hex'),
          trajectoryFeatures: { ...features, speed: features.speed.map((value) => value + video) },
        })),
      };
    }
    if (index < 45) {
      return { ...base, acceptedVideos: 1, submittedAttempts: 2, activeAttempts: 1, records: [record({ furthest: '3d-ok' })], videos: [] };
    }
    if (index < 52) {
      return {
        ...base,
        acceptedVideos: 0,
        submittedAttempts: 2,
        records: [1, 2].map(() => record({ furthest: 'submitted', precheck: { feasible: false, missing: ['tram_track'] } })),
        videos: [],
      };
    }
    if (index < 60) {
      return {
        ...base,
        acceptedVideos: 0,
        submittedAttempts: 12,
        unproductiveStreak: 12,
        records: Array.from({ length: 12 }, () => record({ furthest: '2d-ok' })),
        videos: [],
      };
    }
    return { ...base, acceptedVideos: 0, submittedAttempts: 0, records: [], videos: [] };
  });
}

test('all 67 corpus entries are reported and accounted for exactly once', () => {
  const report = buildBenchmarkReport({
    campaignId: 'edge-cases-67x5',
    generatedAt: '2026-08-18T00:00:00.000Z',
    cases: corpusFixture(67),
    target: 5,
    maxGenerationAttempts: 12,
    elapsedHours: 40,
    mapUniverse: MAPS.length,
  });
  assert.equal(report.schema, BENCHMARK_REPORT_SCHEMA);
  assert.equal(report.corpus.entries, 67);
  assert.equal(report.corpus.reported, 67);
  assert.equal(report.cases.length, 67);
  assert.equal(report.corpus.accountedFor, true);
  assert.equal(
    Object.values(report.corpus.outcomes).reduce((sum, value) => sum + value, 0),
    67,
    'the five outcomes must partition the corpus',
  );
  assert.deepEqual(report.corpus.outcomes, {
    accepted: 30, attempting: 15, exhausted: 8, unsupported: 7, pending: 7,
  });
  assert.deepEqual(verifyBenchmarkReport(report, { expectedEntries: 67 }), []);
});

test('unsupported entries stay in the coverage denominator and leave the quality denominator', () => {
  const report = buildBenchmarkReport({
    campaignId: 'edge-cases-67x5',
    cases: corpusFixture(67),
    target: 5,
    maxGenerationAttempts: 12,
    elapsedHours: 40,
    mapUniverse: MAPS.length,
  });
  assert.equal(report.denominators.coverageDenominator, 67);
  assert.equal(report.denominators.qualityDenominator, 60, '67 entries minus 7 unsupported');
  assert.equal(report.coverage.entriesReported.denominator, 67);
  assert.equal(report.coverage.entriesReported.value, 1);
  assert.equal(report.coverage.accepted.denominator, 67);
  assert.equal(report.quality.acceptedOfSupported.denominator, 60);
  assert.ok(report.quality.acceptedOfSupported.value > report.coverage.accepted.value,
    'removing unreachable cases must raise the quality rate, not the coverage rate');
  assert.equal(report.unsupported.length, 7);
  for (const entry of report.unsupported) {
    assert.equal(entry.reason, 'precheck-infeasible');
    assert.equal(entry.agreeingAttempts, 2);
  }
  for (const row of report.cases) {
    assert.ok(CASE_OUTCOMES.includes(row.outcome));
    if (row.outcome === 'unsupported') assert.ok(row.unsupportedReason);
    if (row.unsupportedReason) assert.equal(row.outcome, 'unsupported');
  }
});

test('report verification names the invariant that a doctored report breaks', () => {
  const report = buildBenchmarkReport({
    campaignId: 'edge-cases-67x5', cases: corpusFixture(67), target: 5, maxGenerationAttempts: 12, elapsedHours: 40, mapUniverse: 5,
  });
  assert.deepEqual(verifyBenchmarkReport(report, { expectedEntries: 67 }), []);

  const zeroDenominator = structuredClone(report);
  zeroDenominator.coverage.accepted = { numerator: 3, denominator: 0, value: 0.5, wilson95: null };
  assert.ok(verifyBenchmarkReport(zeroDenominator).some((violation) => /zero denominator/.test(violation)),
    'a rate over nothing must be rejected');

  const missingDenominator = structuredClone(report);
  missingDenominator.quality.acceptedOfSupported = { numerator: 3, value: 0.5 };
  assert.ok(verifyBenchmarkReport(missingDenominator).some((violation) => /without a denominator/.test(violation)));

  const brokenFunnel = structuredClone(report);
  const brokenGate = brokenFunnel.funnel.stages.find((stage) => stage.id === 'gate-pass');
  brokenGate.reached = brokenGate.denominator + 1;
  const funnelViolations = verifyBenchmarkReport(brokenFunnel);
  assert.ok(funnelViolations.some((violation) => /over denominator/.test(violation)));

  const shortCorpus = structuredClone(report);
  shortCorpus.cases.pop();
  assert.ok(verifyBenchmarkReport(shortCorpus, { expectedEntries: 67 })
    .some((violation) => /cases array has 66 rows/.test(violation)));

  const wrongOutcome = structuredClone(report);
  wrongOutcome.cases[0].outcome = 'probably-fine';
  assert.ok(verifyBenchmarkReport(wrongOutcome).some((violation) => /probably-fine/.test(violation)));
});

test('cost aggregation keeps CPU and GPU attribution attached to the numbers', () => {
  const shared = record({ furthest: 'accepted' });
  shared.cost.cpu = { totalS: 300, attribution: 'process-shared', clockTicksPerSecond: 100 };
  shared.cost.gpu = { samples: 6, meanUtilizationPct: 50, gpuSecondsEquivalent: 120, attribution: 'host-wide' };
  const exclusive = record({ furthest: 'accepted' });
  exclusive.cost.cpu = { totalS: 100, attribution: 'exclusive', clockTicksPerSecond: 100 };
  const report = buildBenchmarkReport({
    cases: [{ id: 'c', index: 0, target: 1, acceptedVideos: 1, submittedAttempts: 2, records: [shared, exclusive], videos: [] }],
    target: 1, maxGenerationAttempts: 4, elapsedHours: 1, mapUniverse: 5,
  });
  assert.equal(report.cost.cpu.measuredAttempts, 2);
  assert.equal(report.cost.cpu.totalS.total, 400);
  assert.equal(report.cost.cpu.exclusivelyAttributedAttempts, 1);
  assert.match(report.cost.cpu.attributionNote, /process-shared/);
  assert.equal(report.cost.gpu.measuredAttempts, 1);
  assert.match(report.cost.gpu.attributionNote, /host-wide/);
  assert.equal(report.cost.tokens.dollarCost, null, 'spend is unmeasured, never estimated');
  assert.equal(report.cost.tokens.inputTokens, 2000);
});

// ---------------------------------------------------------------------------
// Token accounting on disk
// ---------------------------------------------------------------------------

test('a historical job\'s vision usage is billed once even when the verdict is copied between artifacts', async (t) => {
  const jobDir = await mkdtemp(join(tmpdir(), 'showcase-usage-'));
  t.after(async () => rm(jobDir, { recursive: true, force: true }));
  await mkdir(join(jobDir, '20-author'), { recursive: true });
  await mkdir(join(jobDir, '60-render2d'), { recursive: true });
  await writeFile(join(jobDir, '20-author', 'transcript.json'), JSON.stringify({
    usage: { calls: 2, input_tokens: 900, output_tokens: 120, reasoning_tokens: 40 }, wallS: 12,
  }));
  const twoDRow = {
    cellId: 'cell-a',
    rawResponseSha256: 'a'.repeat(64),
    _meta: { promptSha256: 'p1', latencyS: 4, tokens: { in: 500, out: 60, reasoning: 10 } },
  };
  await writeFile(join(jobDir, '60-render2d', 'quality.json'), JSON.stringify({ cells: [twoDRow] }));
  // A job recorded before the 3D product review was removed: its `70-judge.json` is still
  // readable evidence and its tokens are still billed, but no new attempt writes one.
  await writeFile(join(jobDir, '70-judge.json'), JSON.stringify({
    cells: [{
      ...twoDRow,
      threeDReview: {
        version: 'showcase-3d-product-review-v4',
        rawResponseSha256: 'b'.repeat(64),
        latencyS: 9,
        tokens: { in: 3000, out: 200, reasoning: 80 },
      },
    }],
  }));
  const usage = await collectJobUsage(jobDir);
  assert.equal(usage.byStage['20-author'].inputTokens, 900);
  assert.equal(usage.byStage['20-author'].modelWallS, 12);
  assert.equal(usage.byStage['60-render2d'].inputTokens, 500, '2D usage billed once, not twice');
  assert.equal(usage.byStage['70-judge'].inputTokens, 3000);
  assert.equal(usage.tokens.inputTokens, 4400);
  assert.equal(usage.tokens.outputTokens, 380);
  assert.equal(usage.tokens.reasoningTokens, 130);
  assert.equal(usage.tokens.modelWallS, 25);
  assert.equal(usage.tokenAccounting.version, 3);
  assert.equal(usage.tokenAccounting.authorEvidenceFiles, 1);
  assert.equal(usage.tokenAccounting.visionVerdicts, 2);
  assert.equal(usage.tokenAccounting.dollarCost, null);
});

test('a historical repair attempt promoted into its parent job is not billed twice', async (t) => {
  const jobDir = await mkdtemp(join(tmpdir(), 'showcase-usage-repair-'));
  t.after(async () => rm(jobDir, { recursive: true, force: true }));
  const review = {
    cellId: 'cell-a',
    rawResponseSha256: 'c'.repeat(64),
    threeDReview: {
      version: 'showcase-3d-product-review-v4',
      rawResponseSha256: 'd'.repeat(64),
      tokens: { in: 2000, out: 100, reasoning: 0 },
      latencyS: 5,
    },
  };
  const transcript = JSON.stringify({ usage: { calls: 1, input_tokens: 400, output_tokens: 30 } });
  await mkdir(join(jobDir, '80-presentation-retry', '20-author'), { recursive: true });
  await mkdir(join(jobDir, '20-author'), { recursive: true });
  await writeFile(join(jobDir, '20-author', 'transcript.json'), transcript);
  await writeFile(join(jobDir, '80-presentation-retry', '20-author', 'transcript.json'), transcript);
  await writeFile(join(jobDir, '70-judge.json'), JSON.stringify({ cells: [review] }));
  await writeFile(join(jobDir, '80-presentation-retry', '70-judge.json'), JSON.stringify({ cells: [review] }));
  const usage = await collectJobUsage(jobDir);
  assert.equal(usage.byStage['20-author'].inputTokens, 400, 'identical transcripts share a content hash');
  assert.equal(usage.byStage['70-judge'].inputTokens, 2000, 'the promoted 3D review is one verdict');
  assert.equal(usage.tokenAccounting.authorEvidenceFiles, 1);
  assert.equal(usage.tokenAccounting.visionVerdicts, 1);
});

test('a job with no evidence reports zero calls rather than failing', async (t) => {
  const jobDir = await mkdtemp(join(tmpdir(), 'showcase-usage-empty-'));
  t.after(async () => rm(jobDir, { recursive: true, force: true }));
  const usage = await collectJobUsage(jobDir);
  assert.deepEqual(usage.tokens, { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, modelWallS: 0 });
  assert.equal(usage.tokenAccounting.visionVerdicts, 0);
  assert.deepEqual(await readFile(join(jobDir, 'missing.json')).catch(() => 'absent'), 'absent');
});
