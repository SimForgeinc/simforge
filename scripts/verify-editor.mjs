#!/usr/bin/env node
/**
 * Real-GPU verification for the scenario editor.
 *
 * Same rules as `verify-city-renderer.mjs` and `verify-map-overlays.mjs`: system
 * Chrome against a running `pnpm dev`, headed (headless SwiftShader lies about
 * performance), fails on any console error.
 *
 * What it proves, in order:
 *
 *  1. **Speed.** 10 vehicles + 5 pedestrians placed through real pointer events,
 *     timed twice: flat out (the mechanical floor) and at a human pace with
 *     multi-step cursor travel and think-time between placements.
 *  2. **Placement is physically right.** Every placed vehicle is compared
 *     against the ground index (sits on the road, not in it) and against the
 *     lane direction the topology index reports at its own `s` (heading within
 *     2 degrees).
 *  3. **Persistence.** Reload the page and diff the restored actor list against
 *     the pre-reload one, field by field — positions must be bit-identical, not
 *     merely close.
 *  4. **Multi-map.** All five maps open, placement works on each, and two
 *     round-trip switches return `renderer.info` geometry/texture counts to
 *     their baseline (the leak check).
 *  5. **Frame budget.** Street-level fps with 30 actors resident, measured
 *     against the same pose with the actor layer hidden, plus a full
 *     `runBenchmark` fly-through both ways.
 *
 * Between 1 and 2 it also drives the whole keyboard model — `G`, `R` (with and
 * without the ⇧ 15° snap), `Tab`, `⌥`, `Esc`, `⌘D`, `⌘Z`/`⇧⌘Z`, `⌫` — through
 * real key events, with before/after screenshots for the four gestures that
 * change geometry.
 *
 *   node scripts/verify-editor.mjs [--url http://localhost:5199] [--out /tmp/ss-editor]
 *                                  [--map yale-street]
 */
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i]?.replace(/^--/, ''), process.argv[i + 1]);
}
const url = args.get('url') ?? 'http://localhost:5199/';
const outDir = args.get('out') ?? '/tmp/ss-editor';
const benchMs = Number(args.get('bench') ?? 12000);
/**
 * Which map gates 1-3 and 5 run on.
 *
 * Pinned through `?map=`, not left to chance: `initialMapId` remembers the last
 * map in `localStorage`, so an un-pinned run would open wherever the *previous*
 * run happened to finish and the numbers would not be comparable.
 */
const mapId = args.get('map') ?? 'yale-street';
const pageUrl = (() => {
  const u = new URL(url);
  u.searchParams.set('map', mapId);
  return u.toString();
})();

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: [
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--window-size=1680,1050',
    // The leak check compares JS heap across map switches; without a forced
    // collection the number is dominated by whatever GC has not run yet.
    '--js-flags=--expose-gc',
  ],
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
  await page.screenshot({ path: file });
  console.log(`  screenshot -> ${file}`);
  return file;
};

const streamIdle = (timeout = 60000) =>
  page
    .waitForFunction(
      () => {
        const s = window.__viewer?.getStats();
        return s ? s.loading === 0 && s.queued === 0 && s.uploading === 0 && s.residentTiles > 0 : false;
      },
      null,
      { timeout },
    )
    .catch(() => console.log('  (still streaming)'));

const editorReady = (timeout = 240000) =>
  page.waitForFunction(() => Boolean(window.__editor) && Boolean(window.__overlays), null, { timeout });

/** World point -> client pixel. */
const project = (p) =>
  page.evaluate(([x, y, z]) => {
    const viewer = window.__viewer;
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    const V = viewer.camera.position.constructor;
    const ndc = new V(x, y, z).project(viewer.camera);
    return {
      x: rect.left + (ndc.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-ndc.y * 0.5 + 0.5) * rect.height,
      onScreen: Math.abs(ndc.x) < 0.98 && Math.abs(ndc.y) < 0.98 && ndc.z < 1,
    };
  }, [p.x, p.y, p.z]);

/** The panels the harness reads, in one object. */
const editorState = () =>
  page.evaluate(() => {
    const s = window.__editor.state;
    return {
      mode: s.mode,
      placing: s.placing,
      snapped: s.snapped,
      flipped: s.flipped,
      valid: s.valid,
      laneLabel: s.laneLabel,
      rotationDeg: s.rotationDeg === null ? null : +s.rotationDeg.toFixed(3),
      selection: [...s.selection],
      actors: s.actors.length,
      hint: s.hint,
    };
  });

const actorOf = (id) =>
  page.evaluate(
    (wanted) => {
      const a = window.__editor.state.actors.find((x) => x.id === wanted);
      return a ? JSON.parse(JSON.stringify(a)) : null;
    },
    id,
  );

/** Keyboard shortcuts are ignored while an inspector field has focus — by design. */
const blurUi = () => page.evaluate(() => document.activeElement?.blur?.());

/**
 * Put the real cursor over a world point.
 *
 * Returns `null` when the point is off screen *or* behind a panel: the left and
 * right rails float over the canvas, and a press there is a UI click, not a map
 * click, so a gesture driven at such a point would silently do nothing.
 */
const hover = async (point, steps = 6) => {
  const screen = await project(point);
  if (!screen.onScreen) return null;
  const onCanvas = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y) === window.__viewer.renderer.domElement,
    [screen.x, screen.y],
  );
  if (!onCanvas) return null;
  await page.mouse.move(screen.x, screen.y, { steps });
  await page.waitForTimeout(80);
  return screen;
};

/**
 * Arm a catalog entry.
 *
 * The palette is a toggle — clicking the entry that is already armed disarms it
 * — so a harness that just clicks can end up in `idle` and place nothing.
 */
const armPalette = async (catalogId) => {
  await page.click(`[data-testid="palette-${catalogId}"]`);
  // Wait for the snapshot rather than re-clicking on the first miss. The
  // controller coalesces notifications to one animation frame, and right after a
  // map switch a frame can take >100 ms, so `state` still reads `idle` when
  // `click` resolves — and a second click on a *toggle* disarms what the first
  // one armed. That race silently placed nothing on one map per run.
  const armed = await page
    .waitForFunction(
      (id) => window.__editor?.state.mode === 'placing' && window.__editor.state.placing === id,
      catalogId,
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!armed) {
    await page.click(`[data-testid="palette-${catalogId}"]`);
    await page.waitForTimeout(400);
  }
  return editorState();
};

/** Confirm a modal gesture / drop a ghost where the cursor already is. */
const clickHere = async () => {
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(180);
};

const deg = (rad) => (rad * 180) / Math.PI;
const wrapDeg = (d) => {
  let out = d % 360;
  if (out > 180) out -= 360;
  if (out <= -180) out += 360;
  return out;
};

const rendererInfo = async () => {
  // Three collections: the first frees the disposed viewer, the second its
  // now-unreachable typed arrays, the third settles the tail.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => globalThis.gc?.());
    await page.waitForTimeout(250);
  }
  return page.evaluate(() => {
    const info = window.__viewer.renderer.info;
    const stats = window.__viewer.getStats();
    return {
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      residentTiles: stats.residentTiles,
      residentMB: Math.round(stats.residentBytes / 1048576),
      // One live GL context means the old viewers really are gone.
      canvases: document.querySelectorAll('canvas').length,
      heapMB: stats.jsHeapMB === null ? null : Math.round(stats.jsHeapMB),
    };
  });
};

/** Clear every autosave so a run starts from a known-empty scenario set. */
const clearScenarios = () =>
  page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('simforge:scenario:')) localStorage.removeItem(key);
    }
  });

/**
 * The busiest signalised intersection on the current map, or the middle of the
 * longest driving lane when the map has no signals worth clustering.
 */
const findStage = () =>
  page.evaluate(() => {
    const byId = window.__overlays.signals.userData.byId ?? {};
    const lights = Object.values(byId).filter((p) => p.category === 'traffic_light');
    if (lights.length >= 3) {
      let best = null;
      for (const a of lights) {
        const near = lights.filter(
          (b) => (a.position[0] - b.position[0]) ** 2 + (a.position[2] - b.position[2]) ** 2 < 45 ** 2,
        );
        if (!best || near.length > best.length) best = near;
      }
      const x = best.reduce((s, p) => s + p.position[0], 0) / best.length;
      const z = best.reduce((s, p) => s + p.position[2], 0) / best.length;
      return { x, z, y: window.__overlays.sampleHeight(x, z), lights: best.length };
    }
    const lanes = [...window.__editor.laneIndex.all].sort((a, b) => b.length - a.length);
    const lane = lanes[0];
    const pose = window.__editor.laneIndex.poseAt(lane, lane.length / 2, 0);
    return { x: pose.x, z: pose.z, y: window.__overlays.sampleHeight(pose.x, pose.z), lights: 0 };
  });

const setView = (eye, target) =>
  page.evaluate((v) => {
    const viewer = window.__viewer;
    const V = viewer.camera.position.constructor;
    viewer.controls.setView(new V(v[0], v[1], v[2]), new V(v[3], v[4], v[5]));
  }, [...eye, ...target]);

/**
 * Points along the drivable network around `stage`, spaced so that consecutive
 * placements do not overlap — i.e. the way a user fills a street.
 */
const placementPoints = (stage, count, spacing, lateral = 0, radius = 55, clearance = 4) =>
  page.evaluate(
    ([sx, sz, n, gap, t, r, clear]) => {
      const index = window.__editor.laneIndex;
      // Anything already placed is an obstacle: the editor refuses overlapping
      // placements (by design), so a harness that ignores them under-counts.
      const placedActors = window.__editor.state.actors;
      // Walk every nearby centreline at 2 m resolution, keep the candidates
      // closest to the stage that are at least `gap` apart. Sorting by
      // distance (not by lane length) is what keeps every point inside the
      // camera's framing.
      const candidates = [];
      for (const lane of index.all) {
        for (let s = 0; s <= lane.length; s += 2) {
          const pose = index.poseAt(lane, s, t);
          const d = Math.hypot(pose.x - sx, pose.z - sz);
          if (d > r) continue;
          candidates.push({ x: pose.x, z: pose.z, d, rsl: lane.rsl, s });
        }
      }
      candidates.sort((a, b) => a.d - b.d);
      const out = [];
      for (const candidate of candidates) {
        if (out.length >= n) break;
        if (out.some((o) => Math.hypot(o.x - candidate.x, o.z - candidate.z) < gap)) continue;
        if (placedActors.some((a) => Math.hypot(a.x - candidate.x, a.z - candidate.z) < clear)) continue;
        out.push({ ...candidate, y: window.__overlays.sampleHeight(candidate.x, candidate.z) });
      }
      return out;
    },
    [stage.x, stage.z, count, spacing, lateral, radius, clearance],
  );

/**
 * Place `points.length` actors of one catalog id through real pointer events.
 *
 * @param pace `'fast'` clicks as soon as the ghost has tracked; `'human'` moves
 *   the cursor in steps and pauses between placements.
 */
async function placeAll(catalogId, points, pace) {
  await blurUi();
  const armed = await armPalette(catalogId);
  const before = armed.actors;
  const started = Date.now();
  let clicked = 0;
  let offScreen = 0;
  for (const point of points) {
    const screen = await project(point);
    if (!screen.onScreen) {
      offScreen++;
      continue;
    }
    if (pace === 'human') {
      await page.mouse.move(screen.x, screen.y, { steps: 8 });
      await page.waitForTimeout(260);
    } else {
      await page.mouse.move(screen.x, screen.y);
      await page.waitForTimeout(24);
    }
    await page.mouse.down();
    await page.mouse.up();
    clicked++;
    if (pace === 'human') await page.waitForTimeout(420);
  }
  const ms = Date.now() - started;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const added = (await editorState()).actors - before;
  const result = { ms, placed: clicked, added, offScreen };
  // A click that placed nothing is the interesting case; replay those points
  // slowly and record what the ghost said, outside the timed section.
  if (added < clicked) result.refusals = await diagnosePlacement(catalogId, points);
  return result;
}

/** Why did a click not place? One slow pass, reporting the ghost's own verdict. */
async function diagnosePlacement(catalogId, points) {
  const rows = [];
  await blurUi();
  await armPalette(catalogId);
  for (const point of points.slice(0, 6)) {
    const screen = await project(point);
    if (!screen.onScreen) {
      rows.push({ point: [+point.x.toFixed(1), +point.z.toFixed(1)], why: 'off screen', ndcZ: null });
      continue;
    }
    const over = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.tagName ?? null,
      [screen.x, screen.y],
    );
    await page.mouse.move(screen.x, screen.y, { steps: 6 });
    await page.waitForTimeout(200);
    const ghost = await editorState();
    rows.push({
      point: [+point.x.toFixed(1), +point.z.toFixed(1)],
      screen: [Math.round(screen.x), Math.round(screen.y)],
      over,
      mode: ghost.mode,
      placing: ghost.placing,
      snapped: ghost.snapped,
      valid: ghost.valid,
      lane: ghost.laneLabel,
    });
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  return rows;
}

/** Measure fps by sampling the viewer's own rolling average at a fixed pose. */
const sampleFps = async (seconds = 5) => {
  await page.waitForTimeout(700); // let the average shake off the camera move
  const samples = [];
  for (let i = 0; i < seconds * 4; i++) {
    await page.waitForTimeout(250);
    samples.push(await page.evaluate(() => {
      const s = window.__viewer.getStats();
      return [s.fps, s.frameMsP95, s.drawCalls, s.triangles];
    }));
  }
  const col = (i) => samples.map((s) => s[i]).sort((a, b) => a - b);
  const fps = col(0);
  return {
    fpsMin: +fps[0].toFixed(1),
    fpsMedian: +fps[fps.length >> 1].toFixed(1),
    p95FrameMs: +col(1)[Math.floor(samples.length * 0.9)].toFixed(2),
    drawCalls: col(2)[samples.length >> 1],
    triangles: col(3)[samples.length >> 1],
  };
};

const report = { url, machine: { cores: os.cpus().length, load: os.loadavg()[0] } };

// ------------------------------------------------------------------ 0. load
console.log(`> opening ${pageUrl}`);
await page.goto(pageUrl, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__viewer), null, { timeout: 30000 });
await clearScenarios();
await page.reload({ waitUntil: 'load' });
const bootStart = Date.now();
await editorReady();
report.bootMs = Date.now() - bootStart;
report.overlays = await page.evaluate(() => window.__overlays.stats);
report.laneIndex = await page.evaluate(() => {
  const s = window.__editor.laneIndex.stats;
  return { lanes: s.lanes, totalLanes: s.totalLanes, segments: s.segments, buildMs: +s.buildMs.toFixed(1), fetchMs: +s.fetchMs.toFixed(0), bytes: s.bytes };
});
console.log(`> editor armed in ${report.bootMs} ms: ${JSON.stringify(report.laneIndex)}`);
console.log(`> signal layer draw calls: ${report.overlays.signalDrawCalls}`);

const stage = await findStage();
console.log(`> stage ${JSON.stringify(stage)}`);
await setView([stage.x - 34, stage.y + 22, stage.z + 34], [stage.x, stage.y, stage.z]);
await streamIdle();
await page.waitForTimeout(1500);
await shot('00-stage');

// --------------------------------------------------- 1. placement speed
console.log('> gate 1: place 10 vehicles + 5 pedestrians');
const vehiclePoints = await placementPoints(stage, 10, 14, 0);
// Computed after the vehicles land, so the clearance filter can see them.

const fast = { vehicles: await placeAll('vehicle.sedan', vehiclePoints, 'fast') };
const pedPoints = await placementPoints(stage, 5, 26, 7.5, 55, 4.5);
fast.pedestrians = await placeAll('pedestrian.adult_walking', pedPoints, 'fast');
fast.totalMs = fast.vehicles.ms + fast.pedestrians.ms;
fast.clicks = fast.vehicles.placed + fast.pedestrians.placed;
fast.count = await page.evaluate(() => window.__editor.state.actors.length);
console.log(`  scripted: ${fast.count} actors (${fast.clicks} clicks) in ${(fast.totalMs / 1000).toFixed(1)} s`);
await shot('01-placed-fast');

const afterFast = await page.evaluate(() => window.__editor.state.actors.map((a) => ({ ...a })));

// Human pace on a clean slate, same points.
await page.evaluate(() => {
  const ids = window.__editor.state.actors.map((a) => a.id);
  window.__editor.setSelection(ids);
  window.__editor.deleteSelection();
});
await page.waitForTimeout(300);
const human = { vehicles: await placeAll('vehicle.sedan', vehiclePoints, 'human') };
human.pedestrians = await placeAll('pedestrian.adult_walking', pedPoints, 'human');
human.totalMs = human.vehicles.ms + human.pedestrians.ms;
human.clicks = human.vehicles.placed + human.pedestrians.placed;
human.count = await page.evaluate(() => window.__editor.state.actors.length);
console.log(`  human-paced: ${human.count} actors (${human.clicks} clicks) in ${(human.totalMs / 1000).toFixed(1)} s`);
report.placement = { fast, human, samplePose: afterFast[0] ?? null };
await shot('02-placed-human');

// --------------------------------- 1b. props sidecar + editing gestures
console.log('> gate 1b: props sidecar, duplicate, undo/redo, delete');
const gestures = {};

// Props have no `EntityKind` in the v1 schema, so they ride in
// `extensions.propsV0`. They must behave like everything else on screen and
// survive a save.
const conePoints = await placementPoints(stage, 3, 6, 3.2, 40, 3);
gestures.conePlacement = { points: conePoints.length, ...(await placeAll('construction.traffic_cone', conePoints, 'fast')) };
await page.evaluate(() => window.__editor.doc.flush());
gestures.props = await page.evaluate(() => {
  const doc = window.__editor.doc.data;
  const stored = JSON.parse(
    localStorage.getItem(`simforge:scenario:autosave-${window.__mapId}`) ?? '{}',
  );
  return {
    inDocument: (doc.extensions?.propsV0 ?? []).length,
    inStorage: (stored.extensions?.propsV0 ?? []).length,
    // Props must not have leaked into `entities` as fake vehicles.
    entityCatalogIds: [...new Set(doc.entities.map((e) => e.model.catalogId))].sort(),
    actors: window.__editor.state.actors.filter((a) => a.kind === 'prop').length,
  };
});
console.log(`  cones ${JSON.stringify(gestures.conePlacement)}`);
console.log(`  props ${JSON.stringify(gestures.props)}`);

// Duplicate / undo / redo / delete, through the real key bindings.
const pickVehicle = () =>
  page.evaluate(() => {
    const actor = window.__editor.state.actors.find((a) => a.kind === 'vehicle');
    window.__editor.setSelection([actor.id]);
    return actor;
  });
const count = () => page.evaluate(() => window.__editor.state.actors.length);
const original = await pickVehicle();
const beforeDuplicate = await count();
await page.keyboard.press('Meta+d');
await page.waitForTimeout(200);
const afterDuplicate = await count();
const copy = await page.evaluate(() => {
  const id = window.__editor.state.selection[0];
  return window.__editor.state.actors.find((a) => a.id === id);
});
await page.keyboard.press('Meta+z');
await page.waitForTimeout(200);
const afterUndo = await count();
await page.keyboard.press('Meta+Shift+z');
await page.waitForTimeout(200);
const afterRedo = await count();
// Undo dropped the copy, so it dropped the selection with it; redo brings the
// actor back but not the selection. Delete needs one, so pick again.
await pickVehicle();
await page.keyboard.press('Delete');
await page.waitForTimeout(200);
const afterDelete = await count();
gestures.history = {
  beforeDuplicate,
  afterDuplicate,
  afterUndo,
  afterRedo,
  afterDelete,
  // The copy lands one body-length upstream, in the same lane.
  duplicateGapM:
    copy && original ? +Math.hypot(copy.x - original.x, copy.z - original.z).toFixed(3) : null,
  duplicateSameLane: copy?.laneRef?.laneId === original?.laneRef?.laneId,
  bodyLengthM: original?.dims?.l ?? null,
};
console.log(`  gestures ${JSON.stringify(gestures.history)}`);

// Inspector two-way sync, driven through the real DOM inputs.
const anchored = await page.evaluate(() => {
  const actor = window.__editor.state.actors.find((a) => a.laneRef);
  window.__editor.setSelection([actor.id]);
  return actor;
});
await page.waitForTimeout(150);
const sField = page.locator('[data-testid="inspector-s"]');
await sField.fill(String(+(anchored.laneRef.s + 6).toFixed(3)));
await sField.press('Enter');
await page.waitForTimeout(250);
const afterS = await page.evaluate((id) => window.__editor.state.actors.find((a) => a.id === id), anchored.id);
const xField = page.locator('[data-testid="inspector-x"]');
await xField.fill(String(+(afterS.x + 1.2).toFixed(3)));
await xField.press('Enter');
await page.waitForTimeout(250);
const afterX = await page.evaluate((id) => window.__editor.state.actors.find((a) => a.id === id), anchored.id);
gestures.inspector = {
  // Editing s must move the actor along its lane by that much.
  sDelta: +(afterS.laneRef.s - anchored.laneRef.s).toFixed(3),
  movedM: +Math.hypot(afterS.x - anchored.x, afterS.z - anchored.z).toFixed(3),
  // Editing x must re-derive the anchor rather than leave a stale one.
  xApplied: +(afterX.x - afterS.x).toFixed(3),
  anchorFollowed: afterX.laneRef ? +(afterX.laneRef.s - afterS.laneRef.s).toFixed(3) : null,
  stillAnchored: Boolean(afterX.laneRef),
};
console.log(`  inspector ${JSON.stringify(gestures.inspector)}`);
report.gestures = gestures;
await shot('01b-props-and-gestures');

// ------------------------------------------------------ 1c. keyboard model
console.log('> gate 1c: keyboard model — G, R, ⇧R, ⌘D, ⌫, Esc, ⌘Z, Tab, ⌥');
const keys = {};
await blurUi();

// --- G: move, sliding along the lane -------------------------------------
// Pick the anchored vehicle with the most lane left in front of it, so the
// slide has somewhere to go without falling off the end of a junction lane.
const slideActor = await page.evaluate(() => {
  const editor = window.__editor;
  let best = null;
  for (const a of editor.state.actors) {
    if (a.kind !== 'vehicle' || !a.laneRef) continue;
    const lane = editor.laneIndex.laneFor(a.laneRef.roadId, a.laneRef.section, a.laneRef.laneId);
    if (!lane) continue;
    const room = lane.forward ? lane.length - a.laneRef.s : a.laneRef.s;
    if (!best || room > best.room) best = { id: a.id, room: +room.toFixed(2), forward: lane.forward };
  }
  if (best) editor.setSelection([best.id]);
  return best;
});
const slideM = Math.max(3, Math.min(12, slideActor.room - 1));
const slideTo = await page.evaluate(
  ([id, d]) => {
    const editor = window.__editor;
    const a = editor.state.actors.find((x) => x.id === id);
    const lane = editor.laneIndex.laneFor(a.laneRef.roadId, a.laneRef.section, a.laneRef.laneId);
    const s = lane.forward ? a.laneRef.s + d : a.laneRef.s - d;
    const p = editor.laneIndex.poseAt(lane, s, a.laneRef.t);
    return { x: p.x, y: window.__overlays.sampleHeight(p.x, p.z), z: p.z, s: +s.toFixed(3) };
  },
  [slideActor.id, slideM],
);
const grabBefore = await actorOf(slideActor.id);
await shot('kb-01-grab-before');
await hover({ x: grabBefore.x, y: grabBefore.y, z: grabBefore.z });
await page.keyboard.press('g');
await page.waitForTimeout(140);
const grabArmed = await editorState();
const grabReached = await hover(slideTo);
await page.waitForTimeout(200);
await shot('kb-02-grab-dragging');
await clickHere();
const grabAfter = await actorOf(slideActor.id);
await shot('kb-03-grab-after');
keys.grab = {
  mode: grabArmed.mode,
  hint: grabArmed.hint,
  cursorReachedTarget: grabReached !== null,
  requestedM: +slideM.toFixed(2),
  movedM: +Math.hypot(grabAfter.x - grabBefore.x, grabAfter.z - grabBefore.z).toFixed(3),
  sBefore: +grabBefore.laneRef.s.toFixed(3),
  sAfter: grabAfter.laneRef ? +grabAfter.laneRef.s.toFixed(3) : null,
  stillAnchored: Boolean(grabAfter.laneRef),
  sameLane: grabAfter.laneRef?.laneId === grabBefore.laneRef.laneId,
  tHeldM: grabAfter.laneRef ? +(grabAfter.laneRef.t - grabBefore.laneRef.t).toFixed(4) : null,
  // The whole point of "slide along the lane": the actor must stay on the
  // centreline it was anchored to, however the cursor wandered.
  offCentreM: await page.evaluate((id) => {
    const editor = window.__editor;
    const a = editor.state.actors.find((x) => x.id === id);
    if (!a?.laneRef) return null;
    const lane = editor.laneIndex.laneFor(a.laneRef.roadId, a.laneRef.section, a.laneRef.laneId);
    const p = editor.laneIndex.poseAt(lane, a.laneRef.s, a.laneRef.t);
    return +Math.hypot(a.x - p.x, a.z - p.z).toFixed(5);
  }, slideActor.id),
};
console.log(`  G  ${JSON.stringify(keys.grab)}`);

// --- Esc cancels a move without writing to the document -------------------
await blurUi();
await page.evaluate((id) => window.__editor.setSelection([id]), slideActor.id);
const escPoseBefore = await actorOf(slideActor.id);
await hover({ x: escPoseBefore.x, y: escPoseBefore.y, z: escPoseBefore.z });
await page.keyboard.press('g');
await page.waitForTimeout(120);
await hover({ x: escPoseBefore.x + 6, y: escPoseBefore.y, z: escPoseBefore.z + 6 });
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const escPoseAfter = await actorOf(slideActor.id);
const escState = await editorState();
keys.escapeCancelsGrab = {
  mode: escState.mode,
  poseUnchanged:
    escPoseAfter.x === escPoseBefore.x &&
    escPoseAfter.z === escPoseBefore.z &&
    escPoseAfter.headingRad === escPoseBefore.headingRad,
};
console.log(`  Esc(grab) ${JSON.stringify(keys.escapeCancelsGrab)}`);

// --- R, and ⇧R's 15° snap -------------------------------------------------
await blurUi();
await page.evaluate((id) => window.__editor.setSelection([id]), slideActor.id);
const rotBefore = await actorOf(slideActor.id);
await shot('kb-04-rotate-before');
// Cursor on a 10 m arm, due east of the actor, then swung to +47°. With ⇧ held
// the readout must land exactly on 45°, not on 47°.
const ARM_M = 10;
const armPoint = (angleDeg) => ({
  x: rotBefore.x + ARM_M * Math.cos((angleDeg * Math.PI) / 180),
  y: rotBefore.y,
  z: rotBefore.z - ARM_M * Math.sin((angleDeg * Math.PI) / 180),
});
await hover(armPoint(0));
await page.keyboard.press('r');
await page.waitForTimeout(140);
const rotArmed = await editorState();
await page.keyboard.down('Shift');
await hover(armPoint(47));
await page.waitForTimeout(200);
const snappedDeg = (await editorState()).rotationDeg;
await shot('kb-05-rotate-shift-snap');
await page.keyboard.up('Shift');
await page.waitForTimeout(200);
const freeDeg = (await editorState()).rotationDeg;
await page.keyboard.down('Shift');
await page.waitForTimeout(200);
const snappedAgainDeg = (await editorState()).rotationDeg;
await clickHere();
await page.keyboard.up('Shift');
const rotAfter = await actorOf(slideActor.id);
await shot('kb-06-rotate-after');
keys.rotate = {
  mode: rotArmed.mode,
  hint: rotArmed.hint,
  freeDeg,
  snappedDeg,
  snappedAgainDeg,
  isMultipleOf15: snappedDeg === null ? null : Math.abs(snappedDeg / 15 - Math.round(snappedDeg / 15)) < 1e-6,
  appliedDeg: +wrapDeg(deg(rotAfter.headingRad - rotBefore.headingRad)).toFixed(3),
  // A deliberate skew is recorded on the anchor, not lost.
  offsetRecordedDeg: rotAfter.laneRef ? +deg(rotAfter.laneRef.headingOffsetRad).toFixed(3) : null,
  positionHeldM: +Math.hypot(rotAfter.x - rotBefore.x, rotAfter.z - rotBefore.z).toFixed(5),
};
console.log(`  R  ${JSON.stringify(keys.rotate)}`);

// Put it back so the accuracy gate is not measuring a deliberately skewed car
// twice; the skew itself is already recorded above.
await page.keyboard.press('Meta+z');
await page.waitForTimeout(200);
keys.rotate.undoRestoredHeading =
  +wrapDeg(deg((await actorOf(slideActor.id)).headingRad - rotBefore.headingRad)).toFixed(4);

// --- ⌘D: duplicate one body-length *behind*, along the lane ---------------
await blurUi();
const dupSource = await page.evaluate(() => {
  const editor = window.__editor;
  let best = null;
  for (const a of editor.state.actors) {
    if (a.kind !== 'vehicle' || !a.laneRef) continue;
    const lane = editor.laneIndex.laneFor(a.laneRef.roadId, a.laneRef.section, a.laneRef.laneId);
    if (!lane) continue;
    // Room *behind* it, which is where the copy goes.
    const room = lane.forward ? a.laneRef.s : lane.length - a.laneRef.s;
    if (!best || room > best.room) best = { id: a.id, room: +room.toFixed(2) };
  }
  editor.setSelection([best.id]);
  return best;
});
const dupBefore = await actorOf(dupSource.id);
const countBeforeDup = (await editorState()).actors;
await shot('kb-07-duplicate-before');
await page.keyboard.press('Meta+d');
await page.waitForTimeout(250);
const dupCopy = await page.evaluate(() => {
  const id = window.__editor.state.selection[0];
  const a = window.__editor.state.actors.find((x) => x.id === id);
  return a ? JSON.parse(JSON.stringify(a)) : null;
});
await shot('kb-08-duplicate-after');
// Signed distance along the original's own heading: negative means behind.
const along =
  (dupCopy.x - dupBefore.x) * Math.cos(dupBefore.headingRad) +
  (dupCopy.z - dupBefore.z) * -Math.sin(dupBefore.headingRad);
const lateral =
  (dupCopy.x - dupBefore.x) * Math.sin(dupBefore.headingRad) +
  (dupCopy.z - dupBefore.z) * Math.cos(dupBefore.headingRad);
keys.duplicate = {
  added: (await editorState()).actors - countBeforeDup,
  alongHeadingM: +along.toFixed(3),
  lateralM: +lateral.toFixed(3),
  expectedGapM: +(dupBefore.dims.l + 1).toFixed(3),
  sameLane: dupCopy.laneRef?.laneId === dupBefore.laneRef.laneId &&
    dupCopy.laneRef?.roadId === dupBefore.laneRef.roadId,
  selectionMovedToCopy: dupCopy.id !== dupBefore.id,
  headingMatchesDeg: +wrapDeg(deg(dupCopy.headingRad - dupBefore.headingRad)).toFixed(3),
};
console.log(`  ⌘D ${JSON.stringify(keys.duplicate)}`);

// --- ⌘Z / ⇧⌘Z around that duplicate --------------------------------------
await page.keyboard.press('Meta+z');
await page.waitForTimeout(250);
const afterUndoKb = (await editorState()).actors;
await shot('kb-09-undo-after');
await page.keyboard.press('Meta+Shift+z');
await page.waitForTimeout(250);
const afterRedoKb = (await editorState()).actors;
keys.undoRedo = {
  before: countBeforeDup,
  afterDuplicate: countBeforeDup + 1,
  afterUndo: afterUndoKb,
  afterRedo: afterRedoKb,
  undoRemovedTheCopy: afterUndoKb === countBeforeDup,
  redoBroughtItBack: afterRedoKb === countBeforeDup + 1,
};
console.log(`  ⌘Z ${JSON.stringify(keys.undoRedo)}`);

// --- ⌫ delete -------------------------------------------------------------
await blurUi();
await page.evaluate(() => {
  const id = window.__editor.state.actors[window.__editor.state.actors.length - 1].id;
  window.__editor.setSelection([id]);
});
const beforeDel = (await editorState()).actors;
await page.keyboard.press('Delete');
await page.waitForTimeout(250);
keys.delete = { before: beforeDel, after: (await editorState()).actors };
console.log(`  ⌫  ${JSON.stringify(keys.delete)}`);

// --- Tab: flip the ghost to the opposing lane -----------------------------
// A point on a road that actually has an opposing lane, as close to the stage
// (i.e. to the middle of the frame) as possible.
const flipPoint = await page.evaluate(
  ([sx, sz, radius]) => {
    const idx = window.__editor.laneIndex;
    let best = null;
    for (const lane of idx.all) {
      for (let s = 0; s <= lane.length; s += 4) {
        const p = idx.poseAt(lane, s, 0);
        const d = Math.hypot(p.x - sx, p.z - sz);
        if (d > radius || (best && best.d <= d)) continue;
        const hit = idx.nearest(p.x, p.z, 30);
        if (!hit) continue;
        const opp = idx.nearestOpposing(p.x, p.z, hit.headingRad, 30);
        if (!opp || opp.lane.rsl === hit.lane.rsl) continue;
        best = {
          x: p.x,
          z: p.z,
          y: window.__overlays.sampleHeight(p.x, p.z),
          d,
          laneId: hit.lane.laneId,
          roadId: hit.lane.roadId,
          headingDeg: (hit.headingRad * 180) / Math.PI,
          oppLaneId: opp.lane.laneId,
          oppRoadId: opp.lane.roadId,
          oppHeadingDeg: (opp.headingRad * 180) / Math.PI,
        };
      }
    }
    return best;
  },
  [stage.x, stage.z, 50],
);
if (!flipPoint) {
  keys.tab = { skipped: 'no two-way road within 50 m of the stage' };
} else {
  await blurUi();
  await armPalette('vehicle.sedan');
  const reached = await hover(flipPoint);
  const beforeTab = await editorState();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(220);
  const afterTab = await editorState();
  keys.tab = {
    cursorOnMap: reached !== null,
    snappedBefore: beforeTab.snapped,
    flippedBefore: beforeTab.flipped,
    flippedAfter: afterTab.flipped,
    laneBefore: beforeTab.laneLabel,
    laneAfter: afterTab.laneLabel,
    laneChanged: beforeTab.laneLabel !== afterTab.laneLabel,
    indexOpposingDeltaDeg: +Math.abs(wrapDeg(flipPoint.oppHeadingDeg - flipPoint.headingDeg)).toFixed(2),
  };
  if (afterTab.valid) {
    await clickHere();
    const placed = await page.evaluate(() => {
      const id = window.__editor.state.selection[0];
      const a = window.__editor.state.actors.find((x) => x.id === id);
      return a ? JSON.parse(JSON.stringify(a)) : null;
    });
    keys.tab.placedLaneId = placed?.laneRef?.laneId ?? null;
    keys.tab.placedOnOpposingLane = placed?.laneRef?.laneId === flipPoint.oppLaneId;
    keys.tab.placedVsUnflippedDeg = placed
      ? +Math.abs(wrapDeg(deg(placed.headingRad) - flipPoint.headingDeg)).toFixed(2)
      : null;
  } else {
    keys.tab.placedLaneId = 'not placed (ghost invalid — occupied)';
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await shot('kb-10-tab-opposing-lane');
}
console.log(`  Tab ${JSON.stringify(keys.tab)}`);

// --- ⌥: free placement, no lane snap --------------------------------------
const freeSpot = (await placementPoints(stage, 1, 8, 0, 50, 6))[0];
if (!freeSpot) {
  keys.alt = { skipped: 'no free ground near the stage' };
} else {
  await blurUi();
  await armPalette('vehicle.sedan');
  await hover(freeSpot);
  const snappedState = await editorState();
  await page.keyboard.down('Alt');
  await hover({ ...freeSpot, x: freeSpot.x + 0.05 });
  const altState = await editorState();
  await clickHere();
  await page.keyboard.up('Alt');
  const freePlaced = await page.evaluate(() => {
    const id = window.__editor.state.selection[0];
    const a = window.__editor.state.actors.find((x) => x.id === id);
    return a ? JSON.parse(JSON.stringify(a)) : null;
  });
  keys.alt = {
    snappedWithoutAlt: snappedState.snapped,
    snappedWithAlt: altState.snapped,
    hint: altState.hint,
    placedAnchored: Boolean(freePlaced?.laneRef),
    // Free placement still lands on the ground.
    groundDeltaM: freePlaced
      ? +Math.abs(
          freePlaced.y -
            (await page.evaluate(
              ([x, z]) => window.__overlays.sampleHeight(x, z),
              [freePlaced.x, freePlaced.z],
            )),
        ).toFixed(4)
      : null,
  };
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await shot('kb-11-alt-free-placement');
}
console.log(`  ⌥  ${JSON.stringify(keys.alt)}`);

// --- Esc leaves placement mode -------------------------------------------
await blurUi();
const armedState = await armPalette('pedestrian.adult_walking');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const idleState = await editorState();
keys.escape = {
  armedMode: armedState.mode,
  armedPlacing: armedState.placing,
  afterMode: idleState.mode,
  afterPlacing: idleState.placing,
};
console.log(`  Esc ${JSON.stringify(keys.escape)}`);
report.keys = keys;

// ------------------------------------------- 2. ground + heading accuracy
console.log('> gate 2: ground contact and lane heading');

/**
 * Recompute every anchored actor's expected pose straight from the raw
 * `topology-index.json.gz`, in Node, with an implementation that shares no code
 * with the app.
 *
 * This is the check that the app's own numbers cannot make: comparing an actor
 * against `laneIndex.poseAt` only proves the index is self-consistent. Here the
 * gunzip, the local -> scene transform (`scene = (x, height, -y)`), the arc
 * length and the OpenDRIVE direction rule are all done again from the file.
 */
const independentPoseCheck = async (mapId, actors) => {
  const res = await fetch(new URL(`/dev-assets/${mapId}/topology-index.json.gz`, url));
  const buf = Buffer.from(await res.arrayBuffer());
  const topology = JSON.parse(gunzipSync(buf).toString('utf8'));
  const rows = [];
  for (const actor of actors) {
    if (!actor.laneRef) continue;
    const lane = topology.lanes[`${actor.laneRef.roadId}:${actor.laneRef.section}:${actor.laneRef.laneId}`];
    if (!lane?.polyline?.length) continue;
    // local (x east, y north) -> scene (x, -y), duplicates dropped.
    const xs = [];
    const zs = [];
    for (const p of lane.polyline) {
      const x = p.x;
      const z = -p.y;
      const n = xs.length;
      if (n > 0 && Math.abs(xs[n - 1] - x) < 1e-9 && Math.abs(zs[n - 1] - z) < 1e-9) continue;
      xs.push(x);
      zs.push(z);
    }
    let s = 0;
    let segment = xs.length - 2;
    let f = 1;
    for (let i = 1; i < xs.length; i++) {
      const step = Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
      if (s + step >= actor.laneRef.s || i === xs.length - 1) {
        segment = i - 1;
        f = step > 0 ? Math.min(1, (actor.laneRef.s - s) / step) : 0;
        break;
      }
      s += step;
    }
    const ax = xs[segment];
    const az = zs[segment];
    const bx = xs[segment + 1];
    const bz = zs[segment + 1];
    let heading = Math.atan2(-(bz - az), bx - ax);
    // OpenDRIVE: a negative lane id runs along +s, a positive one against it.
    if (actor.laneRef.laneId > 0) heading += Math.PI;
    const px = ax + (bx - ax) * f;
    const pz = az + (bz - az) * f;
    // Lateral offset, positive to the left of travel.
    const ex = px - Math.sin(heading) * actor.laneRef.t;
    const ez = pz - Math.cos(heading) * actor.laneRef.t;
    let dh = actor.headingRad - heading - actor.laneRef.headingOffsetRad;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh <= -Math.PI) dh += Math.PI * 2;
    rows.push({
      id: actor.id,
      snapped: Math.abs(actor.laneRef.headingOffsetRad) < 1e-9,
      headingErrDeg: (dh * 180) / Math.PI,
      positionErrM: Math.hypot(actor.x - ex, actor.z - ez),
    });
  }
  const worst = (pick, from = rows) => from.reduce((m, r) => Math.max(m, Math.abs(pick(r))), 0);
  const snapped = rows.filter((r) => r.snapped);
  return {
    n: rows.length,
    snapped: snapped.length,
    // Recomputed from the raw file: heading residual and position, for the
    // lane-snapped placements and then for every anchored actor.
    worstSnappedHeadingDeg: +worst((r) => r.headingErrDeg, snapped).toFixed(5),
    worstHeadingResidualDeg: +worst((r) => r.headingErrDeg).toFixed(5),
    worstPositionM: +worst((r) => r.positionErrM).toFixed(5),
  };
};
report.accuracy = await page.evaluate(() => {
  const editor = window.__editor;
  const overlays = window.__overlays;
  const rows = [];
  for (const actor of editor.state.actors) {
    const ground = overlays.sampleHeight(actor.x, actor.z);
    // Independent of the index the placement used: a live downward raycast
    // against the road mesh actually on screen.
    const ray = window.__viewer.sampleGroundHeight(actor.x, actor.z);
    const row = { id: actor.id, kind: actor.kind, dY: actor.y - ground, dYRay: ray === null ? null : actor.y - ray };
    if (actor.laneRef) {
      const lane = editor.laneIndex.laneFor(
        actor.laneRef.roadId,
        actor.laneRef.section,
        actor.laneRef.laneId,
      );
      if (lane) {
        const pose = editor.laneIndex.poseAt(lane, actor.laneRef.s, actor.laneRef.t);
        let delta = actor.headingRad - pose.headingRad;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta <= -Math.PI) delta += Math.PI * 2;
        // Raw difference from the lane tangent...
        row.headingErrDeg = (delta * 180) / Math.PI;
        // ...and the difference the anchor does not already account for. An
        // actor that was deliberately skewed (rotated, or nudged sideways in
        // the inspector) records that as `headingOffsetRad`; what must be zero
        // is the *residual*.
        row.headingResidualDeg = ((delta - actor.laneRef.headingOffsetRad) * 180) / Math.PI;
        row.offsetDeg = (actor.laneRef.headingOffsetRad * 180) / Math.PI;
        row.snapped = Math.abs(actor.laneRef.headingOffsetRad) < 1e-9;
        row.lateralErrM = Math.hypot(actor.x - pose.x, actor.z - pose.z);
      }
    }
    rows.push(row);
  }
  const stat = (values) => {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    return {
      n: s.length,
      min: +s[0].toFixed(5),
      p50: +s[s.length >> 1].toFixed(5),
      max: +s[s.length - 1].toFixed(5),
    };
  };
  return {
    groundDelta: stat(rows.map((r) => Math.abs(r.dY))),
    groundDeltaVsRaycast: stat(rows.filter((r) => r.dYRay !== null).map((r) => Math.abs(r.dYRay))),
    // The gate: lane-snapped placements, i.e. the ones that claim zero yaw
    // offset, must point along their lane.
    headingErrDeg: stat(rows.filter((r) => r.snapped).map((r) => Math.abs(r.headingErrDeg))),
    // Every anchored actor, skewed or not: heading must equal the lane tangent
    // plus the offset the anchor records.
    headingResidualDeg: stat(
      rows.filter((r) => r.headingResidualDeg !== undefined).map((r) => Math.abs(r.headingResidualDeg)),
    ),
    skewed: rows.filter((r) => r.snapped === false).map((r) => ({ id: r.id, offsetDeg: +r.offsetDeg.toFixed(4) })),
    lateralErrM: stat(rows.filter((r) => r.lateralErrM !== undefined).map((r) => r.lateralErrM)),
    anchored: rows.filter((r) => r.headingErrDeg !== undefined).length,
    rows: rows.slice(0, 20),
  };
});
const actorsNow = await page.evaluate(() => window.__editor.state.actors.map((a) => ({ ...a })));
report.accuracy.independent = await independentPoseCheck(
  await page.evaluate(() => window.__mapId),
  actorsNow,
);
console.log(`  ground |dY| vs index   ${JSON.stringify(report.accuracy.groundDelta)}`);
console.log(`  ground |dY| vs raycast ${JSON.stringify(report.accuracy.groundDeltaVsRaycast)}`);
console.log(`  heading err deg        ${JSON.stringify(report.accuracy.headingErrDeg)}`);
console.log(`  heading residual deg   ${JSON.stringify(report.accuracy.headingResidualDeg)}`);
console.log(`  deliberately skewed    ${JSON.stringify(report.accuracy.skewed)}`);
console.log(`  independent recompute  ${JSON.stringify(report.accuracy.independent)}`);

// -------------------------------------------------- 3. reload persistence
console.log('> gate 3: reload restores the scenario');
await page.evaluate(() => window.__editor.doc.flush());
const before = await page.evaluate(() =>
  JSON.stringify(
    window.__editor.state.actors.map((a) => [a.catalogId, a.x, a.y, a.z, a.headingRad, a.laneRef ?? null]),
  ),
);
const storedBefore = await page.evaluate(() =>
  localStorage.getItem(`simforge:scenario:autosave-${window.__mapId}`),
);
await page.reload({ waitUntil: 'load' });
await editorReady();
const after = await page.evaluate(() =>
  JSON.stringify(
    window.__editor.state.actors.map((a) => [a.catalogId, a.x, a.y, a.z, a.headingRad, a.laneRef ?? null]),
  ),
);
await page.evaluate(() => window.__editor.doc.flush());
const storedAfter = await page.evaluate(() =>
  localStorage.getItem(`simforge:scenario:autosave-${window.__mapId}`),
);
report.persistence = {
  actorsBefore: JSON.parse(before).length,
  actorsAfter: JSON.parse(after).length,
  poseIdentical: before === after,
  bytesIdentical: storedBefore === storedAfter,
  bytes: storedBefore?.length ?? 0,
};
console.log(`  ${JSON.stringify(report.persistence)}`);

// -------------------------------------------------------- 4. multi-map
console.log('> gate 4: all five maps, switching, leaks');
const maps = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid^="map-"]:not([data-testid="map-picker"])')].map((el) =>
    el.getAttribute('data-testid').replace('map-', ''),
  ),
);
console.log(`  registry: ${maps.join(', ')}`);

const openMapRaw = async (id) => {
  const started = Date.now();
  await page.evaluate((m) => window.__setMap(m), id);
  await page.waitForFunction((m) => window.__mapId === m && Boolean(window.__editor), id, {
    timeout: 300000,
  });
  return Date.now() - started;
};

/** Switch, then wait for the map to be on screen. */
const openMap = async (id) => {
  const ms = await openMapRaw(id);
  await streamIdle(120000);
  await page.waitForTimeout(1200);
  return ms;
};

report.maps = [];
for (const id of maps) {
  if (id !== (await page.evaluate(() => window.__mapId))) {
    const ms = await openMap(id);
    console.log(`  ${id}: ready in ${(ms / 1000).toFixed(1)} s`);
    report.maps.push({ id, readyMs: ms });
  } else {
    report.maps.push({ id, readyMs: 0 });
  }
  const mapStage = await findStage();
  await setView([mapStage.x - 34, mapStage.y + 22, mapStage.z + 34], [mapStage.x, mapStage.y, mapStage.z]);
  await streamIdle(60000);
  await page.waitForTimeout(1200);
  const points = await placementPoints(mapStage, 3, 14, 0);
  const placed = await placeAll('vehicle.suv', points, 'fast');
  const entry = report.maps[report.maps.length - 1];
  entry.lanes = await page.evaluate(() => window.__editor.laneIndex.stats.lanes);
  entry.signalDraws = await page.evaluate(() => window.__overlays.stats.signalDrawCalls);
  entry.placed = await page.evaluate(() => window.__editor.state.actors.length);
  entry.placement = { points: points.length, ...placed };
  entry.placeMs = placed.ms;
  entry.accuracy = await page.evaluate(() => {
    const editor = window.__editor;
    const overlays = window.__overlays;
    let worstY = 0;
    let worstHeading = 0;
    for (const actor of editor.state.actors) {
      worstY = Math.max(worstY, Math.abs(actor.y - overlays.sampleHeight(actor.x, actor.z)));
      if (!actor.laneRef) continue;
      const lane = editor.laneIndex.laneFor(actor.laneRef.roadId, actor.laneRef.section, actor.laneRef.laneId);
      if (!lane) continue;
      const pose = editor.laneIndex.poseAt(lane, actor.laneRef.s, actor.laneRef.t);
      let d = actor.headingRad - pose.headingRad - actor.laneRef.headingOffsetRad;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d <= -Math.PI) d += Math.PI * 2;
      worstHeading = Math.max(worstHeading, Math.abs((d * 180) / Math.PI));
    }
    return { worstGroundDeltaM: +worstY.toFixed(4), worstHeadingDeg: +worstHeading.toFixed(4) };
  });
  console.log(
    `    ${id}: ${entry.placed} actors, ${JSON.stringify(entry.accuracy)} place=${JSON.stringify(entry.placement)}`,
  );
  await shot(`03-map-${id}`);
}

console.log('> leak check: three round trips back to the first map');
/**
 * Measured at each map's **default framing**, i.e. wherever `loadMap` parks the
 * camera, with no `setView` in the loop.
 *
 * That matters more than it looks. Residency is budget-driven: Yale Street sits
 * at its 1.5 GB ceiling, so at an arbitrary oblique pose the eviction order —
 * and therefore the geometry and texture counts — legitimately differs by a few
 * dozen between two visits that are equally leak-free. Comparing like with like
 * needs a pose that is reproduced exactly, and the default framing is the one
 * pose the loader guarantees.
 */
const first = maps[0];
const second = maps[1];
const settleHome = async () => {
  await streamIdle(120000);
  await page.waitForTimeout(3000);
};
await openMapRaw(first);
await settleHome();
const baseline = await rendererInfo();
const trips = [];
for (let i = 0; i < 3; i++) {
  await openMapRaw(second);
  await settleHome();
  await openMapRaw(first);
  await settleHome();
  trips.push(await rendererInfo());
}
report.leaks = {
  pose: 'default framing (no camera move)',
  baseline,
  trips,
  geometryDrift: trips.map((t) => t.geometries - baseline.geometries),
  textureDrift: trips.map((t) => t.textures - baseline.textures),
  programDrift: trips.map((t) => t.programs - baseline.programs),
  heapDriftMB: trips.map((t) => (t.heapMB ?? 0) - (baseline.heapMB ?? 0)),
};
console.log(`  ${JSON.stringify(report.leaks)}`);

// -------------------------------------------------------- 5. frame budget
console.log('> gate 5: 30 actors at street level');
await page.evaluate(() => {
  const ids = window.__editor.state.actors.map((a) => a.id);
  window.__editor.setSelection(ids);
  window.__editor.deleteSelection();
});
const benchStage = await findStage();
// Place from an overview pose: 30 actors do not fit in a 34 m oblique framing,
// and an off-screen point cannot be clicked.
await setView(
  [benchStage.x - 80, benchStage.y + 70, benchStage.z + 80],
  [benchStage.x, benchStage.y, benchStage.z],
);
await streamIdle(60000);
await page.waitForTimeout(1500);
for (const catalogId of ['vehicle.sedan', 'vehicle.suv', 'vehicle.van', 'vehicle.pickup']) {
  const placedSoFar = await page.evaluate(() => window.__editor.state.actors.length);
  if (placedSoFar >= 30) break;
  const slice = await placementPoints(benchStage, 30 - placedSoFar, 11, 0, 110, 9);
  await placeAll(catalogId, slice, 'fast');
}
const actorCount = await page.evaluate(() => window.__editor.state.actors.length);
console.log(`  placed ${actorCount}`);

// Street level: 1.6 m eye height, looking down the road the actors are on.
const streetPose = await page.evaluate(([x, z]) => {
  const index = window.__editor.laneIndex;
  const hit = index.nearest(x, z, 60);
  const a = index.poseAt(hit.lane, Math.max(0, hit.s - 25), 0);
  const b = index.poseAt(hit.lane, Math.min(hit.lane.length, hit.s + 40), 0);
  const y = window.__overlays.sampleHeight(a.x, a.z);
  return { eye: [a.x, y + 1.6, a.z], target: [b.x, y + 1.4, b.z] };
}, [benchStage.x, benchStage.z]);
await setView(streetPose.eye, streetPose.target);
await streamIdle(60000);
await page.waitForTimeout(2000);
await shot('04-street-30-actors');

// The same pose with the nearest actor selected, so the inspector is on screen
// showing a real lane anchor — the shot the brief asks for.
await page.evaluate(
  ([x, z]) => {
    const actors = window.__editor.state.actors;
    let best = actors[0];
    for (const a of actors) {
      if (Math.hypot(a.x - x, a.z - z) < Math.hypot(best.x - x, best.z - z)) best = a;
    }
    window.__editor.setSelection([best.id]);
  },
  [streetPose.target[0], streetPose.target[2]],
);
await page.waitForTimeout(600);
await shot('06-street-inspector');

const setActorsVisible = (visible) =>
  page.evaluate((v) => {
    window.__editor.renderer.group.visible = v;
  }, visible);

report.frameBudget = { actorCount, street: {} };
report.frameBudget.street.withActors = await sampleFps(6);
await setActorsVisible(false);
report.frameBudget.street.withoutActors = await sampleFps(6);
await setActorsVisible(true);
report.frameBudget.street.withActorsRepeat = await sampleFps(6);
console.log(`  street with actors    ${JSON.stringify(report.frameBudget.street.withActors)}`);
console.log(`  street without actors ${JSON.stringify(report.frameBudget.street.withoutActors)}`);
console.log(`  street with (repeat)  ${JSON.stringify(report.frameBudget.street.withActorsRepeat)}`);

console.log('> full fly-through benchmark, actors on then off');
report.frameBudget.bench = {};
report.frameBudget.bench.withActors = await page.evaluate((ms) => window.__bench(ms), benchMs);
await setActorsVisible(false);
report.frameBudget.bench.withoutActors = await page.evaluate((ms) => window.__bench(ms), benchMs);
await setActorsVisible(true);
console.log(`  bench with actors    ${JSON.stringify(report.frameBudget.bench.withActors)}`);
console.log(`  bench without actors ${JSON.stringify(report.frameBudget.bench.withoutActors)}`);

await setView(streetPose.eye, streetPose.target);
await page.waitForTimeout(1500);
await shot('05-final');

// ------------------------------------------------- 6. ⌘D builds a queue
// The gesture the duplicate rule exists for: select one car, hold ⌘D, get a
// stopped queue in its own lane. Shot from above, where a queue reads.
console.log('> gate 6: ⌘D queue, top-down');
await page.evaluate(() => {
  const ids = window.__editor.state.actors.map((a) => a.id);
  window.__editor.setSelection(ids);
  window.__editor.deleteSelection();
});
await page.waitForTimeout(300);
const queueSeed = await page.evaluate(
  ([x, z]) => {
    const index = window.__editor.laneIndex;
    // The longest lane near the stage, so five cars fit nose to tail.
    let best = null;
    for (const lane of index.all) {
      const mid = index.poseAt(lane, lane.length / 2, 0);
      if (Math.hypot(mid.x - x, mid.z - z) > 90) continue;
      if (!best || lane.length > best.length) best = { lane, length: lane.length, mid };
    }
    if (!best) return null;
    // Start near the downstream end so the copies march back up the lane.
    const s = best.lane.forward ? best.length - 6 : 6;
    const pose = index.poseAt(best.lane, s, 0);
    return {
      x: pose.x,
      y: window.__overlays.sampleHeight(pose.x, pose.z),
      z: pose.z,
      headingDeg: (pose.headingRad * 180) / Math.PI,
      laneLength: +best.length.toFixed(1),
    };
  },
  [benchStage.x, benchStage.z],
);
report.queue = { seed: queueSeed };
if (queueSeed) {
  await setView(
    [queueSeed.x + 6, queueSeed.y + 70, queueSeed.z + 6],
    [queueSeed.x, queueSeed.y, queueSeed.z],
  );
  await streamIdle(60000);
  await page.waitForTimeout(1500);
  await blurUi();
  await armPalette('vehicle.sedan');
  await hover(queueSeed);
  await clickHere();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  for (let i = 0; i < 5; i++) {
    await blurUi();
    await page.keyboard.press('Meta+d');
    await page.waitForTimeout(220);
  }
  report.queue.actors = await page.evaluate(() => {
    const index = window.__editor.laneIndex;
    const rows = window.__editor.state.actors
      .filter((a) => a.laneRef)
      .map((a) => ({ id: a.id, s: a.laneRef.s, lane: `${a.laneRef.roadId}:${a.laneRef.laneId}`, x: a.x, z: a.z }))
      .sort((a, b) => a.s - b.s);
    const gaps = [];
    for (let i = 1; i < rows.length; i++) {
      gaps.push(+Math.hypot(rows[i].x - rows[i - 1].x, rows[i].z - rows[i - 1].z).toFixed(3));
    }
    return {
      n: window.__editor.state.actors.length,
      anchored: rows.length,
      lanes: [...new Set(rows.map((r) => r.lane))],
      gapsM: gaps,
      worstHeadingDeg: +window.__editor.state.actors
        .reduce((worst, a) => {
          if (!a.laneRef) return worst;
          const lane = index.laneFor(a.laneRef.roadId, a.laneRef.section, a.laneRef.laneId);
          if (!lane) return worst;
          const pose = index.poseAt(lane, a.laneRef.s, a.laneRef.t);
          let d = a.headingRad - pose.headingRad - a.laneRef.headingOffsetRad;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d <= -Math.PI) d += Math.PI * 2;
          return Math.max(worst, Math.abs((d * 180) / Math.PI));
        }, 0)
        .toFixed(4),
    };
  });
  await page.waitForTimeout(600);
  await shot('07-topdown-queue');
  console.log(`  queue ${JSON.stringify(report.queue.actors)}`);
}

report.consoleErrors = consoleErrors;
report.consoleWarnings = consoleWarnings.slice(0, 20);
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

console.log('\n--- summary ---');
console.log(`editor armed              : ${report.bootMs} ms`);
console.log(`lane index                : ${JSON.stringify(report.laneIndex)}`);
console.log(`signal draw calls         : ${report.overlays.signalDrawCalls}`);
console.log(`place 15 (scripted)       : ${(report.placement.fast.totalMs / 1000).toFixed(1)} s`);
console.log(`place 15 (human pace)     : ${(report.placement.human.totalMs / 1000).toFixed(1)} s`);
console.log(`ground |dY| vs index      : ${JSON.stringify(report.accuracy.groundDelta)}`);
console.log(`ground |dY| vs raycast    : ${JSON.stringify(report.accuracy.groundDeltaVsRaycast)}`);
console.log(`lane heading err (deg)    : ${JSON.stringify(report.accuracy.headingErrDeg)}`);
console.log(`heading residual (deg)    : ${JSON.stringify(report.accuracy.headingResidualDeg)}`);
console.log(`independent recompute     : ${JSON.stringify(report.accuracy.independent)}`);
console.log(`props sidecar             : ${JSON.stringify(report.gestures.props)}`);
console.log(`gestures                  : ${JSON.stringify(report.gestures.history)}`);
console.log(`inspector sync            : ${JSON.stringify(report.gestures.inspector)}`);
console.log(`G move (slide on lane)    : ${JSON.stringify(report.keys.grab)}`);
console.log(`Esc cancels move          : ${JSON.stringify(report.keys.escapeCancelsGrab)}`);
console.log(`R / ⇧R 15° snap           : ${JSON.stringify(report.keys.rotate)}`);
console.log(`⌘D duplicate behind       : ${JSON.stringify(report.keys.duplicate)}`);
console.log(`⌘Z / ⇧⌘Z                  : ${JSON.stringify(report.keys.undoRedo)}`);
console.log(`⌫ delete                  : ${JSON.stringify(report.keys.delete)}`);
console.log(`Tab opposing lane         : ${JSON.stringify(report.keys.tab)}`);
console.log(`⌥ free placement          : ${JSON.stringify(report.keys.alt)}`);
console.log(`Esc leaves placement      : ${JSON.stringify(report.keys.escape)}`);
console.log(`reload identical          : ${report.persistence.poseIdentical} (bytes ${report.persistence.bytesIdentical})`);
console.log(`maps                      : ${report.maps.map((m) => `${m.id}=${m.placed}`).join(' ')}`);
console.log(`leak drift geometry/tex   : ${JSON.stringify(report.leaks.geometryDrift)} / ${JSON.stringify(report.leaks.textureDrift)}`);
console.log(`street fps (30 actors)    : ${JSON.stringify(report.frameBudget.street.withActors)}`);
console.log(`street fps (hidden)       : ${JSON.stringify(report.frameBudget.street.withoutActors)}`);
console.log(`⌘D queue                  : ${JSON.stringify(report.queue?.actors ?? report.queue)}`);
console.log(`console errors            : ${consoleErrors.length}`);
for (const err of consoleErrors.slice(0, 20)) console.log(`  ${err}`);

await context.close();
await browser.close();
process.exit(consoleErrors.length === 0 ? 0 : 1);
