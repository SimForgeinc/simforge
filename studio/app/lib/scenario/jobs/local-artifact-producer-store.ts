import { queryOne, withTransaction } from "@/app/lib/db/data-api";
import { canonicalJsonSha256, scenarioId } from "@/app/lib/scenario/core";
import {
  lockScenarioJob,
  withScenarioJobTransaction,
  type JobTransaction,
} from "./lifecycle-lock";

type LocalArtifactOperation =
  | "openscenario_import"
  | "materialize_traffic"
  | "browser_simulation_preview"
  | "browser_threejs_recording";

type LocalArtifactProducerInput = {
  workspaceId: string;
  revisionId?: string | null;
  requestedByUserId?: string | null;
  operation: LocalArtifactOperation;
  requestPayload: Record<string, unknown>;
  requestPayloadSha256?: string;
  idempotencyKey?: string;
  artifactKind?: string;
  artifactSha256?: string;
  completed?: boolean;
  initialPhase?: string;
  initialProgress?: number;
  maxAttempts?: number;
  clientSessionExpiresSeconds?: number | null;
};

/**
 * Admit a real, workspace-fenced operational job for local artifact work.
 * Content identity is the idempotency boundary, so concurrent reservations
 * resolve to one auditable producer rather than inventing an opaque job id.
 */
export async function createLocalArtifactProducer(
  input: LocalArtifactProducerInput,
) {
  const idempotencyKey = input.idempotencyKey ?? (
    input.artifactKind && input.artifactSha256
      ? `artifact:${input.artifactKind}:${input.artifactSha256}`
      : null
  );
  if (!idempotencyKey) throw new Error("local_artifact_producer_idempotency_required");
  const requestPayloadSha256 =
    input.requestPayloadSha256 ?? canonicalJsonSha256(input.requestPayload);
  const id = scenarioId("uspp");
  const state = input.completed ? "succeeded" : "running";
  const phase = input.completed
    ? "finalized"
    : input.initialPhase ?? "producing_artifact";
  const progress = input.completed ? 1 : input.initialProgress ?? 0;
  const row = await withScenarioJobTransaction(id, (tx) => tx.queryOne<{ id: string }>(
    `INSERT INTO simforge.artifact_postprocess_jobs (
       id, workspace_id, revision_id, postprocess_kind, state, phase, progress,
       requested_by_user_id, idempotency_key, correlation_id, request_payload,
       request_payload_sha256, result_payload, attempt_count, max_attempts,
       client_heartbeat_at, expires_at, started_at, completed_at, created_at, updated_at
     ) VALUES (
       :id, :workspace_id, :revision_id, :operation, :state, :phase, :progress,
       :user_id, :idempotency_key, :id, CAST(:request_payload AS jsonb),
       :request_payload_sha256, CAST(:result_payload AS jsonb), 1, :max_attempts,
       CASE WHEN CAST(:session_expiry_seconds AS double precision) IS NULL
            THEN NULL ELSE NOW() END,
       CASE WHEN CAST(:session_expiry_seconds AS double precision) IS NULL THEN NULL
            ELSE NOW() + (
              CAST(:session_expiry_seconds AS double precision) * INTERVAL '1 second'
            ) END,
       NOW(), CASE WHEN CAST(:completed AS boolean) THEN NOW() ELSE NULL END,
       NOW(), NOW()
     )
     ON CONFLICT (workspace_id, postprocess_kind, idempotency_key)
       WHERE idempotency_key IS NOT NULL
     DO NOTHING
     RETURNING id`,
    {
      id,
      workspace_id: input.workspaceId,
      revision_id: input.revisionId ?? null,
      operation: input.operation,
      state,
      phase,
      progress,
      user_id: input.requestedByUserId ?? null,
      idempotency_key: idempotencyKey,
      request_payload: input.requestPayload,
      request_payload_sha256: requestPayloadSha256,
      result_payload: input.completed
        ? { artifactKind: input.artifactKind, sha256: input.artifactSha256 }
        : input.operation === "browser_threejs_recording"
          ? null
          : {},
      max_attempts: input.maxAttempts ?? 1,
      session_expiry_seconds: input.clientSessionExpiresSeconds ?? null,
      completed: input.completed ?? false,
    },
  ));
  if (row) return row.id;
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM simforge.artifact_postprocess_jobs
      WHERE workspace_id = :workspace_id AND postprocess_kind = :operation
        AND idempotency_key = :idempotency_key LIMIT 1`,
    {
      workspace_id: input.workspaceId,
      operation: input.operation,
      idempotency_key: idempotencyKey,
    },
  );
  if (!existing) throw new Error("local_artifact_producer_admission_failed");
  return existing.id;
}

/**
 * Atomically publishes a checksum-verified local artifact set and closes its
 * producer. S3 verification happens before this transaction; the lifecycle
 * lock prevents cancellation or expiry from racing the terminal write.
 */
export async function finalizeLocalArtifactProducerSet(
  input: {
    workspaceId: string;
    producerJobId: string;
    artifacts: Array<{ artifactId: string; role: string }>;
    resultPayload: Record<string, unknown>;
  },
  executor?: JobTransaction,
) {
  const finalize = async (tx: JobTransaction) => {
    await lockScenarioJob(tx, input.producerJobId);
    const current = await tx.queryOne<{
      state: string;
      cancel_requested_at: string | null;
      result_matches: boolean;
      closure_matches: boolean;
    }>(
      `WITH declared AS (
         SELECT artifact_id, artifact_role
           FROM jsonb_to_recordset(CAST(:artifacts AS jsonb))
             AS item(artifact_id TEXT, artifact_role TEXT)
       ), linked AS (
         SELECT link.artifact_id, link.artifact_role
           FROM simforge.operational_job_artifact_links link
          WHERE link.workspace_id = :workspace_id
            AND link.job_family = 'artifact_postprocess'
            AND link.job_id = :producer_job_id AND link.attempt_id IS NULL
            AND link.artifact_role IS NOT NULL
       )
       SELECT job.state, job.cancel_requested_at::text AS cancel_requested_at,
              job.result_payload = CAST(:result_payload AS jsonb) AS result_matches,
              NOT EXISTS (SELECT * FROM declared EXCEPT SELECT * FROM linked)
                AND NOT EXISTS (SELECT * FROM linked EXCEPT SELECT * FROM declared)
                AS closure_matches
         FROM simforge.artifact_postprocess_jobs job
        WHERE job.id = :producer_job_id AND job.workspace_id = :workspace_id
          AND job.postprocess_kind = 'browser_threejs_recording'
          AND (
            job.state = 'succeeded'
            OR (
              job.state = 'running' AND job.cancel_requested_at IS NULL
              AND job.expires_at > NOW()
            )
          )
        FOR UPDATE OF job`,
      {
        workspace_id: input.workspaceId,
        producer_job_id: input.producerJobId,
        artifacts: input.artifacts.map((artifact) => ({
          artifact_id: artifact.artifactId,
          artifact_role: artifact.role,
        })),
        result_payload: input.resultPayload,
      },
    );
    if (!current || !current.closure_matches) return false;
    if (current.state === "succeeded") {
      return current.result_matches
        ? { accepted: true as const, alreadySucceeded: true as const }
        : false;
    }
    if (
      current.cancel_requested_at ||
      current.state === "cancelled" ||
      current.state === "failed"
    ) {
      return false;
    }
    const artifactIds = [...new Set(input.artifacts.map((artifact) => artifact.artifactId))];
    const published = await tx.queryRows<{ id: string }>(
      `UPDATE simforge.artifacts artifact
          SET artifact_state = 'available', verified_at = COALESCE(verified_at, NOW())
         FROM simforge.operational_job_artifact_links link
        WHERE link.workspace_id = :workspace_id
          AND link.job_family = 'artifact_postprocess'
          AND link.job_id = :producer_job_id AND link.attempt_id IS NULL
          AND link.artifact_id = artifact.id AND link.workspace_id = artifact.workspace_id
          AND artifact.id = ANY(string_to_array(:artifact_ids, ','))
          AND artifact.artifact_state IN ('pending', 'available')
        RETURNING artifact.id`,
      {
        workspace_id: input.workspaceId,
        producer_job_id: input.producerJobId,
        artifact_ids: artifactIds.join(","),
      },
    );
    if (published.length !== artifactIds.length) return false;
    const row = await tx.queryOne<{ id: string }>(
      `UPDATE simforge.artifact_postprocess_jobs
          SET state = 'succeeded', phase = 'finalized', progress = 1,
              progress_payload = '{}'::jsonb,
              result_payload = CAST(:result_payload AS jsonb),
              completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE id = :producer_job_id AND workspace_id = :workspace_id
          AND postprocess_kind = 'browser_threejs_recording'
          AND state = 'running' AND cancel_requested_at IS NULL
          AND expires_at > NOW()
        RETURNING id`,
      {
        workspace_id: input.workspaceId,
        producer_job_id: input.producerJobId,
        result_payload: input.resultPayload,
      },
    );
    return row
      ? { accepted: true as const, alreadySucceeded: false as const }
      : false;
  };
  return executor ? finalize(executor) : withTransaction(finalize);
}

export async function finalizeLocalArtifactProducer(
  input: { workspaceId: string; artifactId: string },
  executor?: JobTransaction,
) {
  const finalize = async (tx: JobTransaction) => {
    const producer = await tx.queryOne<{ id: string }>(
      `SELECT job.id
         FROM simforge.artifacts artifact
         JOIN simforge.artifact_postprocess_jobs job
           ON job.id = artifact.producer_job_id AND job.workspace_id = artifact.workspace_id
        WHERE artifact.id = :artifact_id AND artifact.workspace_id = :workspace_id
          AND artifact.producer_job_family = 'artifact_postprocess'
          AND job.postprocess_kind IN (
            'openscenario_import', 'materialize_traffic', 'browser_simulation_preview'
          )
        LIMIT 1`,
      { artifact_id: input.artifactId, workspace_id: input.workspaceId },
    );
    if (!producer) return false;
    await lockScenarioJob(tx, producer.id);
    const current = await tx.queryOne<{
      state: string;
      cancel_requested_at: string | null;
      result_matches: boolean;
    }>(
      `SELECT job.state, job.cancel_requested_at::text AS cancel_requested_at,
              job.result_payload = jsonb_build_object(
                'artifactId', artifact.id, 'artifactKind', artifact.artifact_kind,
                'sha256', artifact.sha256, 'provenance', artifact.provenance
              ) AS result_matches
         FROM simforge.artifacts artifact
         JOIN simforge.artifact_postprocess_jobs job
           ON job.id = artifact.producer_job_id AND job.workspace_id = artifact.workspace_id
        WHERE artifact.id = :artifact_id AND artifact.workspace_id = :workspace_id
          AND job.id = :producer_job_id
          AND artifact.producer_job_family = 'artifact_postprocess'
          AND job.postprocess_kind IN (
            'openscenario_import', 'materialize_traffic', 'browser_simulation_preview'
          )
        FOR UPDATE OF job, artifact`,
      {
        artifact_id: input.artifactId,
        workspace_id: input.workspaceId,
        producer_job_id: producer.id,
      },
    );
    if (!current) return false;
    if (current.state === "succeeded") {
      return current.result_matches
        ? { accepted: true as const, alreadySucceeded: true as const }
        : false;
    }
    if (
      current.cancel_requested_at ||
      current.state === "cancelled" ||
      current.state === "failed"
    ) {
      return false;
    }
    const row = await tx.queryOne<{ id: string }>(
      `UPDATE simforge.artifact_postprocess_jobs job
          SET state = 'succeeded', phase = 'finalized', progress = 1,
              result_payload = jsonb_build_object(
                'artifactId', artifact.id, 'artifactKind', artifact.artifact_kind,
                'sha256', artifact.sha256, 'provenance', artifact.provenance
              ),
              completed_at = COALESCE(job.completed_at, NOW()), updated_at = NOW()
         FROM simforge.artifacts artifact
        WHERE artifact.id = :artifact_id AND artifact.workspace_id = :workspace_id
          AND job.id = :producer_job_id AND job.id = artifact.producer_job_id
          AND job.workspace_id = artifact.workspace_id
          AND artifact.producer_job_family = 'artifact_postprocess'
          AND job.postprocess_kind IN (
            'openscenario_import', 'materialize_traffic', 'browser_simulation_preview'
          )
          AND job.state NOT IN ('succeeded', 'failed', 'cancelled')
          AND job.cancel_requested_at IS NULL
          AND (
            artifact.producer_attempt_id IS NULL OR EXISTS (
              SELECT 1 FROM simforge.cpu_job_attempts attempt
               WHERE attempt.id = artifact.producer_attempt_id
                 AND attempt.workspace_id = artifact.workspace_id
                 AND attempt.job_family = 'artifact_postprocess'
                 AND attempt.job_id = job.id AND attempt.attempt_state = 'active'
                 AND attempt.expires_at > NOW()
            )
          )
        RETURNING job.id`,
      {
        artifact_id: input.artifactId,
        workspace_id: input.workspaceId,
        producer_job_id: producer.id,
      },
    );
    return row ? { accepted: true as const, alreadySucceeded: false as const } : false;
  };
  return executor ? finalize(executor) : withTransaction(finalize);
}
