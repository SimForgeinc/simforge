#!/usr/bin/env node
/**
 * W0 kill-test clip renderer.
 *
 * Renders one scenario instance/trace pair as a fixed-fps RGB clip at H3's
 * 736x416 while emitting per-frame engine ground truth as JSONL.
 *
 * Reuses scripts/export-render-lib.mjs (read-only import) for pose projection,
 * clearance checks and hashing. It drives Studio's live viewer directly instead
 * of export-render.mjs' catalog evidence gates, because W0 needs every frame of
 * a short window rather than gated key frames, and tolerates traces whose
 * metrics carry no two-actor metric pair (signal-violation scenarios) and whose
 * header inputHash is computed over the engine-normalised input rather than the
 * raw instance file.
 *
 * Usage:
 *   node scripts/w0/render-clip.mjs --instance a.json --trace a.trace.json.gz \
 *     --out /home/path/w0-data/clips/a [--weather clear|fog|night-rain] \
 *     [--seconds 5] [--fps 12] [--center auto|<seconds>]
 */

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

import { chromium } from 'playwright-core';
import { gunzipSync } from 'node:zlib';

import {
  cameraActorClearance,
  nearestIndex,
  renderViewsAtTraceIndex,
  sha256Bytes,
  sha256Json,
} from '../export-render-lib.mjs';

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

async function readJsonMaybeGzip(file) {
  const bytes = await readFile(file);
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return JSON.parse(plain.toString('utf8'));
}

// Visual-only weather appearances for the fog / night-rain content classes.
// The five-map v2 catalog authors every slot as `weekday-clear`, so these are
// applied on top of an engine-exact clear trace; the engine has no friction or
// visibility coupling for them yet (documented W0 content gap).
const WEATHER_PRESETS = {
  fog: {
    backgroundColor: 0xb9c2ca,
    backgroundBlurriness: 0.4,
    backgroundIntensityScale: 0.85,
    environmentIntensityScale: 0.7,
    exposureScale: 0.92,
    fog: { color: 0xb9c2ca, visibilityM: 110, haze: 0.6 },
    precipitation: null,
    clouds: { coverage: 0.95, opacity: 0.7 },
    sunColor: 0xd8dde2,
    sunIntensityScale: 0.45,
    surface: { wetness: 0.15, snowCoverage: 0, snowDepthM: 0, snowCompaction: 0 },
  },
  'night-rain': {
    backgroundColor: 0x05070c,
    backgroundBlurriness: 0.6,
    backgroundIntensityScale: 0.06,
    environmentIntensityScale: 0.12,
    exposureScale: 0.62,
    fog: { color: 0x0a0e14, visibilityM: 180, haze: 0.3 },
    precipitation: { kind: 'rain', intensity: 0.75, wind: 0.25, budget: 'medium' },
    clouds: { coverage: 1, opacity: 0.95, color: 0x11151c },
    sunColor: 0x8090b0,
    sunIntensityScale: 0.05,
    surface: { wetness: 0.95, snowCoverage: 0, snowDepthM: 0, snowCompaction: 0 },
  },
};

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
  await page.evaluate(() => {
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

/** Apply a visual weather preset via the viewer API or a three.js fallback. */
async function applyWeather(page, presetName) {
  const preset = WEATHER_PRESETS[presetName];
  if (!preset) throw new Error(`unknown weather preset ${presetName}`);
  return page.evaluate(async (appearance) => {
    const viewer = window.__viewer;
    const info = { backend: 'viewer-api', movedSun: false };
    if (typeof viewer.setWeatherAppearance === 'function') {
      viewer.setWeatherAppearance(appearance);
      return info;
    }
    // Stale Vite pre-bundle fallback: shape the scene directly. No surface
    // wetness or sky-dome coupling, but fog, darkness and rain read correctly.
    info.backend = 'three-scene-fallback';
    const browserHash = await (await fetch('/node_modules/.vite/deps/_metadata.json')).json()
      .then((m) => m.browserHash).catch(() => null);
    let THREE = null;
    for (const url of [
      `/node_modules/.vite/deps/three.js${browserHash ? `?v=${browserHash}` : ''}`,
      '/node_modules/.vite/deps/three.js',
    ]) {
      try { THREE = await import(url); break; } catch { /* try next */ }
    }
    if (!THREE) throw new Error('could not import three for weather fallback');
    const scene = viewer.scene;
    const visibilityM = appearance.fog?.visibilityM ?? 1000;
    const density = 2.0 / Math.max(1, visibilityM);
    const fogColorHex = appearance.fog?.color ?? appearance.backgroundColor ?? 0x87a0b8;
    const fogColor = new THREE.Color(fogColorHex);
    scene.fog = new THREE.FogExp2(fogColor.getHex(), density);
    scene.background = new THREE.Color(appearance.backgroundColor ?? fogColorHex);
    let sunFound = false;
    scene.traverse((node) => {
      if (node.isDirectionalLight && !sunFound) {
        sunFound = true;
        node.userData.__w0BaseIntensity = node.intensity;
        node.intensity *= appearance.sunIntensityScale;
        if (appearance.sunIntensityScale <= 0.1) {
          const target = node.target?.position ?? { x: 0, y: 0, z: 0 };
          node.position.set(target.x + 30, -60, target.z + 12);
          info.movedSun = true;
        }
      }
      if ((node.isAmbientLight || node.isHemisphereLight) && !node.userData.__w0Dimmed) {
        node.userData.__w0Dimmed = true;
        node.userData.__w0BaseIntensity = node.intensity;
        node.intensity *= Math.max(appearance.sunIntensityScale, 0.25);
      }
    });
    if (appearance.precipitation?.kind === 'rain') {
      // Camera-centred rain volume: ~4k short streaks around the eye.
      const count = 4000;
      const positions = new Float32Array(count * 6);
      for (let i = 0; i < count; i += 1) {
        const x = (Math.random() - 0.5) * 60;
        const y = Math.random() * 24;
        const z = (Math.random() - 0.5) * 60;
        positions[i * 6] = x; positions[i * 6 + 1] = y; positions[i * 6 + 2] = z;
        positions[i * 6 + 3] = x + 0.12; positions[i * 6 + 4] = y - 0.7; positions[i * 6 + 5] = z;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const material = new THREE.LineBasicMaterial({ color: 0x9fb2c8, transparent: true, opacity: 0.34 });
      const rain = new THREE.LineSegments(geometry, material);
      rain.name = 'w0-rain';
      rain.frustumCulled = false;
      if (!scene.children.includes(viewer.camera)) scene.add(viewer.camera);
      viewer.camera.add(rain);
    }
    return info;
  }, preset);
}

/**
 * Full-clip camera that keeps every framing actor inside the viewport, solved
 * per frame from the present actors' bounding radius with the azimuth frozen
 * at the criticality sightline so the shot never spins mid-clip. Local variant
 * of export-render-lib's cameraForClip that takes an explicit anchor time
 * instead of depending on an incident window being present in the metrics.
 */
function clipCameraAt(traceLocal, pair, anchorT, index, groundY, framingIds, framingPropPoses = []) {
  const t = traceLocal.ticks.t;
  const anchorIndex = nearestIndex(t, anchorT);
  const poseAt = (id, i) => ({
    id,
    x: traceLocal.ticks.actors[id].x[i],
    z: -traceLocal.ticks.actors[id].y[i],
    headingRad: traceLocal.ticks.actors[id].headingRad[i],
    present: traceLocal.ticks.actors[id].present[i] !== 0,
  });
  const subjectId = pair.includes(traceLocal.header.metricSubject) ? traceLocal.header.metricSubject : pair[0];
  const otherId = pair.find((id) => id !== subjectId) ?? subjectId;
  const subject = poseAt(subjectId, anchorIndex);
  const target = poseAt(otherId, anchorIndex);
  const sightline = Math.hypot(subject.x - target.x, subject.z - target.z);
  const away = sightline > 1e-6
    ? { x: (subject.x - target.x) / sightline, z: (subject.z - target.z) / sightline }
    : { x: -Math.cos(subject.headingRad), z: Math.sin(subject.headingRad) };
  const side = { x: -away.z, z: away.x };
  const poses = [
    ...framingIds.map((id) => poseAt(id, index)),
    ...framingPropPoses.map((pose) => ({ ...pose, present: pose.present !== false })),
  ].filter((pose) => pose.present);
  if (poses.length === 0) throw new Error(`no framing actors are present at trace index ${index}`);
  const centerX = poses.reduce((sum, pose) => sum + pose.x, 0) / poses.length;
  const centerZ = poses.reduce((sum, pose) => sum + pose.z, 0) / poses.length;
  const radius = Math.max(...poses.map((pose) => Math.hypot(pose.x - centerX, pose.z - centerZ)));
  const fovDeg = 45;
  const halfAngle = (fovDeg / 2) * (Math.PI / 180);
  const distance = Math.max(16, (radius + 6) / (Math.tan(halfAngle) * 0.8));
  const height = groundY + Math.max(7, distance * 0.42);
  return {
    basis: 'w0-clip-fit-frozen-azimuth',
    fovDeg,
    eye: [
      centerX + away.x * distance + side.x * (distance * 0.12),
      height,
      centerZ + away.z * distance + side.z * (distance * 0.12),
    ],
    target: [centerX, groundY + 1.35, centerZ],
  };
}

/**
 * Dashcam (CAR POV) camera: pinned to the ego windshield position, looking
 * forward along the ego heading. This is the in-distribution view for H3
 * (trained on dashcam footage); the cinematic framing solve stays available
 * via --camera framing. Forward convention matches editor-core actorRenderer:
 * scene-space forward is (cos(headingRad), -sin(headingRad)).
 */
function povCameraAt(pose, groundY, { lookAheadM = 12, eyeHeightM = 1.45, fovDeg = 58 } = {}) {
  const c = Math.cos(pose.headingRad);
  const s = Math.sin(pose.headingRad);
  const eyeY = groundY + eyeHeightM;
  return {
    basis: 'w0-ego-dashcam-pov',
    fovDeg,
    eye: [pose.x, eyeY, pose.z],
    target: [pose.x + c * lookAheadM, eyeY - (eyeHeightM - 1.2) * 0.35, pose.z - s * lookAheadM],
  };
}

const args = argsOf(process.argv);
const url = args.get('url') ?? 'http://localhost:5199/';
const instancePath = args.get('instance');
const tracePathArg = args.get('trace');
const outDir = args.get('out');
if (!instancePath || !tracePathArg || !outDir) {
  throw new Error('--instance, --trace and --out are all required');
}
const width = Number(args.get('width') ?? 736);
const height = Number(args.get('height') ?? 416);
const fps = Math.max(1, Math.floor(Number(args.get('fps') ?? 12)));
const seconds = Number(args.get('seconds') ?? 5);
if (!(seconds >= 2 && seconds <= 8)) throw new Error('--seconds must be within [2, 8]');
const frames = Math.round(seconds * fps);
const weather = args.get('weather') ?? 'clear';
// 'pov' (default) = ego dashcam view; 'framing' = cinematic frozen-azimuth fit.
const cameraMode = args.get('camera') ?? 'pov';

const instanceDoc = await readJsonMaybeGzip(instancePath);
const trace = await readJsonMaybeGzip(tracePathArg);

const times = trace.ticks.t;
const header = trace.header;
const input = instanceDoc.input;

// Tolerant pair join. The strict catalog validator hard-fails on (a)
// inputHash mismatches caused by the engine hashing the parsed+normalised
// input while the instance file stores adapter order, and (b) scenarios whose
// metrics carry no two-actor metric pair (e.g. signal violations measured by
// stop-line state). W0 clips only need pose-exact GT, so build evidence from
// the trace header itself and report integrity findings without blocking.
if (header.mapId !== input.mapId) {
  throw new Error(`map mismatch: trace ${header.mapId} vs instance ${input.mapId}`);
}
const sortedIds = [...input.actors.map((a) => a.id)].sort();
if (JSON.stringify(sortedIds) !== JSON.stringify([...header.actorIds].sort())) {
  throw new Error('instance/trace actor ids differ');
}
const integrityFindings = [];
{
  const recomputed = sha256Json(input);
  if ((header.inputHash ?? null) !== recomputed) {
    integrityFindings.push(
      `inputHash ${header.inputHash ?? 'null'} != raw-file hash ${recomputed} ` +
      '(engine hashes normalised input; informational for W0)');
  }
}
const actorMetadata = header.actorMetadata ?? {};
for (const id of sortedIds) {
  if (!actorMetadata[id]) throw new Error(`trace header lacks actorMetadata for ${id}`);
}
// Actors whose trace metadata carries no `catalog:` tag (some pedestrians and
// cyclists) fall back to the kind default the old renderer used; the currently
// served editor-core throws on a null catalog id instead of defaulting.
const KIND_DEFAULT_CATALOG = {
  car: 'vehicle.sedan',
  vehicle: 'vehicle.sedan',
  truck: 'vehicle.box_truck',
  bus: 'vehicle.bus',
  van: 'vehicle.van',
  motorcycle: 'vehicle.motorcycle',
  bicycle: 'vehicle.bicycle',
  pedestrian: 'pedestrian.adult_walking',
};
const actorModels = sortedIds.map((id) => {
  const meta = actorMetadata[id];
  const tagged = (meta.tags ?? []).find((tag) => tag.startsWith('catalog:'))?.slice('catalog:'.length) ?? null;
  return {
    id,
    kind: meta.kind,
    static: meta.static === true,
    dims: meta.dims,
    catalogId: tagged ?? KIND_DEFAULT_CATALOG[meta.kind] ?? null,
  };
});
const props = Array.isArray(input.props) ? input.props : [];
const ambientSet = new Set(header.ambientActorIds ?? []);
const framingActorIds = sortedIds.filter((id) => !ambientSet.has(id));

// Camera framing pair: prefer the recorded criticality pair, else ego vs the
// first other dynamic actor, else the first two framing actors.
let metricPair = trace.metrics.revealToConflict?.pair ?? trace.metrics.minTTC?.pair ?? null;
if (!metricPair || metricPair.length !== 2) {
  const subjectId = framingActorIds.includes('ego') ? 'ego' : framingActorIds[0];
  const other = framingActorIds.find((id) => id !== subjectId && actorMetadata[id]?.static !== true);
  metricPair = other ? [subjectId, other] : [framingActorIds[0], framingActorIds[1] ?? framingActorIds[0]];
}

// Clip window centred on the incident: prefer the reveal→conflict span, fall
// back to the criticality peak, then to the span where every framing actor is
// present, then to mid-trace.
const clipCenterFallback = () => {
  let first = -1;
  let last = -1;
  for (let i = 0; i < times.length; i += 1) {
    if (framingActorIds.every((id) => trace.ticks.actors[id].present[i] !== 0)) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return times[Math.floor(times.length / 2)];
  return (times[first] + times[last]) / 2;
};
const conflictT = trace.metrics.revealToConflict?.conflictT ?? null;
const peakT = trace.metrics.minTTC?.t ?? null;
const requestedCenter = args.get('center') === undefined || args.get('center') === 'auto'
  ? (conflictT ?? peakT ?? clipCenterFallback())
  : Number(args.get('center'));
const halfSpan = seconds * 0.55;
let startT = Math.max(times[0], Math.min(requestedCenter - halfSpan, times[times.length - 1] - seconds));
startT = Math.max(startT, times[0]);

await mkdir(outDir, { recursive: true });
const framesDir = path.join(outDir, 'frames');
await mkdir(framesDir, { recursive: true });

// Default Chrome headless lands on SwiftShader on this host; forcing the
// Vulkan ANGLE backend selects the real GPU (verified RTX 5080 via
// WEBGL_debug_renderer_info). Falls back to software where Vulkan is absent.
const browser = await chromium.launch({
  channel: 'chrome',
  headless: args.get('headless') !== 'false',
  args: [
    '--ignore-gpu-blocklist',
    '--use-gl=angle',
    '--use-angle=vulkan',
    `--window-size=${width + 80},${height + 120}`,
  ],
});
try {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  // Studio defers mounting the 3D world until a render-quality preference is
  // stored; seed it before boot exactly like export-render.mjs does.
  const qualityPreset = args.get('quality') ?? 'balanced';
  await context.addInitScript((preset) => {
    try {
      const key = 'uniscenarios.studio.render-quality.v1';
      if (!window.localStorage.getItem(key)) {
        window.localStorage.setItem(key, JSON.stringify({ preset }));
      }
    } catch { /* leave chooser visible */ }
  }, qualityPreset);
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') process.stderr.write(`[w0-render][console] ${m.text().slice(0, 200)}\n`);
  });
  page.on('pageerror', (e) => process.stderr.write(`[w0-render][pageerror] ${String(e).slice(0, 200)}\n`));

  const pageUrl = new URL(url);
  pageUrl.searchParams.set('map', header.mapId);
  pageUrl.searchParams.set('dpr', '1');
  await page.goto(pageUrl.toString(), { waitUntil: 'load' });
  await waitForApp(page);
  await waitForStreamIdle(page);
  await page.evaluate(() => {
    window.__overlays.setVisible('lanes', false);
  });
  await hideUiForExport(page);

  const loadedMapId = await page.evaluate(() => window.__mapId ?? window.__editor?.doc?.map?.id ?? null);
  if (loadedMapId !== header.mapId) {
    throw new Error(`Studio loaded map ${loadedMapId}, expected ${header.mapId}`);
  }

  let weatherInfo = { applied: false };
  if (weather !== 'clear') {
    weatherInfo = { applied: true, ...(await applyWeather(page, weather)) };
    await settleFrames(page, 24);
  }

  const gtRecords = [];
  const frameRecords = [];
  for (let frameNo = 0; frameNo < frames; frameNo += 1) {
    const targetT = startT + frameNo / fps;
    const index = nearestIndex(times, targetT);
    const frameStart = Date.now();
    process.stderr.write(`[w0-render] frame ${frameNo}/${frames} t=${targetT.toFixed(2)}\n`);
    const views = renderViewsAtTraceIndex(instanceDoc, trace, { actorModels, props }, index);
    const povHideId = cameraMode === 'pov' && actorModels.some((m) => m.id === 'ego') ? 'ego' : null;
    const grounded = await page.evaluate(({ actors, props: frameProps, hideActorId }) => {
      const overlays = window.__overlays;
      const editor = window.__editor;
      if (!overlays || !editor) throw new Error('Studio renderer is unavailable');
      const groundedActors = actors.map((actor) => ({
        ...actor,
        y: actor.present ? overlays.sampleHeight(actor.x, actor.z) : 0,
      }));
      const groundedProps = frameProps.map(({ heightM, ...prop }) => ({
        ...prop,
        y: overlays.sampleHeight(prop.x, prop.z) + heightM,
      }));
      editor.renderer.sync([
        ...groundedActors.filter((actor) => actor.present && actor.id !== hideActorId),
        ...groundedProps,
      ]);
      editor.renderer.setSelection([]);
      return { actors: groundedActors, props: groundedProps };
    }, { ...views, hideActorId: povHideId });

    const presentPoses = grounded.actors.filter((pose) => framingActorIds.includes(pose.id) && pose.present);
    const pairGround = presentPoses.reduce((sum, pose) => sum + pose.y, 0) / Math.max(1, presentPoses.length);
    let camera;
    if (cameraMode === 'pov') {
      const egoPose = grounded.actors.find((pose) => pose.id === 'ego' && pose.present)
        ?? grounded.actors.find((pose) => pose.present);
      if (!egoPose) throw new Error(`no present actor to pin the POV camera to at t=${times[index]}`);
      camera = povCameraAt(egoPose, egoPose.y);
    } else {
      camera = clipCameraAt(trace, metricPair, requestedCenter, index, pairGround, framingActorIds, []);
      const clearance = cameraActorClearance(camera, [...grounded.actors, ...grounded.props], [...actorModels, ...grounded.props]);
      if (clearance.clearanceM < 1.5) {
        process.stderr.write(`[w0-render] warning: camera clearance ${clearance.clearanceM.toFixed(2)}m to ${clearance.actorId} at t=${times[index]}\n`);
      }
    }
    await setView(page, camera.eye, camera.target, camera.fovDeg);
    await waitForStreamIdle(page, 60000);
    await settleFrames(page, 4);

    const fileName = `frame-${String(frameNo).padStart(5, '0')}.png`;
    const file = path.join(framesDir, fileName);
    // Playwright's element screenshot can block indefinitely when the tab's
    // compositor stalls; race it so a hung capture surfaces as an error.
    await Promise.race([
      (async () => {
        const canvas = await page.$('canvas');
        if (!canvas) throw new Error('viewer canvas not found');
        await canvas.screenshot({ path: file });
      })(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`screenshot timed out at frame ${frameNo}`)), 90000)),
    ]);
    process.stderr.write(`[w0-render] frame ${frameNo} done ${Date.now() - frameStart}ms\n`);

    frameRecords.push({
      sequenceIndex: frameNo,
      index,
      requestedT: targetT,
      t: times[index],
      camera,
      file: path.join('frames', fileName),
    });

    // Per-frame engine ground truth: exact recorded channels plus the resolved
    // scene-space pose the renderer displayed (y grounded via map sampler).
    const time = times[index];
    const signalState = {};
    for (const [signalId, trackSignal] of Object.entries(trace.ticks.signals ?? {})) {
      signalState[signalId] = {
        ...(trackSignal.state ? { state: trackSignal.state[index] } : {}),
        ...(trackSignal.program ? { program: trackSignal.program[index] } : {}),
      };
    }
    gtRecords.push({
      schema: 'uniscenarios.w0-frame-gt.v1',
      scenarioId: instanceDoc.manifest.instanceId,
      mapId: header.mapId,
      frame: frameNo,
      t: time,
      tickIndex: index,
      weatherVisual: weather,
      actors: grounded.actors.map((pose) => {
        const model = actorModels.find((m) => m.id === pose.id);
        const track = trace.ticks.actors[pose.id];
        return {
          id: pose.id,
          kind: model.kind,
          catalogId: model.catalogId,
          static: model.static,
          dims: model.dims,
          present: pose.present,
          x: track.x[index],
          yEngine: track.y[index],
          zScene: pose.z,
          yScene: pose.y,
          headingRad: track.headingRad[index],
          speedMps: track.speedMps[index],
          laneRsl: track.laneRsl[index],
          s: track.s[index],
          reversing: track.motionDirection?.[index] === -1,
        };
      }),
      props: grounded.props.map((prop) => ({
        id: prop.id,
        catalogId: prop.catalogId,
        dims: prop.dims,
        x: prop.x,
        zScene: prop.z,
        headingRad: prop.headingRad,
      })),
      signals: signalState,
      camera: { eye: camera.eye, target: camera.target, fovDeg: camera.fovDeg },
    });
  }

  const videoPath = path.join(outDir, 'video.mp4');
  const ffmpeg = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-framerate', String(fps),
    '-i', path.join(framesDir, 'frame-%05d.png'),
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1',
    '-fflags', '+bitexact', '-flags:v', '+bitexact', '-map_metadata', '-1',
    '-movflags', '+faststart',
    videoPath,
  ], { encoding: 'utf8' });
  const video = ffmpeg.status === 0 && existsSync(videoPath)
    ? { file: 'video.mp4', fps, durationSeconds: frames / fps, frameCount: frames, sha256: await sha256Bytes(await readFile(videoPath)) }
    : { unavailable: true, reason: ffmpeg.stderr || 'ffmpeg failed' };

  const manifest = {
    schema: 'uniscenarios.w0-clip-manifest.v1',
    generatedAt: new Date().toISOString(),
    scenarioId: instanceDoc.manifest.instanceId,
    mapId: header.mapId,
    inputHashRawFile: sha256Json(input),
    inputHashEngineNormalized: header.inputHash ?? null,
    integrityFindings,
    viewport: { width, height, deviceScaleFactor: 1 },
    fps,
    seconds,
    startT,
    centerT: requestedCenter,
    conflictT,
    peakT,
    weather,
    cameraMode,
    weatherInfo,
    metricPair,
    ambientActorIds: [...ambientSet],
    sources: {
      instance: instancePath,
      trace: tracePathArg,
      instanceSha256: await sha256Bytes(await readFile(instancePath)),
      traceSha256: await sha256Bytes(await readFile(tracePathArg)),
    },
    frames: frameRecords,
    video,
  };
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const gtFile = path.join(outDir, 'gt.jsonl');
  await writeFile(gtFile, gtRecords.map((record) => JSON.stringify(record)).join('\n') + '\n');

  console.log(JSON.stringify({
    out: outDir,
    frames,
    fps,
    startT,
    tRange: [frameRecords[0].t, frameRecords[frameRecords.length - 1].t],
    weather,
    video,
  }));
} finally {
  await browser.close();
}
