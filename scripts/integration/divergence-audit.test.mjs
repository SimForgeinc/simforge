import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { auditDivergence } from './divergence-audit-lib.mjs';

async function write(root, file, content) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function fixture() {
  const simforgeRoot = await mkdtemp(path.join(tmpdir(), 'simforge-audit-'));
  const simcloudRoot = await mkdtemp(path.join(tmpdir(), 'simcloud-audit-'));
  const tarball = Buffer.from('immutable package');
  const wheel = Buffer.from('immutable Python wheel');
  const sha256 = createHash('sha256').update(tarball).digest('hex');
  const wheelSha256 = createHash('sha256').update(wheel).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  const integration = {
    schema: 'uniscenarios.simcloud-integration/v2',
    platformRepository: 'https://example.test/simcloud',
    sourceStackConfig: 'config/simforge-stack.json',
    vendorLock: 'vendor/uniscenarios/stack-lock.json',
    consumerManifest: 'package.json',
    consumerLock: 'package-lock.json',
    pythonConsumerManifest: 'services/worker/pyproject.toml',
    pythonConsumerLock: 'services/worker/uv.lock',
    requireExactSourceRevision: false,
    forbiddenPaths: ['packages/private-engine'],
    adapterSurfaces: [{ id: 'playback', path: 'app/playback', allowedFiles: ['adapter.ts'] }],
    sourceScanRoots: ['app'],
    importScanIgnoreFiles: [],
    forbiddenImportPatterns: ['@private/engine'],
  };
  const stack = {
    schema: 'uniscenarios.stack-config/v1',
    stackVersion: '1.2.3',
    repository: 'https://example.test/simforge',
    packages: [{ path: 'packages/engine', role: 'simulation-kernel' }],
    pythonPackages: [{
      path: 'adapters/carla-exec', name: 'simforge-carla-exec',
      version: '1.2.3', role: 'optional-carla-execution-adapter', registry: 'pypi',
    }],
  };
  const vendorLock = {
    schema: 'simcloud.uniscenarios-vendor/v1',
    stackVersion: '1.2.3',
    source: { repository: stack.repository, revision: 'a'.repeat(40) },
    packages: [{
      name: '@simforge/engine', version: '1.2.3', role: 'simulation-kernel',
      tarball: 'engine-1.2.3.tgz', sha256,
    }],
    pythonPackages: [{
      name: 'simforge-carla-exec', version: '1.2.3',
      role: 'optional-carla-execution-adapter', registry: 'pypi',
      wheel: 'simforge_carla_exec-1.2.3-py3-none-any.whl', sha256: wheelSha256,
    }],
  };
  await write(simforgeRoot, 'config/simcloud-integration.json', JSON.stringify(integration));
  await write(simforgeRoot, 'config/simforge-stack.json', JSON.stringify(stack));
  await write(simforgeRoot, 'packages/engine/package.json', JSON.stringify({ name: '@simforge/engine', version: '1.2.3' }));
  await write(simcloudRoot, 'vendor/uniscenarios/stack-lock.json', JSON.stringify(vendorLock));
  await write(simcloudRoot, 'vendor/uniscenarios/engine-1.2.3.tgz', tarball);
  await write(simcloudRoot, 'vendor/uniscenarios/simforge_carla_exec-1.2.3-py3-none-any.whl', wheel);
  await write(simcloudRoot, 'package.json', JSON.stringify({ dependencies: { '@simforge/engine': 'file:vendor/uniscenarios/engine-1.2.3.tgz' } }));
  await write(simcloudRoot, 'package-lock.json', JSON.stringify({ packages: { 'node_modules/@simforge/engine': { resolved: 'file:vendor/uniscenarios/engine-1.2.3.tgz', integrity } } }));
  await write(simcloudRoot, 'services/worker/pyproject.toml', 'dependencies = ["simforge-carla-exec==1.2.3"]');
  await write(simcloudRoot, 'services/worker/uv.lock', 'simforge_carla_exec-1.2.3-py3-none-any.whl');
  await write(simcloudRoot, 'app/playback/adapter.ts', 'export const cloudAdapter = true;');
  return { simforgeRoot, simcloudRoot };
}

test('passes when SimCloud consumes the exact immutable stack and only product adapters', async () => {
  const roots = await fixture();
  await write(roots.simcloudRoot, 'app/.next/generated.js', "import '@private/engine';");
  await write(roots.simcloudRoot, 'app/.omc/project-memory.json', '"@private/engine"');
  await write(roots.simcloudRoot, 'app/public/model.glb', "import '@private/engine';");
  await write(roots.simcloudRoot, 'app/.terraform/provider.js', "import '@private/engine';");
  const report = await auditDivergence({ ...roots, includeGitRevisions: false });
  assert.equal(report.status, 'pass');
  assert.equal(report.packages[0].status, 'pass');
  assert.equal(report.pythonPackages[0].status, 'pass');
  assert.deepEqual(report.violations, []);
});

test('fails closed on package skew, private copies, unapproved adapters, and legacy imports', async () => {
  const roots = await fixture();
  await write(roots.simcloudRoot, 'packages/private-engine/index.ts', 'export {};');
  await write(roots.simcloudRoot, 'app/playback/copied-controller.ts', 'export {};');
  await write(roots.simcloudRoot, 'app/legacy.ts', "import '@private/engine';");
  const manifest = { dependencies: { '@simforge/engine': '^1.2.3' } };
  await write(roots.simcloudRoot, 'package.json', JSON.stringify(manifest));

  const report = await auditDivergence({ ...roots, includeGitRevisions: false });
  assert.equal(report.status, 'fail');
  assert.deepEqual(
    new Set(report.violations.map(({ code }) => code)),
    new Set(['PACKAGE_CONTRACT_MISMATCH', 'FORBIDDEN_IMPLEMENTATION', 'UNAPPROVED_ADAPTER_FILE', 'FORBIDDEN_IMPORT']),
  );
});
