import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildStackManifest, serializeStackManifest } from './stack-manifest-lib.mjs';

const SHA = 'a'.repeat(40);

const PACKAGE_NAMES = [
  'model', 'engine', 'maps', 'compiler', 'viewer', 'editor', 'playback',
  'asset-catalog', 'render', 'openscenario', 'training-env', 'evaluation', 'cli',
];
const RETIRED_NAMES = [
  'ambient-traffic', 'anchor-matcher', 'browser-renderer', 'camera-rig',
  'city-renderer', 'cli', 'editor-core', 'editor-ui', 'esmini-runner',
  'examiner', 'map-intel', 'native-renderer', 'openscenario', 'playback',
  'policy-eval', 'prop-catalog', 'render-runtime', 'rl-env',
  'scenario-materializer', 'scenario-model', 'scene-state', 'sim-engine',
  'trace-comparator', 'xodr-tools',
];
const LEGACY_MODEL_PACKAGE = ['@simforge', 'model'].join('/');


async function fixture(overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'simforge-stack-'));
  const config = {
    schema: 'simforge-oss.stack-config/v1',
    stackVersion: '1.2.3',
    repository: 'https://example.test/simforge',
    contracts: { scenarioTemplate: '2', simulationStepSeconds: 0.02 },
    packages: PACKAGE_NAMES.map((name) => ({
      name: `@simforge-oss/${name}`,
      version: '1.2.3',
      path: `packages/${name}`,
      role: `${name}-role`,
    })),
    renameManifest: Object.fromEntries(
      RETIRED_NAMES.map((name) => [`@uniscenarios/${name}`, LEGACY_MODEL_PACKAGE]),
    ),
  };
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'config/simforge-oss-stack.json'), JSON.stringify(config));
  for (const name of PACKAGE_NAMES) {
    const directory = `packages/${name}`;
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, 'package.json'), JSON.stringify({
      name: `@simforge-oss/${name}`, version: '1.2.3', license: 'Apache-2.0',
      main: './dist/index.js', types: './dist/index.d.ts', files: ['dist'],
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      publishConfig: { access: 'public', provenance: true },
      repository: { directory },
      ...(name === 'engine' ? { dependencies: { '@simforge-oss/model': 'workspace:*' } } : {}),
      ...overrides[name],
    }));
  }
  return root;
}

test('builds a deterministic exact stack manifest', async () => {
  const repoRoot = await fixture();
  const manifest = await buildStackManifest({ repoRoot, sourceRevision: SHA });
  assert.equal(manifest.source.revision, SHA);
  assert.equal(manifest.packages.length, 13);
  assert.equal(manifest.schema, 'simforge-oss.stack/v1');
  assert.deepEqual(manifest.packages.slice(0, 2), [
    { name: '@simforge-oss/model', version: '1.2.3', role: 'model-role' },
    { name: '@simforge-oss/engine', version: '1.2.3', role: 'engine-role' },
  ]);
  assert.deepEqual(manifest.renameManifest, Object.fromEntries(
    RETIRED_NAMES.map((name) => [`@uniscenarios/${name}`, LEGACY_MODEL_PACKAGE]),
  ));
  assert.deepEqual(manifest.pythonPackages, []);
  assert.equal(serializeStackManifest(manifest), `${JSON.stringify(manifest, null, 2)}\n`);
});

test('binds PyPI adapters to the PEP 440 form of the stack version', async () => {
  const repoRoot = await fixture();
  const configPath = path.join(repoRoot, 'config/simforge-oss-stack.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.stackVersion = '1.2.3-rc.4';
  for (const entry of config.packages) entry.version = config.stackVersion;
  config.pythonPackages = [{
    path: 'adapters/carla-exec', name: 'simforge-oss-carla-exec',
    version: '1.2.3rc4', role: 'optional-carla-execution-adapter', registry: 'pypi',
  }];
  for (const name of PACKAGE_NAMES) {
    const packagePath = path.join(repoRoot, `packages/${name}/package.json`);
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
    packageJson.version = config.stackVersion;
    await writeFile(packagePath, JSON.stringify(packageJson));
  }
  await writeFile(configPath, JSON.stringify(config));
  await mkdir(path.join(repoRoot, 'adapters/carla-exec'), { recursive: true });
  await writeFile(path.join(repoRoot, 'adapters/carla-exec/pyproject.toml'), [
    '[project]',
    'name = "simforge-oss-carla-exec"',
    'version = "1.2.3rc4"',
    'license = "Apache-2.0"',
    '',
  ].join('\n'));
  const manifest = await buildStackManifest({ repoRoot, sourceRevision: SHA });
  assert.deepEqual(manifest.pythonPackages, [{
    name: 'simforge-oss-carla-exec', version: '1.2.3rc4',
    role: 'optional-carla-execution-adapter', ecosystem: 'pypi',
  }]);
});

test('rejects private packages and version-skewed internal dependencies', async () => {
  const privateRoot = await fixture({ model: { private: true } });
  await assert.rejects(
    buildStackManifest({ repoRoot: privateRoot, sourceRevision: SHA }),
    /private and cannot be part of the public stack/u,
  );

  const skewedRoot = await fixture({ engine: { dependencies: { '@simforge-oss/model': '^1.2.3' } } });
  await assert.rejects(
    buildStackManifest({ repoRoot: skewedRoot, sourceRevision: SHA }),
    /must pin @simforge-oss\/model to the stack version 1.2.3/u,
  );
});

test('requires a full immutable source revision', async () => {
  const repoRoot = await fixture();
  await assert.rejects(
    buildStackManifest({ repoRoot, sourceRevision: 'main' }),
    /full lowercase git SHA/u,
  );
});

test('rejects packages that publish TypeScript source instead of release artifacts', async () => {
  const repoRoot = await fixture({ model: {
    main: './src/index.ts',
    types: './src/index.ts',
    files: ['src'],
    exports: { '.': './src/index.ts' },
  } });
  await assert.rejects(
    buildStackManifest({ repoRoot, sourceRevision: SHA }),
    /must publish compiled dist entry points/u,
  );
});
