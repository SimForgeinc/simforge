/**
 * Standalone model_run worker: leases queued `simforge.model_runs` and
 * executes them (openloop first). Talks to the store directly, so it owns the
 * local PGlite — run it when the studio server is NOT running against the same
 * UNISCENARIOS_CLOUD_ROOT, or point both at Postgres via DATABASE_URL.
 */
import { runModelRunLoop } from "../worker/model-run.js";
import { migrate } from "./migrate";

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort(new Error(`model-run worker stopped by ${signal}`)));
}

await migrate();
await runModelRunLoop({ signal: controller.signal });
