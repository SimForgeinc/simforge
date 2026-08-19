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
import { contractIdentity, CONTRACT_SHA256 } from './review-contract.mjs';

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
    await write('70-judge', '70-judge.json', { status: 'skipped', cells: [] });
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

test('candidate ranking prefers judged quality while preserving site diversity', () => {
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

/** A full 3D review that satisfies every axis the contract asks about. */
const REVIEW_3D = Object.freeze({
  tier: '3d',
  mechanismFidelity: 'yes',
  visualGrounding: 'pass',
  actorFidelity: 'pass',
  eventSequence: 'pass',
  plausible: true,
  realism: 8,
  confidence: 0.9,
  defects: [],
  explanation: 'The requested mechanism happens on camera and every actor sits on the road.',
});

/** One attempt decided by the shared contract, exactly as the 70-judge stage decides it. */
function decide(rows, { topK = 1, passing, gateRows, validity, renders } = {}) {
  return applyProductDecision(rows, {
    job: { render3d: true, judge: true, topK },
    passing: passing ?? new Set(rows.map((row) => row.cellId)),
    gateRows: gateRows ?? new Map(),
    validityByCell: new Map(Object.entries(validity ?? {})),
    renderByCell: new Map(Object.entries(renders ?? {})),
  });
}

const judgeDocument = (cells) => ({ status: 'complete', contract: contractIdentity(), cells });
const production = { render3d: true, judge: true, topK: 1, fallbackToVisual: false };
const rendered = (cellId) => ({ [cellId]: { cellId, status: 'complete' } });

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
  // only, so no 3D export or product review is ever spent on it.
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

  // Nothing survived eligibility, so no cell was ever rendered or reviewed. The job-level decision
  // is an authoring pass, not a resimulation of the same deterministic draws.
  const plan = planRetry({ engine: 'vista2' }, production, judgeDocument([]));
  assert.equal(plan.retry, 'reauthor');
  assert.equal(plan.kind, 'scenario-defect-reauthor');
  assert.deepEqual(plan.defectCodes, ['scenario.no_eligible_simulation']);
  assert.equal(plan.recommendation.action, 'reauthor');
});

test('the product decision splits a cell verdict into semantics and presentation', () => {
  const [accepted] = decide([{ cellId: 'a-0', status: 'complete', threeDReview: { ...REVIEW_3D } }],
    { renders: rendered('a-0') });
  assert.equal(accepted.semanticAccepted, true);
  assert.equal(accepted.presentationAccepted, true);
  assert.deepEqual(accepted.defectCodes, []);
  assert.equal(accepted.unsupportedReason, null);

  // A camera defect the reviewer did see: the scenario is right, the footage is not.
  const [cameraDefect] = decide([{
    cellId: 'a-1',
    status: 'complete',
    threeDReview: { ...REVIEW_3D, defects: [{ code: 'render.camera.framing', text: 'the conflict is cropped out of frame' }] },
  }], { renders: rendered('a-1') });
  assert.equal(cameraDefect.semanticAccepted, true);
  assert.equal(cameraDefect.presentationAccepted, false);
  assert.deepEqual(cameraDefect.defectCodes, ['render.camera.framing']);

  // A render that produced no footage carries the exporter's own defect code, so the camera fault
  // stays attributable even though no reviewer ever saw the cell. Its semantics are unproven: the
  // contract never accepts a scenario it has no 3D evidence for. What keeps that fault away from the
  // author is the retry plan, not a guessed verdict.
  const [renderFailure] = decide([{
    cellId: 'a-2',
    status: 'unavailable',
    renderError: 'incident composition failed at t=6.2 for every searched camera',
  }], { renders: { 'a-2': { cellId: 'a-2', status: 'error', defectCodes: ['render.camera.composition_failed'] } } });
  assert.equal(renderFailure.semanticAccepted, false);
  assert.equal(renderFailure.presentationAccepted, false);
  assert.ok(renderFailure.defectCodes.includes('render.camera.composition_failed'));
  assert.equal(planRetry({ engine: 'vista2' }, production, judgeDocument([renderFailure])).retry, 'recompose');

  // A deterministic simulation defect blocks the presentation without condemning the scenario, and
  // the validator's unsupported note never becomes the canonical unsupported reason: only the
  // reviewer's own inability to attribute a verdict does that.
  const [invalidTrace] = decide([{ cellId: 'a-3', status: 'complete', threeDReview: { ...REVIEW_3D } }], {
    validity: {
      'a-3': {
        eligible: false,
        defectCodes: ['simulation.actor.frozen_tail'],
        unsupportedReason: 'off_road: no lane-corridor guard runs for ped',
      },
    },
    renders: rendered('a-3'),
  });
  assert.equal(invalidTrace.semanticAccepted, true);
  assert.equal(invalidTrace.presentationAccepted, false);
  assert.deepEqual(invalidTrace.defectCodes, ['simulation.actor.frozen_tail']);
  assert.equal(invalidTrace.unsupportedReason, null);

  // An uncertain reviewer blocks both halves and names why, instead of passing for lack of evidence.
  const [uncertain] = decide([{ cellId: 'a-4', status: 'complete', threeDReview: { ...REVIEW_3D, confidence: 0.2 } }],
    { renders: rendered('a-4') });
  assert.equal(uncertain.semanticAccepted, false);
  assert.equal(uncertain.presentationAccepted, false);
  assert.deepEqual(uncertain.defectCodes, ['judge.uncertain']);
  assert.match(uncertain.unsupportedReason, /confidence/);

  // The frozen gate's verdict is the pipeline's own contribution to the evidence.
  const [gateRejected] = decide([{ cellId: 'a-5', status: 'complete', threeDReview: { ...REVIEW_3D } }], {
    passing: new Set(),
    gateRows: new Map([['a-5', { cellId: 'a-5', pass: false, firstFailure: 'C3' }]]),
    renders: rendered('a-5'),
  });
  assert.equal(gateRejected.semanticAccepted, false);
  assert.deepEqual(gateRejected.defectCodes, ['scenario.gate']);
  assert.equal(gateRejected.acceptance.gatePassed, false);

  // topK rations the deliverable, never the semantic truth.
  const capped = decide([
    { cellId: 'b-0', status: 'complete', threeDReview: { ...REVIEW_3D, realism: 9 } },
    { cellId: 'b-1', status: 'complete', threeDReview: { ...REVIEW_3D, realism: 7 } },
  ], { renders: { ...rendered('b-0'), ...rendered('b-1') } });
  assert.deepEqual(capped.map((row) => row.presentationAccepted), [true, false]);
  assert.deepEqual(capped.map((row) => row.semanticAccepted), [true, true]);
  assert.equal(capped[1].acceptance.cappedByTopK, true);
});

test('a presentation failure is repaired in the render stage, never by resimulating or reauthoring', () => {
  const cameraOnly = judgeDocument(decide([{
    cellId: 'a-0',
    status: 'complete',
    threeDReview: { ...REVIEW_3D, defects: [{ code: 'render.camera.framing', text: 'the conflict is cropped out of frame' }] },
  }], { renders: rendered('a-0') }));
  const plan = planRetry({ engine: 'vista2' }, production, cameraOnly);
  assert.equal(plan.retry, 'recompose');
  assert.equal(plan.kind, 'presentation-retry');
  assert.deepEqual(plan.cellIds, ['a-0']);
  assert.deepEqual(plan.defectCodes, ['render.camera.framing']);

  const captureOnly = judgeDocument(decide([{
    cellId: 'a-0',
    status: 'complete',
    threeDReview: { ...REVIEW_3D, defects: [{ code: 'capture.empty', text: 'the clip is an empty scene' }] },
  }], { renders: rendered('a-0') }));
  assert.equal(planRetry({ engine: 'vista2' }, production, captureOnly).retry, 'recapture');

  // A simulation defect on an otherwise sound cell owns the decision: re-rendering the same
  // deterministic trace cannot clear it, so the plan escalates to the single authoring pass instead
  // of spending a futile render.
  const mixed = judgeDocument(decide([{
    cellId: 'a-0',
    status: 'complete',
    threeDReview: {
      ...REVIEW_3D,
      defects: [
        { code: 'render.camera.framing', text: 'the conflict is cropped out of frame' },
        { code: 'simulation.collision', text: 'the ego rear-ends the lead vehicle' },
      ],
    },
  }], { renders: rendered('a-0') }));
  const escalated = planRetry({ engine: 'vista2' }, production, mixed);
  assert.equal(escalated.retry, 'reauthor');
  assert.ok(escalated.defectCodes.includes('scenario.contract_violation'));
  assert.ok(escalated.defectCodes.includes('simulation.collision'));

  // An uncertain reviewer is a human decision, not a machine retry.
  const uncertain = judgeDocument(decide([{ cellId: 'a-0', status: 'complete', threeDReview: { ...REVIEW_3D, confidence: 0.2 } }],
    { renders: rendered('a-0') }));
  assert.equal(planRetry({ engine: 'vista2' }, production, uncertain).retry, 'manual-review');
});

test('a semantic failure may reauthor exactly once, and a skipped review never retries', () => {
  const reviewRejected = judgeDocument(decide([{
    cellId: 'a-0',
    status: 'complete',
    threeDReview: { ...REVIEW_3D, eventSequence: 'fail' },
  }], { renders: rendered('a-0') }));
  const first = planRetry({ engine: 'vista2' }, production, reviewRejected);
  assert.equal(first.retry, 'reauthor');
  assert.equal(first.kind, 'scenario-defect-reauthor');
  assert.deepEqual(first.defectCodes, ['scenario.sequence']);
  assert.deepEqual(first.cellIds, [], 'a reauthored template draws its own cells');
  const spent = planRetry({ engine: 'vista2' }, { ...production, _reauthorDepth: 1 }, reviewRejected);
  assert.equal(spent.retry, 'manual-review');
  assert.equal(spent.kind, 'exhausted');

  // A compiler job spends its declared visual fallback before its reauthor.
  const fallback = planRetry({ engine: 'compiler' }, { ...production, fallbackToVisual: true }, reviewRejected);
  assert.equal(fallback.retry, 'reauthor');
  assert.equal(fallback.kind, 'compiler-to-visual-fallback');

  const accepted = judgeDocument(decide([{ cellId: 'a-0', status: 'complete', threeDReview: { ...REVIEW_3D } }],
    { renders: rendered('a-0') }));
  assert.equal(planRetry({ engine: 'vista2' }, production, accepted).retry, 'none');
  assert.equal(planRetry({ engine: 'vista2' }, production, { status: 'skipped', reason: 'gateway unavailable', cells: [] }).retry, 'none');
  assert.equal(planRetry({ engine: 'vista2' }, { ...production, judge: false }, reviewRejected).retry, 'none');
  assert.equal(planRetry({ engine: 'vista2' }, { ...production, render3d: false }, reviewRejected).retry, 'none');
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
      judge: false,
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
  for (const stage of ['00-brief', '10-route', '15-precheck', '20-author', '30-sites', '40-cells', '50-gate', '60-render2d', '65-render3d', '70-judge', '90-gallery']) {
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
      judge: false,
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
    judge: job.judge,
    author: `${job.authorModel}/${job.authorEffort}`,
    judgeConfig: `${job.judgeModel}/${job.judgeEffort}/${job.judgeStrategy}`,
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
    judge: true,
    author: 'gpt-5.6-sol/low',
    judgeConfig: 'gpt-5.6-sol/medium/spread8',
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
    judgeConcurrency: 4,
  });
  const configured = resolveSchedulerSettings({
    env: {
      SHOWCASE_JOB_CONCURRENCY: '5',
      SHOWCASE_BATCH_CONCURRENCY: '6',
      SHOWCASE_2D_CONCURRENCY: '3',
      SHOWCASE_3D_CONCURRENCY: '4',
      SHOWCASE_JUDGE_CONCURRENCY: '7',
    },
  });
  assert.equal(configured.batchConcurrency, 6);
  assert.equal(configured.judgeConcurrency, 7);
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
    judgeConcurrency: 6,
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
    judgeConcurrency: 6,
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

test('campaign endpoints publish the acceptance-split report and its benchmark block', async (t) => {
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
      presentationAcceptedRequired: true,
      currentReviewContractRequired: true,
      uniqueVideoSha256Required: true,
      reviewContractSha256: CONTRACT_SHA256,
      distinctTrajectoryFingerprintRequired: true,
    },
  });
  const response = await fetch(`${base}/api/campaigns/edge-cases-67x5?token=${TOKEN}`);
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.campaignId, 'edge-cases-67x5');
  assert.equal(report.validityContract.semanticAcceptedRequired, true);
  assert.equal(report.validityContract.presentationAcceptedRequired, true);
  assert.equal(report.validityContract.reviewContractSha256, CONTRACT_SHA256);
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
