import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execute, executeScript, queryRows } from "../app/lib/db/data-api";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = resolve(appRoot, "migrations");

export async function migrate(): Promise<string[]> {
  await execute(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    id TEXT PRIMARY KEY,
    filename TEXT UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const appliedRows = await queryRows<{ filename: string }>(
    "SELECT COALESCE(filename, id) AS filename FROM public.schema_migrations",
  );
  const applied = new Set(appliedRows.map((row) => row.filename));
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  const newlyApplied: string[] = [];

  for (const filename of filenames) {
    if (applied.has(filename)) continue;
    const sql = await readFile(resolve(migrationsDirectory, filename), "utf8");
    await executeScript(sql);
    await execute(
      `INSERT INTO public.schema_migrations (id, filename)
       VALUES (:filename, :filename)
       ON CONFLICT (id) DO UPDATE SET filename = EXCLUDED.filename`,
      { filename },
    );
    newlyApplied.push(filename);
    console.log(`applied ${filename}`);
  }
  return newlyApplied;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await migrate();
  console.log("migrations complete");
}
