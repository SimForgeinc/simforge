#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { buildBundle } from "./build-bundle";
import { parseSelectionFile } from "./selection";

/**
 * CLI shell for the bundle builder: argument parsing, file IO and reporting.
 * All decision logic lives in ./build-bundle.ts so it can be tested without a
 * process.
 *
 *   npm run autogen:bundle -- --run <dir> --selection ids.txt --out /tmp/bundle
 *   npm run autogen:bundle -- --run <dir> --validate-only
 */

type Args = {
  run: string;
  selection: string | null;
  out: string | null;
  datasetId: string | null;
  batchId: string | null;
  validateOnly: boolean;
  limit: number | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    run: "",
    selection: null,
    out: null,
    datasetId: null,
    batchId: null,
    validateOnly: false,
    limit: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--run" && argv[i + 1]) args.run = argv[++i];
    else if (v === "--selection" && argv[i + 1]) args.selection = argv[++i];
    else if (v === "--out" && argv[i + 1]) args.out = argv[++i];
    else if (v === "--dataset" && argv[i + 1]) args.datasetId = argv[++i];
    else if (v === "--batch-id" && argv[i + 1]) args.batchId = argv[++i];
    else if (v === "--limit" && argv[i + 1]) args.limit = Number(argv[++i]);
    else if (v === "--validate-only") args.validateOnly = true;
    else if (v === "--help" || v === "-h") {
      process.stdout.write(
        "Usage: autogen:bundle --run <dir> [options]\n\n" +
          "  --run <dir>          Offline run root (required)\n" +
          "  --selection <file>   Scene-id allowlist. Required to write a bundle;\n" +
          "                       omit only with --validate-only to survey a run.\n" +
          "  --out <dir>          Bundle output directory\n" +
          "  --dataset <id>       Target SimCloud dataset id (recorded only)\n" +
          "  --batch-id <id>      Source batch id (default: run directory name)\n" +
          "  --limit <n>          Stop after n eligible scenes (smoke tests)\n" +
          "  --validate-only      Report eligibility, write nothing\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${v}`);
  }
  if (!args.run) throw new Error("--run is required");
  if (!args.validateOnly && !args.out) {
    throw new Error("--out is required unless --validate-only");
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runRoot = resolve(args.run);

  let selection: string[] | null = null;
  let selectionSha256 = createHash("sha256").update("").digest("hex");
  if (args.selection) {
    const raw = await readFile(resolve(args.selection), "utf8");
    selectionSha256 = createHash("sha256").update(raw).digest("hex");
    selection = parseSelectionFile(raw);
  }

  process.stdout.write(`run:       ${runRoot}\n`);
  process.stdout.write(
    selection
      ? `selection: ${selection.length} id(s) from ${args.selection}\n`
      : "selection: (none) — surveying every discovered scene\n",
  );

  const result = await buildBundle({
    runRoot,
    batchId: args.batchId ?? basename(runRoot),
    selection,
    selectionSha256,
    outDir: args.validateOnly ? null : resolve(args.out as string),
    datasetId: args.datasetId,
    limit: args.limit,
    now: new Date().toISOString(),
  });

  process.stdout.write(`discovered ${result.discovered} scene(s) with 3D output\n`);
  process.stdout.write(`\neligible:  ${result.included.length}\n`);
  process.stdout.write(`excluded:  ${result.excluded.length}\n`);
  for (const [reason, count] of Object.entries(
    result.manifest.exclusions.byReason,
  ).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${String(count).padStart(5)}  ${reason}\n`);
  }

  const byCategory = new Map<string, number>();
  for (const scene of result.included) {
    byCategory.set(
      scene.category.id,
      (byCategory.get(scene.category.id) ?? 0) + 1,
    );
  }
  if (byCategory.size > 0) {
    process.stdout.write("\nby category:\n");
    for (const [id, count] of [...byCategory].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${String(count).padStart(5)}  ${id}\n`);
    }
  }

  process.stdout.write(
    args.validateOnly
      ? "\nvalidate-only — wrote nothing\n"
      : `\nbundle:    ${resolve(args.out as string)}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
