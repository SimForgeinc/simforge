import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditDivergence } from './divergence-audit-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const platformArg = option('--platform-root') ?? process.env.SIMCLOUD_PLATFORM_ROOT;
if (!platformArg) {
  throw new Error('Usage: audit-simcloud-divergence.mjs --platform-root <path> [--out <file>]');
}

const report = await auditDivergence({
  simforgeRoot: repoRoot,
  simcloudRoot: path.resolve(platformArg),
});
const serialized = `${JSON.stringify(report, null, 2)}\n`;
const outputArg = option('--out');
if (outputArg) {
  const output = path.resolve(repoRoot, outputArg);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, serialized, 'utf8');
  process.stdout.write(`${path.relative(repoRoot, output)}\n`);
} else {
  process.stdout.write(serialized);
}
if (report.status !== 'pass') process.exitCode = 1;
