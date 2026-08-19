import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { availableParallelism, loadavg } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  classifyRenderFailure,
  collisionPolicyForContract,
  evaluateTraceValidity,
  mergeDefectCodes,
  retryForDefectCodes,
} from '../../../scripts/trace-validity-lib.mjs';
import { operationalFailure } from './failures.mjs';
import {
  contractIdentity,
  GATE_DEFECT_CODE,
  NEVER_SCREENED_REASON,
  PRODUCT_CONTRACT_VERSION,
  PRODUCT_DECISION_SCHEMA,
  productAcceptanceSummary,
} from './product-contract.mjs';
import {
  ATTEMPT_RECORD_SCHEMA,
  FUNNEL_STAGE_IDS,
  GENERATOR_PIPELINE_STAGES,
  PRODUCT_PIPELINE_STAGES,
  classifyOperational,
  trajectoryFeatures,
  trajectoryFingerprint,
} from './benchmark.mjs';

const execFileAsync = promisify(execFile);

/**
 * Linux USER_HZ. `/proc/self/stat` reports child CPU in these ticks and Node
 * exposes no `sysconf(_SC_CLK_TCK)`, so the assumption is declared in every
 * record it feeds rather than hidden.
 */
const CLOCK_TICKS_PER_SECOND = 100;

function selfCpuSeconds() {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1_000_000;
}

/**
 * CPU seconds burned by reaped child processes. Every heavy pipeline stage is a
 * child process (`node`, `python`, headless browser), so without this the
 * measured CPU would be almost entirely missing.
 */
async function reapedChildCpuSeconds() {
  try {
    const stat = await readFile('/proc/self/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const cutime = Number(fields[13]);
    const cstime = Number(fields[14]);
    if (!Number.isFinite(cutime) || !Number.isFinite(cstime)) return null;
    return (cutime + cstime) / CLOCK_TICKS_PER_SECOND;
  } catch {
    return null;
  }
}

let gpuProbeAvailable = null;

/**
 * One GPU utilisation sample. Host-wide by construction: `nvidia-smi` cannot
 * attribute utilisation to a caller, so consumers are told the attribution
 * instead of being handed an unattributable number as if it were per-attempt.
 */
async function gpuSample() {
  if (gpuProbeAvailable === false || process.env.SHOWCASE_BENCHMARK_GPU === '0') return null;
  try {
    const result = await execFileAsync('nvidia-smi', [
      '--query-gpu=utilization.gpu,memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ], { timeout: 5_000 });
    const rows = result.stdout.trim().split(/\r?\n/)
      .map((line) => line.split(',').map((value) => Number(value.trim())))
      .filter((row) => row.length >= 3 && row.every(Number.isFinite));
    if (rows.length === 0) throw new Error('nvidia-smi returned no parsable rows');
    gpuProbeAvailable = true;
    return {
      utilizationPct: Math.max(...rows.map((row) => row[0])),
      memoryUsedMiB: Math.max(...rows.map((row) => row[1])),
      memoryTotalMiB: Math.max(...rows.map((row) => row[2])),
      devices: rows.length,
    };
  } catch {
    gpuProbeAvailable = false;
    return null;
  }
}

async function resourceSample() {
  return {
    at: Date.now(),
    selfCpuS: selfCpuSeconds(),
    childCpuS: await reapedChildCpuSeconds(),
    gpu: await gpuSample(),
  };
}

export const MAPS = [
  'yale-street',
  'belmont-research-center',
  'el-camino-road',
  'easterbrook-discovery-school',
  'richmond-field-station',
];

/**
 * The vision model the two footage reviews run under. Both are observations, not
 * knobs: the 2D semantic oracle is the pipeline's single acceptance authority and
 * the blind 2D pass is the ranking signal for ungated 3D spend, so neither is a
 * per-job choice a caller may vary between attempts of the same campaign.
 */
const REVIEW_MODEL = 'gpt-5.6-sol';
const REVIEW_EFFORT = 'medium';
const REVIEW_STRATEGY = 'spread8';

const COMPILER_TERMS = /\b(brak|lead|vehicle|car|truck|bus|pedestrian|child|cycl|scooter|junction|intersection|cross|cut.?in|lane chang|swerve|oncoming|u.?turn|parking|pull.?out|work.?zone|road.?work|closure)/i;

export async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  await rename(temp, path);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function emptyUsage() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, modelWallS: 0 };
}

function addUsage(total, usage, wallS = 0) {
  if (!usage || typeof usage !== 'object') return;
  total.calls += Number(usage.calls ?? (usage.in != null || usage.input_tokens != null ? 1 : 0)) || 0;
  total.inputTokens += Number(usage.inputTokens ?? usage.input_tokens ?? usage.in ?? 0) || 0;
  total.outputTokens += Number(usage.outputTokens ?? usage.output_tokens ?? usage.out ?? 0) || 0;
  total.reasoningTokens += Number(usage.reasoningTokens ?? usage.reasoning_tokens ?? usage.reasoning ?? 0) || 0;
  total.modelWallS += Number(usage.modelWallS ?? usage.wallS ?? usage.llmWallS ?? wallS ?? 0) || 0;
}

async function walkFiles(dir) {
  if (!(await exists(dir))) return [];
  const paths = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) paths.push(...await walkFiles(path));
    else paths.push(path);
  }
  return paths;
}

function authorUsageInto(document, usage) {
  const attempts = Array.isArray(document.attempts) ? document.attempts : [];
  const attemptUsages = attempts.map((attempt) => attempt?.row?.usage).filter(Boolean);
  if (attemptUsages.length) {
    for (const item of attemptUsages) addUsage(usage, item);
    return;
  }
  addUsage(
    usage,
    document.usage ?? document.result?.usage ?? document.episode?.usage ?? document.cost?.tokens,
    document.wallS ?? document.cost?.wallS,
  );
}

/**
 * Provider-recorded token usage for one job, attributed to the stage that spent it.
 *
 * Author usage is deduplicated by evidence-file content hash; vision usage is
 * deduplicated by the reviewer's `rawResponseSha256`, so the same verdict copied
 * out of a repair attempt is billed exactly once. The `70-judge` bucket exists
 * only for jobs recorded before the 3D product review was removed: no stage
 * writes that artifact any more, and no new attempt bills the bucket.
 */
export async function collectJobUsage(jobDir) {
  const byStage = {
    '20-author': emptyUsage(),
    '60-render2d': emptyUsage(),
    '62-semantic2d': emptyUsage(),
    '70-judge': emptyUsage(),
  };
  const files = await walkFiles(jobDir);
  const contractAttemptPaths = files.filter((value) => basename(value) === 'contract-attempts.json');
  const contractAttemptDirs = new Set(contractAttemptPaths.map((value) => dirname(value)));
  const authorPaths = [
    ...contractAttemptPaths,
    ...files.filter((value) => basename(value) === 'transcript.json' && !contractAttemptDirs.has(dirname(value))),
  ];
  const seenAuthor = new Set();
  for (const path of authorPaths) {
    let bytes;
    try { bytes = await readFile(path); } catch { continue; }
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (seenAuthor.has(hash)) continue;
    seenAuthor.add(hash);
    try { authorUsageInto(JSON.parse(bytes), byStage['20-author']); } catch { /* malformed evidence is not billable */ }
  }
  const seenVision = new Set();
  const visionPaths = files.filter((value) => ['70-judge.json', 'quality.json', '62-semantic2d.json'].includes(basename(value)));
  for (const path of visionPaths.sort()) {
    let document;
    try { document = await readJson(path); } catch { continue; }
    if (basename(path) === '62-semantic2d.json') {
      for (const row of document.cells ?? []) {
        const key = `sem:${row?.rawResponseSha256 ?? row?.cellId ?? ''}`;
        if (row?.tokens && !seenVision.has(key)) {
          seenVision.add(key);
          addUsage(byStage['62-semantic2d'], row.tokens, row.latencyS);
        }
      }
      continue;
    }
    for (const row of document.cells ?? []) {
      const twoDKey = `2d:${row?._meta?.promptSha256 ?? ''}:${row?.rawResponseSha256 ?? row?.cellId ?? ''}`;
      if (row?._meta?.tokens && !seenVision.has(twoDKey)) {
        seenVision.add(twoDKey);
        addUsage(byStage['60-render2d'], row._meta.tokens, row._meta.latencyS);
      }
      const review = row?.threeDReview;
      const threeDKey = `3d:${review?.version ?? ''}:${review?.rawResponseSha256 ?? row?.cellId ?? ''}`;
      if (review?.tokens && !seenVision.has(threeDKey)) {
        seenVision.add(threeDKey);
        addUsage(byStage['70-judge'], review.tokens, review.latencyS);
      }
    }
  }
  const tokens = emptyUsage();
  for (const usage of Object.values(byStage)) addUsage(tokens, usage);
  for (const usage of [tokens, ...Object.values(byStage)]) {
    usage.modelWallS = Number(usage.modelWallS.toFixed(3));
  }
  return {
    tokens,
    byStage,
    tokenAccounting: {
      version: 3,
      authorEvidenceFiles: seenAuthor.size,
      visionVerdicts: seenVision.size,
      dollarCost: null,
      note: 'Author usage deduplicated by evidence hash, vision usage by reviewer response hash. '
        + 'No price table is available, so spend stays null instead of being estimated.',
    },
  };
}

/**
 * Deterministic product eligibility for one simulated cell.
 *
 * This runs after the frozen training-grade gate and before any render or
 * review: an unreadable trace, a contract-violating collision, an actor frozen
 * by an engine-recorded failure, a permanent lane-corridor stall or a failed
 * authored interaction all reject the cell here, where rejection costs nothing.
 */
async function cellTraceValidity(traceFile, collisionPolicy) {
  let trace = null;
  try {
    trace = JSON.parse(gunzipSync(await readFile(traceFile)).toString('utf8'));
  } catch {
    // An unreadable trace carries no physical fact at all, which is exactly what the validator
    // reports for a trace that recorded no ticks: one code path, failing closed.
  }
  const { schema: _schema, semanticAccepted, ...validity } = evaluateTraceValidity(trace, { collisionPolicy });
  // `eligible` is not a semantic verdict: it is the cheap deterministic gate that keeps a
  // physically broken draw out of the renderer. The 2D semantic oracle owns semantics.
  return { eligible: semanticAccepted, ...validity, retry: retryForDefectCodes(validity.defectCodes) };
}

/**
 * Product eligibility for every simulated cell of a job.
 *
 * The frozen training-grade gate decides admission and is never re-litigated
 * here; a cell it rejected is simply reported as not admitted. For the cells it
 * admitted, this is the deterministic decision about whether the recorded
 * physics is presentable, and it is the gate that every expensive stage filters
 * on.
 */
export async function evaluateCellEligibility(cells, { passing, gateCells = [], collisionPolicy }) {
  const rows = await Promise.all(cells.map(async (cell) => {
    if (!passing.has(cell.cellId)) {
      return {
        cellId: cell.cellId,
        admitted: false,
        eligible: false,
        defectCodes: [],
        unsupportedReason: null,
        retry: 'none',
        reason: `frozen gate rejected this cell (${gateCells.find((row) => row.cellId === cell.cellId)?.firstFailure ?? 'no verdict'})`,
      };
    }
    return {
      cellId: cell.cellId,
      admitted: true,
      ...await cellTraceValidity(cell.traceFile, collisionPolicy),
    };
  }));
  return {
    status: 'complete',
    implementation: 'scripts/trace-validity-lib.mjs:evaluateTraceValidity',
    collisionPolicy,
    admittedCells: rows.filter((row) => row.admitted).length,
    eligibleCells: rows.filter((row) => row.admitted && row.eligible).length,
    defectCodes: mergeDefectCodes(...rows.map((row) => row.defectCodes)),
    cells: rows,
  };
}

function lastJsonLine(text) {
  let value;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      value = JSON.parse(line);
    } catch {
      // Logs may start with a brace; only complete JSON lines are protocol output.
    }
  }
  return value;
}

async function command(file, args, options = {}) {
  try {
    const result = await execFileAsync(file, args.map(String), {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? 3_600_000,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = {
      code: Number.isInteger(error.code) ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error.message ?? error),
    };
    if (!options.allowFailure) {
      throw new Error(`${file} ${args.join(' ')} failed (${result.code}): ${String(result.stderr).slice(-2000)}`);
    }
    return result;
  }
}

function artifactPath(jobDir, path) {
  return relative(jobDir, path).split('\\').join('/');
}

/**
 * Append one measured row to the attempt's stage ledger.
 *
 * `wallS`, `cpuS`, and the GPU sample are `null` whenever they were not
 * measured — a reused artifact has no wall time of its own, and a host without
 * an NVIDIA GPU has no utilisation to report.
 */
function recordStage(context, row) {
  const ledger = context.benchmark?.stages;
  if (!ledger) return;
  const existing = ledger.findIndex((entry) => entry.name === row.name);
  if (existing >= 0) ledger.splice(existing, 1, row);
  else ledger.push(row);
}

function stageDelta(before, after) {
  if (!before || !after) return { cpuS: null, gpu: null };
  const self = after.selfCpuS != null && before.selfCpuS != null ? after.selfCpuS - before.selfCpuS : null;
  const child = after.childCpuS != null && before.childCpuS != null ? after.childCpuS - before.childCpuS : null;
  const cpuS = self == null && child == null
    ? null
    : Number((Math.max(0, self ?? 0) + Math.max(0, child ?? 0)).toFixed(3));
  const gpu = after.gpu
    ? {
      utilizationPct: after.gpu.utilizationPct,
      memoryUsedMiB: after.gpu.memoryUsedMiB,
      memoryTotalMiB: after.gpu.memoryTotalMiB,
      devices: after.gpu.devices,
      attribution: 'host-wide',
    }
    : null;
  return { cpuS, gpu };
}

async function persistBenchmark(context) {
  if (!context?.benchmark || !context.benchmarkPath) return;
  try {
    await atomicJson(context.benchmarkPath, context.benchmark);
  } catch {
    // Evidence persistence must never mask the stage failure that is in flight.
  }
}

/**
 * Fold `75-product.json` into the attempt record.
 *
 * The product decision is the only verdict: it carries the oracle's semantic
 * match, the deterministic render outcome, the defect codes every stage recorded,
 * and the name of the attempt whose render was promoted. Reading acceptance
 * anywhere else would credit footage the decision never accepted.
 */
function applyProductEvidence(context, product) {
  const record = context?.benchmark;
  if (!record) return;
  const rows = product?.cells ?? [];
  const byId = new Map(rows.map((row) => [row.cellId, row]));
  for (const cell of record.cells) {
    const row = byId.get(cell.cellId);
    if (!row) continue;
    cell.semanticAccepted = row.semanticAccepted === true;
    cell.accepted = row.accepted === true;
    cell.defectCodes = row.defectCodes ?? cell.defectCodes ?? [];
  }
  record.counts.accepted = rows.filter((row) => row.accepted === true).length;
  record.funnel.accepted = record.counts.accepted > 0;
  record.outcome.accepted = record.funnel.accepted;
  record.outcome.semanticAccepted = record.funnel['semantic-2d'] === true;
  record.outcome.acceptedAttempt = product?.acceptedAttempt ?? null;
  record.outcome.defectCodes = mergeDefectCodes(
    product?.defectCodes,
    ...rows.map((row) => row.defectCodes),
  );
  record.outcome.unsupportedReason = rows.find((row) => row.unsupportedReason)?.unsupportedReason ?? null;
}

/**
 * Assign the terminal outcome of an attempt.
 *
 * An operational failure censors the attempt at the first funnel stage it had
 * not yet reached, so every stage outcome observed before the failure stays in
 * its denominator and no infrastructure outage can be read as a generator miss.
 */
function finalizeAttemptRecord(context, error) {
  const record = context?.benchmark;
  if (!record) return;
  const finishedMs = Date.now();
  record.execution.finishedAt = new Date().toISOString();
  record.execution.resumedStages = [...new Set(context.resumedStages ?? [])];
  record.execution.resumed = record.execution.resumedStages.length > 0;
  record.outcome.failedStage = context.failedStage ?? null;
  const paidStages = record.stages.filter((row) => Number.isFinite(row.wallS));
  const sumWall = (names) => {
    const rows = paidStages.filter((row) => names.includes(row.name));
    return rows.length > 0 ? Number(rows.reduce((total, row) => total + row.wallS, 0).toFixed(3)) : null;
  };
  record.cost.wallS = Number(((finishedMs - context.startedAtMs) / 1000).toFixed(3));
  record.cost.generatorWallS = sumWall(GENERATOR_PIPELINE_STAGES);
  record.cost.productWallS = sumWall(PRODUCT_PIPELINE_STAGES);
  const cpuRows = record.stages.filter((row) => Number.isFinite(row.cpuS));
  const exclusive = record.concurrency.activeJobsAtStart === 1
    && record.concurrency.peakActiveJobs === 1;
  record.cost.cpu = cpuRows.length === 0 ? null : {
    totalS: Number(cpuRows.reduce((total, row) => total + row.cpuS, 0).toFixed(3)),
    measuredStages: cpuRows.length,
    attribution: exclusive ? 'exclusive' : 'process-shared',
    clockTicksPerSecond: CLOCK_TICKS_PER_SECOND,
    source: 'process.cpuUsage plus /proc/self/stat cutime+cstime',
  };
  const gpuRows = record.stages.map((row) => row.gpu).filter(Boolean);
  record.cost.gpu = gpuRows.length === 0 ? null : {
    samples: gpuRows.length,
    meanUtilizationPct: Number(
      (gpuRows.reduce((total, row) => total + row.utilizationPct, 0) / gpuRows.length).toFixed(2),
    ),
    peakUtilizationPct: Math.max(...gpuRows.map((row) => row.utilizationPct)),
    peakMemoryUsedMiB: Math.max(...gpuRows.map((row) => row.memoryUsedMiB)),
    gpuSecondsEquivalent: record.cost.wallS == null ? null : Number((
      (gpuRows.reduce((total, row) => total + row.utilizationPct, 0) / gpuRows.length / 100)
      * record.cost.wallS
    ).toFixed(3)),
    attribution: 'host-wide',
  };
  if (!error) {
    record.outcome.kind = record.funnel.accepted
      ? 'accepted'
      : record.funnel['semantic-2d'] ? 'semantics-only' : 'rejected';
    return;
  }
  const message = String(error?.message ?? error);
  record.outcome.error = message.slice(-1000);
  const operational = classifyOperational(message);
  record.outcome.operational = operational;
  record.outcome.kind = operational ? 'operational-failure' : 'failed';
  if (!operational) return;
  const firstUnreached = FUNNEL_STAGE_IDS.find((id) => record.funnel[id] !== true);
  record.outcome.censoredAtStage = firstUnreached ?? null;
}

export async function stage(context, name, artifacts, action) {
  const present = await Promise.all(artifacts.map((path) => exists(path)));
  const relativeArtifacts = artifacts.map((p) => artifactPath(context.jobDir, p));
  const single = artifacts.length === 1 && artifacts[0].endsWith('.json') ? artifacts[0] : null;
  if (present.every(Boolean)) {
    // This attempt did not pay for the stage, so it is recorded as reused with null
    // durations rather than as a zero-second measurement that would flatter every
    // throughput denominator.
    context.emit({ stage: name, status: 'complete', artifacts: relativeArtifacts });
    recordStage(context, {
      name,
      status: 'reused',
      startedAt: null,
      finishedAt: null,
      wallS: null,
      cpuS: null,
      gpu: null,
      artifacts: relativeArtifacts,
      error: null,
      note: 'artifacts already present; this attempt did not pay for the stage',
    });
    context.resumedStages?.push(name);
    await persistBenchmark(context);
    return single ? readJson(single) : undefined;
  }
  context.emit({ stage: name, status: 'running', artifacts: [] });
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const before = await resourceSample();
  try {
    const result = await action();
    const wallS = Number(((Date.now() - started) / 1000).toFixed(3));
    context.timings[name] = wallS;
    const after = await resourceSample();
    const status = result?.status ?? 'complete';
    recordStage(context, {
      name,
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      wallS,
      ...stageDelta(before, after),
      artifacts: relativeArtifacts,
      error: null,
    });
    context.emit({ stage: name, status, artifacts: relativeArtifacts });
    await persistBenchmark(context);
    return result?.value ?? result;
  } catch (error) {
    const wallS = Number(((Date.now() - started) / 1000).toFixed(3));
    const after = await resourceSample();
    recordStage(context, {
      name,
      status: 'error',
      startedAt,
      finishedAt: new Date().toISOString(),
      wallS,
      ...stageDelta(before, after),
      artifacts: [],
      error: String(error?.message ?? error).slice(-1000),
    });
    context.failedStage = name;
    await persistBenchmark(context);
    throw error;
  }
}

function safeCellId(result) {
  return `${result.mapId}-${result.siteId}-${result.drawIndex}`.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/**
 * Quantised trajectory description of one trace, used for diversity evidence.
 *
 * Every field is always present and is `null` when it could not be measured, so
 * an absent or unreadable trace never collapses onto a shared constant that
 * would read as a duplicate, and a caller can never mistake a missing key for a
 * field it forgot to record.
 */
const UNIDENTIFIED_TRACE = Object.freeze({
  trajectoryFingerprint: null,
  trajectoryFeatures: null,
  traceSha256: null,
  inputHash: null,
  traceSeed: null,
});

export async function traceIdentity(traceFile) {
  if (!traceFile) return { ...UNIDENTIFIED_TRACE };
  try {
    const bytes = await readFile(traceFile);
    const trace = JSON.parse(gunzipSync(bytes).toString('utf8'));
    const features = trajectoryFeatures(trace);
    return {
      trajectoryFingerprint: trajectoryFingerprint(features),
      trajectoryFeatures: features,
      traceSha256: createHash('sha256').update(bytes).digest('hex'),
      inputHash: trace?.header?.inputHash ?? null,
      traceSeed: trace?.header?.seed ?? null,
    };
  } catch {
    // A trace that cannot be read still has bytes on disk, but nothing here is
    // attributable to it, so no field is guessed from a partial parse.
    return { ...UNIDENTIFIED_TRACE };
  }
}

async function copyCells(summary, cellsDir, job) {
  await mkdir(cellsDir, { recursive: true });
  const cells = [];
  for (const result of summary.results ?? []) {
    const cellId = safeCellId(result);
    const cellDir = join(cellsDir, cellId);
    await mkdir(cellDir, { recursive: true });
    const traceFile = result.traceFile && (await exists(result.traceFile)) ? join(cellDir, 'trace.json.gz') : null;
    const instanceFile = result.instanceFile && (await exists(result.instanceFile)) ? join(cellDir, 'instance.json') : null;
    if (traceFile) await copyFile(result.traceFile, traceFile);
    if (instanceFile) await copyFile(result.instanceFile, instanceFile);
    const identity = await traceIdentity(traceFile);
    const meta = {
      cellId,
      briefId: job.briefId,
      stream: 'showcase',
      templateSha256: summary.templateDigest ?? null,
      map: result.mapId,
      site: result.siteId,
      draw: result.drawIndex,
      seed: result.paramSeed ?? job.seed ?? null,
      gate: null,
      trajectoryFingerprint: identity.trajectoryFingerprint,
      traceSha256: identity.traceSha256,
      notes: 'showcase job cell; gate populated in 50-gate.json',
      batch: {
        status: result.status,
        verdict: result.verdict,
        band: result.band,
        siteScore: result.siteScore,
        error: result.error ?? null,
      },
    };
    await atomicJson(join(cellDir, 'meta.json'), meta);
    cells.push({
      cellId,
      cellDir,
      traceFile,
      instanceFile,
      mapId: result.mapId,
      siteId: result.siteId,
      drawIndex: result.drawIndex,
      verdict: result.verdict,
      band: result.band,
      siteScore: result.siteScore,
      paramSeed: result.paramSeed ?? null,
      trajectoryFingerprint: identity.trajectoryFingerprint,
      trajectoryFeatures: identity.trajectoryFeatures,
      traceSha256: identity.traceSha256,
      inputHash: identity.inputHash ?? null,
    });
  }
  await atomicJson(join(cellsDir, 'index.json'), {
    cells: cells.map(({ cellDir: _cellDir, ...cell }) => ({
      ...cell,
      traceFile: cell.traceFile ? artifactPath(cellsDir, cell.traceFile) : null,
      instanceFile: cell.instanceFile ? artifactPath(cellsDir, cell.instanceFile) : null,
    })),
    batch: { cells: summary.cells, elapsedMs: summary.elapsedMs, criticality: summary.criticality },
  });
  return cells;
}

export function rankCandidates(cells, qualityRows) {
  const quality = new Map(qualityRows.map((row) => [row.cellId, row]));
  const score = (cell) => {
    const row = quality.get(cell.cellId) ?? {};
    return (row.plausible === true ? 100 : 0)
      + Number(row.realism ?? 0) * 10
      + Number(row.dynamism ?? 0) * 2
      - (row.defects ?? []).length * 25;
  };
  const sorted = [...cells].sort((a, b) => score(b) - score(a)
    || String(a.cellId).localeCompare(String(b.cellId)));
  const diverse = [];
  const deferred = [];
  const sites = new Set();
  const maps = new Set();
  for (const cell of sorted) {
    const site = `${cell.mapId}:${cell.siteId}`;
    if (!sites.has(site) || !maps.has(cell.mapId)) {
      diverse.push(cell);
      sites.add(site);
      maps.add(cell.mapId);
    } else {
      deferred.push(cell);
    }
  }
  return [...diverse, ...deferred];
}

/**
 * Decide acceptance for every row of one attempt, in place.
 *
 * The predicate is deterministic and has one semantic authority. A cell is accepted when the frozen
 * gate admitted it, the 2D semantic oracle matched it, and its deterministic render completed --
 * 3D when the job renders 3D, else the 2D clip. Nothing else is consulted, and nothing is rationed:
 * `topK` limits how many cells a job pays to render, never how many true verdicts it may hold.
 *
 * A cell the oracle never screened is reported as unsupported rather than given a verdict no
 * evidence backs.
 */
export function applyProductDecision(rows, { job, passing, gateRows, validityByCell, renderByCell, semanticByCell }) {
  for (const row of rows) {
    const semantic = semanticByCell?.get(row.cellId) ?? null;
    const screened = semantic?.status === 'complete';
    const gatePassed = passing.has(row.cellId);
    const render = renderByCell?.get(row.cellId) ?? null;
    const semanticAccepted = semantic?.semanticMatch === true;
    row.semanticAccepted = semanticAccepted;
    row.accepted = gatePassed && semanticAccepted && render?.status === 'complete';
    // Every code the deterministic stages and the oracle actually attributed. The gate contributes
    // its own verdict for a cell it rejected; nothing here re-attributes free text.
    row.defectCodes = mergeDefectCodes(
      validityByCell?.get(row.cellId)?.defectCodes,
      render?.defectCodes,
      screened ? semantic.scenarioDefectCodes : [],
      gatePassed ? [] : [GATE_DEFECT_CODE],
    );
    row.unsupportedReason = screened ? null : NEVER_SCREENED_REASON;
    row.acceptance = {
      contract: contractIdentity(),
      gatePassed,
      gateFirstFailure: gateRows?.get(row.cellId)?.firstFailure ?? null,
      semanticScreened: screened,
      semanticConfidence: screened ? Number(semantic.confidence ?? 0) : null,
      renderTier: job.render3d ? '3d' : '2d',
      renderStatus: render?.status ?? null,
    };
  }
  return rows;
}

/**
 * The single control a rejected job authorises.
 *
 * The 2D semantic oracle owns the repair budget. Once it has screened this job's footage, the
 * bounded mutation loop upstream has already spent every authoring pass the attempt gets, so a
 * rejection here is a finished verdict and not a budget to re-open. The bounded reauthor survives
 * for exactly one case: a job the oracle could never screen, where no semantic evidence exists to
 * repair against and authoring a new template is the only control left.
 */
export function planRetry(route, job, semantic2d, rows) {
  const observed = mergeDefectCodes(...rows.map((row) => row.defectCodes));
  const plan = (retry, kind, reason, defectCodes = observed) => ({ retry, kind, defectCodes, reason });
  const none = (kind, reason, defectCodes) => plan('none', kind, reason, defectCodes);
  if (!job.render3d) return none('none', '3D render is disabled, so no product render was spent');
  if (rows.some((row) => row.accepted === true)) return none('none', 'the job accepted a cell');
  if (semantic2d?.status !== 'complete') {
    return none('none', `the 2D semantic oracle did not run: ${semantic2d?.reason ?? 'unknown reason'}`);
  }
  if ((semantic2d.cells ?? []).some((row) => row?.status === 'complete')) {
    return none('oracle-rejected',
      'the 2D semantic oracle screened this job and the upstream mutation loop already spent its repair budget');
  }
  // No admitted draw ever reached the oracle, so there is no semantic evidence to repair against.
  const escalated = mergeDefectCodes(['scenario.no_eligible_simulation'], observed);
  if (route.engine === 'compiler' && job.fallbackToVisual === true && Number(job._fallbackDepth ?? 0) < 1) {
    return plan('reauthor', 'compiler-to-visual-fallback',
      'compiler output produced no screenable cell; visual authoring is the declared fallback', escalated);
  }
  if (Number(job._reauthorDepth ?? 0) < 1) {
    return plan('reauthor', 'scenario-defect-reauthor',
      'no cell was screenable by the 2D semantic oracle; only a new template can change that', escalated);
  }
  return none('exhausted', 'the single authorised reauthor is already spent', escalated);
}

async function loadCells(cellsDir) {
  const index = await readJson(join(cellsDir, 'index.json'));
  return index.cells.map((cell) => ({
    ...cell,
    cellDir: join(cellsDir, cell.cellId),
    traceFile: cell.traceFile ? join(cellsDir, cell.traceFile) : null,
    instanceFile: cell.instanceFile ? join(cellsDir, cell.instanceFile) : null,
  }));
}

async function normalizeRender(outDir, redact) {
  const names = await readdir(outDir);
  // The 3D exporter writes `video.mp4`, the 2D renderer writes `rollout.mp4`.
  // Prefer whatever this run just produced: preferring an existing `rollout.mp4`
  // republished the previous attempt's clip after a recapture into the same
  // directory, so a short or empty video survived its own replacement.
  const video = names.find((name) => name === 'video.mp4')
    ?? names.find((name) => name === 'rollout.mp4')
    ?? names.find((name) => name.endsWith('.mp4'));
  if (!video) throw new Error(`renderer wrote no mp4 in ${outDir}`);
  if (video !== 'rollout.mp4') await copyFile(join(outDir, video), join(outDir, 'rollout.mp4'));
  const manifestName = names.includes('render-manifest.json')
    ? 'render-manifest.json'
    : names.includes('manifest.json')
      ? 'manifest.json'
      : null;
  if (!manifestName) throw new Error(`renderer wrote no manifest in ${outDir}`);
  if (manifestName === 'manifest.json') {
    const source = await readJson(join(outDir, manifestName));
    const times = (source.frames ?? []).map((frame) => frame.t);
    await atomicJson(join(outDir, 'render-manifest.json'), {
      ...source,
      frames: (source.frames ?? []).map((frame) => ({ t: frame.t, png: frame.png })),
      footage: { redacted: redact, framePlan: { burstTimes: times.slice(0, 6) } },
    });
  }
}

async function renderCell(context, cell, outDir, { redact = false, tier = '2d', composition = 'incident' } = {}) {
  await mkdir(outDir, { recursive: true });
  const cliArgs = [
    context.cli,
    'render',
    cell.traceFile,
    '--instance',
    cell.instanceFile,
    '--out',
    outDir,
    '--tier',
    tier,
    '--format',
    'both',
    '--camera',
    'follow-ego',
    '--fps',
    '12',
    '--full-clip',
    '--composition',
    composition,
  ];
  if (redact) cliArgs.push('--redact');
  const builtIn = await command('node', cliArgs, { cwd: context.root, allowFailure: true, timeout: tier === '3d' ? 900_000 : 180_000 });
  if (builtIn.code !== 0 && tier === '2d') {
    const fallback = [
      join(context.root, 'scripts', 'render-trace.mjs'),
      '--instance',
      cell.instanceFile,
      '--trace',
      cell.traceFile,
      '--out',
      outDir,
      '--camera',
      'follow-ego',
      '--fps',
      '12',
    ];
    if (redact) fallback.push('--redact');
    await command('node', fallback, { cwd: context.root, timeout: 180_000 });
  } else if (builtIn.code !== 0) {
    throw new Error(String(builtIn.stderr).slice(-2000));
  }
  await normalizeRender(outDir, redact);
}

function gatewayAvailable(host = '127.0.0.1', port = 4141) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const finish = (value) => {
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function concurrencySetting(value, fallback, name, max) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > max) {
    throw new RangeError(`${name} must be an integer from 1 to ${max}`);
  }
  return resolved;
}

function batchConcurrencyForHost(configured) {
  const load1 = loadavg()[0];
  return {
    concurrency: load1 > availableParallelism() * 1.25 ? 1 : configured,
    load1: Number(load1.toFixed(2)),
  };
}

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async run(action) {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise((resolvePromise) => this.waiters.push(resolvePromise));
    }
    try {
      return await action();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

async function mapConcurrent(values, concurrency, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class ShowcasePipeline {
  constructor({
    root,
    python,
    cli,
    jobConcurrency = 4,
    batchConcurrency = 3,
    render2dConcurrency = 4,
    render3dConcurrency = 2,
    reviewConcurrency = 4,
  } = {}) {
    this.root = root ?? resolve(import.meta.dirname, '../../..');
    this.python = python ?? join(this.root, '.venv', 'bin', 'python');
    this.cli = cli ?? join(this.root, 'packages', 'cli', 'bin', 'uniscenarios.js');
    this.bridge = join(this.root, 'tools', 'research', 'showcase', 'stages.py');
    this.schedulerSettings = Object.freeze({
      jobConcurrency: concurrencySetting(jobConcurrency, 4, 'jobConcurrency', 8),
      batchConcurrency: concurrencySetting(batchConcurrency, 3, 'batchConcurrency', 12),
      render2dConcurrency: concurrencySetting(render2dConcurrency, 4, 'render2dConcurrency', 8),
      render3dConcurrency: concurrencySetting(render3dConcurrency, 2, 'render3dConcurrency', 4),
      reviewConcurrency: concurrencySetting(reviewConcurrency, 4, 'reviewConcurrency', 8),
    });
    this.batchConcurrency = this.schedulerSettings.batchConcurrency;
    this.render2d = new Semaphore(this.schedulerSettings.render2dConcurrency);
    this.render3d = new Semaphore(this.schedulerSettings.render3dConcurrency);
    this.review = new Semaphore(this.schedulerSettings.reviewConcurrency);
  }

  /**
   * Create the per-attempt benchmark record. Every field starts either measured
   * or `null`; stages fill it in as they complete so a crash still leaves a
   * truthful partial record on disk.
   */
  #createContext(job, externalContext) {
    const initialBatch = batchConcurrencyForHost(this.batchConcurrency);
    const context = {
      ...externalContext,
      root: this.root,
      python: this.python,
      cli: this.cli,
      timings: {},
      resumedStages: [],
      failedStage: null,
      scheduler: {
        ...(job.scheduler ?? this.schedulerSettings),
        effectiveBatchConcurrency: initialBatch.concurrency,
        load1AtStart: initialBatch.load1,
      },
    };
    context.benchmarkPath = join(context.jobDir, '95-benchmark.json');
    context.startedAtMs = Date.now();
    context.baseline = null;
    context.benchmark = {
      schema: ATTEMPT_RECORD_SCHEMA,
      acceptanceContract: PRODUCT_CONTRACT_VERSION,
      jobId: job.jobId ?? null,
      briefId: job.briefId ?? null,
      campaign: {
        id: job.campaignId ?? null,
        caseId: job.campaignCaseId ?? null,
        attempt: Number.isInteger(job.campaignAttempt) ? job.campaignAttempt : null,
      },
      brief: {
        text: String(job.requestedBrief ?? job.brief ?? '').slice(0, 4000),
        sha256: createHash('sha256').update(String(job.requestedBrief ?? job.brief ?? '')).digest('hex'),
        methodology: job.methodology ?? 'custom',
      },
      seeds: {
        requested: job.seed ?? null,
        ambient: job.ambient === 'off' ? null : (job.seed ?? null),
        seedIdentity: null,
        drawSeeds: [],
      },
      models: {
        author: { model: job.authorModel ?? null, effort: job.authorEffort ?? null },
        review: { model: REVIEW_MODEL, effort: REVIEW_EFFORT, strategy: REVIEW_STRATEGY },
        engineRequested: job.engine ?? 'auto',
        engineResolved: null,
      },
      maps: [...(job.maps ?? [])],
      execution: {
        startedAt: new Date().toISOString(),
        finishedAt: null,
        cold: externalContext?.processJobIndex === 0,
        processJobIndex: Number.isInteger(externalContext?.processJobIndex) ? externalContext.processJobIndex : null,
        processUptimeSAtStart: Number(process.uptime().toFixed(3)),
        resumed: false,
        resumedStages: [],
        repair: null,
        coldWarmBasis: 'cold when this attempt is the first job executed by the server process; '
          + 'resumed lists stages whose artifacts already existed and were therefore not paid for again',
      },
      concurrency: {
        scheduler: { ...context.scheduler },
        activeJobsAtStart: Number.isInteger(externalContext?.activeJobs) ? externalContext.activeJobs : null,
        peakActiveJobs: Number.isInteger(externalContext?.activeJobs) ? externalContext.activeJobs : null,
        logicalCpus: availableParallelism(),
        load1AtStart: initialBatch.load1,
        load1AtSimulation: null,
      },
      precheck: null,
      contractFailures: [],
      stages: [],
      counts: {
        sitesMatched: null,
        cellsSimulated: null,
        cellsWithTrace: null,
        gateEvaluated: null,
        gatePassed: null,
        admittedCells: null,
        eligibleCells: null,
        render2dAttempted: null,
        render2dComplete: null,
        semanticReviewed: null,
        semantic2dReviewed: null,
        semantic2dMatched: null,
        render3dAttempted: null,
        render3dComplete: null,
        accepted: null,
      },
      funnel: Object.fromEntries(FUNNEL_STAGE_IDS.map((id) => [id, id === 'submitted'])),
      cells: [],
      outcome: {
        kind: 'running',
        semanticAccepted: false,
        accepted: false,
        acceptedAttempt: null,
        defectCodes: [],
        unsupportedReason: null,
        operational: null,
        censoredAtStage: null,
        failedStage: null,
        error: null,
      },
      cost: {
        wallS: null,
        generatorWallS: null,
        productWallS: null,
        tokens: emptyUsage(),
        tokenAccounting: null,
        cpu: null,
        gpu: null,
      },
    };
    return context;
  }

  async run(job, externalContext) {
    const context = this.#createContext(job, externalContext);
    context.baseline = await resourceSample();
    await persistBenchmark(context);
    let failure = null;
    try {
      await this.#execute(job, context, externalContext);
    } catch (error) {
      failure = error;
    }
    const usage = await collectJobUsage(context.jobDir);
    context.benchmark.cost.tokens = usage.tokens;
    context.benchmark.cost.tokenAccounting = usage.tokenAccounting;
    for (const row of context.benchmark.stages) {
      row.tokens = usage.byStage[row.name] ?? null;
    }
    finalizeAttemptRecord(context, failure);
    await persistBenchmark(context);
    if (failure) throw failure;
  }

  async #execute(job, context, externalContext) {
    const briefPath = join(context.jobDir, '00-brief.json');
    const routePath = join(context.jobDir, '10-route.json');
    const precheckPath = join(context.jobDir, '15-precheck.json');
    const contractPath = join(context.jobDir, '15-contract.json');
    const authorDir = join(context.jobDir, '20-author');
    const templatePath = join(authorDir, 'template.json');
    const transcriptPath = join(authorDir, 'transcript.json');
    const sitesPath = join(context.jobDir, '30-sites.json');
    const cellsDir = join(context.jobDir, '40-cells');
    const cellsIndex = join(cellsDir, 'index.json');
    const gatePath = join(context.jobDir, '50-gate.json');
    const eligibilityPath = join(context.jobDir, '55-eligibility.json');
    const render2dDir = join(context.jobDir, '60-render2d');
    const render2dQualityPath = join(render2dDir, 'quality.json');
    const render2dIndex = join(render2dDir, 'index.json');
    const render3dDir = join(context.jobDir, '65-render3d');
    const render3dIndex = join(render3dDir, 'index.json');
    const productPath = join(context.jobDir, '75-product.json');
    const authorContractPath = join(authorDir, 'contract-verdict.json');
    const galleryPath = join(context.jobDir, '90-gallery.json');

    context.emit({ stage: '00-brief', status: 'complete', artifacts: ['00-brief.json'] });

    let precheckResult;
    if (await exists(precheckPath)) {
      precheckResult = await readJson(precheckPath);
    } else {
      const result = await command(this.python, [this.bridge, 'precheck', '--brief', briefPath], { cwd: this.root });
      precheckResult = lastJsonLine(result.stdout);
      if (!precheckResult) throw new Error(`precheck returned no JSON: ${result.stdout.slice(-1000)}`);
    }
    let semanticContract;
    if (job.semanticContract) {
      semanticContract = structuredClone(job.semanticContract);
    } else if (await exists(contractPath)) {
      semanticContract = await readJson(contractPath);
    } else {
      const result = await command(this.python, [this.bridge, 'contract', '--brief', briefPath], { cwd: this.root });
      semanticContract = lastJsonLine(result.stdout);
      if (!semanticContract) throw new Error(`semantic contract returned no JSON: ${result.stdout.slice(-1000)}`);
    }
    const requested = job.engine ?? 'auto';
    const autoEngine = precheckResult.feasible && COMPILER_TERMS.test(job.brief) ? 'compiler' : 'vista2';
    const engine = requested === 'auto' ? autoEngine : requested;
    const route = await stage(context, '10-route', [routePath], async () => {
      const value = {
        requested,
        engine,
        why: requested === 'auto'
          ? `${precheckResult.feasible ? 'feasible' : 'infeasible'} structural precheck; ${autoEngine === 'compiler' ? 'brief matches a compiler family' : 'visual authoring required'}`
          : `explicit engine override: ${requested}`,
        precheck: { feasible: precheckResult.feasible, requires: precheckResult.requires, missing: precheckResult.missing },
        methodology: {
          profile: job.methodology ?? 'custom',
          author: { model: job.authorModel, effort: job.authorEffort },
          review: { model: REVIEW_MODEL, effort: REVIEW_EFFORT, strategy: REVIEW_STRATEGY },
          fallbackToVisual: job.fallbackToVisual === true,
        },
        semanticContract,
        scheduler: context.scheduler,
      };
      await atomicJson(routePath, value);
      return value;
    });
    await stage(context, '15-precheck', [precheckPath, contractPath], async () => {
      await atomicJson(precheckPath, precheckResult);
      await atomicJson(contractPath, semanticContract);
      return { precheck: precheckResult, contract: semanticContract };
    });
    context.benchmark.models.engineResolved = route.engine;
    context.benchmark.precheck = {
      feasible: precheckResult?.feasible ?? null,
      requires: precheckResult?.requires ?? [],
      missing: precheckResult?.missing ?? [],
      notPortable: precheckResult?.notPortable ?? [],
    };
    context.benchmark.contractObligations = (semanticContract?.obligations ?? []).map((item) => item?.kind ?? null);

    await stage(context, '20-author', [templatePath, transcriptPath, authorContractPath], async () => {
      await mkdir(authorDir, { recursive: true });
      const authorOnce = async (subcommand) => {
        const args = [
          this.bridge, subcommand, '--brief', briefPath, '--out', authorDir,
          '--model', job.authorModel ?? 'gpt-5.6-sol',
          '--effort', job.authorEffort ?? 'medium',
        ];
        // Every pipeline attempt is a measured attempt. The bridge has no recipe-substitution
        // branch left to disable: `vista-author` always runs a real authoring episode.
        if (subcommand === 'vista-author') args.push('--contract', contractPath, '--retries', '2');
        if (subcommand === 'author') {
          args.push('--draws', '1', '--probe-draws', '1', '--max-sites', String(Math.min(job.maxSitesPerMap, 3)), '--concurrency', String(context.scheduler.effectiveBatchConcurrency));
        }
        await command(this.python, args, {
          cwd: this.root,
          timeout: subcommand === 'vista-author' ? 2_700_000 : 900_000,
          env: { ...process.env, OPENAI_BASE_URL: 'http://127.0.0.1:4141/v1', OPENAI_API_KEY: 'x' },
        });
        const result = await command(this.python, [
          this.bridge, 'validate-contract', '--template', templatePath, '--contract', contractPath,
        ], { cwd: this.root });
        return lastJsonLine(result.stdout);
      };
      const initialEngine = route.engine;
      let contractVerdict = await authorOnce(initialEngine === 'vista2' ? 'vista-author' : 'author');
      const compilerContractVerdict = contractVerdict;
      if (!contractVerdict?.valid && initialEngine === 'compiler' && job.fallbackToVisual === true) {
        const rejectedDir = join(authorDir, 'compiler-rejected');
        await mkdir(rejectedDir, { recursive: true });
        await rename(templatePath, join(rejectedDir, 'template.json'));
        await rename(transcriptPath, join(rejectedDir, 'transcript.json'));
        contractVerdict = await authorOnce('vista-author');
        route.initialEngine = 'compiler';
        route.engine = 'vista2';
        route.authorFallback = {
          reason: 'compiler output violated the executable semantic contract',
          failures: compilerContractVerdict?.failures ?? [],
          artifacts: ['20-author/compiler-rejected/template.json', '20-author/compiler-rejected/transcript.json'],
        };
        await atomicJson(routePath, route);
      }
      context.benchmark.funnel['author-ok'] = true;
      context.benchmark.contractFailures = (contractVerdict?.failures ?? []).map((failure) => (
        typeof failure === 'string' ? failure : failure?.path ?? failure?.kind ?? JSON.stringify(failure)
      ));
      if (!contractVerdict?.valid) {
        throw new Error(`authored template violated semantic contract: ${JSON.stringify(contractVerdict?.failures ?? [])}`);
      }
      context.benchmark.funnel['contract-valid'] = true;
      await atomicJson(authorContractPath, contractVerdict);
      // `batch` derives draw seeds from template identity, site, and draw index.
      // Give that path a stable identity derived from the user-controlled seed.
      const template = await readJson(templatePath);
      const seedIdentity = createHash('sha256').update(`${job.brief}\0${String(job.seed)}`).digest('hex').slice(0, 16);
      template.anchor.id = `showcase-${seedIdentity}`;
      await atomicJson(templatePath, template);
      context.benchmark.seeds.seedIdentity = seedIdentity;
    });
    const authoredTemplate = await readJson(templatePath);
    context.renderComposition = (authoredTemplate.props ?? [])
      .some((prop) => prop.essentiality === 'required') ? 'all-authored' : 'incident';
    route.methodology.renderComposition = context.renderComposition;
    await atomicJson(routePath, route);
    if (context.benchmark.funnel['contract-valid'] !== true) {
      // The stage was reused from a previous run: re-derive the two funnel
      // flags from the persisted verdict instead of assuming success.
      const savedVerdict = await exists(authorContractPath) ? await readJson(authorContractPath) : null;
      context.benchmark.funnel['author-ok'] = await exists(templatePath);
      context.benchmark.funnel['contract-valid'] = savedVerdict?.valid === true;
      context.benchmark.contractFailures = (savedVerdict?.failures ?? []).map((failure) => (
        typeof failure === 'string' ? failure : failure?.path ?? failure?.kind ?? JSON.stringify(failure)
      ));
      context.benchmark.seeds.seedIdentity = (authoredTemplate.anchor?.id ?? '').replace(/^showcase-/, '') || null;
    }
    context.benchmark.route = {
      requested: route.requested ?? null,
      engine: route.engine ?? null,
      initialEngine: route.initialEngine ?? null,
      authorFallback: route.authorFallback?.reason ?? null,
      renderComposition: context.renderComposition,
    };

    const sites = await stage(context, '30-sites', [sitesPath], async () => {
      const args = [this.cli, 'sites', 'match', templatePath];
      if (job.maps.length === MAPS.length) args.push('--all-maps');
      else args.push('--maps', job.maps.join(','));
      args.push('--max-sites', String(job.maxSitesPerMap), '--rejected');
      const result = await command('node', args, { cwd: this.root, allowFailure: true, timeout: 600_000 });
      const value = lastJsonLine(result.stdout);
      if (!value) throw new Error(`site matcher returned no JSON (${result.code}): ${result.stderr.slice(-1000)}`);
      await atomicJson(sitesPath, value);
      return value;
    });
    context.benchmark.counts.sitesMatched = Number(sites?.totalSites ?? 0);
    if ((sites?.totalSites ?? 0) === 0) throw new Error('no matching sites for authored template');

    let cells = await stage(context, '40-cells', [cellsIndex], async () => {
      const batchDir = join(context.jobDir, '.batch');
      await rm(batchDir, { recursive: true, force: true });
      const simulationBatch = batchConcurrencyForHost(this.batchConcurrency);
      context.scheduler.effectiveBatchConcurrency = simulationBatch.concurrency;
      context.scheduler.load1AtSimulation = simulationBatch.load1;
      route.scheduler = context.scheduler;
      await atomicJson(routePath, route);
      const args = [this.cli, 'batch', templatePath, '--out', batchDir, '--draws', String(job.nScenarios), '--max-sites', String(job.maxSitesPerMap), '--concurrency', String(simulationBatch.concurrency)];
      if (job.maps.length === MAPS.length) args.push('--all-maps');
      else args.push('--maps', job.maps.join(','));
      if (job.ambient !== 'off') args.push('--ambient', job.ambient, '--ambient-seed', String(job.seed));
      const result = await command('node', args, { cwd: this.root, allowFailure: true, timeout: 1_800_000 });
      const summaryPath = join(batchDir, 'batch-summary.json');
      if (!(await exists(summaryPath))) throw new Error(`batch wrote no summary (${result.code}): ${result.stderr.slice(-1500)}`);
      const summary = await readJson(summaryPath);
      const copied = await copyCells(summary, cellsDir, job);
      await rm(batchDir, { recursive: true, force: true });
      return copied;
    });
    if (!Array.isArray(cells)) cells = await loadCells(cellsDir);
    context.benchmark.concurrency.load1AtSimulation = context.scheduler.load1AtSimulation ?? null;
    context.benchmark.counts.cellsSimulated = cells.length;
    context.benchmark.counts.cellsWithTrace = cells.filter((cell) => cell.traceFile).length;
    context.benchmark.seeds.drawSeeds = cells.map((cell) => cell.paramSeed ?? null);
    context.benchmark.cells = cells.map((cell) => ({
      cellId: cell.cellId,
      mapId: cell.mapId ?? null,
      siteId: cell.siteId ?? null,
      drawIndex: cell.drawIndex ?? null,
      paramSeed: cell.paramSeed ?? null,
      batchVerdict: cell.verdict ?? null,
      band: cell.band ?? null,
      inputHash: cell.inputHash ?? null,
      traceSha256: cell.traceSha256 ?? null,
      trajectoryFingerprint: cell.trajectoryFingerprint ?? null,
      trajectoryFeatures: cell.trajectoryFeatures ?? null,
      gatePass: null,
      gateFirstFailure: null,
      render2d: null,
      render3d: null,
      semanticAccepted: null,
      accepted: null,
      defectCodes: [],
    }));
    if (context.benchmark.counts.cellsWithTrace > 0) context.benchmark.funnel['cells-ok'] = true;

    const gate = await stage(context, '50-gate', [gatePath], async () => {
      const requestPath = join(context.jobDir, '.gate-request.json');
      await atomicJson(requestPath, {
        brief: job.requestedBrief ?? job.brief,
        cells: cells.map((cell) => ({
          cellId: cell.cellId,
          traceFile: cell.traceFile,
          verdict: cell.verdict,
          band: cell.band,
          mapId: cell.mapId,
          siteId: cell.siteId,
          drawIndex: cell.drawIndex,
        })),
      });
      const result = await command(this.python, [this.bridge, 'gate', '--request', requestPath], { cwd: this.root, timeout: 600_000 });
      await rm(requestPath, { force: true });
      const value = lastJsonLine(result.stdout);
      if (!value) throw new Error(`gate returned no JSON: ${result.stdout.slice(-1000)}`);
      await atomicJson(gatePath, value);
      return value;
    });
    const passing = new Set((gate.cells ?? []).filter((cell) => cell.pass).map((cell) => cell.cellId));
    const gateById = new Map((gate.cells ?? []).map((row) => [row.cellId, row]));
    for (const cell of context.benchmark.cells) {
      const row = gateById.get(cell.cellId);
      cell.gatePass = row ? row.pass === true : null;
      cell.gateFirstFailure = row?.firstFailure ?? null;
    }
    context.benchmark.counts.gateEvaluated = gate.cells?.length ?? 0;
    context.benchmark.counts.gatePassed = passing.size;
    if (passing.size > 0) context.benchmark.funnel['gate-pass'] = true;

    // Deterministic product eligibility, downstream of the frozen gate and
    // upstream of every expensive stage. The frozen contract decides admission;
    // this decides whether the admitted physics is presentable at all.
    const collisionPolicy = collisionPolicyForContract(semanticContract);
    const eligibility = await stage(context, '55-eligibility', [eligibilityPath], async () => {
      const value = await evaluateCellEligibility(cells, {
        passing,
        gateCells: gate.cells ?? [],
        collisionPolicy,
      });
      await atomicJson(eligibilityPath, value);
      return value;
    });
    const eligibilityByCell = new Map((eligibility.cells ?? []).map((row) => [row.cellId, row]));
    const eligible = new Set((eligibility.cells ?? [])
      .filter((row) => row.admitted && row.eligible)
      .map((row) => row.cellId));
    // Eligibility is the generator's terminal verdict: it is the last thing decided
    // before a render is paid for, so it closes the generator funnel.
    context.benchmark.counts.admittedCells = Number(eligibility.admittedCells ?? passing.size) || 0;
    context.benchmark.counts.eligibleCells = eligible.size;
    context.benchmark.cells = context.benchmark.cells.map((cell) => {
      const row = eligibilityByCell.get(cell.cellId);
      return row ? { ...cell, admitted: row.admitted === true, eligible: row.eligible === true } : cell;
    });
    if (eligible.size > 0) context.benchmark.funnel.eligible = true;

    // Both footage reviews are vision calls, so the gateway is what decides whether
    // they can run at all. Probed at most once, and only when a stage needs it.
    let gatewayProbe = null;
    const gateway = () => (gatewayProbe ??= gatewayAvailable());

    let render2d = await stage(context, '60-render2d', [render2dIndex], async () => {
      await mkdir(render2dDir, { recursive: true });
      const candidates = cells.filter((candidate) =>
        eligible.has(candidate.cellId) && candidate.traceFile && candidate.instanceFile);
      const rendered = await mapConcurrent(
        candidates,
        this.schedulerSettings.render2dConcurrency,
        async (cell) => {
          const out = join(render2dDir, cell.cellId);
          try {
            await this.render2d.run(() => renderCell(context, cell, out, {
              tier: '2d', composition: context.renderComposition,
            }));
            // The blind 2D pass reads redacted frames so no gate metric can bias it.
            const redacted = await gateway() ? join(out, 'redacted') : null;
            if (redacted) {
              await this.render2d.run(() => renderCell(context, cell, redacted, {
                tier: '2d', redact: true, composition: context.renderComposition,
              }));
            }
            return { cellId: cell.cellId, status: 'complete', video: `${cell.cellId}/rollout.mp4`, redacted: redacted ? `${cell.cellId}/redacted` : null };
          } catch (error) {
            const message = String(error.message ?? error);
            return {
              cellId: cell.cellId,
              status: 'error',
              error: message.slice(-1000),
              defectCodes: [classifyRenderFailure(message)],
            };
          }
        },
      );
      await atomicJson(render2dIndex, { cells: rendered });
      return { value: rendered, status: rendered.some((row) => row.status === 'complete') ? 'complete' : 'error' };
    });
    if (!Array.isArray(render2d)) render2d = render2d.cells ?? [];
    const render2dById = new Map(render2d.map((row) => [row.cellId, row]));
    for (const cell of context.benchmark.cells) {
      const row = render2dById.get(cell.cellId);
      cell.render2d = row ? row.status : null;
    }
    context.benchmark.counts.render2dAttempted = render2d.length;
    context.benchmark.counts.render2dComplete = render2d.filter((row) => row.status === 'complete').length;
    if (context.benchmark.counts.render2dComplete > 0) context.benchmark.funnel['2d-ok'] = true;

    // The blind 2D footage pass: realism and dynamism over redacted frames. It ranks
    // 3D spend for a job the oracle could not screen and decides nothing.
    let qualityRows = [];
    if (await gateway()) {
      if (await exists(render2dQualityPath)) {
        qualityRows = (await readJson(render2dQualityPath)).cells ?? [];
      } else {
        qualityRows = await mapConcurrent(
          render2d.filter((row) => row.status === 'complete' && row.redacted),
          this.schedulerSettings.reviewConcurrency,
          async (item) => this.review.run(async () => {
            const cell = cells.find((candidate) => candidate.cellId === item.cellId);
            const result = await command(this.python, [
              this.bridge, 'judge', '--cell', cell.cellDir,
              '--render', join(render2dDir, item.redacted),
              '--model', REVIEW_MODEL,
              '--effort', REVIEW_EFFORT,
              '--strategy', REVIEW_STRATEGY,
            ], {
              cwd: this.root,
              timeout: 600_000,
              env: { ...process.env, OPENAI_BASE_URL: 'http://127.0.0.1:4141/v1', OPENAI_API_KEY: 'x' },
              allowFailure: true,
            });
            const verdict = lastJsonLine(result.stdout);
            return verdict
              ? { status: 'complete', ...verdict }
              : { cellId: item.cellId, status: 'error', error: result.stderr.slice(-1000) };
          }),
        );
        await atomicJson(render2dQualityPath, { status: 'complete', cells: qualityRows });
      }
    }
    const qualityAccessFailure = qualityRows.find(operationalFailure);
    if (qualityAccessFailure) {
      throw new Error(`model access unavailable during 2D review: ${JSON.stringify(qualityAccessFailure).slice(-1000)}`);
    }
    context.benchmark.counts.semanticReviewed = qualityRows.filter((row) => row.status === 'complete').length;
    if (context.benchmark.counts.semanticReviewed > 0) context.benchmark.funnel['semantic-reviewed'] = true;

    // ---- 62-semantic2d: the acceptance oracle -------------------------------
    // Brief-aware semantic review of the cheap 2D schematic footage. This is the
    // pipeline's only semantic authority: 3D render spend, template repair, and
    // product acceptance all key off this verdict.
    const semantic2dPath = join(context.jobDir, '62-semantic2d.json');
    const extraGateCells = [];
    let semanticRows = [];
    let adoptedRound = null;
    const semanticTargets = (candidateCells, eligibleSet, renderRoot) => candidateCells
      .filter((cell) => eligibleSet.has(cell.cellId) && cell.traceFile && cell.instanceFile)
      .map((cell) => ({ cell, renderDir: join(renderRoot, cell.cellId) }));
    let semantic2d = await stage(context, '62-semantic2d', [semantic2dPath], async () => {
      if (!(await gateway())) {
        const value = { status: 'skipped', reason: 'OpenAI gateway unavailable at 127.0.0.1:4141', cells: [] };
        await atomicJson(semantic2dPath, value);
        return { value, status: 'skipped' };
      }
      const completed2d = new Set(render2d.filter((row) => row.status === 'complete').map((row) => row.cellId));
      const targets = semanticTargets(cells, eligible, render2dDir)
        .filter((item) => completed2d.has(item.cell.cellId));
      const rows = await this.reviewSemantic2d(context, job, briefPath, targets);
      const value = {
        status: 'complete',
        cells: rows,
        reviewed: rows.filter((row) => row.status === 'complete').length,
        matched: rows.filter((row) => row.semanticMatch === true).length,
      };
      await atomicJson(semantic2dPath, value);
      return value;
    });
    if (Array.isArray(semantic2d)) semantic2d = { status: 'complete', cells: semantic2d };
    const semanticAccessFailure = (semantic2d.cells ?? []).find(operationalFailure);
    if (semanticAccessFailure) {
      throw new Error(`model access unavailable during semantic 2D review: ${JSON.stringify(semanticAccessFailure).slice(-1000)}`);
    }
    semanticRows = semantic2d.cells ?? [];
    const matchedIds = () => new Set(semanticRows.filter((row) => row.semanticMatch === true).map((row) => row.cellId));
    let matchedCells = cells.filter((cell) => matchedIds().has(cell.cellId));

    // ---- bounded semantic repair: mutate the template, never re-run the world.
    // Two single-call mutations of the existing template, then one action-capped
    // fresh authoring episode. Each round re-simulates the best map only and is
    // screened by the same 2D semantic oracle. The recursive full-pipeline
    // repair path is unreachable while this gate is active.
    const semanticFeedback = () => semanticRows
      .filter((row) => row.status === 'complete' && row.semanticMatch !== true)
      .sort((a, b) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0))
      .slice(0, 3)
      .map((row) => ({
        cellId: row.cellId,
        mechanismFidelity: row.mechanismFidelity ?? null,
        actorFidelity: row.actorFidelity ?? null,
        eventSequence: row.eventSequence ?? null,
        plausible: row.plausible ?? null,
        defects: row.defects ?? [],
        explanation: row.explanation ?? '',
      }));
    // What each earlier repair round broke, fed forward so the next mutation
    // does not trade the semantic defect for a criticality one.
    const repairHistory = [];
    const bestSemanticCell = () => {
      const byConfidence = [...semanticRows]
        .filter((row) => row.status === 'complete')
        .sort((a, b) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0));
      const preferred = byConfidence[0]?.cellId;
      return cells.find((cell) => cell.cellId === preferred)
        ?? cells.find((cell) => eligible.has(cell.cellId))
        ?? cells[0];
    };
    const runSemanticRound = async (roundName, makeTemplate) => {
      const roundDir = join(context.jobDir, roundName);
      const roundIndex = join(roundDir, 'index.json');
      const round = await stage(context, roundName, [roundIndex], async () => {
        await mkdir(roundDir, { recursive: true });
        const feedback = semanticFeedback();
        const feedbackPath = join(roundDir, 'feedback.json');
        await atomicJson(feedbackPath, {
          brief: job.requestedBrief ?? job.brief,
          cells: feedback,
          priorRepairFailures: repairHistory,
        });
        const roundTemplatePath = join(roundDir, 'template.json');
        const made = await makeTemplate(roundDir, feedbackPath, roundTemplatePath);
        if (!made.ok) {
          const value = { status: 'failed', reason: made.reason, cells: [], matched: 0 };
          await atomicJson(roundIndex, value);
          return { value, status: 'failed' };
        }
        const roundTemplate = await readJson(roundTemplatePath);
        roundTemplate.anchor.id = `showcase-${context.benchmark.seeds.seedIdentity}-${roundName.slice(3)}`;
        await atomicJson(roundTemplatePath, roundTemplate);
        const anchor = bestSemanticCell();
        const batchDir = join(roundDir, '.batch');
        await rm(batchDir, { recursive: true, force: true });
        const batchArgs = [this.cli, 'batch', roundTemplatePath, '--out', batchDir,
          '--draws', String(job.nScenarios), '--max-sites', '1',
          '--concurrency', String(context.scheduler.effectiveBatchConcurrency),
          '--maps', anchor?.mapId ?? job.maps[0]];
        if (job.ambient !== 'off') batchArgs.push('--ambient', job.ambient, '--ambient-seed', String(job.seed));
        const batchResult = await command('node', batchArgs, { cwd: this.root, allowFailure: true, timeout: 1_800_000 });
        const summaryPath = join(batchDir, 'batch-summary.json');
        if (!(await exists(summaryPath))) {
          const value = { status: 'failed', reason: `repair batch wrote no summary (${batchResult.code})`, cells: [], matched: 0 };
          await atomicJson(roundIndex, value);
          return { value, status: 'failed' };
        }
        const roundSummary = await readJson(summaryPath);
        // A repaired template re-simulates the same map sites, so its draws live
        // in their own index space: without the offset a round cell would collide
        // with the original cell simulated at the same site and draw.
        const drawOffset = { '62-mutation-01': 100, '62-mutation-02': 200, '62-fallback-author': 300 }[roundName] ?? 900;
        for (const result of roundSummary.results ?? []) {
          result.drawIndex = drawOffset + (Number(result.drawIndex) || 0);
        }
        const roundCells = await copyCells(roundSummary, join(roundDir, '40-cells'), job);
        await rm(batchDir, { recursive: true, force: true });
        const gateRequestPath = join(roundDir, '.gate-request.json');
        await atomicJson(gateRequestPath, {
          brief: job.requestedBrief ?? job.brief,
          cells: roundCells.map((cell) => ({
            cellId: cell.cellId, traceFile: cell.traceFile, verdict: cell.verdict,
            band: cell.band, mapId: cell.mapId, siteId: cell.siteId, drawIndex: cell.drawIndex,
          })),
        });
        const gateResult = await command(this.python, [this.bridge, 'gate', '--request', gateRequestPath], { cwd: this.root, timeout: 600_000 });
        await rm(gateRequestPath, { force: true });
        const roundGate = lastJsonLine(gateResult.stdout);
        if (!roundGate) throw new Error(`repair gate returned no JSON: ${gateResult.stdout.slice(-1000)}`);
        const roundPassing = new Set((roundGate.cells ?? []).filter((row) => row.pass).map((row) => row.cellId));
        const roundEligibility = await evaluateCellEligibility(roundCells, {
          passing: roundPassing, gateCells: roundGate.cells ?? [], collisionPolicy,
        });
        const roundEligible = new Set((roundEligibility.cells ?? [])
          .filter((row) => row.admitted && row.eligible).map((row) => row.cellId));
        const renderRoot = join(roundDir, '60-render2d');
        const renderTargets = semanticTargets(roundCells, roundEligible, renderRoot);
        const rendered = [];
        for (const item of renderTargets) {
          try {
            await this.render2d.run(() => renderCell(context, item.cell, item.renderDir, {
              tier: '2d', composition: context.renderComposition,
            }));
            rendered.push(item);
          } catch { /* an unrenderable round cell simply cannot be screened */ }
        }
        const rows = await this.reviewSemantic2d(context, job, briefPath, rendered);
        // Named artifact so collectJobUsage bills this round's review tokens.
        await atomicJson(join(roundDir, '62-semantic2d.json'), { status: 'complete', cells: rows });
        const value = {
          status: 'complete',
          template: 'template.json',
          repair: made.meta ?? null,
          gate: roundGate,
          eligibility: roundEligibility,
          cells: roundCells.map(({ cellDir: _cellDir, ...cell }) => cell),
          semantic: rows,
          reviewed: rows.filter((row) => row.status === 'complete').length,
          matched: rows.filter((row) => row.semanticMatch === true).length,
        };
        await atomicJson(roundIndex, value);
        return { value, status: value.matched > 0 ? 'complete' : 'failed' };
      });
      if (!round || round.status === 'failed' || !Array.isArray(round.cells)) {
        if (round) {
          repairHistory.push({ round: roundName, outcome: 'failed', reason: round.reason ?? null });
        }
        return round ?? null;
      }
      if ((round.matched ?? 0) === 0) {
        const firstFailures = [...new Set((round.gate?.cells ?? [])
          .filter((row) => !row.pass).map((row) => row.firstFailure).filter(Boolean))];
        repairHistory.push({
          round: roundName,
          outcome: 'no-semantic-match',
          gateFirstFailures: firstFailures,
          eligibleCells: (round.eligibility?.cells ?? []).filter((row) => row.admitted && row.eligible).length,
          semanticDefects: [...new Set((round.semantic ?? []).flatMap((row) => (row.defects ?? [])
            .map((defect) => defect?.code).filter(Boolean)))],
          note: firstFailures.length
            ? `the repaired template lost frozen-gate criticality (first failures: ${firstFailures.join(', ')}); the repair must keep a genuine imminent conflict that forces real ego braking`
            : null,
        });
      }
      // Adopt the round's world into the job-wide evidence maps so every
      // downstream stage sees the repaired cells beside the originals.
      const roundCells = round.cells.map((cell) => ({
        ...cell,
        cellDir: join(roundDir, '40-cells', cell.cellId),
        traceFile: cell.traceFile ? join(roundDir, '40-cells', cell.traceFile) : null,
        instanceFile: cell.instanceFile ? join(roundDir, '40-cells', cell.instanceFile) : null,
      }));
      const roundCellPaths = new Map(roundCells.map((cell) => [cell.cellId, cell]));
      for (const cell of roundCells) cells.push(cell);
      for (const row of round.gate?.cells ?? []) {
        extraGateCells.push(row);
        if (row.pass) passing.add(row.cellId);
      }
      for (const row of round.eligibility?.cells ?? []) {
        eligibilityByCell.set(row.cellId, row);
        if (row.admitted && row.eligible) eligible.add(row.cellId);
      }
      for (const cell of round.cells) {
        context.benchmark.cells.push({
          cellId: cell.cellId,
          mapId: cell.mapId ?? null,
          siteId: cell.siteId ?? null,
          drawIndex: cell.drawIndex ?? null,
          paramSeed: cell.paramSeed ?? null,
          batchVerdict: cell.verdict ?? null,
          band: cell.band ?? null,
          inputHash: cell.inputHash ?? null,
          traceSha256: cell.traceSha256 ?? null,
          trajectoryFingerprint: cell.trajectoryFingerprint ?? null,
          trajectoryFeatures: cell.trajectoryFeatures ?? null,
          gatePass: (round.gate?.cells ?? []).find((row) => row.cellId === cell.cellId)?.pass === true,
          gateFirstFailure: (round.gate?.cells ?? []).find((row) => row.cellId === cell.cellId)?.firstFailure ?? null,
          render2d: null,
          render3d: null,
          semanticAccepted: null,
          accepted: null,
          defectCodes: [],
          repairRound: roundName,
        });
      }
      semanticRows = [...semanticRows, ...(round.semantic ?? [])];
      if ((round.matched ?? 0) > 0) {
        adoptedRound = roundName;
        matchedCells = (round.semantic ?? [])
          .filter((row) => row.semanticMatch === true)
          .map((row) => roundCellPaths.get(row.cellId))
          .filter(Boolean);
      }
      return round;
    };
    let currentTemplatePath = templatePath;
    if (semantic2d.status === 'complete'
      && matchedCells.length === 0 && semanticFeedback().length > 0) {
      for (const roundName of ['62-mutation-01', '62-mutation-02']) {
        const round = await runSemanticRound(roundName, async (roundDir, feedbackPath, roundTemplatePath) => {
          const result = await command(this.python, [
            this.bridge, 'mutate', '--brief', briefPath, '--contract', contractPath,
            '--template', currentTemplatePath, '--feedback', feedbackPath,
            '--out', roundTemplatePath,
            '--model', job.authorModel ?? 'gpt-5.6-sol', '--effort', job.authorEffort ?? 'medium',
          ], {
            cwd: this.root,
            timeout: 600_000,
            allowFailure: true,
            env: { ...process.env, OPENAI_BASE_URL: 'http://127.0.0.1:4141/v1', OPENAI_API_KEY: 'x' },
          });
          const verdict = lastJsonLine(result.stdout);
          if (!verdict) return { ok: false, reason: `mutation returned no JSON: ${result.stderr.slice(-500)}` };
          if (verdict.usage) await atomicJson(join(roundDir, 'transcript.json'), { usage: verdict.usage });
          if (verdict.valid !== true) return { ok: false, reason: `mutated template violated the semantic contract: ${JSON.stringify(verdict.failures ?? []).slice(0, 500)}` };
          return { ok: true, meta: { kind: 'template-mutation', latencyS: verdict.latencyS ?? null } };
        });
        if (round?.status !== 'failed' && await exists(join(context.jobDir, roundName, 'template.json'))) {
          currentTemplatePath = join(context.jobDir, roundName, 'template.json');
        }
        if (matchedCells.length > 0) break;
      }
      if (matchedCells.length === 0) {
        await runSemanticRound('62-fallback-author', async (roundDir, feedbackPath, roundTemplatePath) => {
          const feedback = await readJson(feedbackPath);
          const fallbackBriefPath = join(roundDir, '00-brief.json');
          await atomicJson(fallbackBriefPath, {
            id: `${job.briefId}-semantic-fallback`,
            brief: `${job.brief}\n\nSEMANTIC FEEDBACK FROM SIMULATED FOOTAGE OF THE REJECTED TEMPLATE:\n${(feedback.cells ?? []).map((row) => `- ${row.explanation}`).join('\n')}\nAuthor a scenario whose simulated motion visibly enacts the request.`,
          });
          const authorDirRound = join(roundDir, 'author');
          const result = await command(this.python, [
            this.bridge, 'vista-author', '--brief', fallbackBriefPath, '--out', authorDirRound,
            '--model', job.authorModel ?? 'gpt-5.6-sol', '--effort', job.authorEffort ?? 'medium',
            '--contract', contractPath, '--retries', '0', '--budget', '20',
          ], {
            cwd: this.root,
            timeout: 1_500_000,
            allowFailure: true,
            env: { ...process.env, OPENAI_BASE_URL: 'http://127.0.0.1:4141/v1', OPENAI_API_KEY: 'x' },
          });
          if (!(await exists(join(authorDirRound, 'template.json')))) {
            return { ok: false, reason: `fallback author emitted no template: ${result.stderr.slice(-500)}` };
          }
          await copyFile(join(authorDirRound, 'template.json'), roundTemplatePath);
          return { ok: true, meta: { kind: 'fallback-author', actions: 20 } };
        });
      }
    }
    context.benchmark.counts.semantic2dReviewed = semanticRows.filter((row) => row.status === 'complete').length;
    context.benchmark.counts.semantic2dMatched = semanticRows.filter((row) => row.semanticMatch === true).length;
    if (context.benchmark.counts.semantic2dMatched > 0) context.benchmark.funnel['semantic-2d'] = true;
    for (const row of semanticRows) {
      const benchCell = context.benchmark.cells.find((cell) => cell.cellId === row.cellId);
      if (benchCell) benchCell.semantic2dMatch = row.semanticMatch === true;
    }
    context.benchmark.execution.semanticRepair = adoptedRound
      ?? (semantic2d.status === 'complete' && matchedCells.length === 0
        && semanticRows.length > 0 ? 'exhausted' : null);

    let render3d = await stage(context, '65-render3d', [render3dIndex], async () => {
      await mkdir(render3dDir, { recursive: true });
      if (!job.render3d) {
        const value = { status: 'skipped', reason: 'render3d disabled', cells: [] };
        await atomicJson(render3dIndex, value);
        return { value, status: 'skipped' };
      }
      if (semantic2d.status === 'complete' && matchedCells.length === 0) {
        const value = { status: 'skipped', reason: 'no 2D semantic match; 3D spend is gated on the semantic oracle', cells: [] };
        await atomicJson(render3dIndex, value);
        return { value, status: 'skipped' };
      }
      // The oracle rations 3D to the single best-matching cell. The rank-and-render-topK
      // path survives only for a job the oracle could not screen at all.
      const semanticConfidence = new Map(semanticRows
        .filter((row) => row.semanticMatch === true)
        .map((row) => [row.cellId, Number(row.confidence ?? 0)]));
      const candidates = semantic2d.status === 'complete'
        ? [...matchedCells]
          .sort((a, b) => (semanticConfidence.get(b.cellId) ?? 0) - (semanticConfidence.get(a.cellId) ?? 0)
            || String(a.cellId).localeCompare(String(b.cellId)))
          .slice(0, 1)
        : rankCandidates(
          cells.filter((candidate) => eligible.has(candidate.cellId)),
          qualityRows,
        ).slice(0, job.topK * 3);
      const rows = await mapConcurrent(
        candidates,
        this.schedulerSettings.render3dConcurrency,
        async (cell) => this.render3dCell(context, cell, join(render3dDir, cell.cellId)),
      );
      const value = { status: rows.some((row) => row.status === 'complete') ? 'complete' : 'unavailable', cells: rows };
      await atomicJson(render3dIndex, value);
      return { value, status: value.status === 'complete' ? 'complete' : 'skipped' };
    });
    if (Array.isArray(render3d)) render3d = { status: 'complete', cells: render3d };
    const render3dById = new Map((render3d?.cells ?? []).map((row) => [row.cellId, row]));
    for (const cell of context.benchmark.cells) {
      const row = render3dById.get(cell.cellId);
      cell.render3d = row ? row.status : null;
    }
    context.benchmark.counts.render3dAttempted = render3d?.cells?.length ?? 0;
    context.benchmark.counts.render3dComplete = (render3d?.cells ?? [])
      .filter((row) => row.status === 'complete').length;
    if (context.benchmark.counts.render3dComplete > 0) context.benchmark.funnel['3d-ok'] = true;

    // ---- the deterministic product decision --------------------------------
    // Every cell the decision is accountable for: the ones the oracle screened and
    // the ones a deterministic render was spent on. Nothing is reviewed here; the
    // oracle's verdict and the render outcome are the whole evidence.
    const gateRows = new Map([...(gate.cells ?? []), ...extraGateCells].map((row) => [row.cellId, row]));
    const semanticByCell = new Map(semanticRows.map((row) => [row.cellId, row]));
    const renderByCell = new Map((job.render3d ? render3d?.cells ?? [] : render2d)
      .map((row) => [row.cellId, row]));
    let productRows = [...new Set([...semanticByCell.keys(), ...renderByCell.keys()])].sort()
      .map((cellId) => ({
        cellId,
        // Where this cell's own render was written. A 2D-only job has none, and its
        // accepted headline resolves from the 2D index instead.
        renderDir: job.render3d && renderByCell.get(cellId)?.status === 'complete'
          ? `65-render3d/${cellId}`
          : null,
      }));
    applyProductDecision(productRows, {
      job, passing, gateRows, validityByCell: eligibilityByCell, renderByCell, semanticByCell,
    });

    const plan = planRetry(route, job, semantic2d, productRows);
    let acceptedAttempt = null;

    if (plan.retry === 'reauthor') {
      const attemptName = plan.kind === 'compiler-to-visual-fallback' ? '80-visual-fallback' : '80-reauthor-01';
      const repairDir = join(context.jobDir, attemptName);
      const eligibilityDefects = (eligibility.cells ?? [])
        .filter((row) => row.admitted && (row.defectCodes ?? []).length > 0)
        .map((row) => `${row.cellId}: ${row.defectCodes.join(', ')}`);
      // Repair feedback is attributable: every line names the defect code it has to fix. The
      // oracle screened nothing here, so the deterministic rejections are the whole evidence.
      const repairFeedback = [
        ...eligibilityDefects,
        ...productRows.map((row) => [
          row.cellId,
          (row.defectCodes ?? []).join(', ') || 'no defect code',
          row.unsupportedReason,
        ].filter(Boolean).join(': ')),
      ].filter(Boolean).slice(0, 24);
      const repairJob = {
        ...job,
        briefId: `${job.briefId}-${plan.kind === 'compiler-to-visual-fallback' ? 'visual-fallback' : 'reauthor-01'}`,
        requestedBrief: job.requestedBrief ?? job.brief,
        brief: `${job.brief}\n\nPOST-RENDER REPAIR FEEDBACK FROM REJECTED ATTEMPT:\n${repairFeedback.map((item) => `- ${item}`).join('\n')}\nReauthor the executable scenario; do not merely explain these defects.`,
        engine: 'vista2',
        fallbackToVisual: false,
        _fallbackDepth: plan.kind === 'compiler-to-visual-fallback' ? 1 : Number(job._fallbackDepth ?? 0),
        _reauthorDepth: plan.kind === 'compiler-to-visual-fallback' ? Number(job._reauthorDepth ?? 0) : 1,
        semanticContract,
      };
      await mkdir(repairDir, { recursive: true });
      await atomicJson(join(repairDir, '00-brief.json'), repairJob);
      await atomicJson(join(repairDir, 'repair-request.json'), {
        kind: plan.kind,
        retry: plan.retry,
        reason: plan.reason,
        authorisedBy: plan.defectCodes,
        sourceJobId: job.jobId,
        feedback: repairFeedback,
        semanticContract,
      });
      context.emit({ stage: '80-reauthor', status: 'running', artifacts: [`${attemptName}/repair-request.json`] });
      try {
        await this.run(repairJob, {
          ...externalContext,
          jobDir: repairDir,
          emit: () => {},
        });
        const repairedGallery = await readJson(join(repairDir, '90-gallery.json'));
        await atomicJson(join(repairDir, 'repair-result.json'), {
          accepted: repairedGallery.accepted === true,
          gallery: repairedGallery,
        });
        context.emit({
          stage: '80-reauthor',
          status: repairedGallery.accepted === true ? 'complete' : 'failed',
          artifacts: [`${attemptName}/repair-request.json`, `${attemptName}/repair-result.json`],
        });
        if (repairedGallery.accepted === true) {
          // The attempt keeps its own cells, gate verdict, renders and review.
          // Nothing under the rejected attempt is replaced, so both attempts
          // stay auditable and every recorded hash keeps its meaning.
          acceptedAttempt = attemptName;
          const repairedProduct = await readJson(join(repairDir, '75-product.json'));
          productRows = (repairedProduct.cells ?? []).map((row) => ({
            ...row,
            renderDir: row.renderDir ? `${attemptName}/${row.renderDir}` : null,
          }));
        }
        context.benchmark.execution.repair = {
          kind: plan.kind,
          accepted: repairedGallery.accepted === true,
          evidence: `${attemptName}/repair-result.json`,
          attemptRecord: `${attemptName}/95-benchmark.json`,
        };
      } catch (error) {
        await atomicJson(join(repairDir, 'repair-result.json'), {
          accepted: false,
          error: String(error.message ?? error),
        });
        context.benchmark.execution.repair = {
          kind: plan.kind,
          accepted: false,
          evidence: `${attemptName}/repair-result.json`,
          attemptRecord: `${attemptName}/95-benchmark.json`,
          error: String(error.message ?? error).slice(-500),
        };
        context.emit({
          stage: '80-reauthor',
          status: 'failed',
          artifacts: [`${attemptName}/repair-request.json`, `${attemptName}/repair-result.json`],
        });
      }
    }

    // The authoritative cross-attempt product decision. Stage artifacts stay
    // immutable, so this is the one file that says which cell won, where its
    // video actually lives, and every defect code the job recorded -- including
    // the ones that rejected a cell before the oracle could ever screen it.
    const productSummary = productAcceptanceSummary({ cells: productRows });
    const product = {
      schema: PRODUCT_DECISION_SCHEMA,
      status: 'complete',
      contract: contractIdentity(),
      collisionPolicy,
      retry: {
        kind: plan.retry,
        detail: plan.kind,
        reason: plan.reason,
        authorisedBy: plan.defectCodes,
      },
      acceptedAttempt,
      ...productSummary,
      defectCodes: mergeDefectCodes(
        eligibility.defectCodes,
        plan.defectCodes,
        ...productRows.map((row) => row.defectCodes),
      ),
      cells: productRows,
    };
    // A resumed job reads the decision it already recorded, so the gallery never describes a
    // different attempt than the artifact does.
    const decision = await stage(context, '75-product', [productPath], async () => {
      await atomicJson(productPath, product);
      return product;
    }) ?? product;
    // Acceptance is read from the decision that was actually recorded, so a resumed job
    // reports the attempt it shipped rather than recomputing a fresh verdict.
    applyProductEvidence(context, decision);

    await stage(context, '90-gallery', [galleryPath], async () => {
      const decidedRows = decision.cells ?? [];
      const summary = productAcceptanceSummary(decision);
      const acceptedRows = decidedRows.filter((row) => row.accepted === true);
      const accepted = new Set(acceptedRows.map((row) => row.cellId));
      const accepted2d = render2d.find((row) => row.status === 'complete' && accepted.has(row.cellId));
      const fallback2d = render2d.find((row) => row.status === 'complete' && eligible.has(row.cellId))
        ?? render2d.find((row) => row.status === 'complete');
      // An accepted cell names the directory its own render was written to, so a
      // promoted attempt is addressed where it lives instead of overwriting the
      // rejected attempt's artifacts.
      const headline = acceptedRows[0]?.renderDir
        ? `/artifacts/jobs/${job.jobId}/${acceptedRows[0].renderDir}/rollout.mp4`
        : accepted2d
          ? `/artifacts/jobs/${job.jobId}/60-render2d/${accepted2d.video}`
          : fallback2d
            ? `/artifacts/jobs/${job.jobId}/60-render2d/${fallback2d.video}`
            : null;
      const value = {
        id: job.jobId,
        jobId: job.jobId,
        brief: job.brief,
        engine: route.engine,
        methodology: job.methodology ?? 'custom',
        maps: [...new Set(cells.map((cell) => cell.mapId))],
        ambient: job.ambient,
        admitted: passing.size > 0,
        eligible: eligible.size,
        accepted: accepted.size > 0,
        semanticAccepted: decidedRows.some((row) => row.semanticAccepted === true),
        defectCodes: decision.defectCodes,
        unsupportedReason: decidedRows.find((row) => row.unsupportedReason)?.unsupportedReason ?? null,
        retry: decision.retry,
        acceptedAttempt: decision.acceptedAttempt ?? null,
        gate: { passed: passing.size, cells: gate.cells?.length ?? 0 },
        quality: { accepted: accepted.size, screened: summary.screenedCells },
        acceptance: {
          contract: contractIdentity(),
          ...summary,
        },
        benchmarkRecord: '95-benchmark.json',
        headline,
        render3d: job.render3d,
        timings: context.timings,
        createdAt: job.createdAt,
      };
      await atomicJson(galleryPath, value);
      return value;
    });
  }

  /**
   * Render one cell in 3D with a bounded transient retry, classifying any
   * failure into the deterministic namespace that owns it.
   */
  async render3dCell(context, cell, outDir) {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.render3d.run(() => renderCell(context, cell, outDir, {
          tier: '3d', composition: context.renderComposition,
        }));
        return { cellId: cell.cellId, status: 'complete', attempts: attempt };
      } catch (error) {
        lastError = error;
        const message = String(error?.message ?? error);
        // A lost GPU context is the transient the exporter now names outright;
        // it used to reach here as a blank capture. A fresh browser gets a fresh
        // context, which is exactly what a second attempt provides.
        const transient = /Execution context was destroyed|navigation|Target closed|ECONNRESET|fetch failed|is not capture-ready/i
          .test(message);
        if (!transient || attempt === 2) break;
      }
    }
    const message = String(lastError?.message ?? lastError);
    return {
      cellId: cell.cellId,
      status: 'error',
      error: message.slice(-1000),
      defectCodes: [classifyRenderFailure(message)],
    };
  }

  /**
   * Brief-aware semantic review of already rendered 2D schematic footage.
   * `items` pair a simulated cell with the exact render directory reviewed, so
   * repair rounds screen their own footage without touching the originals.
   */
  async reviewSemantic2d(context, job, briefPath, items) {
    return mapConcurrent(items, this.schedulerSettings.reviewConcurrency, async (item) => this.review.run(async () => {
      const result = await command(this.python, [
        this.bridge, 'semantic2d', '--brief', briefPath,
        '--render', item.renderDir, '--cell', item.cell.cellDir,
        '--cell-id', item.cell.cellId,
        '--request-text', job.requestedBrief ?? job.brief,
        '--model', REVIEW_MODEL,
        '--effort', REVIEW_EFFORT,
      ], {
        cwd: this.root,
        timeout: 600_000,
        env: { ...process.env, OPENAI_BASE_URL: 'http://127.0.0.1:4141/v1', OPENAI_API_KEY: 'x' },
        allowFailure: true,
      });
      const verdict = lastJsonLine(result.stdout);
      return verdict
        ? { status: 'complete', ...verdict }
        : { cellId: item.cell.cellId, status: 'error', semanticMatch: false, error: result.stderr.slice(-1000) };
    }));
  }
}
