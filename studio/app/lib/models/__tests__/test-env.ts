/**
 * MUST be the first import of every model-registry test file: points the
 * local database and run outputs at a throwaway directory BEFORE
 * app/lib/db/config.ts is evaluated.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "simforge-model-registry-"));
process.env.SIMFORGE_CLOUD_ROOT = root;
process.env.SIMFORGE_RUNS_ROOT = join(root, "runs");
delete process.env.DATABASE_URL;

export const TEST_ROOT = root;
export const TEST_RUNS_ROOT = join(root, "runs");
