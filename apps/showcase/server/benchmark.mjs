// Truthful stage-separated benchmark evidence.
//
// Every number produced here is either measured or `null`; nothing is imputed.
// Every rate carries its own denominator so a reader can never mistake a
// censored sample for a failed one. Operational failures (provider outages,
// renderer infrastructure crashes, host exhaustion) censor the attempt at the
// stage where they happened: earlier stage outcomes stay in their denominators,
// the failing stage and every later stage drop the attempt. That is what makes
// a provider outage unable to lower the generator yield.
//
// This module is pure: no filesystem, no network, no clock. Callers supply
// measurements; the module only arranges and summarises them.

import { createHash } from 'node:crypto';
import { DEFECT_CODE_VOCABULARY } from './review-contract.mjs';

export const ATTEMPT_RECORD_SCHEMA = 'showcase-benchmark-attempt/v1';
export const BENCHMARK_REPORT_SCHEMA = 'showcase-benchmark-report/v1';
export const ACCEPTANCE_SPLIT_SCHEMA = 'showcase-acceptance-split/v1';
export const TRAJECTORY_FINGERPRINT_VERSION = 'showcase-trajectory-fingerprint/v1';

/**
 * The generation funnel, in order. `phase: 'generator'` stages end at the 2D
 * semantic oracle: trace + gate + deterministic eligibility + brief-aware 2D
 * semantic match. `phase: 'product'` stages add the 3D render and product
 * review. Throughput is reported separately for the two phases because they
 * consume different hardware and fail for different reasons.
 */
export const FUNNEL_STAGES = Object.freeze([
  { id: 'submitted', label: 'attempt submitted', phase: 'generator', evidence: '00-brief.json' },
  { id: 'author-ok', label: 'author emitted a template', phase: 'generator', evidence: '20-author/template.json' },
  { id: 'contract-valid', label: 'template satisfies the semantic contract', phase: 'generator', evidence: '20-author/contract-verdict.json' },
  { id: 'cells-ok', label: 'simulation produced at least one trace', phase: 'generator', evidence: '40-cells/index.json' },
  { id: 'gate-pass', label: 'frozen gate admitted at least one cell', phase: 'generator', evidence: '50-gate.json' },
  { id: 'eligible', label: 'deterministic trace validity admitted at least one cell', phase: 'generator', evidence: '55-eligibility.json' },
  { id: '2d-ok', label: '2D render completed', phase: 'generator', evidence: '60-render2d/index.json' },
  { id: 'semantic-reviewed', label: 'blind 2D semantic review returned a verdict', phase: 'generator', evidence: '60-render2d/quality.json' },
  { id: 'semantic-2d', label: '2D schematic footage shows the requested semantics', phase: 'generator', evidence: '62-semantic2d.json' },
  { id: '3d-ok', label: '3D render completed', phase: 'product', evidence: '65-render3d/index.json' },
  { id: 'semantic-3d', label: '3D footage shows the requested semantics', phase: 'product', evidence: '70-judge.json' },
  { id: 'presentation', label: 'footage accepted for presentation', phase: 'product', evidence: '75-product.json' },
]);

export const FUNNEL_STAGE_IDS = Object.freeze(FUNNEL_STAGES.map((entry) => entry.id));

/**
 * Last generator stage: generator throughput is measured up to and including
 * this. The brief-aware 2D semantic verdict is the generation oracle -- it is
 * the last stage a generation attempt can fail on its own merits, and it is
 * decided before any 3D render is spent.
 */
export const GENERATOR_TERMINAL_STAGE = 'semantic-2d';

const STAGE_INDEX = new Map(FUNNEL_STAGES.map((entry, index) => [entry.id, index]));
const GENERATOR_TERMINAL_INDEX = STAGE_INDEX.get(GENERATOR_TERMINAL_STAGE);

/** Pipeline stages whose wall time is attributed to the generator phase. */
export const GENERATOR_PIPELINE_STAGES = Object.freeze([
  '00-brief', '10-route', '15-precheck', '20-author', '30-sites', '40-cells',
  '50-gate', '55-eligibility', '60-render2d', '62-semantic2d',
  '62-mutation-01', '62-mutation-02', '62-fallback-author',
]);

/**
 * Pipeline stages whose wall time is attributed to the product phase. The
 * deterministic product decision is cheap but is paid for by the product phase,
 * because it exists only to ration renders and reviews.
 */
export const PRODUCT_PIPELINE_STAGES = Object.freeze([
  '65-render3d', '70-judge',
  '80-presentation-retry', '75-product', '90-gallery',
]);

export const CASE_OUTCOMES = Object.freeze(['accepted', 'attempting', 'exhausted', 'unsupported', 'pending']);

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

const round = (value, digits) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * Wilson score interval at 95% confidence. Returns `null` when there is no
 * denominator: an interval over zero trials is not an interval, and reporting
 * `[0, 1]` would imply a measurement that was never taken.
 */
export function wilson95(successes, trials) {
  const k = Number(successes);
  const n = Number(trials);
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0 || k < 0 || k > n) return null;
  const z = 1.959963984540054;
  const zz = z * z;
  const centre = (k + zz / 2) / (n + zz);
  const halfWidth = (z / (n + zz)) * Math.sqrt((k * (n - k)) / n + zz / 4);
  return {
    low: round(Math.max(0, centre - halfWidth), 6),
    high: round(Math.min(1, centre + halfWidth), 6),
    z: round(z, 6),
  };
}

/**
 * A rate that can never be read without its denominator. `value` is `null`
 * exactly when `denominator === 0`, which is a measurement gap, not a zero.
 */
export function ratio(numerator, denominator) {
  const k = Number(numerator) || 0;
  const n = Number(denominator) || 0;
  return {
    numerator: k,
    denominator: n,
    value: n > 0 ? round(k / n, 6) : null,
    wilson95: wilson95(k, n),
  };
}

/** A per-hour rate; the denominator is the observation window, in hours. */
export function perHour(numerator, hours) {
  const k = Number(numerator) || 0;
  const h = Number(hours);
  return {
    numerator: k,
    denominatorHours: Number.isFinite(h) && h > 0 ? round(h, 6) : null,
    value: Number.isFinite(h) && h > 0 ? round(k / h, 4) : null,
  };
}

/**
 * Keep only real measurements. `Number(null)` is `0`, so an unmeasured value
 * would otherwise be summarised as a zero-second stage or a zero-token attempt.
 */
function measurements(values) {
  return (values ?? [])
    .filter((value) => value != null && value !== '' && typeof value !== 'boolean')
    .map(Number)
    .filter(Number.isFinite);
}

/** Linear-interpolated percentile over a finite sample; `null` when empty. */
export function percentile(values, quantile) {
  const sorted = measurements(values).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, quantile));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** Distribution summary; every field is `null` when nothing was measured. */
export function summarize(values, digits = 3) {
  const sample = measurements(values);
  if (sample.length === 0) {
    return { n: 0, min: null, p50: null, p90: null, max: null, mean: null, total: null };
  }
  const total = sample.reduce((sum, value) => sum + value, 0);
  return {
    n: sample.length,
    min: round(Math.min(...sample), digits),
    p50: round(percentile(sample, 0.5), digits),
    p90: round(percentile(sample, 0.9), digits),
    max: round(Math.max(...sample), digits),
    mean: round(total / sample.length, digits),
    total: round(total, digits),
  };
}

/** Shannon-entropy balance of a histogram, normalised to [0, 1]; `null` below two buckets. */
export function balance(counts) {
  const values = Object.values(counts ?? {}).map(Number).filter((value) => Number.isFinite(value) && value > 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.length < 2 || total <= 0) return null;
  const entropy = -values.reduce((sum, value) => {
    const p = value / total;
    return sum + p * Math.log(p);
  }, 0);
  return round(entropy / Math.log(values.length), 6);
}

// ---------------------------------------------------------------------------
// Defect vocabulary
// ---------------------------------------------------------------------------

/**
 * Defect codes come from `config/showcase-review-contract.json` by way of
 * `review-contract.mjs`, which attributes reviewer prose to a code under the
 * contract hash. This module therefore never re-attributes prose: a second
 * taxonomy beside the hashed one could disagree with the verdicts it is
 * summarising, and the disagreement would be invisible in the report.
 *
 * `judge.uncertain` is the contract's fallback code, so prose the contract could
 * not attribute is already visible as a code rather than silently swallowed. The
 * raw text is preserved per attempt in `outcome.unclassifiedDefects`.
 */
export const DEFECT_CODES = DEFECT_CODE_VOCABULARY;

/**
 * Which acceptance decision a code blocks, read from the code's contract
 * namespace: `scenario.*` and `judge.*` bear on whether the requested behaviour
 * happened, everything else on whether the footage shows it well enough to ship.
 */
export function defectClass(code) {
  const value = String(code ?? '');
  if (value.startsWith('scenario.') || value.startsWith('judge.')) return 'semantic';
  if (value.startsWith('simulation.') || value.startsWith('render.') || value.startsWith('capture.')) {
    return 'presentation';
  }
  return 'unclassified';
}

// ---------------------------------------------------------------------------
// Operational failure classification
// ---------------------------------------------------------------------------

/**
 * Operational failure classes. These are infrastructure outcomes, not generator
 * outcomes: an attempt that hits one of these was never given a fair chance to
 * succeed, so it is censored out of the denominator at the stage where it hit
 * and reported under `operational` instead.
 */
export const OPERATIONAL_CLASSES = Object.freeze([
  { class: 'model-access', pattern: /vision preflight failed|no credential available|usage limit|authentication_error|rate_limit_error|\bHTTP (?:401|403|429)\b|insufficient_quota|model access unavailable/i },
  { class: 'gateway-unavailable', pattern: /gateway unavailable|127\.0\.0\.1:4141|model gateway preflight failed|ECONNREFUSED/i },
  { class: 'provider-server-error', pattern: /\bHTTP 5\d\d\b|upstream error|bad gateway|service unavailable|overloaded_error|internal server error/i },
  { class: 'host-resource', pattern: /ENOSPC|ENOMEM|EMFILE|ENFILE|Cannot allocate memory|out of memory|JavaScript heap out of memory/i },
  { class: 'renderer-infrastructure', pattern: /Execution context was destroyed|Target closed|Protocol error|Session closed|browser (?:has )?(?:disconnected|closed)|WebGL context|GPU process|renderer captured an empty scene|Navigation failed/i },
  { class: 'submission', pattern: /submit .* failed|returned no jobId|submission outcome was not recoverable|fetch failed/i },
  { class: 'timeout', pattern: /ETIMEDOUT|\btimed out\b|timeout of \d+ms exceeded|SIGTERM/i },
]);

/**
 * Classify a failure message. `null` means the failure is attributable to the
 * generator and therefore belongs in the denominator.
 */
export function classifyOperational(value) {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return null;
  for (const entry of OPERATIONAL_CLASSES) {
    if (entry.pattern.test(text)) return { class: entry.class, detail: text.slice(-500) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Trajectory fingerprint and distance
// ---------------------------------------------------------------------------

/** Number of evenly spaced samples taken from every trace. */
export const TRAJECTORY_SAMPLES = 32;
const POSITION_QUANTUM_M = 0.25;
const SPEED_QUANTUM_MPS = 0.1;

const quantize = (value, step) => (Number.isFinite(value) ? Math.round(value / step) * step : null);

function resolveSubject(trace) {
  const header = trace?.header ?? {};
  const actors = trace?.ticks?.actors ?? {};
  if (typeof header.metricSubject === 'string' && actors[header.metricSubject]) return header.metricSubject;
  for (const [id, meta] of Object.entries(header.actorMetadata ?? {})) {
    if ((meta?.tags ?? []).includes('role:ego') && actors[id]) return id;
  }
  const ids = Object.keys(actors).sort();
  return ids[0] ?? null;
}

/**
 * Extract a fixed-length, quantised description of one trace.
 *
 * `path` is absolute (map frame) so two encodings of the same simulation agree
 * exactly and two different sites never agree. `shape` is the same path with the
 * first sample subtracted, which measures manoeuvre similarity independently of
 * where on the map it happened. Both are needed: absolute distance answers
 * "is this the same run?", shape distance answers "is this the same manoeuvre?".
 *
 * Returns `null` when the trace has no usable subject track: an unmeasurable
 * fingerprint must stay unmeasured rather than collapse onto a shared constant.
 */
export function trajectoryFeatures(trace) {
  const subject = resolveSubject(trace);
  const track = subject ? trace?.ticks?.actors?.[subject] : null;
  const times = Array.isArray(trace?.ticks?.t) ? trace.ticks.t : [];
  const xs = Array.isArray(track?.x) ? track.x : [];
  const ys = Array.isArray(track?.y) ? track.y : [];
  if (!subject || times.length === 0 || xs.length === 0 || ys.length === 0) return null;
  const usable = Math.min(times.length, xs.length, ys.length);
  const speeds = Array.isArray(track?.speedMps) ? track.speedMps : [];
  const headings = Array.isArray(track?.headingRad) ? track.headingRad : [];
  const path = [];
  const speed = [];
  const heading = [];
  for (let index = 0; index < TRAJECTORY_SAMPLES; index += 1) {
    const at = TRAJECTORY_SAMPLES === 1
      ? 0
      : Math.round((index * (usable - 1)) / (TRAJECTORY_SAMPLES - 1));
    path.push(quantize(Number(xs[at]), POSITION_QUANTUM_M), quantize(Number(ys[at]), POSITION_QUANTUM_M));
    speed.push(quantize(Number(speeds[at]), SPEED_QUANTUM_MPS));
    heading.push(quantize(Number(headings[at]), 0.01));
  }
  const originX = path[0];
  const originY = path[1];
  const shape = path.map((value, index) => (value == null ? null
    : round(value - (index % 2 === 0 ? originX : originY), 4)));
  let pathLengthM = 0;
  for (let index = 1; index < usable; index += 1) {
    const dx = Number(xs[index]) - Number(xs[index - 1]);
    const dy = Number(ys[index]) - Number(ys[index - 1]);
    if (Number.isFinite(dx) && Number.isFinite(dy)) pathLengthM += Math.hypot(dx, dy);
  }
  const actorKinds = {};
  for (const meta of Object.values(trace?.header?.actorMetadata ?? {})) {
    const kind = typeof meta?.kind === 'string' ? meta.kind : 'unknown';
    actorKinds[kind] = (actorKinds[kind] ?? 0) + 1;
  }
  const eventKinds = {};
  for (const event of trace?.events ?? []) {
    const kind = typeof event?.kind === 'string' ? event.kind : 'unknown';
    eventKinds[kind] = (eventKinds[kind] ?? 0) + 1;
  }
  return {
    version: TRAJECTORY_FINGERPRINT_VERSION,
    subject,
    samples: TRAJECTORY_SAMPLES,
    positionQuantumM: POSITION_QUANTUM_M,
    speedQuantumMps: SPEED_QUANTUM_MPS,
    path,
    shape,
    speed,
    heading,
    pathLengthM: round(pathLengthM, 3),
    netDisplacementM: round(Math.hypot(
      Number(xs[usable - 1]) - Number(xs[0]),
      Number(ys[usable - 1]) - Number(ys[0]),
    ), 3),
    clipSeconds: Number.isFinite(Number(trace?.header?.clipSeconds)) ? Number(trace.header.clipSeconds) : null,
    actorKinds,
    eventKinds,
  };
}

/**
 * Content hash of the quantised trace description. Re-encoding an MP4 cannot
 * change this, which is exactly why diversity is keyed on it rather than on the
 * video digest.
 */
export function trajectoryFingerprint(features) {
  if (!features) return null;
  const canonical = JSON.stringify([
    features.version, features.samples, features.positionQuantumM, features.speedQuantumMps,
    features.path, features.speed, features.heading,
    Object.entries(features.actorKinds ?? {}).sort(),
    Object.entries(features.eventKinds ?? {}).sort(),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

function vectorDistance(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return null;
  let sum = 0;
  let pairs = 0;
  for (let index = 0; index + 1 < left.length; index += 2) {
    const ax = left[index];
    const ay = left[index + 1];
    const bx = right[index];
    const by = right[index + 1];
    if (![ax, ay, bx, by].every((value) => Number.isFinite(value))) continue;
    sum += Math.hypot(ax - bx, ay - by);
    pairs += 1;
  }
  return pairs > 0 ? round(sum / pairs, 4) : null;
}

function scalarDistance(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return null;
  let sum = 0;
  let pairs = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (!Number.isFinite(left[index]) || !Number.isFinite(right[index])) continue;
    sum += (left[index] - right[index]) ** 2;
    pairs += 1;
  }
  return pairs > 0 ? round(Math.sqrt(sum / pairs), 4) : null;
}

/**
 * Distance between two trace descriptions. All three components are `0` for two
 * encodings of the same simulation, which is the property the diversity claim
 * rests on.
 */
export function trajectoryDistance(left, right) {
  if (!left || !right) return null;
  return {
    absoluteM: vectorDistance(left.path, right.path),
    shapeM: vectorDistance(left.shape, right.shape),
    speedMps: scalarDistance(left.speed, right.speed),
  };
}

// ---------------------------------------------------------------------------
// Diversity
// ---------------------------------------------------------------------------

const histogram = (values) => {
  const counts = {};
  for (const value of values) {
    const key = value == null ? 'unknown' : String(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

/**
 * Trace-level diversity of the accepted footage.
 *
 * `videos` entries: `{ sha256, cellId, mapId, siteId, trajectoryFingerprint, trajectoryFeatures }`.
 * `mapUniverse` is the number of maps the campaign could have drawn from, so
 * `maps.coverage` has a real denominator.
 */
export function buildDiversity(videos, { mapUniverse = null } = {}) {
  const rows = (videos ?? []).filter(Boolean);
  const digests = new Set();
  const fingerprints = new Set();
  const byFingerprint = new Map();
  let unfingerprinted = 0;
  for (const row of rows) {
    if (typeof row.sha256 === 'string') digests.add(row.sha256);
    const fingerprint = row.trajectoryFingerprint;
    if (typeof fingerprint === 'string' && fingerprint) {
      fingerprints.add(fingerprint);
      if (!byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, []);
      byFingerprint.get(fingerprint).push(row);
    } else {
      unfingerprinted += 1;
    }
  }
  const reencodedGroups = [...byFingerprint.entries()]
    .map(([fingerprint, group]) => ({
      trajectoryFingerprint: fingerprint,
      videos: group.length,
      distinctVideoSha256: new Set(group.map((row) => row.sha256)).size,
      cellIds: group.map((row) => row.cellId ?? null),
    }))
    .filter((group) => group.distinctVideoSha256 > 1)
    .sort((left, right) => right.videos - left.videos);
  const withFeatures = rows.filter((row) => row.trajectoryFeatures);
  const absolute = [];
  const shape = [];
  const speed = [];
  for (let i = 0; i < withFeatures.length; i += 1) {
    for (let j = i + 1; j < withFeatures.length; j += 1) {
      const distance = trajectoryDistance(withFeatures[i].trajectoryFeatures, withFeatures[j].trajectoryFeatures);
      if (!distance) continue;
      if (distance.absoluteM != null) absolute.push(distance.absoluteM);
      if (distance.shapeM != null) shape.push(distance.shapeM);
      if (distance.speedMps != null) speed.push(distance.speedMps);
    }
  }
  const mapCounts = histogram(rows.map((row) => row.mapId ?? null));
  const siteCounts = histogram(rows.map((row) => (row.mapId && row.siteId ? `${row.mapId}:${row.siteId}` : null)));
  const distinctMaps = Object.keys(mapCounts).filter((key) => key !== 'unknown').length;
  return {
    videos: rows.length,
    distinctVideoSha256: digests.size,
    distinctTrajectoryFingerprints: fingerprints.size,
    unfingerprintedVideos: unfingerprinted,
    trajectoryDistinctness: ratio(fingerprints.size, rows.length - unfingerprinted),
    videoDigestDistinctness: ratio(digests.size, rows.length),
    reencodedOnlyGroups: reencodedGroups,
    reencodedOnlyVideos: reencodedGroups.reduce((sum, group) => sum + group.videos - 1, 0),
    maps: {
      distinct: distinctMaps,
      coverage: mapUniverse ? ratio(distinctMaps, mapUniverse) : null,
      balance: balance(mapCounts),
      histogram: mapCounts,
    },
    sites: {
      distinct: Object.keys(siteCounts).filter((key) => key !== 'unknown').length,
      perVideo: ratio(Object.keys(siteCounts).filter((key) => key !== 'unknown').length, rows.length),
      balance: balance(siteCounts),
      histogram: siteCounts,
    },
    pairwise: {
      pairs: absolute.length,
      absoluteM: summarize(absolute),
      shapeM: summarize(shape),
      speedMps: summarize(speed),
    },
    note: 'Diversity is keyed on the quantised trace fingerprint, never on the MP4 digest: '
      + 're-encoding one simulation yields a new video hash but the same fingerprint and zero trajectory distance.',
  };
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

/**
 * Attempt records are censored, not failed, at the stage where an operational
 * failure occurred. `censoredAtStage` names that stage; `null` means the attempt
 * ran to a generator-attributable outcome.
 */
function censorIndex(record) {
  const stage = record?.outcome?.censoredAtStage;
  return typeof stage === 'string' && STAGE_INDEX.has(stage) ? STAGE_INDEX.get(stage) : null;
}

function reachedStage(record, stageId) {
  return record?.funnel?.[stageId] === true;
}

/**
 * Does this attempt belong in the denominator for `stageIndex`?
 * It must have reached the previous stage, and must not have been censored at or
 * before `stageIndex` — a censored attempt has no observed outcome there.
 */
function inDenominator(record, stageIndex) {
  if (stageIndex > 0 && !reachedStage(record, FUNNEL_STAGE_IDS[stageIndex - 1])) return false;
  const censored = censorIndex(record);
  return censored == null || censored > stageIndex;
}

/** Attempts whose generator outcome (through trace + gate) was actually observed. */
export function generatorAttempts(records) {
  return (records ?? []).filter((record) => {
    const censored = censorIndex(record);
    return censored == null || censored > GENERATOR_TERMINAL_INDEX;
  });
}

/** Attempts whose full product outcome (render + review) was actually observed. */
export function productAttempts(records) {
  return (records ?? []).filter((record) => censorIndex(record) == null);
}

/** Attempts censored by an operational failure at any stage. */
export function operationalFailures(records) {
  return (records ?? []).filter((record) => censorIndex(record) != null);
}

/**
 * Stage-by-stage funnel with an explicit denominator on every row.
 * `stepRate` converts from the previous stage; `cumulativeRate` is against all
 * attempts still uncensored at that stage.
 */
export function buildFunnel(records) {
  const all = records ?? [];
  const stages = FUNNEL_STAGES.map((stage, index) => {
    const eligible = all.filter((record) => inDenominator(record, index));
    const reached = eligible.filter((record) => reachedStage(record, stage.id));
    const censoredHere = all.filter((record) => censorIndex(record) === index);
    return {
      id: stage.id,
      label: stage.label,
      phase: stage.phase,
      evidence: stage.evidence,
      reached: reached.length,
      denominator: eligible.length,
      denominatorStage: index === 0 ? 'submitted attempts' : FUNNEL_STAGE_IDS[index - 1],
      stepRate: ratio(reached.length, eligible.length),
      censoredHere: censoredHere.length,
    };
  });
  const generator = generatorAttempts(all);
  const product = productAttempts(all);
  for (const [index, stage] of stages.entries()) {
    const base = FUNNEL_STAGES[index].phase === 'generator' ? generator : product;
    stage.cumulativeRate = ratio(stage.reached, base.length);
    stage.cumulativeDenominatorLabel = FUNNEL_STAGES[index].phase === 'generator'
      ? 'generator attempts (uncensored through gate-pass)'
      : 'product attempts (uncensored end to end)';
  }
  const monotone = stages.every((stage, index) => index === 0 || stage.reached <= stages[index - 1].reached);
  return {
    stages,
    monotone,
    denominators: {
      submittedAttempts: all.length,
      generatorAttempts: generator.length,
      productAttempts: product.length,
      operationalFailures: operationalFailures(all).length,
    },
    note: 'An attempt censored by an operational failure keeps the stage outcomes observed before the '
      + 'failure and is removed from the failing stage onward, so infrastructure outages cannot lower a '
      + 'generator conversion rate.',
  };
}

// ---------------------------------------------------------------------------
// Throughput
// ---------------------------------------------------------------------------

function stageWallSummary(records, stageNames) {
  const summary = {};
  for (const name of stageNames) {
    const values = records
      .map((record) => (record.stages ?? []).find((stage) => stage.name === name)?.wallS)
      .filter((value) => Number.isFinite(Number(value)))
      .map(Number);
    summary[name] = summarize(values);
  }
  return summary;
}

const tokenTotal = (records, key) => records.reduce(
  (sum, record) => sum + (Number(record?.cost?.tokens?.[key]) || 0), 0,
);

/**
 * Generator and product throughput, reported separately.
 *
 * Generator throughput measures work that ends at trace + frozen gate +
 * deterministic eligibility — everything decided before a render is spent.
 * Product throughput measures the same attempts carried through render, review,
 * and the deterministic product decision. The two never share a denominator,
 * because a provider outage removes attempts from the second without touching
 * the first.
 */
export function buildThroughput(records, { elapsedHours = null } = {}) {
  const generator = generatorAttempts(records);
  const product = productAttempts(records);
  const gatePassed = generator.filter((record) => reachedStage(record, 'gate-pass'));
  const eligible = generator.filter((record) => reachedStage(record, 'eligible'));
  const semantic2d = generator.filter((record) => reachedStage(record, 'semantic-2d'));
  const presented = product.filter((record) => reachedStage(record, 'presentation'));
  const semantic3d = product.filter((record) => reachedStage(record, 'semantic-3d'));
  const generatorWall = generator
    .map((record) => Number(record?.cost?.generatorWallS))
    .filter(Number.isFinite);
  const productWall = product
    .map((record) => Number(record?.cost?.productWallS))
    .filter(Number.isFinite);
  const totalWall = product.map((record) => Number(record?.cost?.wallS)).filter(Number.isFinite);
  const acceptedCells = product.reduce((sum, record) => sum + (Number(record?.counts?.presentationAccepted) || 0), 0);
  const gateCells = generator.reduce((sum, record) => sum + (Number(record?.counts?.gatePassed) || 0), 0);
  const eligibleCells = generator.reduce((sum, record) => sum + (Number(record?.counts?.eligibleCells) || 0), 0);
  return {
    elapsedHours: Number.isFinite(Number(elapsedHours)) ? round(Number(elapsedHours), 4) : null,
    generator: {
      boundary: `stages 00-brief through the 62-* semantic loop, ending at funnel stage ${GENERATOR_TERMINAL_STAGE} `
        + '(trace + frozen gate + deterministic trace validity + brief-aware 2D semantic match)',
      attempts: generator.length,
      gatePassedAttempts: gatePassed.length,
      gatePassedCells: gateCells,
      eligibleAttempts: eligible.length,
      eligibleCells,
      semantic2dAttempts: semantic2d.length,
      yield: ratio(semantic2d.length, generator.length),
      eligibleYield: ratio(eligible.length, generator.length),
      gateYield: ratio(gatePassed.length, generator.length),
      wallS: summarize(generatorWall),
      stageWallS: stageWallSummary(generator, GENERATOR_PIPELINE_STAGES),
      attemptsPerHour: perHour(generator.length, elapsedHours),
      gatePassedAttemptsPerHour: perHour(gatePassed.length, elapsedHours),
      eligibleAttemptsPerHour: perHour(eligible.length, elapsedHours),
      eligibleCellsPerHour: perHour(eligibleCells, elapsedHours),
      semantic2dAttemptsPerHour: perHour(semantic2d.length, elapsedHours),
      tokensPerSemanticAttempt: semantic2d.length
        ? Math.round((tokenTotal(generator, 'inputTokens') + tokenTotal(generator, 'outputTokens')) / semantic2d.length)
        : null,
      tokensPerEligibleAttempt: eligible.length
        ? Math.round((tokenTotal(generator, 'inputTokens') + tokenTotal(generator, 'outputTokens')) / eligible.length)
        : null,
    },
    product: {
      boundary: 'all generator stages plus 65-render3d, 70-judge, the stage-local 80-* retry, '
        + 'and the deterministic 75-product decision',
      attempts: product.length,
      semantic3dAttempts: semantic3d.length,
      presentationAcceptedAttempts: presented.length,
      presentationAcceptedCells: acceptedCells,
      yield: ratio(presented.length, product.length),
      wallS: summarize(totalWall),
      renderReviewWallS: summarize(productWall),
      stageWallS: stageWallSummary(product, PRODUCT_PIPELINE_STAGES),
      attemptsPerHour: perHour(product.length, elapsedHours),
      presentationAcceptedAttemptsPerHour: perHour(presented.length, elapsedHours),
      presentationAcceptedCellsPerHour: perHour(acceptedCells, elapsedHours),
      tokensPerAcceptedCell: acceptedCells
        ? Math.round((tokenTotal(product, 'inputTokens') + tokenTotal(product, 'outputTokens')) / acceptedCells)
        : null,
    },
    note: 'Generator throughput ends at the brief-aware 2D semantic verdict, the last verdict reached before '
      + 'a 3D render is spent. Product throughput adds the 3D render, product review, and the product decision, '
      + 'so its denominator is smaller whenever renderer or provider infrastructure censored an attempt.',
  };
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

const sumField = (records, path) => records.reduce((sum, record) => {
  const value = path.reduce((node, key) => (node == null ? null : node[key]), record);
  return sum + (Number(value) || 0);
}, 0);

/** Aggregate measured cost. CPU and GPU carry their attribution, never an implied exclusivity. */
export function buildCost(records) {
  const all = records ?? [];
  const cpu = all.map((record) => Number(record?.cost?.cpu?.totalS)).filter(Number.isFinite);
  const gpu = all.map((record) => Number(record?.cost?.gpu?.gpuSecondsEquivalent)).filter(Number.isFinite);
  const exclusiveCpu = all.filter((record) => record?.cost?.cpu?.attribution === 'exclusive').length;
  return {
    wallS: summarize(all.map((record) => Number(record?.cost?.wallS)).filter(Number.isFinite)),
    tokens: {
      calls: sumField(all, ['cost', 'tokens', 'calls']),
      inputTokens: sumField(all, ['cost', 'tokens', 'inputTokens']),
      outputTokens: sumField(all, ['cost', 'tokens', 'outputTokens']),
      reasoningTokens: sumField(all, ['cost', 'tokens', 'reasoningTokens']),
      modelWallS: round(sumField(all, ['cost', 'tokens', 'modelWallS']), 3),
      dollarCost: null,
      dollarCostNote: 'No price table is available to this runner, so spend stays unmeasured rather than estimated.',
    },
    cpu: {
      measuredAttempts: cpu.length,
      totalS: summarize(cpu),
      exclusivelyAttributedAttempts: exclusiveCpu,
      attributionNote: 'CPU seconds come from process self time plus reaped-child time. When more than one '
        + 'attempt shared the process the sample is process-wide, flagged attribution "process-shared".',
    },
    gpu: {
      measuredAttempts: gpu.length,
      gpuSecondsEquivalent: summarize(gpu),
      attributionNote: 'GPU seconds are utilisation samples integrated over the attempt window and are '
        + 'host-wide: they are not attributable to a single attempt when attempts overlap.',
    },
  };
}

// ---------------------------------------------------------------------------
// Execution conditions
// ---------------------------------------------------------------------------

/**
 * The conditions the measurements were taken under.
 *
 * Every cost number in this report is only comparable against another number
 * taken under the same conditions, so the conditions are reported beside them
 * rather than assumed: whether the attempt paid a cold process start, how many
 * attempts shared the host, and which models produced the evidence. A condition
 * an attempt never recorded is counted under `unknown` rather than dropped, so
 * the histograms always sum to the attempts they describe.
 */
export function buildExecution(records) {
  const all = records ?? [];
  const declaredCold = all.filter((record) => typeof record?.execution?.cold === 'boolean');
  const declaredResumed = all.filter((record) => typeof record?.execution?.resumed === 'boolean');
  return {
    attempts: all.length,
    cold: {
      ...ratio(declaredCold.filter((record) => record.execution.cold === true).length, declaredCold.length),
      basis: [...new Set(all.map((record) => record?.execution?.coldWarmBasis).filter(Boolean))].sort(),
      note: 'A cold attempt is the first job of its runner process. Its stage wall times include process '
        + 'and import warm-up that no later attempt pays, so cold and warm attempts are not '
        + 'interchangeable samples of the same stage.',
    },
    resumed: {
      ...ratio(declaredResumed.filter((record) => record.execution.resumed === true).length, declaredResumed.length),
      stages: histogram(all.flatMap((record) => record?.execution?.resumedStages ?? [])),
      note: 'A resumed attempt reused artifacts an earlier attempt paid for. Those stages carry a null '
        + 'wall time and are absent from every duration denominator.',
    },
    concurrency: {
      activeJobsAtStart: summarize(all.map((record) => record?.concurrency?.activeJobsAtStart)),
      peakActiveJobs: summarize(all.map((record) => record?.concurrency?.peakActiveJobs)),
      logicalCpus: histogram(all.map((record) => record?.concurrency?.logicalCpus)),
      load1AtStart: summarize(all.map((record) => record?.concurrency?.load1AtStart), 2),
      load1AtSimulation: summarize(all.map((record) => record?.concurrency?.load1AtSimulation), 2),
      scheduler: histogram(all.map((record) => {
        const scheduler = record?.concurrency?.scheduler;
        if (!scheduler || typeof scheduler !== 'object') return null;
        return JSON.stringify(Object.fromEntries(Object.entries(scheduler).sort(([a], [b]) => a.localeCompare(b))));
      })),
      note: 'Attempts that overlap on one host contend for CPU and GPU. Wherever more than one attempt was '
        + 'active, per-attempt CPU is process-shared and the GPU sample is host-wide.',
    },
    models: {
      author: histogram(all.map((record) => {
        const author = record?.models?.author;
        return author?.model ? `${author.model}/${author.effort ?? 'default'}` : null;
      })),
      judge: histogram(all.map((record) => {
        const judge = record?.models?.judge;
        return judge?.model ? `${judge.model}/${judge.effort ?? 'default'}/${judge.strategy ?? 'default'}` : null;
      })),
      engineRequested: histogram(all.map((record) => record?.models?.engineRequested)),
      engineResolved: histogram(all.map((record) => record?.models?.engineResolved)),
      productReviewVersion: histogram(all.map((record) => record?.models?.productReviewVersion)),
      note: 'Token and wall-time costs are only comparable within one model, effort, and review version. '
        + 'A histogram with more than one key means the aggregate mixes them.',
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic unsupported reasons
// ---------------------------------------------------------------------------

export const UNSUPPORTED_REASONS = Object.freeze({
  'precheck-infeasible': 'Structural precheck reports that the brief needs primitives the map inventory does not provide.',
  'no-matching-sites': 'The authored template matched no site on any campaign map.',
  'contract-unsatisfiable': 'Every author attempt violated the same executable semantic contract obligations.',
  'gate-unreachable': 'Every simulated cell failed the same frozen-gate criterion.',
});

/**
 * The terminal deterministic cause of one attempt, or `null` when the attempt
 * ended for a non-deterministic reason (or succeeded).
 * `evidence` makes the grouping key explicit so two attempts only agree when
 * they failed on the same thing, not merely at the same stage.
 */
export function attemptDeterminism(record) {
  if (!record || censorIndex(record) != null) return null;
  const precheck = record.precheck ?? {};
  if (precheck.feasible === false && Array.isArray(precheck.missing) && precheck.missing.length > 0) {
    return { reason: 'precheck-infeasible', evidence: [...precheck.missing].map(String).sort() };
  }
  if (record.funnel?.['contract-valid'] === true && Number(record.counts?.sitesMatched) === 0) {
    return { reason: 'no-matching-sites', evidence: [...(record.maps ?? [])].map(String).sort() };
  }
  if (record.funnel?.['author-ok'] === true && record.funnel?.['contract-valid'] !== true) {
    const failures = (record.contractFailures ?? []).map((failure) => String(
      typeof failure === 'string' ? failure : failure?.path ?? failure?.kind ?? JSON.stringify(failure),
    ));
    if (failures.length > 0) return { reason: 'contract-unsatisfiable', evidence: [...new Set(failures)].sort() };
  }
  if (record.funnel?.['cells-ok'] === true && record.funnel?.['gate-pass'] !== true) {
    const criteria = new Set((record.cells ?? []).map((cell) => cell?.gateFirstFailure).filter(Boolean).map(String));
    if (criteria.size === 1) return { reason: 'gate-unreachable', evidence: [...criteria] };
  }
  return null;
}

/**
 * A case is unsupported only when independent attempts agree deterministically:
 * the same reason with the same evidence, at least `minimumAgreeingAttempts`
 * times, from attempts that were not censored. One flake never marks a case
 * unsupported.
 */
export function deterministicUnsupportedReason(records, { minimumAgreeingAttempts = 2 } = {}) {
  const groups = new Map();
  for (const record of records ?? []) {
    const determinism = attemptDeterminism(record);
    if (!determinism) continue;
    const key = `${determinism.reason}\u0000${determinism.evidence.join('\u0001')}`;
    if (!groups.has(key)) groups.set(key, { ...determinism, attempts: [] });
    groups.get(key).attempts.push(record.campaign?.attempt ?? record.jobId ?? null);
  }
  const agreeing = [...groups.values()]
    .filter((group) => group.attempts.length >= minimumAgreeingAttempts)
    .sort((left, right) => right.attempts.length - left.attempts.length
      || left.reason.localeCompare(right.reason));
  const winner = agreeing[0];
  if (!winner) return null;
  return {
    reason: winner.reason,
    detail: UNSUPPORTED_REASONS[winner.reason],
    evidence: winner.evidence,
    agreeingAttempts: winner.attempts.length,
    attempts: winner.attempts,
    minimumAgreeingAttempts,
  };
}

// ---------------------------------------------------------------------------
// Case outcomes
// ---------------------------------------------------------------------------

/**
 * Exactly one of `CASE_OUTCOMES` for every entry, so the corpus is always fully
 * accounted for:
 *   accepted    — the acceptance target is met
 *   attempting  — attempts are live or budget remains
 *   exhausted   — the generation-attempt budget is spent without reaching the target
 *   unsupported — repeated attempts agree on a deterministic blocker
 *   pending     — nothing has been attempted yet
 *
 * Exhaustion is decided by `unproductiveStreak`, matching the campaign runner:
 * the budget counts *consecutive* unproductive generation attempts, so a case
 * that produced a video and then regressed is not retired for its history, and
 * operational failures — which are not generation attempts — never consume it.
 */
export function caseOutcome({
  acceptedVideos = 0,
  target = 1,
  submittedAttempts = 0,
  activeAttempts = 0,
  unproductiveStreak = 0,
  maxGenerationAttempts = null,
  unsupportedReason = null,
} = {}) {
  if (acceptedVideos >= target) return 'accepted';
  if (activeAttempts > 0) return 'attempting';
  if (unsupportedReason) return 'unsupported';
  if (submittedAttempts === 0) return 'pending';
  if (Number.isInteger(maxGenerationAttempts) && unproductiveStreak >= maxGenerationAttempts) return 'exhausted';
  return 'attempting';
}

/** A case is resolved when no further attempt can change its outcome. */
export function caseResolved(outcome) {
  return outcome === 'accepted' || outcome === 'exhausted' || outcome === 'unsupported';
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Assemble the campaign benchmark block.
 *
 * `cases` entries: `{ id, title, index, priority, target, acceptedVideos,
 * submittedAttempts, activeAttempts, unproductiveStreak, operationalFailures,
 * records, videos }` where `records` are the per-attempt benchmark records for
 * that case. `unproductiveStreak` and `operationalFailures` come from the
 * campaign runner's own accounting, so the report cannot disagree with the
 * scheduler about which cases are retired.
 */
export function buildBenchmarkReport({
  campaignId,
  generatedAt,
  cases = [],
  target = 1,
  maxGenerationAttempts = null,
  elapsedHours = null,
  mapUniverse = null,
  minimumAgreeingAttempts = 2,
} = {}) {
  const allRecords = cases.flatMap((item) => item.records ?? []);
  const allVideos = cases.flatMap((item) => item.videos ?? []);
  const caseRows = cases.map((item) => {
    const records = item.records ?? [];
    const unsupported = deterministicUnsupportedReason(records, { minimumAgreeingAttempts });
    const generator = generatorAttempts(records);
    const acceptedVideos = Number(item.acceptedVideos ?? (item.videos ?? []).length) || 0;
    const caseTarget = Number(item.target ?? target) || target;
    const outcome = caseOutcome({
      acceptedVideos,
      target: caseTarget,
      submittedAttempts: Number(item.submittedAttempts ?? records.length) || 0,
      activeAttempts: Number(item.activeAttempts ?? 0) || 0,
      unproductiveStreak: Number(item.unproductiveStreak ?? 0) || 0,
      maxGenerationAttempts,
      unsupportedReason: unsupported?.reason ?? null,
    });
    const furthest = records
      .map((record) => FUNNEL_STAGE_IDS.reduce(
        (best, stageId, index) => (record?.funnel?.[stageId] === true ? index : best), -1,
      ))
      .reduce((best, value) => Math.max(best, value), -1);
    return {
      id: item.id,
      title: item.title ?? null,
      index: Number.isInteger(item.index) ? item.index : null,
      priority: Number.isInteger(item.priority) ? item.priority : null,
      outcome,
      resolved: caseResolved(outcome),
      target: caseTarget,
      acceptedVideos,
      submittedAttempts: Number(item.submittedAttempts ?? records.length) || 0,
      generationAttempts: generator.length,
      operationalFailures: Number.isInteger(item.operationalFailures)
        ? item.operationalFailures
        : operationalFailures(records).length,
      activeAttempts: Number(item.activeAttempts ?? 0) || 0,
      attemptBudget: maxGenerationAttempts,
      furthestStage: furthest >= 0 ? FUNNEL_STAGE_IDS[furthest] : null,
      semanticAccepted: records.some((record) => record?.funnel?.['semantic-3d'] === true),
      presentationAccepted: records.some((record) => record?.funnel?.presentation === true),
      defectCodes: [...new Set(records.flatMap((record) => record?.outcome?.defectCodes ?? []))].sort(),
      unsupportedReason: unsupported?.reason ?? null,
      unsupported,
    };
  });
  const outcomeCounts = Object.fromEntries(CASE_OUTCOMES.map((outcome) => [
    outcome, caseRows.filter((row) => row.outcome === outcome).length,
  ]));
  const operationalByClass = {};
  for (const record of operationalFailures(allRecords)) {
    const key = record?.outcome?.operational?.class ?? 'unknown';
    operationalByClass[key] = (operationalByClass[key] ?? 0) + 1;
  }
  const funnel = buildFunnel(allRecords);
  const defectCounts = {};
  for (const record of allRecords) {
    for (const code of record?.outcome?.defectCodes ?? []) {
      defectCounts[code] = (defectCounts[code] ?? 0) + 1;
    }
  }
  const coverageDenominator = caseRows.length;
  const qualityDenominator = caseRows.filter((row) => row.outcome !== 'unsupported').length;
  return {
    schema: BENCHMARK_REPORT_SCHEMA,
    campaignId: campaignId ?? null,
    generatedAt: generatedAt ?? null,
    corpus: {
      entries: caseRows.length,
      reported: caseRows.length,
      outcomes: outcomeCounts,
      accountedFor: Object.values(outcomeCounts).reduce((sum, value) => sum + value, 0) === caseRows.length,
      resolved: caseRows.filter((row) => row.resolved).length,
      attemptBudgetPerCase: maxGenerationAttempts,
      note: 'Every entry holds exactly one of accepted, attempting, exhausted, unsupported, or pending. '
        + 'The attempt budget counts consecutive unproductive generation attempts, so operational '
        + 'failures never consume it.',
    },
    denominators: {
      corpusEntries: coverageDenominator,
      coverageDenominator,
      qualityDenominator,
      submittedAttempts: allRecords.length,
      generatorAttempts: generatorAttempts(allRecords).length,
      productAttempts: productAttempts(allRecords).length,
      operationalFailures: operationalFailures(allRecords).length,
      note: 'Unsupported entries stay in the coverage denominator (the corpus is always fully reported) and '
        + 'leave the quality denominator, because a blocker the generator cannot reach is not a quality miss.',
    },
    coverage: {
      entriesReported: ratio(caseRows.length, coverageDenominator),
      accepted: ratio(outcomeCounts.accepted, coverageDenominator),
      unsupported: ratio(outcomeCounts.unsupported, coverageDenominator),
      attemptedOrResolved: ratio(
        caseRows.filter((row) => row.outcome !== 'pending').length, coverageDenominator,
      ),
    },
    quality: {
      acceptedOfSupported: ratio(outcomeCounts.accepted, qualityDenominator),
      semanticAcceptedOfSupported: ratio(
        caseRows.filter((row) => row.outcome !== 'unsupported' && row.semanticAccepted).length,
        qualityDenominator,
      ),
      presentationAcceptedOfSupported: ratio(
        caseRows.filter((row) => row.outcome !== 'unsupported' && row.presentationAccepted).length,
        qualityDenominator,
      ),
    },
    funnel,
    throughput: buildThroughput(allRecords, { elapsedHours }),
    cost: buildCost(allRecords),
    execution: buildExecution(allRecords),
    diversity: buildDiversity(allVideos, { mapUniverse }),
    operational: {
      attempts: operationalFailures(allRecords).length,
      byClass: operationalByClass,
      shareOfSubmitted: ratio(operationalFailures(allRecords).length, allRecords.length),
      excludedFromGenerationDenominator: true,
      note: 'Reported in full, censored from the stage where each failure happened onward.',
    },
    defects: {
      taxonomy: 'config/showcase-review-contract.json',
      vocabulary: DEFECT_CODES,
      attemptsByCode: defectCounts,
      // Codes outside the contract vocabulary mean a report is summarising verdicts from a
      // different contract than this runner loaded. That is surfaced, never folded away.
      unknownCodes: Object.keys(defectCounts).filter((code) => !DEFECT_CODES.includes(code)).sort(),
      unclassifiedAttempts: allRecords
        .filter((record) => (record?.outcome?.unclassifiedDefects ?? []).length > 0).length,
      note: 'Codes are attributed by the hashed review contract, not by this module. '
        + 'unclassifiedAttempts counts attempts whose reviewer prose the contract could not '
        + 'attribute; the prose itself is kept verbatim on each attempt record.',
    },
    unsupported: caseRows.filter((row) => row.unsupported).map((row) => ({
      id: row.id,
      title: row.title,
      ...row.unsupported,
    })),
    cases: caseRows.map(({ unsupported: _unsupported, ...row }) => row),
  };
}

/**
 * Invariants a truthful report must satisfy. Returns the list of violations;
 * empty means the report is internally consistent.
 */
export function verifyBenchmarkReport(report, { expectedEntries = null } = {}) {
  const violations = [];
  if (report?.schema !== BENCHMARK_REPORT_SCHEMA) {
    violations.push(`schema is ${JSON.stringify(report?.schema ?? null)}, expected ${BENCHMARK_REPORT_SCHEMA}`);
  }
  const walk = (node, path) => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    const hasValue = Object.hasOwn(node, 'value');
    const hasDenominator = Object.hasOwn(node, 'denominator') || Object.hasOwn(node, 'denominatorHours');
    if (hasValue && Object.hasOwn(node, 'numerator') && !hasDenominator) {
      violations.push(`${path} reports a rate without a denominator`);
    }
    if (hasValue && hasDenominator) {
      const denominator = node.denominator ?? node.denominatorHours;
      if ((denominator ?? 0) === 0 && node.value !== null) {
        violations.push(`${path} reports value ${node.value} over a zero denominator`);
      }
      if ((denominator ?? 0) > 0 && node.value === null) {
        violations.push(`${path} has denominator ${denominator} but a null value`);
      }
    }
    for (const [key, value] of Object.entries(node)) walk(value, path ? `${path}.${key}` : key);
  };
  walk(report, '');
  const entries = report?.corpus?.entries ?? 0;
  if (report?.corpus?.accountedFor !== true) violations.push('corpus outcomes do not account for every entry');
  if (report?.cases?.length !== entries) {
    violations.push(`cases array has ${report?.cases?.length ?? 0} rows for ${entries} entries`);
  }
  if (Number.isInteger(expectedEntries) && entries !== expectedEntries) {
    violations.push(`corpus reports ${entries} entries, expected ${expectedEntries}`);
  }
  if (report?.funnel?.monotone !== true) violations.push('funnel stage counts are not monotone');
  for (const row of report?.cases ?? []) {
    if (!CASE_OUTCOMES.includes(row?.outcome)) {
      violations.push(`case ${row?.id} has outcome ${JSON.stringify(row?.outcome ?? null)}`);
    }
  }
  const stages = report?.funnel?.stages ?? [];
  const submitted = report?.denominators?.submittedAttempts ?? 0;
  for (const [index, stage] of stages.entries()) {
    if (stage.reached > stage.denominator) {
      violations.push(`funnel stage ${stage.id} reached ${stage.reached} over denominator ${stage.denominator}`);
    }
    const upstream = index === 0 ? submitted : stages[index - 1].reached;
    if (stage.denominator + stage.censoredHere > upstream) {
      violations.push(
        `funnel stage ${stage.id} accounts for ${stage.denominator + stage.censoredHere} attempts `
        + `but only ${upstream} reached ${stage.denominatorStage}`,
      );
    }
  }
  return violations;
}
