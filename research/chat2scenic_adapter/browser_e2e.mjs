import { chromium } from 'playwright-core';

const target = process.env.SIMFORGE_E2E_URL ?? 'http://127.0.0.1:5309/?map=richmond-field-station';
const screenshotBefore = process.env.SIMFORGE_E2E_BEFORE ?? '/private/tmp/chat2scenic-upstream-before-apply.png';
const screenshotAfter = process.env.SIMFORGE_E2E_AFTER ?? '/private/tmp/chat2scenic-upstream-after-apply.png';
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 500)); });
page.on('pageerror', (error) => consoleErrors.push(error.message.slice(0, 500)));

try {
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const chooser = page.getByTestId('first-run-graphics-chooser');
  if (await chooser.isVisible().catch(() => false)) await page.getByTestId('graphics-choice-roads-only').click();
  await page.getByRole('button', { name: 'Scenario Copilot' }).waitFor({ timeout: 180_000 });
  await page.getByRole('button', { name: 'Scenario Copilot' }).click();
  await page.getByRole('button', { name: /Upstream Chat2Scenic/ }).click();
  await page.getByTestId('scenario-copilot-prompt').fill('A sedan approaches a pedestrian emerging from behind a stopped van on the current road. The pedestrian starts after four seconds and the sedan brakes for a near miss without collision.');
  await page.getByTestId('scenario-copilot-generate').click();
  const candidate = page.getByTestId('scenario-copilot-candidate').first();
  const alert = page.getByRole('alert');
  const outcome = await Promise.race([
    candidate.waitFor({ timeout: 900_000 }).then(() => 'candidate'),
    alert.waitFor({ timeout: 900_000 }).then(() => 'error'),
  ]);
  if (outcome === 'error') throw new Error(`Scenario Copilot UI error: ${await alert.innerText()}`);
  await candidate.getByText(/Canonical simulation passed/).waitFor({ timeout: 300_000 });
  const candidateText = await candidate.innerText();
  const runText = await page.locator('[data-testid="scenario-copilot-panel"]').innerText();
  await page.screenshot({ path: screenshotBefore, fullPage: true });
  await candidate.getByTestId('scenario-copilot-apply').click();
  await page.getByTestId('scenario-copilot-panel').waitFor({ state: 'detached', timeout: 30_000 });
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: screenshotAfter, fullPage: true });
  const bodyText = await page.locator('body').innerText();
  const actorLabels = ['Ego vehicle', 'pedestrian', 'van'].filter((label) => bodyText.toLowerCase().includes(label.toLowerCase()));
  process.stdout.write(`${JSON.stringify({
    target,
    canonicalSimulationPassed: /Canonical simulation passed/.test(candidateText),
    actorCount: Number(/passed · (\d+) actors/.exec(candidateText)?.[1] ?? 0),
    durationS: Number(/actors · ([\d.]+) s/.exec(candidateText)?.[1] ?? 0),
    model: /gpt-5\.6-luna/.test(runText) ? 'gpt-5.6-luna' : 'not-observed',
    scenicCompiled: /compiled yes/.test(candidateText),
    scenicSampled: /sampled yes/.test(candidateText),
    applied: true,
    visibleActorLabels: actorLabels,
    consoleErrors,
    screenshotBefore,
    screenshotAfter,
  }, null, 2)}\n`);
} finally {
  await browser.close();
}
