#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  SCENARIO_REVIEW_PROVENANCE_FILES,
  createScenarioReviewTemplate,
} from './scenario-review-ledger-lib.mjs';
import {
  batchProgressExitCode,
  createBatchLedger,
  markRenderFailed,
  markRenderFinished,
  markRenderCancelled,
  markRenderStarted,
  reconcileBatchLedger,
  renderCandidates,
  resumeBatchLedger,
  sha256,
  summarizeBatchEntries,
} from './scenario-render-batch-lib.mjs';

function argsOf(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected positional argument ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) values.set(key, 'true');
    else {
      values.set(key, next);
      index += 1;
    }
  }
  return values;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readMaybeGzipJson(file) {
  const bytes = await readFile(file);
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return { bytes, value: JSON.parse(plain.toString('utf8')) };
}

async function readJsonMaybe(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  const absolute = path.resolve(file);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, absolute);
}

async function sourceProvenance(repositoryRoot, files) {
  return Promise.all(files.map(async (file) => ({
    file,
    sha256: sha256(await readFile(path.resolve(repositoryRoot, file))),
  })));
}

function runRenderer(repositoryRoot, args, signal) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/export-render.mjs', ...args], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-8000); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
    child.on('error', (error) => resolve({ exitCode: -1, stdout, stderr: error.message }));
    child.on('close', (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
    const cancel = () => {
      if (!child.pid) return;
      try {
        // The exporter may be synchronously waiting on ffmpeg. Terminate its
        // dedicated process group so cancellation cannot orphan an encoder.
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if (error?.code !== 'ESRCH') child.kill('SIGTERM');
      }
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    child.on('close', () => signal?.removeEventListener('abort', cancel));
  });
}

const args = argsOf(process.argv);
const repositoryRoot = path.resolve(args.get('root') ?? '.');
const catalogFile = path.resolve(repositoryRoot, args.get('catalog') ?? 'catalog/simforge-oss-five-map-v2.catalog.json');
const ledgerFile = path.resolve(repositoryRoot, args.get('ledger') ?? 'artifacts/qa/scenario-render-review-batch.json');
const reportFile = args.has('report') ? path.resolve(repositoryRoot, args.get('report')) : null;
const catalogBytes = await readFile(catalogFile);
const catalog = JSON.parse(catalogBytes.toString('utf8'));
const rendererSources = await sourceProvenance(repositoryRoot, SCENARIO_REVIEW_PROVENANCE_FILES);
const provenance = {
  catalog: {
    file: path.relative(repositoryRoot, catalogFile),
    sha256: sha256(catalogBytes),
    declaredDigest: catalog.catalogDigest ?? null,
  },
  rendererSources,
};
const config = {
  url: args.get('url') ?? 'http://127.0.0.1:5199',
  width: Number(args.get('width') ?? 1600),
  height: Number(args.get('height') ?? 960),
  fps: Math.max(8, Number(args.get('fps') ?? 12)),
  headless: !args.has('headed'),
  includeUi: args.has('include-ui'),
};

const previous = await readJsonMaybe(ledgerFile);
let ledger = previous
  ? resumeBatchLedger(previous, catalog, provenance, config)
  : createBatchLedger(catalog, provenance, config);
ledger = await reconcileBatchLedger(ledger, catalog, repositoryRoot);
await writeJsonAtomic(ledgerFile, ledger);

if (args.has('render')) {
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const jobs = Math.max(1, Math.floor(Number(args.get('jobs') ?? 1)));
  const limit = Math.max(0, Math.floor(Number(args.get('limit') ?? Infinity)));
  const queue = renderCandidates(ledger, limit);
  let cursor = 0;
  let persist = Promise.resolve();
  const replaceEntry = async (updated) => {
    const index = ledger.entries.findIndex((entry) => entry.scenarioId === updated.scenarioId);
    ledger.entries[index] = updated;
    ledger.summary = summarizeBatchEntries(ledger.entries, catalog.maps);
    persist = persist.then(() => writeJsonAtomic(ledgerFile, ledger));
    await persist;
  };
  const worker = async () => {
    while (cursor < queue.length) {
      if (cancellation.signal.aborted) return;
      const queued = queue[cursor];
      cursor += 1;
      let entry = ledger.entries.find((candidate) => candidate.scenarioId === queued.scenarioId);
      entry = markRenderStarted(entry, new Date().toISOString());
      await replaceEntry(entry);
      const out = path.dirname(path.resolve(repositoryRoot, entry.evidencePaths.renderManifest));
      const rendererArgs = [
        '--url', config.url,
        '--instance', path.resolve(repositoryRoot, entry.evidencePaths.instance),
        '--trace', path.resolve(repositoryRoot, entry.evidencePaths.trace),
        '--result', path.resolve(repositoryRoot, entry.evidencePaths.result),
        '--out', out,
        '--width', String(config.width),
        '--height', String(config.height),
        '--fps', String(config.fps),
        ...(config.headless ? ['--headless'] : []),
        ...(config.includeUi ? ['--include-ui'] : []),
      ];
      const result = await runRenderer(repositoryRoot, rendererArgs, cancellation.signal);
      if (cancellation.signal.aborted) {
        entry = markRenderCancelled(entry, new Date().toISOString());
        await replaceEntry(entry);
        continue;
      }
      if (result.exitCode !== 0) {
        entry = markRenderFailed(entry, new Date().toISOString(), result.exitCode, result.stderr || result.stdout);
        await replaceEntry(entry);
        continue;
      }
      entry = markRenderFinished(entry, new Date().toISOString());
      const manifest = await readJson(path.resolve(repositoryRoot, entry.evidencePaths.renderManifest));
      const reviewPath = path.resolve(repositoryRoot, entry.evidencePaths.visualInspection);
      const [{ value: instanceDoc, bytes: instanceBytes }, { value: trace, bytes: traceBytes }] = await Promise.all([
        readMaybeGzipJson(path.resolve(repositoryRoot, entry.evidencePaths.instance)),
        readMaybeGzipJson(path.resolve(repositoryRoot, entry.evidencePaths.trace)),
      ]);
      await writeJsonAtomic(reviewPath, createScenarioReviewTemplate(
        manifest,
        path.relative(path.dirname(reviewPath), path.resolve(repositoryRoot, entry.evidencePaths.renderManifest)),
        {
          instanceDoc,
          trace,
          instanceSha256: sha256(instanceBytes),
          traceFileSha256: sha256(traceBytes),
          resultSha256: sha256(await readFile(path.resolve(repositoryRoot, entry.evidencePaths.result))),
          rendererSources,
        },
      ));
      entry = await reconcileBatchLedger({ ...ledger, entries: [entry] }, { maps: catalog.maps }, repositoryRoot)
        .then((value) => value.entries[0]);
      await replaceEntry(entry);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, Math.max(1, queue.length)) }, () => worker()));
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
  if (cancellation.signal.aborted) process.exitCode = 130;
}

ledger = await reconcileBatchLedger(ledger, catalog, repositoryRoot);
await writeJsonAtomic(ledgerFile, ledger);
if (reportFile) {
  await writeJsonAtomic(reportFile, {
    schema: 'simforge-oss.scenario-render-review-batch-report.v1',
    ledger: path.relative(repositoryRoot, ledgerFile),
    provenance: ledger.provenance,
    config: ledger.config,
    summary: ledger.summary,
  });
}
console.log(JSON.stringify({ ledger: path.relative(repositoryRoot, ledgerFile), summary: ledger.summary }, null, 2));
if (process.exitCode !== 130) process.exitCode = batchProgressExitCode(ledger.summary);
