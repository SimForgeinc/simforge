import { createHash } from "node:crypto";

/**
 * Deriving an explicit scene-id allowlist from a rated review export.
 *
 * The publisher accepts ONLY a flat id list, never a review file. That split is
 * deliberate: review artifacts drift (six sampled runs had six different
 * `review.csv` headers, and ratings are actually entered in the CoT review HTML
 * sheet and exported separately), and a threshold living inside the publisher
 * would quietly change what ships when a column is renamed. Keeping derivation
 * separate makes the rating -> selection decision a recorded, auditable step.
 */

/**
 * Minimal RFC4180 reader. Review exports contain quoted commas and embedded
 * newlines in the nav-prompt and narration columns, so a split on "," loses
 * rows — silently, and in a way that looks like a shorter batch.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

export const ID_COLUMN_CANDIDATES = [
  "scene_id",
  "scenario_id",
  "variant_id",
  "scene",
];
export const RATING_COLUMN_CANDIDATES = ["rating_1_5", "v2_rating", "rating"];

export function pickColumn(
  header: string[],
  explicit: string | null,
  candidates: string[],
  label: string,
): number {
  if (explicit) {
    const index = header.indexOf(explicit);
    if (index < 0) throw new Error(`--${label}-column "${explicit}" not in header`);
    return index;
  }
  for (const candidate of candidates) {
    const index = header.indexOf(candidate);
    if (index >= 0) return index;
  }
  throw new Error(
    `could not auto-detect the ${label} column (looked for ${candidates.join(", ")}); ` +
      `pass --${label}-column`,
  );
}

export type DeriveOptions = {
  minRating: number;
  idColumn?: string | null;
  ratingColumn?: string | null;
  excludeRejected?: boolean;
};

export type DeriveResult = {
  selected: string[];
  header: string[];
  sourceSha256: string;
  counts: { belowThreshold: number; unrated: number; rejected: number };
};

export function deriveSelection(csv: string, opts: DeriveOptions): DeriveResult {
  const sourceSha256 = createHash("sha256").update(csv).digest("hex");
  const rows = parseCsv(csv);
  const headerRow = rows[0];
  if (!headerRow) throw new Error("empty csv");

  const header = headerRow.map((h) => h.trim());
  const idIndex = pickColumn(header, opts.idColumn ?? null, ID_COLUMN_CANDIDATES, "id");
  const ratingIndex = pickColumn(
    header,
    opts.ratingColumn ?? null,
    RATING_COLUMN_CANDIDATES,
    "rating",
  );
  const rejectedIndex = header.indexOf("rejected");
  const excludeRejected = opts.excludeRejected !== false;

  const selected: string[] = [];
  const counts = { belowThreshold: 0, unrated: 0, rejected: 0 };

  for (const row of rows.slice(1)) {
    const id = (row[idIndex] ?? "").trim();
    if (!id) continue;

    if (excludeRejected && rejectedIndex >= 0) {
      const flag = (row[rejectedIndex] ?? "").trim().toLowerCase();
      if (flag === "yes" || flag === "true" || flag === "1") {
        counts.rejected += 1;
        continue;
      }
    }

    const ratingRaw = (row[ratingIndex] ?? "").trim();
    if (!ratingRaw) {
      counts.unrated += 1;
      continue;
    }
    const rating = Number(ratingRaw);
    if (!Number.isFinite(rating) || rating < opts.minRating) {
      counts.belowThreshold += 1;
      continue;
    }
    selected.push(id);
  }

  return { selected: [...new Set(selected)], header, sourceSha256, counts };
}

/** Render the allowlist with a provenance header the builder ignores. */
export function formatSelectionFile(
  result: DeriveResult,
  sourcePath: string,
  minRating: number,
): string {
  return [
    "# Explicit scene-id allowlist. The publisher reads only the ids below.",
    `# source: ${sourcePath}`,
    `# source_sha256: ${result.sourceSha256}`,
    `# min_rating: ${minRating}`,
    `# selected: ${result.selected.length}`,
    ...result.selected,
    "",
  ].join("\n");
}

/** Parse an allowlist file back into ids, ignoring comments and blanks. */
export function parseSelectionFile(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}
