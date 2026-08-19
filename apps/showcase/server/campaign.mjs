#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { availableParallelism, freemem, hostname, loadavg, totalmem } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  ATTEMPT_RECORD_SCHEMA,
  buildBenchmarkReport,
  deterministicUnsupportedReason,
  perHour,
  verifyBenchmarkReport,
} from './benchmark.mjs';
import {
  acceptsCampaignVideo,
  campaignVideoRow,
  isCurrentAcceptance,
  PRODUCT_CONTRACT_VERSION,
} from './product-contract.mjs';

import { classifyFailure, normalizeUnsupportedReason, OPERATIONAL_FAILURE_KINDS, truncateDetail } from './failures.mjs';
import { MAPS, collectJobUsage, emptyUsage } from './pipeline.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const execFileAsync = promisify(execFile);

export const CAMPAIGN_STATE_VERSION = 3;
/** The deterministic product decision the campaign consumes for acceptance. */
export const CANONICAL_DECISION_FIELDS = Object.freeze(['semanticAccepted', 'accepted', 'defectCodes', 'unsupportedReason']);
export const CIRCUIT_STATES = Object.freeze(['closed', 'open', 'probe']);
export const SETTLED_CASE_STATUSES = Object.freeze(['complete', 'unsupported', 'exhausted']);
export const DEFAULT_RELIABILITY = Object.freeze({
  /** Consecutive unproductive generation attempts a single case may spend before it is retired. */
  maxGenerationAttempts: 4,
  /** Consecutive operational failures that open the provider circuit. */
  providerFailureThreshold: 3,
  retryBackoffMs: 30_000,
  maxRetryBackoffMs: 900_000,
  /** Re-verify a healthy provider at most this stale, and probe an open circuit on the backoff schedule. */
  providerProbeMaxAgeMs: 1_800_000,
  /** A probe trial job that never settles must not wedge the campaign forever. */
  providerTrialTimeoutMs: 3_600_000,
});

const now = () => new Date().toISOString();
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const exists = async (path) => stat(path).then(() => true, () => false);
const nonemptyFile = async (path) => stat(path).then((value) => value.isFile() && value.size > 0, () => false);
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const counter = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : 0);
const timestamp = (value) => (typeof value === 'string' && value ? value : null);

export const isActive = (attempt) => ['submitting', 'queued', 'running'].includes(attempt.status);
const dateMs = (value, fallback = Date.now()) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, value);
  await rename(temporary, path);
}
async function atomicJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const args = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    args.set(key.slice(2), value?.startsWith('--') ? true : value ?? true);
    if (value && !value.startsWith('--')) index += 1;
  }
  return args;
}

export function validateCampaignConfig(config) {
  if (typeof config?.id !== 'string' || !config.id || !Array.isArray(config.cases) || config.cases.length === 0) {
    throw new Error('campaign config requires a non-empty id and cases array');
  }
  if (!Number.isInteger(config.targetValidVideos) || config.targetValidVideos < 1) {
    throw new Error('campaign targetValidVideos must be a positive integer');
  }
  const caseIds = config.cases.map((item) => item.id);
  if (caseIds.some((id) => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) || new Set(caseIds).size !== caseIds.length) {
    throw new Error('campaign case ids must be unique lowercase slugs');
  }
  return config;
}

/** Bounded exponential backoff shared by the provider circuit and per-case retry pacing. */
export function backoffDelayMs(failures, { baseMs, maxMs } = {}) {
  const count = counter(failures);
  if (count <= 0) return 0;
  const base = Math.max(0, Number(baseMs) || 0);
  const ceiling = Math.max(base, Number(maxMs) || 0);
  const raw = base * 2 ** (count - 1);
  return Math.round(Math.min(ceiling, Number.isFinite(raw) ? raw : ceiling));
}

export function emptyOperationalLedger() {
  const byKind = {};
  for (const kind of OPERATIONAL_FAILURE_KINDS) byKind[kind] = 0;
  return { total: 0, consecutive: 0, byKind, lastAt: null, lastKind: null, lastCode: null, lastDetail: null, recent: [] };
}

export function normalizeOperationalLedger(value) {
  const ledger = emptyOperationalLedger();
  if (!value || typeof value !== 'object') return ledger;
  ledger.total = counter(value.total);
  ledger.consecutive = counter(value.consecutive);
  for (const kind of OPERATIONAL_FAILURE_KINDS) ledger.byKind[kind] = counter(value.byKind?.[kind]);
  ledger.lastAt = timestamp(value.lastAt);
  ledger.lastKind = OPERATIONAL_FAILURE_KINDS.includes(value.lastKind) ? value.lastKind : null;
  ledger.lastCode = typeof value.lastCode === 'string' ? value.lastCode : null;
  ledger.lastDetail = truncateDetail(value.lastDetail);
  ledger.recent = Array.isArray(value.recent) ? value.recent.filter((entry) => entry && typeof entry === 'object').slice(-24) : [];
  return ledger;
}

/** Operational failures are counted here and nowhere else; they never reach the generation ledger. */
export function recordOperationalFailure(ledger, entry, recentLimit = 8) {
  const kind = OPERATIONAL_FAILURE_KINDS.includes(entry.kind) ? entry.kind : 'provider';
  ledger.total += 1;
  ledger.consecutive += 1;
  ledger.byKind[kind] += 1;
  ledger.lastAt = entry.at ?? now();
  ledger.lastKind = kind;
  ledger.lastCode = typeof entry.code === 'string' ? entry.code : null;
  ledger.lastDetail = truncateDetail(entry.detail);
  ledger.recent.push({
    at: ledger.lastAt,
    kind,
    code: ledger.lastCode,
    caseId: entry.caseId ?? null,
    attempt: Number.isInteger(entry.attempt) ? entry.attempt : null,
    jobId: entry.jobId ?? null,
    detail: ledger.lastDetail,
  });
  if (ledger.recent.length > recentLimit) ledger.recent.splice(0, ledger.recent.length - recentLimit);
  return ledger;
}

export const isOperationalAttempt = (attempt) => attempt?.failureClass === 'operational';
export const acceptedByAttempt = (attempt) => counter(attempt?.acceptedVideos);

/** Scheduling depth: attempts that actually spent generation budget. */
export function generationAttempts(item) {
  return item.attempts.filter((attempt) => !isOperationalAttempt(attempt)).length;
}

/** Consecutive settled generation attempts that produced no accepted video. */
export function unproductiveStreak(item) {
  let streak = 0;
  for (let index = item.attempts.length - 1; index >= 0; index -= 1) {
    const attempt = item.attempts[index];
    if (isOperationalAttempt(attempt) || isActive(attempt)) continue;
    if (acceptedByAttempt(attempt) > 0) break;
    streak += 1;
  }
  return streak;
}

export function caseStatus(item, { targetValidVideos, maxGenerationAttempts, nowMs = Date.now() }) {
  if (normalizeUnsupportedReason(item.unsupportedReason)) return 'unsupported';
  if (item.validVideos.length >= targetValidVideos) return 'complete';
  if (item.attempts.some(isActive)) return 'active';
  if (unproductiveStreak(item) >= maxGenerationAttempts) return 'exhausted';
  if (dateMs(item.nextAttemptAt, 0) > nowMs) return 'waiting';
  return 'pending';
}

export function campaignSettled(state, options) {
  return state.cases.every((item) => SETTLED_CASE_STATUSES.includes(caseStatus(item, options)));
}

/**
 * Breadth-first round-robin: every schedulable case at the shallowest generation depth is
 * served before any deeper case, so a first attempt reaches all cases before any case takes
 * a second. Priority only breaks ties between cases of equal depth, and the case index
 * breaks the remaining ties, which rotates deterministically through each depth band.
 */
export function submissionOrder(state, options) {
  return state.cases
    .filter((item) => caseStatus(item, options) === 'pending')
    .sort((left, right) => generationAttempts(left) - generationAttempts(right)
      || (right.priority ?? 0) - (left.priority ?? 0)
      || left.index - right.index);
}

/**
 * Provider circuit breaker with probe recovery.
 *
 * closed: submissions flow. `providerFailureThreshold` consecutive operational failures open it.
 * open:   no submissions. A vision preflight probe runs on a bounded exponential schedule.
 * probe:  a passing probe releases exactly one trial job; the trial's outcome closes or reopens.
 */
export class ProviderCircuit {
  constructor({
    failureThreshold = DEFAULT_RELIABILITY.providerFailureThreshold,
    baseDelayMs = DEFAULT_RELIABILITY.retryBackoffMs,
    maxDelayMs = DEFAULT_RELIABILITY.maxRetryBackoffMs,
    probeMaxAgeMs = DEFAULT_RELIABILITY.providerProbeMaxAgeMs,
    trialTimeoutMs = DEFAULT_RELIABILITY.providerTrialTimeoutMs,
    snapshot = null,
  } = {}) {
    this.failureThreshold = Math.max(1, counter(failureThreshold) || 1);
    this.baseDelayMs = Math.max(0, Number(baseDelayMs) || 0);
    this.maxDelayMs = Math.max(this.baseDelayMs, Number(maxDelayMs) || 0);
    this.probeMaxAgeMs = Math.max(0, Number(probeMaxAgeMs) || 0);
    this.trialTimeoutMs = Math.max(0, Number(trialTimeoutMs) || 0);
    const saved = snapshot && typeof snapshot === 'object' ? snapshot : {};
    this.state = CIRCUIT_STATES.includes(saved.state) ? saved.state : 'closed';
    this.consecutiveFailures = counter(saved.consecutiveFailures);
    this.openCycles = counter(saved.openCycles);
    this.openedAt = timestamp(saved.openedAt);
    this.nextProbeAt = timestamp(saved.nextProbeAt);
    this.lastProbeAt = timestamp(saved.lastProbeAt);
    this.lastFailureAt = timestamp(saved.lastFailureAt);
    this.lastSuccessAt = timestamp(saved.lastSuccessAt);
    this.lastKind = OPERATIONAL_FAILURE_KINDS.includes(saved.lastKind) ? saved.lastKind : null;
    this.lastCode = typeof saved.lastCode === 'string' ? saved.lastCode : null;
    this.lastDetail = truncateDetail(saved.lastDetail);
    this.trial = saved.trial && typeof saved.trial === 'object'
      ? { caseId: saved.trial.caseId ?? null, number: counter(saved.trial.number) || null, jobId: saved.trial.jobId ?? null, at: timestamp(saved.trial.at) }
      : null;
  }

  toJSON() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      failureThreshold: this.failureThreshold,
      openCycles: this.openCycles,
      openedAt: this.openedAt,
      nextProbeAt: this.nextProbeAt,
      lastProbeAt: this.lastProbeAt,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      lastKind: this.lastKind,
      lastCode: this.lastCode,
      lastDetail: this.lastDetail,
      trial: this.trial,
    };
  }

  allowSubmission(nowMs = Date.now()) {
    if (this.state === 'closed') return { allowed: true, state: this.state, limit: null, reason: null };
    if (this.state === 'open') {
      return { allowed: false, state: this.state, limit: 0, reason: `provider circuit open until ${this.nextProbeAt ?? 'the next probe'} after ${this.lastCode ?? 'an operational failure'}` };
    }
    if (this.trial && dateMs(this.trial.at, 0) + this.trialTimeoutMs > nowMs) {
      return { allowed: false, state: this.state, limit: 0, reason: `provider circuit is probing recovery with ${this.trial.caseId} attempt ${this.trial.number}` };
    }
    return { allowed: true, state: this.state, limit: 1, reason: null };
  }

  noteSubmission({ caseId, number, jobId, atMs = Date.now() }) {
    if (this.state !== 'probe') return;
    this.trial = { caseId, number, jobId, at: iso(atMs) };
  }

  /** An operational failure. Below the threshold it only counts; a failed trial always reopens. */
  recordFailure({ kind, code, detail, atMs = Date.now() }) {
    this.consecutiveFailures += 1;
    this.lastFailureAt = iso(atMs);
    this.lastKind = OPERATIONAL_FAILURE_KINDS.includes(kind) ? kind : 'provider';
    this.lastCode = typeof code === 'string' ? code : null;
    this.lastDetail = truncateDetail(detail);
    if (this.state === 'probe' || this.consecutiveFailures >= this.failureThreshold) this.#open(atMs);
  }

  /** Any settled job proves the provider answered, whatever the scenario verdict was. */
  recordSuccess(atMs = Date.now()) {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.openCycles = 0;
    this.openedAt = null;
    this.nextProbeAt = null;
    this.trial = null;
    this.lastSuccessAt = iso(atMs);
  }

  recordProbe(ok, { atMs = Date.now(), detail, kind = 'vision', code = 'vision_preflight_failed' } = {}) {
    this.lastProbeAt = iso(atMs);
    if (!ok) {
      this.lastFailureAt = this.lastProbeAt;
      this.lastKind = OPERATIONAL_FAILURE_KINDS.includes(kind) ? kind : 'vision';
      this.lastCode = code;
      this.lastDetail = truncateDetail(detail) ?? this.lastDetail;
      this.#open(atMs);
      return;
    }
    this.consecutiveFailures = 0;
    if (this.state === 'open') {
      this.state = 'probe';
      this.trial = null;
      this.nextProbeAt = null;
    }
  }

  probeDue(nowMs = Date.now()) {
    if (this.state === 'open') return dateMs(this.nextProbeAt, 0) <= nowMs;
    if (this.state === 'probe') return false;
    return this.lastProbeAt == null || nowMs - dateMs(this.lastProbeAt, 0) >= this.probeMaxAgeMs;
  }

  #open(atMs) {
    this.openCycles += 1;
    this.state = 'open';
    this.openedAt = iso(atMs);
    this.trial = null;
    this.nextProbeAt = iso(atMs + backoffDelayMs(this.openCycles, { baseMs: this.baseDelayMs, maxMs: this.maxDelayMs }));
  }
}

function normalizeAttempt(attempt) {
  const status = isActive(attempt) || ['complete', 'failed'].includes(attempt.status) ? attempt.status : 'failed';
  const value = { ...attempt, number: Number(attempt.number), status };
  if (isActive(value)) {
    delete value.failureClass;
    delete value.failureKind;
    delete value.failureCode;
    delete value.outcomeRecordedAt;
    return value;
  }
  if (value.outcomeRecordedAt != null) return value;
  // A settled attempt saved before typed classification is classified once, from its own evidence.
  if (status === 'failed') {
    const failure = classifyFailure(value.error ?? 'job failed');
    value.failureClass = failure.operational ? 'operational' : 'generation';
    value.failureKind = failure.kind;
    value.failureCode = failure.code;
    if (failure.defectCodes.length) value.defectCodes = [...failure.defectCodes];
  }
  value.outcomeRecordedAt = timestamp(value.finishedAt) ?? now();
  return value;
}

function normalizeAttempts(attempts) {
  const unique = new Map();
  for (const raw of attempts) {
    const attempt = normalizeAttempt(raw);
    if (!Number.isInteger(attempt.number) || attempt.number < 1) continue;
    const key = attempt.jobId ? `job:${attempt.jobId}` : `number:${attempt.number}`;
    if (unique.has(key)) Object.assign(unique.get(key), attempt);
    else unique.set(key, attempt);
  }
  return [...unique.values()];
}

function ledgerFromAttempts(attempts) {
  const ledger = emptyOperationalLedger();
  for (const attempt of attempts) {
    if (!isOperationalAttempt(attempt)) continue;
    recordOperationalFailure(ledger, {
      kind: attempt.failureKind,
      code: attempt.failureCode,
      detail: attempt.error,
      at: attempt.outcomeRecordedAt ?? attempt.finishedAt ?? null,
      attempt: attempt.number,
      jobId: attempt.jobId ?? null,
    });
  }
  let consecutive = 0;
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (isActive(attempt)) continue;
    if (!isOperationalAttempt(attempt)) break;
    consecutive += 1;
  }
  ledger.consecutive = consecutive;
  return ledger;
}

/**
 * Explicit state migration to version 3.
 *
 * Accepted videos are carried over verbatim, so accepted hashes survive the upgrade. Attempts
 * saved without a typed outcome are reclassified from their recorded error, which retroactively
 * refunds historical operational failures instead of charging them to a case's attempt budget.
 * `nextCaseIndex` is dropped: the breadth-first order is derived from depth, not a saved cursor.
 */
export function migrateCampaignState(saved, {
  config,
  reliability = DEFAULT_RELIABILITY,
  unsupportedAgreement = 2,
  startedAt = now(),
}) {
  const target = config.targetValidVideos;
  const source = saved && typeof saved === 'object' && saved.campaignId === config.id ? saved : null;
  const fromVersion = Number.isInteger(source?.version) ? source.version : source ? 1 : CAMPAIGN_STATE_VERSION;
  if (fromVersion > CAMPAIGN_STATE_VERSION) {
    throw new Error(`campaign state version ${fromVersion} is newer than this runner (${CAMPAIGN_STATE_VERSION}); refusing to downgrade persisted state`);
  }
  const byId = new Map((source?.cases ?? []).map((item) => [item.id, item]));
  let reclassifiedAttempts = 0;
  const cases = config.cases.map((item, index) => {
    const prior = byId.get(item.id) ?? {};
    const priorAttempts = Array.isArray(prior.attempts) ? prior.attempts : [];
    const attempts = normalizeAttempts(priorAttempts);
    reclassifiedAttempts += Math.max(
      0,
      attempts.filter((attempt) => attempt.outcomeRecordedAt != null).length
        - priorAttempts.filter((attempt) => attempt?.outcomeRecordedAt != null).length,
    );
    const configuredReason = normalizeUnsupportedReason(item.unsupportedReason);
    const priorReason = normalizeUnsupportedReason(prior.unsupportedReason);
    return {
      id: item.id,
      title: item.title,
      index,
      priority: Number.isInteger(item.priority) ? item.priority : 0,
      status: 'pending',
      unsupportedReason: configuredReason ?? priorReason,
      unsupportedAt: configuredReason ?? priorReason ? timestamp(prior.unsupportedAt) ?? startedAt : null,
      unsupportedFromJobId: prior.unsupportedFromJobId ?? null,
      exhaustedAt: timestamp(prior.exhaustedAt),
      nextAttemptAt: timestamp(prior.nextAttemptAt),
      operationalFailures: fromVersion >= CAMPAIGN_STATE_VERSION
        ? normalizeOperationalLedger(prior.operationalFailures)
        : ledgerFromAttempts(attempts),
      attempts,
      validVideos: (prior.validVideos ?? []).slice(0, target),
    };
  });
  let operationalFailures;
  if (fromVersion >= CAMPAIGN_STATE_VERSION) {
    operationalFailures = normalizeOperationalLedger(source?.operationalFailures);
  } else {
    // Case ledgers are reconstructed from attempts; a campaign-wide streak cannot be ordered
    // across cases, so the circuit restarts closed and re-learns from live outcomes.
    operationalFailures = emptyOperationalLedger();
    for (const item of cases) {
      operationalFailures.total += item.operationalFailures.total;
      for (const kind of OPERATIONAL_FAILURE_KINDS) operationalFailures.byKind[kind] += item.operationalFailures.byKind[kind];
    }
  }
  return {
    version: CAMPAIGN_STATE_VERSION,
    campaignId: config.id,
    targetValidVideos: target,
    unsupportedAgreement: boundedInteger(
      unsupportedAgreement, 2, 2, 10, 'campaign unsupportedAgreement',
    ),
    methodology: config.methodology,
    reliability: { ...reliability },
    startedAt: timestamp(source?.startedAt) ?? startedAt,
    updatedAt: startedAt,
    heartbeatAt: timestamp(source?.heartbeatAt),
    heartbeatSequence: Number.isInteger(source?.heartbeatSequence) ? source.heartbeatSequence : 0,
    lastSubmissionAt: timestamp(source?.lastSubmissionAt),
    migration: {
      fromVersion,
      toVersion: CAMPAIGN_STATE_VERSION,
      migratedAt: fromVersion === CAMPAIGN_STATE_VERSION ? timestamp(source?.migration?.migratedAt) : startedAt,
      reclassifiedAttempts,
      droppedFields: fromVersion < CAMPAIGN_STATE_VERSION && source?.nextCaseIndex !== undefined ? ['nextCaseIndex'] : [],
    },
    provider: new ProviderCircuit({ ...circuitOptions(reliability), snapshot: source?.provider }).toJSON(),
    operationalFailures,
    cases,
  };
}

function circuitOptions(reliability) {
  return {
    failureThreshold: reliability.providerFailureThreshold,
    baseDelayMs: reliability.retryBackoffMs,
    maxDelayMs: reliability.maxRetryBackoffMs,
    probeMaxAgeMs: reliability.providerProbeMaxAgeMs,
    trialTimeoutMs: reliability.providerTrialTimeoutMs,
  };
}

export function resolveCampaignRuntime({ config, args = new Map(), env = {}, hardware }) {
  const runtimeConfig = config.runtime ?? {};
  const requestedConcurrency = boundedInteger(
    args.get('concurrency') ?? env.SHOWCASE_CAMPAIGN_CONCURRENCY ?? runtimeConfig.maxActiveJobs,
    4, 1, 8, 'campaign concurrency',
  );
  const loadPausePerCpu = Number(env.SHOWCASE_CAMPAIGN_LOAD_PAUSE_PER_CPU ?? runtimeConfig.loadPausePerCpu ?? 1.25);
  if (!Number.isFinite(loadPausePerCpu) || loadPausePerCpu < 0.5 || loadPausePerCpu > 4) {
    throw new Error('campaign loadPausePerCpu must be between 0.5 and 4');
  }
  return Object.freeze({
    requestedConcurrency,
    maxActive: Math.min(requestedConcurrency, hardware.logicalCpus),
    intervalMs: boundedInteger(
      args.get('interval-ms') ?? env.SHOWCASE_CAMPAIGN_INTERVAL_MS ?? runtimeConfig.intervalMs,
      30_000, 5_000, 3_600_000, 'campaign interval-ms',
    ),
    submissionRecoveryMs: boundedInteger(
      args.get('submission-recovery-ms') ?? env.SHOWCASE_CAMPAIGN_SUBMISSION_RECOVERY_MS ?? runtimeConfig.submissionRecoveryMs,
      300_000, 30_000, 3_600_000, 'campaign submission-recovery-ms',
    ),
    submissionRampPerHeartbeat: boundedInteger(
      args.get('submission-ramp') ?? env.SHOWCASE_CAMPAIGN_SUBMISSION_RAMP ?? runtimeConfig.submissionRampPerHeartbeat,
      1, 1, 4, 'campaign submission-ramp',
    ),
    unsupportedAgreement: boundedInteger(
      args.get('unsupported-agreement') ?? runtimeConfig.unsupportedAgreement,
      2, 2, 10, 'campaign unsupported-agreement',
    ),
    loadPausePerCpu,
    reliability: Object.freeze({
      maxGenerationAttempts: boundedInteger(
        args.get('max-attempts') ?? env.SHOWCASE_CAMPAIGN_MAX_ATTEMPTS ?? runtimeConfig.maxGenerationAttempts,
        DEFAULT_RELIABILITY.maxGenerationAttempts, 1, 64, 'campaign max-attempts',
      ),
      providerFailureThreshold: boundedInteger(
        args.get('provider-failure-threshold') ?? env.SHOWCASE_CAMPAIGN_PROVIDER_FAILURE_THRESHOLD ?? runtimeConfig.providerFailureThreshold,
        DEFAULT_RELIABILITY.providerFailureThreshold, 1, 16, 'campaign provider-failure-threshold',
      ),
      retryBackoffMs: boundedInteger(
        args.get('retry-backoff-ms') ?? env.SHOWCASE_CAMPAIGN_RETRY_BACKOFF_MS ?? runtimeConfig.retryBackoffMs,
        DEFAULT_RELIABILITY.retryBackoffMs, 1_000, 3_600_000, 'campaign retry-backoff-ms',
      ),
      maxRetryBackoffMs: boundedInteger(
        args.get('max-retry-backoff-ms') ?? env.SHOWCASE_CAMPAIGN_MAX_RETRY_BACKOFF_MS ?? runtimeConfig.maxRetryBackoffMs,
        DEFAULT_RELIABILITY.maxRetryBackoffMs, 1_000, 21_600_000, 'campaign max-retry-backoff-ms',
      ),
      providerProbeMaxAgeMs: boundedInteger(
        runtimeConfig.providerProbeMaxAgeMs, DEFAULT_RELIABILITY.providerProbeMaxAgeMs, 60_000, 86_400_000, 'campaign providerProbeMaxAgeMs',
      ),
      providerTrialTimeoutMs: boundedInteger(
        runtimeConfig.providerTrialTimeoutMs, DEFAULT_RELIABILITY.providerTrialTimeoutMs, 60_000, 86_400_000, 'campaign providerTrialTimeoutMs',
      ),
    }),
  });
}

/**
 * The pipeline's persisted benchmark record, or `null` when the attempt did not
 * reach that stage or left malformed evidence behind.
 */
async function loadAttemptRecord(jobDir, collectedUsage = null) {
  try {
    const record = await readJson(join(jobDir, '95-benchmark.json'));
    if (record?.schema !== ATTEMPT_RECORD_SCHEMA) return null;
    const usage = collectedUsage ?? await collectJobUsage(jobDir);
    record.cost ??= {};
    record.cost.tokens = usage.tokens;
    record.cost.tokenAccounting = usage.tokenAccounting;
    for (const row of record.stages ?? []) row.tokens = usage.byStage[row.name] ?? null;
    return record;
  } catch {
    return null;
  }
}

function projectStageLedger(record) {
  return (record?.stages ?? []).map((row) => ({
    name: row.name,
    status: row.status,
    wallS: row.wallS ?? null,
    cpuS: row.cpuS ?? null,
    tokens: row.tokens ?? null,
    error: row.error ?? null,
  }));
}

/**
 * Keep the bounded report evidence in campaign state. Full trajectory features
 * are retained only for accepted cells; fingerprints remain for duplicate and
 * diversity accounting without growing state around every trace vector.
 */
function projectAttemptRecord(record, acceptedCellIds) {
  if (!record) return null;
  return {
    schema: record.schema,
    acceptanceContract: record.acceptanceContract ?? null,
    jobId: record.jobId,
    campaign: record.campaign,
    seeds: record.seeds,
    models: record.models,
    maps: record.maps,
    route: record.route ?? null,
    execution: record.execution,
    concurrency: record.concurrency,
    precheck: record.precheck,
    contractFailures: record.contractFailures ?? [],
    contractObligations: record.contractObligations ?? [],
    stages: projectStageLedger(record),
    counts: record.counts,
    funnel: record.funnel,
    outcome: record.outcome,
    cost: record.cost,
    cells: (record.cells ?? []).map((cell) => ({
      ...cell,
      trajectoryFeatures: acceptedCellIds.has(cell.cellId) ? cell.trajectoryFeatures : null,
    })),
  };
}

/**
 * Campaign wall time includes queue wait; execution and stage measurements come
 * from the attempt record, while collectJobUsage is the sole token authority.
 */
async function jobMetrics(jobDir, submittedAt, finishedAt) {
  const usage = await collectJobUsage(jobDir);
  const record = await loadAttemptRecord(jobDir, usage);
  const stageLedgerRows = projectStageLedger(record);
  const stageSeconds = {};
  for (const row of stageLedgerRows) {
    if (!Number.isFinite(Number(row.wallS))) continue;
    stageSeconds[row.name] = Number((Number(stageSeconds[row.name] ?? 0) + Number(row.wallS)).toFixed(3));
  }
  const startedMs = dateMs(submittedAt);
  const finishedMs = dateMs(finishedAt, startedMs);
  return {
    wallS: Number((Math.max(0, finishedMs - startedMs) / 1000).toFixed(3)),
    executionWallS: record?.cost?.wallS ?? null,
    generatorWallS: record?.cost?.generatorWallS ?? null,
    productWallS: record?.cost?.productWallS ?? null,
    stageSeconds,
    tokens: usage.tokens,
    tokensByStage: usage.byStage,
    cpu: record?.cost?.cpu ?? null,
    gpu: record?.cost?.gpu ?? null,
    tokenAccounting: {
      ...usage.tokenAccounting,
      attemptRecord: record ? '95-benchmark.json' : null,
      stageLedgerRows,
    },
  };
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function safeCellId(value) {
  return typeof value === 'string' && value.length > 0 && basename(value) === value && !value.includes(sep) ? value : null;
}

/**
 * A render directory named by `75-product.json`, relative to the job directory.
 * A promoted attempt lives in a subdirectory, so this is a path rather than a
 * single name; it still may never escape the job.
 */
function safeRenderDir(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return null;
  const segments = value.split('/');
  if (segments.length < 2 || segments.length > 4) return null;
  return segments.every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) ? segments.join('/') : null;
}

/**
 * `probe` is the provider liveness check the circuit uses for recovery. It defaults to the
 * repository vision gate; callers that drive the runner without the python toolchain supply
 * their own probe.
 */
export async function runCampaign({ argv = [], env = {}, probe } = {}) {
  const args = parseArgs(argv);
  const configPath = resolve(String(args.get('config') ?? join(ROOT, 'apps/showcase/campaigns/edge-cases.json')));
  const dataRoot = resolve(String(args.get('data') ?? join(ROOT, 'showcase-data')));
  const server = String(args.get('server') ?? env.SHOWCASE_SERVER ?? 'http://127.0.0.1:4174').replace(/\/+$/, '');
  const token = String(args.get('token') ?? env.SHOWCASE_TOKEN ?? 'demo-local');
  const config = validateCampaignConfig(JSON.parse(await readFile(configPath, 'utf8')));
  const hardware = {
    logicalCpus: availableParallelism(),
    memoryGiB: Number((totalmem() / (1024 ** 3)).toFixed(1)),
    gpuSlots: boundedInteger(env.SHOWCASE_CAMPAIGN_GPU_SLOTS, 2, 1, 8, 'SHOWCASE_CAMPAIGN_GPU_SLOTS'),
  };
  const settings = resolveCampaignRuntime({ config, args, env, hardware });
  const { reliability } = settings;
  const initializeOnly = args.has('once') || args.has('dry-run');
  const campaignDir = join(dataRoot, 'campaigns', config.id);
  const statePath = join(campaignDir, 'state.json');
  const reportPath = join(campaignDir, 'report.json');
  const htmlPath = join(campaignDir, 'index.html');
  const jobsDir = join(dataRoot, 'jobs');
  const lockPath = join(campaignDir, 'runner.lock');
  const retryBackoff = { baseMs: reliability.retryBackoffMs, maxMs: reliability.maxRetryBackoffMs };

  const state = migrateCampaignState(await readJson(statePath).catch(() => null), {
    config,
    reliability,
    unsupportedAgreement: settings.unsupportedAgreement,
  });
  const circuit = new ProviderCircuit({ ...circuitOptions(reliability), snapshot: state.provider });
  let capacity = null;

  const statusOptions = (nowMs = Date.now()) => ({
    targetValidVideos: state.targetValidVideos,
    maxGenerationAttempts: reliability.maxGenerationAttempts,
    nowMs,
  });

  async function acquireLock() {
    for (let pass = 0; pass < 2; pass += 1) {
      try {
        const handle = await open(lockPath, 'wx', 0o644);
        await handle.writeFile(`${JSON.stringify({ host: hostname(), pid: process.pid, startedAt: now() })}\n`);
        return handle;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let owner;
        try { owner = await readJson(lockPath); } catch { owner = null; }
        let live = owner != null && owner.host !== hostname();
        if (owner?.host === hostname() && Number.isInteger(owner.pid)) {
          try { process.kill(owner.pid, 0); live = true; } catch { live = false; }
        }
        if (live) throw new Error(`campaign runner is already active on ${owner.host ?? 'unknown host'} as pid ${owner.pid ?? 'unknown'}`);
        await unlink(lockPath).catch((unlinkError) => {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError;
        });
      }
    }
    throw new Error('could not acquire campaign runner lock');
  }

  async function releaseLock(handle) {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }

  async function checkpoint(heartbeat = false) {
    state.updatedAt = now();
    if (heartbeat) {
      state.heartbeatAt = state.updatedAt;
      state.heartbeatSequence += 1;
    }
    state.provider = circuit.toJSON();
    await atomicJson(statePath, state);
  }

  /** Operational failures are ledgered and paced; they never touch the generation budget. */
  function noteOperationalFailure({ item, kind, code, detail, jobId = null, attemptNumber = null }) {
    const entry = { kind, code, detail, at: now(), caseId: item?.id ?? null, attempt: attemptNumber, jobId };
    recordOperationalFailure(state.operationalFailures, entry, 24);
    if (!item) return;
    recordOperationalFailure(item.operationalFailures, entry, 8);
    item.nextAttemptAt = iso(Date.now() + backoffDelayMs(item.operationalFailures.consecutive, retryBackoff));
  }

  function noteGenerationOutcome(item, productive) {
    item.operationalFailures.consecutive = 0;
    if (productive) {
      item.nextAttemptAt = null;
      return;
    }
    const streak = unproductiveStreak(item);
    item.nextAttemptAt = streak > 0 ? iso(Date.now() + backoffDelayMs(streak, retryBackoff)) : null;
  }

  function applyUnsupported(item, reason, jobId) {
    const resolved = normalizeUnsupportedReason(reason);
    if (!resolved || item.unsupportedReason) return;
    item.unsupportedReason = resolved;
    item.unsupportedAt = now();
    item.unsupportedFromJobId = jobId ?? null;
  }

  function refreshCaseStatus(nowMs = Date.now()) {
    const options = statusOptions(nowMs);
    for (const item of state.cases) {
      const status = caseStatus(item, options);
      item.status = status;
      if (status === 'exhausted') item.exhaustedAt ??= now();
      else if (status !== 'unsupported') item.exhaustedAt = null;
    }
  }

  const probeProvider = probe ?? async function visionGateProbe() {
    try {
      await execFileAsync(join(ROOT, '.venv/bin/python'), [join(ROOT, 'tools/gates/assert_vision.py')], {
        cwd: ROOT,
        timeout: 180_000,
        maxBuffer: 1_000_000,
        env: {
          ...process.env,
          OPENAI_BASE_URL: 'http://127.0.0.1:4141/v1',
          OPENAI_API_KEY: 'x',
          VISTA_MODEL: 'gpt-5.6-sol',
          VISTA_EFFORT: 'low',
        },
      });
      return { ok: true, detail: null };
    } catch (error) {
      return { ok: false, detail: truncateDetail(error?.stderr ?? error?.stdout ?? error?.message ?? error) };
    }
  };

  async function providerSnapshot() {
    if (initializeOnly || !circuit.probeDue()) return circuit.toJSON();
    const wasOpen = circuit.state === 'open';
    const result = await probeProvider();
    circuit.recordProbe(result.ok, { detail: result.detail });
    if (!result.ok) {
      noteOperationalFailure({ item: null, kind: 'vision', code: 'vision_preflight_failed', detail: result.detail });
    } else if (wasOpen) {
      console.log(JSON.stringify({ providerProbe: 'passed', circuit: circuit.state }));
    }
    return circuit.toJSON();
  }

  async function capacitySnapshot() {
    const load1 = loadavg()[0];
    const memoryInfo = await readFile('/proc/meminfo', 'utf8').catch(() => '');
    const availableKiB = Number(memoryInfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m)?.[1]);
    const memoryAvailableGiB = Number(((Number.isFinite(availableKiB) ? availableKiB * 1024 : freemem()) / (1024 ** 3)).toFixed(2));
    let gpuFreeGiB = null;
    try {
      const result = await execFileAsync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { timeout: 5_000 });
      const values = result.stdout.trim().split(/\s+/).map(Number).filter(Number.isFinite);
      if (values.length) gpuFreeGiB = Number((Math.min(...values) / 1024).toFixed(2));
    } catch { /* CPU and memory gates remain available without nvidia-smi */ }
    const provider = await providerSnapshot();
    const allowance = circuit.allowSubmission();
    let effectiveMaxActiveJobs = settings.maxActive;
    let throttleReason = null;
    if (circuit.state === 'open') {
      effectiveMaxActiveJobs = 0;
      throttleReason = allowance.reason;
    } else if (circuit.state === 'probe') {
      effectiveMaxActiveJobs = Math.min(1, settings.maxActive);
      throttleReason = allowance.reason ?? 'provider circuit releases a single trial job before reopening the queue';
    } else if (memoryAvailableGiB < 8) {
      effectiveMaxActiveJobs = 0;
      throttleReason = `available memory ${memoryAvailableGiB} GiB is below 8 GiB`;
    } else if (gpuFreeGiB != null && gpuFreeGiB < 1.5) {
      effectiveMaxActiveJobs = 0;
      throttleReason = `GPU memory ${gpuFreeGiB} GiB is below 1.5 GiB`;
    } else if (load1 > hardware.logicalCpus * settings.loadPausePerCpu) {
      const complementaryCapacity = memoryAvailableGiB >= 12
        && (gpuFreeGiB == null || gpuFreeGiB >= 2.5) ? 2 : 1;
      effectiveMaxActiveJobs = Math.min(complementaryCapacity, settings.maxActive);
      throttleReason = `load1 ${load1.toFixed(2)} exceeds ${(hardware.logicalCpus * settings.loadPausePerCpu).toFixed(2)}; complementary-stage capacity ${effectiveMaxActiveJobs}`;
    }
    return {
      observedAt: now(),
      load1: Number(load1.toFixed(2)),
      loadPauseThreshold: Number((hardware.logicalCpus * settings.loadPausePerCpu).toFixed(2)),
      memoryAvailableGiB,
      gpuFreeGiB,
      provider,
      effectiveMaxActiveJobs,
      throttleReason,
    };
  }

  function runnerStatus() {
    return {
      host: hostname(),
      pid: process.pid,
      mode: initializeOnly ? 'initialize-only' : 'running',
      maxActiveJobs: settings.maxActive,
      requestedMaxActiveJobs: settings.requestedConcurrency,
      intervalMs: settings.intervalMs,
      submissionRecoveryMs: settings.submissionRecoveryMs,
      submissionRampPerHeartbeat: settings.submissionRampPerHeartbeat,
      reliability,
      hardware,
      capacity,
    };
  }

  async function recoverCampaignJobs() {
    if (!(await exists(jobsDir))) return;
    const caseById = new Map(state.cases.map((item) => [item.id, item]));
    for (const entry of await readdir(jobsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const jobId = entry.name;
      let brief;
      try { brief = await readJson(join(jobsDir, jobId, '00-brief.json')); } catch { continue; }
      if (brief.campaignId !== config.id) continue;
      const item = caseById.get(brief.campaignCaseId);
      const number = Number(brief.campaignAttempt);
      if (!item || !Number.isInteger(number) || number < 1) continue;
      let attempt = item.attempts.find((value) => value.jobId === jobId);
      if (!attempt) attempt = item.attempts.find((value) => value.number === number && !value.jobId);
      if (!attempt) {
        attempt = { number, seed: brief.seed, status: 'queued', submittedAt: brief.createdAt ?? now() };
        item.attempts.push(attempt);
      }
      attempt.jobId = jobId;
      attempt.seed = brief.seed ?? attempt.seed;
      attempt.submittedAt = brief.createdAt ?? attempt.submittedAt ?? now();
      if (attempt.status === 'submitting') attempt.status = 'queued';
    }
    for (const item of state.cases) {
      item.attempts.sort((left, right) => left.number - right.number || String(left.jobId ?? '').localeCompare(String(right.jobId ?? '')));
    }
  }

  function caseRecords(item) {
    return item.attempts.map((attempt) => attempt.record).filter(Boolean);
  }

  function benchmarkBlock(elapsedHours) {
    for (const item of state.cases) {
      item.unsupported = deterministicUnsupportedReason(caseRecords(item), {
        minimumAgreeingAttempts: state.unsupportedAgreement,
      });
    }
    const report = buildBenchmarkReport({
      campaignId: state.campaignId,
      generatedAt: state.updatedAt,
      target: state.targetValidVideos,
      maxGenerationAttempts: reliability.maxGenerationAttempts,
      minimumAgreeingAttempts: state.unsupportedAgreement,
      elapsedHours,
      mapUniverse: MAPS.length,
      cases: state.cases.map((item) => ({
        id: item.id,
        title: item.title,
        index: item.index,
        priority: item.priority,
        target: state.targetValidVideos,
        acceptedVideos: item.validVideos.length,
        submittedAttempts: item.attempts.length,
        activeAttempts: item.attempts.filter(isActive).length,
        unproductiveStreak: unproductiveStreak(item),
        operationalFailures: item.operationalFailures.total,
        records: caseRecords(item),
        videos: item.validVideos,
      })),
    });
    report.verification = {
      violations: verifyBenchmarkReport(report, { expectedEntries: state.cases.length }),
    };
    report.verification.consistent = report.verification.violations.length === 0;
    const outcomeById = new Map(report.cases.map((row) => [row.id, row.outcome]));
    for (const item of state.cases) item.outcome = outcomeById.get(item.id) ?? 'pending';
    return report;
  }

  function aggregate(nowMs = Date.now()) {
    const options = statusOptions(nowMs);
    const totals = {
      cases: state.cases.length,
      completeCases: 0,
      exhaustedCases: 0,
      unsupportedCases: 0,
      settledCases: 0,
      schedulableCases: 0,
      targetVideos: state.cases.length * state.targetValidVideos,
      validVideos: 0,
      jobs: 0,
      activeJobs: 0,
      failedJobs: 0,
      generationAttempts: 0,
      operationalAttempts: 0,
      operationalFailures: state.operationalFailures.total,
      wallS: 0,
      stageSeconds: {},
      tokens: emptyUsage(),
    };
    for (const item of state.cases) {
      totals.validVideos += item.validVideos.length;
      const status = caseStatus(item, options);
      if (status === 'complete') totals.completeCases += 1;
      if (status === 'exhausted') totals.exhaustedCases += 1;
      if (status === 'unsupported') totals.unsupportedCases += 1;
      if (SETTLED_CASE_STATUSES.includes(status)) totals.settledCases += 1;
      else totals.schedulableCases += 1;
      totals.generationAttempts += generationAttempts(item);
      for (const attempt of item.attempts) {
        totals.jobs += 1;
        if (isActive(attempt)) totals.activeJobs += 1;
        if (isOperationalAttempt(attempt)) totals.operationalAttempts += 1;
        else if (attempt.status === 'failed') totals.failedJobs += 1;
        if (!attempt.metrics) continue;
        totals.wallS += Number(attempt.metrics.wallS ?? 0) || 0;
        const tokens = attempt.metrics.tokens ?? {};
        totals.tokens.calls += Number(tokens.calls ?? 0) || 0;
        totals.tokens.inputTokens += Number(tokens.inputTokens ?? 0) || 0;
        totals.tokens.outputTokens += Number(tokens.outputTokens ?? 0) || 0;
        totals.tokens.reasoningTokens += Number(tokens.reasoningTokens ?? 0) || 0;
        totals.tokens.modelWallS += Number(tokens.modelWallS ?? 0) || 0;
        for (const [stage, seconds] of Object.entries(attempt.metrics.stageSeconds ?? {})) {
          totals.stageSeconds[stage] = Number((Number(totals.stageSeconds[stage] ?? 0) + (Number(seconds) || 0)).toFixed(3));
        }
      }
    }
    totals.wallS = Number(totals.wallS.toFixed(3));
    totals.tokens.modelWallS = Number(totals.tokens.modelWallS.toFixed(3));
    const elapsedHours = Math.max(1 / 3600, (nowMs - dateMs(state.startedAt)) / 3_600_000);
    totals.elapsedHours = Number(elapsedHours.toFixed(3));
    const window = elapsedHours >= 1 / 60 ? elapsedHours : null;
    totals.validVideosPerHour = perHour(totals.validVideos, window);
    totals.jobsPerHour = perHour(totals.jobs, window);
    totals.minimumObservationHours = Number((1 / 60).toFixed(6));
    totals.meanTokensPerValidVideo = totals.validVideos
      ? Math.round((totals.tokens.inputTokens + totals.tokens.outputTokens) / totals.validVideos)
      : null;
    totals.benchmark = benchmarkBlock(window);
    return totals;
  }

  async function publish() {
    capacity = await capacitySnapshot();
    refreshCaseStatus();
    await checkpoint(true);
    const totals = aggregate();
    const report = {
      ...state,
      runner: runnerStatus(),
      totals,
      validityContract: {
        semanticAcceptedRequired: true,
        acceptedRequired: true,
        frozenGateRequired: true,
        briefAware2dSemanticOracleRequired: true,
        uniqueVideoSha256Required: true,
        distinctTrajectoryFingerprintRequired: true,
        durableCampaignCopyRequired: true,
        currentProductContractRequired: true,
        productContractVersion: PRODUCT_CONTRACT_VERSION,
        minimumPerCase: state.targetValidVideos,
        canonicalDecisionFields: CANONICAL_DECISION_FIELDS,
        maxGenerationAttempts: reliability.maxGenerationAttempts,
        operationalFailuresConsumeAttempts: false,
      },
    };
    await atomicJson(reportPath, report);
    const rows = state.cases.map((item) => {
      const attempts = item.attempts.map((attempt) => `#${attempt.number} ${attempt.status}${isOperationalAttempt(attempt) ? ` (${attempt.failureKind})` : ''}`).join(', ') || 'pending';
      const reason = item.unsupportedReason ? ` · unsupported: ${escapeHtml(item.unsupportedReason)}` : '';
      const unsupported = item.unsupported
        ? `<div class="muted">benchmark unsupported: ${escapeHtml(item.unsupported.reason)} (${item.unsupported.agreeingAttempts} agreeing attempts)</div>`
        : '';
      const videos = item.validVideos.map((video, index) => `<figure><video controls preload="none" src="${escapeHtml(video.url)}"></video><figcaption>${index + 1}. ${escapeHtml(video.cellId)} · ${escapeHtml(video.sha256.slice(0, 12))}</figcaption></figure>`).join('');
      return `<tr><td>${item.index + 1}</td><td><b>${escapeHtml(item.title)}</b><div class="muted">${escapeHtml(item.status)} · benchmark ${escapeHtml(item.outcome)} · ${escapeHtml(attempts)}${reason}</div>${unsupported}${videos ? `<details><summary>${item.validVideos.length} accepted videos</summary><div class="videos">${videos}</div></details>` : ''}</td><td>${item.validVideos.length}/${state.targetValidVideos}</td></tr>`;
    }).join('\n');
    const benchmark = totals.benchmark;
    const percent = (rate) => (rate?.value == null ? 'n/a' : `${(rate.value * 100).toFixed(1)}%`);
    const funnelRows = benchmark.funnel.stages.map((row) => `<tr><td>${escapeHtml(row.id)}</td><td>${escapeHtml(row.phase)}</td><td>${row.reached}/${row.denominator}</td><td>${percent(row.stepRate)}</td><td>${row.stepRate.wilson95 ? `${(row.stepRate.wilson95.low * 100).toFixed(1)}–${(row.stepRate.wilson95.high * 100).toFixed(1)}%` : 'n/a'}</td><td>${row.censoredHere}</td></tr>`).join('\n');
    const outcomeRows = Object.entries(benchmark.corpus.outcomes)
      .map(([outcome, count]) => `<div class="metric"><b>${count}/${benchmark.corpus.entries}</b><br>${escapeHtml(outcome)}</div>`).join('');
    const throttle = capacity.throttleReason ? ` Throttled: ${escapeHtml(capacity.throttleReason)}.` : '';
    const hourlyVideos = totals.validVideosPerHour.value == null ? 'n/a' : totals.validVideosPerHour.value;
    const hourlyWindow = totals.validVideosPerHour.denominatorHours == null
      ? 'too short a window'
      : `${totals.validVideosPerHour.denominatorHours} h`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="30"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(config.id)}</title><style>body{font:14px system-ui;background:#0b0e14;color:#e8edf5;margin:32px}h1{margin-bottom:4px}.muted,figcaption{color:#95a0b2}.metrics{display:flex;gap:12px;flex-wrap:wrap}.metric{padding:12px 16px;background:#151b25;border-radius:10px}table{border-collapse:collapse;width:100%;margin-top:24px}th,td{text-align:left;vertical-align:top;padding:9px;border-bottom:1px solid #29303c}.videos{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-top:12px}video{width:100%;background:#000}figure{margin:0}a{color:#8de8c0}summary{cursor:pointer;margin-top:7px}h2{margin-top:32px;font-size:15px}</style></head><body><h1>${escapeHtml(config.id)}</h1><p class="muted">Strict frozen gate + brief-aware 2D semantic acceptance + deterministic 3D render + per-case SHA-256 uniqueness + distinct trace fingerprint. Heartbeat ${escapeHtml(state.heartbeatAt)}. Provider circuit ${escapeHtml(capacity.provider.state)}.${throttle}</p><div class="metrics"><div class="metric"><b>${totals.validVideos}/${totals.targetVideos}</b><br>valid videos</div><div class="metric"><b>${totals.completeCases}/${totals.cases}</b><br>complete cases</div><div class="metric"><b>${totals.exhaustedCases}/${totals.unsupportedCases}</b><br>exhausted/unsupported</div><div class="metric"><b>${totals.activeJobs}/${capacity.effectiveMaxActiveJobs}</b><br>active/effective jobs</div><div class="metric"><b>${totals.generationAttempts}</b><br>generation attempts</div><div class="metric"><b>${totals.operationalFailures}</b><br>operational failures</div><div class="metric"><b>${capacity.load1}</b><br>load1</div><div class="metric"><b>${hourlyVideos}</b><br>videos/hour over ${hourlyWindow}</div><div class="metric"><b>${totals.tokens.inputTokens + totals.tokens.outputTokens}</b><br>tokens</div></div><h2>Corpus accounting (all ${benchmark.corpus.entries} entries)</h2><div class="metrics">${outcomeRows}</div><h2>Funnel — every rate carries its denominator</h2><table><thead><tr><th>stage</th><th>phase</th><th>reached/denominator</th><th>step rate</th><th>Wilson 95%</th><th>censored here</th></tr></thead><tbody>${funnelRows}</tbody></table><h2>Throughput — generator ends at deterministic eligibility</h2><div class="metrics"><div class="metric"><b>${benchmark.throughput.generator.eligibleAttempts}/${benchmark.throughput.generator.attempts}</b><br>generator yield</div><div class="metric"><b>${benchmark.throughput.generator.wallS.p50 ?? 'n/a'} / ${benchmark.throughput.generator.wallS.p90 ?? 'n/a'}</b><br>generator wall p50/p90 s</div><div class="metric"><b>${benchmark.throughput.product.acceptedAttempts}/${benchmark.throughput.product.attempts}</b><br>product yield</div><div class="metric"><b>${benchmark.throughput.product.wallS.p50 ?? 'n/a'} / ${benchmark.throughput.product.wallS.p90 ?? 'n/a'}</b><br>product wall p50/p90 s</div><div class="metric"><b>${benchmark.operational.attempts}</b><br>operational failures (censored)</div></div><h2>Diversity — keyed on trace fingerprint, not MP4 bytes</h2><div class="metrics"><div class="metric"><b>${benchmark.diversity.distinctTrajectoryFingerprints}/${benchmark.diversity.videos}</b><br>distinct trajectories</div><div class="metric"><b>${benchmark.diversity.reencodedOnlyVideos}</b><br>re-encode-only duplicates</div><div class="metric"><b>${benchmark.diversity.maps.distinct}/${MAPS.length}</b><br>maps covered</div><div class="metric"><b>${benchmark.diversity.sites.distinct}</b><br>distinct sites</div><div class="metric"><b>${benchmark.diversity.pairwise.shapeM.p50 ?? 'n/a'}</b><br>pairwise shape distance p50 m</div></div><p class="muted">Report consistency: ${benchmark.verification.consistent ? 'no violations' : escapeHtml(benchmark.verification.violations.join('; '))}</p><p><a href="report.json">Live report JSON</a></p><h2>Per-case ledger</h2><table><thead><tr><th>#</th><th>Case and attempt status</th><th>Accepted</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    await atomicWrite(htmlPath, html);
    console.log(JSON.stringify({
      at: state.updatedAt,
      heartbeatSequence: state.heartbeatSequence,
      capacity,
      ...totals,
      benchmark: {
        outcomes: benchmark.corpus.outcomes,
        generatorYield: benchmark.throughput.generator.yield,
        productYield: benchmark.throughput.product.yield,
        operationalFailures: benchmark.operational.attempts,
        distinctTrajectories: benchmark.diversity.distinctTrajectoryFingerprints,
        consistent: benchmark.verification.consistent,
      },
    }));
  }

  function videoTarget(item, digest) {
    return join(campaignDir, 'videos', item.id, `${digest}.mp4`);
  }

  async function durableCopy(source, target, expectedHash) {
    if (await nonemptyFile(target)) {
      if (await fileSha256(target) === expectedHash) return;
    }
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await copyFile(source, temporary);
    if (await fileSha256(temporary) !== expectedHash) throw new Error(`copied video hash mismatch for ${source}`);
    await rename(temporary, target);
  }

  async function collectAccepted(item, attempt, jobDir, gallery) {
    // `75-product.json` is the cross-attempt decision: it names the cell that won and the directory
    // that cell's own render was written to, so a promoted reauthor attempt is collected from where
    // it actually lives. A decision recorded under any other contract version is not current.
    const document = await readJson(join(jobDir, '75-product.json')).catch(() => null);
    if (!isCurrentAcceptance(document) || item.validVideos.length >= state.targetValidVideos) return;
    let indexedCells = [];
    try { indexedCells = (await readJson(join(jobDir, '40-cells', 'index.json'))).cells ?? []; } catch { /* map id remains unknown */ }
    const known = new Set(item.validVideos.map((video) => video.sha256));
    for (const row of document.cells ?? []) {
      // The decision accepted the cell under the current contract, which already carries the frozen
      // gate, the oracle's match, and a completed deterministic render.
      if (!acceptsCampaignVideo(document, row) || item.validVideos.length >= state.targetValidVideos) continue;
      const cellId = safeCellId(row.cellId);
      const renderDir = cellId ? safeRenderDir(row.renderDir ?? `65-render3d/${cellId}`) : null;
      if (!cellId || !renderDir) continue;
      const candidates = [
        join(jobDir, renderDir, 'rollout.mp4'),
        join(jobDir, renderDir, 'video.mp4'),
      ];
      let videoPath = null;
      for (const candidate of candidates) {
        if (await nonemptyFile(candidate)) { videoPath = candidate; break; }
      }
      if (!videoPath) continue;
      const digest = await fileSha256(videoPath);
      if (known.has(digest)) continue;
      const relativeVideo = join('videos', item.id, `${digest}.mp4`);
      await durableCopy(videoPath, join(campaignDir, relativeVideo), digest);
      const indexedCell = indexedCells.find((cell) => cell.cellId === cellId);
      item.validVideos.push({
        sha256: digest,
        jobId: attempt.jobId,
        cellId,
        renderDir,
        acceptedAttempt: document.acceptedAttempt ?? null,
        source: relative(jobDir, videoPath).split('\\').join('/'),
        url: `/artifacts/campaigns/${config.id}/${relativeVideo.split('\\').join('/')}`,
        mapId: indexedCell?.mapId ?? ((gallery.maps ?? []).length === 1 ? gallery.maps[0] : null),
        siteId: indexedCell?.siteId ?? null,
        trajectoryFingerprint: indexedCell?.trajectoryFingerprint ?? null,
        trajectoryFeatures: indexedCell?.trajectoryFeatures ?? null,
        traceSha256: indexedCell?.traceSha256 ?? null,
        semanticAccepted: true,
        accepted: true,
        productContractVersion: document.contract?.version ?? PRODUCT_CONTRACT_VERSION,
        acceptedAt: now(),
      });
      known.add(digest);
    }
  }

  async function validateSavedVideos() {
    for (const item of state.cases) {
      const valid = [];
      const known = new Set();
      const removedJobs = new Set();
      for (const video of item.validVideos) {
        let accepted = true;
        if (valid.length >= state.targetValidVideos || !/^[a-f0-9]{64}$/.test(video.sha256) || known.has(video.sha256)) accepted = false;
        const attempt = accepted ? item.attempts.find((value) => value.jobId === video.jobId) : null;
        if (accepted && (!attempt?.jobId || !safeCellId(video.cellId))) accepted = false;
        let document;
        if (accepted) {
          document = await readJson(join(jobsDir, attempt.jobId, '75-product.json')).catch(() => null);
          if (!isCurrentAcceptance(document)) accepted = false;
        }
        const row = accepted ? campaignVideoRow(document, video.cellId) : null;
        if (accepted && !row) accepted = false;
        // The decision must still name the directory the saved bytes were copied from.
        const renderDir = row ? safeRenderDir(row.renderDir ?? `65-render3d/${video.cellId}`) : null;
        if (accepted && (video.renderDir ?? renderDir) !== renderDir) accepted = false;
        if (accepted && video.productContractVersion !== PRODUCT_CONTRACT_VERSION) accepted = false;
        const target = accepted ? videoTarget(item, video.sha256) : null;
        if (accepted && (!(await nonemptyFile(target)) || await fileSha256(target) !== video.sha256)) accepted = false;
        if (!accepted) {
          if (video.jobId) removedJobs.add(video.jobId);
          continue;
        }
        valid.push(video);
        known.add(video.sha256);
      }
      item.validVideos = valid;
      if (removedJobs.size) {
        for (const attempt of item.attempts) delete attempt.acceptanceCollectedAt;
      }
    }
  }

  async function attachRecord(item, attempt, jobDir) {
    const acceptedCellIds = new Set(
      item.validVideos.filter((video) => video.jobId === attempt.jobId).map((video) => video.cellId),
    );
    attempt.record = projectAttemptRecord(await loadAttemptRecord(jobDir), acceptedCellIds);
  }

  async function refreshAttempts() {
    const refreshedJobs = new Set();
    for (const item of state.cases) {
      for (const attempt of item.attempts) {
        if (!attempt.jobId) {
          if (attempt.status === 'submitting' && Date.now() - dateMs(attempt.submissionStartedAt) >= settings.submissionRecoveryMs) {
            // The handoff never became a job, so it consumed no generation budget.
            attempt.status = 'failed';
            attempt.finishedAt = now();
            attempt.error = 'submission outcome was not recoverable before the recovery deadline';
            attempt.failureClass = 'operational';
            attempt.failureKind = 'gateway';
            attempt.failureCode = 'submission_unresolved';
            attempt.outcomeRecordedAt = attempt.finishedAt;
            noteOperationalFailure({
              item, kind: 'gateway', code: 'submission_unresolved', detail: attempt.error, attemptNumber: attempt.number,
            });
            circuit.recordFailure({ kind: 'gateway', code: 'submission_unresolved', detail: attempt.error });
          }
          continue;
        }
        if (refreshedJobs.has(attempt.jobId)) continue;
        refreshedJobs.add(attempt.jobId);
        const jobDir = join(jobsDir, attempt.jobId);
        const galleryPath = join(jobDir, '90-gallery.json');
        const errorPath = join(jobDir, 'job-error.json');
        if (await exists(galleryPath)) {
          let gallery;
          try { gallery = await readJson(galleryPath); } catch { continue; }
          const firstObservation = attempt.outcomeRecordedAt == null;
          attempt.status = 'complete';
          attempt.finishedAt = gallery.finishedAt ?? attempt.finishedAt ?? now();
          attempt.reportedAcceptedVideos = Number(gallery.quality?.accepted ?? 0);
          applyUnsupported(item, gallery.unsupportedReason, attempt.jobId);
          if (!attempt.acceptanceCollectedAt) {
            await collectAccepted(item, attempt, jobDir, gallery);
            attempt.acceptanceCollectedAt = now();
          }
          attempt.acceptedVideos = item.validVideos.filter((video) => video.jobId === attempt.jobId).length;
          if (firstObservation) {
            attempt.outcomeRecordedAt = now();
            circuit.recordSuccess();
            noteGenerationOutcome(item, acceptedByAttempt(attempt) > 0);
          }
          if (attempt.metrics?.tokenAccounting?.version !== 3) attempt.metrics = await jobMetrics(jobDir, attempt.submittedAt, attempt.finishedAt);
          await attachRecord(item, attempt, jobDir);
        } else if (await exists(errorPath)) {
          let error;
          try { error = await readJson(errorPath); } catch { continue; }
          const firstObservation = attempt.outcomeRecordedAt == null;
          attempt.status = 'failed';
          attempt.finishedAt = error.failedAt ?? attempt.finishedAt ?? now();
          attempt.error = error.error ?? 'job failed';
          const failure = classifyFailure(error);
          applyUnsupported(item, failure.unsupportedReason, attempt.jobId);
          if (firstObservation) {
            attempt.failureClass = failure.operational ? 'operational' : 'generation';
            attempt.failureKind = failure.kind;
            attempt.failureCode = failure.code;
            if (failure.defectCodes.length) attempt.defectCodes = [...failure.defectCodes];
            attempt.outcomeRecordedAt = now();
            if (failure.operational) {
              noteOperationalFailure({
                item, kind: failure.kind, code: failure.code, detail: attempt.error, jobId: attempt.jobId, attemptNumber: attempt.number,
              });
              circuit.recordFailure({ kind: failure.kind, code: failure.code, detail: attempt.error });
            } else {
              // The provider answered; only the scenario failed.
              circuit.recordSuccess();
              noteGenerationOutcome(item, false);
            }
          }
          if (attempt.metrics?.tokenAccounting?.version !== 3) attempt.metrics = await jobMetrics(jobDir, attempt.submittedAt, attempt.finishedAt);
          await attachRecord(item, attempt, jobDir);
        } else if (await exists(jobDir)) {
          attempt.status = 'running';
          await attachRecord(item, attempt, jobDir);
        }
      }
    }
  }

  function activeCount() {
    return state.cases.flatMap((item) => item.attempts).filter(isActive).length;
  }

  function attemptSeed(item, number) {
    return Number.parseInt(sha256(`${item.id}:${number}`).slice(0, 8), 16) & 0x7fffffff;
  }

  async function submit(item) {
    const number = Math.max(0, ...item.attempts.map((attempt) => Number(attempt.number) || 0)) + 1;
    const seed = attemptSeed(item, number);
    const attempt = { number, seed, status: 'submitting', submissionStartedAt: now(), submittedAt: null };
    item.attempts.push(attempt);
    await checkpoint();
    const brief = `${item.title}. Generate a physically grounded, collision-free edge-case scenario in which the exact requested behavior is visibly central. The full-duration 3D sequence must unambiguously establish the road context, causal actors, event progression, and realistic reactions needed for strict product review. Produce a distinct realization for campaign attempt ${number}.`;
    try {
      const response = await fetch(`${server}/api/jobs?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          methodology: 'production',
          brief,
          seed,
          campaignId: config.id,
          campaignCaseId: item.id,
          campaignAttempt: number,
        }),
      });
      if (!response.ok) {
        throw Object.assign(new Error(`submit ${item.id} failed ${response.status}: ${(await response.text()).slice(0, 500)}`), { httpStatus: response.status });
      }
      const payload = await response.json();
      if (typeof payload.jobId !== 'string' || !payload.jobId) throw new Error(`submit ${item.id} returned no jobId`);
      attempt.jobId = payload.jobId;
      attempt.status = 'queued';
      attempt.submittedAt = now();
      state.lastSubmissionAt = attempt.submittedAt;
      circuit.noteSubmission({ caseId: item.id, number, jobId: attempt.jobId });
      await checkpoint();
      console.log(JSON.stringify({ submitted: item.id, number, jobId: attempt.jobId }));
      return { ok: true, attempt };
    } catch (error) {
      // A submission that never became a job is operational: the attempt record is withdrawn so
      // the case keeps its full generation budget and its seed for the retry.
      const classified = classifyFailure(error);
      const failure = classified.operational ? classified : submissionFailure(error);
      item.attempts = item.attempts.filter((value) => value !== attempt);
      noteOperationalFailure({
        item, kind: failure.kind, code: failure.code, detail: failure.detail ?? error?.message, attemptNumber: number,
      });
      circuit.recordFailure({ kind: failure.kind, code: failure.code, detail: failure.detail ?? error?.message });
      await checkpoint();
      console.error(JSON.stringify({ submissionFailed: item.id, number, kind: failure.kind, code: failure.code, detail: failure.detail }));
      return { ok: false, failure };
    }
  }

  function submissionFailure(error) {
    const status = Number(error?.httpStatus);
    const detail = truncateDetail(error?.message ?? error);
    if (status === 429) return { operational: true, kind: 'provider', code: 'rate_limited', detail };
    if (status >= 500) return { operational: true, kind: 'gateway', code: 'submission_unavailable', detail };
    return { operational: true, kind: 'gateway', code: 'submission_rejected', detail };
  }

  await mkdir(campaignDir, { recursive: true });
  const runnerLock = await acquireLock();
  try {
    await recoverCampaignJobs();
    await validateSavedVideos();
    await refreshAttempts();
    await publish();

    if (initializeOnly) return { state, totals: aggregate() };

    while (!campaignSettled(state, statusOptions())) {
      let paused = null;
      let submittedThisHeartbeat = 0;
      while (
        activeCount() < capacity.effectiveMaxActiveJobs
        && submittedThisHeartbeat < settings.submissionRampPerHeartbeat
      ) {
        const allowance = circuit.allowSubmission();
        if (!allowance.allowed) {
          paused = allowance.reason;
          break;
        }
        const item = submissionOrder(state, statusOptions())[0];
        if (!item) break;
        const result = await submit(item);
        if (!result.ok) {
          paused = `${result.failure.kind}/${result.failure.code}`;
          break;
        }
        submittedThisHeartbeat += 1;
      }
      await publish();
      await sleep(paused ? Math.max(settings.intervalMs, 60_000) : settings.intervalMs);
      await recoverCampaignJobs();
      await refreshAttempts();
    }
    await publish();
    return { state, totals: aggregate() };
  } finally {
    await releaseLock(runnerLock);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await runCampaign({ argv: process.argv, env: process.env });
}
