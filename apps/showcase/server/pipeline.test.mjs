/**
 * End-to-end smoke coverage for the showcase pipeline's eligibility and retry
 * flow, driven through the real `ShowcasePipeline.run` with stand-in `python`
 * and `cli` executables.
 *
 * The stand-ins are deliberately thin: they answer the exact JSON protocol the
 * pipeline speaks and write the exact artifacts it reads, so every decision, path
 * and file this test observes is made by the production code.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { ShowcasePipeline, exists } from './pipeline.mjs';
import { REVIEW_CODE_PATHS } from './review-contract.mjs';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
const CLEAN_TRACE = join(REPO_ROOT, 'fixtures/evidence/golden-yale-bus-stop/trace.json.gz');
const CRASHED_TRACE = join(
  REPO_ROOT,
  'research/edge-case-corpus/gold-agent-authored/c8-taper-merge/el-camino-road__2dfa4c7661f965ef__draw-005.trace.json.gz',
);

const SEMANTIC_CONTRACT = {
  version: 'showcase-semantic-contract-v1',
  briefId: 'smoke',
  structures: [],
  obligations: [{ kind: 'collision_free' }],
};

/**
 * Stand-in for the python stage bridge. Argv is `[bridge, subcommand, ...flags]`,
 * exactly as `ShowcasePipeline` invokes it.
 */
const FAKE_BRIDGE = `#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The pipeline runs node <bridge> <subcommand> ..., so the subcommand is argv[2].
const command = process.argv[2];
const flag = (name) => {
  const at = process.argv.indexOf('--' + name);
  return at === -1 ? null : process.argv[at + 1];
};
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');

const plan = JSON.parse(await readFile(process.env.SMOKE_PLAN, 'utf8'));

if (command === 'precheck') emit({ id: 'smoke', feasible: true, requires: [], missing: [], notPortable: [] });
else if (command === 'contract') emit(plan.contract);
else if (command === 'validate-contract') emit({ valid: true, failures: [], representationDefaults: { invariants: [] } });
else if (command === 'author' || command === 'vista-author') {
  const out = flag('out');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'template.json'), JSON.stringify({
    anchor: { id: 'smoke-template' },
    choreography: { clipSeconds: 14 },
    props: [],
  }));
  await writeFile(join(out, 'transcript.json'), JSON.stringify({ attempts: 1 }));
  emit({ template: join(out, 'template.json'), transcript: join(out, 'transcript.json'), admitted: true, clipSeconds: 14 });
} else if (command === 'gate') {
  const request = JSON.parse(await readFile(flag('request'), 'utf8'));
  emit({
    implementation: 'tools/gates/tg_gate.py:gate_cell',
    version: 2,
    cells: request.cells.map((cell) => ({
      cellId: cell.cellId,
      pass: !plan.gateRejects.includes(cell.cellId),
      firstFailure: plan.gateRejects.includes(cell.cellId) ? 'C3' : null,
    })),
  });
} else if (command === 'judge') {
  emit({ cellId: flag('cell').split('/').pop(), plausible: true, realism: 8, dynamism: 7, defects: [] });
} else if (command === 'review3d') {
  const cellId = flag('cell-id');
  const render = flag('render');
  const attempt = render.includes('80-presentation-retry') ? 'retry' : 'first';
  const verdict = plan.review[attempt]?.[cellId] ?? plan.review[attempt]?.['*'] ?? {};
  await writeFile(join(process.env.SMOKE_DIR, 'review-' + attempt + '-' + cellId + '.json'), JSON.stringify({ render }));
  // A canonical v5 emission: every axis the acceptance contract asks about, plus the evidence text
  // it requires. A test that wants a rejection overrides one axis or adds a defect.
  emit({
    cellId,
    tier: '3d',
    version: 'showcase-3d-review-v5',
    visionAsserted: true,
    mechanismFidelity: 'yes',
    visualGrounding: 'pass',
    actorFidelity: 'pass',
    eventSequence: 'pass',
    plausible: true,
    realism: 8,
    dynamism: 7,
    defects: [],
    confidence: 0.9,
    explanation: 'The requested mechanism happens on camera and every actor sits on the road.',
    ...verdict,
  });
} else if (command === 'semantic2d') {
  const cellId = flag('cell-id');
  const render = flag('render');
  const attempt = render.includes('62-mutation-01') ? 'mutation-01'
    : render.includes('62-mutation-02') ? 'mutation-02'
      : render.includes('62-fallback-author') ? 'fallback' : 'first';
  const verdict = plan.semantic2d?.[attempt]?.[cellId] ?? plan.semantic2d?.[attempt]?.['*'] ?? {};
  // A canonical semantic 2D emission: brief-aware traffic-behaviour axes only.
  emit({
    cellId,
    tier: '2d-semantic',
    visionAsserted: true,
    mechanismFidelity: 'yes',
    actorFidelity: 'pass',
    eventSequence: 'pass',
    plausible: true,
    confidence: 0.9,
    defects: [],
    explanation: 'The schematic traffic enacts the requested mechanism in order.',
    semanticMatch: true,
    scenarioDefectCodes: [],
    tokens: { in: 100, out: 20, reasoning: 5 },
    rawResponseSha256: 'sem-' + attempt + '-' + cellId,
    ...verdict,
  });
} else if (command === 'mutate') {
  const template = JSON.parse(await readFile(flag('template'), 'utf8'));
  template.mutated = (template.mutated ?? 0) + 1;
  await writeFile(flag('out'), JSON.stringify(template));
  emit({
    template: flag('out'),
    valid: plan.mutateInvalid !== true,
    failures: plan.mutateInvalid === true ? [{ kind: 'smoke', reason: 'planned invalid mutation' }] : [],
    latencyS: 1.5,
    usage: { calls: 1, input_tokens: 1500, output_tokens: 400, reasoning_tokens: 50, wallS: 1.5 },
  });
} else {
  process.stderr.write('unsupported subcommand ' + command + '\\n');
  process.exit(2);
}
`;

/** Stand-in for the uniscenarios CLI: `sites match`, `batch` and `render`. */
const FAKE_CLI = `#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [command, sub] = [process.argv[2], process.argv[3]];
const flag = (name) => {
  const at = process.argv.indexOf('--' + name);
  return at === -1 ? null : process.argv[at + 1];
};
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const plan = JSON.parse(await readFile(process.env.SMOKE_PLAN, 'utf8'));

if (command === 'sites' && sub === 'match') {
  emit({ totalSites: plan.cells.length, maps: ['yale-street'] });
} else if (command === 'batch') {
  const out = flag('out');
  const results = [];
  const repairRound = out.includes('62-mutation') || out.includes('62-fallback-author');
  for (const cell of (repairRound ? plan.mutationCells ?? plan.cells : plan.cells)) {
    const dir = join(out, cell.cellId);
    await mkdir(dir, { recursive: true });
    await copyFile(cell.trace, join(dir, 'trace.json.gz'));
    await writeFile(join(dir, 'instance.json'), JSON.stringify({ manifest: { instanceId: cell.cellId } }));
    results.push({
      mapId: cell.mapId,
      siteId: cell.siteId,
      drawIndex: cell.drawIndex,
      status: 'ok',
      verdict: 'accept',
      band: 'critical',
      siteScore: 1,
      paramSeed: 7,
      traceFile: join(dir, 'trace.json.gz'),
      instanceFile: join(dir, 'instance.json'),
    });
  }
  await writeFile(join(out, 'batch-summary.json'), JSON.stringify({
    results, cells: results.length, elapsedMs: 1, criticality: {}, templateDigest: 'deadbeef',
  }));
  emit({ ok: true });
} else if (command === 'render') {
  const out = flag('out');
  const tier = flag('tier');
  const cellId = out.split('/').filter(Boolean).at(-1);
  const failures = out.includes('80-presentation-retry') ? plan.renderFails.retry : plan.renderFails.first;
  if (tier === '3d' && (failures[cellId] ?? null)) {
    process.stderr.write(failures[cellId] + '\\n');
    process.exit(1);
  }
  await mkdir(out, { recursive: true });
  // The real 3D exporter writes video.mp4; only the 2D renderer writes
  // rollout.mp4 itself. normalizeRender has to promote the former.
  await writeFile(join(out, tier === '3d' ? 'video.mp4' : 'rollout.mp4'), 'fake mp4 for ' + out);
  await writeFile(join(out, 'render-manifest.json'), JSON.stringify({ frames: [{ t: 0, png: 'frame-000.png' }] }));
  emit({ ok: true });
} else {
  process.stderr.write('unsupported command ' + command + ' ' + sub + '\\n');
  process.exit(2);
}
`;

async function harness(t, plan) {
  const dir = await mkdtemp(join(tmpdir(), 'showcase-pipeline-smoke-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  // The 70-judge cache key hashes the review implementation, so the synthetic repo has to carry the
  // same files the contract names.
  for (const path of REVIEW_CODE_PATHS) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await copyFile(join(REPO_ROOT, path), join(dir, path));
  }
  const python = join(dir, 'fake-bridge.mjs');
  const cli = join(dir, 'fake-cli.mjs');
  await writeFile(python, FAKE_BRIDGE);
  await writeFile(cli, FAKE_CLI);
  await chmod(python, 0o755);
  await chmod(cli, 0o755);
  const planPath = join(dir, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  process.env.SMOKE_PLAN = planPath;
  process.env.SMOKE_DIR = dir;
  t.after(() => {
    delete process.env.SMOKE_PLAN;
    delete process.env.SMOKE_DIR;
  });

  // `70-judge` and the 2D quality review only run when a gateway answers on the
  // conventional port. Bind it if it is free; a real gateway already listening
  // is equally acceptable.
  const gateway = createServer(() => {});
  const bound = await new Promise((resolve) => {
    gateway.once('error', () => resolve(false));
    gateway.listen(4141, '127.0.0.1', () => resolve(true));
  });
  t.after(async () => {
    if (bound) await new Promise((resolve) => gateway.close(resolve));
  });

  const jobDir = join(dir, 'jobs', 'job-1');
  await mkdir(jobDir, { recursive: true });
  const job = {
    jobId: 'job-1',
    briefId: 'smoke',
    brief: 'a lead vehicle brakes hard at a junction',
    seed: 11,
    maps: ['yale-street'],
    maxSitesPerMap: 1,
    nScenarios: plan.cells.length,
    topK: 1,
    ambient: 'off',
    engine: 'vista2',
    judge: true,
    render3d: true,
    methodology: 'custom',
    createdAt: '2026-01-01T00:00:00.000Z',
    semanticContract: SEMANTIC_CONTRACT,
    ...plan.job,
  };
  await writeFile(join(jobDir, '00-brief.json'), JSON.stringify(job));
  const events = [];
  const pipeline = new ShowcasePipeline({ root: dir, python: process.execPath, cli });
  // The pipeline spawns `node <python> <bridge> ...`; point the bridge at the
  // stand-in so the stage protocol is answered without a python runtime.
  pipeline.bridge = python;
  await pipeline.run(job, { jobDir, emit: (event) => events.push(event) });
  const read = async (relative) => JSON.parse(await readFile(join(jobDir, relative), 'utf8'));
  return { dir, jobDir, events, read, job };
}

const CELLS = [
  { cellId: 'yale-street-site-a-0', mapId: 'yale-street', siteId: 'site-a', drawIndex: 0, trace: CLEAN_TRACE },
];

test('a camera failure is repaired in the render stage and never reaches the author', async (t) => {
  const { jobDir, events, read } = await harness(t, {
    contract: SEMANTIC_CONTRACT,
    cells: CELLS,
    gateRejects: [],
    renderFails: {
      first: { 'yale-street-site-a-0': 'incident composition failed at t=6.2 for every searched camera: ego(inFrame=false)' },
      retry: {},
    },
    review: { first: {}, retry: {} },
  });

  const render3d = await read('65-render3d/index.json');
  assert.equal(render3d.cells[0].status, 'error');
  assert.deepEqual(render3d.cells[0].defectCodes, ['render.camera.composition_failed']);

  const product = await read('75-product.json');
  assert.equal(product.retry.kind, 'recompose');
  assert.equal(product.retry.detail, 'presentation-retry');
  assert.ok(product.retry.authorisedBy.includes('render.camera.composition_failed'));
  // A camera fault never reads as an authoring fault, so nothing in the authorised set is a
  // scenario defect and the reauthor stays unspent.
  assert.ok(product.retry.authorisedBy.every((code) => !code.startsWith('scenario.')));
  assert.equal(product.acceptedAttempt, '80-presentation-retry');
  assert.equal(product.acceptedCells, 1);
  assert.equal(product.cells[0].renderDir, '80-presentation-retry/65-render3d/yale-street-site-a-0');

  // Presentation was repaired where it failed: no authoring attempt exists, and
  // the simulated cells were never redrawn.
  assert.equal(await exists(join(jobDir, '80-reauthor-01')), false);
  assert.equal(await exists(join(jobDir, '80-visual-fallback')), false);
  assert.ok(await exists(join(jobDir, '80-presentation-retry', 'index.json')));
  assert.deepEqual(
    events.filter((event) => event.stage.startsWith('80-')).map((event) => `${event.stage}:${event.status}`),
    ['80-presentation-retry:running', '80-presentation-retry:complete'],
  );
  // Exactly one authoring pass happened: the one this job started with.
  assert.equal(events.filter((event) => event.stage === '20-author' && event.status === 'running').length, 1);

  // The rejected render and every upstream artifact keep their own bytes.
  const rejected = await read('65-render3d/index.json');
  assert.equal(rejected.cells[0].status, 'error');
  const retry = await read('80-presentation-retry/index.json');
  assert.equal(retry.kind, 'recompose');
  assert.equal(retry.cells[0].status, 'complete');
  assert.match(
    await readFile(join(jobDir, '80-presentation-retry', '65-render3d', 'yale-street-site-a-0', 'rollout.mp4'), 'utf8'),
    /80-presentation-retry/,
  );

  const gallery = await read('90-gallery.json');
  assert.equal(gallery.accepted, true);
  assert.equal(gallery.headline,
    '/artifacts/jobs/job-1/80-presentation-retry/65-render3d/yale-street-site-a-0/rollout.mp4');
  assert.equal(gallery.retry.kind, 'recompose');
  assert.equal(gallery.presentationAccepted, true);
});

test('a resumed job reads the presentation retry it already rendered', async (t) => {
  const { jobDir, read, job } = await harness(t, {
    contract: SEMANTIC_CONTRACT,
    cells: CELLS,
    gateRejects: [],
    renderFails: {
      first: { 'yale-street-site-a-0': 'renderer is not capture-ready: WebGL context is lost' },
      retry: {},
    },
    review: { first: {}, retry: {} },
  });
  const first = await read('80-presentation-retry/index.json');
  assert.equal(first.kind, 'recapture');
  const retryVideo = join(jobDir, '80-presentation-retry', '65-render3d', 'yale-street-site-a-0', 'rollout.mp4');
  await writeFile(retryVideo, 'resumed sentinel');

  // Re-running the same job resolves every completed stage, including the retry,
  // from its artifact instead of rendering or reviewing anything again.
  const events = [];
  const pipeline = new ShowcasePipeline({ root: dirname(dirname(jobDir)), python: process.execPath, cli: join(dirname(dirname(jobDir)), 'fake-cli.mjs') });
  pipeline.bridge = join(dirname(dirname(jobDir)), 'fake-bridge.mjs');
  await pipeline.run(job, { jobDir, emit: (event) => events.push(event) });
  assert.equal(await readFile(retryVideo, 'utf8'), 'resumed sentinel');
  assert.deepEqual(
    events.filter((event) => event.stage === '80-presentation-retry').map((event) => event.status),
    ['complete'],
  );
  assert.deepEqual(await read('80-presentation-retry/index.json'), first);
  assert.equal((await read('75-product.json')).acceptedAttempt, '80-presentation-retry');
});

test('a physically invalid trace is dropped before the 3D render and reauthors once', async (t) => {
  const { jobDir, events, read } = await harness(t, {
    contract: SEMANTIC_CONTRACT,
    cells: [{ ...CELLS[0], trace: CRASHED_TRACE }],
    gateRejects: [],
    renderFails: { first: {}, retry: {} },
    // The reauthored attempt never gets a presentable cell either, so the nested
    // run ends rejected and the parent keeps its own artifacts.
    review: { first: {}, retry: {} },
  });

  const eligibility = await read('55-eligibility.json');
  assert.equal(eligibility.collisionPolicy, 'reject');
  assert.equal(eligibility.admittedCells, 1);
  assert.equal(eligibility.eligibleCells, 0);
  assert.ok(eligibility.defectCodes.includes('simulation.collision.contract_violation'));
  assert.ok(eligibility.defectCodes.includes('simulation.actor.frozen_tail'));
  assert.equal(eligibility.cells[0].retry, 'resimulate');

  // Nothing was rendered or reviewed: the expensive stages saw no candidate.
  assert.deepEqual((await read('65-render3d/index.json')).cells, []);
  assert.deepEqual((await read('60-render2d/index.json')).cells, []);
  assert.equal(await exists(join(jobDir, '65-render3d', 'yale-street-site-a-0')), false);

  const product = await read('75-product.json');
  assert.equal(product.retry.kind, 'reauthor');
  assert.equal(product.retry.detail, 'scenario-defect-reauthor');
  assert.ok(product.retry.authorisedBy.includes('scenario.no_eligible_simulation'));
  assert.equal(product.acceptedAttempt, null);

  // The reauthor happened once, in its own directory, and the rejected attempt's
  // gate verdict and cells were left exactly as they were written.
  const attemptBrief = await read('80-reauthor-01/00-brief.json');
  assert.equal(attemptBrief._reauthorDepth, 1);
  assert.match(attemptBrief.brief, /POST-RENDER REPAIR FEEDBACK/);
  assert.match(attemptBrief.brief, /simulation\.collision\.contract_violation/);
  const attemptProduct = await read('80-reauthor-01/75-product.json');
  assert.equal(attemptProduct.retry.kind, 'manual-review', 'the single authorised reauthor is spent');
  assert.ok(await exists(join(jobDir, '80-reauthor-01', '50-gate.json')));
  assert.equal(await exists(join(jobDir, '80-reauthor-01', '80-reauthor-01')), false);
  assert.deepEqual(
    events.filter((event) => event.stage.startsWith('80-')).map((event) => `${event.stage}:${event.status}`),
    ['80-reauthor:running', '80-reauthor:failed'],
  );

  const gallery = await read('90-gallery.json');
  assert.equal(gallery.accepted, false);
  assert.equal(gallery.eligible, 0);
  assert.equal(gallery.retry.kind, 'reauthor');
  assert.ok(gallery.defectCodes.includes('simulation.collision.contract_violation'));
});

test('a valid trace renders, reviews and is accepted with no retry at all', async (t) => {
  const { jobDir, events, read } = await harness(t, {
    contract: SEMANTIC_CONTRACT,
    cells: CELLS,
    gateRejects: [],
    renderFails: { first: {}, retry: {} },
    review: { first: {}, retry: {} },
  });

  const eligibility = await read('55-eligibility.json');
  assert.equal(eligibility.eligibleCells, 1);
  assert.deepEqual(eligibility.defectCodes, []);
  assert.match(eligibility.cells[0].unsupportedReason, /no lane-corridor guard runs for ego, ped/);

  const product = await read('75-product.json');
  assert.equal(product.retry.kind, 'none');
  assert.equal(product.acceptedCells, 1);
  assert.equal(product.acceptedAttempt, null);
  assert.equal(product.cells[0].semanticAccepted, true);
  assert.equal(product.cells[0].presentationAccepted, true);
  assert.equal(product.cells[0].renderDir, '65-render3d/yale-street-site-a-0');

  const gallery = await read('90-gallery.json');
  assert.equal(gallery.accepted, true);
  assert.equal(gallery.headline, '/artifacts/jobs/job-1/65-render3d/yale-street-site-a-0/rollout.mp4');
  assert.equal(events.some((event) => event.stage.startsWith('80-')), false);
  assert.equal(await exists(join(jobDir, '80-presentation-retry')), false);
});

test('a gate-rejected cell is reported, never re-decided, and never rendered', async (t) => {
  const { jobDir, read } = await harness(t, {
    contract: SEMANTIC_CONTRACT,
    cells: [
      CELLS[0],
      { cellId: 'yale-street-site-b-0', mapId: 'yale-street', siteId: 'site-b', drawIndex: 0, trace: CLEAN_TRACE },
    ],
    gateRejects: ['yale-street-site-b-0'],
    renderFails: { first: {}, retry: {} },
    review: { first: {}, retry: {} },
  });

  const eligibility = await read('55-eligibility.json');
  const rejected = eligibility.cells.find((row) => row.cellId === 'yale-street-site-b-0');
  assert.equal(rejected.admitted, false);
  assert.deepEqual(rejected.defectCodes, []);
  assert.match(rejected.reason, /frozen gate rejected this cell \(C3\)/);
  assert.equal(eligibility.eligibleCells, 1);
  assert.equal(await exists(join(jobDir, '65-render3d', 'yale-street-site-b-0')), false);
  assert.equal(await exists(join(jobDir, '60-render2d', 'yale-street-site-b-0')), false);
});

test('a semantic mismatch mutates the template once and 3D renders only the matched cell', async (t) => {
  const { jobDir, events, read } = await harness(t, {
    contract: SEMANTIC_CONTRACT,
    cells: CELLS,
    mutationCells: [
      { cellId: 'mutated-src', mapId: 'yale-street', siteId: 'site-m', drawIndex: 0, trace: CLEAN_TRACE },
    ],
    gateRejects: [],
    renderFails: { first: {}, retry: {} },
    review: { first: {}, retry: {} },
    semantic2d: {
      first: {
        '*': {
          mechanismFidelity: 'no',
          semanticMatch: false,
          defects: [{ code: 'scenario.mechanism', text: 'the ego never reroutes around the closure' }],
          explanation: 'The ego drives straight past; the requested reroute never happens.',
        },
      },
      'mutation-01': { '*': {} },
    },
  });

  // The oracle rejected the original footage and the first mutation round fixed it.
  const semantic = await read('62-semantic2d.json');
  assert.equal(semantic.matched, 0);
  const round = await read('62-mutation-01/index.json');
  assert.equal(round.matched, 1);
  assert.equal(round.repair.kind, 'template-mutation');
  const matchedCellId = round.semantic.find((row) => row.semanticMatch === true).cellId;
  assert.notEqual(matchedCellId, 'yale-street-site-a-0');
  // The mutated template is a surgical edit of the authored one, not a new episode.
  const mutatedTemplate = await read('62-mutation-01/template.json');
  assert.equal(mutatedTemplate.mutated, 1);
  assert.equal(await exists(join(jobDir, '62-mutation-02')), false);
  assert.equal(await exists(join(jobDir, '62-fallback-author')), false);

  // Exactly one 3D render was spent, on the matched repaired cell only.
  const render3d = await read('65-render3d/index.json');
  assert.equal(render3d.cells.length, 1);
  assert.equal(render3d.cells[0].cellId, matchedCellId);
  assert.equal(render3d.cells[0].status, 'complete');
  assert.equal(await exists(join(jobDir, '65-render3d', 'yale-street-site-a-0')), false);

  const product = await read('75-product.json');
  assert.equal(product.retry.kind, 'none');
  assert.equal(product.acceptedCells, 1);
  const acceptedRow = product.cells.find((row) => row.presentationAccepted === true);
  assert.equal(acceptedRow.cellId, matchedCellId);

  // No recursive authoring episode ran: one 20-author pass, no 80-* attempt.
  assert.equal(events.filter((event) => event.stage === '20-author' && event.status === 'running').length, 1);
  assert.equal(await exists(join(jobDir, '80-reauthor-01')), false);
  assert.equal(await exists(join(jobDir, '80-visual-fallback')), false);

  const benchmark = await read('95-benchmark.json');
  assert.equal(benchmark.funnel['semantic-2d'], true);
  assert.equal(benchmark.counts.semantic2dMatched, 1);
  assert.equal(benchmark.execution.semanticRepair, '62-mutation-01');
  const repairedRow = benchmark.cells.find((cell) => cell.cellId === matchedCellId);
  assert.equal(repairedRow.repairRound, '62-mutation-01');
  assert.equal(repairedRow.semantic2dMatch, true);
});

test('an exhausted semantic loop stops for a person instead of reauthoring', async (t) => {
  const mismatch = {
    '*': {
      mechanismFidelity: 'no',
      semanticMatch: false,
      defects: [{ code: 'scenario.mechanism', text: 'requested mechanism absent' }],
      explanation: 'The requested mechanism never appears.',
    },
  };
  const { jobDir, read } = await harness(t, {
    contract: SEMANTIC_CONTRACT,
    cells: CELLS,
    mutationCells: [
      { cellId: 'mutated-src', mapId: 'yale-street', siteId: 'site-m', drawIndex: 0, trace: CLEAN_TRACE },
    ],
    gateRejects: [],
    renderFails: { first: {}, retry: {} },
    review: { first: {}, retry: {} },
    semantic2d: {
      first: mismatch, 'mutation-01': mismatch, 'mutation-02': mismatch, fallback: mismatch,
    },
  });

  // Both mutation rounds and the capped fallback episode ran, then the loop stopped.
  assert.ok(await exists(join(jobDir, '62-mutation-01', 'index.json')));
  assert.ok(await exists(join(jobDir, '62-mutation-02', 'index.json')));
  assert.ok(await exists(join(jobDir, '62-fallback-author', 'index.json')));
  // 3D was never spent and no recursive full-pipeline repair ran.
  assert.equal((await read('65-render3d/index.json')).status, 'skipped');
  assert.equal(await exists(join(jobDir, '80-reauthor-01')), false);
  const product = await read('75-product.json');
  assert.equal(product.retry.kind, 'manual-review');
  assert.equal(product.acceptedCells, 0);
  const benchmark = await read('95-benchmark.json');
  assert.equal(benchmark.funnel['semantic-2d'] === true, false);
  assert.equal(benchmark.execution.semanticRepair, 'exhausted');
});
