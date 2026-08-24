/**
 * The `model_run` job family: leases queued `simforge.model_runs`, spawns (or
 * connects to) the run's endpoint from the descriptor that was resolved into
 * the attempt at first lease, health-checks it, executes the run, and writes
 * outputs + metrics + the attempt trail.
 *
 * Only the `openloop` kind executes today: a JSON input manifest is POSTed
 * item-by-item to the endpoint and every response lands on disk under
 * `~/simforge-assets/runs/<run_id>/` (override with SIMFORGE_RUNS_ROOT).
 * `policy_episode`/`artifact` runs stay queued for their future executors.
 *
 * Endpoint transports: `http-json` (TCP port or unix socket) is implemented;
 * `unix-msgpack` (the Alpamayo/env-server wire) descriptors are accepted by
 * the registry and the process is spawned/health-checked identically, but an
 * openloop attempt that needs it fails with `endpoint_transport_unsupported`.
 *
 * Unlike the render worker this loop talks to the store directly (PGlite is
 * in-process), so it must run in the process that owns the local database:
 * `pnpm exec tsx scripts/model-run-worker.ts`, or any test/script that already
 * imported the data API.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer, connect } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  OpenloopParamsSchema,
  type ModelEndpointDescriptor,
  type ModelRunKind,
} from "../app/lib/models/contracts.js";
import {
  completeModelRun,
  failModelRunAttempt,
  leaseNextModelRun,
  type LeasedModelRun,
} from "../app/lib/models/model-run-store.js";

/** stdio: ["ignore", "pipe", "pipe"] — no stdin, captured stdout/stderr. */
type EndpointChild = ChildProcessByStdio<null, Readable, Readable>;

export type ModelRunWorkerOptions = {
  signal: AbortSignal;
  workerId?: string;
  pollMs?: number;
  runsRoot?: string;
  kinds?: readonly ModelRunKind[];
};

/** A failure with a stable ledger code; anything else becomes `execution_error`. */
export class ModelRunFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function log(event: string, fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ component: "simforge-model-run-worker", event, ...fields })}\n`);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal.aborted) { reject(signal.reason); return promise; }
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}

export async function runModelRunLoop(options: ModelRunWorkerOptions): Promise<void> {
  const workerId = options.workerId
    ?? `model-${hostname().replace(/[^A-Za-z0-9._:-]/g, "-")}-${process.pid}`;
  const pollMs = options.pollMs ?? 1_000;
  const kinds = options.kinds ?? (["openloop"] as const);
  const runsRoot = options.runsRoot
    ?? process.env.SIMFORGE_RUNS_ROOT?.trim()
    ?? join(homedir(), "simforge-assets", "runs");
  const signal = options.signal;

  while (!signal.aborted) {
    let lease: LeasedModelRun | null = null;
    try {
      lease = await leaseNextModelRun({ workerId, kinds });
    } catch (error) {
      if (signal.aborted) return;
      log("lease.retry", { error: error instanceof Error ? error.message : String(error) });
      await delay(pollMs, signal).catch(() => undefined);
      continue;
    }
    if (!lease) {
      await delay(pollMs, signal).catch(() => undefined);
      continue;
    }
    log("attempt.started", { runId: lease.runId, attempt: lease.attemptNumber });
    try {
      const result = await executeOpenloopRun(lease, { runsRoot, signal });
      await completeModelRun(lease, result);
      log("run.succeeded", { runId: lease.runId, attempt: lease.attemptNumber, metrics: result.metrics });
    } catch (error) {
      const code = error instanceof ModelRunFailure ? error.code : "execution_error";
      const message = error instanceof Error ? error.message : String(error);
      const { runStatus } = await failModelRunAttempt(lease, {
        errorCode: code,
        errorDetail: { message: message.slice(0, 2_000) },
      });
      log("attempt.failed", { runId: lease.runId, attempt: lease.attemptNumber, code, runStatus });
      if (signal.aborted) return;
    }
  }
}

async function freeTcpPort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => port
      ? resolve(port)
      : reject(new Error("could not allocate a TCP port")));
  });
  return promise;
}

type EndpointHandle = {
  descriptor: ModelEndpointDescriptor;
  port: number | null;
  socketPath: string | null;
  child: EndpointChild | null;
  stdout: string[];
  spawnMs: number;
  healthMs: number;
  stop(): Promise<void>;
};

async function startEndpoint(
  descriptor: ModelEndpointDescriptor,
  signal: AbortSignal,
): Promise<EndpointHandle> {
  const spawnStarted = Date.now();
  let child: EndpointChild | null = null;
  let port: number | null = null;
  const stdout: string[] = [];
  let exited: Promise<void> = Promise.resolve();

  if (descriptor.kind === "process") {
    if (descriptor.invoke.kind === "http-json" && !descriptor.socketPath) {
      port = await freeTcpPort();
    }
    const [command, ...args] = descriptor.cmd;
    child = spawn(command!, args, {
      cwd: descriptor.cwd,
      env: {
        ...process.env,
        ...descriptor.env,
        ...(port !== null ? { [descriptor.portEnv]: String(port) } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const spawned = child;
    spawned.stdout.setEncoding("utf8");
    spawned.stderr.setEncoding("utf8");
    spawned.stdout.on("data", (chunk: string) => { stdout.push(chunk); });
    spawned.stderr.on("data", () => undefined);
    const exit = Promise.withResolvers<void>();
    spawned.once("exit", () => exit.resolve());
    exited = exit.promise;
  }

  const handle: EndpointHandle = {
    descriptor,
    port,
    socketPath: descriptor.socketPath ?? null,
    child,
    stdout,
    spawnMs: Date.now() - spawnStarted,
    healthMs: 0,
    stop: async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => { child?.kill("SIGKILL"); }, 5_000);
      await exited;
      clearTimeout(killTimer);
    },
  };

  const healthStarted = Date.now();
  try {
    await waitForHealth(handle, signal);
  } catch (error) {
    await handle.stop();
    throw error;
  }
  handle.healthMs = Date.now() - healthStarted;
  return handle;
}

async function waitForHealth(handle: EndpointHandle, signal: AbortSignal): Promise<void> {
  const health = handle.descriptor.health;
  const deadline = Date.now() + health.timeoutMs;
  const pattern = health.kind === "stdout" ? new RegExp(health.pattern, "m") : null;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new ModelRunFailure("worker_stopped", "worker stopped during health check");
    if (handle.child && handle.child.exitCode !== null) {
      throw new ModelRunFailure(
        "endpoint_exited",
        `endpoint process exited with code ${handle.child.exitCode} before becoming healthy`,
      );
    }
    if (health.kind === "stdout") {
      if (pattern!.test(handle.stdout.join(""))) return;
    } else if (health.kind === "http") {
      if (handle.port === null) {
        throw new ModelRunFailure("endpoint_descriptor_invalid", "http health check requires a TCP endpoint");
      }
      try {
        const response = await fetch(`http://127.0.0.1:${handle.port}${health.path}`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) return;
      } catch { /* not up yet */ }
    } else {
      const socketPath = health.path ?? handle.socketPath;
      if (!socketPath) {
        throw new ModelRunFailure("endpoint_descriptor_invalid", "socket health check requires a socket path");
      }
      const probe = Promise.withResolvers<boolean>();
      const socket = connect(socketPath, () => { socket.destroy(); probe.resolve(true); });
      socket.once("error", () => { socket.destroy(); probe.resolve(false); });
      const connected = await probe.promise;
      if (connected) return;
    }
    await delay(200, signal);
  }
  throw new ModelRunFailure("endpoint_unhealthy", `endpoint failed its ${health.kind} health check within ${health.timeoutMs}ms`);
}

/** POST one JSON document to the endpoint (TCP port or unix socket). */
async function invokeHttpJson(
  handle: EndpointHandle,
  path: string,
  timeoutMs: number,
  body: unknown,
): Promise<unknown> {
  const payload = JSON.stringify(body);
  if (handle.socketPath) {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const request = httpRequest(
      { socketPath: handle.socketPath, path, method: "POST", headers: { "content-type": "application/json" }, timeout: timeoutMs },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) >= 400) {
            reject(new ModelRunFailure("endpoint_invoke_failed", `endpoint returned ${response.statusCode}: ${text.slice(0, 500)}`));
            return;
          }
          try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
        });
      },
    );
    request.once("timeout", () => { request.destroy(new ModelRunFailure("endpoint_invoke_timeout", `invoke exceeded ${timeoutMs}ms`)); });
    request.once("error", reject);
    request.end(payload);
    return promise;
  }
  if (handle.port === null) {
    throw new ModelRunFailure("endpoint_descriptor_invalid", "http-json invoke requires a TCP port or socket path");
  }
  const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ModelRunFailure("endpoint_invoke_failed", `endpoint returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

export async function executeOpenloopRun(
  lease: LeasedModelRun,
  options: { runsRoot: string; signal: AbortSignal },
): Promise<{ metrics: Record<string, unknown>; outputRefs: unknown[] }> {
  if (lease.kind !== "openloop") {
    throw new ModelRunFailure("unsupported_run_kind", `no executor for run kind ${lease.kind}`);
  }
  const params = OpenloopParamsSchema.safeParse(lease.params);
  if (!params.success) {
    throw new ModelRunFailure("invalid_openloop_params", params.error.issues.map((issue) => issue.message).join("; "));
  }
  const descriptor = lease.resolvedDescriptor;
  if (descriptor.invoke.kind !== "http-json") {
    throw new ModelRunFailure(
      "endpoint_transport_unsupported",
      `openloop executor speaks http-json only; endpoint requires ${descriptor.invoke.kind}`,
    );
  }

  let items: unknown[];
  if ("items" in params.data.input) {
    items = params.data.input.items;
  } else {
    const manifest = JSON.parse(await readFile(params.data.input.manifestPath, "utf8")) as { items?: unknown[] };
    if (!Array.isArray(manifest.items) || manifest.items.length === 0) {
      throw new ModelRunFailure("invalid_input_manifest", `${params.data.input.manifestPath} has no "items" array`);
    }
    items = manifest.items;
  }

  const runDir = join(options.runsRoot, lease.runId);
  const outputsDir = join(runDir, "outputs");
  await mkdir(outputsDir, { recursive: true });

  const endpoint = await startEndpoint(descriptor, options.signal);
  const outputFiles: string[] = [];
  const invokeStarted = Date.now();
  try {
    for (let index = 0; index < items.length; index += 1) {
      if (options.signal.aborted) throw new ModelRunFailure("worker_stopped", "worker stopped mid-run");
      const response = await invokeHttpJson(endpoint, descriptor.invoke.path, descriptor.invoke.timeoutMs, {
        runId: lease.runId,
        seed: lease.seed,
        index,
        request: params.data.request,
        input: items[index],
      });
      const fileName = `item-${String(index).padStart(5, "0")}.json`;
      await writeFile(join(outputsDir, fileName), `${JSON.stringify(response, null, 2)}\n`, "utf8");
      outputFiles.push(join("outputs", fileName));
    }
  } finally {
    await endpoint.stop();
  }
  const invokeTotalMs = Date.now() - invokeStarted;

  const metrics = {
    itemCount: items.length,
    failedItems: 0,
    spawnMs: endpoint.spawnMs,
    healthMs: endpoint.healthMs,
    invokeTotalMs,
    meanItemMs: Math.round(invokeTotalMs / items.length),
  };
  const manifestPath = join(runDir, "manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      runId: lease.runId,
      attemptNumber: lease.attemptNumber,
      seed: lease.seed,
      itemCount: items.length,
      outputs: outputFiles,
      metrics,
      completedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
  return {
    metrics,
    outputRefs: [
      { kind: "directory", path: runDir },
      { kind: "file", path: manifestPath },
    ],
  };
}
