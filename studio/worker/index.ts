import { homedir, hostname } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { RenderProgressRecord } from "@simforge/render";

import { runCompilerLoop } from "./compiler.js";
import { executeRender } from "./executor.js";
import { CpuJobsClient, downloadInputs } from "./http-client.js";
import type { CpuJobClaim } from "./types.js";

export type LocalWorkerHandle = {
  readonly done: Promise<void>;
  stop(reason?: unknown): void;
};

export function startLocalWorker(baseUrl: string | URL): LocalWorkerHandle {
  const controller = new AbortController();
  const token = process.env.UNISCENARIO_RENDER_WORKER_TOKEN?.trim() || "uniscenarios-local-worker";
  const workerId = process.env.UNISCENARIO_RENDER_WORKER_ID?.trim()
    || `local-${hostname().replace(/[^A-Za-z0-9._:-]/g, "-")}-${process.pid}`;
  const client = new CpuJobsClient(new URL(baseUrl), token, workerId);
  const done = Promise.all([
    runClaimLoop(client, controller.signal),
    runCompilerLoop(baseUrl, token, controller.signal),
  ]).then(() => undefined);
  return {
    done,
    stop(reason = new Error("local render worker stopped")) {
      controller.abort(reason);
    },
  };
}

export function localWorkerEnabled(argv: readonly string[] = process.argv.slice(2)): boolean {
  return process.env.UNISCENARIOS_LOCAL_WORKER === "1" || argv.includes("--with-worker");
}

async function runClaimLoop(client: CpuJobsClient, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const claim = await client.claim(signal);
      if (!claim) {
        await delay(1_000, signal);
        continue;
      }
      await runClaim(client, claim, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      process.stderr.write(`${JSON.stringify({
        component: "uniscenarios-local-render-worker",
        event: "claim.retry",
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
      await delay(1_000, signal);
    }
  }
}

async function runClaim(client: CpuJobsClient, claim: CpuJobClaim, workerSignal: AbortSignal): Promise<void> {
  const root = process.env.UNISCENARIO_LOCAL_WORKER_ROOT?.trim()
    || join(homedir(), ".uniscenarios", "cloud", "worker");
  const workspace = join(root, `${claim.jobId}-${claim.attemptId}`);
  await rm(workspace, { recursive: true, force: true });
  const job = new AbortController();
  const signal = AbortSignal.any([workerSignal, job.signal]);
  let progress = 0;
  const heartbeat = runHeartbeat(client, claim, () => progress, job, workerSignal);
  try {
    await client.event(claim, "job.started", { engine: claim.payload.engine }, signal);
    const inputs = await downloadInputs(claim.payload.inputs, join(workspace, "inputs"), signal);
    const result = await executeRender({
      jobId: claim.jobId,
      attempt: 1,
      engine: claim.payload.engine,
      intent: claim.payload.intent,
      intentSha256: claim.payload.intentSha256,
      inputs,
      workspace,
      signal,
      reportProgress: async (record: RenderProgressRecord) => {
        progress = progressOf(record, progress);
        if (record.event === "stage.progress") {
          await client.event(claim, "stage.progress", {
            stage: record.stage,
            completed: record.completed,
            total: record.total,
            unit: record.unit,
          }, signal);
        }
      },
    });
    progress = 0.95;
    const recording = await client.reserve(claim, result.artifacts, signal);
    for (const artifact of result.artifacts) {
      const key = artifact.sensor
        ? `${artifact.kind}\0${artifact.sensor.actorId}\0${artifact.sensor.sensorId}\0${artifact.sensor.modality}`
        : artifact.kind;
      const reservation = recording.uploads.find((item) => item.key === key);
      if (!reservation) throw new Error(`missing upload reservation for ${key}`);
      await client.upload(reservation, artifact, signal);
    }
    job.abort(new Error("render complete"));
    await heartbeat;
    await client.complete(claim, recording.recordingId, result.artifacts, recording.uploads, workerSignal);
    process.stdout.write(`${JSON.stringify({
      component: "uniscenarios-local-render-worker",
      event: "job.completed",
      jobId: claim.jobId,
      frameCount: result.frameCount,
      durationSeconds: result.durationSeconds,
    })}\n`);
  } catch (error) {
    job.abort(error);
    await heartbeat.catch(() => undefined);
    if (workerSignal.aborted) throw workerSignal.reason;
    const detail = error instanceof Error ? error.message : String(error);
    await client.fail(claim, failureCode(error), { message: detail.slice(0, 2_000) }, AbortSignal.timeout(30_000));
    process.stderr.write(`${JSON.stringify({
      component: "uniscenarios-local-render-worker",
      event: "job.failed",
      jobId: claim.jobId,
      error: detail,
    })}\n`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runHeartbeat(
  client: CpuJobsClient,
  claim: CpuJobClaim,
  progress: () => number,
  job: AbortController,
  workerSignal: AbortSignal,
): Promise<void> {
  while (!job.signal.aborted && !workerSignal.aborted) {
    await delay(10_000, AbortSignal.any([job.signal, workerSignal])).catch(() => undefined);
    if (job.signal.aborted || workerSignal.aborted) return;
    try {
      const result = await client.heartbeat(claim, progress(), workerSignal);
      if (result.cancelRequested) {
        job.abort(new Error("render cancellation requested by control plane"));
        return;
      }
    } catch (error) {
      job.abort(error);
      return;
    }
  }
}

function progressOf(record: RenderProgressRecord, previous: number): number {
  if (record.event !== "stage.progress" || record.total <= 0) return previous;
  return Math.max(previous, Math.min(0.9, (record.completed / record.total) * 0.9));
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/digest|integrity|invalid|missing|undeclared/i.test(message)) return "render_invalid_input";
  if (/cancel/i.test(message)) return "render_cancelled";
  return "render_execution_failed";
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      rejectPromise(signal.reason);
    };
    function finish() {
      signal.removeEventListener("abort", abort);
      resolvePromise();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function main(): Promise<void> {
  const baseUrl = process.env.UNISCENARIO_API_BASE_URL?.trim() || "http://127.0.0.1:5199";
  process.stdout.write(`${JSON.stringify({
    component: "uniscenarios-local-render-worker",
    event: "worker.started",
    baseUrl,
  })}\n`);
  const worker = startLocalWorker(baseUrl);
  const stop = (name: string) => worker.stop(new Error(`received ${name}`));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await worker.done;
}

const entryHref = pathToFileURL(process.argv[1] ?? "").href;
if (import.meta.url === entryHref || entryHref.endsWith("/worker/index.ts")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      component: "uniscenarios-local-render-worker",
      event: "worker.failed",
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  });
}
