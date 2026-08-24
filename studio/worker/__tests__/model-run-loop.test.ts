import "../../app/lib/models/__tests__/test-env";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { before, after, test } from "node:test";

import {
  TEST_RUNS_ROOT,
} from "../../app/lib/models/__tests__/test-env";
import {
  bootModelTestDatabase,
  echoEndpointDescriptor,
} from "../../app/lib/models/__tests__/harness";
import type { AppContext } from "../../app/lib/db/app-context";
import { CreateModelRunSchema, ModelEndpointDescriptorSchema } from "../../app/lib/models/contracts";
import {
  createModelEndpoint,
  createModelVersion,
} from "../../app/lib/models/model-registry-store";
import { createModelRun, getModelRun } from "../../app/lib/models/model-run-store";
import { runModelRunLoop } from "../model-run";

const ECHO_SCRIPT = join(import.meta.dirname, "..", "testing", "echo-endpoint.mjs");

/** Runtime-checked narrowing of the stores' discriminated result unions. */
function expectKind<T extends { kind: string }, K extends T["kind"]>(
  value: T,
  kind: K,
): Extract<T, { kind: K }> {
  if (value.kind !== kind) throw new Error(`expected result kind ${kind}, got ${value.kind}`);
  // Checked one line above; Extract cannot be inferred from the comparison.
  return value as Extract<T, { kind: K }>;
}

let context: AppContext;
let versionId: string;
const controller = new AbortController();
let loop: Promise<void>;

before(async () => {
  context = await bootModelTestDatabase();
  const version = expectKind(await createModelVersion(context, {
    family: "stub",
    name: "Echo Stub",
    source: "local/echo",
    checkpointDigest: "c".repeat(64),
    quant: "none",
    license: "apache-2.0",
  }), "created");
  versionId = version.version.id;
  loop = runModelRunLoop({
    signal: controller.signal,
    workerId: "loop-test-worker",
    pollMs: 100,
    runsRoot: TEST_RUNS_ROOT,
  });
}, { timeout: 240_000 });

after(async () => {
  controller.abort(new Error("test complete"));
  await loop;
});

async function waitForTerminal(runId: string, timeoutMs = 60_000) {
  // Integration test against the REAL worker loop, a real PGlite, and a real
  // spawned endpoint process: there is no fake clock that drives all three,
  // so poll the ledger until the run settles.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = (await getModelRun(context, runId))!;
    if (detail.run.status === "succeeded" || detail.run.status === "failed") return detail;
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 100);
    await tick.promise;
  }
  throw new Error(`run ${runId} did not settle within ${timeoutMs}ms`);
}

test("openloop run against the echo stub goes queued -> succeeded end to end", { timeout: 120_000 }, async () => {
  const endpoint = expectKind(await createModelEndpoint(context, {
    modelVersionId: versionId,
    name: "echo",
    descriptor: echoEndpointDescriptor(ECHO_SCRIPT),
  }), "created");
  const items = [{ prompt: "left turn" }, { prompt: "u-turn" }, { prompt: "merge" }];
  const created = expectKind(await createModelRun(context, CreateModelRunSchema.parse({
    modelVersionId: versionId,
    endpointId: endpoint.endpoint.id,
    kind: "openloop",
    params: { input: { items }, request: { top_p: 0.9 } },
    seed: 42,
  })), "created");
  assert.equal(created.run.status, "queued");

  const detail = await waitForTerminal(created.run.id);
  assert.equal(detail.run.status, "succeeded");
  assert.equal(detail.attempts.length, 1);
  assert.equal(detail.attempts[0]!.state, "succeeded");
  assert.equal(detail.attempts[0]!.workerId, "loop-test-worker");
  assert.equal(detail.run.metrics?.itemCount, 3);
  assert.deepEqual(
    detail.events.map((event) => event.eventType),
    ["run.queued", "attempt.started", "run.succeeded"],
  );

  // Outputs land on disk under <runsRoot>/<run_id>/.
  const runDir = join(TEST_RUNS_ROOT, created.run.id);
  const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as {
    runId: string; itemCount: number; outputs: string[];
  };
  assert.equal(manifest.runId, created.run.id);
  assert.equal(manifest.itemCount, 3);
  assert.equal(manifest.outputs.length, 3);
  for (let index = 0; index < items.length; index += 1) {
    const output = JSON.parse(
      await readFile(join(runDir, "outputs", `item-${String(index).padStart(5, "0")}.json`), "utf8"),
    ) as { ok: boolean; echo: { runId: string; seed: number; index: number; input: unknown } };
    assert.equal(output.ok, true);
    assert.equal(output.echo.runId, created.run.id);
    assert.equal(output.echo.seed, 42);
    assert.equal(output.echo.index, index);
    assert.deepEqual(output.echo.input, items[index]);
  }
  assert.deepEqual(detail.run.outputRefs, [
    { kind: "directory", path: runDir },
    { kind: "file", path: join(runDir, "manifest.json") },
  ]);
});

test("crashing endpoint burns every attempt and fails the run terminally", { timeout: 120_000 }, async () => {
  const endpoint = expectKind(await createModelEndpoint(context, {
    modelVersionId: versionId,
    name: "crash",
    descriptor: ModelEndpointDescriptorSchema.parse({
      kind: "process",
      cmd: ["node", "/nonexistent/simforge-endpoint.mjs"],
      health: { kind: "http", path: "/healthz", timeoutMs: 5_000 },
      invoke: { kind: "http-json", path: "/invoke", timeoutMs: 5_000 },
    }),
  }), "created");
  const created = expectKind(await createModelRun(context, CreateModelRunSchema.parse({
    modelVersionId: versionId,
    endpointId: endpoint.endpoint.id,
    kind: "openloop",
    params: { input: { items: [{ prompt: "never served" }] } },
    maxAttempts: 2,
  })), "created");

  const detail = await waitForTerminal(created.run.id);
  assert.equal(detail.run.status, "failed");
  assert.equal(detail.attempts.length, 2);
  assert.deepEqual(detail.attempts.map((attempt) => attempt.state), ["failed", "failed"]);
  assert.equal(detail.attempts[1]!.errorCode, "endpoint_exited");
  assert.deepEqual(
    detail.events.map((event) => event.eventType),
    ["run.queued", "attempt.started", "attempt.failed", "attempt.started", "run.failed"],
  );
});
