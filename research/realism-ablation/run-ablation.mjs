#!/usr/bin/env node
/**
 * WS4.2 — realism ablation runner (the decision experiment).
 *
 * Drives the WS1 bridge-fidelity scorecard tool over two rendered frame sets
 * of the same underlying scenarios:
 *   stage A — three.js/Chrome frames (available today; produced by
 *             scripts/export-render.mjs, e.g. via the determinism harness)
 *   stage B — Bevy atmosphere/shadow frames (produced by scripts/renderer-spike
 *             when the bake-off lands)
 * and emits a comparison verdict JSON. The renderer choice comes from this
 * ablation, not taste (plan gate), so the scoring order follows WS1's
 * authority order: detector-based paired metrics dominate; FID only breaks
 * ties.
 *
 * Scorecard contract (WS1-owned): JSON with
 *   { corpusHash, detector: {name, version, weightsSha256},
 *     perClass: {ap, recall}, hallucinationRate, deletionRate, fid?, verdict }
 *
 * Usage:
 *   node research/realism-ablation/run-ablation.mjs \
 *     --stage-a artifacts/render-determinism/<run>/pass-a \
 *     [--stage-b <bevy-frames-dir> | --poll-spike <seconds>] \
 *     --scorecard-cmd '<cmd> %FRAMES%' \
 *     --out artifacts/realism-ablation/<run>.json [--record]
 *
 * If packages/bridge-fidelity has landed, --scorecard-cmd may be omitted: the
 * runner then tries `pnpm --filter @simforge/bridge-fidelity exec node dist/score-cli.js %FRAMES%`.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const VERDICT_SCHEMA = 'uniscenarios.realism-ablation-verdict.v1';

/** Decision margin on the composite quality score below which the stages tie. */
const DECISION_MARGIN = 0.02;

function argsOf(argv) {
  const values = new Map();
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected positional argument ${token}`);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) values.set(token.slice(2), 'true');
    else {
      values.set(token.slice(2), next);
      i += 1;
    }
  }
  return values;
}

async function listFrameFiles(dir) {
  const entries = await readdir(dir, { recursive: true });
  return entries.filter((name) => /\.png$/i.test(name)).sort();
}

/** Frames-dir digest binds the ablation to the exact pixels scored. */
async function framesDirDigest(dir, files) {
  const hash = createHash('sha256');
  hash.update(`${dir}\0`);
  for (const name of files) {
    hash.update(name);
    hash.update(await readFile(path.join(dir, name)));
  }
  return hash.digest('hex');
}

function runScorecard(commandTemplate, framesDir) {
  const [file, ...rest] = commandTemplate.split(' ');
  const args = rest.map((arg) => arg.replaceAll('%FRAMES%', framesDir));
  return new Promise((resolve) => {
    execFile(file, args, { cwd: repoRoot, timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: String(error), stderrTail: String(stderr).slice(-4000) });
        return;
      }
      try {
        resolve({ ok: true, scorecard: JSON.parse(stdout) });
      } catch (parseError) {
        resolve({ ok: false, error: `scorecard stdout was not JSON: ${parseError.message}`, stderrTail: String(stderr).slice(-4000) });
      }
    });
  });
}

const REQUIRED_SCORECARD_FIELDS = ['corpusHash', 'detector', 'perClass', 'hallucinationRate', 'deletionRate'];

function validateScorecard(scorecard) {
  const missing = REQUIRED_SCORECARD_FIELDS.filter((field) => !(field in scorecard));
  if (missing.length > 0) return `missing field(s): ${missing.join(', ')}`;
  if (typeof scorecard.perClass !== 'object' || typeof scorecard.perClass.ap !== 'number' || typeof scorecard.perClass.recall !== 'number') {
    return 'perClass must carry numeric ap and recall';
  }
  return null;
}

/**
 * Composite quality in WS1's authority order: paired detector agreement
 * (recall) minus the engine-ground-truth error rates. FID is deliberately NOT
 * in the composite; it only breaks ties.
 */
function qualityScore(scorecard) {
  return scorecard.perClass.recall - scorecard.hallucinationRate - scorecard.deletionRate;
}

function compare(scorecardA, scorecardB) {
  const qa = qualityScore(scorecardA);
  const qb = qualityScore(scorecardB);
  const margin = qb - qa;
  let verdict;
  if (margin > DECISION_MARGIN) verdict = 'stage-b-bevy-wins';
  else if (margin < -DECISION_MARGIN) verdict = 'stage-a-threejs-wins';
  else if (scorecardA.fid != null && scorecardB.fid != null && Math.abs(margin) <= DECISION_MARGIN) {
    // FID as tie-breaker only.
    verdict = scorecardB.fid < scorecardA.fid - 1.0 ? 'stage-b-bevy-wins' : 'tie-fid-insufficient';
  } else verdict = 'tie';
  return {
    verdict,
    metricAuthorityOrder: [
      'per-class detector recall delta (paired real-corpus metrics)',
      'hallucination/deletion rate vs engine ground truth',
      'FID strictly as tie-breaker',
    ],
    decisionMargin: DECISION_MARGIN,
    quality: {
      formula: 'perClass.recall - hallucinationRate - deletionRate',
      stageA: qa,
      stageB: qb,
      marginStageBminusStageA: margin,
    },
    perMetric: {
      perClassApDelta: scorecardB.perClass.ap - scorecardA.perClass.ap,
      perClassRecallDelta: scorecardB.perClass.recall - scorecardA.perClass.recall,
      hallucinationRateDelta: scorecardB.hallucinationRate - scorecardA.hallucinationRate,
      deletionRateDelta: scorecardB.deletionRate - scorecardA.deletionRate,
      ...(scorecardA.fid != null && scorecardB.fid != null ? { fidDelta: scorecardB.fid - scorecardA.fid } : {}),
    },
  };
}

/** Find a Bevy frames directory under the renderer-spike output root. */
function findBevyFrames(spikeOut) {
  if (!existsSync(spikeOut)) return null;
  const stack = [spikeOut];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const pngs = entries.filter((entry) => entry.isFile() && /\.png$/i.test(entry.name));
    const bevyNamedPngs = entries.filter((entry) => entry.isFile() && /bevy.*\.png$/i.test(entry.name));
    // Matches both a dedicated bevy frames directory and the spike's flat
    // `bevy_*.png` output layout (rgb0/id/depth probes).
    if ((/bevy/i.test(path.basename(dir)) && pngs.length >= 2) || bevyNamedPngs.length >= 2) return dir;
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
    }
  }
  return null;
}

import { readdirSync } from 'node:fs';

async function main() {
  const args = argsOf(process.argv);
  const stageADir = args.has('stage-a') ? path.resolve(repoRoot, args.get('stage-a')) : null;
  if (!stageADir || !existsSync(stageADir)) throw new Error('--stage-a must name an existing three.js frame set directory');
  const spikeOut = path.resolve(args.get('spike-out') ?? '/home/path/SimForge/scripts/renderer-spike/out');
  const pollSeconds = Number(args.get('poll-spike') ?? 0);
  const record = args.has('record');
  const outFile = path.resolve(repoRoot, args.get('out') ?? `artifacts/realism-ablation/ablation-${Date.now()}.json`);

  // Default scorecard driver: WS1's bridge-fidelity CLI (see docs/rl-platform-hardening-plan.md WS1).
  //   uv run --project research/bridge-fidelity bf-score --translated <frames> \
  //     --gt-jsonl <engine frame gt> --real-manifest packages/bridge-fidelity/corpus/real-corpus.manifest.v1.json
  const gtJsonl = args.has('gt-jsonl') ? path.resolve(repoRoot, args.get('gt-jsonl')) : null;
  const realManifest = args.has('real-manifest')
    ? path.resolve(repoRoot, args.get('real-manifest'))
    : path.join(repoRoot, 'packages/bridge-fidelity/corpus/real-corpus.manifest.v1.json');
  const scorecardOutDir = path.dirname(outFile);
  const scorecardCmd = args.get('scorecard-cmd') ?? [
    'uv', 'run', '--project', path.join(repoRoot, 'research/bridge-fidelity'), 'bf-score',
    '--translated', '%FRAMES%',
    '--gt-jsonl', gtJsonl ?? '%GT_JSONL%',
    '--real-manifest', realManifest,
    '--out', path.join(scorecardOutDir, 'scorecard-%STAGE%.json'),
  ].join(' ');
  if (!args.get('scorecard-cmd') && !gtJsonl) {
    process.stderr.write('[ablation] warning: --gt-jsonl not given; default bf-score invocation will fail until it is provided\n');
  }

  async function scoreStage(framesDir, stageLabel) {
    const files = await listFrameFiles(filesDirGuard(framesDir));
    const framesSha256 = await framesDirDigest(framesDir, files);
    const command = scorecardCmd.replaceAll('%STAGE%', stageLabel);
    const run = await runScorecard(command, framesDir);
    if (!run.ok) {
      return { command, framesDir, frameCount: files.length, framesSha256, scorecard: null, status: 'scorecard-unavailable', detail: run.error, stderrTail: run.stderrTail };
    }
    const invalid = validateScorecard(run.scorecard);
    if (invalid) {
      return { command, framesDir, frameCount: files.length, framesSha256, scorecard: run.scorecard, status: 'scorecard-invalid', detail: invalid };
    }
    return { command, framesDir, frameCount: files.length, framesSha256, scorecard: run.scorecard, status: 'scored' };
  }

  function filesDirGuard(dir) {
    if (!existsSync(dir)) throw new Error(`frames dir does not exist: ${dir}`);
    return dir;
  }

  // Stage B: explicit dir, else poll the spike output for Bevy frames.
  let stageBDir = args.has('stage-b') ? path.resolve(repoRoot, args.get('stage-b')) : findBevyFrames(spikeOut);
  if (!stageBDir && pollSeconds > 0) {
    const deadline = Date.now() + pollSeconds * 1000;
    process.stderr.write(`[ablation] polling ${spikeOut} for Bevy frames for ${pollSeconds}s\n`);
    while (!stageBDir && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      stageBDir = findBevyFrames(spikeOut);
    }
  }

  const stageA = await scoreStage(stageADir, 'stage-a');
  const stageB = stageBDir && existsSync(stageBDir) ? await scoreStage(stageBDir, 'stage-b') : {
    command: null,
    framesDir: null,
    frameCount: 0,
    framesSha256: null,
    scorecard: null,
    status: 'pending-bevy-frames',
    detail: `no directory under ${spikeOut} matches bevy frame layout yet; re-run with --stage-b <dir> once scripts/renderer-spike emits frames`,
  };

  const comparable = stageA.status === 'scored' && stageB.status === 'scored'
    && stageA.scorecard.corpusHash === stageB.scorecard.corpusHash
    && stageA.scorecard.detector.weightsSha256 === stageB.scorecard.detector.weightsSha256;
  const comparison = comparable
    ? compare(stageA.scorecard, stageB.scorecard)
    : null;

  const verdictJson = {
    schema: VERDICT_SCHEMA,
    generatedAt: new Date().toISOString(),
    scorecardCommand: scorecardCmd,
    stageA,
    stageB,
    comparison,
    verdict: comparable
      ? comparison.verdict
      : 'incomplete — both stages need valid scorecards from the same corpusHash + detector weights before a renderer decision',
    notes: [
      'Decision authority belongs to this ablation, not taste; scoring order follows WS1 (detector metrics first, FID tie-breaker only).',
      ...(comparable ? [] : ['Stage B completes with: node research/realism-ablation/run-ablation.mjs --stage-a <dir> --stage-b <bevyFramesDir> --out <verdict.json>']),
    ],
  };

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(verdictJson, null, 2)}\n`);
  if (record) {
    const evidenceDir = path.join(repoRoot, 'research/realism-ablation/evidence');
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, path.basename(outFile)), `${JSON.stringify(verdictJson, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    outputPath: path.relative(repoRoot, outFile),
    stageAStatus: stageA.status,
    stageBStatus: stageB.status,
    verdict: verdictJson.verdict,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
