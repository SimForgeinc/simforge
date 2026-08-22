#!/usr/bin/env node
/**
 * WS4.3 — render determinism harness.
 *
 * Renders the SAME bound scenario (instance + trace + result) twice through
 * the existing Chrome/three.js renderer path (`scripts/export-render.mjs`
 * driving the Studio dev server), then asserts per-frame sha256 equality and
 * emits an evidence manifest with per-pass hashes and a hardware fingerprint.
 *
 * Honesty contract: this tool MEASURES byte-stability, it never assumes it.
 * If the Chrome path is not byte-stable, exit code stays 0 by default and the
 * manifest records the mismatch; pass --require-stable to turn instability
 * into a failing gate once RGB determinism is pinned to hardware.
 *
 *   node tools/render-determinism/determinism-harness.mjs \
 *     --scenario catalog/evidence/yale-street/yale-street-007-multiple-threat-crosswalk-585ad30557a6 \
 *     --out artifacts/render-determinism/run-001 --record
 *
 * Pass coverage: this path emits RGB only. Depth / semantic / instance passes
 * are recorded as `available: false` with the reason; they are produced by the
 * sensor-rig pipeline (packages/browser-renderer sensors) and are in scope for
 * the ID/depth "byte-exact everywhere" tier of docs/determinism-claim.md.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MANIFEST_SCHEMA = 'uniscenarios.render-determinism-manifest.v1';

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

async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function runProcess(command, args, { cwd, timeoutMs = 0 }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const cap = (acc, chunk) => `${acc}${chunk}`.slice(-16_000);
    child.stdout.on('data', (chunk) => { stdout = cap(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = cap(stderr, chunk); });
    const timer = timeoutMs > 0 ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Studio server never became ready at ${url}: ${lastError}`);
}

async function startStudio(port) {
  const url = `http://127.0.0.1:${port}/`;
  const child = spawn('pnpm', [
    '--filter', '@uniscenarios/studio', 'dev', '--host', '127.0.0.1', '--port', String(port),
  ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
  try {
    await waitForServer(url, 300_000);
    return { child, url };
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(`${error.message}\nstudio stderr tail: ${stderr}`);
  }
}

async function listFrames(passDir) {
  // Scenario mode: frame.png (conflict still) + frames/frame-NNN.png.
  // Map-orbit mode: <mapId>/still.png + <mapId>/frames/frame-NNNNNN.png.
  const entries = [];
  const stack = [passDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/^(frame\.png|still\.png)$/.test(entry.name) || /^frame-\d+\.png$/.test(entry.name)) {
        entries.push({ name: path.relative(passDir, full), file: full });
      }
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

async function renderPass(label, exporterArgs, cwd) {
  const startedAt = new Date().toISOString();
  const result = await runProcess(process.execPath, ['scripts/export-render.mjs', ...exporterArgs], {
    cwd,
    timeoutMs: 30 * 60_000,
  });
  return { label, startedAt, finishedAt: new Date().toISOString(), exitCode: result.code, stdoutTail: result.stdout, stderrTail: result.stderr };
}

async function main() {
  const args = argsOf(process.argv);
  const mapMode = args.has('map');
  const scenarioDir = mapMode ? null : path.resolve(repoRoot, args.get('scenario')
    ?? 'catalog/evidence/belmont-research-center/belmont-research-center-001-child-dartout-parked-cars-afeb89eed1e5');
  const outDir = path.resolve(repoRoot, args.get('out') ?? `artifacts/render-determinism/${mapMode ? `map-${args.get('map')}` : path.basename(scenarioDir)}-${Date.now()}`);
  const fps = Number(args.get('fps') ?? 12);
  const framesCount = Number(args.get('frames-count') ?? 12);
  const port = Number(args.get('port') ?? 5199);
  const requireStable = args.has('require-stable');
  const record = args.has('record');

  let inputs;
  let instanceId = null;
  let mapId = mapMode ? args.get('map') : null;
  if (mapMode) {
    inputs = { map: { id: mapId, note: 'deterministic camera orbit over the streamed static city scene' } };
  } else {
    const instanceFile = path.join(scenarioDir, 'instance.json');
    const traceFile = path.join(scenarioDir, 'trace.json.gz');
    const resultFile = path.join(scenarioDir, 'result.json');
    const instance = JSON.parse(await readFile(instanceFile, 'utf8'));
    instanceId = instance.manifest?.instanceId ?? null;
    mapId = instance.manifest?.mapId ?? null;
    inputs = {
      instance: { file: path.relative(repoRoot, instanceFile), sha256: await sha256File(instanceFile) },
      trace: { file: path.relative(repoRoot, traceFile), sha256: await sha256File(traceFile) },
      result: { file: path.relative(repoRoot, resultFile), sha256: await sha256File(resultFile) },
    };
  }

  const studio = await startStudio(port);
  try {
    const exporterArgs = [
      '--url', studio.url,
      '--headless',
      '--fps', String(fps),
    ];
    if (mapMode) {
      exporterArgs.push('--map', mapId, '--frames', String(framesCount));
    } else {
      exporterArgs.push(
        '--instance', path.join(scenarioDir, 'instance.json'),
        '--trace', path.join(scenarioDir, 'trace.json.gz'),
        '--result', path.join(scenarioDir, 'result.json'),
        '--no-video',
      );
    }
    const passDirs = { a: path.join(outDir, 'pass-a'), b: path.join(outDir, 'pass-b') };
    await Promise.all([mkdir(passDirs.a, { recursive: true }), mkdir(passDirs.b, { recursive: true })]);

    // Two independent Chrome processes, identical arguments, sequential so the
    // second pass cannot contend with the first for GPU scheduling.
    const runs = [];
    for (const label of ['a', 'b']) {
      const run = await renderPass(label, [...exporterArgs, '--out', passDirs[label]], repoRoot);
      runs.push(run);
      if (run.exitCode !== 0) {
        throw new Error(`render pass ${label} exited ${run.exitCode}; stderr tail:\n${run.stderrTail}`);
      }
    }

    const framesA = await listFrames(passDirs.a);
    const framesB = await listFrames(passDirs.b);
    const byName = new Map(framesB.map((frame) => [frame.name, frame]));
    const frames = [];
    for (const frameA of framesA) {
      const frameB = byName.get(frameA.name);
      const sha256A = await sha256File(frameA.file);
      const sha256B = frameB ? await sha256File(frameB.file) : null;
      frames.push({
        name: frameA.name,
        bytes: (await readFile(frameA.file)).length,
        sha256PassA: sha256A,
        sha256PassB: sha256B,
        equal: sha256B === sha256A,
      });
      byName.delete(frameA.name);
    }
    for (const extra of byName.values()) {
      frames.push({
        name: extra.name,
        bytes: null,
        sha256PassA: null,
        sha256PassB: await sha256File(extra.file),
        equal: false,
      });
    }

    const { chromium } = await import('playwright-core');
    const { collectHardwareFingerprint } = await import('./gpu-fingerprint.mjs');
    const hardware = await collectHardwareFingerprint(chromium);

    const rgbStable = frames.length > 0 && frames.every((frame) => frame.equal);
    const manifest = {
      schema: MANIFEST_SCHEMA,
      generatedAt: new Date().toISOString(),
      claim: 'byte-exactness of the Chrome/three.js RGB export path across two independent renders of one fixed scene state on pinned hardware',
      mode: mapMode ? 'map-orbit' : 'bound-scenario',
      scenario: {
        ...(mapMode ? {} : { dir: path.relative(repoRoot, scenarioDir) }),
        instanceId,
        mapId,
        inputs,
      },
      rendererPath: {
        file: 'scripts/export-render.mjs',
        sha256: await sha256File(path.join(repoRoot, 'scripts/export-render.mjs')),
        engine: 'chrome-headless three.js via Studio dev server (@uniscenarios/studio)',
        invocation: {
          url: studio.url,
          flags: mapMode ? ['--headless', '--map', mapId, '--frames', String(framesCount)] : ['--headless', '--no-video'],
          passesRenderedSequentially: true,
        },
      },
      hardware,
      passes: {
        rgb: {
          available: true,
          frameCount: frames.length,
          frames,
          equalFrames: frames.filter((frame) => frame.equal).length,
          byteStable: rgbStable,
        },
        depth: {
          available: false,
          reason: 'the Chrome screenshot export path emits RGB stills only; depth is produced by the sensor-rig pipeline (packages/browser-renderer src/sensors/depth-pass.ts) and is not exercised here',
        },
        semantic: {
          available: false,
          reason: 'not emitted by scripts/export-render.mjs; semantic G-buffer lives in packages/browser-renderer src/sensors/id-pass.ts and requires the sensor-rig intent pipeline',
        },
        instance: {
          available: false,
          reason: 'not emitted by scripts/export-render.mjs; instance G-buffer shares the id-pass limitation above',
        },
      },
      verdict: {
        byteStable: rgbStable,
        mismatchedFrames: frames.filter((frame) => !frame.equal).length,
        scope: 'RGB only, single GPU/driver/Chrome build, two processes on one machine — cross-hardware reproducibility is explicitly NOT claimed (see docs/determinism-claim.md)',
      },
      runs,
    };

    const manifestFile = path.join(outDir, 'determinism-manifest.json');
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    let evidenceCopy = null;
    if (record) {
      const evidenceDir = path.join(repoRoot, 'tools/render-determinism/evidence');
      await mkdir(evidenceDir, { recursive: true });
      evidenceCopy = path.join(evidenceDir, `${path.basename(outDir)}.json`);
      await copyFile(manifestFile, evidenceCopy);
    }

    process.stdout.write(`${JSON.stringify({
      manifestPath: path.relative(repoRoot, manifestFile),
      ...(evidenceCopy ? { evidenceCopy: path.relative(repoRoot, evidenceCopy) } : {}),
      frames: frames.length,
      equalFrames: manifest.passes.rgb.equalFrames,
      byteStable: rgbStable,
      gpu: hardware.webgl.unmaskedRenderer,
    }, null, 2)}\n`);
    // The spawned Studio tree shares our stdio pipes; stop it explicitly and
    // then sever pipes with an explicit exit so Node cannot linger.
    studio.child.kill('SIGTERM');
    process.exit(requireStable && !rgbStable ? 2 : 0);
  } catch (error) {
    studio.child.kill('SIGTERM');
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
