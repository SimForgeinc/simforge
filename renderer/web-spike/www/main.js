// web-spike measurement harness (NON-PRODUCT).
// Boot: init WebGPU engine, load 3 BC7-KTX2 map tiles + animated actor, first frame.
// Phases (also callable from automation): runOrbit, runPick, runVideoFrame.

import initWasm, { spikeInit } from './pkg/web_spike.js';

const logEl = document.getElementById('log');
const R = (window.__results = { phases: {}, errors: [] });

function log(...a) {
  const s = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  logEl.textContent += s + '\n';
  console.log('[spike]', s);
}

function quantile(sorted, q) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
}

const TILES = [
  '/assets/tile_0_1.lod0.bc7.glb',
  '/assets/tile_1_0.lod0.bc7.glb',
  '/assets/tile_1_1.lod0.bc7.glb',
];
const ACTOR = '/assets/actor_mustang.glb';

let spike = null;
let center = [0, 0, 0];
let orbitR = 100;
let actorPos = [0, 0, 0];

function memSnapshot() {
  const m = {};
  if (performance.memory) m.jsHeapUsed = performance.memory.usedJSHeapSize;
  try { m.wasmMemory = JSON.parse(spike.stats()).wasmMemoryBytes; } catch {}
  return m;
}

async function boot() {
  const t = { navStart: 0 };
  t.moduleStart = performance.now();
  await initWasm();
  t.wasmReady = performance.now();

  if (!navigator.gpu) throw new Error('navigator.gpu missing — no WebGPU in this browser');
  const canvas = document.getElementById('cv');
  spike = await spikeInit(canvas);
  window.__spike = spike;
  t.deviceReady = performance.now();
  log('adapter:', spike.adapterInfo());

  const tileStats = JSON.parse(await spike.loadTiles(TILES));
  t.tilesLoaded = performance.now();

  const b = spike.sceneBounds();
  center = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
  const dx = b[3] - b[0], dy = b[4] - b[1], dz = b[2] > b[5] ? 0 : b[5] - b[2];
  orbitR = Math.max(dx, dz) * 0.45;
  log('bounds:', b.map(v => v.toFixed(1)), 'orbitR:', orbitR.toFixed(1));

  const actorStats = JSON.parse(await spike.spawnActor(ACTOR));
  actorPos = actorStats.pos;
  t.actorLoaded = performance.now();

  spike.setCamera([
    center[0] + orbitR, center[1] + orbitR * 0.55, center[2] + orbitR,
    center[0], center[1], center[2], 50,
  ]);
  await spike.renderAt(0);
  t.firstFrame = performance.now();

  R.phases.boot = {
    timings: {
      wasmInitMs: +(t.wasmReady - t.moduleStart).toFixed(1),
      deviceInitMs: +(t.deviceReady - t.wasmReady).toFixed(1),
      tilesMs: +(t.tilesLoaded - t.deviceReady).toFixed(1),
      actorMs: +(t.actorLoaded - t.tilesLoaded).toFixed(1),
      firstRenderMs: +(t.firstFrame - t.actorLoaded).toFixed(1),
      ttffFromModuleStartMs: +(t.firstFrame - t.moduleStart).toFixed(1),
      ttffFromNavStartMs: +t.firstFrame.toFixed(1),
    },
    tiles: tileStats,
    actor: actorStats,
    stats: JSON.parse(spike.stats()),
    mem: memSnapshot(),
  };
  log('boot:', R.phases.boot.timings);
  log('stats:', R.phases.boot.stats);
}

// Orbit the camera around `focus` for n frames driven by rAF; per-frame renderAt(tick).
async function runOrbit(n = 600, focus = 'scene', dist = null, fov = 50) {
  const target = focus === 'actor' ? [actorPos[0], actorPos[1] + 2, actorPos[2]] : center;
  const d = dist ?? (focus === 'actor' ? orbitR * 0.05 : orbitR);
  const frameDeltas = [];
  const renderCpu = [];
  let last = null;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    spike.setCamera([
      target[0] + Math.cos(a) * d, target[1] + d * 0.55, target[2] + Math.sin(a) * d,
      target[0], target[1], target[2], fov,
    ]);
    const t0 = performance.now();
    await spike.renderAt(i);
    renderCpu.push(performance.now() - t0);
    const ts = await new Promise(requestAnimationFrame);
    if (last !== null) frameDeltas.push(ts - last);
    last = ts;
  }
  frameDeltas.sort((a, b) => a - b);
  renderCpu.sort((a, b) => a - b);
  const res = {
    frames: n,
    focus,
    frameDeltaMs: {
      p50: +quantile(frameDeltas, 0.5).toFixed(2),
      p95: +quantile(frameDeltas, 0.95).toFixed(2),
      p99: +quantile(frameDeltas, 0.99).toFixed(2),
      max: +frameDeltas[frameDeltas.length - 1].toFixed(2),
    },
    renderAtCpuMs: {
      p50: +quantile(renderCpu, 0.5).toFixed(2),
      p95: +quantile(renderCpu, 0.95).toFixed(2),
      max: +renderCpu[renderCpu.length - 1].toFixed(2),
    },
    mem: memSnapshot(),
  };
  R.phases['orbit_' + focus] = res;
  log('orbit', focus, res.frameDeltaMs, 'renderAtCpu:', res.renderAtCpuMs);
  return res;
}

async function runPick(n = 40) {
  // warm up once
  await spike.pick(640, 360);
  const lat = [];
  let ids = {};
  for (let i = 0; i < n; i++) {
    const x = 200 + ((i * 37) % 880);
    const y = 150 + ((i * 53) % 420);
    const t0 = performance.now();
    const id = await spike.pick(x, y);
    lat.push(performance.now() - t0);
    ids[id] = (ids[id] || 0) + 1;
  }
  lat.sort((a, b) => a - b);
  const res = {
    picks: n,
    latencyMs: {
      p50: +quantile(lat, 0.5).toFixed(2),
      p95: +quantile(lat, 0.95).toFixed(2),
      max: +lat[lat.length - 1].toFixed(2),
    },
    distinctIds: Object.keys(ids).length,
    idHistogramTop: Object.entries(ids).sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
  R.phases.pick = res;
  log('pick:', res);
  return res;
}

// E2E-8 check: after `await renderAt(tick)`, does `new VideoFrame(canvas)` hold
// exactly that tick's frame? The engine draws a tick-coded swatch at (8,8)-(104,104);
// we capture, read the swatch center, and compare against expectedSwatch(tick).
async function captureSwatchPixel() {
  const canvas = document.getElementById('cv');
  const vf = new VideoFrame(canvas, { timestamp: 0 });
  try {
    const w = vf.codedWidth, h = vf.codedHeight;
    // draw the VideoFrame and read pixels (robust across pixel formats)
    const oc = new OffscreenCanvas(w, h);
    const ctx = oc.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(vf, 0, 0);
    const px = ctx.getImageData(50, 50, 1, 1).data;
    return { rgba: [px[0], px[1], px[2], px[3]], format: vf.format, w, h };
  } finally {
    vf.close();
  }
}

async function runVideoFrame() {
  const ticks = [11, 47, 200];
  const trials = [];
  let pass = true;
  for (const tick of ticks) {
    await spike.renderAt(tick);
    const cap = await captureSwatchPixel();
    const want = Array.from(spike.expectedSwatch(tick));
    const prevWant = Array.from(spike.expectedSwatch(tick - 1));
    const diff = Math.max(...want.map((w, i) => Math.abs(w - cap.rgba[i])));
    const staleDiff = Math.max(...prevWant.map((w, i) => Math.abs(w - cap.rgba[i])));
    const ok = diff <= 3 && staleDiff > 3;
    pass = pass && ok;
    trials.push({ tick, want, got: cap.rgba.slice(0, 3), maxChannelDiff: diff, staleFrameDiff: staleDiff, format: cap.format, ok });
  }
  const res = { pass, trials };
  R.phases.videoFrame = res;
  log('videoFrame exact-frame test:', pass ? 'PASS' : 'FAIL', trials);
  return res;
}

window.runOrbit = runOrbit;
window.runPick = runPick;
window.runVideoFrame = runVideoFrame;
window.setCam = (...p) => spike.setCamera(p);
window.renderAt = t => spike.renderAt(t);

(async () => {
  try {
    await boot();
    R.ready = true;
  } catch (e) {
    R.errors.push(String(e && e.stack || e));
    log('ERROR:', String(e));
  }
})();
