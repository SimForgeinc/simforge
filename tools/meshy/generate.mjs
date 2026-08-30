#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOL_DIR, '../..');
const STATE_PATH = path.join(TOOL_DIR, 'state.json');
const MANIFEST_PATH = path.join(TOOL_DIR, 'manifest.json');
const REPORT_PATH = path.join(TOOL_DIR, 'REPORT.md');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'dev-assets/gallery-assets');
const CACHE_ROOT = path.join(TOOL_DIR, 'cache');
const API_ROOT = 'https://api.meshy.ai/openapi';
const TERMINAL_TASK_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELED']);
const RIGGABLE_CLASSES = new Set(['pedestrian']);
const ANIMATION_ACTIONS = Object.freeze({ idle: 0, walk: 30, run: 15 });
const CATALOG_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;

const requireFromCli = createRequire(path.join(REPO_ROOT, 'packages/cli/package.json'));
const { NodeIO } = requireFromCli('@gltf-transform/core');
const { ALL_EXTENSIONS } = requireFromCli('@gltf-transform/extensions');
const { getBounds } = requireFromCli('@gltf-transform/functions');
const { MeshoptDecoder } = requireFromCli('meshoptimizer');

function parseArgs(argv) {
  const options = {
    concurrency: 3,
    pollMs: 10_000,
    timeoutMs: 2 * 60 * 60 * 1000,
    dryRun: false,
    retryFailed: false,
    only: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--retry-failed') options.retryFailed = true;
    else if (arg === '--concurrency') options.concurrency = positiveInteger(argv[++index], arg);
    else if (arg === '--poll-ms') options.pollMs = positiveInteger(argv[++index], arg);
    else if (arg === '--timeout-ms') options.timeoutMs = positiveInteger(argv[++index], arg);
    else if (arg === '--only') options.only = argv[++index] ?? fail(`${arg} requires a value`);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node tools/meshy/generate.mjs [options]\n\n` +
        `  --concurrency N  Assets processed concurrently (default: 3)\n` +
        `  --poll-ms N      Task polling interval (default: 10000)\n` +
        `  --timeout-ms N   Per-task timeout (default: 7200000)\n` +
        `  --only FILTER    Catalog id substring or exact class\n` +
        `  --retry-failed   Retry failed/rejected/credit-exhausted assets\n` +
        `  --dry-run        Initialize state/manifest and validate catalog only`);
      process.exit(0);
    } else fail(`Unknown argument: ${arg}`);
  }
  return options;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${flag} requires a positive integer`);
  return parsed;
}

function fail(message) {
  throw new Error(message);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function loadCatalog() {
  const candidates = [
    path.join(REPO_ROOT, 'packages/prop-catalog/catalog.json'),
    path.join(REPO_ROOT, 'packages/asset-catalog/catalog.json'),
  ];
  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    const parsed = JSON.parse(await readFile(candidate, 'utf8'));
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    validateCatalog(parsed, candidate);
    return { entries: parsed.filter((entry) => !entry.legacyAliasOf), source: path.relative(REPO_ROOT, candidate) };
  }
  fail(`No non-empty catalog found at ${candidates.map((item) => path.relative(REPO_ROOT, item)).join(' or ')}`);
}

function validateCatalog(entries, source) {
  const ids = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !CATALOG_ID_PATTERN.test(entry.id)) fail(`Invalid catalog id in ${source}`);
    if (ids.has(entry.id)) fail(`Duplicate catalog id ${entry.id} in ${source}`);
    ids.add(entry.id);
    for (const axis of ['l', 'w', 'h']) {
      if (!(Number(entry.dims?.[axis]) > 0)) fail(`${entry.id} has invalid dims.${axis}`);
    }
    if (entry.class === 'pedestrian' && entry.animation) {
      if (entry.animation.rig !== 'humanoid') fail(`${entry.id} must use a humanoid animation rig`);
      if (!entry.animation.clips.includes(entry.animation.idleClip)
        || !entry.animation.clips.includes(entry.animation.locomotionClip)) {
        fail(`${entry.id} animation contract omits idleClip or locomotionClip`);
      }
    }
  }
}

async function loadState(catalogSource) {
  if (await exists(STATE_PATH)) {
    const parsed = JSON.parse(await readFile(STATE_PATH, 'utf8'));
    if (parsed.schemaVersion !== 1 || typeof parsed.assets !== 'object') fail('Unsupported tools/meshy/state.json schema');
    parsed.catalogSource = catalogSource;
    parsed.updatedAt = new Date().toISOString();
    return parsed;
  }
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    catalogSource,
    startedAt: now,
    updatedAt: now,
    halt: null,
    assets: {},
  };
}

function freshAssetState(entry) {
  return {
    catalogId: entry.id,
    class: entry.class,
    dimensionsM: entry.dims,
    prompt: buildPrompt(entry),
    texturePrompt: buildTexturePrompt(entry),
    stage: 'queued',
    tasks: {},
    priorConsumedCredits: 0,
    output: null,
    error: null,
    updatedAt: new Date().toISOString(),
    retryCount: 0,
  };
}

function buildPrompt(entry) {
  const dimensions = `${entry.dims.l} m long, ${entry.dims.w} m wide, ${entry.dims.h} m tall`;
  const common = `Single isolated ${entry.label}, ${dimensions}. ${entry.description} Photorealistic but clean production game asset, physically plausible proportions, complete geometry on every side, PBR-ready materials, centered with no floor or background, no text, logos, labels, watermark, or display stand.`;
  const byClass = {
    vehicle: 'Roadworthy contemporary design, closed panels and windows, realistic tires and wheel wells, front facing +Z, upright on level ground.',
    pedestrian: 'One full-body standard humanoid character in a neutral T-pose with clearly separated arms and legs, symmetrical unobstructed limbs, modest realistic everyday clothing, front facing +Z, feet at ground level; no carried objects or loose accessories.',
    sidewalk_robot: 'Functional near-future commercial robot with believable joints, sensors, wheels or feet, clean industrial design, front facing +Z, upright on level ground.',
    drone: 'Functional commercial multirotor aircraft with distinct arms, rotors, landing structure and sensor payload, front facing +Z.',
    animal: 'Anatomically plausible single animal, full body, neutral standing pose with separated legs, front facing +Z, feet on ground.',
    construction: 'Realistic road-construction equipment or prop with durable municipal materials, safety colors where appropriate, front or primary face toward +Z, resting naturally on level ground.',
    occluder: 'Realistic urban roadside object, intact and fully modeled, primary face toward +Z, resting naturally on level ground.',
    street: 'Realistic contemporary urban street prop, intact and fully modeled, primary face toward +Z, resting naturally on level ground.',
    hazard: 'Realistic but clean roadway hazard prop, a single coherent asset rather than a scene, no floor, resting naturally on level ground.',
  };
  return `${common} ${byClass[entry.class] ?? ''}`.slice(0, 600);
}
function buildDimensionRetryPrompt(entry) {
  const { l, w, h } = entry.dims;
  const ratio = `${(l / h).toFixed(2)}:${(w / h).toFixed(2)}:1`;
  return `DIMENSION-CRITICAL RETRY: target bounding box exactly ${l} m long x ${w} m wide x ${h} m tall; length:width:height proportion ${ratio}. Preserve these proportions in the geometry, not with empty space. ${buildPrompt(entry)}`.slice(0, 600);
}


function buildTexturePrompt(entry) {
  return `Match this catalog appearance exactly: ${entry.label}. ${entry.description} Treat every stated color, material, and pattern as mandatory, with strong clearly visible color separation. Photorealistic clean PBR game-asset texturing with realistic base color, roughness, metallic and normal detail. Neutral even albedo with no baked lighting or shadows, no dirt that obscures shape, no logos, text, labels, watermark, or background.`.slice(0, 600);
}

function buildPreviewRequest(entry, asset) {
  return {
    mode: 'preview',
    prompt: asset.prompt,
    model_type: 'standard',
    ai_model: 'latest',
    should_remesh: true,
    topology: 'triangle',
    target_polycount: entry.class === 'pedestrian' ? 80_000 : 60_000,
    pose_mode: entry.class === 'pedestrian' ? 't-pose' : '',
    moderation: false,
    target_formats: ['glb'],
    auto_size: false,
  };
}

function buildRefineRequest(previewTaskId, asset) {
  if (typeof previewTaskId !== 'string' || !previewTaskId) fail('A preview task id is required for refinement');
  return {
    mode: 'refine',
    preview_task_id: previewTaskId,
    enable_pbr: true,
    texture_resolution: '2k',
    texture_prompt: asset.texturePrompt,
    ai_model: 'latest',
    moderation: false,
    remove_lighting: true,
    target_formats: ['glb'],
  };
}

function assetPaths(catalogId, roots = {}) {
  if (!CATALOG_ID_PATTERN.test(catalogId)) fail(`Invalid catalog id: ${catalogId}`);
  const cacheRoot = roots.cacheRoot ?? CACHE_ROOT;
  const outputRoot = roots.outputRoot ?? OUTPUT_ROOT;
  return {
    cacheDir: path.join(cacheRoot, catalogId),
    rawModel: path.join(cacheRoot, catalogId, 'refined.glb'),
    outputDir: path.join(outputRoot, catalogId),
    model: path.join(outputRoot, catalogId, 'model.glb'),
    animations: Object.fromEntries(
      Object.keys(ANIMATION_ACTIONS).map((clip) => [clip, path.join(outputRoot, catalogId, 'animations', `${clip}.glb`)]),
    ),
  };
}

function publicTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    status: task.status,
    consumedCredits: task.consumedCredits ?? 0,
    finishedAt: task.finishedAt ?? null,
    error: task.error ?? null,
  };
}

function manifestEntry(stateEntry) {
  const taskIds = {};
  for (const [name, task] of Object.entries(stateEntry.tasks ?? {})) {
    if (task?.id) taskIds[name] = task.id;
  }
  const output = stateEntry.output;
  const result = {
    catalogId: stateEntry.catalogId,
    meshyTaskIds: taskIds,
    sha256: output?.sha256 ?? null,
    bounds: output?.bounds ?? null,
    scaleApplied: output?.scaleApplied ?? null,
    status: stateEntry.stage,
  };
  if (output?.animationSha256) result.animationSha256 = output.animationSha256;
  if (stateEntry.error) result.rejectReason = stateEntry.error;
  return result;
}

function creditUsage(state) {
  let total = 0;
  for (const asset of Object.values(state.assets)) {
    total += Number(asset.priorConsumedCredits ?? 0);
    for (const task of Object.values(asset.tasks ?? {})) total += Number(task?.consumedCredits ?? 0);
  }
  return total;
}

function makeReport(entries, state) {
  const rows = entries.map((entry) => state.assets[entry.id]).filter(Boolean);
  const counts = new Map();
  for (const row of rows) counts.set(row.stage, (counts.get(row.stage) ?? 0) + 1);
  const rejected = rows.filter((row) => ['rejected', 'failed', 'credit_exhausted'].includes(row.stage));
  const lines = [
    '# Meshy Asset Generation Report',
    '',
    `Updated: ${state.updatedAt}`,
    '',
    `Catalog source: \`${state.catalogSource}\``,
    '',
    `Catalog assets: ${rows.length}`,
    '',
    '## Status counts',
    '',
    '| Status | Count |',
    '| --- | ---: |',
    ...[...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => `| ${status} | ${count} |`),
    '',
    '## Credit usage',
    '',
    `Observed consumed credits reported by Meshy tasks: **${creditUsage(state)}**. This is exact for tasks already retrieved; active or unsubmitted tasks are not estimated.`,
    '',
    '## Rejects and failures',
    '',
  ];
  if (rejected.length === 0) lines.push('None.');
  else {
    lines.push('| Catalog id | Status | Reason |', '| --- | --- | --- |');
    for (const row of rejected) lines.push(`| \`${row.catalogId}\` | ${row.stage} | ${String(row.error ?? 'unknown').replaceAll('|', '\\|')} |`);
  }
  if (state.halt) lines.push('', '## Queue halt', '', `${state.halt.at}: ${state.halt.reason}`);
  lines.push('');
  return lines.join('\n');
}

let persistChain = Promise.resolve();
function persistAll(entries, state) {
  persistChain = persistChain.then(async () => {
    state.updatedAt = new Date().toISOString();
    await atomicJson(STATE_PATH, state);
    const manifest = entries.map((entry) => manifestEntry(state.assets[entry.id]));
    await atomicJson(MANIFEST_PATH, manifest);
    await atomicText(REPORT_PATH, makeReport(entries, state));
  });
  return persistChain;
}

async function atomicJson(target, value) {
  await atomicText(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicText(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, target);
}

class MeshyHttpError extends Error {
  constructor(status, message, body) {
    super(`Meshy API ${status}: ${message}`);
    this.status = status;
    this.body = body;
  }
}

class CreditExhaustedError extends MeshyHttpError {}

function safeApiErrorBody(body) {
  if (!body || typeof body !== 'object') return String(body ?? '');
  return JSON.stringify({
    message: body.message ?? body.error?.message ?? body.task_error?.message ?? null,
    code: body.code ?? body.status_code ?? null,
  });
}

async function apiRequest(apiKey, method, endpoint, body = undefined) {
  let lastError;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    try {
      const response = await fetch(`${API_ROOT}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed;
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { message: text.slice(0, 500) }; }
      if (response.ok) return parsed;
      const message = safeApiErrorBody(parsed);
      if (response.status === 402) throw new CreditExhaustedError(response.status, message, parsed);
      if (response.status !== 429 && response.status < 500) throw new MeshyHttpError(response.status, message, parsed);
      lastError = new MeshyHttpError(response.status, message, parsed);
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 2_000 * 2 ** attempt));
    } catch (error) {
      if (error instanceof CreditExhaustedError) throw error;
      if (error instanceof MeshyHttpError && error.status < 500 && error.status !== 429) throw error;
      lastError = error;
      await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
    }
  }
  throw lastError ?? new Error(`Meshy API request failed: ${method} ${endpoint}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createTask(apiKey, endpoint, payload) {
  const response = await apiRequest(apiKey, 'POST', endpoint, payload);
  if (typeof response.result !== 'string' || !response.result) fail(`Meshy returned no task id for ${endpoint}`);
  return response.result;
}

async function pollTask(apiKey, endpoint, taskId, options, onUpdate) {
  const started = Date.now();
  let previousSignature = '';
  while (Date.now() - started < options.timeoutMs) {
    const task = await apiRequest(apiKey, 'GET', `${endpoint}/${encodeURIComponent(taskId)}`);
    const signature = `${task.status}:${task.progress}:${task.consumed_credits}`;
    if (signature !== previousSignature) {
      previousSignature = signature;
      await onUpdate(task);
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      if (task.status !== 'SUCCEEDED') {
        throw new Error(`${endpoint} task ${taskId} ${task.status}: ${task.task_error?.message || 'no reason supplied'}`);
      }
      return task;
    }
    await sleep(options.pollMs);
  }
  throw new Error(`${endpoint} task ${taskId} exceeded ${options.timeoutMs} ms`);
}

function updateTaskRecord(asset, name, task, fallbackId) {
  asset.tasks[name] = {
    id: task.id ?? fallbackId,
    status: task.status ?? 'PENDING',
    consumedCredits: Number(task.consumed_credits ?? asset.tasks[name]?.consumedCredits ?? 0),
    finishedAt: task.finished_at ?? asset.tasks[name]?.finishedAt ?? null,
    error: task.task_error?.message || null,
  };
  asset.updatedAt = new Date().toISOString();
}

async function ensureTask({ apiKey, endpoint, payload, asset, taskName, stage, options, entries, state }) {
  let taskId = asset.tasks[taskName]?.id;
  if (!taskId) {
    asset.stage = stage;
    asset.error = null;
    taskId = await createTask(apiKey, endpoint, payload);
    asset.tasks[taskName] = { id: taskId, status: 'PENDING', consumedCredits: 0, finishedAt: null, error: null };
    await persistAll(entries, state);
  }
  return pollTask(apiKey, endpoint, taskId, options, async (task) => {
    updateTaskRecord(asset, taskName, task, taskId);
    await persistAll(entries, state);
  });
}

async function download(url, target) {
  if (!url) fail(`No download URL supplied for ${target}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${path.basename(target)}`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength < 20 || new TextDecoder().decode(data.subarray(0, 4)) !== 'glTF') {
    throw new Error(`Downloaded file is not a binary glTF: ${target}`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.download`;
  await writeFile(temporary, data);
  await rename(temporary, target);
  return target;
}

async function sha256(filePath) {
  const data = await readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

function extents(bounds) {
  return {
    l: bounds.max[0] - bounds.min[0],
    w: bounds.max[2] - bounds.min[2],
    h: bounds.max[1] - bounds.min[1],
  };
}

function finitePositiveDims(dims) {
  return ['l', 'w', 'h'].every((axis) => Number.isFinite(dims[axis]) && dims[axis] > 1e-6);
}

async function normalizeGlb(inputPath, outputPath, targetDims, clipName = null, expectedScale = null, gateAxes = ['l', 'w', 'h'], preferQuarterTurn = false) {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const document = await io.read(inputPath);
  const root = document.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) fail(`${inputPath} has no glTF scene`);
  if (root.listMeshes().length === 0) fail(`${inputPath} has no meshes`);

  const wrapper = document.createNode('__simforge_normalization__');
  for (const child of [...scene.listChildren()]) wrapper.addChild(child);
  scene.addChild(wrapper);

  // Meshy does not guarantee a horizontal forward axis. Select the 0°/+90°
  // orientation whose extents best match the catalog; humanoid T-poses are
  // explicitly +Z-forward and therefore always receive the +90° conversion.
  const rotations = [
    [0, 0, 0, 1],
    [0, Math.SQRT1_2, 0, Math.SQRT1_2],
  ];
  const candidates = rotations.map((rotation, index) => {
    wrapper.setRotation(rotation);
    const raw = extents(getBounds(wrapper));
    if (!finitePositiveDims(raw)) fail(`${inputPath} has degenerate bounds ${JSON.stringify(raw)}`);
    const ratios = Object.fromEntries(['l', 'w', 'h'].map((axis) => [axis, targetDims[axis] / raw[axis]]));
    const scalingRatios = gateAxes.map((axis) => ratios[axis]);
    const scale = expectedScale ?? scalingRatios.reduce((sum, value) => sum + value, 0) / scalingRatios.length;
    const deviations = Object.fromEntries(['l', 'w', 'h'].map((axis) => [axis, Math.abs(raw[axis] * scale - targetDims[axis]) / targetDims[axis]]));
    return { rotation, quarterTurn: index === 1, raw, scale, deviations, score: Math.max(...Object.values(deviations)) };
  });
  const selected = preferQuarterTurn ? candidates[1] : candidates.sort((left, right) => left.score - right.score)[0];
  wrapper.setRotation(selected.rotation);
  const { raw, scale: bestScale, deviations } = selected;
  const maxDeviation = Math.max(...gateAxes.map((axis) => deviations[axis]));
  if (maxDeviation > 0.30) {
    const detail = Object.entries(deviations).map(([axis, value]) => `${axis}=${(value * 100).toFixed(1)}%`).join(', ');
    const error = new Error(`aspect ratio gate failed after uniform scaling (${detail}; max allowed 30.0%)`);
    error.code = 'ASPECT_RATIO_REJECTED';
    error.details = { raw, target: targetDims, proposedScale: bestScale, deviations, quarterTurn: selected.quarterTurn };
    throw error;
  }

  wrapper.setScale([bestScale, bestScale, bestScale]);
  const scaledBounds = getBounds(wrapper);
  wrapper.setTranslation([
    -(scaledBounds.min[0] + scaledBounds.max[0]) / 2,
    -scaledBounds.min[1],
    -(scaledBounds.min[2] + scaledBounds.max[2]) / 2,
  ]);

  if (clipName) {
    const animations = root.listAnimations();
    if (animations.length === 0) fail(`${inputPath} contains no animation for requested clip ${clipName}`);
    animations.forEach((animation, index) => animation.setName(index === 0 ? clipName : `${clipName}_${index + 1}`));
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp.glb`;
  await io.write(temporary, document);
  await rename(temporary, outputPath);
  const normalized = extents(getBounds(wrapper));
  return {
    raw,
    normalized,
    target: targetDims,
    deviations,
    scaleApplied: bestScale,
    sha256: await sha256(outputPath),
  };
}

async function processBase(entry, asset, context) {
  const { apiKey, options, entries, state } = context;
  const preview = await ensureTask({
    apiKey,
    endpoint: '/v2/text-to-3d',
    payload: buildPreviewRequest(entry, asset),
    asset,
    taskName: 'preview',
    stage: 'previewing',
    options,
    entries,
    state,
  });

  const refine = await ensureTask({
    apiKey,
    endpoint: '/v2/text-to-3d',
    payload: buildRefineRequest(preview.id, asset),
    asset,
    taskName: 'refine',
    stage: 'refining',
    options,
    entries,
    state,
  });

  const paths = assetPaths(entry.id);
  if (!(await exists(paths.rawModel))) await download(refine.model_urls?.glb, paths.rawModel);
  asset.stage = 'normalizing';
  await persistAll(entries, state);

  const normalized = await normalizeGlb(paths.rawModel, paths.model, entry.dims, null, null, RIGGABLE_CLASSES.has(entry.class) ? ['h'] : ['l', 'w', 'h'], RIGGABLE_CLASSES.has(entry.class));
  asset.output = {
    model: path.relative(REPO_ROOT, paths.model),
    sha256: normalized.sha256,
    bounds: { raw: normalized.raw, normalized: normalized.normalized, target: normalized.target, deviations: normalized.deviations },
    scaleApplied: normalized.scaleApplied,
    animationSha256: {},
  };
  await persistAll(entries, state);
}

async function processPedestrian(entry, asset, context) {
  const { apiKey, options, entries, state } = context;
  const refineId = asset.tasks.refine?.id;
  if (!refineId) fail(`${entry.id} has no refine task for rigging`);
  const rig = await ensureTask({
    apiKey,
    endpoint: '/v1/rigging',
    payload: { input_task_id: refineId, height_meters: entry.dims.h },
    asset,
    taskName: 'rig',
    stage: 'rigging',
    options,
    entries,
    state,
  });

  const cacheDir = path.join(CACHE_ROOT, entry.id);
  const outputDir = path.join(OUTPUT_ROOT, entry.id, 'animations');
  const rigRaw = path.join(cacheDir, 'rigged.glb');
  const riggedPath = path.join(outputDir, 'rigged.glb');
  if (!(await exists(rigRaw))) await download(rig.result?.rigged_character_glb_url, rigRaw);
  for (const [name, url] of Object.entries({
    basic_walk: rig.result?.basic_animations?.walking_glb_url,
    basic_run: rig.result?.basic_animations?.running_glb_url,
  })) {
    const cachePath = path.join(cacheDir, `${name}.glb`);
    if (url && !(await exists(cachePath))) await download(url, cachePath);
  }
  // Rigging honors height_meters and emits a newly scaled model, so derive a
  // fresh normalization scale rather than reusing the generation-task scale.
  const rigged = await normalizeGlb(rigRaw, riggedPath, entry.dims, null, null, ['h'], true);
  asset.output.rigScaleApplied = rigged.scaleApplied;
  asset.output.animationSha256.rigged = rigged.sha256;
  await persistAll(entries, state);

  for (const [clip, actionId] of Object.entries(ANIMATION_ACTIONS)) {
    const task = await ensureTask({
      apiKey,
      endpoint: '/v1/animations',
      payload: { rig_task_id: rig.id, action_id: actionId },
      asset,
      taskName: `animation_${clip}`,
      stage: `animating_${clip}`,
      options,
      entries,
      state,
    });
    const rawPath = path.join(cacheDir, `${clip}.glb`);
    const outputPath = path.join(outputDir, `${clip}.glb`);
    if (!(await exists(rawPath))) await download(task.result?.animation_glb_url, rawPath);
    const contractClip = clip === 'idle'
      ? (entry.animation?.idleClip ?? 'idle')
      : clip === 'walk'
        ? (entry.animation?.locomotionClip ?? 'walk')
        : 'run';
    const normalized = await normalizeGlb(rawPath, outputPath, entry.dims, contractClip, asset.output.rigScaleApplied, ['h'], true);
    asset.output.animationSha256[clip] = normalized.sha256;
    await persistAll(entries, state);
  }
}

async function processAsset(entry, context) {
  const { entries, state, options } = context;
  const asset = state.assets[entry.id];
  const paths = assetPaths(entry.id);
  const outputPath = paths.model;
  const animationPaths = Object.values(paths.animations);
  const completeOnDisk = asset.stage === 'completed'
    && await exists(outputPath)
    && (!RIGGABLE_CLASSES.has(entry.class) || (await Promise.all(animationPaths.map(exists))).every(Boolean));
  if (completeOnDisk) return;
  if (['failed', 'rejected', 'credit_exhausted'].includes(asset.stage)) {
    if (!options.retryFailed || (asset.retryCount ?? 0) >= 1) return;
    const previousStage = asset.stage;
    asset.stage = 'queued';
    asset.error = null;
    asset.retryCount = (asset.retryCount ?? 0) + 1;
    if (previousStage === 'rejected') {
      asset.output = null;
      asset.prompt = buildDimensionRetryPrompt(entry);
      asset.priorConsumedCredits = Number(asset.priorConsumedCredits ?? 0)
        + Object.values(asset.tasks).reduce((total, task) => total + Number(task?.consumedCredits ?? 0), 0);
      asset.tasks = {};
      await rm(path.join(CACHE_ROOT, entry.id), { recursive: true, force: true });
      await rm(path.join(OUTPUT_ROOT, entry.id), { recursive: true, force: true });
    } else if (previousStage === 'failed') {
      for (const [taskName, task] of Object.entries(asset.tasks)) {
        if (task.status === 'FAILED' || task.status === 'CANCELED') {
          asset.priorConsumedCredits = Number(asset.priorConsumedCredits ?? 0) + Number(task.consumedCredits ?? 0);
          delete asset.tasks[taskName];
        }
      }
    }
  }

  try {
    if (!asset.output || !(await exists(outputPath))) await processBase(entry, asset, context);
    if (RIGGABLE_CLASSES.has(entry.class)) await processPedestrian(entry, asset, context);
    asset.stage = 'completed';
    asset.error = null;
    asset.updatedAt = new Date().toISOString();
    await persistAll(entries, state);
    console.log(`completed ${entry.id}`);
  } catch (error) {
    if (error instanceof CreditExhaustedError) {
      const interruptedStage = asset.stage;
      asset.stage = 'credit_exhausted';
      asset.error = `Meshy credits exhausted while ${interruptedStage} (${error.message})`;
      state.halt = { at: entry.id, stage: interruptedStage, reason: asset.error, recordedAt: new Date().toISOString() };
      await persistAll(entries, state);
      throw error;
    }
    asset.stage = error?.code === 'ASPECT_RATIO_REJECTED' ? 'rejected' : 'failed';
    asset.error = error instanceof Error ? error.message : String(error);
    asset.updatedAt = new Date().toISOString();
    await persistAll(entries, state);
    console.error(`${asset.stage} ${entry.id}: ${asset.error}`);
  }
}

function sortCatalog(entries) {
  // Vehicles and non-human props first; rigged pedestrians are deliberately second.
  return [...entries].sort((left, right) => {
    const leftPedestrian = RIGGABLE_CLASSES.has(left.class) ? 1 : 0;
    const rightPedestrian = RIGGABLE_CLASSES.has(right.class) ? 1 : 0;
    return leftPedestrian - rightPedestrian;
  });
}

async function runQueue(entries, context) {
  let cursor = 0;
  let halted = false;
  async function worker() {
    while (!halted) {
      const index = cursor;
      cursor += 1;
      if (index >= entries.length) return;
      try {
        await processAsset(entries[index], context);
      } catch (error) {
        if (error instanceof CreditExhaustedError) {
          halted = true;
          return;
        }
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(context.options.concurrency, entries.length) }, worker));
  if (halted) {
    for (const entry of entries.slice(cursor)) {
      const asset = context.state.assets[entry.id];
      if (asset.stage === 'queued') {
        asset.stage = 'credit_exhausted';
        asset.error = `Not submitted after credit exhaustion at ${context.state.halt?.at ?? 'another asset'}`;
      }
    }
    await persistAll(context.entries, context.state);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { entries: allEntries, source } = await loadCatalog();
  const state = await loadState(source);
  for (const entry of allEntries) {
    state.assets[entry.id] ??= freshAssetState(entry);
    const asset = state.assets[entry.id];
    if (!asset.tasks.preview?.id) asset.prompt = buildPrompt(entry);
    if (!asset.tasks.refine?.id) asset.texturePrompt = buildTexturePrompt(entry);
  }
  for (const catalogId of Object.keys(state.assets)) {
    if (!allEntries.some((entry) => entry.id === catalogId)) delete state.assets[catalogId];
  }
  const exactClassMatch = options.only && allEntries.some((entry) => entry.class === options.only);
  const selected = options.only
    ? allEntries.filter((entry) => exactClassMatch ? entry.class === options.only : entry.id.includes(options.only))
    : allEntries;
  if (selected.length === 0) fail(`--only matched no catalog entries: ${options.only}`);
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await mkdir(CACHE_ROOT, { recursive: true });
  await persistAll(allEntries, state);
  if (options.dryRun) {
    console.log(`validated ${allEntries.length} catalog assets (${selected.length} selected)`);
    return;
  }
  const apiKey = process.env.MESHY_API_KEY;
  if (!apiKey) fail('MESHY_API_KEY is required (the key is never read from or written to repository files)');
  if (options.retryFailed) state.halt = null;
  const ordered = sortCatalog(selected);
  await runQueue(ordered, { apiKey, options, entries: allEntries, state });
  await persistAll(allEntries, state);
  const completed = ordered.filter((entry) => state.assets[entry.id].stage === 'completed').length;
  console.log(`finished: ${completed}/${ordered.length} selected assets completed; ${creditUsage(state)} observed credits consumed`);
  if (state.halt) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Never include headers or the API key in errors.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  API_ROOT,
  apiRequest,
  assetPaths,
  creditUsage,
  buildTexturePrompt,
  buildPreviewRequest,
  buildRefineRequest,
  download,
  manifestEntry,
  validateCatalog,
};
