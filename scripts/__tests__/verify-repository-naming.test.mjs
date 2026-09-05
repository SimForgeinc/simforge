import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';

import { PACKAGE_NAMES, STACK_PACKAGE_NAMES, verifyRepositoryNaming } from '../verify-repository-naming.mjs';



function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'simforge-naming-'));
  mkdirSync(join(root, 'packages'), { recursive: true });
  for (const name of PACKAGE_NAMES) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({
      name: `@simforge-oss/${name}`,
      version: '0.1.0-rc.45',
      ...(name === 'cli' ? { bin: { simforge: './bin/simforge.js', sf: './bin/sf.js' } } : {}),
    }));
  }
  mkdirSync(join(root, 'studio'), { recursive: true });
  writeFileSync(join(root, 'studio', 'package.json'), JSON.stringify({ name: '@simforge-oss/studio' }));
  mkdirSync(join(root, 'renderer'), { recursive: true });
  writeFileSync(join(root, 'renderer', 'Cargo.toml'), '[workspace]\n');
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'simforge-oss-stack.json'), JSON.stringify({
    stackVersion: '0.1.0-rc.45',
    packages: STACK_PACKAGE_NAMES.map((name) => ({ name: `@simforge-oss/${name}`, version: '0.1.0-rc.45' })),
  }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'simforge', private: true }));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('rejects retired package imports', () => {
  const item = fixture();
  try {
    writeFileSync(join(item.root, 'packages', 'cli', 'legacy.ts'), "import x from '@uni" + "scenarios/cli';\n");
    assert.throws(() => verifyRepositoryNaming(item.root), /imports the retired package scope/);
  } finally { item.cleanup(); }
});

test('rejects the previous SimForge package scope', () => {
  const item = fixture();
  try {
    writeFileSync(join(item.root, 'packages', 'cli', 'legacy-scope.ts'), "import x from '@simforge" + "/cli';\n");
    assert.throws(() => verifyRepositoryNaming(item.root), /imports the retired @simforge package scope/);
  } finally { item.cleanup(); }
});

test('rejects removed directories and package drift', () => {
  const item = fixture();
  try {
    mkdirSync(join(item.root, 'apps', 'studio'), { recursive: true });
    assert.throws(() => verifyRepositoryNaming(item.root), /apps\/studio must not exist/);
  } finally { item.cleanup(); }
});
