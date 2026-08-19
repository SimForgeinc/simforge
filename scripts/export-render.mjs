#!/usr/bin/env node
/**
 * Deterministic UniScenarios visual export.
 *
 * Exports a still (`--frames 1`), a deterministic frame sequence
 * (`--frames N`), and, when `ffmpeg` is available and `--video` is passed, an
 * H.264 MP4. A machine-readable manifest is always written next to the images.
 *
 * The script intentionally drives the real app in Chrome instead of reusing
 * renderer internals: it proves the same lifecycle a human/agent sees.
 *
 *   node scripts/export-render.mjs --url http://localhost:5199 --map yale-street \
 *     --out artifacts/qa/export-smoke --frames 24 --fps 12 --video
 *   node scripts/export-render.mjs --url http://localhost:5199 --all-maps \
 *     --out artifacts/qa/five-map-smoke --frames 1
 *
 * Strict Yale instance + trace slice (the Studio server should be bound to the
 * same explicit IPv4 host when a Starcode preview will open it):
 *
 *   pnpm --filter @uniscenarios/studio dev --host 127.0.0.1 --port 5199
 *   node scripts/export-render.mjs --url http://127.0.0.1:5199 \
 *     --instance artifacts/qa/golden-yale-bus-stop-20260801-corrected/instance.json \
 *     --trace artifacts/qa/golden-yale-bus-stop-20260801-corrected/trace.json.gz \
 *     --result artifacts/qa/golden-yale-bus-stop-20260801-corrected/result.json \
 *     --out artifacts/qa/golden-yale-bus-stop-20260801-corrected/studio-render \
 *     --headless --fps 2
 *
 * Corpus mode (`--evidence-class corpus`) renders a research corpus artifact
 * that was never reserved in the 500-slot evidence catalog. It keeps every
 * instance/trace/result hash and actor-id binding, frames every authored actor
 * instead of only the metric pair, and encodes the FULL recorded clip instead
 * of the seconds around the reveal:
 *
 *   node scripts/export-render.mjs --url http://127.0.0.1:5199 \
 *     --instance <dir>/draw-000.instance.json --trace <dir>/draw-000.trace.json.gz \
 *     --result <dir>/draw-000.result.json --out /tmp/vista-3d/<scenarioId> \
 *     --headless --fps 12 --evidence-class corpus
 */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
import {
  assertScenarioEvidenceAccepted,
  buildIncidentRenderPreflight,
  buildScenarioManifest,
  cameraActorClearance,
  cameraForClip,
  cameraForIncident,
  incidentWindow,
  selectClipVideoFrames,
  selectIncidentVideoFrames,
  renderViewsAtTraceIndex,
  resolveRenderGroundHeight,
  sha256Bytes,
  validateCorpusScenarioResult,
  validateScenarioPair,
  validateScenarioResult,
} from './export-render-lib.mjs';
import {
  SCENARIO_REVIEW_PROVENANCE_FILES,
  createScenarioReviewTemplate,
} from './scenario-review-ledger-lib.mjs';

const MAPS = [
  { id: 'yale-street', label: 'Yale Street' },
  { id: 'belmont-research-center', label: 'Belmont Research Center' },
  { id: 'el-camino-road', label: 'El Camino Road' },
  { id: 'easterbrook-discovery-school', label: 'Easterbrook Discovery School' },
  { id: 'richmond-field-station', label: 'Richmond Field Station' },
];

function argsOf(argv) {
  const out = new Map();
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected positional argument ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out.set(key, 'true');
    else {
      out.set(key, next);
      i += 1;
    }
  }
  return out;
}

const args = argsOf(process.argv);
const url = args.get('url') ?? 'http://localhost:5199/';
const outDir = args.get('out') ?? `artifacts/qa/export-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const width = Number(args.get('width') ?? 1600);
const height = Number(args.get('height') ?? 960);
const frames = Math.max(1, Math.floor(Number(args.get('frames') ?? 1)));
const fps = Math.max(1, Math.floor(Number(args.get('fps') ?? 12)));
const headless = args.get('headless') === 'true';
const encodeVideo = args.has('video');
const includeUi = args.has('include-ui');
const instancePath = args.get('instance');
const tracePath = args.get('trace');
const resultPath = args.get('result');
if (Boolean(instancePath) !== Boolean(tracePath)) {
  throw new Error('--instance and --trace must be provided together');
}
const scenarioMode = Boolean(instancePath && tracePath);
const extraChromeArgs = (args.get('chrome-flags') ?? '')
  .split(',')
  .map((flag) => flag.trim())
  .filter(Boolean);
for (let i = 0; i < extraChromeArgs.length; i += 1) {
  if (!extraChromeArgs[i].startsWith('--')) extraChromeArgs[i] = `--${extraChromeArgs[i]}`;
}
const evidenceClassArg = args.get('evidence-class') ?? 'catalog';
if (!['catalog', 'corpus'].includes(evidenceClassArg)) {
  throw new Error(`--evidence-class must be catalog or corpus, got ${evidenceClassArg}`);
}
const corpusMode = evidenceClassArg === 'corpus';
const allAuthored = corpusMode || args.has('all-authored');
const showProgress = args.has('progress');
const cameraSearch = args.has('camera-search');
// Orbit offsets tried, in order, when `--camera-search` is on. 0/1 is the
// analytic camera itself, so an unobstructed scene keeps exactly the framing
// the solver chose; later entries swing progressively further around the
// framing centre and lift the eye to clear a building.
const CAMERA_SEARCH_OFFSETS = [
  { azimuthDeg: 0, heightGain: 1 },
  { azimuthDeg: 0, heightGain: 1.45 },
  { azimuthDeg: 25, heightGain: 1 },
  { azimuthDeg: -25, heightGain: 1 },
  { azimuthDeg: 25, heightGain: 1.45 },
  { azimuthDeg: -25, heightGain: 1.45 },
  { azimuthDeg: 55, heightGain: 1.2 },
  { azimuthDeg: -55, heightGain: 1.2 },
  { azimuthDeg: 90, heightGain: 1.2 },
  { azimuthDeg: -90, heightGain: 1.2 },
  { azimuthDeg: 125, heightGain: 1.3 },
  { azimuthDeg: -125, heightGain: 1.3 },
  { azimuthDeg: 180, heightGain: 1.3 },
  { azimuthDeg: 0, heightGain: 2.2 },
  { azimuthDeg: 45, heightGain: 2.2 },
  { azimuthDeg: -45, heightGain: 2.2 },
  { azimuthDeg: 90, heightGain: 2.2 },
  { azimuthDeg: -90, heightGain: 2.2 },
  { azimuthDeg: 135, heightGain: 2.2 },
  { azimuthDeg: -135, heightGain: 2.2 },
  { azimuthDeg: 180, heightGain: 2.2 },
  // Last resort: a near-overhead viewpoint clears almost any facade at the
  // cost of an unattractive shot, which still beats losing the scenario.
  { azimuthDeg: 0, heightGain: 3.4 },
  { azimuthDeg: 70, heightGain: 3.4 },
  { azimuthDeg: -70, heightGain: 3.4 },
  { azimuthDeg: 180, heightGain: 3.4 },
];

/** Orbit a fitted camera around its own target without changing what it frames. */
function reorientCamera(camera, offset) {
  if (offset.azimuthDeg === 0 && offset.heightGain === 1) {
    return { ...camera, searchOffset: { azimuthDeg: 0, heightGain: 1 } };
  }
  const [targetX, targetY, targetZ] = camera.target;
  const dx = camera.eye[0] - targetX;
  const dz = camera.eye[2] - targetZ;
  const radians = (offset.azimuthDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    ...camera,
    basis: `${camera.basis}+occlusion-search`,
    searchOffset: { ...offset },
    eye: [
      targetX + dx * cos - dz * sin,
      targetY + (camera.eye[1] - targetY) * offset.heightGain,
      targetZ + dx * sin + dz * cos,
    ],
  };
}
const maps = args.has('all-maps')
  ? MAPS
  : [MAPS.find((m) => m.id === (args.get('map') ?? 'yale-street')) ?? MAPS[0]];

function withMap(base, mapId) {
  const u = new URL(base);
  u.searchParams.set('map', mapId);
  u.searchParams.set('dpr', '1');
  return u.toString();
}

async function waitForApp(page) {
  await page.waitForFunction(
    () => Boolean(window.__viewer) && Boolean(window.__overlays) && Boolean(window.__editor),
    null,
    { timeout: 180000 },
  );
}

async function waitForStreamIdle(page, timeout = 120000) {
  await page.waitForFunction(
    () => {
      const s = window.__viewer?.getStats?.();
      return s ? s.residentTiles > 0 && s.loading === 0 && s.uploading === 0 : false;
    },
    null,
    { timeout },
  );
  await settleFrames(page, 12);
}

async function settleFrames(page, count = 8) {
  await page.evaluate((n) => new Promise((resolve) => {
    let i = 0;
    const step = () => {
      i += 1;
      if (i >= n) resolve(null);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), count);
}

async function hideUiForExport(page) {
  if (includeUi) return;
  await page.evaluate(() => {
    // The viewer canvas is nested several layout wrappers below `#root > div`
    // (#root > div > div > div > div > canvas). Hiding every non-CANVAS child
    // of `#root > div` therefore hid the canvas itself: the element became
    // non-visible and `elementHandle.screenshot()` blocked on actionability
    // forever. Walk the canvas ancestor chain instead and hide only its
    // siblings at each level, which removes the chrome while leaving the
    // canvas visible and its layout box unchanged.
    const canvas = document.querySelector('canvas');
    if (!canvas) return;
    let node = canvas;
    while (node.parentElement && node.parentElement !== document.documentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling !== node) sibling.style.visibility = 'hidden';
      }
      node = node.parentElement;
    }
  });
}

async function chooseStage(page) {
  return page.evaluate(() => {
    const byId = window.__overlays.signals.userData.byId ?? {};
    const lights = Object.values(byId).filter((p) => p.category === 'traffic_light');
    if (lights.length >= 3) {
      let best = null;
      for (const a of lights) {
        const near = lights.filter((b) => (a.position[0] - b.position[0]) ** 2 + (a.position[2] - b.position[2]) ** 2 < 45 ** 2);
        if (!best || near.length > best.length) best = near;
      }
      const x = best.reduce((s, p) => s + p.position[0], 0) / best.length;
      const z = best.reduce((s, p) => s + p.position[2], 0) / best.length;
      return { x, z, y: window.__overlays.sampleHeight(x, z), reason: `traffic-light cluster (${best.length})` };
    }
    const lane = [...window.__editor.laneIndex.all].sort((a, b) => b.length - a.length)[0];
    const pose = window.__editor.laneIndex.poseAt(lane, lane.length / 2, 0);
    return { x: pose.x, z: pose.z, y: window.__overlays.sampleHeight(pose.x, pose.z), reason: `longest lane ${lane.rsl}` };
  });
}

async function setView(page, eye, target, fovDeg = null) {
  await page.evaluate((v) => {
    const viewer = window.__viewer;
    const V = viewer.camera.position.constructor;
    if (v.fovDeg !== null) {
      viewer.camera.fov = v.fovDeg;
      viewer.camera.updateProjectionMatrix();
    }
    viewer.controls.setView(new V(v.eye[0], v.eye[1], v.eye[2]), new V(v.target[0], v.target[1], v.target[2]));
  }, { eye, target, fovDeg });
  await settleFrames(page, 8);
}

/**
 * Verify the composition with the live Studio camera and scene graph. Actor
 * footprint clearance alone cannot catch a camera placed behind foliage or a
 * shelter, so every present incident actor must project inside the canvas and
 * have an unobstructed ray through the static city/vegetation layers.
 */
async function inspectIncidentComposition(
  page, poses, requiredActorIds, separationActorIds, conflictT, sampleT,
) {
  return page.evaluate(({ actorPoses, ids, separationIds, conflict, t }) => {
    const viewer = window.__viewer;
    const editor = window.__editor;
    if (!viewer || !editor) throw new Error('Studio viewer is unavailable for composition inspection');
    const canvas = viewer.renderer.domElement;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    viewer.camera.updateMatrixWorld(true);
    viewer.camera.updateProjectionMatrix();
    const required = actorPoses.filter((pose) => pose.present && ids.includes(pose.id));
    const raycaster = editor.raycaster;
    if (!raycaster) throw new Error('Studio raycaster is unavailable for composition inspection');
    const savedNear = raycaster.near;
    const savedFar = raycaster.far;
    const actors = required.map((pose) => {
      const actorCenter = viewer.camera.position.clone().set(
        pose.x,
        pose.y + Math.max(0.8, (pose.dims?.h ?? 1.8) * 0.52),
        pose.z,
      );
      const ndc = actorCenter.clone().project(viewer.camera);
      const pixel = [(ndc.x + 1) * width / 2, (1 - ndc.y) * height / 2];
      const origin = viewer.camera.position.clone();
      const direction = actorCenter.clone().sub(origin);
      const distanceM = direction.length();
      raycaster.near = 0.05;
      raycaster.far = Math.max(0.05, distanceM - Math.max(0.7, (pose.dims?.l ?? 1.8) * 0.25));
      raycaster.set(origin, direction.normalize());
      const cityHit = raycaster.intersectObject(viewer.cityGroup, true)[0];
      const vegetationHit = raycaster.intersectObject(viewer.vegetationGroup, true)[0];
      const blocker = !cityHit ? vegetationHit
        : !vegetationHit ? cityHit
          : cityHit.distance <= vegetationHit.distance ? cityHit : vegetationHit;
      return {
        id: pose.id,
        ndc: [ndc.x, ndc.y, ndc.z],
        pixel,
        inFrame: ndc.z >= -1 && ndc.z <= 1 && Math.abs(ndc.x) <= 0.94 && Math.abs(ndc.y) <= 0.9,
        sceneryClear: !blocker,
        blockerLayer: blocker ? (blocker === vegetationHit ? 'vegetation' : 'city') : null,
        blockerDistanceM: blocker?.distance ?? null,
      };
    });
    raycaster.near = savedNear;
    raycaster.far = savedFar;
    const separationActors = actors.filter((actor) => separationIds.includes(actor.id));
    let minPairSeparationPx = Infinity;
    let closestPair = null;
    for (let i = 0; i < separationActors.length; i += 1) {
      for (let j = i + 1; j < separationActors.length; j += 1) {
        const separation = Math.hypot(
          separationActors[i].pixel[0] - separationActors[j].pixel[0],
          separationActors[i].pixel[1] - separationActors[j].pixel[1],
        );
        if (separation < minPairSeparationPx) {
          minPairSeparationPx = separation;
          closestPair = [separationActors[i].id, separationActors[j].id];
        }
      }
    }
    const minimumRequiredSeparationPx = t >= conflict - 0.05 ? 24 : 4;
    return {
      viewport: { width, height },
      boundsNdc: { x: 0.94, y: 0.9 },
      minimumRequiredSeparationPx,
      minPairSeparationPx: separationActors.length < 2 ? null : minPairSeparationPx,
      closestPair,
      actors,
      passed: actors.every((actor) => actor.inFrame && actor.sceneryClear)
        && (separationActors.length < 2 || minPairSeparationPx >= minimumRequiredSeparationPx),
    };
  }, {
    actorPoses: poses, ids: requiredActorIds, separationIds: separationActorIds,
    conflict: conflictT, t: sampleT,
  });
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function writeJsonAtomic(file, value) {
  const absolute = path.resolve(file);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, absolute);
}

async function clearGeneratedFrames(directory, pattern) {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!pattern.test(entry.name)) continue;
    if (!entry.isFile()) {
      throw new Error(`refusing to replace non-file frame artifact ${path.join(directory, entry.name)}`);
    }
    await unlink(path.join(directory, entry.name));
  }
}

async function readJsonMaybeGzip(file) {
  const bytes = await readFile(file);
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return { value: JSON.parse(plain.toString('utf8')), bytes, canonicalBytes: plain };
}

async function topologyEvidence(instanceDoc, trace, mapId) {
  const mapDir = path.resolve('dev-assets', mapId);
  const topologyFile = path.join(mapDir, 'topology-index.json.gz');
  const xodrFile = path.join(mapDir, 'map.xodr');
  const renderManifestFile = path.join(mapDir, '3d', 'manifest.json');
  for (const file of [topologyFile, xodrFile, renderManifestFile]) {
    if (!existsSync(file)) throw new Error(`map evidence file is missing: ${file}`);
  }
  const [topologyBytes, xodrBytes, renderManifestBytes] = await Promise.all([
    readFile(topologyFile),
    readFile(xodrFile),
    readFile(renderManifestFile),
  ]);
  const matcherDigest = sha256Bytes(topologyBytes);
  const engineGraphDigest = sha256Bytes(xodrBytes);
  const claimedMatcher = instanceDoc.manifest.replayKey.matcherIndexDigest;
  const claimedEngine = instanceDoc.manifest.replayKey.engineGraphDigest;
  if (claimedMatcher !== matcherDigest) {
    throw new Error(`topology integrity failed: matcher topology ${claimedMatcher} != map artifact ${matcherDigest}`);
  }
  if (claimedEngine !== engineGraphDigest || trace.header.engineGraphDigest !== engineGraphDigest) {
    throw new Error(
      `topology integrity failed: simulation graph instance=${claimedEngine} trace=${trace.header.engineGraphDigest} map=${engineGraphDigest}`,
    );
  }
  return {
    authoringMatcherTopology: {
      domain: 'anchor matching and lane topology index',
      digest: matcherDigest,
      artifact: path.relative(process.cwd(), topologyFile),
    },
    simulationRoadGraph: {
      domain: 'simulation graph derived from source OpenDRIVE',
      digest: engineGraphDigest,
      traceLegacyTopologyDigest: trace.header.topologyDigest ?? null,
      artifact: path.relative(process.cwd(), xodrFile),
    },
    studioRenderScene: {
      domain: 'streamed 3D city and road render manifest',
      digest: sha256Bytes(renderManifestBytes),
      artifact: path.relative(process.cwd(), renderManifestFile),
    },
  };
}

async function exportScenario(page) {
  const instanceFile = path.resolve(instancePath);
  const traceFile = path.resolve(tracePath);
  const [{ value: instanceDoc, bytes: instanceBytes }, { value: trace, bytes: traceFileBytes, canonicalBytes }] =
    await Promise.all([readJsonMaybeGzip(instanceFile), readJsonMaybeGzip(traceFile)]);
  const evidence = validateScenarioPair(instanceDoc, trace, canonicalBytes);
  let resultDoc = null;
  let resultBytes = null;
  let resultBinding = null;
  if (resultPath) {
    const loaded = await readJsonMaybeGzip(path.resolve(resultPath));
    resultDoc = loaded.value;
    resultBytes = loaded.bytes;
    if (corpusMode) {
      const bound = validateCorpusScenarioResult(instanceDoc, trace, resultDoc, {
        instanceFileBytes: instanceBytes,
        traceFileBytes,
      });
      resultBinding = {
        mode: 'corpus-semantic',
        catalogSlot: null,
        collisionPolicy: bound.collisionPolicy,
        recordedCollisions: bound.recordedCollisions,
        resultDigest: bound.resultDigest,
        instanceFileSha256: bound.instanceFileSha256,
        traceFileSha256: bound.traceFileSha256,
      };
    } else {
      validateScenarioResult(instanceDoc, trace, resultDoc, canonicalBytes, {
        instanceFileBytes: instanceBytes,
        traceFileBytes,
      });
    }
  }
  // The scenario's own eligibility declaration decides whether a recorded
  // collision condemns the clip; absent a result document the strict policy
  // applies, which is what `validateScenarioResult` already demands.
  const preflight = buildIncidentRenderPreflight(trace, evidence, {
    collisionPolicy: resultDoc?.eligibility?.collisionPolicy ?? 'reject',
  });
  const preflightFile = path.join(outDir, 'preflight.json');
  await writeJsonAtomic(preflightFile, {
    ...preflight,
    scenarioId: instanceDoc.manifest.instanceId,
    mapId: evidence.mapId,
    inputHash: evidence.inputHash,
    traceDigest: evidence.traceDigest,
    countsTowardScenarioCoverage: false,
  });
  if (preflight.verdict !== 'pass') {
    const failed = preflight.gates.filter((gate) => gate.status === 'fail').map((gate) => gate.id);
    throw new Error(
      `scenario render preflight rejected: ${failed.join(', ')}`
      + `${preflight.defectCodes.length > 0 ? ` [${preflight.defectCodes.join(', ')}]` : ''}`,
    );
  }
  const topologyDomains = await topologyEvidence(instanceDoc, trace, evidence.mapId);
  const selectedFrames = preflight.selectedFrames;
  const framesDir = path.join(outDir, 'frames');
  const sourceDir = path.join(outDir, 'source');
  await Promise.all([
    mkdir(framesDir, { recursive: true }),
    mkdir(sourceDir, { recursive: true }),
  ]);
  await clearGeneratedFrames(framesDir, /^frame-\d{3}\.png$/);
  // Snapshot the validated pair into the evidence bundle. A long GPU export
  // must remain self-contained even if an upstream regeneration replaces the
  // source paths while Chrome is rendering the sequence.
  const instanceSnapshot = path.join(sourceDir, 'instance.json');
  const traceSnapshot = path.join(sourceDir, 'trace.json.gz');
  const resultSnapshot = resultBytes ? path.join(sourceDir, 'result.json') : null;
  await Promise.all([
    writeFile(instanceSnapshot, instanceBytes),
    writeFile(traceSnapshot, traceFileBytes),
    ...(resultSnapshot ? [writeFile(resultSnapshot, resultBytes)] : []),
  ]);

  const pageUrl = withMap(url, evidence.mapId);
  await page.goto(pageUrl, { waitUntil: 'load' });
  // Studio defers mounting the 3D world until a render-quality preference is
  // *stored*. An unparsable value silently degrades to `invalid`, the chooser
  // still disappears, and every captured frame would be empty. Fail loudly.
  const qualityState = await page.evaluate(() => {
    try {
      const raw = window.localStorage.getItem('uniscenarios.studio.render-quality.v1');
      if (!raw) return { state: 'missing', raw: null };
      const parsed = JSON.parse(raw);
      return { state: typeof parsed?.preset === 'string' ? 'stored' : 'invalid', raw };
    } catch (error) {
      return { state: 'unavailable', raw: String(error) };
    }
  });
  if (qualityState.state !== 'stored') {
    throw new Error(`render-quality preference is ${qualityState.state}; the 3D world would never mount`);
  }
  await waitForApp(page);
  await waitForStreamIdle(page);
  await page.evaluate(() => {
    // Lane polygons are an authoring/debug layer; the evidence render keeps
    // the real streamed road/map and real signal furniture without the cyan
    // coverage wash obscuring the incident.
    window.__overlays.setVisible('lanes', false);
  });
  await hideUiForExport(page);
  const loadedMapId = await page.evaluate(() => window.__mapId ?? window.__editor?.doc?.map?.id ?? null);
  if (loadedMapId !== evidence.mapId) {
    throw new Error(`Studio loaded map ${loadedMapId}, expected ${evidence.mapId}`);
  }

  const incident = incidentWindow(trace);
  const occluderActorIds = (trace.metrics.revealToConflict?.relevantOccluderIds ?? [])
    .filter((id) => id.startsWith('actor:'))
    .map((id) => id.slice('actor:'.length));
  // A corpus clip has to show the ego and every authored challenger, not just
  // the two actors that produced the criticality metric.
  //
  // AUTHORED ONLY. `evidence.actorIds` also lists generated background road users once ambient
  // traffic is on, and requiring all ~40 of them to be simultaneously in-frame and unoccluded is
  // unsatisfiable -- it rejected 60 of 62 corpus scenarios with
  // `ambient:v1:...(inFrame=false)`. Ambient traffic is scenery: it must be VISIBLE IN the shot,
  // never a CONSTRAINT ON the shot. The strict composition gate is unchanged for every authored
  // actor, and on traces written before ambient traffic existed `ambientActorIds` is absent, so this
  // filter is a no-op.
  const ambientActorIdSet = new Set(trace?.header?.ambientActorIds ?? []);
  const framingActorIds = allAuthored
    ? [...evidence.actorIds].filter((id) => !ambientActorIdSet.has(id))
    : [...new Set([...evidence.metricPair, ...occluderActorIds])].filter((id) => !ambientActorIdSet.has(id));
  const declaredOccluderIds = new Set(trace.metrics.revealToConflict?.relevantOccluderIds ?? []);
  let framingPropIds;
  if (allAuthored) {
    const conflictIndex = trace.ticks.t.reduce((best, value, index) => (
      Math.abs(value - incident.conflictT) < Math.abs(trace.ticks.t[best] - incident.conflictT)
        ? index
        : best
    ), 0);
    const conflictViews = renderViewsAtTraceIndex(instanceDoc, trace, evidence, conflictIndex);
    const pair = conflictViews.actors.filter((actor) => evidence.metricPair.includes(actor.id));
    const center = {
      x: pair.reduce((sum, actor) => sum + actor.x, 0) / pair.length,
      z: pair.reduce((sum, actor) => sum + actor.z, 0) / pair.length,
    };
    const nearestByCatalog = new Map();
    for (const prop of conflictViews.props) {
      const distance = Math.hypot(prop.x - center.x, prop.z - center.z);
      const current = nearestByCatalog.get(prop.catalogId);
      if (!current || distance < current.distance) nearestByCatalog.set(prop.catalogId, { prop, distance });
    }
    framingPropIds = new Set([...nearestByCatalog.values()]
      .sort((left, right) => left.distance - right.distance || left.prop.id.localeCompare(right.prop.id))
      .slice(0, 6)
      .map(({ prop }) => prop.id));
  } else {
    framingPropIds = new Set(evidence.props.filter((prop) => {
      const declared = declaredOccluderIds.has(prop.id) || declaredOccluderIds.has(`prop:${prop.id}`);
      const relation = prop.occludes
        && evidence.metricPair.includes(prop.occludes.observer)
        && evidence.metricPair.includes(prop.occludes.target);
      return declared || relation;
    }).map((prop) => prop.id));
  }

  // Sticky across the whole export: an accepted orbit offset is retried first
  // on the next frame so the clip keeps one stable shot.
  let cameraOffset = CAMERA_SEARCH_OFFSETS[0];
  const renderTraceFrame = async (selected, file, settleCount, clipCamera = false) => {
    // Stage timings on stderr make a stalled export diagnosable instead of a
    // silent multi-hour hang. They never enter the manifest.
    const stageStart = Date.now();
    let lastStage = stageStart;
    const stage = (name) => {
      if (!showProgress) return;
      const now = Date.now();
      process.stderr.write(`[progress] t=${selected.t} ${name} ${now - lastStage}ms total=${now - stageStart}ms\n`);
      lastStage = now;
    };
    const views = renderViewsAtTraceIndex(instanceDoc, trace, evidence, selected.index);
    const sampledGround = await page.evaluate(({ actors, props }) => {
      const overlays = window.__overlays;
      const viewer = window.__viewer;
      if (!overlays || !viewer) throw new Error('Studio renderer is unavailable');
      const sample = (value) => ({
        ...value,
        surfaceHeights: viewer.getGroundIndex()?.sampleAll(value.x, value.z) ?? [],
        fallbackHeight: overlays.sampleHeight(value.x, value.z),
      });
      return { actors: actors.map(sample), props: props.map(sample) };
    }, views);
    const groundedActors = sampledGround.actors.map(({ surfaceHeights, fallbackHeight, ...actor }) => ({
      ...actor,
      y: resolveRenderGroundHeight(surfaceHeights, fallbackHeight),
    }));
    const groundedProps = sampledGround.props.map(({ surfaceHeights, fallbackHeight, heightM, ...prop }) => ({
      ...prop,
      y: resolveRenderGroundHeight(surfaceHeights, fallbackHeight) + heightM,
    }));
    await page.evaluate(({ actors, props }) => {
      const editor = window.__editor;
      if (!editor) throw new Error('Studio renderer is unavailable');
      editor.renderer.sync([
        ...actors.filter((actor) => actor.present),
        ...props,
      ]);
      editor.renderer.setSelection([]);
    }, { actors: groundedActors, props: groundedProps });
    const grounded = { actors: groundedActors, props: groundedProps };
    stage('sync');
    const groundedPoses = grounded.actors;
    const pairGround = groundedPoses
      .filter((pose) => evidence.metricPair.includes(pose.id))
      .reduce((sum, pose) => sum + pose.y, 0) / evidence.metricPair.length;
    const framingProps = grounded.props.filter((prop) => framingPropIds.has(prop.id));
    const strictIncidentComposition = selected.t <= incident.conflictT + 0.5 + 1e-9;
    const frameActorIds = strictIncidentComposition
      ? framingActorIds
      : (evidence.actorIds.includes('ego') ? ['ego'] : evidence.metricPair.slice(0, 1));
    // Pre-event and reveal establish the actors and road. Static incident
    // furniture can still be far down-corridor then; require it in the
    // conflict composition, when it is causally visible.
    const frameProps = strictIncidentComposition && selected.phase === 'conflict'
      ? framingProps
      : [];
    const cameraProps = allAuthored ? framingProps : frameProps;
    const baseCamera = (clipCamera ? cameraForClip : cameraForIncident)(
      trace,
      evidence.metricPair,
      selected.index,
      pairGround,
      frameActorIds,
      cameraProps,
    );
    const compositionArgs = [
      [...groundedPoses, ...frameProps],
      [...frameActorIds, ...frameProps.map((prop) => prop.id)],
      evidence.metricPair,
      incident.conflictT,
      selected.t,
    ];
    const describeFailure = (composition) => {
      const failures = composition.actors
        .filter((actor) => !actor.inFrame || !actor.sceneryClear)
        .map((actor) => `${actor.id}(inFrame=${actor.inFrame},sceneryClear=${actor.sceneryClear},blocker=${actor.blockerLayer})`);
      if (Number.isFinite(composition.minPairSeparationPx)
        && composition.minPairSeparationPx < composition.minimumRequiredSeparationPx) {
        failures.push(
          `${composition.closestPair?.join('/')} separation ${composition.minPairSeparationPx.toFixed(1)}px < ${composition.minimumRequiredSeparationPx}px`,
        );
      }
      return failures.join(', ');
    };

    // The analytic camera solvers pick an azimuth from the incident sightline
    // alone. On a real city map that direction is frequently occupied by a
    // building, so a geometrically perfect framing still has no line of sight
    // and the composition gate correctly rejects it. `--camera-search` orbits
    // the same fitted camera around its own target until every framing actor
    // is unobstructed. The offset is sticky across the clip so the shot stays
    // stable instead of jittering frame to frame.
    let camera = baseCamera;
    let cameraClearance = cameraActorClearance(
      camera,
      [...groundedPoses, ...grounded.props],
      [...evidence.actorModels, ...grounded.props],
    );
    let composition;
    if (cameraSearch) {
      const ordered = [cameraOffset, ...CAMERA_SEARCH_OFFSETS.filter(
        (candidate) => candidate.azimuthDeg !== cameraOffset.azimuthDeg || candidate.heightGain !== cameraOffset.heightGain,
      )];
      let accepted = null;
      let lastComposition = null;
      for (const candidate of ordered) {
        const trial = reorientCamera(baseCamera, candidate);
        const clearance = cameraActorClearance(
          trial,
          [...groundedPoses, ...grounded.props],
          [...evidence.actorModels, ...grounded.props],
        );
        if (clearance.clearanceM < 2) continue;
        await setView(page, trial.eye, trial.target, trial.fovDeg);
        // The candidate must be judged in the same fully-resident state the
        // capture will use. Testing before stream-idle lets a not-yet-uploaded
        // city tile read as clear line of sight, and the shot then fails the
        // authoritative check after the tile lands.
        await waitForStreamIdle(page, 60000);
        await settleFrames(page, settleCount);
        const trialComposition = await inspectIncidentComposition(page, ...compositionArgs);
        lastComposition = trialComposition;
        if (trialComposition.passed) {
          accepted = { camera: trial, clearance, candidate, composition: trialComposition };
          break;
        }
      }
      if (!accepted) {
        throw new Error(
          `incident composition failed at t=${selected.t} for every searched camera: ${
            lastComposition ? describeFailure(lastComposition) : 'no candidate cleared the actor footprints'}`,
        );
      }
      camera = accepted.camera;
      cameraClearance = accepted.clearance;
      cameraOffset = accepted.candidate;
      composition = accepted.composition;
      stage('cameraSearch');
    } else {
      if (cameraClearance.clearanceM < 2) {
        throw new Error(
          `camera intersects actor clearance at t=${selected.t}: ${cameraClearance.actorId} ${cameraClearance.clearanceM.toFixed(3)}m`,
        );
      }
      await setView(page, camera.eye, camera.target, camera.fovDeg);
      stage('setView');
      // Catalog evidence must fail closed if the incident view never reaches a
      // fully resident state. Capturing after a swallowed timeout can make a
      // missing city tile look like clear line of sight.
      await waitForStreamIdle(page, 60000);
      stage('streamIdle');
      await settleFrames(page, settleCount);
      stage('settle');
      composition = await inspectIncidentComposition(page, ...compositionArgs);
      if (!composition.passed) {
        throw new Error(`incident composition failed at t=${selected.t}: ${describeFailure(composition)}`);
      }
    }
    stage('composition');
    const capture = async () => {
      if (includeUi) {
        await page.screenshot({ path: file, fullPage: false });
      } else {
        const canvas = await page.$('canvas');
        if (!canvas) throw new Error('viewer canvas not found');
        await canvas.screenshot({ path: file });
      }
    };
    // A GPU context can die between the readiness gate above and the shutter —
    // on a loaded machine the driver drops the device under VRAM pressure. The
    // renderer reports the loss and the rebuild that follows through `loading`,
    // so a frame is only trustworthy when nothing was outstanding as the
    // shutter closed.
    const sceneWasWhole = () => page.evaluate(() => window.__viewer.getStats().loading === 0);
    let whole = false;
    for (let attempt = 0; attempt < 3 && !whole; attempt += 1) {
      if (attempt > 0) await waitForStreamIdle(page, 60_000);
      await capture();
      whole = await sceneWasWhole();
    }
    if (!whole) {
      throw new Error(`renderer never held a complete scene through a capture at t=${selected.t}`);
    }
    stage('screenshot');
    return {
      requestedT: selected.targetT,
      index: selected.index,
      t: selected.t,
      poses: groundedPoses.map(({
        catalogId, catalogIdAuthored, kind, dims, static: isStatic, doors, reversing,
        emergency, hornActive, ...pose
      }) => pose),
      props: grounded.props.map(({ catalogId, catalogIdAuthored, dims, static: isStatic, ...prop }) => prop),
      camera,
      cameraActorClearance: cameraClearance,
      composition,
      artifact: {
        file: path.relative(outDir, file),
        sha256: await sha256(file),
      },
    };
  };

  const frameRecords = [];
  for (let frameNo = 0; frameNo < selectedFrames.length; frameNo += 1) {
    const selected = selectedFrames[frameNo];
    // The catalog reserves render/frame.png as its primary still. Make the
    // conflict frame that exact artifact; the other named phases remain in
    // the deterministic frame sequence.
    const file = selected.phase === 'conflict'
      ? path.join(outDir, 'frame.png')
      : path.join(framesDir, `frame-${String(frameNo).padStart(3, '0')}.png`);
    frameRecords.push({
      phase: selected.phase,
      ...(await renderTraceFrame(selected, file, 16)),
    });
  }

  let video = null;
  let videoSequence = null;
  if (!args.has('no-video')) {
    const videoFps = Math.max(8, fps);
    const selection = corpusMode || args.get('full-clip') === 'true'
      ? selectClipVideoFrames(trace, videoFps)
      : selectIncidentVideoFrames(trace, videoFps);
    const videoFramesDir = path.join(outDir, 'video-frames');
    await clearGeneratedFrames(videoFramesDir, /^frame-\d{5}\.png$/);
    const records = [];
    for (let frameNo = 0; frameNo < selection.frames.length; frameNo += 1) {
      const selected = selection.frames[frameNo];
      const file = path.join(videoFramesDir, `frame-${String(frameNo).padStart(5, '0')}.png`);
      const record = await renderTraceFrame(selected, file, 3, corpusMode);
      records.push({
        sequenceIndex: frameNo,
        index: record.index,
        requestedT: record.requestedT,
        t: record.t,
        poses: record.poses,
        props: record.props,
        camera: record.camera,
        cameraActorClearance: record.cameraActorClearance,
        composition: record.composition,
      });
    }
    // This exact name is reserved in every catalog slot.
    const output = path.join(outDir, 'video.mp4');
    const ffmpeg = spawnSync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-framerate', String(videoFps),
      '-i', path.join(videoFramesDir, 'frame-%05d.png'),
      '-an',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-threads', '1',
      '-fflags', '+bitexact',
      '-flags:v', '+bitexact',
      '-map_metadata', '-1',
      '-movflags', '+faststart',
      output,
    ], { encoding: 'utf8' });
    if (ffmpeg.status === 0 && existsSync(output)) {
      const probe = spawnSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'stream=nb_frames,r_frame_rate,width,height',
        '-of', 'json',
        output,
      ], { encoding: 'utf8' });
      if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`);
      const stream = JSON.parse(probe.stdout).streams?.[0];
      if (Number(stream?.nb_frames) !== records.length || stream?.r_frame_rate !== `${videoFps}/1`) {
        throw new Error(
          `encoded video mismatch: frames=${stream?.nb_frames} fps=${stream?.r_frame_rate}, expected ${records.length} @ ${videoFps}/1`,
        );
      }
    }
    video = ffmpeg.status === 0 && existsSync(output)
      ? {
          file: path.relative(outDir, output),
          fps: videoFps,
          durationSeconds: records.length / videoFps,
          frameCount: records.length,
          sha256: await sha256(output),
        }
      : { unavailable: true, reason: ffmpeg.stderr || 'ffmpeg not installed or failed' };
    if (ffmpeg.status === 0 && existsSync(output)) {
      // The MP4 is the bound motion artifact. Keep failed encoder inputs for
      // diagnosis, but remove successful temporary PNGs to keep 500-slot
      // evidence storage bounded.
      await Promise.all(selection.frames.map((_, frameNo) => unlink(path.join(
        videoFramesDir,
        `frame-${String(frameNo).padStart(5, '0')}.png`,
      ))));
      await rmdir(videoFramesDir);
    }
    videoSequence = {
      startT: selection.startT,
      endT: selection.endT,
      fps: videoFps,
      ...(selection.coverage ? { coverage: selection.coverage, clipWindow: selection.window } : {}),
      frameCount: records.length,
      frames: records,
    };
  }

  // Keep performance counters out of the evidence manifest: fps, heap and
  // residency timing are intentionally runtime-dependent. These renderer
  // facts are stable for a fixed actor/model set.
  const rendererStats = await page.evaluate(() => ({
    actorRenderer: window.__editor.renderer.stats,
  }));
  const manifest = buildScenarioManifest({
    instanceDoc,
    trace,
    evidence,
    topologyDomains,
    viewport: { width, height, deviceScaleFactor: 1, includeUi },
    frameRecords,
    videoSequence,
    video,
    inputArtifacts: {
      instance: {
        file: path.relative(outDir, instanceSnapshot),
        source: path.relative(process.cwd(), instanceFile),
        sha256: sha256Bytes(instanceBytes),
      },
      traceFile: {
        file: path.relative(outDir, traceSnapshot),
        source: path.relative(process.cwd(), traceFile),
        sha256: sha256Bytes(traceFileBytes),
      },
      ...(resultSnapshot ? {
        result: {
          file: path.relative(outDir, resultSnapshot),
          source: path.relative(process.cwd(), path.resolve(resultPath)),
          sha256: sha256Bytes(resultBytes),
        },
      } : {}),
    },
    rendererStats,
    diagnostics,
    ...(corpusMode
      ? { evidenceClass: 'corpus-scenario-clip', resultBinding }
      : {}),
  });
  manifest.simulationNotices = simulationNotices;
  const manifestFile = path.join(outDir, 'manifest.json');
  await writeJsonAtomic(manifestFile, manifest);
  // Preserve the rejected manifest for diagnosis, but never report a strict
  // scenario export as successful unless every machine gate passes.
  assertScenarioEvidenceAccepted(manifest.machineAssessment);
  const rendererSources = await Promise.all(SCENARIO_REVIEW_PROVENANCE_FILES.map(async (file) => ({
    file,
    sha256: sha256Bytes(await readFile(path.resolve(file))),
  })));
  const reviewTemplate = createScenarioReviewTemplate(manifest, 'manifest.json', {
    instanceDoc,
    trace,
    instanceSha256: sha256Bytes(instanceBytes),
    traceFileSha256: sha256Bytes(traceFileBytes),
    resultSha256: resultBytes ? sha256Bytes(resultBytes) : null,
    rendererSources,
  });
  await writeJsonAtomic(path.join(outDir, 'review.json'), reviewTemplate);
  return manifest;
}

async function exportMap(page, map) {
  const mapDir = path.join(outDir, map.id);
  const framesDir = path.join(mapDir, 'frames');
  await mkdir(framesDir, { recursive: true });

  const pageUrl = withMap(url, map.id);
  await page.goto(pageUrl, { waitUntil: 'load' });
  await waitForApp(page);
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('uniscenarios:scenario:')) localStorage.removeItem(key);
    }
  });
  await page.reload({ waitUntil: 'load' });
  await waitForApp(page);
  await waitForStreamIdle(page);
  await hideUiForExport(page);

  const stage = await chooseStage(page);
  const radius = 48;
  const elevation = 28;
  const captures = [];
  for (let i = 0; i < frames; i += 1) {
    const theta = frames === 1 ? Math.PI * 0.25 : (2 * Math.PI * i) / frames + Math.PI * 0.25;
    const eye = [stage.x + Math.cos(theta) * radius, stage.y + elevation, stage.z + Math.sin(theta) * radius];
    const target = [stage.x, stage.y, stage.z];
    await setView(page, eye, target);
    await waitForStreamIdle(page, 60000).catch(() => undefined);
    await settleFrames(page, 24);
    const file = frames === 1 ? path.join(mapDir, 'still.png') : path.join(framesDir, `frame-${String(i).padStart(6, '0')}.png`);
    if (includeUi) {
      await page.screenshot({ path: file, fullPage: false });
    } else {
      const canvas = await page.$('canvas');
      if (!canvas) throw new Error('viewer canvas not found');
      await canvas.screenshot({ path: file });
    }
    captures.push({
      index: i,
      cameraMode: 'orbit',
      file: path.relative(outDir, file),
      sha256: await sha256(file),
      eye,
      target,
    });
  }

  let video = null;
  if (encodeVideo && frames > 1) {
    const output = path.join(mapDir, 'video.mp4');
    const ffmpeg = spawnSync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-framerate', String(fps),
      '-i', path.join(framesDir, 'frame-%06d.png'),
      '-an',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-threads', '1',
      '-fflags', '+bitexact',
      '-flags:v', '+bitexact',
      '-map_metadata', '-1',
      '-movflags', '+faststart',
      output,
    ], { encoding: 'utf8' });
    if (ffmpeg.status === 0 && existsSync(output)) {
      video = { file: path.relative(outDir, output), sha256: await sha256(output), encoder: 'ffmpeg/libx264' };
    } else {
      video = { unavailable: true, reason: ffmpeg.stderr || 'ffmpeg not installed or failed' };
    }
  }

  const stats = await page.evaluate(() => ({
    viewer: window.__viewer.getStats(),
    overlays: window.__overlays.stats,
    lanes: window.__editor.laneIndex.stats,
    actors: window.__editor.state.actors.length,
  }));
  const manifest = {
    schema: 'uniscenarios.map-render-diagnostic.v1',
    evidenceClass: 'map-render-diagnostic',
    countsTowardScenarioCoverage: false,
    cameraMode: 'orbit',
    generatedAt: new Date().toISOString(),
    map,
    pageUrl,
    viewport: { width, height, deviceScaleFactor: 1 },
    includeUi,
    frames: captures,
    video,
    stage,
    stats,
  };
  await writeJsonAtomic(path.join(mapDir, 'manifest.json'), manifest);
  return manifest;
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome',
  headless,
  args: [
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    `--window-size=${width + 80},${height + 120}`,
    ...extraChromeArgs,
  ],
});
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
// A fresh browser profile has no stored render-quality preference, so Studio
// shows its first-run graphics chooser and never mounts the viewer. Seed the
// same preference a human would pick (default: the app's own `balanced`
// preset, i.e. full city + vegetation) before the app boots.
const qualityPreset = args.get('quality') ?? 'balanced';
if (args.has('pin-page')) {
  // A long batch export can run while the Vite dev server is still hot-reloading
  // from unrelated source edits. A full page reload mid-sequence destroys
  // window.__viewer and the run dies with a confusing error. `--pin-page`
  // neutralises the dev-client's `location.reload()` for the export session only.
  await context.addInitScript(() => {
    try {
      const reload = window.location.reload.bind(window.location);
      Object.defineProperty(window.location, 'reload', {
        configurable: true,
        value: () => { console.warn('[export-render] suppressed dev-server reload'); void reload; },
      });
    } catch {
      // Non-configurable location in some engines; the export simply stays exposed.
    }
  });
}
await context.addInitScript((preset) => {
  try {
    const key = 'uniscenarios.studio.render-quality.v1';
    if (!window.localStorage.getItem(key)) {
      window.localStorage.setItem(key, JSON.stringify({ preset }));
    }
  } catch {
    // A privacy-restricted store simply leaves the chooser visible.
  }
}, qualityPreset);
const page = await context.newPage();
const diagnostics = [];
// The bundled SUMO-derived traffic model emits its own advisory channel through
// console.error, e.g. "Warning: Vehicle 'sumo-...' performs emergency braking on
// lane ...". Those are simulation-quality notices about ambient traffic, not
// browser or renderer faults, and they must not be able to reject a visual
// evidence bundle. They are still recorded, just in a non-blocking bucket.
const simulationNotices = [];
const SIMULATION_NOTICE = /^Warning: /;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const text = m.text();
  if (SIMULATION_NOTICE.test(text)) simulationNotices.push({ type: 'console', text });
  else diagnostics.push({ type: 'console', text });
});
page.on('pageerror', (e) => diagnostics.push({ type: 'pageerror', text: String(e) }));

const results = [];
try {
  if (scenarioMode) {
    console.log(`> export strict scenario ${instancePath}`);
    results.push(await exportScenario(page));
  } else {
    for (const map of maps) {
      console.log(`> export ${map.id}`);
      results.push(await exportMap(page, map));
    }
  }
} finally {
  await browser.close();
}

if (scenarioMode) {
  console.log(JSON.stringify({
    outDir,
    mapId: results[0].mapId,
    scenarioId: results[0].scenarioId,
    frames: results[0].frames.length,
    diagnostics: diagnostics.length,
  }, null, 2));
} else {
  const rootManifest = {
    schema: 'uniscenarios.multi-map-render-diagnostic.v1',
    evidenceClass: 'multi-map-render-diagnostic',
    countsTowardScenarioCoverage: false,
    generatedAt: new Date().toISOString(),
    command: process.argv,
    machine: { platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length },
    inputs: { url, outDir, frames, fps, width, height, headless, encodeVideo, includeUi, maps: maps.map((m) => m.id) },
    diagnostics,
    results: results.map((r) => ({ map: r.map, manifest: path.join(r.map.id, 'manifest.json'), frames: r.frames, video: r.video, stage: r.stage })),
  };
  await writeFile(path.join(outDir, 'validation-manifest.json'), JSON.stringify(rootManifest, null, 2));
  console.log(JSON.stringify({ outDir, maps: maps.map((m) => m.id), diagnostics: diagnostics.length }, null, 2));
}
