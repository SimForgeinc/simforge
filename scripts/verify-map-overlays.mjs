#!/usr/bin/env node
/**
 * Real-GPU verification for the map overlays (lanes + signals).
 *
 * Companion to `verify-city-renderer.mjs`, same rules: system Chrome against a
 * running `pnpm dev`, headed (headless SwiftShader lies about performance),
 * fails on any console error.
 *
 * What it proves:
 *  1. Overlays load after settle and report sane stats.
 *  2. Lane surfaces are flush with the road — measured, not eyeballed: N lane
 *     vertices spread across the map, compared against BOTH the ground index and
 *     `viewer.sampleGroundHeight` (the live raycast).
 *  3. No spikes: every lane vertex is compared against a robust local estimate
 *     of its own neighbourhood. This is the check that catches a vertex draped
 *     onto a lamp post instead of the road, which reads as a cyan shard in a
 *     screenshot and is invisible in the p95 alignment number.
 *  4. Signal heads sit at plausible mounted heights above the ground.
 *  5. No z-fighting: repeat screenshots at one static pose must be byte-identical
 *     (the HUD is hidden first — its numbers change every 250 ms).
 *  6. `window.__bench()` with overlays on vs off, interleaved — the frame-cost
 *     delta, with run-to-run noise bounded by the repeats.
 *
 *   node scripts/verify-map-overlays.mjs [--url http://localhost:5199] [--out /tmp/...]
 */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i]?.replace(/^--/, ''), process.argv[i + 1]);
}
const url = args.get('url') ?? 'http://localhost:5199/';
const outDir = args.get('out') ?? '/tmp/simforge-overlays';
const benchMs = Number(args.get('bench') ?? 15000);
const alignSamples = Number(args.get('align') ?? 300);

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--window-size=1680,1050'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 960 } });
const page = await context.newPage();

const consoleErrors = [];
const consoleWarnings = [];
page.on('console', (msg) => {
  const text = `${msg.type()}: ${msg.text()}`;
  if (msg.type() === 'error') consoleErrors.push(text);
  else if (msg.type() === 'warning') consoleWarnings.push(text);
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
page.on('requestfailed', (req) => {
  // React StrictMode double-mounts in dev; the first viewer's fetches abort.
  const failure = req.failure()?.errorText ?? '';
  if (failure.includes('ERR_ABORTED')) return;
  consoleErrors.push(`requestfailed: ${failure} ${req.url()}`);
});
page.on('response', (res) => {
  if (res.status() >= 400) consoleErrors.push(`http ${res.status()} ${res.url()}`);
});

const shot = async (name) => {
  const file = path.join(outDir, `${name}.png`);
  const buf = await page.screenshot({ path: file });
  console.log(`  screenshot -> ${file}`);
  return { file, hash: createHash('sha256').update(buf).digest('hex').slice(0, 16) };
};

const setLayers = (lanes, signals) =>
  page.evaluate(([l, s]) => {
    window.__overlays.setVisible('lanes', l);
    window.__overlays.setVisible('signals', s);
  }, [lanes, signals]);

const setView = (eye, target) =>
  page.evaluate((v) => {
    const viewer = window.__viewer;
    const V = viewer.camera.position.constructor;
    viewer.controls.setView(new V(v[0], v[1], v[2]), new V(v[3], v[4], v[5]));
  }, [...eye, ...target]);

const streamIdle = (timeout = 40000) =>
  page
    .waitForFunction(
      () => {
        const s = window.__viewer?.getStats();
        return s ? s.loading === 0 && s.uploading === 0 && s.queued === 0 : false;
      },
      null,
      { timeout },
    )
    .catch(() => console.log('  (still streaming)'));

// ---------------------------------------------------------------- 0. load
console.log(`> opening ${url}`);
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__viewer), null, { timeout: 30000 });

const overlayStart = Date.now();
await page.waitForFunction(() => Boolean(window.__overlays), null, { timeout: 240000 });
const overlayReadyMs = Date.now() - overlayStart;
const overlayStats = await page.evaluate(() => window.__overlays.stats);
console.log(`> overlays ready ${overlayReadyMs} ms after page load`);
console.log(JSON.stringify(overlayStats, null, 2));

const defaults = await page.evaluate(() => ({
  lanes: window.__overlays.isVisible('lanes'),
  signals: window.__overlays.isVisible('signals'),
}));
console.log(`> toggle defaults ${JSON.stringify(defaults)}`);

// -------------------------------------------------- 1. lane drape alignment
console.log(`> measuring lane drape (${alignSamples} spread vertices)`);
const alignment = await page.evaluate((n) => {
  const viewer = window.__viewer;
  const overlays = window.__overlays;
  const mesh = overlays.lanes.getObjectByName('lane-surfaces');
  const pos = mesh.geometry.attributes.position;
  const total = pos.count;
  const step = Math.max(1, Math.floor(total / n));

  const vsIndex = [];
  const vsRay = [];
  const rayNull = [];
  const worst = [];
  // Sign matters. `sampleGroundHeight` returns the topmost surface of road AND
  // city, so a lane under a building canopy legitimately reads far "off" — but
  // it is BELOW the roof, which is fine. A lane ABOVE the topmost surface is
  // the actual failure (an overlay drawn on a rooftop), and must be zero.
  let above = 0;
  let below = 0;
  for (let i = 0; i < total; i += step) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const g = overlays.sampleHeight(x, z);
    vsIndex.push(Math.abs(y - g));
    const ray = viewer.sampleGroundHeight(x, z);
    if (ray === null) rayNull.push([x, z]);
    else {
      const signed = y - ray;
      const d = Math.abs(signed);
      vsRay.push(d);
      if (signed > 0.1) above++;
      else if (signed < -0.1) below++;
      if (d > 0.1) worst.push({ x: +x.toFixed(2), z: +z.toFixed(2), laneY: +y.toFixed(3), rayY: +ray.toFixed(3), delta: +signed.toFixed(3) });
    }
  }
  const stat = (a) => {
    if (a.length === 0) return null;
    const s = [...a].sort((p, q) => p - q);
    const at = (f) => s[Math.min(s.length - 1, Math.floor(s.length * f))];
    return {
      n: s.length,
      min: +s[0].toFixed(4),
      p50: +at(0.5).toFixed(4),
      p90: +at(0.9).toFixed(4),
      p95: +at(0.95).toFixed(4),
      max: +s[s.length - 1].toFixed(4),
      over10cm: s.filter((d) => d > 0.1).length,
    };
  };
  // Spike sweep over EVERY vertex, spatially: compare each vertex to the median
  // ground height on a 1.5 m circle around it. Deliberately not a comparison
  // against neighbouring vertices in buffer order — lanes are emitted one after
  // another, so a vertex at a lane boundary has "neighbours" 200 m away and
  // every lane boundary fakes a spike.
  const spikes = [];
  const ring = [];
  for (let a = 0; a < 8; a++) ring.push([Math.cos((a * Math.PI) / 4) * 1.5, Math.sin((a * Math.PI) / 4) * 1.5]);
  const lifts = [];
  for (let i = 0; i < total; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const around = [];
    for (const [dx, dz] of ring) {
      const s = overlays.sampleHeight(x + dx, z + dz);
      if (s !== null) around.push(s);
    }
    if (around.length < 4) continue;
    around.sort((a, b) => a - b);
    const lift = y - around[around.length >> 1];
    lifts.push(Math.abs(lift));
    if (Math.abs(lift) > 0.5) {
      spikes.push({ x: +x.toFixed(1), z: +z.toFixed(1), y: +y.toFixed(2), localMedian: +around[around.length >> 1].toFixed(2), lift: +lift.toFixed(2) });
    }
  }
  lifts.sort((a, b) => a - b);
  const liftAt = (f) => +(lifts[Math.min(lifts.length - 1, Math.floor(lifts.length * f))] ?? 0).toFixed(3);

  return {
    laneVertices: total,
    sampled: Math.ceil(total / step),
    vsGroundIndex: stat(vsIndex),
    vsSampleGroundHeight: stat(vsRay),
    /** `above` must be 0 — a lane drawn on top of a roof. `below` is canopies. */
    versusTopmost: { above, below, flush: vsRay.length - above - below },
    rayNullCount: rayNull.length,
    worst: worst.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 8),
    // "Local relief": how far each lane vertex sits from the ground 1.5 m away.
    // Small values are the road's own crown and grade, not error.
    localRelief: { p50: liftAt(0.5), p95: liftAt(0.95), p99: liftAt(0.99), max: +(lifts[lifts.length - 1] ?? 0).toFixed(2) },
    spikes: {
      count: spikes.length,
      pctOfVertices: +((spikes.length / total) * 100).toFixed(4),
      overTwoMetres: spikes.filter((s) => Math.abs(s.lift) > 2).length,
      worst: spikes.sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift)).slice(0, 8),
    },
  };
}, alignSamples);
console.log(JSON.stringify(alignment, null, 2));

// -------------------------------------------------- 2. signal head heights
console.log('> measuring signal head heights');
const signalHeights = await page.evaluate(() => {
  const viewer = window.__viewer;
  const overlays = window.__overlays;
  const heads = overlays.signals.getObjectByName('signal-heads');
  const byCategory = {};
  const suspicious = [];
  const lights = [];
  for (const obj of heads.children) {
    const signal = obj.userData.signal;
    if (!signal) continue;
    const category = signal.category;
    if (obj.isLineLoop) {
      // Crosswalks: outline draped on the road, no pole.
      const p = obj.geometry.attributes.position;
      let sum = 0;
      for (let i = 0; i < p.count; i++) {
        const g = overlays.sampleHeight(p.getX(i), p.getZ(i));
        sum += p.getY(i) - g;
      }
      (byCategory.crosswalk ??= []).push(sum / p.count);
      continue;
    }
    const ground = overlays.sampleHeight(obj.position.x, obj.position.z);
    const above = obj.position.y - ground;
    (byCategory[category] ??= []).push(above);
    if (category === 'traffic_light') {
      lights.push({ x: obj.position.x, z: obj.position.z, above });
    }
    if (above < 0 || above > 12) {
      suspicious.push({ id: signal.id, category, above: +above.toFixed(2) });
    }
  }
  const summarise = (a) => {
    const s = [...a].sort((p, q) => p - q);
    return {
      n: s.length,
      min: +s[0].toFixed(3),
      p50: +s[Math.floor(s.length / 2)].toFixed(3),
      max: +s[s.length - 1].toFixed(3),
    };
  };
  const out = {};
  for (const [k, v] of Object.entries(byCategory)) out[k] = summarise(v);

  // Densest traffic-light cluster = the busiest signalised intersection.
  let best = null;
  for (const a of lights) {
    const near = lights.filter((b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2 < 45 ** 2);
    if (!best || near.length > best.near.length) best = { near };
  }
  const cluster = best ? best.near : [];
  const cx = cluster.reduce((s, p) => s + p.x, 0) / Math.max(1, cluster.length);
  const cz = cluster.reduce((s, p) => s + p.z, 0) / Math.max(1, cluster.length);
  return {
    aboveGroundByCategory: out,
    suspicious,
    intersection: { x: +cx.toFixed(1), z: +cz.toFixed(1), lights: cluster.length, groundY: viewer.sampleGroundHeight(cx, cz) },
  };
});
console.log(JSON.stringify(signalHeights, null, 2));

const isec = signalHeights.intersection;
const groundY = isec.groundY ?? 8;

// -------------------------------------------------------- 3. screenshots
console.log('> screenshots');
const shots = {};

// (a) street level at the intersection, signals ON, lanes ON.
await setLayers(true, true);
await setView([isec.x - 45, groundY + 1.7, isec.z + 32], [isec.x + 15, groundY + 4.5, isec.z - 20]);
await streamIdle();
await page.waitForTimeout(2500);
shots.streetSignals = await shot('01-street-signals-on');

// (b) same pose, signals OFF — the A/B for "are those markers real".
await setLayers(true, false);
await page.waitForTimeout(600);
shots.streetSignalsOff = await shot('02-street-signals-off');

// (c) street level, lanes ON — drape check at grazing angle.
await setLayers(true, false);
await setView([isec.x - 90, groundY + 1.8, isec.z + 55], [isec.x + 60, groundY + 2.6, isec.z - 40]);
await streamIdle();
await page.waitForTimeout(2500);
shots.streetLanes = await shot('03-street-lanes-on');

// (d) same pose, lanes OFF.
await setLayers(false, false);
await page.waitForTimeout(600);
shots.streetLanesOff = await shot('04-street-lanes-off');

// (e) nadir over the intersection, lanes ON.
await setLayers(true, false);
await setView([isec.x, groundY + 130, isec.z], [isec.x, groundY, isec.z + 0.01]);
await streamIdle();
await page.waitForTimeout(2500);
shots.nadirLanes = await shot('05-nadir-lanes-on');

// (f) z-fighting probe. The HUD repaints its counters every 250 ms, so it has
// to go before repeat captures can mean anything. Lanes-off is the control: if
// the frame is unstable either way, the overlay is not the cause.
const setHudVisible = (visible) =>
  page.evaluate((v) => {
    const hud = document.querySelector('[data-testid="hud"]');
    if (hud) hud.style.visibility = v ? 'visible' : 'hidden';
  }, visible);

/**
 * Repeat-capture a static pose and report whether the pixels are identical.
 *
 * A late tile landing also changes pixels, so each capture is tagged with a
 * scene signature (resident assets / draw calls / triangles) and only captures
 * that share a signature are compared. Same scene + different pixels = shimmer.
 * Different scene = inconclusive, and we retry rather than cry wolf.
 */
const stability = async (label, lanes, attempts = 6) => {
  await setLayers(lanes, false);
  await setHudVisible(false);
  await streamIdle();
  const seen = new Map();
  let verdict = { stable: null, note: 'never saw two captures of the same scene' };
  for (let i = 0; i < attempts; i++) {
    await page.waitForTimeout(700);
    const sig = await page.evaluate(() => {
      const s = window.__viewer.getStats();
      return `${s.residentAssets}/${s.drawCalls}/${s.triangles}`;
    });
    const buf = await page.screenshot();
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const prior = seen.get(sig);
    if (prior) {
      verdict = prior === hash
        ? { stable: true, note: `identical across two captures of scene ${sig}` }
        : { stable: false, note: `scene ${sig} rendered differently: ${prior} vs ${hash}` };
      if (verdict.stable) break; // a confirmed match is enough
    } else {
      seen.set(sig, hash);
    }
  }
  await setHudVisible(true);
  const tag = verdict.stable === null ? 'INCONCLUSIVE' : verdict.stable ? 'STABLE' : 'FLICKER';
  console.log(`  ${label}: ${tag} — ${verdict.note}`);
  return { ...verdict, tag };
};

const stab = {};
stab.nadirLanesOn = await stability('nadir lanes-on', true);
stab.nadirLanesOff = await stability('nadir lanes-off (control)', false);

// (g) high nadir over the whole map, lanes ON — far-field shimmer check, where
// depth precision is worst and a 4 cm drape offset has the least headroom.
await setLayers(true, false);
await setView([700, groundY + 620, -1730], [700, groundY, -1729.99]);
await streamIdle();
await page.waitForTimeout(2500);
shots.nadirWide = await shot('06-nadir-wide-lanes-on');
stab.wideLanesOn = await stability('wide-nadir lanes-on', true);
stab.wideLanesOff = await stability('wide-nadir lanes-off (control)', false);

// (h) default framing with default toggles, for the record.
await setLayers(defaults.lanes, defaults.signals);
await page.evaluate(() => {
  const viewer = window.__viewer;
  const V = viewer.camera.position.constructor;
  viewer.controls.setView(new V(480, 250, -1416), new V(709, 16, -1737));
});
await streamIdle();
await page.waitForTimeout(2500);
shots.defaults = await shot('07-defaults');

// ------------------------------------------------ 4. draw-call attribution
console.log('> draw-call attribution');
const drawCalls = {};
for (const [name, lanes, signals] of [
  ['off/off', false, false],
  ['lanes', true, false],
  ['signals', false, true],
  ['both', true, true],
]) {
  await setLayers(lanes, signals);
  await page.waitForTimeout(500);
  drawCalls[name] = await page.evaluate(() => window.__viewer.getStats().drawCalls);
}
console.log(`  ${JSON.stringify(drawCalls)}`);

// ------------------------------------------------------------ 5. benchmark
// Frame timings are only meaningful on an idle machine. Record the load so a
// contended run labels itself instead of quietly producing a bogus regression.
const loadBefore = os.loadavg()[0];
if (loadBefore > os.cpus().length * 0.6) {
  console.log(`  ! 1-min load average is ${loadBefore.toFixed(1)} on ${os.cpus().length} cores — bench numbers will be noisy`);
}
// Interleaved and repeated: back-to-back bench runs differ by a few percent on
// their own (the fly-through restreams tiles), so a single A/B pair cannot tell
// a real overlay cost from noise.
const benchRuns = { off: [], defaults: [], both: [] };
const configs = {
  off: [false, false],
  defaults: [defaults.lanes, defaults.signals],
  both: [true, true],
};
const configNames = Object.keys(configs);
for (let round = 0; round < configNames.length; round++) {
  // Rotate, do not reverse. Position in the sequence carries a real penalty
  // (the fly-through leaves the streamer in a different state each time), and
  // reversing a 3-config list pins the middle one to the middle slot every
  // round — which is exactly how the lane overlay first appeared to cost 5 fps
  // it does not cost. Rotating gives every config every slot once.
  const order = configNames.map((_, i) => configNames[(i + round) % configNames.length]);
  for (const name of order) {
    const [lanes, signals] = configs[name];
    await setLayers(lanes, signals);
    await page.waitForTimeout(500);
    const result = await page.evaluate((ms) => window.__bench(ms), benchMs);
    benchRuns[name].push(result);
    console.log(`> bench ${name} #${round + 1}: ${result.avgFps.toFixed(1)} fps, p95 ${result.p95FrameMs.toFixed(1)} ms, ${result.drawCalls} draws`);
  }
}
const summarise = (runs) => ({
  runs: runs.length,
  avgFps: +(runs.reduce((s, r) => s + r.avgFps, 0) / runs.length).toFixed(1),
  p95FrameMs: +(runs.reduce((s, r) => s + r.p95FrameMs, 0) / runs.length).toFixed(2),
  minFps: +Math.min(...runs.map((r) => r.minFps)).toFixed(1),
  drawCalls: Math.round(runs.reduce((s, r) => s + r.drawCalls, 0) / runs.length),
  residentBytes: Math.round(runs.reduce((s, r) => s + r.residentBytes, 0) / runs.length),
  spread: +(Math.max(...runs.map((r) => r.avgFps)) - Math.min(...runs.map((r) => r.avgFps))).toFixed(1),
});
const benchOff = summarise(benchRuns.off);
const benchDefault = summarise(benchRuns.defaults);
const benchBoth = summarise(benchRuns.both);

await setLayers(defaults.lanes, defaults.signals);
const finalStats = await page.evaluate(() => window.__viewer.getStats());

const report = {
  url,
  machine: { cores: os.cpus().length, loadBeforeBench: +loadBefore.toFixed(2), loadAfterBench: +os.loadavg()[0].toFixed(2) },
  overlayReadyMs,
  overlayStats,
  defaults,
  alignment,
  signalHeights,
  shots,
  stability: stab,
  drawCalls,
  bench: { off: benchOff, defaults: benchDefault, both: benchBoth, raw: benchRuns },
  finalStats,
  consoleErrors,
  consoleWarnings: consoleWarnings.slice(0, 20),
};
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

console.log('\n--- summary ---');
console.log(`lane drape vs ground index : ${JSON.stringify(alignment.vsGroundIndex)}`);
console.log(`lane drape vs raycast      : ${JSON.stringify(alignment.vsSampleGroundHeight)}`);
console.log(`lane vs topmost surface    : ${JSON.stringify(alignment.versusTopmost)}  (above MUST be 0)`);
console.log(`lane local relief          : ${JSON.stringify(alignment.localRelief)}`);
console.log(`lane spikes (>0.5 m)       : ${alignment.spikes.count} / ${alignment.laneVertices} (${alignment.spikes.pctOfVertices}%), >2 m: ${alignment.spikes.overTwoMetres}`);
console.log(`stability                  : ${Object.entries(stab).map(([k, s]) => `${k}=${s.tag}`).join(' ')}`);
console.log(`draw calls                 : ${JSON.stringify(drawCalls)}`);
console.log(`bench off                  : ${JSON.stringify(benchOff)}`);
console.log(`bench defaults             : ${JSON.stringify(benchDefault)}`);
console.log(`bench both                 : ${JSON.stringify(benchBoth)}`);
console.log(`console errors: ${consoleErrors.length}`);
for (const err of consoleErrors.slice(0, 20)) console.log(`  ${err}`);
console.log(`console warnings: ${consoleWarnings.length}`);
for (const warn of consoleWarnings.slice(0, 5)) console.log(`  ${warn}`);

await context.close();
await browser.close();
process.exit(consoleErrors.length === 0 ? 0 : 1);
