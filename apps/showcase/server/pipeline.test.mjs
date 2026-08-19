/**
 * End-to-end smoke coverage for the showcase pipeline's eligibility, semantic
 * oracle, and acceptance flow, driven through the real `ShowcasePipeline.run`
 * with stand-in `python` and `cli` executables.
 *
 * The stand-ins are deliberately thin: they answer the exact JSON protocol the
 * pipeline speaks and write the exact artifacts it reads, so every decision, path
 * and file this test observes is made by the production code.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { ShowcasePipeline, exists } from './pipeline.mjs';
import { NEVER_SCREENED_REASON, PRODUCT_CONTRACT_VERSION } from './product-contract.mjs';

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
  // The blind 2D footage pass: it ranks candidates and decides nothing.
  emit({ cellId: flag('cell').split('/').pop(), plausible: true, realism: 8, dynamism: 7, defects: [] });
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
  if (tier === '3d' && (plan.renderFails[cellId] ?? null)) {
    process.stderr.write(plan.renderFails[cellId] + '\\n');
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

  // Both footage reviews only run when a gateway answers on the conventional
  // port. Bind it if it is free; a real gateway already listening is equally
  // acceptable.
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

const MISMATCH = {
  '*': {
    mechanismFidelity: 'no',
    semanticMatch: false,
    defects: [{ code: 'scenario.mechanism', text: 'requested mechanism absent' }],
    scenarioDefectCodes: ['scenario.mechanism'],
    explanation: 'The requested mechanism never appears.',
  },
};

test('a 3D render failure rejects the cell with its own code and never reaches the author', async (t) => {
  const { jobDir, events, read } = await harness(t, {
    contract: SEMANTIC_CONTRACT,
    cells: CELLS,
    gateRejects: [],
    renderFails: {
      'yale-street-site-a-0': 'incident composition failed at t=6.2 for every searched camera: ego(inFrame=false)',
    },
  });

  const render3d = await read('65-render3d/index.json');
  assert.equal(render3d.cells[0].status, 'error');
  assert.deepEqual(render3d.cells[0].defectCodes, ['render.camera.composition_failed']);

  // The oracle matched the scenario, so the semantic verdict stands on its own; only the
  // render is missing, and the exporter's own code says so.
  const product = await read('75-product.json');
  assert.equal(product.contract.version, PRODUCT_CONTRACT_VERSION);
  assert.equal(product.cells[0].semanticAccepted, true);
  assert.equal(product.cells[0].accepted, false);
  assert.deepEqual(product.cells[0].defectCodes, ['render.camera.composition_failed']);
  assert.equal(product.cells[0].unsupportedReason, null);
  assert.equal(product.acceptedCells, 0);
  assert.equal(product.acceptedAttempt, null);

  // No control repairs this: the oracle already screened the job, so its repair budget is
  // spent and a render fault can never be laundered into an authoring pass.
  assert.equal(product.retry.kind, 'none');
  assert.equal(product.retry.detail, 'oracle-rejected');
  assert.ok(product.retry.authorisedBy.every((code) => !code.startsWith('scenario.')));
  assert.equal(await exists(join(jobDir, '80-reauthor-01')), false);
  assert.equal(await exists(join(jobDir, '80-visual-fallback')), false);
  assert.equal(await exists(join(jobDir, '80-presentation-retry')), false);
  assert.equal(events.some((event) => event.stage.startsWith('80-')), false);
  // Exactly one authoring pass happened: the one this job started with.
  assert.equal(events.filter((event) => event.stage === '20-author' && event.status === 'running').length, 1);

  const gallery = await read('90-gallery.json');
  assert.equal(gallery.accepted, false);
  assert.equal(gallery.semanticAccepted, true);
  // No 3D footage exists, so the headline is the 2D clip that does.
  assert.equal(gallery.headline, '/artifacts/jobs/job-1/60-render2d/yale-street-site-a-0/rollout.mp4');
  assert.equal(await exists(join(jobDir, '70-judge.json')), false);
});

test('a resumed job reads the product decision it already recorded', async (t) => {
  const { jobDir, read, job } = await harness(t, {
    contract: SEMANTIC_CONTRACT,
    cells: CELLS,
    gateRejects: [],
    renderFails: {},
  });
  const first = await read('75-product.json');
  assert.equal(first.acceptedCells, 1);
  const video = join(jobDir, '65-render3d', 'yale-street-site-a-0', 'rollout.mp4');
  await writeFile(video, 'resumed sentinel');

  // Re-running the same job resolves every completed stage from its artifact
  // instead of rendering or reviewing anything again.
  const events = [];
  const pipeline = new ShowcasePipeline({ root: dirname(dirname(jobDir)), python: process.execPath, cli: join(dirname(dirname(jobDir)), 'fake-cli.mjs') });
  pipeline.bridge = join(dirname(dirname(jobDir)), 'fake-bridge.mjs');
  await pipeline.run(job, { jobDir, emit: (event) => events.push(event) });
  assert.equal(await readFile(video, 'utf8'), 'resumed sentinel');
  assert.deepEqual(
    events.filter((event) => ['65-render3d', '75-product', '90-gallery'].includes(event.stage))
      .map((event) => `${event.stage}:${event.status}`),
    ['65-render3d:complete', '75-product:complete', '90-gallery:complete'],
  );
  assert.deepEqual(await read('75-product.json'), first);
  const benchmark = await read('95-benchmark.json');
  assert.equal(benchmark.funnel.accepted, true);
  assert.equal(benchmark.outcome.kind, 'accepted');
});

test('a physically invalid trace is dropped before the 3D render and reauthors once', async (t) => {
  const { jobDir, events, read } = await harness(t, {
    contract: SEMANTIC_CONTRACT,
    cells: [{ ...CELLS[0], trace: CRASHED_TRACE }],
    gateRejects: [],
    renderFails: {},
  });

  const eligibility = await read('55-eligibility.json');
  assert.equal(eligibility.collisionPolicy, 'reject');
  assert.equal(eligibility.admittedCells, 1);
  assert.equal(eligibility.eligibleCells, 0);
  assert.ok(eligibility.defectCodes.includes('simulation.collision.contract_violation'));
  assert.ok(eligibility.defectCodes.includes('simulation.actor.frozen_tail'));
  assert.equal(eligibility.cells[0].retry, 'resimulate');

  // Nothing was rendered or screened: the expensive stages saw no candidate, and the
  // oracle reviewed nothing, so no cell was ever screenable.
  assert.deepEqual((await read('65-render3d/index.json')).cells, []);
  assert.deepEqual((await read('60-render2d/index.json')).cells, []);
  assert.deepEqual((await read('62-semantic2d.json')).cells, []);
  assert.equal(await exists(join(jobDir, '65-render3d', 'yale-street-site-a-0')), false);

  const product = await read('75-product.json');
  assert.equal(product.retry.kind, 'reauthor');
  assert.equal(product.retry.detail, 'scenario-defect-reauthor');
  assert.ok(product.retry.authorisedBy.includes('scenario.no_eligible_simulation'));
  assert.equal(product.acceptedAttempt, null);
  assert.deepEqual(product.cells, []);

  // The reauthor happened once, in its own directory, and the rejected attempt's
  // gate verdict and cells were left exactly as they were written.
  const attemptBrief = await read('80-reauthor-01/00-brief.json');
  assert.equal(attemptBrief._reauthorDepth, 1);
  assert.match(attemptBrief.brief, /POST-RENDER REPAIR FEEDBACK/);
  assert.match(attemptBrief.brief, /simulation\.collision\.contract_violation/);
  const attemptProduct = await read('80-reauthor-01/75-product.json');
  assert.equal(attemptProduct.retry.kind, 'none');
  assert.equal(attemptProduct.retry.detail, 'exhausted', 'the single authorised reauthor is spent');
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
  assert.equal(await exists(join(jobDir, '70-judge.json')), false);
});

test('a valid trace renders, matches the oracle and is accepted with no retry at all', async (t) => {
  const { jobDir, events, read } = await harness(t, {
    contract: SEMANTIC_CONTRACT,
    cells: CELLS,
    gateRejects: [],
    renderFails: {},
  });

  const eligibility = await read('55-eligibility.json');
  assert.equal(eligibility.eligibleCells, 1);
  assert.deepEqual(eligibility.defectCodes, []);
  assert.match(eligibility.cells[0].unsupportedReason, /no lane-corridor guard runs for ego, ped/);

  const product = await read('75-product.json');
  assert.equal(product.schema, 'uniscenarios.showcase-product-decision.v2');
  assert.equal(product.retry.kind, 'none');
  assert.equal(product.acceptedCells, 1);
  assert.equal(product.semanticAcceptedCells, 1);
  assert.equal(product.screenedCells, 1);
  assert.equal(product.unsupportedCells, 0);
  assert.equal(product.acceptedAttempt, null);
  assert.equal(product.cells[0].semanticAccepted, true);
  assert.equal(product.cells[0].accepted, true);
  assert.deepEqual(product.cells[0].defectCodes, []);
  assert.equal(product.cells[0].renderDir, '65-render3d/yale-street-site-a-0');
  assert.deepEqual(product.cells[0].acceptance, {
    contract: { version: PRODUCT_CONTRACT_VERSION },
    gatePassed: true,
    gateFirstFailure: null,
    semanticScreened: true,
    semanticConfidence: 0.9,
    renderTier: '3d',
    renderStatus: 'complete',
  });

  const gallery = await read('90-gallery.json');
  assert.equal(gallery.accepted, true);
  assert.equal(gallery.headline, '/artifacts/jobs/job-1/65-render3d/yale-street-site-a-0/rollout.mp4');
  assert.equal(events.some((event) => event.stage.startsWith('80-')), false);
  assert.equal(await exists(join(jobDir, '70-judge.json')), false);
  // The blind 2D pass still runs and still decides nothing.
  assert.equal((await read('60-render2d/quality.json')).cells.length, 1);
});

test('a gate-rejected cell is reported, never re-decided, and never rendered', async (t) => {
  const { jobDir, read } = await harness(t, {
    contract: SEMANTIC_CONTRACT,
    cells: [
      CELLS[0],
      { cellId: 'yale-street-site-b-0', mapId: 'yale-street', siteId: 'site-b', drawIndex: 0, trace: CLEAN_TRACE },
    ],
    gateRejects: ['yale-street-site-b-0'],
    renderFails: {},
  });

  const eligibility = await read('55-eligibility.json');
  const rejected = eligibility.cells.find((row) => row.cellId === 'yale-street-site-b-0');
  assert.equal(rejected.admitted, false);
  assert.deepEqual(rejected.defectCodes, []);
  assert.match(rejected.reason, /frozen gate rejected this cell \(C3\)/);
  assert.equal(eligibility.eligibleCells, 1);
  assert.equal(await exists(join(jobDir, '65-render3d', 'yale-street-site-b-0')), false);
  assert.equal(await exists(join(jobDir, '60-render2d', 'yale-street-site-b-0')), false);
  // The gate-rejected cell never reached the oracle, so it holds no verdict at all.
  const product = await read('75-product.json');
  assert.deepEqual(product.cells.map((row) => row.cellId), ['yale-street-site-a-0']);
});

test('a cell the oracle never screened is unsupported, not given a verdict', async (t) => {
  // A 2D render failure keeps the cell out of the oracle's reach while the 3D render
  // still runs on the legacy ranked path, which is exactly the never-screened case.
  const { read } = await harness(t, {
    contract: SEMANTIC_CONTRACT,
    cells: CELLS,
    gateRejects: [],
    renderFails: {},
    semantic2d: { first: { '*': { status: 'error', semanticMatch: false } } },
  });
  const product = await read('75-product.json');
  const row = product.cells.find((item) => item.cellId === 'yale-street-site-a-0');
  assert.equal(row.semanticAccepted, false);
  assert.equal(row.accepted, false);
  assert.equal(row.unsupportedReason, NEVER_SCREENED_REASON);
  assert.equal(row.acceptance.semanticScreened, false);
  assert.equal(row.acceptance.semanticConfidence, null);
  assert.equal(product.screenedCells, 0);
  assert.equal(product.unsupportedCells, 1);
});

test('a semantic mismatch mutates the template once and 3D renders only the matched cell', async (t) => {
  const { jobDir, events, read } = await harness(t, {
    contract: SEMANTIC_CONTRACT,
    cells: CELLS,
    mutationCells: [
      { cellId: 'mutated-src', mapId: 'yale-street', siteId: 'site-m', drawIndex: 0, trace: CLEAN_TRACE },
    ],
    gateRejects: [],
    renderFails: {},
    semantic2d: {
      first: {
        '*': {
          mechanismFidelity: 'no',
          semanticMatch: false,
          defects: [{ code: 'scenario.mechanism', text: 'the ego never reroutes around the closure' }],
          scenarioDefectCodes: ['scenario.mechanism'],
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
  const acceptedRow = product.cells.find((row) => row.accepted === true);
  assert.equal(acceptedRow.cellId, matchedCellId);
  // The rejected original still carries the oracle's own scenario code, and no verdict
  // it did not earn.
  const rejectedRow = product.cells.find((row) => row.cellId === 'yale-street-site-a-0');
  assert.equal(rejectedRow.semanticAccepted, false);
  assert.equal(rejectedRow.accepted, false);
  assert.deepEqual(rejectedRow.defectCodes, ['scenario.mechanism']);

  // No recursive authoring episode ran: one 20-author pass, no 80-* attempt.
  assert.equal(events.filter((event) => event.stage === '20-author' && event.status === 'running').length, 1);
  assert.equal(await exists(join(jobDir, '80-reauthor-01')), false);
  assert.equal(await exists(join(jobDir, '80-visual-fallback')), false);

  const benchmark = await read('95-benchmark.json');
  assert.equal(benchmark.funnel['semantic-2d'], true);
  assert.equal(benchmark.funnel.accepted, true);
  assert.equal(benchmark.counts.semantic2dMatched, 1);
  assert.equal(benchmark.counts.accepted, 1);
  assert.equal(benchmark.execution.semanticRepair, '62-mutation-01');
  const repairedRow = benchmark.cells.find((cell) => cell.cellId === matchedCellId);
  assert.equal(repairedRow.repairRound, '62-mutation-01');
  assert.equal(repairedRow.semantic2dMatch, true);
  assert.equal(repairedRow.accepted, true);
});

test('an exhausted semantic loop rejects honestly instead of reauthoring', async (t) => {
  const { jobDir, read } = await harness(t, {
    contract: SEMANTIC_CONTRACT,
    cells: CELLS,
    mutationCells: [
      { cellId: 'mutated-src', mapId: 'yale-street', siteId: 'site-m', drawIndex: 0, trace: CLEAN_TRACE },
    ],
    gateRejects: [],
    renderFails: {},
    semantic2d: {
      first: MISMATCH, 'mutation-01': MISMATCH, 'mutation-02': MISMATCH, fallback: MISMATCH,
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
  assert.equal(product.retry.kind, 'none');
  assert.equal(product.retry.detail, 'oracle-rejected');
  assert.equal(product.acceptedCells, 0);
  assert.equal(product.semanticAcceptedCells, 0);
  assert.ok(product.cells.every((row) => row.defectCodes.includes('scenario.mechanism')));
  const benchmark = await read('95-benchmark.json');
  assert.equal(benchmark.funnel['semantic-2d'] === true, false);
  assert.equal(benchmark.funnel.accepted, false);
  assert.equal(benchmark.outcome.kind, 'rejected');
  assert.equal(benchmark.execution.semanticRepair, 'exhausted');
  assert.equal(await exists(join(jobDir, '70-judge.json')), false);
});
