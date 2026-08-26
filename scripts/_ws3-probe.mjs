
import { chromium } from 'playwright-core';
const url = 'http://127.0.0.1:5199/?map=belmont-office-park-belmont-ca&dpr=1';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist', '--window-size=1680,1080'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1 });
await ctx.addInitScript(() => {
  const key = 'uniscenarios.studio.render-quality.v1';
  window.localStorage.setItem(key, JSON.stringify({ preset: 'minimal' }));
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0,300)));
const t0 = Date.now();
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__viewer && window.__overlays && window.__editor), null, { timeout: 180000 });
console.log('app ready', Date.now() - t0, 'ms');
await page.waitForFunction(() => { const s = window.__viewer?.getStats?.(); return s ? s.residentTiles > 0 && s.loading === 0 && s.uploading === 0 : false; }, null, { timeout: 120000 });
console.log('stream idle', Date.now() - t0, 'ms');
const dom = await page.evaluate(() => {
  const root = document.querySelector('#root > div');
  const canvas = document.querySelector('canvas');
  return {
    rootChildren: root ? [...root.children].map((c) => c.tagName + '.' + (c.className || '')) : null,
    canvasParentChain: (() => { const chain = []; let n = canvas; while (n && n !== document.body) { chain.push(n.tagName + '#' + (n.id||'') + '.' + (typeof n.className === 'string' ? n.className : '')); n = n.parentElement; } return chain; })(),
    canvasBox: canvas ? { w: canvas.clientWidth, h: canvas.clientHeight, dw: canvas.width, dh: canvas.height } : null,
    canvasCount: document.querySelectorAll('canvas').length,
    quality: (() => { try { return JSON.parse(localStorage.getItem('uniscenarios.studio.render-quality.v1')); } catch { return null; } })(),
  };
});
console.log('DOM', JSON.stringify(dom, null, 1));

async function timed(name, fn) {
  const s = Date.now();
  try { const r = await fn(); console.log('OK  ', name, Date.now() - s, 'ms', r ?? ''); }
  catch (e) { console.log('FAIL', name, Date.now() - s, 'ms', String(e).slice(0, 200)); }
}
await timed('page.screenshot', () => page.screenshot({ path: '/tmp/vista-3d/p_page.png', timeout: 20000 }).then((b) => b.length));
const canvas = await page.$('canvas');
await timed('canvas.screenshot', () => canvas.screenshot({ path: '/tmp/vista-3d/p_canvas.png', timeout: 20000 }).then((b) => b.length));
// after hiding UI like the exporter does
await page.evaluate(() => {
  const root = document.querySelector('#root > div');
  for (const child of root.children) if (child.tagName !== 'CANVAS') child.style.visibility = 'hidden';
});
await timed('canvas.screenshot afterHideUi', () => canvas.screenshot({ path: '/tmp/vista-3d/p_canvas_hidden.png', timeout: 20000 }).then((b) => b.length));
await timed('page.screenshot afterHideUi', () => page.screenshot({ path: '/tmp/vista-3d/p_page_hidden.png', timeout: 20000 }).then((b) => b.length));
const cdp = await ctx.newCDPSession(page);
await timed('cdp captureScreenshot', async () => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); const fs = await import('node:fs/promises'); await fs.writeFile('/tmp/vista-3d/p_cdp.png', Buffer.from(r.data, 'base64')); return r.data.length; });
await timed('toDataURL', async () => { const d = await page.evaluate(() => document.querySelector('canvas').toDataURL('image/png').length); return d; });
await browser.close();
