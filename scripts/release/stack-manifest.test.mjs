import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildStackManifest, serializeStackManifest } from './stack-manifest-lib.mjs';

const SHA = 'a'.repeat(40);

async function fixture(overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'uniscenarios-stack-'));
  const config = {
    schema: 'uniscenarios.stack-config/v1',
    stackVersion: '1.2.3',
    repository: 'https://example.test/uniscenarios',
    contracts: { scenarioTemplate: '2', simulationStepSeconds: 0.02 },
    packages: [
      { path: 'packages/model', role: 'scenario-contract' },
      { path: 'packages/engine', role: 'simulation-kernel' },
    ],
  };
  await mkdir(path.join(root, 'config'), { recursive: true });
  await mkdir(path.join(root, 'packages/model'), { recursive: true });
  await mkdir(path.join(root, 'packages/engine'), { recursive: true });
  await writeFile(path.join(root, 'config/simforge-stack.json'), JSON.stringify(config));
  await writeFile(path.join(root, 'packages/model/package.json'), JSON.stringify({
    name: '@simforge/model', version: '1.2.3', license: 'Apache-2.0',
    main: './dist/index.js', types: './dist/index.d.ts', files: ['dist'],
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    publishConfig: { access: 'public', provenance: true },
    repository: { directory: 'packages/model' }, ...overrides.model,
  }));
  await writeFile(path.join(root, 'packages/engine/package.json'), JSON.stringify({
    name: '@simforge/engine', version: '1.2.3', license: 'Apache-2.0',
    main: './dist/index.js', types: './dist/index.d.ts', files: ['dist'],
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    publishConfig: { access: 'public', provenance: true },
    repository: { directory: 'packages/engine' },
    dependencies: { '@simforge/model': 'workspace:*' }, ...overrides.engine,
  }));
  return root;
}

test('builds a deterministic exact stack manifest', async () => {
  const repoRoot = await fixture();
  const manifest = await buildStackManifest({ repoRoot, sourceRevision: SHA });
  assert.equal(manifest.source.revision, SHA);
  assert.deepEqual(manifest.packages, [
    { name: '@simforge/model', version: '1.2.3', role: 'scenario-contract' },
    { name: '@simforge/engine', version: '1.2.3', role: 'simulation-kernel' },
  ]);
  assert.deepEqual(manifest.pythonPackages, []);
  assert.equal(serializeStackManifest(manifest), `${JSON.stringify(manifest, null, 2)}\n`);
});

test('binds PyPI adapters to the PEP 440 form of the stack version', async () => {
  const repoRoot = await fixture();
  const configPath = path.join(repoRoot, 'config/simforge-stack.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.stackVersion = '1.2.3-rc.4';
  config.pythonPackages = [{
    path: 'adapters/carla-exec', name: 'uniscenarios-carla-bridge',
    version: '1.2.3rc4', role: 'optional-carla-execution-adapter', registry: 'pypi',
  }];
  await writeFile(configPath, JSON.stringify(config));
  await mkdir(path.join(repoRoot, 'adapters/carla-exec'), { recursive: true });
  await writeFile(path.join(repoRoot, 'adapters/carla-exec/pyproject.toml'), [
    '[project]',
    'name = "uniscenarios-carla-bridge"',
    'version = "1.2.3rc4"',
    'license = "Apache-2.0"',
    '',
  ].join('\n'));
  const manifest = await buildStackManifest({ repoRoot, sourceRevision: SHA });
  assert.deepEqual(manifest.pythonPackages, [{
    name: 'uniscenarios-carla-bridge', version: '1.2.3rc4',
    role: 'optional-carla-execution-adapter', ecosystem: 'pypi',
  }]);
});

test('rejects private packages and version-skewed internal dependencies', async () => {
  const privateRoot = await fixture({ model: { private: true } });
  await assert.rejects(
    buildStackManifest({ repoRoot: privateRoot, sourceRevision: SHA }),
    /private and cannot be part of the public stack/u,
  );

  const skewedRoot = await fixture({ engine: { dependencies: { '@simforge/model': '^1.2.3' } } });
  await assert.rejects(
    buildStackManifest({ repoRoot: skewedRoot, sourceRevision: SHA }),
    /must pin @uniscenarios\/model to the stack version 1.2.3/u,
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
