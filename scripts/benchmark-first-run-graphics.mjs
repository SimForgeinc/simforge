#!/usr/bin/env node
/**
 * Reproducible first-run preset benchmark against a running Studio dev server.
 * Cold HTTP cache is enforced through CDP. `residentBytes` is the renderer's
 * decoded resident allocation estimate; it is not direct hardware VRAM usage.
 *
 * node scripts/benchmark-first-run-graphics.mjs \
 *   --url http://127.0.0.1:5299 --out /tmp/first-run-graphics.json
 */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import { chromium } from 'playwright-core';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index]?.replace(/^--/, ''), process.argv[index + 1]);
}
const baseUrl = args.get('url') ?? 'http://127.0.0.1:5199/';
const output = args.get('out') ?? '/tmp/simforge-first-run-graphics.json';
const maps = (args.get('maps') ?? 'easterbrook-discovery-school,yale-street').split(',');
const presets = (args.get('presets') ?? 'roads-only,ultra-low-3d,minimal,high').split(',');
const allConditions = [
  { id: 'hardware-enabled', launchArgs: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'] },
  { id: 'software-requested', launchArgs: ['--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] },
];
const requestedConditions = new Set((args.get('conditions') ?? allConditions.map(({ id }) => id).join(',')).split(','));
const conditions = allConditions.filter(({ id }) => requestedConditions.has(id));

function processMemoryMB(processIds) {
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
      .trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
    return rows.filter(([pid]) => processIds.has(pid)).reduce((sum, row) => sum + (row[2] ?? 0), 0) / 1024;
  } catch {
    return null;
  }
}

const results = [];
for (const condition of conditions) {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [...condition.launchArgs, '--window-size=1440,960', '--js-flags=--expose-gc'],
  });
  const browserCdp = await browser.newBrowserCDPSession();
  const sampleProcessMB = async () => {
    try {
      const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
      return processMemoryMB(new Set(processInfo.map((entry) => entry.id)));
    } catch { return null; }
  };
  try {
    for (const map of maps) {
      for (const preset of presets) {
        const context = await browser.newContext({ viewport: { width: 1360, height: 850 } });
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        let transferredBytes = 0;
        let tracking = false;
        const requestUrls = new Map();
        const completedRequests = [];
        cdp.on('Network.requestWillBeSent', (event) => requestUrls.set(event.requestId, event.request.url));
        cdp.on('Network.loadingFinished', (event) => {
          if (!tracking) return;
          transferredBytes += event.encodedDataLength;
          completedRequests.push({ url: requestUrls.get(event.requestId) ?? '', encodedBytes: event.encodedDataLength });
        });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });

        const target = new URL(baseUrl);
        target.searchParams.set('map', map);
        await page.goto(target.toString(), { waitUntil: 'load' });
        await page.waitForSelector(`[data-testid="graphics-choice-${preset}"]`);
        tracking = true;
        const startedAt = performance.now();
        let peakProcessMB = await sampleProcessMB();
        const memoryTimer = setInterval(async () => {
          const current = await sampleProcessMB();
          if (current !== null) peakProcessMB = Math.max(peakProcessMB ?? 0, current);
        }, 200);
        await page.click(`[data-testid="graphics-choice-${preset}"]`);
        await page.waitForFunction(() => window.__viewer?.getStats().roadVisible === true, null, { timeout: 90000 });
        const roadVisibleMs = performance.now() - startedAt;
        await page.waitForFunction(() => {
          const stats = window.__viewer?.getStats();
          return stats && stats.loading === 0 && stats.queued === 0 && stats.uploading === 0;
        }, null, { timeout: 60000 }).catch(() => undefined);
        await page.waitForTimeout(1200);
        const settledMs = performance.now() - startedAt;
        const sample = await page.evaluate(async () => {
          const viewer = window.__viewer;
          globalThis.gc?.();
          const capability = viewer.getRendererCapability();
          const stats = viewer.getStats();
          const info = viewer.renderer.info;
          const benchmark = await viewer.runBenchmark(4000);
          return {
            capability,
            stats,
            rendererMemory: { geometries: info.memory.geometries, textures: info.memory.textures },
            benchmark,
          };
        });
        clearInterval(memoryTimer);
        const steadyProcessMB = await sampleProcessMB();
        results.push({
          condition: condition.id, map, preset,
          coldTransferredMB: transferredBytes / 1048576,
          roadVisibleMs, settledMs,
          rendererResidentEstimateMB: sample.stats.residentBytes / 1048576,
          jsHeapMB: sample.stats.jsHeapMB,
          steadyProcessMB, peakProcessMB,
          renderer: sample.capability,
          rendererMemory: sample.rendererMemory,
          frame: {
            displayFps: sample.benchmark.displayFps,
            p50Ms: sample.benchmark.p50FrameMs,
            p95Ms: sample.benchmark.p95FrameMs,
            p99Ms: sample.benchmark.p99FrameMs,
            drawCalls: sample.benchmark.drawCalls,
            residentBytes: sample.benchmark.residentBytes,
            phases: sample.benchmark.phases,
          },
          requestInventory: completedRequests.map((entry) => {
            const pathname = (() => { try { return new URL(entry.url).pathname; } catch { return entry.url; } })();
            const category = /\/tiles\/veg_|\.instances\.json$/.test(pathname) ? 'vegetation'
              : /\/tiles\/tile_/.test(pathname) ? 'city'
                : /\/roads-only-v\d|\/tiles\/road\.glb$/.test(pathname) ? 'road'
                  : 'application-or-overlay';
            return { pathname, category, encodedBytes: entry.encodedBytes };
          }),
          errors,
        });
        console.log(`${condition.id} ${map} ${preset}: ${roadVisibleMs.toFixed(0)} ms, ${(transferredBytes / 1048576).toFixed(1)} MB, ${sample.benchmark.displayFps.toFixed(1)} fps`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

const report = {
  capturedAt: new Date().toISOString(),
  machine: { platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length, totalMemoryGB: os.totalmem() / 1073741824 },
  config: { baseUrl, maps, presets, viewport: '1360x850', coldCache: true, settleTimeoutMs: 60000, benchmarkMs: 4000, conditions },
  caveats: [
    'residentBytes is the renderer decoded-resident allocation estimate, not direct physical VRAM usage.',
    'Process memory aggregates Chrome parent and child RSS and therefore includes browser overhead beyond the scene.',
    'Hardware/software labels describe requested launch configuration; renderer.capability records what Chrome actually provided.',
    'Localhost transfer removes WAN latency; bytes are cold-cache network payload and timings vary by browser, OS, disk, and map.',
  ],
  results,
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${output}`);
