#!/usr/bin/env node
/**
 * policy-eval-build-suite — derive the frozen `policy-eval-suite.v1.json`
 * from the five-map catalog minus the rl training banks.
 *
 *   node packages/evaluation/dist/build-suite-cli.js \
 *     --catalog catalog/uniscenarios-five-map-v2.catalog.json \
 *     --training-glob 'scripts/rl/episodes/*-*.json' \
 *     --out qualification/policy-eval-suite.v1.json [--validate]
 *
 * `--validate` materialize-probes every candidate cell (needs dev-assets and
 * a resolvable rl runtime; see src/runtime.ts). stdout is one JSON summary.
 * Deterministic: same catalog + banks ⇒ byte-identical suite file.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { globSync } from 'node:fs';
import {
  buildSuite,
  policyEvalSuiteSchema,
  type CatalogSlotView,
  type SuiteEntry,
} from './suite.js';
import { loadTrainingBanks, slotsFromCatalog, entryValidator } from './catalog.js';
import { resolveRlRuntime } from './runtime.js';

interface Flags {
  catalog: string;
  trainingGlob: string;
  out: string;
  validate: boolean;
}

function parseArgs(argv: readonly string[]): Flags {
  const flags: Flags = {
    catalog: 'catalog/uniscenarios-five-map-v2.catalog.json',
    trainingGlob: 'scripts/rl/episodes/*-train.json,scripts/rl/episodes/*-eval.json',
    out: 'qualification/policy-eval-suite.v1.json',
    validate: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--catalog': flags.catalog = value(); break;
      case '--training-glob': flags.trainingGlob = value(); break;
      case '--out': flags.out = value(); break;
      case '--validate': flags.validate = true; break;
      default: throw new Error(`unknown flag ${arg}`);
    }
  }
  return flags;
}

/**
 * Episode banks live with the rl stack, which in a split-worktree setup may
 * not be this checkout. Each pattern resolves against the current directory
 * first, then against the rl checkout named by UNISCENARIOS_RL_ENV.
 */
function bankSources(pattern: string): string[] {
  const out: string[] = [];
  const rlRepo = process.env['UNISCENARIOS_RL_ENV'] === undefined
    ? null
    : path.resolve(process.env['UNISCENARIOS_RL_ENV'], '..', '..');
  for (const pat of pattern.split(',')) {
    const trimmed = pat.trim();
    if (!trimmed.includes('*')) {
      out.push(trimmed);
      continue;
    }
    let matched = globSync(path.resolve(trimmed)) ?? [];
    if (matched.length === 0 && rlRepo !== null) {
      matched = (globSync(path.join(rlRepo, trimmed)) ?? []).map((p) => path.relative('.', p));
    }
    out.push(...matched.sort());
  }
  if (out.length === 0) throw new Error(`no training banks match "${pattern}"`);
  return out;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const catalogDoc = JSON.parse(await readFile(path.resolve(repoRoot, flags.catalog), 'utf8'));
  const slots: CatalogSlotView[] = slotsFromCatalog(catalogDoc);
  const rlRepo = process.env['UNISCENARIOS_RL_ENV'] === undefined
    ? null
    : path.resolve(process.env['UNISCENARIOS_RL_ENV'], '..', '..');
  const bankPaths = bankSources(flags.trainingGlob).map((s) => path.resolve(repoRoot, s));
  const banks = await loadTrainingBanks(bankPaths);
  // Provenance labels stay portable: relative to the rl checkout when the
  // banks were found there, basename otherwise.
  for (const bank of banks) {
    const absolute = path.resolve(bank.source);
    bank.source = rlRepo !== null && absolute.startsWith(rlRepo + path.sep)
      ? path.relative(rlRepo, absolute)
      : path.basename(absolute);
  }

  let validate: ((entry: SuiteEntry) => Promise<boolean>) | undefined;
  if (flags.validate) {
    const runtime = await resolveRlRuntime();
    validate = entryValidator(runtime, repoRoot);
  }

  const { suite, skipped } = await buildSuite({ slots, banks, validate });
  const checked = policyEvalSuiteSchema.parse(suite);

  // Deterministic serialization: canonical key order via the hash path is
  // overkill on disk; stable insertion order from buildSuite already makes
  // repeated runs byte-identical.
  await writeFile(path.resolve(repoRoot, flags.out), `${JSON.stringify(checked, null, 1)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        suiteHash: checked.suiteHash,
        out: flags.out,
        entries: checked.entries.length,
        abilities: Object.keys(checked.abilities),
        skipped,
        exclusions: checked.trainingExclusions,
      },
      null,
      1,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ code: 'build_suite_failed', reason: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exit(1);
});
