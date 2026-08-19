import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  backoffDelayMs,
  campaignSettled,
  CAMPAIGN_STATE_VERSION,
  caseStatus,
  DEFAULT_RELIABILITY,
  generationAttempts,
  migrateCampaignState,
  ProviderCircuit,
  recordOperationalFailure,
  resolveCampaignRuntime,
  submissionOrder,
  unproductiveStreak,
  validateCampaignConfig,
} from './campaign.mjs';
import { classifyFailure } from './failures.mjs';
import {
  acceptsCampaignVideo,
  campaignVideoRow,
  PRODUCT_CONTRACT_VERSION,
} from './product-contract.mjs';

const CAMPAIGN_ID = 'edge-cases-67x5';
const STAMP = '2026-08-18T00:00:00.000Z';

function campaignConfig(caseCount, overrides = {}) {
  return {
    id: CAMPAIGN_ID,
    targetValidVideos: 5,
    methodology: 'production',
    cases: Array.from({ length: caseCount }, (_, index) => ({
      id: `case-${String(index + 1).padStart(2, '0')}`,
      title: `Edge case ${index + 1}`,
      ...(overrides[index] ?? {}),
    })),
  };
}

function freshState(caseCount, { overrides = {}, reliability = DEFAULT_RELIABILITY } = {}) {
  return migrateCampaignState(null, { config: campaignConfig(caseCount, overrides), reliability, startedAt: STAMP });
}

function statusOptions({ maxGenerationAttempts = DEFAULT_RELIABILITY.maxGenerationAttempts, nowMs = 0 } = {}) {
  return { targetValidVideos: 5, maxGenerationAttempts, nowMs };
}

function nextNumber(item) {
  return Math.max(0, ...item.attempts.map((attempt) => attempt.number)) + 1;
}

function failGeneration(item, { code = 'job_failed', error = 'batch wrote no summary (1)' } = {}) {
  const number = nextNumber(item);
  item.attempts.push({
    number,
    seed: number,
    status: 'failed',
    jobId: `${item.id}-job-${number}`,
    error,
    failureClass: 'generation',
    failureKind: 'generation',
    failureCode: code,
    outcomeRecordedAt: STAMP,
  });
}

function failOperational(item, { kind = 'provider', code = 'rate_limited' } = {}) {
  const number = nextNumber(item);
  item.attempts.push({
    number,
    seed: number,
    status: 'failed',
    jobId: `${item.id}-job-${number}`,
    error: 'HTTP 429: rate_limit_error',
    failureClass: 'operational',
    failureKind: kind,
    failureCode: code,
    outcomeRecordedAt: STAMP,
  });
  return { kind, code, caseId: item.id, attempt: number, jobId: `${item.id}-job-${number}`, at: STAMP };
}

function completeAttempt(item, acceptedVideos) {
  const number = nextNumber(item);
  item.attempts.push({
    number,
    seed: number,
    status: 'complete',
    jobId: `${item.id}-job-${number}`,
    acceptedVideos,
    outcomeRecordedAt: STAMP,
  });
  for (let index = 0; index < acceptedVideos; index += 1) {
    item.validVideos.push({ sha256: `${item.id}-${number}-${index}`.padEnd(64, '0'), jobId: `${item.id}-job-${number}` });
  }
}

test('breadth-first scheduling gives all 67 cases a first attempt before any case reaches a fifth', () => {
  const reliability = { ...DEFAULT_RELIABILITY, maxGenerationAttempts: 8 };
  const state = freshState(67, { overrides: { 0: { priority: 90 }, 5: { priority: 100 } }, reliability });
  const options = statusOptions({ maxGenerationAttempts: 8 });
  const order = [];
  for (let step = 0; step < 67 * 5; step += 1) {
    const item = submissionOrder(state, options)[0];
    assert.ok(item, `a schedulable case existed at step ${step}`);
    order.push(item.id);
    failGeneration(item);
  }

  assert.equal(new Set(order.slice(0, 67)).size, 67, 'the first 67 submissions covered every case exactly once');
  assert.deepEqual(order.slice(0, 2), ['case-06', 'case-01'], 'priority breaks ties inside the first depth band');
  const fifthAttempt = order.findIndex((id, index) => order.slice(0, index).filter((value) => value === id).length === 4);
  assert.equal(fifthAttempt, 67 * 4, 'no case took a fifth attempt until every case had four');
  assert.deepEqual([...new Set(state.cases.map(generationAttempts))], [5]);
});

test('the configurable per-case cap retires a case as exhausted and settles the campaign', () => {
  const state = freshState(3);
  const options = statusOptions();
  while (submissionOrder(state, options).length > 0) failGeneration(submissionOrder(state, options)[0]);

  assert.deepEqual(state.cases.map(generationAttempts), [4, 4, 4]);
  assert.deepEqual(state.cases.map((item) => caseStatus(item, options)), ['exhausted', 'exhausted', 'exhausted']);
  assert.equal(campaignSettled(state, options), true);

  const raised = statusOptions({ maxGenerationAttempts: 6 });
  assert.equal(campaignSettled(state, raised), false, 'raising the cap reopens retired cases');
  assert.equal(submissionOrder(state, raised).length, 3);
});

test('an accepted video resets the unproductive streak so productive cases keep earning depth', () => {
  const state = freshState(1);
  const [item] = state.cases;
  const options = statusOptions();
  for (let index = 0; index < 3; index += 1) failGeneration(item);
  completeAttempt(item, 1);
  for (let index = 0; index < 3; index += 1) failGeneration(item);

  assert.equal(unproductiveStreak(item), 3);
  assert.equal(generationAttempts(item), 7);
  assert.equal(caseStatus(item, options), 'pending', 'a case that produced video keeps its budget');

  failGeneration(item);
  assert.equal(caseStatus(item, options), 'exhausted');

  completeAttempt(item, 4);
  assert.equal(caseStatus(item, options), 'complete', 'reaching the per-case target outranks exhaustion');
});

test('one hundred provider failures add zero generation attempts', () => {
  const state = freshState(2);
  const [item] = state.cases;
  const options = statusOptions();
  for (let index = 0; index < 100; index += 1) {
    const entry = failOperational(item, index % 2 === 0 ? { kind: 'provider', code: 'rate_limited' } : { kind: 'gateway', code: 'gateway_unreachable' });
    recordOperationalFailure(state.operationalFailures, entry, 24);
    recordOperationalFailure(item.operationalFailures, entry, 8);
  }

  assert.equal(item.attempts.length, 100, 'operational failures stay on the record as evidence');
  assert.equal(generationAttempts(item), 0, 'and consume no generation attempt');
  assert.equal(unproductiveStreak(item), 0);
  assert.equal(caseStatus(item, options), 'pending', 'the case is never exhausted by infrastructure');
  assert.equal(item.operationalFailures.total, 100);
  assert.equal(item.operationalFailures.consecutive, 100);
  assert.deepEqual(item.operationalFailures.byKind, { provider: 50, gateway: 50, 'model-access': 0, vision: 0 });
  assert.equal(item.operationalFailures.recent.length, 8, 'the per-case sample stays bounded');
  assert.equal(state.operationalFailures.total, 100);
  assert.equal(state.operationalFailures.recent.length, 24);

  failGeneration(item);
  assert.equal(generationAttempts(item), 1, 'a real generation failure still spends budget');
});

test('an unavailable provider cannot flood the queue and recovers through a single probe trial', () => {
  const tunables = { failureThreshold: 3, baseDelayMs: 30_000, maxDelayMs: 900_000, probeMaxAgeMs: 1_800_000, trialTimeoutMs: 3_600_000 };
  const heartbeats = 200;
  const intervalMs = 30_000;
  const drive = (probeOk) => {
    const circuit = new ProviderCircuit(tunables);
    let clock = Date.parse(STAMP);
    let submissions = 0;
    for (let beat = 0; beat < heartbeats; beat += 1) {
      if (circuit.probeDue(clock)) circuit.recordProbe(probeOk, { atMs: clock, detail: 'vision preflight failed' });
      if (circuit.allowSubmission(clock).allowed) {
        submissions += 1;
        circuit.noteSubmission({ caseId: 'case-01', number: submissions, jobId: `job-${submissions}`, atMs: clock });
        circuit.recordFailure({ kind: 'provider', code: 'rate_limited', atMs: clock });
      }
      clock += intervalMs;
    }
    return { submissions, circuit };
  };

  const jobsFail = drive(true);
  assert.equal(jobsFail.circuit.state, 'open');
  assert.equal(jobsFail.submissions, 13, `${heartbeats} heartbeats against a broken provider submitted 13 jobs, not ${heartbeats}`);

  const preflightFails = drive(false);
  assert.equal(preflightFails.submissions, 0, 'a failing vision preflight admits no jobs at all');
  assert.equal(preflightFails.circuit.state, 'open');

  const circuit = jobsFail.circuit;
  const recoveredAt = Date.parse(STAMP) + heartbeats * intervalMs;
  circuit.recordProbe(true, { atMs: recoveredAt });
  assert.equal(circuit.state, 'probe');
  const trial = circuit.allowSubmission(recoveredAt);
  assert.deepEqual([trial.allowed, trial.limit], [true, 1], 'a passing probe releases exactly one trial job');
  circuit.noteSubmission({ caseId: 'case-02', number: 1, jobId: 'trial-job', atMs: recoveredAt });
  assert.equal(circuit.allowSubmission(recoveredAt).allowed, false, 'a second job waits for the trial verdict');
  circuit.recordSuccess(recoveredAt);
  assert.equal(circuit.state, 'closed');
  assert.equal(circuit.allowSubmission(recoveredAt).allowed, true);
});

test('provider recovery and generation depth survive a runner restart', () => {
  const config = campaignConfig(3);
  const state = freshState(3);
  const [item] = state.cases;
  const circuit = new ProviderCircuit({
    failureThreshold: DEFAULT_RELIABILITY.providerFailureThreshold,
    baseDelayMs: DEFAULT_RELIABILITY.retryBackoffMs,
    maxDelayMs: DEFAULT_RELIABILITY.maxRetryBackoffMs,
  });
  const failedAt = Date.parse(STAMP);
  failGeneration(state.cases[1]);
  for (let index = 0; index < 3; index += 1) {
    const entry = failOperational(item, { kind: 'model-access', code: 'usage_limit' });
    recordOperationalFailure(state.operationalFailures, entry, 24);
    recordOperationalFailure(item.operationalFailures, entry, 8);
    circuit.recordFailure({ kind: entry.kind, code: entry.code, atMs: failedAt });
  }
  state.provider = circuit.toJSON();
  assert.equal(state.provider.state, 'open');

  const restarted = migrateCampaignState(JSON.parse(JSON.stringify(state)), { config, reliability: DEFAULT_RELIABILITY, startedAt: '2026-08-18T06:00:00.000Z' });
  const restoredCircuit = new ProviderCircuit({ snapshot: restarted.provider });

  assert.equal(restarted.startedAt, STAMP, 'the campaign clock is not reset by a restart');
  assert.equal(restoredCircuit.state, 'open');
  assert.equal(restoredCircuit.nextProbeAt, circuit.nextProbeAt);
  assert.equal(restoredCircuit.openCycles, circuit.openCycles);
  assert.equal(restoredCircuit.lastCode, 'usage_limit');
  assert.equal(restoredCircuit.allowSubmission(failedAt).allowed, false);
  assert.equal(restarted.cases[0].operationalFailures.total, 3);
  assert.equal(restarted.cases[0].operationalFailures.consecutive, 3);
  assert.equal(generationAttempts(restarted.cases[0]), 0);
  assert.equal(generationAttempts(restarted.cases[1]), 1);
  assert.equal(restarted.migration.reclassifiedAttempts, 0, 'already-typed attempts are not reclassified');

  const probedAt = Date.parse(restoredCircuit.nextProbeAt);
  assert.equal(restoredCircuit.probeDue(probedAt), true, 'the probe schedule resumes where it stopped');
  restoredCircuit.recordProbe(true, { atMs: probedAt });
  assert.equal(restoredCircuit.allowSubmission(probedAt).allowed, true);
});

test('state migration preserves accepted hashes and refunds legacy operational failures', () => {
  const config = campaignConfig(3, { 0: { priority: 90 } });
  const validVideos = [
    {
      sha256: 'a'.repeat(64),
      jobId: 'job-1',
      cellId: 'yale-street-site-0-0',
      url: `/artifacts/campaigns/${CAMPAIGN_ID}/videos/case-01/${'a'.repeat(64)}.mp4`,
      semanticAccepted: true,
      accepted: true,
      productContractVersion: PRODUCT_CONTRACT_VERSION,
      acceptedAt: STAMP,
    },
    {
      sha256: 'b'.repeat(64),
      jobId: 'job-1',
      cellId: 'yale-street-site-0-1',
      url: `/artifacts/campaigns/${CAMPAIGN_ID}/videos/case-01/${'b'.repeat(64)}.mp4`,
      semanticAccepted: true,
      accepted: true,
      productContractVersion: PRODUCT_CONTRACT_VERSION,
      acceptedAt: STAMP,
    },
  ];
  const saved = {
    version: 2,
    campaignId: CAMPAIGN_ID,
    targetValidVideos: 5,
    methodology: 'production',
    startedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: STAMP,
    heartbeatAt: STAMP,
    heartbeatSequence: 42,
    nextCaseIndex: 7,
    lastSubmissionAt: STAMP,
    cases: [
      {
        id: 'case-01',
        title: 'Edge case 1',
        index: 0,
        priority: 90,
        attempts: [
          { number: 1, seed: 11, status: 'complete', jobId: 'job-1', acceptedVideos: 2, finishedAt: STAMP },
          { number: 2, seed: 12, status: 'failed', jobId: 'job-2', error: 'HTTP 429: rate_limit_error', finishedAt: STAMP },
          { number: 3, seed: 13, status: 'failed', jobId: 'job-3', error: 'authored template violated semantic contract: ["collision_free"]', finishedAt: STAMP },
        ],
        validVideos: structuredClone(validVideos),
      },
      { id: 'case-02', title: 'Edge case 2', index: 1, attempts: [], validVideos: [] },
    ],
  };

  const migrated = migrateCampaignState(structuredClone(saved), { config, reliability: DEFAULT_RELIABILITY, startedAt: STAMP });

  assert.equal(migrated.version, CAMPAIGN_STATE_VERSION);
  assert.equal(migrated.migration.fromVersion, 2);
  assert.equal(migrated.migration.migratedAt, STAMP);
  assert.deepEqual(migrated.migration.droppedFields, ['nextCaseIndex']);
  assert.equal(migrated.nextCaseIndex, undefined);
  assert.equal(migrated.startedAt, saved.startedAt);
  assert.equal(migrated.heartbeatSequence, 42);
  assert.deepEqual(migrated.cases[0].validVideos, validVideos, 'accepted video hashes and urls carry over verbatim');
  assert.equal(migrated.cases.length, 3, 'a case added to the config joins the campaign');
  assert.deepEqual(migrated.cases[2].validVideos, []);

  const [complete, rateLimited, contractViolation] = migrated.cases[0].attempts;
  assert.equal(complete.failureClass, undefined);
  assert.equal(rateLimited.failureClass, 'operational');
  assert.equal(rateLimited.failureKind, 'provider');
  assert.equal(rateLimited.failureCode, 'rate_limited');
  assert.equal(contractViolation.failureClass, 'generation');
  assert.equal(contractViolation.failureCode, 'contract_violation');
  assert.equal(generationAttempts(migrated.cases[0]), 2, 'the rate-limited attempt is refunded');
  assert.equal(unproductiveStreak(migrated.cases[0]), 1);
  assert.equal(migrated.cases[0].operationalFailures.total, 1);
  assert.equal(migrated.cases[0].operationalFailures.byKind.provider, 1);
  assert.equal(migrated.cases[0].operationalFailures.consecutive, 0, 'the trailing failure is a generation defect');
  assert.equal(migrated.operationalFailures.total, 1);
  assert.equal(migrated.migration.reclassifiedAttempts, 3);
  assert.equal(migrated.provider.state, 'closed');

  const reloaded = migrateCampaignState(JSON.parse(JSON.stringify(migrated)), { config, reliability: DEFAULT_RELIABILITY, startedAt: STAMP });
  assert.equal(reloaded.migration.fromVersion, CAMPAIGN_STATE_VERSION);
  assert.equal(reloaded.migration.reclassifiedAttempts, 0, 'migration is idempotent');
  assert.deepEqual(reloaded.cases[0].attempts, migrated.cases[0].attempts);
  assert.deepEqual(reloaded.cases[0].operationalFailures, migrated.cases[0].operationalFailures);

  assert.throws(
    () => migrateCampaignState({ ...migrated, version: CAMPAIGN_STATE_VERSION + 1 }, { config, reliability: DEFAULT_RELIABILITY }),
    /newer than this runner/,
  );

  const otherCampaign = migrateCampaignState({ ...saved, campaignId: 'other-campaign' }, { config, reliability: DEFAULT_RELIABILITY, startedAt: STAMP });
  assert.deepEqual(otherCampaign.cases.map((item) => item.validVideos.length), [0, 0, 0], 'state from another campaign is never adopted');
});

test('campaign collection requires an accepted cell under the current product contract', () => {
  const decision = {
    schema: 'uniscenarios.showcase-product-decision.v2',
    contract: { version: PRODUCT_CONTRACT_VERSION },
    cells: [
      {
        cellId: 'cell-1',
        renderDir: '65-render3d/cell-1',
        semanticAccepted: true,
        accepted: true,
        defectCodes: [],
        unsupportedReason: null,
      },
      {
        cellId: 'cell-2',
        renderDir: null,
        semanticAccepted: true,
        accepted: false,
        defectCodes: ['render.camera.composition_failed'],
        unsupportedReason: null,
      },
      {
        cellId: 'cell-3',
        renderDir: '65-render3d/cell-3',
        semanticAccepted: false,
        accepted: false,
        defectCodes: [],
        unsupportedReason: 'never screened by the 2D semantic oracle',
      },
    ],
  };
  assert.equal(acceptsCampaignVideo(decision, decision.cells[0]), true);
  assert.equal(acceptsCampaignVideo(decision, decision.cells[1]), false,
    'a semantic match with no completed render yields no deliverable video');
  assert.equal(acceptsCampaignVideo(decision, decision.cells[2]), false,
    'a cell the oracle never screened is never a result');
  assert.equal(campaignVideoRow(decision, 'cell-1').cellId, 'cell-1');

  const superseded = { ...decision, contract: { version: 'showcase-acceptance-contract-v1' } };
  assert.equal(campaignVideoRow(superseded, 'cell-1'), null,
    'a decision from the retired acceptance split is not a result');

  // A `70-judge.json` verdict is exactly what the campaign used to collect. It carries no product
  // contract version at all, so it can never read as current.
  const historical = {
    productReviewVersion: 'showcase-3d-product-review-v4',
    cells: [{ cellId: 'cell-1', productAccepted: true, presentationAccepted: true }],
  };
  assert.equal(campaignVideoRow(historical, 'cell-1'), null,
    'a historical judge verdict is never collected under the deterministic contract');
});

test('an unsupported case is retired instead of retried', () => {
  const reason = 'no reversible lane exists in the five-map catalog';
  const state = freshState(3, { overrides: { 1: { unsupportedReason: reason } } });
  const options = statusOptions();

  assert.equal(state.cases[1].unsupportedReason, reason);
  assert.equal(state.cases[1].unsupportedAt, STAMP);
  assert.equal(caseStatus(state.cases[1], options), 'unsupported');
  assert.deepEqual(submissionOrder(state, options).map((item) => item.id), ['case-01', 'case-03']);
  assert.equal(campaignSettled(state, options), false);
  for (const item of [state.cases[0], state.cases[2]]) {
    for (let index = 0; index < 4; index += 1) failGeneration(item);
  }
  assert.equal(campaignSettled(state, options), true, 'unsupported cases do not stall the campaign forever');
});

test('bounded exponential backoff paces retries without exceeding its ceiling', () => {
  const bounds = { baseMs: 30_000, maxMs: 900_000 };
  assert.equal(backoffDelayMs(0, bounds), 0);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((failures) => backoffDelayMs(failures, bounds)),
    [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  assert.equal(backoffDelayMs(4096, bounds), 900_000, 'a long outage cannot overflow the delay');

  const state = freshState(2);
  const [waiting, ready] = state.cases;
  const nowMs = Date.parse(STAMP);
  waiting.nextAttemptAt = new Date(nowMs + backoffDelayMs(2, bounds)).toISOString();
  assert.equal(caseStatus(waiting, { ...statusOptions(), nowMs }), 'waiting');
  assert.deepEqual(submissionOrder(state, { ...statusOptions(), nowMs }).map((item) => item.id), [ready.id]);
  assert.equal(caseStatus(waiting, { ...statusOptions(), nowMs: nowMs + 60_001 }), 'pending');
});

test('typed classification separates operational failures from generation defects', () => {
  const kindOf = (value) => {
    const failure = classifyFailure(value);
    return [failure.operational, failure.kind, failure.code];
  };
  assert.deepEqual(kindOf('HTTP 401: No credential available for provider openai-codex'), [true, 'model-access', 'no_credential']);
  assert.deepEqual(kindOf({ error: 'HTTP 429: rate_limit_error' }), [true, 'provider', 'rate_limited']);
  assert.deepEqual(kindOf('model access unavailable during 3D review: {"accepted":false}'), [true, 'vision', 'vision_review_unavailable']);
  assert.deepEqual(kindOf('vision preflight failed: gateway returned 500'), [true, 'vision', 'vision_preflight_failed']);
  assert.deepEqual(kindOf(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), [true, 'gateway', 'gateway_unreachable']);
  assert.deepEqual(kindOf(Object.assign(new Error('submit case-01 failed 503: upstream'), { httpStatus: 503 })), [true, 'provider', 'provider_unavailable']);
  assert.deepEqual(kindOf('no matching sites for authored template'), [false, 'generation', 'no_matching_sites']);
  assert.deepEqual(kindOf({ accepted: false, defects: ['frozen_actor'] }), [false, 'generation', 'job_failed']);
  assert.deepEqual(classifyFailure({ accepted: false, defects: ['frozen_actor'] }).defectCodes, ['frozen_actor']);

  const declaredOperational = classifyFailure({ error: 'renderer wrote no mp4', operational: true, failureKind: 'gateway', code: 'renderer_host_lost' });
  assert.deepEqual([declaredOperational.operational, declaredOperational.kind, declaredOperational.code], [true, 'gateway', 'renderer_host_lost']);
  const declaredUnsupported = classifyFailure({ error: 'no reversible lane', unsupportedReason: 'no reversible lane in the catalog' });
  assert.deepEqual([declaredUnsupported.operational, declaredUnsupported.kind, declaredUnsupported.unsupportedReason],
    [false, 'unsupported', 'no reversible lane in the catalog']);
});

test('reliability settings are configurable through config, environment, and flags', () => {
  const hardware = { logicalCpus: 8 };
  const base = campaignConfig(1);
  assert.equal(resolveCampaignRuntime({ config: base, hardware }).reliability.maxGenerationAttempts, 4);
  assert.equal(
    resolveCampaignRuntime({ config: { ...base, runtime: { maxGenerationAttempts: 9 } }, hardware }).reliability.maxGenerationAttempts,
    9,
  );
  assert.equal(
    resolveCampaignRuntime({ config: base, env: { SHOWCASE_CAMPAIGN_MAX_ATTEMPTS: '7' }, hardware }).reliability.maxGenerationAttempts,
    7,
  );
  assert.equal(
    resolveCampaignRuntime({
      config: { ...base, runtime: { maxGenerationAttempts: 9 } },
      args: new Map([['max-attempts', '12']]),
      env: { SHOWCASE_CAMPAIGN_MAX_ATTEMPTS: '7' },
      hardware,
    }).reliability.maxGenerationAttempts,
    12,
  );
  assert.throws(
    () => resolveCampaignRuntime({ config: base, args: new Map([['max-attempts', '0']]), hardware }),
    /campaign max-attempts must be an integer from 1 through 64/,
  );
  assert.throws(
    () => resolveCampaignRuntime({ config: { ...base, runtime: { providerFailureThreshold: 99 } }, hardware }),
    /campaign provider-failure-threshold must be an integer from 1 through 16/,
  );
});

test('the shipped 67-case campaign config schedules every case on a fresh run', async () => {
  const config = validateCampaignConfig(JSON.parse(await readFile(new URL('../campaigns/edge-cases.json', import.meta.url), 'utf8')));
  assert.equal(config.id, CAMPAIGN_ID);
  assert.equal(config.cases.length, 67);
  assert.equal(config.targetValidVideos, 5);

  const settings = resolveCampaignRuntime({ config, hardware: { logicalCpus: 8 } });
  assert.deepEqual(settings.reliability, {
    maxGenerationAttempts: 4,
    providerFailureThreshold: 3,
    retryBackoffMs: 30_000,
    maxRetryBackoffMs: 900_000,
    providerProbeMaxAgeMs: 1_800_000,
    providerTrialTimeoutMs: 3_600_000,
  });

  const state = migrateCampaignState(null, { config, reliability: settings.reliability, startedAt: STAMP });
  const options = statusOptions({ maxGenerationAttempts: settings.reliability.maxGenerationAttempts });
  assert.equal(submissionOrder(state, options).length, 67);
  assert.equal(state.cases.filter((item) => item.priority > 0).length, 2);
  assert.equal(submissionOrder(state, options)[0].priority, 100);
});
