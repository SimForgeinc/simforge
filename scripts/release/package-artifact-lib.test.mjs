import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyPackageArtifacts } from './package-artifact-lib.mjs';

async function fixture({ includeSchema = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'uniscenarios-artifacts-'));
  await mkdir(path.join(root, 'config'), { recursive: true });
  await mkdir(path.join(root, 'packages/openscenario/dist'), { recursive: true });
  await mkdir(path.join(root, 'packages/openscenario/schema'), { recursive: true });
  await writeFile(path.join(root, 'config/simforge-stack.json'), JSON.stringify({
    packages: [{ path: 'packages/openscenario' }],
  }));
  await writeFile(path.join(root, 'packages/openscenario/package.json'), JSON.stringify({
    name: '@simforge/openscenario',
    version: '1.0.0',
    main: './dist/index.js',
    exports: { '.': './dist/index.js', './schema/*': './schema/*' },
  }));
  await writeFile(path.join(root, 'packages/openscenario/dist/index.js'), 'export {};\n');
  if (includeSchema) {
    await writeFile(path.join(root, 'packages/openscenario/schema/OpenSCENARIO.xsd'), '<schema/>\n');
  }
  return root;
}

test('accepts wildcard exports when at least one packaged artifact matches', async () => {
  const repoRoot = await fixture();
  const verified = await verifyPackageArtifacts({ repoRoot });
  assert.deepEqual(verified, [{ name: '@simforge/openscenario', version: '1.0.0', targets: 2 }]);
});

test('rejects wildcard exports that match no packaged artifacts', async () => {
  const repoRoot = await fixture({ includeSchema: false });
  await assert.rejects(
    verifyPackageArtifacts({ repoRoot }),
    /export pattern \.\/schema\/\* does not match a packaged artifact/u,
  );
});
