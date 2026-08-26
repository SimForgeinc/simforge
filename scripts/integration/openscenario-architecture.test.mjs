import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), 'utf8'));

async function exists(relative) {
  try { await access(path.join(root, relative)); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function sourceFiles(relative) {
  const directory = path.join(root, relative);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  return entries.filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name));
}

test('OpenSCENARIO standards behavior has one package owner', async () => {
  const canonical = await readJson('packages/openscenario/package.json');
  const cli = await readJson('packages/cli/package.json');

  // The esmini runner is consolidated into @simforge-oss/openscenario itself.
  assert.equal(canonical.dependencies?.['@simforge-oss/cli'], undefined);
  assert.equal(cli.dependencies?.['@simforge-oss/openscenario'], 'workspace:*');
  assert.deepEqual(await sourceFiles('packages/cli/src/asam'), []);
  assert.equal(await exists('packages/openscenario/src/export/index.ts'), true);
  assert.equal(await exists('packages/openscenario/src/node/index.ts'), true);
});

test('Studio imports the standards package instead of CLI internals', async () => {
  const roots = ['studio/app'];
  const pending = [...roots];
  const violations = [];
  while (pending.length) {
    const relative = pending.pop();
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) pending.push(child);
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/u.test(entry.name)) continue;
      const source = await readFile(path.join(root, child), 'utf8');
      if (source.includes('@simforge-oss/cli/asam') || source.includes('packages/cli/src/asam')) violations.push(child);
    }
  }
  assert.deepEqual(violations, []);
  assert.ok((await sourceFiles('packages/openscenario/src/export')).length > 0);
});
