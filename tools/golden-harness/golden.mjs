#!/usr/bin/env node
/**
 * Native render golden harness — WSB6 (DeterminismCI).
 *
 * Drives the Bevy headless spike binary (scripts/renderer-spike/bevy-spike,
 * later native/render-core) to record and verify golden pass hashes per GPU
 * fingerprint, with a frame-time regression budget. Evidence manifests extend
 * `uniscenarios.render-determinism-manifest.v1` (WSB4's schema — see
 * docs/determinism-claim.md); the additions are documented in
 * docs/native-golden-ci.md.
 *
 * Commands:
 *   node tools/golden-harness/golden.mjs record  <scene>   run twice, require byte-stable, write golden
 *   node tools/golden-harness/golden.mjs verify  <scene>   one run, compare hashes + frame-time budget
 *   node tools/golden-harness/golden.mjs verify-all        verify every scene in scenes/
 *
 * Scene overrides for red-path demos: --set rendererArgs.sunElev=20
 *
 * Exit codes: 0 ok · 2 pass-hash drift · 3 frame-time budget exceeded ·
 * 4 nondeterministic on record (two runs differ) · 5 no golden for this GPU ·
 * 6 GPU busy (co-tenant load; infra, not drift) · 1 usage/environment error.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNativeHardware } from './lib/fingerprint.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HARNESS = path.join(repoRoot, 'tools/golden-harness');
const SCENES_DIR = process.env.GOLDEN_SCENES_DIR ?? path.join(HARNESS, 'scenes');
const GOLDENS_DIR = process.env.GOLDEN_STORE_DIR ?? path.join(HARNESS, 'goldens');
const ARTIFACTS_DIR = process.env.GOLDEN_ARTIFACTS_DIR ?? path.join(repoRoot, 'artifacts/golden-harness');

// ---------------------------------------------------------------------------
// helpers

const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') {
      const [k, v] = argv[++i].split('=');
      args.overrides ??= [];
      args.overrides.push([k, v]);
    } else if (a.startsWith('--')) {
      args[a.slice(2)] = argv[++i];
    } else {
      args._.push(a);
    }
  }
  return args;
}

function applyOverrides(scene, overrides) {
  const clone = structuredClone(scene);
  for (const [dotPath, raw] of overrides ?? []) {
    const keys = dotPath.split('.');
    let node = clone;
    while (keys.length > 1) {
      node ??= {};
      node = node[keys.shift()];
    }
    const leaf = keys[0];
    const prev = node?.[leaf];
    node[leaf] =
      typeof prev === 'number' && !Number.isNaN(Number(raw)) ? Number(raw)
      : prev === true || prev === false ? raw === 'true'
      : Array.isArray(prev) ? String(raw).split(',').map(Number)
      : raw;
  }
  return clone;
}

/**
 * Co-tenant guard: the 5080 is shared (other lanes render/train on it).
 * Heavy concurrent GPU state has been observed to both inflate frame times
 * (~5x) and rarely destabilize the lit RGB path, so gates run only on a
 * reasonably quiet GPU. Exit 6 = infra condition, not hash drift.
 * GOLDEN_GPU_WAIT: seconds to wait for a quiet window (default 0 = immediate).
 */
async function requireQuietGpu() {
  const waitSecs = Number(process.env.GOLDEN_GPU_WAIT ?? 0);
  const deadline = Date.now() + waitSecs * 1000;
  for (;;) {
    const out = spawnSync('nvidia-smi', ['--query-gpu=memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).stdout ?? '';
    const [usedMiB, totalMiB, utilPct] = out.trim().split(',').map((v) => Number(v.trim()));
    const maxMemFrac = Number(process.env.GOLDEN_GPU_MAX_MEM_FRAC ?? 0.5);
    const maxUtil = Number(process.env.GOLDEN_GPU_MAX_UTIL ?? 50);
    const busy = usedMiB > maxMemFrac * totalMiB || utilPct > maxUtil;
    if (!busy) return;
    if (Date.now() >= deadline) {
      fail(6, `GPU busy (mem ${usedMiB}/${totalMiB} MiB, util ${utilPct}%) — golden runs need a quiet GPU; set GOLDEN_GPU_WAIT or free the GPU`);
    }
    console.log(`[golden-harness] GPU busy (mem ${usedMiB} MiB, util ${utilPct}%) — waiting for quiet window...`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

function resolvePaths(scene) {
  const corpusRoot = process.env.SCEN_SENSOR_CORPUS
    ?? path.join(repoRoot, 'scripts/renderer-spike/corpus');
  const glbs = scene.corpusFiles.map((f) => path.join(corpusRoot, f));
  for (const g of glbs) {
    if (!fs.existsSync(g)) {
      fail(1, `corpus file missing: ${g} (set SCEN_SENSOR_CORPUS to the decoded corpus root)`);
    }
  }
  return { corpusRoot, glbs };
}

function loadScene(id) {
  const p = path.join(SCENES_DIR, `${id}.json`);
  if (!fs.existsSync(p)) fail(1, `unknown scene: ${id} (${p})`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Map logical pass key -> output file produced by the spike's --out prefix. */
function passFiles(outPrefix) {
  return {
    rgb0: `${outPrefix}.rgb0.png`,
    id0: `${outPrefix}.id.png`,
    depth0: `${outPrefix}.depth.f32.bin`, // raw Depth32Float buffer, not the PNG visualization
    mv0: `${outPrefix}.mv.f32.bin`, // WSB2 motion vectors, raw Rg16Float (naming confirmed; gate when the pass ships)
  };
}

function hashPasses(outPrefix, passes) {
  const map = passFiles(outPrefix);
  const out = {};
  for (const key of passes) {
    const f = map[key];
    if (!fs.existsSync(f)) fail(1, `expected pass output missing: ${f}`);
    out[key] = { file: path.basename(f), sha256: sha256File(f), bytes: fs.statSync(f).size };
  }
  // Legend is deterministic metadata; recorded as diagnostic, not a gate.
  const legend = `${outPrefix}.legend.json`;
  if (fs.existsSync(legend)) out.legend = { file: 'legend.json', sha256: sha256File(legend), diagnostic: true };
  return out;
}

function buildSpikeInvocation(scene, glbs, outPrefix) {
  const a = scene.rendererArgs;
  return [
    '--glbs', glbs.join(','),
    '--eye', ...a.eye.map(String),
    '--target', ...a.target.map(String),
    '--fov', String(a.fov), '--width', String(a.width), '--height', String(a.height),
    '--warmup', String(a.warmup), '--frames', String(a.frames),
    '--cameras', String(a.cameras),
    '--sun-elev', String(a.sunElev), '--sun-azim', String(a.sunAzim),
    '--lux', String(a.lux), '--ambient', String(a.ambient),
    // Forward-compatible flags for newer binaries (e.g. WSB4 --rung/--profile/--weather).
    ...(scene.extraArgs ?? []),
    '--out', outPrefix,
  ];
}

function runSpike(binPath, invocation, label) {
  console.log(`[golden-harness] spike run ${label}: ${path.basename(binPath)} ${invocation.join(' ')}`);
  const r = spawnSync(binPath, invocation, { encoding: 'utf8', timeout: 600_000 });
  if (r.status !== 0) {
    fail(1, `spike exited ${r.status}\nstdout tail:\n${(r.stdout ?? '').slice(-2000)}\nstderr tail:\n${(r.stderr ?? '').slice(-2000)}`);
  }
  const timingsLine = (r.stdout ?? '').split('\n').find((l) => l.startsWith('TIMINGS '));
  if (!timingsLine) fail(1, 'spike did not print a TIMINGS line');
  return JSON.parse(timingsLine.slice('TIMINGS '.length));
}

function cargoVersions() {
  // wgpu + bevy versions from the built crate's Cargo.lock.
  let lock = '';
  for (const cand of [
    path.join(repoRoot, 'native/Cargo.lock'),
    path.join(repoRoot, 'scripts/renderer-spike/bevy-spike/Cargo.lock'),
  ]) {
    if (fs.existsSync(cand)) { lock = fs.readFileSync(cand, 'utf8'); break; }
  }
  const ver = (name) => lock.match(new RegExp(`\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`))?.[1] ?? null;
  return { bevy: ver('bevy'), wgpu: ver('wgpu') };
}

function rustcVersion() {
  try {
    return spawnSync('rustc', ['--version'], { encoding: 'utf8' }).stdout.trim();
  } catch { return null; }
}

function resolveBinary(args) {
  // Production path first (native/render-core bin `native-render`, byte-identical
  // CLI to the spike today); spike binary kept as fallback for pre-scaffold trees.
  const candidates = [
    args.bin,
    path.join(repoRoot, 'native/target/release/native-render'),
    path.join(repoRoot, 'scripts/renderer-spike/bevy-spike/target/release/bevy-spike'),
  ].filter(Boolean);
  const bin = candidates.find((p) => fs.existsSync(p));
  if (!bin) fail(1, `no renderer binary found (tried: ${candidates.join(', ')}) — build it first (cargo build --release in native/)`);
  return bin;
}

function manifestBase({ mode, scene, hardware, binPath, invocation, versions }) {
  return {
    schema: 'uniscenarios.render-determinism-manifest.v1',
    generatedAt: new Date().toISOString(),
    claim: 'byte-exactness of the native (Bevy/wgpu) sensor-profile pass hashes across renders of one fixed scene state on pinned hardware',
    mode,
    profile: scene.profile,
    scenario: {
      instanceId: null,
      mapId: scene.mapId,
      sceneId: scene.sceneId,
      inputs: { sceneDefinition: `tools/golden-harness/scenes/${scene.sceneId}.json` },
    },
    rendererPath: {
      engine: 'native-bevy',
      file: path.relative(repoRoot, binPath),
      sha256: sha256File(binPath),
      invocation: { args: invocation, passesRenderedSequentially: false },
      versions: { ...versions, rustc: rustcVersion(), backend: 'vulkan' },
    },
    hardware,
  };
}

function writeManifest(obj, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  console.log(`[golden-harness] wrote ${path.relative(repoRoot, file)}`);
}

function goldenPath(hardware, sceneId) {
  return path.join(GOLDENS_DIR, hardware.gpuFingerprint, `${sceneId}.json`);
}

function fail(code, msg) {
  console.error(`[golden-harness] ERROR: ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// commands

async function cmdRecord(args) {
  const sceneId = args._[1];
  if (!sceneId) fail(1, 'usage: golden.mjs record <scene>');
  const scene = applyOverrides(loadScene(sceneId), args.overrides);
  const { glbs } = resolvePaths(scene);
  const binPath = resolveBinary(args);

  await requireQuietGpu();
  console.log('[golden-harness] collecting hardware fingerprint...');
  const hardware = await collectNativeHardware();
  console.log(`[golden-harness] gpuFingerprint=${hardware.gpuFingerprint} gpu=${hardware.host.gpus[0].name} driver=${hardware.host.gpus[0].driverVersion}`);

  const corpusChecksums = glbs.map((g) => ({
    path: path.basename(g),
    sha256: sha256File(g),
    bytes: fs.statSync(g).size,
  }));
  const artifacts = path.join(ARTIFACTS_DIR, 'record', sceneId);
  fs.mkdirSync(artifacts, { recursive: true });

  const versions = cargoVersions();
  const base = { scene, hardware, binPath, versions };

  // Two independent process runs — the determinism evidence itself.
  const runs = [];
  for (const label of ['runA', 'runB']) {
    const prefix = path.join(artifacts, label, sceneId);
    fs.mkdirSync(path.dirname(prefix), { recursive: true });
    const invocation = buildSpikeInvocation(scene, glbs, prefix);
    const timings = runSpike(binPath, invocation, label);
    runs.push({
      timings,
      passHashes: hashPasses(prefix, scene.expectedPasses),
      invocation,
    });
  }

  const drift = Object.keys(runs[0].passHashes)
    .filter((k) => !runs[0].passHashes[k].diagnostic)
    .filter((k) => runs[0].passHashes[k].sha256 !== runs[1].passHashes[k].sha256);
  if (drift.length > 0) {
    fail(4, `two record runs disagree on passes: ${drift.join(',')} — this GPU/render path is NOT byte-stable; refusing to write a golden`);
  }

  const golden = {
    ...manifestBase({ mode: 'golden-record', ...base, invocation: runs[0].invocation }),
    passHashes: runs[0].passHashes,
    corpusChecksums,
    timings: {
      avgFrameMs: runs[0].timings.avg_frame_ms,
      p50FrameMs: runs[0].timings.p50_frame_ms,
      p99FrameMs: runs[0].timings.p99_frame_ms,
      fps: runs[0].timings.fps,
      measuredFrames: runs[0].timings.measured_frames,
    },
    twoRunEvidence: {
      runsCompared: 2,
      byteStable: true,
      runBTimingsAvgFrameMs: runs[1].timings.avg_frame_ms,
    },
    verdict: {
      byteStable: true,
      driftedPasses: [],
      scope: 'sensor-profile pass hashes, single GPU/driver/wgpu backend — cross-hardware reproducibility NOT claimed (docs/determinism-claim.md)',
    },
  };
  const gp = goldenPath(hardware, sceneId);
  fs.mkdirSync(path.dirname(gp), { recursive: true });
  // Per-pass golden versioning: superseded goldens are archived append-only,
  // so an rgb0 re-record (e.g. WSB4 realism stack landing) preserves prior
  // id0/depth0 history for audit.
  if (fs.existsSync(gp)) {
    const prev = JSON.parse(fs.readFileSync(gp, 'utf8'));
    delete prev.previousVersions;
    golden.previousVersions ??= [];
    golden.previousVersions.push(prev);
  }
  fs.writeFileSync(gp, JSON.stringify(golden, null, 2));
  writeManifest(golden, path.join(artifacts, 'manifest.json'));
  console.log(`[golden-harness] RECORDED golden for ${sceneId} @ ${hardware.gpuFingerprint}`);
  console.log(`  baseline avg_frame_ms=${golden.timings.avgFrameMs.toFixed(3)} p50=${golden.timings.p50FrameMs.toFixed(3)} (budget: verify fails above ${(golden.timings.avgFrameMs * 1.10).toFixed(3)})`);
  for (const [k, v] of Object.entries(golden.passHashes)) console.log(`  ${k.padEnd(7)} ${v.sha256.slice(0, 16)}…  ${v.bytes}B`);
}

async function cmdVerify(args) {
  const all = args._[1] === undefined || args._[1] === 'all';
  const sceneIds = all
    ? fs.readdirSync(SCENES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    : [args._[1]];
  let failed = 0;
  for (const id of sceneIds) {
    try {
      await verifyOne(args, id);
    } catch (e) {
      if (e.exitCode) failed = Math.max(failed, e.exitCode);
      else throw e;
    }
  }
  if (failed) process.exit(failed);
}

class GateFailure extends Error {
  constructor(exitCode, msg) { super(msg); this.exitCode = exitCode; }
}

async function verifyOne(args, sceneId) {
  const scene = applyOverrides(loadScene(sceneId), args.overrides);
  const { glbs } = resolvePaths(scene);
  const binPath = resolveBinary(args);

  await requireQuietGpu();
  const hardware = await collectNativeHardware();
  const gp = goldenPath(hardware, sceneId);
  if (!fs.existsSync(gp)) {
    throw new GateFailure(5, `no golden for gpuFingerprint=${hardware.gpuFingerprint} scene=${sceneId} — record first on this GPU (policy: goldens are per-GPU, never universal)`);
  }
  const golden = JSON.parse(fs.readFileSync(gp, 'utf8'));

  const artifacts = path.join(ARTIFACTS_DIR, 'verify', sceneId);
  fs.mkdirSync(artifacts, { recursive: true });
  const prefix = path.join(artifacts, 'verify-run', sceneId);
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const invocation = buildSpikeInvocation(scene, glbs, prefix);
  const timings = runSpike(binPath, invocation, 'verify');
  const observed = hashPasses(prefix, [...scene.expectedPasses, ...(Object.keys(golden.passHashes).includes('legend') ? ['legend'] : [])]);

  // Gate 1: pass-hash drift.
  const drifted = Object.entries(golden.passHashes)
    .filter(([k, v]) => !v.diagnostic)
    .filter(([k, v]) => !(observed[k]?.sha256 === v.sha256))
    .map(([k]) => k);

  // Gate 2: frame-time budget (>10% avg-frame regression vs recorded baseline).
  const budgetFactor = Number(process.env.GOLDEN_FRAME_BUDGET ?? 1.10);
  const baseline = golden.timings.avgFrameMs;
  const regressionPct = ((timings.avg_frame_ms - baseline) / baseline) * 100;

  const manifest = {
    ...manifestBase({ mode: 'golden-verify', scene, hardware, binPath, invocation, versions: cargoVersions() }),
    passHashes: observed,
    corpusChecksums: golden.corpusChecksums,
    timings: {
      avgFrameMs: timings.avg_frame_ms, p50FrameMs: timings.p50_frame_ms,
      p99FrameMs: timings.p99_frame_ms, fps: timings.fps,
      measuredFrames: timings.measured_frames,
      baselineAvgFrameMs: baseline,
      regressionPct: Number(regressionPct.toFixed(2)),
      budgetFactor,
    },
    verdict: {
      byteStable: drifted.length === 0,
      driftedPasses: drifted,
      frameTimeBudgetExceeded: regressionPct > (budgetFactor - 1) * 100,
      scope: golden.verdict.scope,
    },
  };
  writeManifest(manifest, path.join(artifacts, 'manifest.json'));

  console.log(`[golden-harness] verify ${sceneId} @ fp=${hardware.gpuFingerprint}:`);
  for (const [k, v] of Object.entries(observed)) {
    const exp = golden.passHashes[k];
    const ok = exp && (exp.sha256 === v.sha256);
    console.log(`  ${ok ? 'MATCH' : 'DRIFT'}  ${k.padEnd(7)} ${v.sha256.slice(0, 16)}…${exp && !ok ? ` (golden ${exp.sha256.slice(0, 16)}…)` : ''}`);
  }
  console.log(`  frame-time: ${timings.avg_frame_ms.toFixed(3)} ms vs baseline ${baseline.toFixed(3)} ms → ${regressionPct >= 0 ? '+' : ''}${regressionPct.toFixed(1)}% (budget +${((budgetFactor - 1) * 100).toFixed(0)}%)`);

  if (drifted.length > 0) {
    console.error(`[golden-harness] FAIL(${sceneId}): pass-hash drift in: ${drifted.join(', ')}`);
    throw new GateFailure(2, 'pass-hash drift');
  }
  if (regressionPct > (budgetFactor - 1) * 100) {
    console.error(`[golden-harness] FAIL(${sceneId}): frame-time regression ${regressionPct.toFixed(1)}% exceeds budget`);
    throw new GateFailure(3, 'frame-time budget exceeded');
  }
  console.log(`[golden-harness] PASS ${sceneId}`);
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  if (cmd === 'record') await cmdRecord(args);
  else if (cmd === 'verify') await cmdVerify(args);
  else fail(1, 'usage: golden.mjs <record|verify> <scene|all> [--set dotted.path=value] [--bin path]');
} catch (e) {
  if (e instanceof GateFailure) { console.error(`[golden-harness] ERROR: ${e.message}`); process.exit(e.exitCode); }
  throw e;
}
