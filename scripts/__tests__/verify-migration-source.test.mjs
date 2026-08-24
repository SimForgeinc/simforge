import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createMigrationManifest, parseArgs as parseExtractionArgs } from '../extract-uniscenarios.mjs';
import { verifyMigrationSource } from '../verify-migration-source.mjs';

function runGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trimEnd();
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'uniscenarios-provenance-'));
  runGit(root, ['init', '-b', 'main']);
  runGit(root, ['config', 'user.name', 'Provenance Test']);
  runGit(root, ['config', 'user.email', 'provenance@example.invalid']);
  writeFileSync(join(root, 'tracked.txt'), 'committed\n');
  runGit(root, ['add', 'tracked.txt']);
  runGit(root, ['commit', '-m', 'fixture']);

  writeFileSync(join(root, 'tracked.txt'), 'dirty contents\n');
  writeFileSync(join(root, 'tool.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'tool.sh'), 0o755);
  symlinkSync('tracked.txt', join(root, 'tracked-link'));

  const head = runGit(root, ['rev-parse', 'HEAD']);
  const manifest = {
    schema: 'uniscenarios.repository-extraction.v2',
    capturedAt: '2026-08-01T00:00:00.000Z',
    source: {
      repositoryName: 'fixture',
      head,
      branch: 'main',
      dirty: true,
      status: [' M tracked.txt', '?? tool.sh', '?? tracked-link'],
    },
    packageScope: '@uniscenarios',
    cli: {
      primary: 'uniscenarios',
      compatibilityAlias: 'scen',
    },
    provenance: {
      reproducibility: {
        classification: 'verification-only-non-reconstructible',
        exactDirtySnapshotReconstructibleFromManifest: false,
      },
      sourceLocator: {
        kind: 'not-recorded',
        value: null,
        policy: 'The caller must supply a candidate checkout; no locator is asserted.',
      },
      verification: {
        checks: [
          'gitHead',
          'gitBranch',
          'gitStatusPorcelainV1',
          'materialPathSet',
          'fileKind',
          'posixMode',
          'sha256',
        ],
      },
    },
    files: [
      { path: 'tool.sh', kind: 'file', mode: '0755', sha256: digest('#!/bin/sh\nexit 0\n') },
      {
        path: 'tracked-link',
        kind: 'symlink',
        mode: `0${(lstatSync(join(root, 'tracked-link')).mode & 0o777).toString(8).padStart(3, '0')}`,
        sha256: digest('tracked.txt'),
      },
      { path: 'tracked.txt', kind: 'file', mode: '0644', sha256: digest('dirty contents\n') },
    ],
  };
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // The fixture manifest is audit input, not part of the candidate material set.
  writeFileSync(join(root, '.gitignore'), 'manifest.json\n');
  // Add the ignore rule to the commit so it does not alter the captured status.
  runGit(root, ['add', '.gitignore']);
  runGit(root, ['commit', '--amend', '--no-edit']);
  manifest.source.head = runGit(root, ['rev-parse', 'HEAD']);
  manifest.files.unshift({
    path: '.gitignore',
    kind: 'file',
    mode: '0644',
    sha256: digest('manifest.json\n'),
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    root,
    manifest,
    manifestPath,
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test('accepts an exact dirty checkout including modes and symlink targets', (t) => {
  const item = fixture();
  t.after(item.cleanup);
  assert.deepEqual(verifyMigrationSource({ source: item.root, manifestPath: item.manifestPath }), {
    head: item.manifest.source.head,
    branch: 'main',
    dirty: true,
    fileCount: 4,
  });
});

test('the extractor builds the verifier-compatible v2 provenance contract', () => {
  const manifest = createMigrationManifest({
    sourceRoot: '/authorized/source/scenario-studio',
    sourceHead: 'a'.repeat(40),
    sourceBranch: 'main',
    status: [' M tracked.txt'],
    files: [{ path: 'tracked.txt', kind: 'file', mode: '0644', sha256: 'b'.repeat(64) }],
    capturedAt: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(manifest.schema, 'uniscenarios.repository-extraction.v2');
  assert.equal(manifest.source.repositoryName, 'scenario-studio');
  assert.equal(manifest.packageScope, '@uniscenarios');
  assert.deepEqual(manifest.cli, { primary: 'uniscenarios', compatibilityAlias: 'scen' });
  assert.equal(manifest.provenance.reproducibility.exactDirtySnapshotReconstructibleFromManifest, false);
  assert.deepEqual(manifest.provenance.sourceLocator, {
    kind: 'not-recorded',
    value: null,
    policy: "A source checkout must be supplied explicitly by the verifier's caller. No public URL, private URL, filesystem path, or assurance of continued source availability is asserted by this manifest.",
  });
});

test('the extractor requires an explicit portable destination', () => {
  assert.throws(() => parseExtractionArgs([]), /--destination is required/);
  assert.deepEqual(parseExtractionArgs(['--destination', '/tmp/UniScenarios']), {
    destination: '/tmp/UniScenarios',
    linkDevAssets: false,
    commit: false,
  });
});

test('fails closed when source is omitted from the command line', () => {
  const script = fileURLToPath(new URL('../verify-migration-source.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--source is required; no source location is inferred/);
});

test('rejects a different Git HEAD', (t) => {
  const item = fixture();
  t.after(item.cleanup);
  item.manifest.source.head = '0'.repeat(40);
  writeFileSync(item.manifestPath, JSON.stringify(item.manifest));
  assert.throws(
    () => verifyMigrationSource({ source: item.root, manifestPath: item.manifestPath }),
    /Git HEAD differs/,
  );
});

test('rejects status and material-path differences', (t) => {
  const item = fixture();
  t.after(item.cleanup);
  writeFileSync(join(item.root, 'unexpected.txt'), 'not captured\n');
  assert.throws(
    () => verifyMigrationSource({ source: item.root, manifestPath: item.manifestPath }),
    /Git status differs[\s\S]*material path set differs/,
  );
});

test('rejects content and mode differences even when status lines are unchanged', (t) => {
  const item = fixture();
  t.after(item.cleanup);
  writeFileSync(join(item.root, 'tracked.txt'), 'different dirty contents\n');
  chmodSync(join(item.root, 'tool.sh'), 0o644);
  assert.throws(
    () => verifyMigrationSource({ source: item.root, manifestPath: item.manifestPath }),
    /tool\.sh: mode differs[\s\S]*tracked\.txt: SHA-256 differs/,
  );
});

test('rejects unsafe or incomplete manifests before inspecting files', (t) => {
  const item = fixture();
  t.after(item.cleanup);
  const malformed = JSON.parse(readFileSync(item.manifestPath, 'utf8'));
  malformed.files[0].path = '../outside';
  writeFileSync(item.manifestPath, JSON.stringify(malformed));
  assert.throws(
    () => verifyMigrationSource({ source: item.root, manifestPath: item.manifestPath }),
    /normalized relative path within the source checkout/,
  );
});

test('rejects contradictory standalone naming metadata and verifier claims', (t) => {
  const item = fixture();
  t.after(item.cleanup);
  const malformed = JSON.parse(readFileSync(item.manifestPath, 'utf8'));
  malformed.packageScope = '@scenario-studio';
  malformed.cli.primary = 'scen';
  malformed.provenance.verification.checks.push('sourceAvailability');
  writeFileSync(item.manifestPath, JSON.stringify(malformed));
  assert.throws(
    () => verifyMigrationSource({ source: item.root, manifestPath: item.manifestPath }),
    /manifest\.packageScope must be @simforge/,
  );
});

test('rejects non-canonical or overstated verifier coverage', (t) => {
  const item = fixture();
  t.after(item.cleanup);
  const malformed = JSON.parse(readFileSync(item.manifestPath, 'utf8'));
  malformed.provenance.verification.checks.reverse();
  writeFileSync(item.manifestPath, JSON.stringify(malformed));
  assert.throws(
    () => verifyMigrationSource({ source: item.root, manifestPath: item.manifestPath }),
    /exactly the supported verifier checks in canonical order/,
  );
});
