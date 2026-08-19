import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ATTEMPT_RECORD_SCHEMA, BENCHMARK_REPORT_SCHEMA } from './benchmark.mjs';
import { createShowcaseServer, resolveSchedulerSettings } from './index.mjs';
import {
  applyProductDecision,
  atomicJson,
  evaluateCellEligibility,
  planRetry,
  rankCandidates,
} from './pipeline.mjs';
import { classifyFailure } from './failures.mjs';
import { NEVER_SCREENED_REASON, PRODUCT_CONTRACT_VERSION } from './product-contract.mjs';

const TOKEN = 'test-showcase-token';

class StubEngine {
  constructor() {
    this.jobs = [];
  }

  async run(job, context) {
    this.jobs.push(job);
    const write = async (stage, path, value) => {
      await atomicJson(join(context.jobDir, path), value);
      context.emit({ stage, status: 'complete', artifacts: [path] });
      await new Promise((resolve) => setTimeout(resolve, 4));
    };
    await write('10-route', '10-route.json', { requested: job.engine, engine: 'compiler', why: 'stub' });
    await write('15-precheck', '15-precheck.json', { feasible: true, requires: ['plain_corridor'] });
    await mkdir(join(context.jobDir, '20-author'), { recursive: true });
    await atomicJson(join(context.jobDir, '20-author', 'template.json'), { stub: true });
    await atomicJson(join(context.jobDir, '20-author', 'transcript.json'), { stub: true });
    context.emit({ stage: '20-author', status: 'complete', artifacts: ['20-author/template.json', '20-author/transcript.json'] });
    await write('30-sites', '30-sites.json', { totalSites: 1, maps: [] });
    await mkdir(join(context.jobDir, '40-cells', 'stub-cell'), { recursive: true });
    await writeFile(join(context.jobDir, '40-cells', 'stub-cell', 'trace.json.gz'), 'stub');
    await write('40-cells', '40-cells/index.json', { cells: [{ cellId: 'stub-cell' }] });
    await write('50-gate', '50-gate.json', { cells: [{ cellId: 'stub-cell', pass: true }] });
    await mkdir(join(context.jobDir, '60-render2d', 'stub-cell'), { recursive: true });
    await writeFile(join(context.jobDir, '60-render2d', 'stub-cell', 'rollout.mp4'), 'fake mp4');
    await write('60-render2d', '60-render2d/index.json', { cells: [{ cellId: 'stub-cell', status: 'complete' }] });
    await write('65-render3d', '65-render3d/index.json', { status: 'skipped', cells: [] });
    await write('75-product', '75-product.json', {
      schema: 'uniscenarios.showcase-product-decision.v2',
      status: 'complete',
      contract: { version: PRODUCT_CONTRACT_VERSION },
      acceptedCells: 0,
      cells: [],
    });
    await write('90-gallery', '90-gallery.json', {
      id: job.jobId,
      jobId: job.jobId,
      brief: job.brief,
      engine: 'compiler',
      headline: `/artifacts/jobs/${job.jobId}/60-render2d/stub-cell/rollout.mp4`,
      createdAt: job.createdAt,
    });
  }
}

class BlockingEngine {
  constructor() {
    this.active = 0;
    this.maximumActive = 0;
    this.releasePromise = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  async run() {
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      await this.releasePromise;
    } finally {
      this.active -= 1;
    }
  }
}

class FailingEngine {
  constructor(error) {
    this.error = error;
  }

  async run() {
    throw this.error;
  }
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('typed classification separates operational failures from product rejection', () => {
  const provider = classifyFailure({ error: 'HTTP 401: No credential available for provider openai-codex' });
  assert.deepEqual([provider.operational, provider.kind, provider.code], [true, 'model-access', 'no_credential']);
  const rateLimited = classifyFailure({ error: 'HTTP 429: rate_limit_error' });
  assert.deepEqual([rateLimited.operational, rateLimited.kind], [true, 'provider']);
  const rejection = classifyFailure({ accepted: false, defects: ['frozen_actor'] });
  assert.deepEqual([rejection.operational, rejection.kind, rejection.defectCodes], [false, 'generation', ['frozen_actor']]);
});

test('candidate ranking prefers blind 2D quality while preserving site diversity', () => {
  const cells = [
    { cellId: 'a-0', mapId: 'map-a', siteId: 'site-a' },
    { cellId: 'a-1', mapId: 'map-a', siteId: 'site-a' },
    { cellId: 'b-0', mapId: 'map-b', siteId: 'site-b' },
  ];
  const quality = [
    { cellId: 'a-0', plausible: true, realism: 8, dynamism: 7, defects: [] },
    { cellId: 'a-1', plausible: true, realism: 7, dynamism: 7, defects: [] },
    { cellId: 'b-0', plausible: true, realism: 6, dynamism: 5, defects: [] },
  ];
  assert.deepEqual(rankCandidates(cells, quality).map((cell) => cell.cellId), ['a-0', 'b-0', 'a-1']);
});


const CLEAN_TRACE = new URL('../../../fixtures/evidence/golden-yale-bus-stop/trace.json.gz', import.meta.url);
// The merger hits a work-zone prop, the ego hits the disabled merger, and both
// bodies then sit still for 14 of the clip's 16 seconds.
const CRASHED_TRACE = new URL(
  '../../../research/edge-case-corpus/gold-agent-authored/c8-taper-merge/el-camino-road__2dfa4c7661f965ef__draw-005.trace.json.gz',
  import.meta.url,
);

/** A matched 2D semantic oracle verdict: the only semantic authority the pipeline has. */
const MATCHED = Object.freeze({ status: 'complete', semanticMatch: true, confidence: 0.9, scenarioDefectCodes: [] });

/** One attempt decided exactly as the 75-product stage decides it. */
function decide(rows, { passing, gateRows, validity, renders, semantic } = {}) {
  return applyProductDecision(rows, {
    job: { render3d: true, topK: 1 },
    passing: passing ?? new Set(rows.map((row) => row.cellId)),
    gateRows: gateRows ?? new Map(),
    validityByCell: new Map(Object.entries(validity ?? {})),
    renderByCell: new Map(Object.entries(renders ?? {})),
    semanticByCell: new Map(Object.entries(semantic ?? {})),
  });
}

const production = { render3d: true, topK: 1, fallbackToVisual: false };
const rendered = (cellId) => ({ [cellId]: { cellId, status: 'complete' } });
const screened = (cellId, overrides = {}) => ({ [cellId]: { cellId, ...MATCHED, ...overrides } });
/** The oracle document `planRetry` reads: `cells` decides whether anything was screenable. */
const oracle = (cells) => ({ status: 'complete', cells });

test('product eligibility rejects broken physics before any render is spent', async (t) => {
  const cellsDir = await mkdtemp(join(tmpdir(), 'showcase-eligibility-test-'));
  t.after(async () => rm(cellsDir, { recursive: true, force: true }));
  const write = async (cellId, source) => {
    await mkdir(join(cellsDir, cellId), { recursive: true });
    const traceFile = join(cellsDir, cellId, 'trace.json.gz');
    await writeFile(traceFile, await readFile(source));
    return { cellId, traceFile };
  };
  const cells = [
    await write('clean-0', CLEAN_TRACE),
    await write('crashed-0', CRASHED_TRACE),
    await write('rejected-0', CLEAN_TRACE),
    { cellId: 'missing-0', traceFile: join(cellsDir, 'missing-0', 'trace.json.gz') },
  ];
  const eligibility = await evaluateCellEligibility(cells, {
    passing: new Set(['clean-0', 'crashed-0', 'missing-0']),
    gateCells: [{ cellId: 'rejected-0', pass: false, firstFailure: 'C3' }],
    collisionPolicy: 'reject',
  });

  assert.equal(eligibility.admittedCells, 3);
  assert.equal(eligibility.eligibleCells, 1);
  const byCell = new Map(eligibility.cells.map((row) => [row.cellId, row]));

  // A valid trace stays eligible and needs no retry.
  assert.equal(byCell.get('clean-0').eligible, true);
  assert.deepEqual(byCell.get('clean-0').defectCodes, []);
  assert.equal(byCell.get('clean-0').retry, 'none');

  // A collided, aborted and frozen trace is rejected here, with simulation codes
  // only, so no 3D export is ever spent on it.
  const crashed = byCell.get('crashed-0');
  assert.equal(crashed.eligible, false);
  assert.ok(crashed.defectCodes.includes('simulation.collision.contract_violation'));
  assert.ok(crashed.defectCodes.includes('simulation.actor.frozen_tail'));
  assert.ok(crashed.defectCodes.every((code) => code.startsWith('simulation.')));
  assert.equal(crashed.retry, 'resimulate');
  assert.ok(crashed.findings.collisions.authoredInvolved.length > 0);

  // The frozen gate's own rejection is reported, never re-decided.
  assert.equal(byCell.get('rejected-0').admitted, false);
  assert.deepEqual(byCell.get('rejected-0').defectCodes, []);
  assert.match(byCell.get('rejected-0').reason, /frozen gate rejected this cell \(C3\)/);

  // A missing trace fails closed rather than passing for lack of evidence.
  assert.deepEqual(byCell.get('missing-0').defectCodes, ['simulation.trace.unreadable']);
  assert.equal(byCell.get('missing-0').eligible, false);

  assert.deepEqual(eligibility.defectCodes, [
    'simulation.actor.frozen_tail',
    'simulation.collision.contract_violation',
    'simulation.interaction.skipped',
    'simulation.trace.unreadable',
    'simulation.trigger.never_fired',
  ]);

  // Nothing survived eligibility, so no cell was ever rendered or screenable. The job-level
  // decision is an authoring pass, not a resimulation of the same deterministic draws.
  const plan = planRetry({ engine: 'vista2' }, production, oracle([]), []);
  assert.equal(plan.retry, 'reauthor');
  assert.equal(plan.kind, 'scenario-defect-reauthor');
  assert.deepEqual(plan.defectCodes, ['scenario.no_eligible_simulation']);
});

test('acceptance is the gate, the oracle, and a completed deterministic render — nothing else', () => {
  const [accepted] = decide([{ cellId: 'a-0' }], { renders: rendered('a-0'), semantic: screened('a-0') });
  assert.equal(accepted.semanticAccepted, true);
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.defectCodes, []);
  assert.equal(accepted.unsupportedReason, null);
  assert.equal(accepted.acceptance.contract.version, PRODUCT_CONTRACT_VERSION);

  // A render that produced no footage carries the exporter's own defect code. The oracle's
  // semantic verdict still stands on its own: a camera fault is not a scenario fault.
  const [renderFailure] = decide([{ cellId: 'a-1' }], {
    renders: { 'a-1': { cellId: 'a-1', status: 'error', defectCodes: ['render.camera.composition_failed'] } },
    semantic: screened('a-1'),
  });
  assert.equal(renderFailure.semanticAccepted, true);
  assert.equal(renderFailure.accepted, false);
  assert.deepEqual(renderFailure.defectCodes, ['render.camera.composition_failed']);
  assert.equal(renderFailure.unsupportedReason, null);

  // The oracle rejected the scenario: its own codes travel with the row.
  const [mismatch] = decide([{ cellId: 'a-2' }], {
    renders: rendered('a-2'),
    semantic: screened('a-2', { semanticMatch: false, scenarioDefectCodes: ['scenario.mechanism'] }),
  });
  assert.equal(mismatch.semanticAccepted, false);
  assert.equal(mismatch.accepted, false);
  assert.deepEqual(mismatch.defectCodes, ['scenario.mechanism']);

  // A deterministic simulation defect is folded in, and the validator's unsupported note never
  // becomes the canonical unsupported reason: only the absence of an oracle verdict does that.
  const [invalidTrace] = decide([{ cellId: 'a-3' }], {
    validity: {
      'a-3': {
        eligible: false,
        defectCodes: ['simulation.actor.frozen_tail'],
        unsupportedReason: 'off_road: no lane-corridor guard runs for ped',
      },
    },
    renders: rendered('a-3'),
    semantic: screened('a-3'),
  });
  assert.deepEqual(invalidTrace.defectCodes, ['simulation.actor.frozen_tail']);
  assert.equal(invalidTrace.unsupportedReason, null);

  // A cell the oracle never screened is unsupported, not rejected and not accepted.
  const [unscreened] = decide([{ cellId: 'a-4' }], { renders: rendered('a-4') });
  assert.equal(unscreened.semanticAccepted, false);
  assert.equal(unscreened.accepted, false);
  assert.equal(unscreened.unsupportedReason, NEVER_SCREENED_REASON);
  assert.equal(unscreened.acceptance.semanticScreened, false);

  // The frozen gate's verdict is the pipeline's own contribution to the evidence, and it
  // overrides an oracle match: an inadmissible cell is never a deliverable.
  const [gateRejected] = decide([{ cellId: 'a-5' }], {
    passing: new Set(),
    gateRows: new Map([['a-5', { cellId: 'a-5', pass: false, firstFailure: 'C3' }]]),
    renders: rendered('a-5'),
    semantic: screened('a-5'),
  });
  assert.equal(gateRejected.semanticAccepted, true);
  assert.equal(gateRejected.accepted, false);
  assert.deepEqual(gateRejected.defectCodes, ['scenario.gate']);
  assert.equal(gateRejected.acceptance.gatePassed, false);
  assert.equal(gateRejected.acceptance.gateFirstFailure, 'C3');

  // Semantic truth is never rationed: topK bounds render spend upstream, not acceptance.
  const capped = decide([{ cellId: 'b-0' }, { cellId: 'b-1' }], {
    renders: { ...rendered('b-0'), ...rendered('b-1') },
    semantic: { ...screened('b-0'), ...screened('b-1') },
  });
  assert.deepEqual(capped.map((row) => row.accepted), [true, true]);
  assert.deepEqual(capped.map((row) => row.semanticAccepted), [true, true]);
});

test('a screened job spends no retry, and only an unscreenable one may reauthor once', () => {
  // The oracle screened this footage and rejected it, so the bounded mutation loop upstream
  // already spent the repair budget. A render fault can never buy an authoring pass either.
  const rejected = decide([{ cellId: 'a-0' }], {
    renders: rendered('a-0'),
    semantic: screened('a-0', { semanticMatch: false, scenarioDefectCodes: ['scenario.mechanism'] }),
  });
  const spentBudget = planRetry({ engine: 'vista2' }, production, oracle([{ status: 'complete' }]), rejected);
  assert.equal(spentBudget.retry, 'none');
  assert.equal(spentBudget.kind, 'oracle-rejected');
  assert.deepEqual(spentBudget.defectCodes, ['scenario.mechanism']);

  const cameraOnly = decide([{ cellId: 'a-0' }], {
    renders: { 'a-0': { cellId: 'a-0', status: 'error', defectCodes: ['render.camera.framing'] } },
    semantic: screened('a-0'),
  });
  const camera = planRetry({ engine: 'vista2' }, production, oracle([{ status: 'complete' }]), cameraOnly);
  assert.equal(camera.retry, 'none');
  assert.equal(camera.kind, 'oracle-rejected');

  // Nothing was screenable: authoring a new template is the only control left, exactly once.
  const unscreenable = oracle([]);
  const first = planRetry({ engine: 'vista2' }, production, unscreenable, []);
  assert.equal(first.retry, 'reauthor');
  assert.equal(first.kind, 'scenario-defect-reauthor');
  const spent = planRetry({ engine: 'vista2' }, { ...production, _reauthorDepth: 1 }, unscreenable, []);
  assert.equal(spent.retry, 'none');
  assert.equal(spent.kind, 'exhausted');

  // A compiler job spends its declared visual fallback before its reauthor.
  const fallback = planRetry({ engine: 'compiler' }, { ...production, fallbackToVisual: true }, unscreenable, []);
  assert.equal(fallback.retry, 'reauthor');
  assert.equal(fallback.kind, 'compiler-to-visual-fallback');

  // An accepted job, a skipped oracle, and a 2D-only job all retry nothing.
  const acceptedRows = decide([{ cellId: 'a-0' }], { renders: rendered('a-0'), semantic: screened('a-0') });
  assert.equal(planRetry({ engine: 'vista2' }, production, oracle([{ status: 'complete' }]), acceptedRows).retry, 'none');
  assert.equal(planRetry({ engine: 'vista2' }, production, { status: 'skipped', reason: 'gateway unavailable', cells: [] }, []).retry, 'none');
  assert.equal(planRetry({ engine: 'vista2' }, { ...production, render3d: false }, unscreenable, []).retry, 'none');
});

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'showcase-server-test-'));
  const webDir = join(dataDir, 'web');
  await mkdir(webDir, { recursive: true });
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>showcase test</title>');
  const engine = new StubEngine();
  const app = await createShowcaseServer({ token: TOKEN, dataDir, webDir, engine });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { ...app, base };
}

async function collectEvents(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (data) events.push(JSON.parse(data.slice(6)));
    }
    if (done) break;
  }
  return events;
}

test('frozen REST + SSE contract exposes each stage and gallery artifacts', async (t) => {
  const { base } = await fixture(t);
  const submitted = await fetch(`${base}/api/jobs?token=${TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      methodology: 'custom',
      brief: 'A lead vehicle brakes hard in front of the ego.',
      engine: 'compiler',
      nScenarios: 1,
      maps: ['yale-street'],
      maxSitesPerMap: 1,
      ambient: 'light',
      seed: 7,
      render3d: false,
      topK: 1,
    }),
  });
  assert.equal(submitted.status, 202);
  const payload = await submitted.json();
  assert.deepEqual(Object.keys(payload), ['jobId']);
  assert.match(payload.jobId, /^[0-9a-f-]{36}$/);

  const events = await collectEvents(await fetch(`${base}/api/jobs/${payload.jobId}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  }));
  const completed = new Set(events.filter((event) => event.status === 'complete').map((event) => event.stage));
  for (const stage of ['00-brief', '10-route', '15-precheck', '20-author', '30-sites', '40-cells', '50-gate', '60-render2d', '65-render3d', '75-product', '90-gallery']) {
    assert.ok(completed.has(stage), `${stage} appeared in SSE`);
  }
  for (const event of events) assert.deepEqual(Object.keys(event), ['stage', 'status', 'artifacts']);

  const full = await fetch(`${base}/api/jobs/${payload.jobId}/full?token=${TOKEN}`).then((response) => response.json());
  assert.equal(full.jobId, payload.jobId);
  assert.ok(full.files.some((file) => file.path === '00-brief.json' && file.json.brief.includes('lead vehicle')));
  assert.ok(full.files.some((file) => file.path === '90-gallery.json'));

  const cards = await fetch(`${base}/api/gallery?token=${TOKEN}`).then((response) => response.json());
  assert.equal(cards.length, 1);
  assert.equal(cards[0].jobId, payload.jobId);
  const artifact = await fetch(`${base}${cards[0].headline}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(artifact.status, 200);
  assert.equal(await artifact.text(), 'fake mp4');
});

test('production methodology freezes the research-proven recipe', async (t) => {
  const { base, runner } = await fixture(t);
  const response = await fetch(`${base}/api/jobs?token=${TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      methodology: 'production',
      brief: 'A cyclist emerges late from behind a stopped bus.',
      engine: 'compiler',
      nScenarios: 1,
      maps: ['yale-street'],
      maxSitesPerMap: 1,
      ambient: 'off',
      render3d: false,
    }),
  });
  assert.equal(response.status, 202);
  const { jobId } = await response.json();
  await collectEvents(await fetch(`${base}/api/jobs/${jobId}?token=${TOKEN}`));
  const job = runner.engine.jobs.find((candidate) => candidate.jobId === jobId);
  assert.deepEqual({
    methodology: job.methodology,
    engine: job.engine,
    maps: job.maps,
    nScenarios: job.nScenarios,
    maxSitesPerMap: job.maxSitesPerMap,
    ambient: job.ambient,
    render3d: job.render3d,
    topK: job.topK,
    author: `${job.authorModel}/${job.authorEffort}`,
    fallbackToVisual: job.fallbackToVisual,
  }, {
    methodology: 'production',
    engine: 'auto',
    maps: [
      'yale-street',
      'belmont-research-center',
      'el-camino-road',
      'easterbrook-discovery-school',
      'richmond-field-station',
    ],
    nScenarios: 3,
    maxSitesPerMap: 3,
    ambient: 'light',
    render3d: true,
    topK: 3,
    author: 'gpt-5.6-sol/low',
    fallbackToVisual: true,
  });
});

test('all endpoints reject missing/wrong auth and accept query or bearer auth', async (t) => {
  const { base } = await fixture(t);
  assert.equal((await fetch(`${base}/api/gallery`)).status, 401);
  assert.equal((await fetch(`${base}/api/gallery?token=wrong`)).status, 401);
  assert.equal((await fetch(`${base}/api/gallery?token=${TOKEN}`)).status, 200);
  assert.equal((await fetch(`${base}/api/gallery`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  const page = await fetch(`${base}/?token=${TOKEN}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /showcase test/);
  assert.match(page.headers.get('set-cookie'), /^showcase_token=/);
  assert.equal((await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brief: 'A valid but unauthorized brief.' }),
  })).status, 401);
});

test('gallery discovers committed per-card gallery seeds on first load', async (t) => {
  const { base, runner } = await fixture(t);
  const seed = join(runner.dataDir, 'gallery-seed', '001');
  await mkdir(join(seed, '60-render2d', 'cell-1'), { recursive: true });
  await writeFile(join(seed, '60-render2d', 'cell-1', 'rollout.mp4'), 'seed mp4');
  await atomicJson(join(seed, '90-gallery.json'), {
    id: 'seed-001',
    brief: 'A seeded scenario.',
    media: '/artifacts/gallery-seed/001/60-render2d/cell-1/rollout.mp4',
  });

  const cards = await fetch(`${base}/api/gallery?token=${TOKEN}`).then((response) => response.json());
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 'seed-001');
  const artifact = await fetch(`${base}${cards[0].media}?token=${TOKEN}`);
  assert.equal(artifact.status, 200);
  assert.equal(await artifact.text(), 'seed mp4');
});

test('scheduler bounds four active jobs and preserves the legacy concurrency option', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'showcase-concurrency-test-'));
  const engine = new BlockingEngine();
  const { runner } = await createShowcaseServer({
    token: TOKEN,
    dataDir,
    engine,
    jobConcurrency: 4,
    env: {},
  });
  t.after(async () => rm(dataDir, { recursive: true, force: true }));

  for (let index = 0; index < 6; index += 1) {
    await runner.submit({ methodology: 'custom', brief: `Queued campaign job number ${index}.` });
  }
  await eventually(() => engine.active === 4, 'four jobs became active');
  assert.equal(engine.maximumActive, 4);
  assert.equal(runner.queue.length, 2);

  engine.release();
  await eventually(() => runner.active === 0, 'all queued jobs completed');
  assert.equal(engine.maximumActive, 4);
});

test('scheduler configuration uses bounded production defaults and rejects oversubscription', () => {
  assert.deepEqual(resolveSchedulerSettings({ env: {} }), {
    jobConcurrency: 4,
    batchConcurrency: 3,
    render2dConcurrency: 4,
    render3dConcurrency: 2,
    reviewConcurrency: 4,
  });
  const configured = resolveSchedulerSettings({
    env: {
      SHOWCASE_JOB_CONCURRENCY: '5',
      SHOWCASE_BATCH_CONCURRENCY: '6',
      SHOWCASE_2D_CONCURRENCY: '3',
      SHOWCASE_3D_CONCURRENCY: '4',
      SHOWCASE_REVIEW_CONCURRENCY: '7',
    },
  });
  assert.equal(configured.batchConcurrency, 6);
  assert.equal(configured.reviewConcurrency, 7);
  assert.throws(
    () => resolveSchedulerSettings({ env: { SHOWCASE_JOB_CONCURRENCY: '999999' } }),
    /jobConcurrency must be an integer from 1 to 8/,
  );
  assert.throws(
    () => resolveSchedulerSettings({ render3dConcurrency: Number.POSITIVE_INFINITY, env: {} }),
    /render3dConcurrency must be an integer from 1 to 4/,
  );
});

test('job evidence normalizes campaign metadata and records scheduler limits', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'showcase-metadata-test-'));
  const engine = new StubEngine();
  const { runner } = await createShowcaseServer({
    token: TOKEN,
    dataDir,
    engine,
    jobConcurrency: 1,
    batchConcurrency: 5,
    render2dConcurrency: 3,
    render3dConcurrency: 2,
    reviewConcurrency: 6,
    env: {},
  });
  t.after(async () => rm(dataDir, { recursive: true, force: true }));

  const jobId = await runner.submit({
    methodology: 'custom',
    brief: 'A campaign metadata normalization case.',
    campaignId: '  edge-cases-67x5  ',
    campaignCaseId: '  case-07  ',
    campaignAttempt: 9,
  });
  const saved = JSON.parse(await readFile(join(runner.jobsDir, jobId, '00-brief.json'), 'utf8'));
  assert.equal(saved.campaignId, 'edge-cases-67x5');
  assert.equal(saved.campaignCaseId, 'case-07');
  assert.equal(saved.campaignAttempt, 9);
  assert.deepEqual(saved.scheduler, {
    jobConcurrency: 1,
    batchConcurrency: 5,
    render2dConcurrency: 3,
    render3dConcurrency: 2,
    reviewConcurrency: 6,
  });
  await eventually(() => runner.ensureState(jobId).done, 'metadata job completed');
});

test('recovery replays a persisted job error as a terminal event', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'showcase-recovery-test-'));
  const jobId = '11111111-1111-4111-8111-111111111111';
  const jobDir = join(dataDir, 'jobs', jobId);
  await mkdir(jobDir, { recursive: true });
  await atomicJson(join(jobDir, '00-brief.json'), {
    jobId,
    briefId: `showcase-${jobId}`,
    brief: 'A recovered terminal failure.',
  });
  await atomicJson(join(jobDir, 'job-error.json'), {
    error: 'persisted failure',
    failedAt: new Date().toISOString(),
  });
  const { runner } = await createShowcaseServer({
    token: TOKEN,
    dataDir,
    engine: new StubEngine(),
    env: {},
  });
  t.after(async () => rm(dataDir, { recursive: true, force: true }));

  const events = [];
  const subscription = runner.subscribe(jobId, (event) => events.push(event));
  assert.equal(subscription.done, true);
  assert.deepEqual(events.at(-1), {

    stage: 'job',
    status: 'error',
    artifacts: ['job-error.json'],
  });
  assert.equal(runner.queue.length, 0);
});

async function failureDocument(t, error, brief) {
  const dataDir = await mkdtemp(join(tmpdir(), 'showcase-failure-test-'));
  const { runner } = await createShowcaseServer({
    token: TOKEN,
    dataDir,
    engine: new FailingEngine(error),
    env: {},
  });
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const jobId = await runner.submit({ methodology: 'custom', brief });
  await eventually(() => runner.ensureState(jobId).done, 'the failing job reached a terminal state');
  return JSON.parse(await readFile(join(runner.jobsDir, jobId, 'job-error.json'), 'utf8'));
}

test('a failed job persists the typed failure contract the campaign runner reads', async (t) => {
  const document = await failureDocument(
    t,
    new Error('model access unavailable during 3D review: {"cellId":"cell-1","review":{"error":"HTTP 429"}}'),
    'A provider outage during 3D review.',
  );
  assert.equal(document.operational, true);
  assert.equal(document.failureKind, 'vision');
  assert.equal(document.code, 'vision_review_unavailable');
  assert.equal(document.unsupportedReason, null);
  assert.deepEqual(document.defectCodes, []);
  assert.match(document.error, /model access unavailable during 3D review/);
});

test('a failed job persists a declared unsupported reason instead of an operational failure', async (t) => {
  const document = await failureDocument(
    t,
    Object.assign(new Error('no matching sites for authored template'), {
      unsupportedReason: 'no reversible lane exists in the five-map catalog',
      defectCodes: ['unsupported_geometry'],
    }),
    'A brief that the map catalog cannot support.',
  );
  assert.equal(document.operational, false);
  assert.equal(document.failureKind, 'unsupported');
  assert.equal(document.unsupportedReason, 'no reversible lane exists in the five-map catalog');
  assert.deepEqual(document.defectCodes, ['unsupported_geometry']);
});

test('campaign endpoints publish the deterministic product report and its benchmark block', async (t) => {
  const { base, runner } = await fixture(t);
  const campaignDir = join(runner.dataDir, 'campaigns', 'edge-cases-67x5');
  await mkdir(campaignDir, { recursive: true });
  const benchmark = {
    schema: BENCHMARK_REPORT_SCHEMA,
    corpus: { entries: 67, outcomes: { accepted: 1, attempting: 0, exhausted: 0, unsupported: 0, pending: 66 }, accountedFor: true },
    funnel: { stages: [], monotone: true },
  };
  await atomicJson(join(campaignDir, 'report.json'), {
    campaignId: 'edge-cases-67x5',
    targetValidVideos: 5,
    cases: [{ id: 'case-1', title: 'Case one', attempts: [], validVideos: [], outcome: 'pending' }],
    totals: { validVideos: 0, targetVideos: 335, benchmark },
    validityContract: {
      semanticAcceptedRequired: true,
      acceptedRequired: true,
      currentProductContractRequired: true,
      uniqueVideoSha256Required: true,
      productContractVersion: PRODUCT_CONTRACT_VERSION,
      distinctTrajectoryFingerprintRequired: true,
    },
  });
  const response = await fetch(`${base}/api/campaigns/edge-cases-67x5?token=${TOKEN}`);
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.campaignId, 'edge-cases-67x5');
  assert.equal(report.validityContract.semanticAcceptedRequired, true);
  assert.equal(report.validityContract.acceptedRequired, true);
  assert.equal(report.validityContract.productContractVersion, PRODUCT_CONTRACT_VERSION);
  assert.equal(report.validityContract.distinctTrajectoryFingerprintRequired, true);
  assert.equal(report.totals.benchmark.corpus.entries, 67);
  assert.equal((await fetch(`${base}/api/campaigns/missing?token=${TOKEN}`)).status, 404);

  // The benchmark block is also reachable on its own, so a reporter never has to
  // download the full 67-case ledger to verify the numbers.
  const direct = await fetch(`${base}/api/campaigns/edge-cases-67x5/benchmark?token=${TOKEN}`);
  assert.equal(direct.status, 200);
  assert.deepEqual(await direct.json(), benchmark);
  assert.equal((await fetch(`${base}/api/campaigns/missing/benchmark?token=${TOKEN}`)).status, 404);

  // A report written before this schema existed is refused, not silently faked.
  const legacyDir = join(runner.dataDir, 'campaigns', 'legacy');
  await mkdir(legacyDir, { recursive: true });
  await atomicJson(join(legacyDir, 'report.json'), { campaignId: 'legacy', totals: {} });
  const legacy = await fetch(`${base}/api/campaigns/legacy/benchmark?token=${TOKEN}`);
  assert.equal(legacy.status, 409);
  assert.match((await legacy.json()).error, /predates the benchmark schema/);
});

test('a job exposes the one benchmark record written for its attempt', async (t) => {
  const { base, runner } = await fixture(t);
  const jobId = '22222222-2222-4222-8222-222222222222';
  const jobDir = join(runner.jobsDir, jobId);
  await mkdir(jobDir, { recursive: true });
  assert.equal((await fetch(`${base}/api/jobs/${jobId}/benchmark?token=${TOKEN}`)).status, 404);
  const record = {
    schema: ATTEMPT_RECORD_SCHEMA,
    jobId,
    execution: { cold: true, processJobIndex: 0, resumed: false, resumedStages: [] },
    concurrency: { activeJobsAtStart: 1, logicalCpus: 8 },
    funnel: { submitted: true },
    outcome: { kind: 'running', censoredAtStage: null, operational: null, defectCodes: [] },
  };
  await atomicJson(join(jobDir, '95-benchmark.json'), record);
  const response = await fetch(`${base}/api/jobs/${jobId}/benchmark?token=${TOKEN}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), record);
});

test('the runner tells each attempt whether it is the process cold start and how busy the host is', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'showcase-coldwarm-test-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const seen = [];
  const engine = {
    async run(job, context) {
      seen.push({
        jobId: job.jobId,
        processJobIndex: context.processJobIndex,
        activeJobs: context.activeJobs,
        jobConcurrency: context.jobConcurrency,
      });
      await atomicJson(join(context.jobDir, '90-gallery.json'), { jobId: job.jobId });
      context.emit({ stage: '90-gallery', status: 'complete', artifacts: ['90-gallery.json'] });
    },
  };
  const { runner } = await createShowcaseServer({ token: TOKEN, dataDir, engine, env: {} });
  await runner.submit({ brief: 'First attempt on a cold process.', methodology: 'custom' });
  await eventually(() => seen.length === 1, 'first job never ran');
  await runner.submit({ brief: 'Second attempt on a warm process.', methodology: 'custom' });
  await eventually(() => seen.length === 2, 'second job never ran');
  assert.equal(seen[0].processJobIndex, 0, 'the first job of the process is the cold one');
  assert.equal(seen[1].processJobIndex, 1, 'every later job is warm');
  assert.ok(seen.every((entry) => Number.isInteger(entry.activeJobs)));
  assert.equal(seen[0].jobConcurrency, 4);
});
