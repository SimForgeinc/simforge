import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';

import { PACKAGE_NAMES, verifyRepositoryNaming } from '../verify-repository-naming.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'simforge-naming-'));
  mkdirSync(join(root, 'packages'), { recursive: true });
  for (const name of PACKAGE_NAMES) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({
      name: `@simforge/${name}`,
      version: '0.1.0-rc.45',
      ...(name === 'cli' ? { bin: { simforge: './bin/simforge.js', sf: './bin/sf.js', uniscenarios: './bin/uniscenarios.js' } } : {}),
    }));
  }
  mkdirSync(join(root, 'studio'), { recursive: true });
  writeFileSync(join(root, 'studio', 'package.json'), JSON.stringify({ name: '@simforge/studio' }));
  mkdirSync(join(root, 'renderer'), { recursive: true });
  writeFileSync(join(root, 'renderer', 'Cargo.toml'), '[workspace]\n');
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'simforge-stack.json'), JSON.stringify({
    packages: PACKAGE_NAMES.map((name) => ({ name: `@simforge/${name}` })),
    renameManifest: Object.fromEntries(Array.from({ length: 23 }, (_, index) => [`old-${index}`, `new-${index}`])),
  }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'simforge', private: true }));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('accepts the consolidated SimForge layout', () => {
  const item = fixture();
  try { assert.equal(verifyRepositoryNaming(item.root).packageCount, 13); }
  finally { item.cleanup(); }
});

test('rejects retired package imports', () => {
  const item = fixture();
  try {
    writeFileSync(join(item.root, 'packages', 'cli', 'legacy.ts'), "import x from '@" + "uniscenarios/cli';\n");
    assert.throws(() => verifyRepositoryNaming(item.root), /imports the retired @uniscenarios scope/);
  } finally { item.cleanup(); }
});

test('rejects removed directories and package drift', () => {
  const item = fixture();
  try {
    mkdirSync(join(item.root, 'apps', 'studio'), { recursive: true });
    assert.throws(() => verifyRepositoryNaming(item.root), /apps\/studio must not exist/);
  } finally { item.cleanup(); }
});
