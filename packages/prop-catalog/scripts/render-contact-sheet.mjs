/**
 * Build the contact sheet and screenshot it.
 *
 *   node scripts/render-contact-sheet.mjs [outputPath]
 *
 * Bundles `contact-sheet/` with vite, serves the output over loopback (module
 * scripts are blocked under `file://`), opens it in a headless Chromium
 * (playwright-core, using whichever Chromium build is already installed) and
 * writes a full-page PNG. Default output: /tmp/prop-catalog-sheet.png.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const out = process.argv[2] ?? '/tmp/prop-catalog-sheet.png';

// --- build
execFileSync(resolve(pkgRoot, 'node_modules/.bin/vite'), ['build', '--config', 'contact-sheet/vite.config.ts'], {
  cwd: pkgRoot,
  stdio: 'inherit',
});
const dist = resolve(pkgRoot, '.contact-sheet-dist');
if (!existsSync(join(dist, 'index.html'))) {
  throw new Error(`vite build produced no index.html in ${dist}`);
}

// --- serve (ES modules are blocked under file://)
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  const file = join(dist, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(dist) || !existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { port } = server.address();

/**
 * Chromium for the screenshot. Prefers an explicit override, then the
 * Playwright cache for this platform, then a system Chrome — this used to look
 * only in the macOS cache, so the script could not run on Linux at all.
 */
function findChromium() {
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (override) {
    if (!existsSync(override)) throw new Error(`PLAYWRIGHT_CHROMIUM_EXECUTABLE not found: ${override}`);
    return override;
  }
  const home = process.env.HOME ?? '';
  const caches = [join(home, '.cache/ms-playwright'), join(home, 'Library/Caches/ms-playwright')];
  const tails = [
    'chrome-linux/chrome',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
    'chrome-win/chrome.exe',
  ];
  for (const cache of caches.filter((path) => existsSync(path))) {
    const builds = readdirSync(cache)
      .filter((name) => name.startsWith('chromium-'))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const name of builds) {
      for (const tail of tails) {
        const exe = join(cache, name, tail);
        if (existsSync(exe)) return exe;
      }
    }
  }
  for (const system of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(system)) return system;
  }
  throw new Error('no chromium build found; set PLAYWRIGHT_CHROMIUM_EXECUTABLE');
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: [
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--disable-lcd-text',
    '--force-color-profile=srgb',
  ],
});
const page = await browser.newPage({ viewport: { width: 2500, height: 1400 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  // favicon.ico is not part of the bundle; everything else is a real failure.
  const text = message.text();
  if (message.type() === 'error' && !text.includes('favicon')) errors.push(text);
});
page.on('requestfailed', (request) => {
  if (!request.url().includes('favicon')) errors.push(`request failed: ${request.url()}`);
});

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
try {
  await page.waitForFunction(() => window.__SHEET_READY === true, null, { timeout: 180_000 });
} catch (error) {
  process.stderr.write(`sheet never became ready.\n${errors.join('\n')}\n`);
  throw error;
}
const [width, height] = await page.evaluate(() => window.__SHEET_SIZE);
await page.setViewportSize({ width, height: Math.min(height, 8000) });
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
await page.screenshot({ path: out, fullPage: true });
await browser.close();
server.close();

if (errors.length) {
  process.stderr.write(`page errors:\n${errors.join('\n')}\n`);
  process.exitCode = 1;
}
process.stdout.write(`contact sheet: ${out} (${width}x${height})\n`);
