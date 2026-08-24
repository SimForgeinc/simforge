#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index]?.replace(/^--/, ''), process.argv[index + 1]);
}

const url = args.get('url') ?? 'http://localhost:5204/?map=yale-street';
const instancePath = path.resolve(
  args.get('instance') ?? 'artifacts/qa/simforge-traffic-light-slice/yale-signal.instance.json',
);
const tracePath = path.resolve(
  args.get('trace') ?? 'artifacts/qa/simforge-traffic-light-slice/yale-signal.trace.json.gz',
);
const outDir = path.resolve(
  args.get('out') ?? 'artifacts/qa/simforge-traffic-light-standalone',
);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

await mkdir(outDir, { recursive: true });

const browserErrors = [];
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--window-size=1680,1050'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 960 } });
const page = await context.newPage();
page.on('console', (message) => {
  if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
});
page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
page.on('requestfailed', (request) => {
  const reason = request.failure()?.errorText ?? '';
  if (!reason.includes('ERR_ABORTED')) browserErrors.push(`request: ${reason} ${request.url()}`);
});
page.on('response', (response) => {
  if (response.status() >= 400) browserErrors.push(`http ${response.status()} ${response.url()}`);
});

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () => Boolean(window.__viewer && window.__overlays && window.__editor),
    null,
    { timeout: 180_000 },
  );
  await page.locator('[data-testid="instance-file"]').setInputFiles(instancePath);
  await page.locator('[data-testid="trace-file"]').setInputFiles(tracePath);
  await page.locator('[data-testid="load-playback"]').click();
  await page.waitForFunction(
    () =>
      window.__playback?.state.signalHeadCount === 18 &&
      window.__playback?.state.renderedSignalHeadCount === 18,
    null,
    { timeout: 60_000 },
  );

  const samples = [];
  for (const sample of [
    { time: 0, expected: { green: 6, yellow: 0, red: 12 } },
    { time: 4.63, expected: { green: 0, yellow: 6, red: 12 } },
  ]) {
    await page.locator('[data-testid="timeline"]').fill(String(sample.time));
    await page.waitForFunction(
      (time) => Math.abs((window.__playback?.state.time ?? -999) - time) < 0.001,
      sample.time,
    );
    await page.waitForTimeout(250);
    const observed = await page.evaluate(() => {
      const playback = window.__playback;
      if (!playback) throw new Error('window.__playback is unavailable');
      return {
        time: playback.state.time,
        signalPrograms: playback.state.signalCount,
        signalHeads: playback.state.signalHeadCount,
        renderedSignalHeads: playback.state.renderedSignalHeadCount,
        phases: playback.state.signalPhases,
        timingSources: playback.state.signalTimingSources,
        ui: document.querySelector('[data-testid="playback-signals"]')?.textContent?.trim() ?? null,
      };
    });
    if (JSON.stringify(observed.phases) !== JSON.stringify(sample.expected)) {
      throw new Error(
        `unexpected phases at t=${sample.time}: expected ${JSON.stringify(sample.expected)}, got ${JSON.stringify(observed.phases)}`,
      );
    }
    const screenshotPath = path.join(outDir, `signals-t${sample.time.toFixed(2)}.png`);
    await page.screenshot({ path: screenshotPath });
    samples.push({
      ...observed,
      screenshot: {
        file: path.basename(screenshotPath),
        sha256: sha256(await readFile(screenshotPath)),
      },
    });
  }

  if (browserErrors.length > 0) {
    throw new Error(`browser errors: ${browserErrors.join('\n')}`);
  }

  const instanceBytes = await readFile(instancePath);
  const traceBytes = await readFile(tracePath);
  const manifest = {
    schema: 'uniscenarios.traffic-light-playback-evidence.v1',
    generatedAt: new Date().toISOString(),
    url,
    scenarioId: await page.evaluate(() => window.__playback?.state.instanceId ?? null),
    mapId: 'yale-street',
    source: {
      instance: { file: path.relative(process.cwd(), instancePath), sha256: sha256(instanceBytes) },
      trace: { file: path.relative(process.cwd(), tracePath), sha256: sha256(traceBytes) },
    },
    samples,
    browserErrors,
    acceptance: {
      exactSignalHeadCount: samples.every(
        (sample) => sample.signalHeads === 18 && sample.renderedSignalHeads === 18,
      ),
      greenToYellowTransition:
        samples[0]?.phases.green === 6 &&
        samples[0]?.phases.red === 12 &&
        samples[1]?.phases.yellow === 6 &&
        samples[1]?.phases.red === 12,
      browserErrorCount: browserErrors.length,
    },
  };
  const manifestPath = path.join(outDir, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ manifest: manifestPath, acceptance: manifest.acceptance }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
