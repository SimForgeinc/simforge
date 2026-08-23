#!/usr/bin/env node

/**
 * Create a standalone UniScenarios repository from this working tree.
 *
 * The extraction is deliberately one-way and non-destructive:
 * - the destination must not exist;
 * - the source repository, index, working tree, and remotes are never changed;
 * - committed history is cloned without hard links;
 * - tracked edits and non-ignored untracked files are copied into the clone;
 * - ignored local dependencies and map assets are not copied into Git.
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio ?? 'pipe',
  });
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`${command} ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
  return result.stdout;
}

export function parseArgs(argv) {
  const options = {
    destination: undefined,
    linkDevAssets: false,
    commit: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--destination') {
      const value = argv[index + 1];
      if (!value) throw new Error('--destination requires a path');
      options.destination = value;
      index += 1;
    } else if (arg === '--link-dev-assets') {
      options.linkDevAssets = true;
    } else if (arg === '--commit') {
      options.commit = true;
    } else if (arg === '--help') {
      process.stdout.write(
        [
          'Usage: node scripts/extract-uniscenarios.mjs [options]',
          '',
          '  --destination PATH  New repository path (must not exist)',
          '  --link-dev-assets   Link the ignored local map assets into the new checkout',
          '  --commit            Create a local migration commit after validation',
          '',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!options.destination) throw new Error('--destination is required');
  return options;
}

function assertSafeDestination(sourceRoot, destination) {
  if (!isAbsolute(destination)) throw new Error('destination must be an absolute path');
  if (existsSync(destination)) throw new Error(`destination already exists: ${destination}`);
  const sourcePrefix = `${sourceRoot}${sep}`;
  if (destination === sourceRoot || destination.startsWith(sourcePrefix)) {
    throw new Error('destination must be outside the source repository');
  }
  if (destination === '/' || destination === dirname(destination)) {
    throw new Error(`refusing unsafe destination: ${destination}`);
  }
}

function materialPaths(sourceRoot) {
  const output = run(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: sourceRoot },
  );
  return output.split('\0').filter(Boolean).sort();
}

function copyMaterialFile(sourceRoot, destination, path) {
  const sourcePath = join(sourceRoot, path);
  const destinationPath = join(destination, path);
  const stat = lstatSync(sourcePath);
  mkdirSync(dirname(destinationPath), { recursive: true });
  if (stat.isSymbolicLink()) {
    rmSync(destinationPath, { force: true });
    symlinkSync(readlinkSync(sourcePath), destinationPath);
  } else if (stat.isFile()) {
    copyFileSync(sourcePath, destinationPath);
    chmodSync(destinationPath, stat.mode);
  } else {
    throw new Error(`unsupported material path type: ${path}`);
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function transformTextFiles(destination, paths) {
  const replacements = [
    ['https://scenario-studio.simforge.ai/schema', 'https://schemas.uniscenarios.dev'],
    ['@scenario-studio/', '@uniscenarios/'],
    ['scenario-studio-monorepo', 'uniscenarios'],
    ['SCENARIO_STUDIO', 'UNISCENARIOS'],
    ['Scenario Studio', 'UniScenarios'],
    ['scenario-studio', 'uniscenarios'],
  ];

  for (const path of paths) {
    if (
      path === 'scripts/extract-uniscenarios.mjs' ||
      path === 'docs/uniscenarios-repository-extraction.md'
    ) {
      continue;
    }
    const absolutePath = join(destination, path);
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) continue;
    const buffer = readFileSync(absolutePath);
    if (buffer.includes(0)) continue;
    let text = buffer.toString('utf8');
    let next = text;
    for (const [from, to] of replacements) next = next.split(from).join(to);
    if (next !== text) writeFileSync(absolutePath, next);
  }
}

function configureCli(destination) {
  const packagePath = join(destination, 'packages/cli/package.json');
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
  manifest.bin = {
    uniscenarios: './bin/uniscenarios.js',
    scen: './bin/scen.js',
  };
  manifest.scripts = {
    ...manifest.scripts,
    uniscenarios: 'tsx src/main.ts',
  };
  writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);

  const oldBin = join(destination, 'packages/cli/bin/scen.js');
  const newBin = join(destination, 'packages/cli/bin/uniscenarios.js');
  const source = readFileSync(oldBin, 'utf8')
    .replace('`scen`', '`uniscenarios`')
    .replace('the agent CLI entry point', 'the UniScenarios CLI entry point');
  writeFileSync(newBin, source, { mode: 0o755 });
  chmodSync(oldBin, 0o755);

  const gitignorePath = join(destination, '.gitignore');
  const gitignore = readFileSync(gitignorePath, 'utf8')
    .replace(/^dev-assets\/$/m, '/dev-assets')
    .concat(
      '\n# Local render and simulation evidence; publish through an artifact store or Git LFS.\n/artifacts\n/scripts/.ss-probe.mjs\n',
    );
  writeFileSync(gitignorePath, gitignore);
}

export function createMigrationManifest({ sourceRoot, sourceHead, sourceBranch, status, files, capturedAt = new Date().toISOString() }) {
  return {
    schema: 'uniscenarios.repository-extraction.v2',
    capturedAt,
    source: {
      repositoryName: sourceRoot.split(sep).at(-1),
      head: sourceHead,
      branch: sourceBranch,
      dirty: status.length > 0,
      status,
    },
    packageScope: '@uniscenarios',
    cli: {
      primary: 'uniscenarios',
      compatibilityAlias: 'scen',
    },
    excludedIgnoredState: ['node_modules/', 'dist/', 'dev-assets/'],
    provenance: {
      reproducibility: {
        classification: 'verification-only-non-reconstructible',
        exactDirtySnapshotReconstructibleFromManifest: false,
        statement: 'The committed HEAD may be recoverable from an independently available Git repository, but this manifest does not contain the modified and untracked file bytes needed to reconstruct the captured dirty snapshot. SHA-256 digests identify bytes; they cannot recover them.',
      },
      sourceLocator: {
        kind: 'not-recorded',
        value: null,
        policy: 'A source checkout must be supplied explicitly by the verifier\'s caller. No public URL, private URL, filesystem path, or assurance of continued source availability is asserted by this manifest.',
      },
      verification: {
        command: 'node scripts/verify-migration-source.mjs --source <source-checkout>',
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
    files,
  };
}

function writeTransitionDocuments(destination, sourceRoot, sourceHead, sourceBranch, status, files) {
  const migrationManifest = createMigrationManifest({
    sourceRoot,
    sourceHead,
    sourceBranch,
    status,
    files,
  });
  writeFileSync(
    join(destination, 'MIGRATION-SOURCE.json'),
    `${JSON.stringify(migrationManifest, null, 2)}\n`,
  );

  const document = `# UniScenarios repository transition

This repository is the standalone successor to the Scenario Studio working tree.
It was extracted without modifying or deleting the source repository.

## Naming contract

- Product and repository: **UniScenarios** / \`uniscenarios\`
- Package scope: \`@uniscenarios/*\`
- Primary CLI: \`uniscenarios\`
- Compatibility CLI alias: \`scen\`
- Application workspace: \`apps/cloud\` (\`@uniscenarios/studio\`)

The \`apps/cloud\` directory name describes the authoring surface; it is not a
legacy product name. Public UI, schemas, package metadata, and documentation use
UniScenarios naming.

The naming contract is executable:

\`\`\`sh
pnpm verify:naming
\`\`\`

The audit checks the root name, every workspace package scope, the primary and
compatibility CLI names, duplicate workspace names, and public documentation.
Legacy product naming is allowed only in these transition and extraction
documents, where it identifies historical provenance rather than the current
product.

## Provenance and local-only state

\`MIGRATION-SOURCE.json\` is an integrity inventory of the extraction input. It
records the source commit and branch, the dirty status, and the file kind,
POSIX mode, and SHA-256 digest of every tracked or non-ignored untracked source
file copied by the extractor.

The provenance classification is **verification-only, non-reconstructible**.
The manifest can prove that an independently obtained source checkout matches
the captured input, but it cannot create that checkout. In particular, hashes
do not contain the modified or untracked file bytes from the dirty working tree.
The committed \`HEAD\` alone is therefore insufficient to reproduce the exact
extraction input.

No source URL or source filesystem path is recorded. This is deliberate: no
public source location or continuing availability has been established, and a
machine-local path would expose local information without making the snapshot
portable. A caller that already has a candidate source checkout can verify it:

\`\`\`sh
node scripts/verify-migration-source.mjs \\
  --source /path/to/candidate-source-checkout
\`\`\`

The verifier fails closed unless the Git \`HEAD\`, branch, complete porcelain
status, complete tracked/non-ignored path set, file kinds, modes, and SHA-256
digests all match. A successful check establishes identity with the recorded
snapshot; it does not establish how the checkout was obtained or that it will
remain available.

The extraction preserves committed history but intentionally configures no Git
remote, so publishing requires an explicit remote choice.

Ignored dependencies, generated build output, local render evidence, and
proprietary/local map assets are not committed. Publish selected evidence through
Git LFS or an external artifact store. For local development, provide
\`dev-assets/\` separately or use the extraction command's \`--link-dev-assets\`
option on the source machine.

## Compatibility

Existing automation can continue invoking \`scen\`. New integrations should use
\`uniscenarios\`. Serialized scenario formats retain their schema versions; only
the owning product namespace and canonical schema host have changed.
`;
  mkdirSync(join(destination, 'docs'), { recursive: true });
  writeFileSync(join(destination, 'docs/repository-transition.md'), document);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceRoot = realpathSync(
    run('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() }).trim(),
  );
  const destination = resolve(options.destination);
  assertSafeDestination(sourceRoot, destination);

  const sourceHead = run('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot }).trim();
  const sourceBranch = run('git', ['branch', '--show-current'], { cwd: sourceRoot }).trim();
  const status = run('git', ['status', '--short', '--untracked-files=all'], {
    cwd: sourceRoot,
  })
    .split('\n')
    .filter(Boolean);
  const paths = materialPaths(sourceRoot);

  mkdirSync(dirname(destination), { recursive: true });
  run('git', ['clone', '--local', '--no-hardlinks', sourceRoot, destination], {
    cwd: dirname(destination),
    stdio: 'inherit',
  });
  run('git', ['remote', 'remove', 'origin'], { cwd: destination });

  const files = [];
  for (const path of paths) {
    copyMaterialFile(sourceRoot, destination, path);
    const sourcePath = join(sourceRoot, path);
    const stat = lstatSync(sourcePath);
    files.push({
      path,
      kind: stat.isSymbolicLink() ? 'symlink' : 'file',
      mode: `0${(stat.mode & 0o777).toString(8).padStart(3, '0')}`,
      sha256: stat.isSymbolicLink()
        ? createHash('sha256').update(readlinkSync(sourcePath)).digest('hex')
        : sha256(sourcePath),
    });
  }

  transformTextFiles(destination, paths);
  configureCli(destination);
  writeTransitionDocuments(
    destination,
    sourceRoot,
    sourceHead,
    sourceBranch,
    status,
    files,
  );

  const sourceAssets = join(sourceRoot, 'dev-assets');
  const destinationAssets = join(destination, 'dev-assets');
  if (options.linkDevAssets && existsSync(sourceAssets)) {
    symlinkSync(sourceAssets, destinationAssets);
  }

  run('git', ['checkout', '-b', 'codex/uniscenarios-transition'], { cwd: destination });
  if (options.commit) {
    run('git', ['add', '--all'], { cwd: destination });
    run(
      'git',
      ['commit', '-m', 'Initialize standalone UniScenarios repository'],
      { cwd: destination, stdio: 'inherit' },
    );
  }

  const finalStatus = run('git', ['status', '--short', '--branch'], { cwd: destination });
  process.stdout.write(
    [
      `Created standalone UniScenarios repository at ${destination}`,
      `Captured ${files.length} tracked/non-ignored files from ${sourceHead}`,
      options.linkDevAssets ? 'Linked local dev-assets for immediate development' : '',
      '',
      finalStatus.trimEnd(),
      '',
    ]
      .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
      .join('\n'),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
