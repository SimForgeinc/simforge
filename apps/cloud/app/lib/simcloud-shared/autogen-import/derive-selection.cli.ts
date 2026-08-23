#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { deriveSelection, formatSelectionFile } from "./selection";

/**
 * CLI shell for selection derivation. Logic lives in ./selection.ts.
 *
 *   npm run autogen:selection -- --csv <run>/review.csv --min-rating 4 \
 *     --out selected-scene-ids.txt
 */

type Args = {
  csv: string;
  out: string | null;
  minRating: number;
  idColumn: string | null;
  ratingColumn: string | null;
  excludeRejected: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    csv: "",
    out: null,
    minRating: 4,
    idColumn: null,
    ratingColumn: null,
    excludeRejected: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--csv" && argv[i + 1]) args.csv = argv[++i];
    else if (v === "--out" && argv[i + 1]) args.out = argv[++i];
    else if (v === "--min-rating" && argv[i + 1]) args.minRating = Number(argv[++i]);
    else if (v === "--id-column" && argv[i + 1]) args.idColumn = argv[++i];
    else if (v === "--rating-column" && argv[i + 1]) args.ratingColumn = argv[++i];
    else if (v === "--include-rejected") args.excludeRejected = false;
    else if (v === "--help" || v === "-h") {
      process.stdout.write(
        "Usage: autogen:selection --csv <file> [options]\n\n" +
          "  --csv <file>            Rated review export (required)\n" +
          "  --out <file>            Write the allowlist here (default: stdout)\n" +
          "  --min-rating <n>        Minimum rating to select (default: 4)\n" +
          "  --id-column <name>      Scene id column (default: auto-detect)\n" +
          "  --rating-column <name>  Rating column (default: auto-detect)\n" +
          "  --include-rejected      Keep rows flagged rejected (default: drop)\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${v}`);
  }
  if (!args.csv) throw new Error("--csv is required");
  if (!Number.isFinite(args.minRating)) throw new Error("--min-rating must be a number");
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const path = resolve(args.csv);
  const result = deriveSelection(await readFile(path, "utf8"), {
    minRating: args.minRating,
    idColumn: args.idColumn,
    ratingColumn: args.ratingColumn,
    excludeRejected: args.excludeRejected,
  });

  const body = formatSelectionFile(result, path, args.minRating);
  if (args.out) {
    await writeFile(resolve(args.out), body);
    process.stdout.write(`wrote ${result.selected.length} id(s) to ${args.out}\n`);
  } else {
    process.stdout.write(body);
  }
  process.stderr.write(
    `selected ${result.selected.length} | below threshold ${result.counts.belowThreshold} | ` +
      `unrated ${result.counts.unrated} | rejected ${result.counts.rejected}\n`,
  );

  // An empty selection is almost always a column mismatch rather than a run
  // where nothing was good enough, so say so instead of writing an empty file
  // that would later look like "the operator picked nothing".
  if (result.selected.length === 0) {
    process.stderr.write(
      "\nNo rows selected. If this run was rated, check --id-column / " +
        `--rating-column against the header:\n  ${result.header.join(", ")}\n`,
    );
    process.exit(2);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
