/**
 * Standalone `hifi_preview` worker: leases queued
 * `simforge.hifi_preview_requests` and renders single Bevy frames via
 * native-render-service. Talks to the store directly, so it owns the local
 * PGlite — run it when the studio server is NOT running against the same
 * SIMFORGE_CLOUD_ROOT, or point both at Postgres via DATABASE_URL.
 * (When the studio server runs, its API route drains the queue in-process.)
 */
import { runHifiPreviewLoop } from "../worker/hifi-preview.js";
import { migrate } from "./migrate";

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort(new Error(`hifi-preview worker stopped by ${signal}`)));
}

await migrate();
await runHifiPreviewLoop({ signal: controller.signal });
