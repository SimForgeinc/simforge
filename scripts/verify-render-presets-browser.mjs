#!/usr/bin/env node
import { chromium } from 'playwright-core';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index]?.replace(/^--/, ''), process.argv[index + 1]);
}
const baseUrl = args.get('url') ?? 'http://127.0.0.1:5199/';
const maps = (args.get('maps') ?? 'yale-street,belmont-research-center,el-camino-road,easterbrook-discovery-school,richmond-field-station').split(',');
const presets = ['roads-only', 'ultra-low-3d', 'minimal', 'high'];
const software = args.get('software') === 'true';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: software ? ['--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] : ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});

const failures = [];
const results = [];
try {
  for (const map of maps) {
    for (const preset of presets) {
      const context = await browser.newContext({ viewport: { width: 1360, height: 850 } });
      const page = await context.newPage();
      const errors = [];
      const requests = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', (response) => {
        if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
      });
      page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.includes('/3d/')) requests.push(pathname);
      });
      const target = new URL(baseUrl);
      target.searchParams.set('map', map);
      const started = performance.now();
      try {
        await page.goto(target.toString(), { waitUntil: 'load' });
        await page.click(`[data-testid="graphics-choice-${preset}"]`);
        await page.waitForFunction(() => window.__viewer?.getStats().roadVisible === true, null, { timeout: 30_000 });
        const usableMs = performance.now() - started;
        await page.waitForFunction(() => {
          const stats = window.__viewer?.getStats();
          return stats && stats.loading + stats.queued + stats.uploading === 0 && stats.streamingError === null;
        }, null, { timeout: 45_000 });
        const sample = await page.evaluate(() => ({
          preference: JSON.parse(localStorage.getItem('simforge-oss.studio.render-quality.v1') ?? 'null'),
          stats: window.__viewer?.getStats(),
        }));
        if (sample.preference?.preset !== preset) errors.push(`selected ${preset}, persisted ${sample.preference?.preset}`);
        if (sample.stats?.streamingError) errors.push(sample.stats.streamingError);
        if (preset === 'roads-only') {
          const excluded = requests.filter((path) => /\/tiles\/(?:tile_|veg_)|\.instances\.json$/.test(path));
          if (excluded.length) errors.push(`Roads Only fetched excluded assets: ${excluded.join(', ')}`);
        }
        results.push({ map, preset, usableMs, settledMs: performance.now() - started, requests: requests.length, errors });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        results.push({ map, preset, errors });
      } finally {
        if (errors.length) failures.push(`${map}/${preset}: ${errors.join('; ')}`);
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}

for (const result of results) {
  console.log(`${result.map} ${result.preset}: ${result.usableMs?.toFixed(0) ?? '—'} ms usable, ${result.settledMs?.toFixed(0) ?? '—'} ms settled${result.errors.length ? ` · ${result.errors.join('; ')}` : ''}`);
}
if (failures.length) throw new Error(`Render preset browser verification failed:\n${failures.join('\n')}`);

