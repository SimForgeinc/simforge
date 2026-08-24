import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const REVISION_PATTERN = /^[0-9a-f]{40}$/u;

const RETIRED_PACKAGE_NAMES = [
  '@uniscenarios/ambient-traffic',
  '@uniscenarios/anchor-matcher',
  '@uniscenarios/browser-renderer',
  '@uniscenarios/camera-rig',
  '@uniscenarios/city-renderer',
  '@uniscenarios/cli',
  '@uniscenarios/editor-core',
  '@uniscenarios/editor-ui',
  '@uniscenarios/esmini-runner',
  '@uniscenarios/examiner',
  '@uniscenarios/map-intel',
  '@uniscenarios/native-renderer',
  '@uniscenarios/openscenario',
  '@uniscenarios/playback',
  '@uniscenarios/policy-eval',
  '@uniscenarios/prop-catalog',
  '@uniscenarios/render-runtime',
  '@uniscenarios/rl-env',
  '@uniscenarios/scenario-materializer',
  '@uniscenarios/scenario-model',
  '@uniscenarios/scene-state',
  '@uniscenarios/sim-engine',
  '@uniscenarios/trace-comparator',
  '@uniscenarios/xodr-tools',
];

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function currentRevision(repoRoot) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

function internalDependencies(packageJson) {
  const sections = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  return Object.fromEntries(sections.flatMap((section) => Object.entries(packageJson[section] ?? {})));
}

function normalizedPythonVersion(stackVersion) {
  return stackVersion.replace(/-rc\.(\d+)$/u, 'rc$1');
}

async function pythonPackages(repoRoot, config) {
  const result = [];
  for (const entry of config.pythonPackages ?? []) {
    if (entry.registry !== 'pypi') {
      throw new Error(`${entry.path} must publish through PyPI`);
    }
    const pyproject = await readFile(path.join(repoRoot, entry.path, 'pyproject.toml'), 'utf8');
    const project = pyproject.match(/\[project\]([\s\S]*?)(?:\n\[|$)/u)?.[1] ?? '';
    const field = (name) => project.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'mu'))?.[1];
    const name = field('name');
    const version = field('version');
    const license = field('license');
    if (name !== entry.name || version !== entry.version) {
      throw new Error(`${entry.path} PyPI identity must equal ${entry.name} ${entry.version}`);
    }
    if (version !== normalizedPythonVersion(config.stackVersion)) {
      throw new Error(`${entry.name} must use the PEP 440 form of stack version ${config.stackVersion}; found ${version}`);
    }
    if (license !== 'Apache-2.0') {
      throw new Error(`${entry.name} must declare the Apache-2.0 license`);
    }
    result.push({
      name,
      version,
      role: entry.role,
      ecosystem: 'pypi',
    });
  }
  return result;
}

function assertCompiledPackage(packageJson) {
  if (packageJson.main !== './dist/index.js' || packageJson.types !== './dist/index.d.ts') {
    throw new Error(`${packageJson.name} must publish compiled dist entry points`);
  }
  if (!Array.isArray(packageJson.files) || !packageJson.files.includes('dist')) {
    throw new Error(`${packageJson.name} must include dist in published files`);
  }
  const rootExport = packageJson.exports?.['.'];
  if (rootExport?.default !== './dist/index.js' || rootExport?.types !== './dist/index.d.ts') {
    throw new Error(`${packageJson.name} must expose compiled root exports`);
  }
  for (const [name, target] of Object.entries(packageJson.bin ?? {})) {
    if (typeof target !== 'string' || target.includes('/src/') || target.endsWith('.ts')) {
      throw new Error(`${packageJson.name} binary ${name} must not execute TypeScript source`);
    }
  }
}

function assertRenameManifest(config, packageNames) {
  const entries = Object.entries(config.renameManifest ?? {});
  const sources = entries.map(([source]) => source).sort();
  if (JSON.stringify(sources) !== JSON.stringify(RETIRED_PACKAGE_NAMES)) {
    throw new Error('renameManifest must map exactly the 24 retired @uniscenarios package names');
  }
  for (const [source, target] of entries) {
    if (typeof target !== 'string') {
      throw new Error(`renameManifest target for ${source} must be a package or package subpath`);
    }
    const targetPackage = target.split('/').slice(0, 2).join('/');
    if (!packageNames.has(targetPackage)) {
      throw new Error(`renameManifest target ${target} is outside the 13-package stack`);
    }
  }
}

export async function buildStackManifest({ repoRoot, sourceRevision } = {}) {
  if (!repoRoot) throw new Error('repoRoot is required');

  const config = await readJson(path.join(repoRoot, 'config/simforge-stack.json'));
  if (config.schema !== 'simforge.stack-config/v1') {
    throw new Error(`Unsupported stack config schema: ${String(config.schema)}`);
  }

  const revision = sourceRevision ?? currentRevision(repoRoot);
  if (!REVISION_PATTERN.test(revision)) {
    throw new Error(`source revision must be a full lowercase git SHA: ${revision}`);
  }

  if (!Array.isArray(config.packages) || config.packages.length !== 13) {
    throw new Error('stack config must contain exactly 13 npm packages');
  }
  const configuredNames = new Set(config.packages.map((entry) => entry.name));
  if (configuredNames.size !== 13) {
    throw new Error('stack config package names must be unique');
  }
  assertRenameManifest(config, configuredNames);

  const packages = [];
  const versions = new Map();
  for (const entry of config.packages) {
    const packageJson = await readJson(path.join(repoRoot, entry.path, 'package.json'));
    if (typeof packageJson.name !== 'string' || !packageJson.name.startsWith('@simforge/')) {
      throw new Error(`${entry.path} must declare an @simforge package name`);
    }
    if (packageJson.name !== entry.name || packageJson.version !== entry.version) {
      throw new Error(`${entry.path} identity must equal ${entry.name} ${entry.version}`);
    }
    if (packageJson.version !== config.stackVersion) {
      throw new Error(`${packageJson.name} must use stack version ${config.stackVersion}`);
    }
    if (packageJson.private === true) {
      throw new Error(`${packageJson.name} is private and cannot be part of the public stack`);
    }
    if (packageJson.license !== 'Apache-2.0') {
      throw new Error(`${packageJson.name} must declare the Apache-2.0 license`);
    }
    if (packageJson.publishConfig?.access !== 'public' || packageJson.publishConfig?.provenance !== true) {
      throw new Error(`${packageJson.name} must publish publicly with npm provenance`);
    }
    if (packageJson.repository?.directory !== entry.path) {
      throw new Error(`${packageJson.name} repository.directory must be ${entry.path}`);
    }
    assertCompiledPackage(packageJson);
    versions.set(packageJson.name, packageJson.version);
    packages.push({
      name: packageJson.name,
      version: packageJson.version,
      role: entry.role,
    });
  }

  for (const entry of config.packages) {
    const packageJson = await readJson(path.join(repoRoot, entry.path, 'package.json'));
    for (const [name, range] of Object.entries(internalDependencies(packageJson))) {
      const expected = versions.get(name);
      if (!expected) continue;
      if (range !== `workspace:*` && range !== `workspace:${expected}` && range !== expected) {
        throw new Error(`${packageJson.name} must pin ${name} to the stack version ${expected}; found ${range}`);
      }
    }
  }

  return {
    schema: 'simforge.stack/v1',
    stackVersion: config.stackVersion,
    source: {
      repository: config.repository,
      revision,
    },
    contracts: config.contracts,
    packages,
    pythonPackages: await pythonPackages(repoRoot, config),
    renameManifest: config.renameManifest,
  };
}

export function serializeStackManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
