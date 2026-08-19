import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicJson, exists, MAPS, ShowcasePipeline } from './pipeline.mjs';
import { classifyFailure } from './failures.mjs';
import { normalizeJudgeDocument } from './review-contract.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.gz': 'application/gzip',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request, url, token) {
  const query = url.searchParams.get('token');
  const header = request.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('showcase_token='));
  const cookieToken = cookie ? decodeURIComponent(cookie.slice('showcase_token='.length)) : null;
  return (query !== null && safeEqual(query, token))
    || (bearer !== null && safeEqual(bearer, token))
    || (header !== undefined && safeEqual(header, token))
    || (cookieToken !== null && safeEqual(cookieToken, token));
}

async function requestJson(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('request body exceeds 1 MB'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { status: 400 });
  }
}

function optionalInteger(value, fallback, name, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw Object.assign(new Error(`${name} must be an integer from ${min} to ${max}`), { status: 400 });
  }
  return value;
}

const SCHEDULER_BOUNDS = Object.freeze({
  jobConcurrency: [1, 8],
  batchConcurrency: [1, 12],
  render2dConcurrency: [1, 8],
  render3dConcurrency: [1, 4],
  judgeConcurrency: [1, 8],
});

function boundedSetting(value, fallback, name) {
  const [min, max] = SCHEDULER_BOUNDS[name];
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function resolveSchedulerSettings({
  jobConcurrency,
  batchConcurrency,
  render2dConcurrency,
  render3dConcurrency,
  judgeConcurrency,
  env = process.env,
} = {}) {
  return Object.freeze({
    jobConcurrency: boundedSetting(jobConcurrency ?? env.SHOWCASE_JOB_CONCURRENCY, 4, 'jobConcurrency'),
    batchConcurrency: boundedSetting(batchConcurrency ?? env.SHOWCASE_BATCH_CONCURRENCY, 3, 'batchConcurrency'),
    render2dConcurrency: boundedSetting(render2dConcurrency ?? env.SHOWCASE_2D_CONCURRENCY, 4, 'render2dConcurrency'),
    render3dConcurrency: boundedSetting(render3dConcurrency ?? env.SHOWCASE_3D_CONCURRENCY, 2, 'render3dConcurrency'),
    judgeConcurrency: boundedSetting(judgeConcurrency ?? env.SHOWCASE_JUDGE_CONCURRENCY, 4, 'judgeConcurrency'),
  });
}

function campaignValue(value) {
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, 120) || null;
}

function normalizeJob(input, jobId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('JSON body must be an object'), { status: 400 });
  }
  if (typeof input.brief !== 'string' || input.brief.trim().length < 3 || input.brief.length > 10_000) {
    throw Object.assign(new Error('brief must be a string from 3 to 10000 characters'), { status: 400 });
  }
  const methodology = input.methodology ?? 'production';
  if (!['production', 'custom'].includes(methodology)) {
    throw Object.assign(new Error('methodology must be production or custom'), { status: 400 });
  }
  const production = methodology === 'production';
  const engine = production ? 'auto' : (input.engine ?? 'auto');
  if (!['auto', 'compiler', 'vista2'].includes(engine)) {
    throw Object.assign(new Error('engine must be auto, compiler, or vista2'), { status: 400 });
  }
  const maps = production ? [...MAPS] : (input.maps === undefined ? [...MAPS] : input.maps);
  if (!Array.isArray(maps) || maps.length < 1 || maps.some((map) => !MAPS.includes(map)) || new Set(maps).size !== maps.length) {
    throw Object.assign(new Error(`maps must contain unique values from: ${MAPS.join(', ')}`), { status: 400 });
  }
  const ambient = production ? 'light' : (input.ambient ?? 'off');
  if (!['off', 'light', 'moderate', 'city', 'heavy'].includes(ambient)) {
    throw Object.assign(new Error('ambient must be off, light, moderate, city, or heavy'), { status: 400 });
  }
  const nScenarios = production ? 3 : optionalInteger(input.nScenarios, 1, 'nScenarios', 1, 10);
  const maxSitesPerMap = production ? 3 : optionalInteger(input.maxSitesPerMap, 1, 'maxSitesPerMap', 1, 10);
  if (nScenarios * maxSitesPerMap * maps.length > 48) {
    throw Object.assign(new Error('job exceeds the 48-cell disk cap (nScenarios × maxSitesPerMap × maps)'), { status: 400 });
  }
  const topK = production ? 3 : optionalInteger(input.topK, 3, 'topK', 1, 10);
  if (input.render3d !== undefined && typeof input.render3d !== 'boolean') {
    throw Object.assign(new Error('render3d must be boolean'), { status: 400 });
  }
  if (input.judge !== undefined && typeof input.judge !== 'boolean') {
    throw Object.assign(new Error('judge must be boolean'), { status: 400 });
  }
  if (input.seed !== undefined && !['string', 'number'].includes(typeof input.seed)) {
    throw Object.assign(new Error('seed must be a string or number'), { status: 400 });
  }
  return {
    jobId,
    id: `showcase-${jobId}`,
    briefId: `showcase-${jobId}`,
    category: 'showcase.custom',
    brief: input.brief.trim(),
    methodology,
    engine,
    nScenarios,
    maps,
    maxSitesPerMap,
    ambient,
    seed: input.seed ?? jobId,
    render3d: production ? true : (input.render3d ?? false),
    topK,
    judge: production ? true : (input.judge ?? true),
    authorModel: 'gpt-5.6-sol',
    authorEffort: production ? 'low' : 'medium',
    judgeModel: 'gpt-5.6-sol',
    judgeEffort: 'medium',
    judgeStrategy: 'spread8',
    fallbackToVisual: production,
    campaignId: campaignValue(input.campaignId),
    campaignCaseId: campaignValue(input.campaignCaseId),
    campaignAttempt: input.campaignAttempt === undefined
      ? null
      : optionalInteger(input.campaignAttempt, null, 'campaignAttempt', 1, 10_000),
    createdAt: new Date().toISOString(),
  };
}

export class JobRunner {
  constructor({ dataDir, engine, concurrency = 4, scheduler }) {
    this.dataDir = dataDir;
    this.jobsDir = join(dataDir, 'jobs');
    this.engine = engine;
    this.concurrency = boundedSetting(concurrency, 4, 'jobConcurrency');
    this.scheduler = resolveSchedulerSettings({
      ...(scheduler ?? {}),
      jobConcurrency: this.concurrency,
      env: {},
    });
    this.queue = [];
    this.active = 0;
    this.executed = 0;
    this.states = new Map();
  }

  async initialize() {
    await mkdir(this.jobsDir, { recursive: true });
    for (const entry of await readdir(this.jobsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const jobDir = join(this.jobsDir, entry.name);
      const briefPath = join(jobDir, '00-brief.json');
      if (!(await exists(briefPath))) continue;
      const job = JSON.parse(await readFile(briefPath, 'utf8'));
      job.id ??= job.briefId ?? `showcase-${entry.name}`;
      job.briefId ??= job.id;
      const state = this.ensureState(entry.name);
      const savedStages = [
        ['00-brief', ['00-brief.json']],
        ['10-route', ['10-route.json']],
        ['15-precheck', ['15-precheck.json']],
        ['20-author', ['20-author/template.json', '20-author/transcript.json', '20-author/contract-verdict.json']],
        ['30-sites', ['30-sites.json']],
        ['40-cells', ['40-cells/index.json']],
        ['50-gate', ['50-gate.json']],
        ['55-eligibility', ['55-eligibility.json']],
        ['60-render2d', ['60-render2d/index.json']],
        ['62-semantic2d', ['62-semantic2d.json']],
        ['62-mutation-01', ['62-mutation-01/index.json']],
        ['62-mutation-02', ['62-mutation-02/index.json']],
        ['62-fallback-author', ['62-fallback-author/index.json']],
        ['65-render3d', ['65-render3d/index.json']],
        ['70-judge', ['70-judge.json']],
        ['75-product', ['75-product.json']],
        ['90-gallery', ['90-gallery.json']],
        ['95-benchmark', ['95-benchmark.json']],
      ];
      for (const [stage, artifacts] of savedStages) {
        if ((await Promise.all(artifacts.map((artifact) => exists(join(jobDir, artifact))))).every(Boolean)) {
          let status = 'complete';
          if (stage === '65-render3d' || stage === '70-judge' || stage === '62-semantic2d') {
            const saved = JSON.parse(await readFile(join(jobDir, artifacts[0]), 'utf8'));
            if (saved.status === 'skipped') status = 'skipped';
          }
          this.emit(entry.name, { stage, status, artifacts });
        }
      }
      if (await exists(join(jobDir, '90-gallery.json'))) {
        state.done = true;
      } else if (await exists(join(jobDir, 'job-error.json'))) {
        this.emit(entry.name, { stage: 'job', status: 'error', artifacts: ['job-error.json'] });
      } else {
        this.queue.push({ job, jobDir });
      }
    }
    this.drain();
  }

  ensureState(jobId) {
    let state = this.states.get(jobId);
    if (!state) {
      state = { events: [], listeners: new Set(), done: false };
      this.states.set(jobId, state);
    }
    return state;
  }

  emit(jobId, event) {
    const value = { stage: String(event.stage), status: String(event.status), artifacts: Array.isArray(event.artifacts) ? event.artifacts : [] };
    const state = this.ensureState(jobId);
    state.events.push(value);
    for (const listener of state.listeners) listener(value);
    if (
      (event.stage === '90-gallery' && event.status === 'complete')
      || (event.stage === 'job' && event.status === 'error')
    ) state.done = true;
  }

  async submit(input) {
    const jobId = randomUUID();
    const job = normalizeJob(input, jobId);
    job.scheduler = { ...this.scheduler };
    const jobDir = join(this.jobsDir, jobId);
    await mkdir(jobDir, { recursive: false });
    await atomicJson(join(jobDir, '00-brief.json'), job);
    this.emit(jobId, { stage: '00-brief', status: 'complete', artifacts: ['00-brief.json'] });
    this.emit(jobId, { stage: 'job', status: 'queued', artifacts: [] });
    this.queue.push({ job, jobDir });
    this.drain();
    return jobId;
  }

  drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      this.active += 1;
      void this.execute(item).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }

  async execute({ job, jobDir }) {
    await rm(join(jobDir, 'job-error.json'), { force: true });
    this.emit(job.jobId, { stage: 'job', status: 'running', artifacts: [] });
    // `processJobIndex` is what makes cold versus warm a measurement rather than
    // a guess: index 0 is the first job this process has executed, so no derived
    // artifact, module, or GPU context has been warmed by a previous attempt.
    const processJobIndex = this.executed;
    this.executed += 1;
    try {
      await this.engine.run(job, {
        jobDir,
        emit: (event) => this.emit(job.jobId, event),
        processJobIndex,
        activeJobs: this.active,
        jobConcurrency: this.concurrency,
      });
      this.ensureState(job.jobId).done = true;
    } catch (error) {
      const failure = classifyFailure(error);
      await atomicJson(join(jobDir, 'job-error.json'), {
        error: String(error.message ?? error),
        stack: String(error.stack ?? '').split('\n').slice(0, 12),
        operational: failure.operational,
        failureKind: failure.kind,
        code: failure.code,
        defectCodes: [...failure.defectCodes],
        unsupportedReason: failure.unsupportedReason,
        failedAt: new Date().toISOString(),
      });
      this.emit(job.jobId, { stage: 'job', status: 'error', artifacts: ['job-error.json'] });
    }
  }

  subscribe(jobId, listener) {
    const state = this.ensureState(jobId);
    for (const event of state.events) listener(event);
    if (!state.done) state.listeners.add(listener);
    return { done: state.done, unsubscribe: () => state.listeners.delete(listener) };
  }
}

async function directoryIndex(root, current = root) {
  const files = [];
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await directoryIndex(root, path));
    else if (entry.isFile()) {
      const info = await stat(path);
      const item = { path: relative(root, path).split(sep).join('/'), size: info.size };
      if (entry.name.endsWith('.json') && info.size <= 2_000_000) {
        try {
          item.json = JSON.parse(await readFile(path, 'utf8'));
          // Historical normalization at the read boundary: a judgement written before the
          // semantic/presentation split is re-derived so every client sees the current fields,
          // while the artifact on disk stays untouched evidence.
          if (item.path.endsWith('70-judge.json')) item.json = normalizeJudgeDocument(item.json);
        } catch {
          item.jsonError = true;
        }
      }
      files.push(item);
    }
  }
  return files;
}

async function gallery(dataDir) {
  const cards = [];
  const jobsDir = join(dataDir, 'jobs');
  for (const entry of await readdir(jobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(jobsDir, entry.name, '90-gallery.json');
    if (!(await exists(path))) continue;
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (Array.isArray(value)) cards.push(...value);
      else cards.push(value);
    } catch {
      // An incomplete atomic temp file is hidden; a corrupt committed card is omitted.
    }
  }
  const seedsDir = join(dataDir, 'gallery-seed');
  if (await exists(seedsDir)) {
    for (const entry of await readdir(seedsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(seedsDir, entry.name, '90-gallery.json');
      if (!(await exists(path))) continue;
      try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        if (Array.isArray(value)) cards.push(...value);
        else cards.push(value);
      } catch {
        // Same atomic/corrupt-file behavior as live job cards.
      }
    }
  }
  return cards.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

async function serveArtifact(request, response, dataDir, encodedPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    return sendJson(response, 400, { error: 'invalid artifact path encoding' });
  }
  const root = resolve(dataDir);
  const path = resolve(root, decoded);
  if (path !== root && !path.startsWith(`${root}${sep}`)) return sendJson(response, 403, { error: 'artifact path escapes data root' });
  let info;
  try {
    info = await stat(path);
  } catch {
    return sendJson(response, 404, { error: 'artifact not found' });
  }
  if (!info.isFile()) return sendJson(response, 404, { error: 'artifact not found' });
  const headers = { 'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream', 'accept-ranges': 'bytes' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= info.size) {
      response.writeHead(416, { 'content-range': `bytes */${info.size}` });
      return response.end();
    }
    response.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${info.size}` });
    return createReadStream(path, { start, end }).pipe(response);
  }
  response.writeHead(200, { ...headers, 'content-length': info.size });
  createReadStream(path).pipe(response);
}

async function serveWeb(response, webDir, pathname) {
  const root = resolve(webDir);
  let requested;
  try {
    requested = decodeURIComponent(pathname);
  } catch {
    return sendJson(response, 400, { error: 'invalid path encoding' });
  }
  const candidate = resolve(root, `.${requested}`);
  let path = candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : join(root, 'index.html');
  try {
    const info = await stat(path);
    if (!info.isFile()) path = join(root, 'index.html');
  } catch {
    path = join(root, 'index.html');
  }
  if (!(await exists(path))) return sendJson(response, 404, { error: 'showcase web build not found; run pnpm -r build' });
  const info = await stat(path);
  response.writeHead(200, {
    'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': path.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  createReadStream(path).pipe(response);
}

export async function createShowcaseServer({
  token,
  dataDir = join(REPO_ROOT, 'showcase-data'),
  webDir = join(REPO_ROOT, 'apps', 'showcase', 'web', 'dist'),
  engine,
  jobConcurrency,
  batchConcurrency,
  render2dConcurrency,
  render3dConcurrency,
  judgeConcurrency,
  env = process.env,
} = {}) {
  const scheduler = resolveSchedulerSettings({
    jobConcurrency,
    batchConcurrency,
    render2dConcurrency,
    render3dConcurrency,
    judgeConcurrency,
    env,
  });
  if (typeof token !== 'string' || token.length === 0) throw new Error('SHOWCASE_TOKEN is required');
  const selectedEngine = engine ?? new ShowcasePipeline({ root: REPO_ROOT, ...scheduler });
  const runner = new JobRunner({
    dataDir: resolve(dataDir),
    engine: selectedEngine,
    concurrency: scheduler.jobConcurrency,
    scheduler,
  });
  await runner.initialize();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://showcase.local');
    if (url.searchParams.has('token') && safeEqual(url.searchParams.get('token'), token)) {
      response.setHeader('set-cookie', `showcase_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`);
    }
    if (!authorized(request, url, token)) return sendJson(response, 401, { error: 'unauthorized' });
    try {
      if (request.method === 'POST' && url.pathname === '/api/jobs') {
        const jobId = await runner.submit(await requestJson(request));
        return sendJson(response, 202, { jobId });
      }
      if (request.method === 'GET' && url.pathname === '/api/gallery') {
        return sendJson(response, 200, await gallery(runner.dataDir));
      }
      const campaignBenchmark = /^\/api\/campaigns\/([a-zA-Z0-9._-]+)\/benchmark$/.exec(url.pathname);
      if (request.method === 'GET' && campaignBenchmark) {
        const reportPath = join(runner.dataDir, 'campaigns', campaignBenchmark[1], 'report.json');
        if (!(await exists(reportPath))) return sendJson(response, 404, { error: 'campaign not found' });
        const report = JSON.parse(await readFile(reportPath, 'utf8'));
        // The campaign runner publishes the block at `totals.benchmark`.
        const benchmark = report.totals?.benchmark;
        if (!benchmark) {
          return sendJson(response, 409, { error: 'campaign report predates the benchmark schema' });
        }
        return sendJson(response, 200, benchmark);
      }
      const campaign = /^\/api\/campaigns\/([a-zA-Z0-9._-]+)$/.exec(url.pathname);
      if (request.method === 'GET' && campaign) {
        const reportPath = join(runner.dataDir, 'campaigns', campaign[1], 'report.json');
        if (!(await exists(reportPath))) return sendJson(response, 404, { error: 'campaign not found' });
        return sendJson(response, 200, JSON.parse(await readFile(reportPath, 'utf8')));
      }
      const attemptRecord = /^\/api\/jobs\/([0-9a-f-]+)\/benchmark$/.exec(url.pathname);
      if (request.method === 'GET' && attemptRecord) {
        const recordPath = join(runner.jobsDir, attemptRecord[1], '95-benchmark.json');
        if (!(await exists(recordPath))) return sendJson(response, 404, { error: 'attempt record not found' });
        return sendJson(response, 200, JSON.parse(await readFile(recordPath, 'utf8')));
      }
      const full = /^\/api\/jobs\/([0-9a-f-]+)\/full$/.exec(url.pathname);
      if (request.method === 'GET' && full) {
        const jobDir = join(runner.jobsDir, full[1]);
        if (!(await exists(join(jobDir, '00-brief.json')))) return sendJson(response, 404, { error: 'job not found' });
        return sendJson(response, 200, { jobId: full[1], files: await directoryIndex(jobDir) });
      }
      const events = /^\/api\/jobs\/([0-9a-f-]+)$/.exec(url.pathname);
      if (request.method === 'GET' && events) {
        const jobDir = join(runner.jobsDir, events[1]);
        if (!(await exists(join(jobDir, '00-brief.json')))) return sendJson(response, 404, { error: 'job not found' });
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        response.flushHeaders?.();
        const subscription = runner.subscribe(events[1], (event) => {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
          if ((event.stage === '90-gallery' && event.status === 'complete') || (event.stage === 'job' && event.status === 'error')) {
            queueMicrotask(() => response.end());
          }
        });
        if (subscription.done) return response.end();
        const keepalive = setInterval(() => response.write(': keepalive\n\n'), 15_000);
        request.once('close', () => {
          clearInterval(keepalive);
          subscription.unsubscribe();
        });
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/artifacts/')) {
        return serveArtifact(request, response, runner.dataDir, url.pathname.slice('/artifacts/'.length));
      }
      if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
        return serveWeb(response, webDir, url.pathname);
      }
      return sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      return sendJson(response, error.status ?? 500, { error: String(error.message ?? error) });
    }
  });
  return { server, runner };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const host = process.env.SHOWCASE_HOST ?? '0.0.0.0';
  const port = Number(process.env.SHOWCASE_PORT ?? 4174);
  const { server } = await createShowcaseServer({
    token: process.env.SHOWCASE_TOKEN,
    dataDir: process.env.SHOWCASE_DATA_DIR ?? join(REPO_ROOT, 'showcase-data'),
    env: process.env,
  });
  server.listen(port, host, () => process.stdout.write(`showcase server listening on http://${host}:${port}\n`));
}
