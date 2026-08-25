import "./test-env";

import assert from "node:assert/strict";
import { before, test } from "node:test";

import { bootModelTestDatabase, echoEndpointDescriptor } from "./harness";
import type { AppContext } from "../../db/app-context";
import { execute } from "../../db/data-api";
import { CreateModelRunSchema, CreateModelVersionSchema } from "../contracts";
import {
  createModelEndpoint,
  createModelVersion,
  getModelVersion,
  promoteModelVersion,
} from "../model-registry-store";
import {
  completeModelRun,
  createModelRun,
  failModelRunAttempt,
  getModelRun,
  leaseNextModelRun,
} from "../model-run-store";

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
let endpointId: string;

before(async () => {
  context = await bootModelTestDatabase();
  const version = expectKind(await createModelVersion(context, {
    family: "alpamayo",
    name: "Alpamayo R1 10B nf4",
    source: "nvidia/Alpamayo-R1-10B",
    checkpointDigest: "a".repeat(64),
    quant: "nf4",
    license: "nvidia-open-model",
  }), "created");
  versionId = version.version.id;
  const endpoint = expectKind(await createModelEndpoint(context, {
    modelVersionId: versionId,
    name: "echo",
    descriptor: echoEndpointDescriptor("worker/testing/echo-endpoint.mjs"),
  }), "created");
  endpointId = endpoint.endpoint.id;
}, { timeout: 240_000 });

function openloopRunInput(overrides: Record<string, unknown> = {}) {
  return CreateModelRunSchema.parse({
    modelVersionId: versionId,
    endpointId,
    kind: "openloop",
    params: { input: { items: [{ prompt: "a" }] } },
    seed: 7,
    ...overrides,
  });
}

test("submit-time validation rejects invalid payloads", () => {
  assert.equal(
    CreateModelVersionSchema.safeParse({
      family: "Alpamayo!", name: "x", source: "y", checkpointDigest: "nope",
    }).success,
    false,
  );
  const badParams = CreateModelRunSchema.safeParse({
    modelVersionId: "mv_x",
    endpointId: "mep_x",
    kind: "openloop",
    params: { input: {} },
  });
  assert.equal(badParams.success, false);
});

test("duplicate checkpoint registration conflicts", async () => {
  const duplicate = await createModelVersion(context, {
    family: "alpamayo",
    name: "same checkpoint again",
    source: "nvidia/Alpamayo-R1-10B",
    checkpointDigest: "a".repeat(64),
    quant: "nf4",
    license: "nvidia-open-model",
  });
  assert.deepEqual(duplicate, { kind: "conflict" });
});

test("createModelRun rejects an endpoint of another version", async () => {
  const otherVersion = expectKind(await createModelVersion(context, {
    family: "other",
    name: "other",
    source: "local/other",
    checkpointDigest: "b".repeat(64),
    quant: "none",
    license: "unknown",
  }), "created");
  const result = await createModelRun(context, openloopRunInput({
    modelVersionId: otherVersion.version.id,
  }));
  assert.deepEqual(result, { kind: "endpoint_not_found" });
});

test("ledger: queued -> running -> succeeded, descriptor resolved once, terminal rows frozen", async () => {
  const created = expectKind(await createModelRun(context, openloopRunInput()), "created");
  const runId = created.run.id;
  assert.equal(created.run.status, "queued");

  const lease = await leaseNextModelRun({ workerId: "w1", kinds: ["openloop"] });
  assert.ok(lease, "expected a lease");
  assert.equal(lease.runId, runId);
  assert.equal(lease.attemptNumber, 1);
  assert.equal(lease.resolvedDescriptor.kind, "process");

  let detail = (await getModelRun(context, runId))!;
  assert.equal(detail.run.status, "running");
  assert.deepEqual(detail.run.resolvedDescriptor, lease.resolvedDescriptor);
  assert.equal(detail.attempts.length, 1);
  assert.equal(detail.attempts[0]!.state, "active");

  await completeModelRun(lease, {
    metrics: { itemCount: 1 },
    outputRefs: [{ kind: "directory", path: "/tmp/x" }],
  });
  detail = (await getModelRun(context, runId))!;
  assert.equal(detail.run.status, "succeeded");
  assert.deepEqual(detail.run.metrics, { itemCount: 1 });
  assert.equal(detail.attempts[0]!.state, "succeeded");
  assert.ok(detail.attempts[0]!.finishedAt);
  assert.deepEqual(
    detail.events.map((event) => event.eventType),
    ["run.queued", "attempt.started", "run.succeeded"],
  );

  // Terminal rows are frozen by the database trigger, not by store politeness.
  await assert.rejects(
    execute(`UPDATE simforge.model_runs SET metrics_json = '{}'::jsonb WHERE id = :id`, { id: runId }),
    /model_run_terminal_immutable/,
  );
  await assert.rejects(
    execute(`DELETE FROM simforge.model_runs WHERE id = :id`, { id: runId }),
    /model_run_terminal_immutable/,
  );
  // Attempts are append-only.
  await assert.rejects(
    execute(`DELETE FROM simforge.model_run_attempts WHERE run_id = :id`, { id: runId }),
    /model_run_attempt_append_only/,
  );
  await assert.rejects(
    execute(
      `UPDATE simforge.model_run_attempts SET state = 'failed', finished_at = NOW(), error_code = 'x' WHERE run_id = :id`,
      { id: runId },
    ),
    /model_run_attempt_append_only/,
  );
  // Events are append-only.
  await assert.rejects(
    execute(`DELETE FROM simforge.model_run_events WHERE run_id = :id`, { id: runId }),
    /model_run_event_append_only/,
  );
});

test("ledger: retry opens attempt 2 with the identical descriptor snapshot", async () => {
  const created = expectKind(await createModelRun(context, openloopRunInput({ maxAttempts: 3 })), "created");
  const runId = created.run.id;

  const first = (await leaseNextModelRun({ workerId: "w1", kinds: ["openloop"] }))!;
  assert.equal(first.runId, runId);
  const requeued = await failModelRunAttempt(first, { errorCode: "endpoint_exited" });
  assert.equal(requeued.runStatus, "queued");

  let detail = (await getModelRun(context, runId))!;
  assert.equal(detail.run.status, "queued");
  assert.equal(detail.attempts[0]!.state, "failed");
  assert.equal(detail.attempts[0]!.errorCode, "endpoint_exited");

  const second = (await leaseNextModelRun({ workerId: "w2", kinds: ["openloop"] }))!;
  assert.equal(second.runId, runId);
  assert.equal(second.attemptNumber, 2);
  assert.deepEqual(second.resolvedDescriptor, first.resolvedDescriptor);

  await completeModelRun(second, { metrics: { itemCount: 1 }, outputRefs: [] });
  detail = (await getModelRun(context, runId))!;
  assert.equal(detail.run.status, "succeeded");
  assert.equal(detail.attempts.length, 2);
  assert.deepEqual(
    detail.attempts.map((attempt) => attempt.state),
    ["failed", "succeeded"],
  );
});

test("ledger: attempt exhaustion is terminal failure", async () => {
  const created = expectKind(await createModelRun(context, openloopRunInput({ maxAttempts: 1 })), "created");
  const runId = created.run.id;
  const lease = (await leaseNextModelRun({ workerId: "w1", kinds: ["openloop"] }))!;
  const settled = await failModelRunAttempt(lease, { errorCode: "endpoint_unhealthy" });
  assert.equal(settled.runStatus, "failed");
  const detail = (await getModelRun(context, runId))!;
  assert.equal(detail.run.status, "failed");
  assert.ok(detail.run.completedAt);
  await assert.rejects(
    execute(`UPDATE simforge.model_runs SET status = 'queued' WHERE id = :id`, { id: runId }),
    /model_run_terminal_immutable/,
  );
});

test("promotion requires a succeeded eval run of the same version", async () => {
  // A queued run is not promotion evidence.
  const queued = expectKind(await createModelRun(context, openloopRunInput()), "created");
  const rejected = await promoteModelVersion(context, versionId, queued.run.id);
  assert.equal(rejected.kind, "invalid_promotion");

  // A succeeded openloop run is.
  const lease = (await leaseNextModelRun({ workerId: "w1", kinds: ["openloop"] }))!;
  await completeModelRun(lease, { metrics: {}, outputRefs: [] });
  const promoted = expectKind(await promoteModelVersion(context, versionId, lease.runId), "promoted");
  assert.equal(promoted.version.status, "promoted");
  const version = (await getModelVersion(context, versionId))!;
  assert.equal(version.version.promotedRunId, lease.runId);
});
