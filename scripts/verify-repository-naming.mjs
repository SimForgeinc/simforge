#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAMES = [
  'scenario',
  'engine',
  'maps',
  'compiler',
  'viewer',
  'editor',
  'playback',
  'asset-catalog',
  'render',
  'openscenario',
  'training-env',
  'evaluation',
  'cli',
];

const REMOVED_PATHS = [
  'apps/studio',
  'apps/cloud',
  'native',
  'packages/editor-ui',
  'packages/scenario-model',
  'packages/sim-engine',
  'packages/scene-state',
  'packages/xodr-tools',
  'packages/map-intel',
  'packages/anchor-matcher',
  'packages/scenario-materializer',
  'packages/city-renderer',
  'packages/camera-rig',
  'packages/editor-core',
  'packages/ambient-traffic',
  'packages/prop-catalog',
  'packages/render-runtime',
  'packages/browser-renderer',
  'packages/native-renderer',
  'packages/esmini-runner',
  'packages/trace-comparator',
  'packages/rl-env',
  'packages/policy-eval',
  'packages/examiner',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sourceFiles(root) {
  const files = [];
  const pending = [root];
  const ignored = new Set(['.git', '.next', 'dist', 'docs', 'node_modules']);
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (/\.(?:[cm]?[jt]sx?|json|ya?ml)$/u.test(entry.name)) files.push(path);
    }
  }
  return files;
}

export function verifyRepositoryNaming(root) {
  const errors = [];
  const rootManifest = readJson(join(root, 'package.json'));
  if (rootManifest.name !== 'simforge') errors.push('package.json name must be "simforge"');

  const actualPackages = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort();
  const expectedPackages = [...PACKAGE_NAMES].sort();
  if (JSON.stringify(actualPackages) !== JSON.stringify(expectedPackages)) {
    errors.push(`packages/ must contain exactly: ${expectedPackages.join(', ')}`);
  }
  for (const name of PACKAGE_NAMES) {
    const path = join(root, 'packages', name, 'package.json');
    if (!existsSync(path)) continue;
    const manifest = readJson(path);
    if (manifest.name !== `@simforge/${name}`) errors.push(`packages/${name}/package.json must be named @simforge/${name}`);
    if (manifest.version !== '0.1.0-rc.45') errors.push(`packages/${name}/package.json must remain at 0.1.0-rc.45`);
  }

  const studio = readJson(join(root, 'studio', 'package.json'));
  if (studio.name !== '@simforge/studio') errors.push('studio/package.json must be named @simforge/studio');
  for (const path of REMOVED_PATHS) {
    if (existsSync(join(root, path))) errors.push(`${path} must not exist`);
  }
  if (!existsSync(join(root, 'renderer', 'Cargo.toml'))) errors.push('renderer/Cargo.toml must exist');

  const cli = readJson(join(root, 'packages/cli/package.json'));
  const expectedBins = { simforge: './bin/simforge.js', sf: './bin/sf.js', uniscenarios: './bin/uniscenarios.js' };
  if (JSON.stringify(cli.bin) !== JSON.stringify(expectedBins)) errors.push('CLI bins must be simforge, sf, and deprecated uniscenarios');

  const stack = readJson(join(root, 'config/simforge-stack.json'));
  if (stack.packages?.length !== 13) errors.push('config/simforge-stack.json must contain 13 packages');
  const stackNames = (stack.packages ?? []).map((item) => item.name).sort();
  const packageNames = PACKAGE_NAMES.map((name) => `@simforge/${name}`).sort();
  if (JSON.stringify(stackNames) !== JSON.stringify(packageNames)) errors.push('stack package names must match the 13-package workspace');
  if (!stack.renameManifest || Object.keys(stack.renameManifest).length < 23) errors.push('stack renameManifest must cover every former package');

  const legacyImport = /(?:from\s*|import\s*\(|require\s*\()\s*['"]@uniscenarios\//u;
  for (const path of sourceFiles(root)) {
    const source = readFileSync(path, 'utf8');
    if (legacyImport.test(source)) errors.push(`${relative(root, path)} imports the retired @uniscenarios scope`);
  }

  if (errors.length) throw new Error(`Repository naming verification failed:\n- ${errors.join('\n- ')}`);
  return { packageCount: PACKAGE_NAMES.length, scannedFiles: sourceFiles(root).length };
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = verifyRepositoryNaming(root);
  process.stdout.write(`SimForge naming verified (${result.packageCount} packages, ${result.scannedFiles} files).\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
