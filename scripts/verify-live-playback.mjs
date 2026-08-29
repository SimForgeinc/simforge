#!/usr/bin/env node
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index]?.replace(/^--/, ''), process.argv[index + 1]);
}
const url = args.get('url') ?? 'http://127.0.0.1:5204/?map=yale-street';
const outDir = path.resolve(args.get('out') ?? 'artifacts/agent/studio-live-playback');
const instancePath = path.resolve(args.get('instance') ?? 'artifacts/qa/golden-yale-bus-stop-20260801-corrected/instance.json');
const tracePath = path.resolve(args.get('trace') ?? 'artifacts/qa/golden-yale-bus-stop-20260801-corrected/trace.json.gz');
await mkdir(outDir, { recursive: true });
const videoDir = path.join(outDir, '.video');
await mkdir(videoDir, { recursive: true });

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const consoleErrors = [];
const consoleWarnings = [];
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--window-size=1680,1050'],
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 960 },
  recordVideo: { dir: videoDir, size: { width: 1600, height: 960 } },
});
const page = await context.newPage();
page.on('console', (message) => {
  const row = `${message.type()}: ${message.text()}`;
  if (message.type() === 'error') consoleErrors.push(row);
  if (message.type() === 'warning') consoleWarnings.push(row);
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
page.on('requestfailed', (request) => {
  const reason = request.failure()?.errorText ?? '';
  if (!reason.includes('ERR_ABORTED')) consoleErrors.push(`requestfailed: ${reason} ${request.url()}`);
});
page.on('response', (response) => {
  if (response.status() >= 400) consoleErrors.push(`http ${response.status()} ${response.url()}`);
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => Boolean(window.__viewer && window.__overlays && window.__editor), null, { timeout: 180_000 });
await page.locator('[data-testid="instance-file"]').setInputFiles(instancePath);
await page.locator('[data-testid="trace-file"]').setInputFiles(tracePath);
await page.locator('[data-testid="load-playback"]').click();
await page.waitForFunction(
  () => window.__playback?.state.actorCount === 3 && window.__playback.state.visibleActorCount === 3,
  null,
  { timeout: 60_000 },
);
await page.waitForTimeout(1_500);

const identity = await page.evaluate(() => {
  const playback = window.__playback;
  if (!playback) throw new Error('window.__playback is missing after import');
  const sceneGroup = window.__viewer?.scene.getObjectByName('playback-actors');
  return {
    state: playback.state,
    actorIds: playback.bundle.actors.map((actor) => actor.id),
    models: playback.bundle.actors.map((actor) => ({
      id: actor.id,
      catalogId: actor.catalogId,
      static: actor.static,
      dims: actor.dims,
    })),
    renderer: playback.renderer.stats,
    sceneGroup: sceneGroup
      ? { name: sceneGroup.name, visible: sceneGroup.visible, children: sceneGroup.children.length }
      : null,
    ui: document.querySelector('[data-testid="playback-identity"]')?.textContent?.trim() ?? null,
  };
});
if (identity.state.actorCount !== 3 || identity.actorIds.join(',') !== 'bus,ego,ped') {
  throw new Error(`expected bus,ego,ped actor identity, got ${JSON.stringify(identity)}`);
}
if (!identity.sceneGroup || identity.sceneGroup.children === 0 || identity.renderer.drawCalls === 0) {
  throw new Error(`playback actor geometry is not resident: ${JSON.stringify(identity)}`);
}

const sampleTimes = [0, 4.3, 6.9, 7.4];
const samples = [];
const screenshots = [];
for (let index = 0; index < sampleTimes.length; index++) {
  const requestedT = sampleTimes[index];
  await page.locator('[data-testid="timeline"]').fill(String(requestedT));
  await page.waitForFunction((time) => Math.abs((window.__playback?.state.time ?? -999) - time) < 0.001, requestedT);
  await page.waitForTimeout(250);
  const snapshot = await page.evaluate((time) => {
    const playback = window.__playback;
    const overlays = window.__overlays;
    if (!playback || !overlays) throw new Error('playback/overlays missing while sampling');
    return {
      requestedT: time,
      actualT: playback.state.time,
      actorCount: playback.state.actorCount,
      visibleActorCount: playback.state.visibleActorCount,
      poses: playback.currentActors.map((actor) => ({
        id: actor.id,
        catalogId: actor.catalogId,
        static: actor.static,
        present: actor.present,
        x: actor.x,
        y: overlays.sampleHeight(actor.x, actor.z),
        z: actor.z,
        headingRad: actor.headingRad,
      })),
    };
  }, requestedT);
  samples.push(snapshot);
  const file = path.join(outDir, `scrub-${String(index).padStart(2, '0')}-t${requestedT.toFixed(1)}.png`);
  await page.screenshot({ path: file });
  screenshots.push({ file: path.basename(file), sha256: sha256(await readFile(file)), time: requestedT });
}

const busPoses = samples.map((sample) => sample.poses.find((pose) => pose.id === 'bus'));
const busSignature = new Set(busPoses.map((pose) => JSON.stringify([pose.x, pose.z, pose.headingRad])));
if (busSignature.size !== 1) throw new Error(`static bus moved across scrub samples: ${JSON.stringify(busPoses)}`);
const ego0 = samples[0].poses.find((pose) => pose.id === 'ego');
const egoConflict = samples[2].poses.find((pose) => pose.id === 'ego');
if (Math.hypot(egoConflict.x - ego0.x, egoConflict.z - ego0.z) < 80) {
  throw new Error('dynamic ego did not move far enough to prove trace-driven playback');
}

await page.locator('[data-testid="timeline"]').fill('4.3');
const beforePlay = await page.evaluate(() => window.__playback.state.time);
await page.locator('[data-testid="play-pause"]').click();
await page.waitForFunction(() => window.__playback?.state.playing === true);
await page.waitForTimeout(1_100);
await page.locator('[data-testid="play-pause"]').click();
await page.waitForFunction(() => window.__playback?.state.playing === false);
const afterPause = await page.evaluate(() => window.__playback.state.time);
if (afterPause - beforePlay < 0.7) throw new Error(`play/pause advanced only ${afterPause - beforePlay}s`);
const transport = { beforePlay, afterPause, advancedSeconds: afterPause - beforePlay };

const finalShot = path.join(outDir, 'play-pause-final.png');
await page.screenshot({ path: finalShot });
screenshots.push({ file: path.basename(finalShot), sha256: sha256(await readFile(finalShot)), time: afterPause });

const video = page.video();
await page.close();
await context.close();
const recordedPath = await video.path();
const webmPath = path.join(outDir, 'studio-live-playback.webm');
await copyFile(recordedPath, webmPath);
await browser.close();

const mp4Path = path.join(outDir, 'studio-live-playback.mp4');
const ffmpeg = spawnSync('ffmpeg', [
  '-y', '-i', webmPath, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4Path,
], { encoding: 'utf8' });
if (ffmpeg.status !== 0) throw new Error(`ffmpeg failed: ${ffmpeg.stderr}`);

const instanceBytes = await readFile(instancePath);
const traceBytes = await readFile(tracePath);
const manifest = {
  schema: 'simforge-oss.live-playback-evidence.v1',
  generatedAt: new Date().toISOString(),
  url,
  repository: process.cwd(),
  scenarioId: identity.state.instanceId,
  mapId: 'yale-street',
  inputHash: identity.state.inputHash,
  actorIds: identity.actorIds,
  actorCount: identity.state.actorCount,
  models: identity.models,
  renderer: identity.renderer,
  sceneGroup: identity.sceneGroup,
  source: {
    instance: { file: path.relative(process.cwd(), instancePath), sha256: sha256(instanceBytes) },
    trace: { file: path.relative(process.cwd(), tracePath), sha256: sha256(traceBytes) },
  },
  transport,
  samples,
  artifacts: {
    screenshots,
    videoWebm: { file: path.basename(webmPath), sha256: sha256(await readFile(webmPath)) },
    videoMp4: { file: path.basename(mp4Path), sha256: sha256(await readFile(mp4Path)) },
  },
  console: { errors: consoleErrors, warnings: consoleWarnings },
  acceptance: {
    actorCountGreaterThanZero: identity.state.actorCount > 0,
    exactGoldenActorCount: identity.state.actorCount === 3,
    allThreeVisibleAtStart: samples[0].visibleActorCount === 3,
    staticBusInvariant: busSignature.size === 1,
    dynamicEgoMoved: true,
    playPauseAdvanced: transport.advancedSeconds >= 0.7,
    multipleScrubTimes: samples.length,
    actualActorGeometry: identity.sceneGroup.children > 0 && identity.renderer.drawCalls > 0,
    consoleErrors: consoleErrors.length,
  },
};
if (consoleErrors.length > 0) throw new Error(`console errors during live playback: ${consoleErrors.join('\n')}`);
const manifestPath = path.join(outDir, 'manifest.json');
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const hashes = {
  manifest: { file: 'manifest.json', sha256: sha256(await readFile(manifestPath)) },
  ...manifest.artifacts,
};
await writeFile(path.join(outDir, 'hashes.json'), `${JSON.stringify(hashes, null, 2)}\n`);
console.log(JSON.stringify({ manifest: manifestPath, hashes, acceptance: manifest.acceptance }, null, 2));
