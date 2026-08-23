import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { verifyRepositoryNaming } from '../verify-repository-naming.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'uniscenarios-naming-'));
  mkdirSync(join(root, 'packages/cli'), { recursive: true });
  mkdirSync(join(root, 'apps/cloud'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'uniscenarios', private: true }));
  writeFileSync(join(root, 'packages/cli/package.json'), JSON.stringify({
    name: '@uniscenarios/cli',
    bin: { uniscenarios: './bin/uniscenarios.js', scen: './bin/scen.js' },
  }));
  writeFileSync(join(root, 'apps/cloud/package.json'), JSON.stringify({ name: '@uniscenarios/studio' }));
  writeFileSync(join(root, 'README.md'), '# UniScenarios\n');
  writeFileSync(join(root, 'docs/repository-transition.md'), 'Historical source: Scenario Studio.\n');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('accepts canonical names and permits legacy naming only in transition history', (t) => {
  const item = fixture();
  t.after(item.cleanup);
  assert.deepEqual(verifyRepositoryNaming(item.root), {
    rootName: 'uniscenarios',
    packageScope: '@uniscenarios',
    workspacePackageCount: 2,
    documentationFileCount: 1,
  });
});

test('rejects legacy public documentation naming and a foreign package scope', (t) => {
  const item = fixture();
  t.after(item.cleanup);
  writeFileSync(join(item.root, 'README.md'), '# Scenario Studio\n');
  writeFileSync(join(item.root, 'apps/cloud/package.json'), JSON.stringify({ name: '@scenario-studio/studio' }));
  assert.throws(
    () => verifyRepositoryNaming(item.root),
    /apps\/studio\/package\.json name must use the @uniscenarios\/ scope[\s\S]*README\.md:1 contains a legacy public product name/,
  );
});

test('rejects a renamed root or compatibility-only CLI surface', (t) => {
  const item = fixture();
  t.after(item.cleanup);
  writeFileSync(join(item.root, 'package.json'), JSON.stringify({ name: 'scenario-tools', private: false }));
  writeFileSync(join(item.root, 'packages/cli/package.json'), JSON.stringify({
    name: '@uniscenarios/cli',
    bin: { scen: './bin/scen.js' },
  }));
  assert.throws(
    () => verifyRepositoryNaming(item.root),
    /package\.json name must be uniscenarios[\s\S]*workspace root private[\s\S]*CLI primary executable must be uniscenarios/,
  );
});
