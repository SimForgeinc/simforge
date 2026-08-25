import type { AppContext } from "../db/app-context";
import { queryOne, queryRows, withTransaction, type Transaction } from "../db/data-api";
import { modelRunAttemptId, modelRunEventId, modelRunId } from "../db/ids";
import {
  ModelEndpointDescriptorSchema,
  type CreateModelRunInput,
  type ModelEndpointDescriptor,
  type ModelRunAttemptRecord,
  type ModelRunEventRecord,
  type ModelRunKind,
  type ModelRunRecord,
} from "./contracts";
import { endpointDescriptorOfRow } from "./model-registry-store";

type RunRow = {
  id: string;
  workspace_id: string;
  model_version_id: string;
  endpoint_id: string;
  kind: ModelRunKind;
  status: "queued" | "running" | "succeeded" | "failed";
  params_json: Record<string, unknown>;
  seed: string | number;
  resolved_descriptor_json: Record<string, unknown> | null;
  metrics_json: Record<string, unknown> | null;
  output_refs: unknown[];
  attempt_count: number;
  max_attempts: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type AttemptRow = {
  id: string;
  run_id: string;
  attempt_number: number;
  worker_id: string;
  state: "active" | "succeeded" | "failed";
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
  error_detail: Record<string, unknown> | null;
};

type EventRow = {
  id: string;
  run_id: string;
  attempt_id: string | null;
  event_ordinal: string | number;
  event_type: string;
  event_payload: Record<string, unknown>;
  occurred_at: string;
};

function runRecord(row: RunRow): ModelRunRecord {
  return {
    id: row.id,
    modelVersionId: row.model_version_id,
    endpointId: row.endpoint_id,
    kind: row.kind,
    status: row.status,
    params: row.params_json,
    seed: Number(row.seed),
    resolvedDescriptor: row.resolved_descriptor_json
      ? ModelEndpointDescriptorSchema.parse(row.resolved_descriptor_json)
      : null,
    metrics: row.metrics_json,
    outputRefs: row.output_refs,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function attemptRecord(row: AttemptRow): ModelRunAttemptRecord {
  return {
    id: row.id,
    runId: row.run_id,
    attemptNumber: row.attempt_number,
    workerId: row.worker_id,
    state: row.state,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
  };
}

async function insertRunEvent(
  tx: Transaction,
  input: {
    workspaceId: string;
    runId: string;
    attemptId?: string | null;
    type: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const next = await tx.queryOne<{ ordinal: string | number }>(
    `SELECT COALESCE(MAX(event_ordinal), 0) + 1 AS ordinal
     FROM simforge.model_run_events WHERE run_id = :run_id`,
    { run_id: input.runId },
  );
  const ordinal = Number(next!.ordinal);
  await tx.execute(
    `INSERT INTO simforge.model_run_events
       (id, workspace_id, run_id, attempt_id, event_ordinal, event_type, event_payload)
     VALUES (:id, :workspace_id, :run_id, :attempt_id, :ordinal, :type, :payload)`,
    {
      id: modelRunEventId(input.runId, ordinal),
      workspace_id: input.workspaceId,
      run_id: input.runId,
      attempt_id: input.attemptId ?? null,
      ordinal,
      type: input.type,
      payload: input.payload ?? {},
    },
  );
}

export async function createModelRun(
  context: AppContext,
  input: CreateModelRunInput,
): Promise<{ kind: "created"; run: ModelRunRecord } | { kind: "endpoint_not_found" }> {
  const id = modelRunId();
  return withTransaction(async (tx) => {
    const endpoint = await tx.queryOne<{ id: string }>(
      `SELECT id FROM simforge.model_endpoints
       WHERE id = :id AND workspace_id = :workspace_id
         AND model_version_id = :model_version_id AND enabled`,
      {
        id: input.endpointId,
        workspace_id: context.workspaceId,
        model_version_id: input.modelVersionId,
      },
    );
    if (!endpoint) return { kind: "endpoint_not_found" as const };
    const row = await tx.queryOne<RunRow>(
      `INSERT INTO simforge.model_runs
         (id, workspace_id, model_version_id, endpoint_id, kind, params_json, seed, max_attempts)
       VALUES (:id, :workspace_id, :model_version_id, :endpoint_id, :kind, :params, :seed, :max_attempts)
       RETURNING *`,
      {
        id,
        workspace_id: context.workspaceId,
        model_version_id: input.modelVersionId,
        endpoint_id: input.endpointId,
        kind: input.kind,
        params: input.params,
        seed: input.seed,
        max_attempts: input.maxAttempts,
      },
    );
    await insertRunEvent(tx, {
      workspaceId: context.workspaceId,
      runId: id,
      type: "run.queued",
      payload: { kind: input.kind, endpointId: input.endpointId },
    });
    return { kind: "created" as const, run: runRecord(row!) };
  });
}

export async function listModelRuns(
  context: AppContext,
  filter: { modelVersionId?: string; status?: string } = {},
): Promise<ModelRunRecord[]> {
  const rows = await queryRows<RunRow>(
    `SELECT * FROM simforge.model_runs
     WHERE workspace_id = :workspace_id
       AND (:model_version_id::TEXT IS NULL OR model_version_id = :model_version_id)
       AND (:status::TEXT IS NULL OR status = :status)
     ORDER BY created_at DESC, id`,
    {
      workspace_id: context.workspaceId,
      model_version_id: filter.modelVersionId ?? null,
      status: filter.status ?? null,
    },
  );
  return rows.map(runRecord);
}

export async function getModelRun(
  context: AppContext,
  runId: string,
): Promise<{
  run: ModelRunRecord;
  attempts: ModelRunAttemptRecord[];
  events: ModelRunEventRecord[];
} | null> {
  const row = await queryOne<RunRow>(
    `SELECT * FROM simforge.model_runs WHERE id = :id AND workspace_id = :workspace_id`,
    { id: runId, workspace_id: context.workspaceId },
  );
  if (!row) return null;
  const attempts = await queryRows<AttemptRow>(
    `SELECT * FROM simforge.model_run_attempts WHERE run_id = :run_id ORDER BY attempt_number`,
    { run_id: runId },
  );
  const events = await queryRows<EventRow>(
    `SELECT * FROM simforge.model_run_events WHERE run_id = :run_id ORDER BY event_ordinal`,
    { run_id: runId },
  );
  return {
    run: runRecord(row),
    attempts: attempts.map(attemptRecord),
    events: events.map((event) => ({
      id: event.id,
      runId: event.run_id,
      attemptId: event.attempt_id,
      eventOrdinal: Number(event.event_ordinal),
      eventType: event.event_type,
      eventPayload: event.event_payload,
      occurredAt: event.occurred_at,
    })),
  };
}

export type LeasedModelRun = {
  runId: string;
  workspaceId: string;
  kind: ModelRunKind;
  seed: number;
  params: Record<string, unknown>;
  attemptId: string;
  attemptNumber: number;
  maxAttempts: number;
  /** Snapshot taken at FIRST lease; identical for every retry of the run. */
  resolvedDescriptor: ModelEndpointDescriptor;
};

/**
 * Lease the oldest queued run of one of `kinds`. Transactionally flips the run
 * to `running`, snapshots the endpoint descriptor into
 * `resolved_descriptor_json` if this is the first attempt (retries reuse the
 * snapshot — the descriptor is resolved exactly once per run, enforced by the
 * `model_run_descriptor_resolved_once` trigger), and opens an attempt row.
 */
export async function leaseNextModelRun(input: {
  workerId: string;
  kinds: readonly ModelRunKind[];
}): Promise<LeasedModelRun | null> {
  const kinds = input.kinds.filter((kind) =>
    ["openloop", "policy_episode", "artifact"].includes(kind));
  if (kinds.length === 0) return null;
  const kindList = kinds.map((kind) => `'${kind}'`).join(", ");
  return withTransaction(async (tx) => {
    const candidate = await tx.queryOne<RunRow & { ep_row_id: string }>(
      `SELECT r.*, e.id AS ep_row_id
       FROM simforge.model_runs r
       JOIN simforge.model_endpoints e ON e.id = r.endpoint_id
       WHERE r.status = 'queued' AND r.kind IN (${kindList})
       ORDER BY r.created_at, r.id
       LIMIT 1`,
    );
    if (!candidate) return null;
    let descriptor: ModelEndpointDescriptor;
    if (candidate.resolved_descriptor_json) {
      descriptor = ModelEndpointDescriptorSchema.parse(candidate.resolved_descriptor_json);
    } else {
      const endpointRow = await tx.queryOne<Parameters<typeof endpointDescriptorOfRow>[0]>(
        `SELECT * FROM simforge.model_endpoints WHERE id = :id`,
        { id: candidate.endpoint_id },
      );
      descriptor = endpointDescriptorOfRow(endpointRow!);
    }
    const attemptNumber = candidate.attempt_count + 1;
    const updated = await tx.queryOne<{ id: string }>(
      `UPDATE simforge.model_runs
       SET status = 'running',
           attempt_count = :attempt_number,
           resolved_descriptor_json = COALESCE(resolved_descriptor_json, :descriptor),
           started_at = COALESCE(started_at, NOW()),
           updated_at = NOW()
       WHERE id = :id AND status = 'queued'
       RETURNING id`,
      { id: candidate.id, attempt_number: attemptNumber, descriptor },
    );
    if (!updated) return null;
    const attemptId = modelRunAttemptId(candidate.id, attemptNumber);
    await tx.execute(
      `INSERT INTO simforge.model_run_attempts
         (id, workspace_id, run_id, attempt_number, worker_id, resolved_descriptor_json)
       VALUES (:id, :workspace_id, :run_id, :attempt_number, :worker_id, :descriptor)`,
      {
        id: attemptId,
        workspace_id: candidate.workspace_id,
        run_id: candidate.id,
        attempt_number: attemptNumber,
        worker_id: input.workerId,
        descriptor,
      },
    );
    await insertRunEvent(tx, {
      workspaceId: candidate.workspace_id,
      runId: candidate.id,
      attemptId,
      type: "attempt.started",
      payload: { attemptNumber, workerId: input.workerId },
    });
    return {
      runId: candidate.id,
      workspaceId: candidate.workspace_id,
      kind: candidate.kind,
      seed: Number(candidate.seed),
      params: candidate.params_json,
      attemptId,
      attemptNumber,
      maxAttempts: candidate.max_attempts,
      resolvedDescriptor: descriptor,
    };
  });
}

export async function completeModelRun(
  lease: Pick<LeasedModelRun, "runId" | "attemptId" | "workspaceId">,
  result: { metrics: Record<string, unknown>; outputRefs: unknown[] },
): Promise<void> {
  await withTransaction(async (tx) => {
    const attempt = await tx.queryOne<{ id: string }>(
      `UPDATE simforge.model_run_attempts
       SET state = 'succeeded', finished_at = NOW()
       WHERE id = :id AND state = 'active'
       RETURNING id`,
      { id: lease.attemptId },
    );
    if (!attempt) throw new Error(`model run attempt ${lease.attemptId} is not active`);
    const run = await tx.queryOne<{ id: string }>(
      `UPDATE simforge.model_runs
       SET status = 'succeeded', metrics_json = :metrics, output_refs = :output_refs,
           completed_at = NOW(), updated_at = NOW()
       WHERE id = :id AND status = 'running'
       RETURNING id`,
      { id: lease.runId, metrics: result.metrics, output_refs: result.outputRefs },
    );
    if (!run) throw new Error(`model run ${lease.runId} is not running`);
    await insertRunEvent(tx, {
      workspaceId: lease.workspaceId,
      runId: lease.runId,
      attemptId: lease.attemptId,
      type: "run.succeeded",
      payload: { metrics: result.metrics },
    });
  });
}

/**
 * Fail the active attempt. The run goes back to `queued` while attempts
 * remain, else terminally to `failed`.
 */
export async function failModelRunAttempt(
  lease: Pick<LeasedModelRun, "runId" | "attemptId" | "workspaceId" | "attemptNumber" | "maxAttempts">,
  failure: { errorCode: string; errorDetail?: Record<string, unknown> },
): Promise<{ runStatus: "queued" | "failed" }> {
  return withTransaction(async (tx) => {
    const attempt = await tx.queryOne<{ id: string }>(
      `UPDATE simforge.model_run_attempts
       SET state = 'failed', finished_at = NOW(), error_code = :code, error_detail = :detail
       WHERE id = :id AND state = 'active'
       RETURNING id`,
      { id: lease.attemptId, code: failure.errorCode, detail: failure.errorDetail ?? {} },
    );
    if (!attempt) throw new Error(`model run attempt ${lease.attemptId} is not active`);
    const exhausted = lease.attemptNumber >= lease.maxAttempts;
    const nextStatus = exhausted ? "failed" : "queued";
    const run = await tx.queryOne<{ id: string }>(
      `UPDATE simforge.model_runs
       SET status = :status,
           completed_at = CASE WHEN :status = 'failed' THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE id = :id AND status = 'running'
       RETURNING id`,
      { id: lease.runId, status: nextStatus },
    );
    if (!run) throw new Error(`model run ${lease.runId} is not running`);
    await insertRunEvent(tx, {
      workspaceId: lease.workspaceId,
      runId: lease.runId,
      attemptId: lease.attemptId,
      type: exhausted ? "run.failed" : "attempt.failed",
      payload: { errorCode: failure.errorCode, attemptNumber: lease.attemptNumber },
    });
    return { runStatus: nextStatus };
  });
}
