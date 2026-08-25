import type {
  DatasetExportJob,
  DatasetExportPublication,
  DatasetExportRequestedOutput,
  DatasetExportScope,
  DatasetExportTask,
  DatasetExportTaskInput,
  DatasetExportTaskStage,
  ExportFormat,
} from "@simforge/studio-shared";
import {
  DatasetExportRequestedOutputsSchema,
  DatasetExportScopeSchema,
  DatasetExportTaskInputSchema,
  assertDatasetExportRecipeQueueable,
  defaultDatasetExportRequestedOutputs,
  resolveDatasetExportRecipe,
} from "@simforge/studio-shared";
import { normalizeCanonicalJobStatus } from "@simforge/studio-shared";
import {
  datasetExportJobId,
  datasetExportPublicationId,
  datasetExportTaskAttemptId,
  datasetExportTaskId,
} from "./ids";
import { execute, queryOne, queryRows, withTransaction } from "./data-api";

type ExportJobRow = {
  id: string;
  workspace_id: string;
  status: string;
  phase: string;
  job_type: string;
  job_purpose: string | null;
  initiator_surface: string | null;
  priority: number;
  created_by_user_id: string | null;
  idempotency_key: string | null;
  correlation_id: string | null;
  request_json: string;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  cancel_requested_at: string | null;
  cancel_reason: string | null;
  dataset_id: string;
  dataset_snapshot_id: string | null;
  format: string;
  recipe: string | null;
  scope_json: string | null;
  requested_outputs_json: string;
  default_publication_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type ExportTaskRow = {
  id: string;
  workspace_id: string;
  dataset_export_job_id: string;
  stage: string;
  partition_key: string | null;
  status: string;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  last_heartbeat_at: string | null;
  attempt_count: number;
  max_attempts: number;
  input_json: string;
  output_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type PublicationRow = {
  id: string;
  workspace_id: string;
  dataset_export_job_id: string;
  dataset_snapshot_id: string | null;
  kind: string;
  artifact_id: string;
  status: string;
  is_default: boolean;
  published_at: string | null;
  expires_at: string | null;
  metadata_json: string | null;
};

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function validateScopeJson(scopeJson: DatasetExportScope | null | undefined) {
  if (scopeJson == null) return null;
  return DatasetExportScopeSchema.parse(scopeJson);
}

function validateRequestedOutputs(
  format: ExportFormat,
  recipeId: string | null | undefined,
  requestedOutputs: DatasetExportRequestedOutput[] | undefined,
) {
  return DatasetExportRequestedOutputsSchema.parse(
    requestedOutputs?.length
      ? requestedOutputs
      : defaultDatasetExportRequestedOutputs(format, recipeId),
  );
}

function validateTaskInput(
  stage: DatasetExportTaskStage,
  inputJson: Record<string, unknown>,
): DatasetExportTaskInput {
  return DatasetExportTaskInputSchema.parse({
    ...inputJson,
    stage,
  });
}

function rowToJob(row: ExportJobRow): DatasetExportJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    status: normalizeCanonicalJobStatus(row.status),
    phase: row.phase,
    jobType: row.job_type,
    jobPurpose: row.job_purpose as DatasetExportJob["jobPurpose"],
    initiatorSurface: row.initiator_surface as DatasetExportJob["initiatorSurface"],
    priority: row.priority,
    createdByUserId: row.created_by_user_id,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    requestJson: parseJson(row.request_json, {}),
    resultJson: parseJson(row.result_json, null),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    cancelRequestedAt: row.cancel_requested_at,
    cancelReason: row.cancel_reason,
    datasetId: row.dataset_id,
    datasetSnapshotId: row.dataset_snapshot_id,
    format: row.format as ExportFormat,
    recipe: row.recipe,
    scopeJson: parseJson(row.scope_json, null),
    requestedOutputsJson: parseJson<DatasetExportRequestedOutput[]>(
      row.requested_outputs_json,
      [],
    ),
    defaultPublicationId: row.default_publication_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToTask(row: ExportTaskRow): DatasetExportTask {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    datasetExportJobId: row.dataset_export_job_id,
    stage: row.stage as DatasetExportTask["stage"],
    partitionKey: row.partition_key,
    status: row.status as DatasetExportTask["status"],
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    inputJson: parseJson(row.input_json, {}),
    outputJson: parseJson(row.output_json, null),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToPublication(row: PublicationRow): DatasetExportPublication {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    datasetExportJobId: row.dataset_export_job_id,
    datasetSnapshotId: row.dataset_snapshot_id,
    kind: row.kind as DatasetExportPublication["kind"],
    artifactId: row.artifact_id,
    status: row.status as DatasetExportPublication["status"],
    isDefault: row.is_default,
    publishedAt: row.published_at,
    expiresAt: row.expires_at,
    metadataJson: parseJson(row.metadata_json, null),
  };
}

const SELECT_EXPORT_JOB = `
  SELECT
    id, workspace_id, state AS status, phase,
    'dataset_export'::text AS job_type, 'dataset_export'::text AS job_purpose,
    'web'::text AS initiator_surface, priority,
    requested_by_user_id AS created_by_user_id, idempotency_key, correlation_id,
    request_payload::text AS request_json, result_payload::text AS result_json,
    failure_code AS error_code, failure_detail->>'message' AS error_message,
    attempt_count AS retry_count, cancel_requested_at::text AS cancel_requested_at,
    cancel_reason, dataset_id, dataset_snapshot_id, format, recipe,
    scope_json::text AS scope_json, requested_outputs::text AS requested_outputs_json,
    default_publication_id, created_at::text AS created_at, updated_at::text AS updated_at,
    started_at::text AS started_at, completed_at::text AS finished_at
  FROM uniscenario.artifact_postprocess_jobs
`;

export async function createDatasetExportJobV2(input: {
  workspaceId: string;
  datasetId: string;
  datasetSnapshotId?: string | null;
  format: ExportFormat;
  recipe?: string | null;
  scopeJson?: DatasetExportScope | null;
  requestedOutputs?: DatasetExportRequestedOutput[];
  createdByUserId?: string | null;
  idempotencyKey?: string | null;
  correlationId?: string | null;
  pipelineRunId?: string | null;
}): Promise<DatasetExportJob> {
  const id = datasetExportJobId();
  const scopeJson = validateScopeJson(input.scopeJson);
  const recipeDefinition = resolveDatasetExportRecipe(input.format, input.recipe);
  assertDatasetExportRecipeQueueable(recipeDefinition);
  const requestedOutputs = validateRequestedOutputs(
    input.format,
    recipeDefinition.id,
    input.requestedOutputs,
  );
  const snapshotResolveInput = validateTaskInput("snapshot_resolve", {
    datasetId: input.datasetId,
    scope: scopeJson,
  });
  const admittedId = await withTransaction(async (tx) => {
    const existing = input.idempotencyKey
      ? await tx.queryOne<{ id: string }>(
          `SELECT id FROM uniscenario.artifact_postprocess_jobs
           WHERE workspace_id = :workspace_id AND postprocess_kind = 'dataset_export'
             AND idempotency_key = :idempotency_key
           LIMIT 1 FOR UPDATE`,
          { workspace_id: input.workspaceId, idempotency_key: input.idempotencyKey },
        )
      : null;
    if (existing) return existing.id;
    const inserted = await tx.queryOne<{ id: string }>(
      `
        INSERT INTO uniscenario.artifact_postprocess_jobs (
          id, workspace_id, postprocess_kind, state, phase,
          requested_by_user_id, idempotency_key, correlation_id, request_payload,
          dataset_id, dataset_snapshot_id, pipeline_run_id, format, recipe, scope_json, requested_outputs,
          created_at, updated_at
        ) VALUES (
          :id, :workspace_id, 'dataset_export', 'queued', 'snapshot_resolve',
          :created_by_user_id, :idempotency_key, :correlation_id, CAST(:request_json AS JSONB),
          :dataset_id, :snapshot_id, :pipeline_run_id, :format, :recipe, CAST(:scope_json AS JSONB), CAST(:requested_outputs_json AS JSONB), NOW(), NOW()
        )
        ON CONFLICT (workspace_id, postprocess_kind, idempotency_key)
          WHERE idempotency_key IS NOT NULL
        DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
        RETURNING id
      `,
      {
        id,
        workspace_id: input.workspaceId,
        created_by_user_id: input.createdByUserId ?? null,
        idempotency_key: input.idempotencyKey ?? null,
        correlation_id: input.correlationId ?? id,
        request_json: {
          datasetId: input.datasetId,
          snapshotId: input.datasetSnapshotId ?? null,
          format: input.format,
          recipe: input.recipe ?? null,
          scope: scopeJson,
          requestedOutputs,
        },
        dataset_id: input.datasetId,
        snapshot_id: input.datasetSnapshotId ?? null,
        pipeline_run_id: input.pipelineRunId ?? null,
        format: input.format,
        recipe: input.recipe ?? null,
        scope_json: scopeJson,
        requested_outputs_json: requestedOutputs,
      },
    );
    if (!inserted) throw new Error("Failed to admit canonical dataset export job");
    if (inserted.id === id) {
      await tx.execute(
        `
          INSERT INTO dataset_export_tasks (
            id, workspace_id, dataset_export_job_id, stage, partition_key, status,
            input_json, created_at, updated_at
          ) VALUES (
            :task_id, :workspace_id, :job_id, 'snapshot_resolve', 'snapshot', 'queued',
            CAST(:input_json AS JSONB), NOW(), NOW()
          )
        `,
        {
          task_id: datasetExportTaskId(),
          workspace_id: input.workspaceId,
          job_id: inserted.id,
          input_json: snapshotResolveInput,
        },
      );
    }
    return inserted.id;
  });
  const job = await getDatasetExportJobV2(input.workspaceId, admittedId);
  if (!job) throw new Error("Failed to create dataset export job");
  return job;
}

export async function getDatasetExportJobV2(workspaceId: string, id: string): Promise<DatasetExportJob | null> {
  const row = await queryOne<ExportJobRow>(
    `${SELECT_EXPORT_JOB} WHERE postprocess_kind = 'dataset_export'
      AND workspace_id = :workspace_id AND id = :id LIMIT 1`,
    { workspace_id: workspaceId, id },
  );
  return row ? rowToJob(row) : null;
}

export async function listDatasetExportTasks(workspaceId: string, exportJobId: string): Promise<DatasetExportTask[]> {
  const rows = await queryRows<ExportTaskRow>(
    `
      SELECT
        id, workspace_id, dataset_export_job_id, stage, partition_key, status,
        lease_owner, lease_token, lease_expires_at::text AS lease_expires_at,
        last_heartbeat_at::text AS last_heartbeat_at, attempt_count, max_attempts,
        input_json::text AS input_json, output_json::text AS output_json,
        error_code, error_message, created_at::text AS created_at, updated_at::text AS updated_at,
        started_at::text AS started_at, finished_at::text AS finished_at
      FROM dataset_export_tasks
      WHERE workspace_id = :workspace_id AND dataset_export_job_id = :job_id
      ORDER BY created_at ASC
    `,
    { workspace_id: workspaceId, job_id: exportJobId },
  );
  return rows.map(rowToTask);
}

export async function createDatasetExportTask(input: {
  workspaceId: string;
  datasetExportJobId: string;
  stage: DatasetExportTaskStage;
  partitionKey?: string | null;
  inputJson?: Record<string, unknown>;
}): Promise<string> {
  const id = datasetExportTaskId();
  const taskInput = validateTaskInput(input.stage, input.inputJson ?? {});
  await execute(
    `
      INSERT INTO dataset_export_tasks (
        id, workspace_id, dataset_export_job_id, stage, partition_key, status,
        input_json, created_at, updated_at
      ) VALUES (
        :id, :workspace_id, :dataset_export_job_id, :stage, :partition_key, 'queued',
        CAST(:input_json AS JSONB), NOW(), NOW()
      )
    `,
    {
      id,
      workspace_id: input.workspaceId,
      dataset_export_job_id: input.datasetExportJobId,
      stage: input.stage,
      partition_key: input.partitionKey ?? null,
      input_json: taskInput,
    },
  );
  return id;
}

export async function recordDatasetExportTaskAttempt(input: {
  taskId: string;
  attemptNumber: number;
  leaseOwner?: string | null;
  leaseToken?: string | null;
  status?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadataJson?: Record<string, unknown>;
}) {
  await execute(
    `
      INSERT INTO dataset_export_task_attempts (
        id, dataset_export_task_id, attempt_number, lease_owner, lease_token,
        status, error_code, error_message, metadata_json, started_at
      ) VALUES (
        :id, :task_id, :attempt_number, :lease_owner, :lease_token,
        :status, :error_code, :error_message, CAST(:metadata_json AS JSONB), NOW()
      )
      ON CONFLICT (dataset_export_task_id, attempt_number) DO UPDATE SET
        status = EXCLUDED.status,
        error_code = EXCLUDED.error_code,
        error_message = EXCLUDED.error_message,
        metadata_json = EXCLUDED.metadata_json,
        finished_at = CASE WHEN EXCLUDED.status IN ('succeeded','failed','cancelled') THEN NOW() ELSE dataset_export_task_attempts.finished_at END
    `,
    {
      id: datasetExportTaskAttemptId(input.taskId, input.attemptNumber),
      task_id: input.taskId,
      attempt_number: input.attemptNumber,
      lease_owner: input.leaseOwner ?? null,
      lease_token: input.leaseToken ?? null,
      status: input.status ?? "running",
      error_code: input.errorCode ?? null,
      error_message: input.errorMessage ?? null,
      metadata_json: input.metadataJson ?? {},
    },
  );
}

export async function createDatasetExportPublication(input: {
  workspaceId: string;
  datasetExportJobId: string;
  datasetSnapshotId?: string | null;
  kind: DatasetExportPublication["kind"];
  artifactId: string;
  status?: DatasetExportPublication["status"];
  isDefault?: boolean;
  metadataJson?: Record<string, unknown> | null;
}): Promise<DatasetExportPublication> {
  const id = datasetExportPublicationId();
  await execute(
    `
      INSERT INTO dataset_export_publications (
        id, workspace_id, dataset_export_job_id, dataset_snapshot_id, kind,
        uniscenario_artifact_id, status, is_default, published_at, metadata_json
      ) VALUES (
        :id, :workspace_id, :dataset_export_job_id, :dataset_snapshot_id, :kind,
        :artifact_id, :status, :is_default,
        CASE WHEN :status = 'ready' THEN NOW() ELSE NULL END,
        CAST(:metadata_json AS JSONB)
      )
    `,
    {
      id,
      workspace_id: input.workspaceId,
      dataset_export_job_id: input.datasetExportJobId,
      dataset_snapshot_id: input.datasetSnapshotId ?? null,
      kind: input.kind,
      artifact_id: input.artifactId,
      status: input.status ?? "pending",
      is_default: input.isDefault ?? false,
      metadata_json: input.metadataJson ?? {},
    },
  );
  const publication = await getDatasetExportPublication(input.workspaceId, id);
  if (!publication) throw new Error("Failed to create export publication");
  return publication;
}

export async function getDatasetExportPublication(workspaceId: string, id: string): Promise<DatasetExportPublication | null> {
  const row = await queryOne<PublicationRow>(
    `
      SELECT
        id, workspace_id, dataset_export_job_id, dataset_snapshot_id, kind,
        COALESCE(uniscenario_artifact_id, artifact_id) AS artifact_id,
        status, is_default, published_at::text AS published_at,
        expires_at::text AS expires_at, metadata_json::text AS metadata_json
      FROM dataset_export_publications
      WHERE workspace_id = :workspace_id AND id = :id
      LIMIT 1
    `,
    { workspace_id: workspaceId, id },
  );
  return row ? rowToPublication(row) : null;
}

export async function listDatasetExportJobsV2(workspaceId: string, datasetId: string): Promise<DatasetExportJob[]> {
  const rows = await queryRows<ExportJobRow>(
    `${SELECT_EXPORT_JOB}
      WHERE postprocess_kind = 'dataset_export'
        AND workspace_id = :workspace_id AND dataset_id = :dataset_id
      ORDER BY created_at DESC`,
    { workspace_id: workspaceId, dataset_id: datasetId },
  );
  return rows.map(rowToJob);
}

export async function getDefaultDatasetExportPublication(workspaceId: string, exportJobId: string): Promise<DatasetExportPublication | null> {
  const row = await queryOne<PublicationRow>(
    `
      SELECT
        id, workspace_id, dataset_export_job_id, dataset_snapshot_id, kind,
        COALESCE(uniscenario_artifact_id, artifact_id) AS artifact_id,
        status, is_default, published_at::text AS published_at,
        expires_at::text AS expires_at, metadata_json::text AS metadata_json
      FROM dataset_export_publications
      WHERE workspace_id = :workspace_id AND dataset_export_job_id = :job_id AND is_default = TRUE
      ORDER BY
        CASE kind
          WHEN 'prefix' THEN 0
          WHEN 'manifest' THEN 1
          ELSE 2
        END,
        published_at DESC NULLS LAST,
        created_at DESC
      LIMIT 1
    `,
    { workspace_id: workspaceId, job_id: exportJobId },
  );
  return row ? rowToPublication(row) : null;
}

export async function getDatasetExportPublicationByKind(
  workspaceId: string,
  exportJobId: string,
  kind: DatasetExportPublication["kind"],
): Promise<DatasetExportPublication | null> {
  const row = await queryOne<PublicationRow>(
    `
      SELECT
        id, workspace_id, dataset_export_job_id, dataset_snapshot_id, kind,
        COALESCE(uniscenario_artifact_id, artifact_id) AS artifact_id,
        status, is_default, published_at::text AS published_at,
        expires_at::text AS expires_at, metadata_json::text AS metadata_json
      FROM dataset_export_publications
      WHERE workspace_id = :workspace_id
        AND dataset_export_job_id = :job_id
        AND kind = :kind
        AND status = 'ready'
      ORDER BY published_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    `,
    { workspace_id: workspaceId, job_id: exportJobId, kind },
  );
  return row ? rowToPublication(row) : null;
}
