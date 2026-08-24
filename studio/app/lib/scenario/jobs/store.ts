import type { AppContext } from "@/app/lib/db/app-context";
import { queryRows } from "@/app/lib/db/data-api";
import type { ScenarioJobFamily } from "./contracts";
import { settlePipelineJob, withScenarioJobTransaction } from "./lifecycle-lock";

type JobRow = {
  id: string;
  job_family: ScenarioJobFamily;
  revision_id: string;
  job_type: string;
  state: string;
  priority: number;
  progress: number;
  attempt_count: number;
  max_attempts: number;
  failure_code: string | null;
  failure_detail: unknown;
  cancel_requested_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

function dto(row: JobRow) {
  return {
    id: row.id,
    family: row.job_family,
    revisionId: row.revision_id,
    type: row.job_type,
    status: row.state,
    priority: Number(row.priority),
    progress: Number(row.progress),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    cancelRequestedAt: row.cancel_requested_at,
    failureCode: row.failure_code,
    failureDetail: row.failure_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

const COLUMNS = `id, job_family, revision_id, job_type, state, priority, progress,
  attempt_count, max_attempts, failure_code, failure_detail,
  cancel_requested_at::text AS cancel_requested_at,
  created_at::text AS created_at, updated_at::text AS updated_at,
  started_at::text AS started_at, completed_at::text AS completed_at`;

export async function listOperationalJobs(
  context: AppContext,
  input: {
    family?: ScenarioJobFamily | null;
    revisionId?: string | null;
    limit?: number;
  } = {},
) {
  const rows = await queryRows<JobRow>(
    `SELECT ${COLUMNS} FROM uniscenario.operational_jobs
      WHERE workspace_id = :workspace_id
        ${input.family ? "AND job_family = :job_family" : ""}
        ${input.revisionId ? "AND revision_id = :revision_id" : ""}
      ORDER BY created_at DESC, id DESC LIMIT :row_limit`,
    {
      workspace_id: context.workspaceId,
      ...(input.family ? { job_family: input.family } : {}),
      ...(input.revisionId ? { revision_id: input.revisionId } : {}),
      row_limit: Math.max(1, Math.min(input.limit ?? 100, 100)),
    },
  );
  return rows.map(dto);
}

export async function getOperationalJob(
  context: Pick<AppContext, "workspaceId">,
  jobId: string,
) {
  const rows = await queryRows<JobRow>(
    `SELECT ${COLUMNS} FROM uniscenario.operational_jobs
      WHERE workspace_id = :workspace_id AND id = :job_id LIMIT 1`,
    { workspace_id: context.workspaceId, job_id: jobId },
  );
  return rows[0] ? dto(rows[0]) : null;
}

type CancellationOptions = {
  family?: ScenarioJobFamily | null;
  reason?: string;
  requestedBy?: "user" | "admin";
};

export async function cancelOperationalJobWithResult(
  context: Pick<AppContext, "workspaceId">,
  jobId: string,
  options: CancellationOptions = {},
) {
  const current = await queryRows<{ job_family: ScenarioJobFamily }>(
    `SELECT job_family FROM uniscenario.operational_jobs
      WHERE workspace_id = :workspace_id AND id = :job_id
        ${options.family ? "AND job_family = :job_family" : ""}
      LIMIT 1`,
    {
      workspace_id: context.workspaceId,
      job_id: jobId,
      ...(options.family ? { job_family: options.family } : {}),
    },
  );
  const family = current[0]?.job_family;
  if (!family) return { job: null, family: null, mutated: false };
  const reason = options.reason?.trim() || "user_requested";
  const requestedBy = options.requestedBy ?? "user";
  const detail = { reason, requestedBy, acknowledgedByWorker: false };
  const mutated = await withScenarioJobTransaction(jobId, async (tx) => {
    let activeAttemptId: string | null = null;
    let changed = false;

    if (family === "openscenario_compile") {
      const job = await tx.queryOne<{ id: string }>(
        `UPDATE uniscenario.exports
         SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
             export_state = 'cancelled', completed_at = COALESCE(completed_at, NOW()),
             error_code = COALESCE(error_code, 'cancelled'),
             error_detail = COALESCE(error_detail, CAST(:detail AS jsonb)), updated_at = NOW()
         WHERE workspace_id = :workspace_id AND id = :job_id
           AND export_state NOT IN ('succeeded', 'failed', 'cancelled')
         RETURNING id`,
        { workspace_id: context.workspaceId, job_id: jobId, detail },
      );
      changed = Boolean(job);
      if (changed) {
        const activeAttempt = await tx.queryOne<{ id: string }>(
          `UPDATE uniscenario.export_attempts
              SET attempt_state = 'cancelled', completed_at = COALESCE(completed_at, NOW()),
                  failure_code = 'cancelled', failure_detail = CAST(:detail AS jsonb)
            WHERE workspace_id = :workspace_id AND export_id = :job_id
              AND attempt_state = 'active'
            RETURNING id`,
          { workspace_id: context.workspaceId, job_id: jobId, detail },
        );
        activeAttemptId = activeAttempt?.id ?? null;
      }
    } else if (family === "openscenario_validate") {
      const job = await tx.queryOne<{ id: string }>(
        `UPDATE uniscenario.validation_runs
         SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
             validation_state = 'cancelled', completed_at = COALESCE(completed_at, NOW()),
             failure_code = COALESCE(failure_code, 'cancelled'),
             failure_detail = COALESCE(failure_detail, CAST(:detail AS jsonb)), updated_at = NOW()
         WHERE workspace_id = :workspace_id AND id = :job_id
           AND validation_state NOT IN ('passed', 'failed', 'cancelled')
         RETURNING id`,
        { workspace_id: context.workspaceId, job_id: jobId, detail },
      );
      changed = Boolean(job);
      if (changed) {
        const activeAttempt = await tx.queryOne<{ id: string }>(
          `UPDATE uniscenario.cpu_job_attempts
              SET attempt_state = 'cancelled', completed_at = COALESCE(completed_at, NOW()),
                  failure_code = 'cancelled', failure_detail = CAST(:detail AS jsonb)
            WHERE workspace_id = :workspace_id AND job_family = 'openscenario_validate'
              AND job_id = :job_id AND attempt_state = 'active'
            RETURNING id`,
          { workspace_id: context.workspaceId, job_id: jobId, detail },
        );
        activeAttemptId = activeAttempt?.id ?? null;
      }
    } else if (family === "artifact_postprocess") {
      const canonical = await tx.queryOne<{
        canonical_exists: boolean;
        state: string | null;
        postprocess_kind: string | null;
      }>(
        `WITH current AS (
           SELECT id FROM uniscenario.artifact_postprocess_jobs
            WHERE workspace_id = :workspace_id AND id = :job_id FOR UPDATE
         ), updated AS (
           UPDATE uniscenario.artifact_postprocess_jobs job
              SET cancel_requested_at = COALESCE(job.cancel_requested_at, NOW()),
                  cancel_reason = COALESCE(job.cancel_reason, :reason),
                  state = 'cancelled', phase = 'cancelled',
                  completed_at = COALESCE(job.completed_at, NOW()),
                  failure_code = COALESCE(job.failure_code, 'cancelled'),
                  failure_detail = COALESCE(job.failure_detail, CAST(:detail AS jsonb)),
                  updated_at = NOW()
             FROM current
            WHERE job.id = current.id AND job.state NOT IN ('succeeded', 'failed', 'cancelled')
            RETURNING job.state, job.postprocess_kind
         )
         SELECT EXISTS(SELECT 1 FROM current) AS canonical_exists,
                (SELECT state FROM updated LIMIT 1) AS state,
                (SELECT postprocess_kind FROM updated LIMIT 1) AS postprocess_kind`,
        { workspace_id: context.workspaceId, job_id: jobId, reason, detail },
      );
      if (canonical?.canonical_exists && canonical.state === "cancelled") {
        changed = true;
        await tx.execute(
          `UPDATE dataset_export_tasks
           SET status = 'cancelled', lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, error_code = 'cancelled',
               error_message = 'Canonical artifact postprocess job cancelled by the control plane.',
               finished_at = COALESCE(finished_at, NOW()), updated_at = NOW()
           WHERE workspace_id = :workspace_id AND dataset_export_job_id = :job_id
             AND status IN ('queued', 'running')`,
          { workspace_id: context.workspaceId, job_id: jobId },
        );
        await tx.execute(
          `UPDATE dataset_export_task_attempts attempt
              SET status = 'cancelled', error_code = 'cancelled',
                  error_message = 'Canonical artifact postprocess job cancelled by the control plane.',
                  finished_at = COALESCE(finished_at, NOW())
            FROM dataset_export_tasks task
           WHERE task.id = attempt.dataset_export_task_id
             AND task.workspace_id = :workspace_id
             AND task.dataset_export_job_id = :job_id
             AND attempt.status = 'running'`,
          { workspace_id: context.workspaceId, job_id: jobId },
        );
        const activeAttempt = await tx.queryOne<{ id: string }>(
          `UPDATE uniscenario.cpu_job_attempts
              SET attempt_state = 'cancelled', completed_at = COALESCE(completed_at, NOW()),
                  failure_code = 'cancelled',
                  failure_detail = CAST(:detail AS jsonb)
            WHERE workspace_id = :workspace_id
              AND job_family = 'artifact_postprocess' AND job_id = :job_id
              AND attempt_state = 'active'
            RETURNING id`,
          { workspace_id: context.workspaceId, job_id: jobId, detail },
        );
        activeAttemptId = activeAttempt?.id ?? null;
      } else if (!canonical?.canonical_exists) {
        const compatibility = await tx.queryOne<{ id: string }>(
          `UPDATE uniscenario.render_jobs
           SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
               job_state = 'cancelled', completed_at = COALESCE(completed_at, NOW()),
               failure_code = COALESCE(failure_code, 'cancelled'),
               failure_detail = COALESCE(failure_detail, CAST(:detail AS jsonb)), updated_at = NOW()
           WHERE workspace_id = :workspace_id AND id = :job_id
             AND job_mode IN ('cosmos_augment', 'vlm_annotate')
             AND job_state NOT IN ('succeeded', 'failed', 'cancelled')
           RETURNING id`,
          { workspace_id: context.workspaceId, job_id: jobId, detail },
        );
        changed = Boolean(compatibility);
        if (changed) {
          const activeAttempt = await tx.queryOne<{ id: string }>(
            `UPDATE uniscenario.cpu_job_attempts
                SET attempt_state = 'cancelled', completed_at = COALESCE(completed_at, NOW()),
                    failure_code = 'cancelled', failure_detail = CAST(:detail AS jsonb)
              WHERE workspace_id = :workspace_id AND job_family = 'artifact_postprocess'
                AND job_id = :job_id AND attempt_state = 'active'
              RETURNING id`,
            { workspace_id: context.workspaceId, job_id: jobId, detail },
          );
          activeAttemptId = activeAttempt?.id ?? null;
        }
      }
    } else {
      const job = await tx.queryOne<{ id: string }>(
        `UPDATE uniscenario.render_jobs
         SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
             job_state = 'cancelled', completed_at = COALESCE(completed_at, NOW()),
             failure_code = COALESCE(failure_code, 'cancelled'),
             failure_detail = COALESCE(failure_detail, CAST(:detail AS jsonb)), updated_at = NOW()
         WHERE workspace_id = :workspace_id AND id = :job_id
           AND job_state NOT IN ('succeeded', 'failed', 'cancelled')
         RETURNING id`,
        { workspace_id: context.workspaceId, job_id: jobId, detail },
      );
      changed = Boolean(job);
      if (changed) {
        await tx.execute(
          `UPDATE uniscenario.worker_leases SET lease_state = 'revoked', released_at = COALESCE(released_at, NOW())
            WHERE render_job_id = :job_id AND lease_state = 'active'`,
          { job_id: jobId },
        );
        const activeAttempt = await tx.queryOne<{ id: string }>(
          `UPDATE uniscenario.render_attempts
              SET attempt_state = 'cancelled', completed_at = COALESCE(completed_at, NOW())
            WHERE workspace_id = :workspace_id AND render_job_id = :job_id
              AND attempt_state IN ('leased', 'running')
            RETURNING id`,
          { workspace_id: context.workspaceId, job_id: jobId },
        );
        activeAttemptId = activeAttempt?.id ?? null;
        await tx.execute(
          `UPDATE uniscenario.artifact_uploads SET upload_state = 'cancelled'
            WHERE workspace_id = :workspace_id AND render_job_id = :job_id
              AND upload_state = 'reserved'`,
          { workspace_id: context.workspaceId, job_id: jobId },
        );
      }
    }

    if (!changed) return false;
    if (family === "openscenario_render") {
      await tx.execute(
        `INSERT INTO uniscenario.job_events (
           id, workspace_id, render_job_id, render_attempt_id, event_ordinal,
           worker_sequence, event_type, event_payload, occurred_at
         ) SELECT 'usje_' || substr(md5(:workspace_id || ':' || :job_id || ':cancelled'), 1, 24),
                  :workspace_id, :job_id, :attempt_id, COALESCE(MAX(event_ordinal), 0) + 1,
                  NULL, 'cancelled', CAST(:event_payload AS jsonb), NOW()
             FROM uniscenario.job_events WHERE render_job_id = :job_id
         ON CONFLICT (id) DO NOTHING`,
        {
          workspace_id: context.workspaceId,
          job_id: jobId,
          attempt_id: activeAttemptId,
          event_payload: detail,
        },
      );
    } else {
      await tx.execute(
        `INSERT INTO uniscenario.operational_job_events (
           id, workspace_id, job_family, job_id, attempt_id,
           event_ordinal, event_type, event_payload
         ) SELECT 'usoe_' || substr(md5(:workspace_id || ':' || :job_family || ':' || :job_id || ':cancelled'), 1, 24),
                  :workspace_id, :job_family, :job_id, :attempt_id,
                  COALESCE(MAX(event_ordinal), 0) + 1, 'cancelled', CAST(:event_payload AS jsonb)
             FROM uniscenario.operational_job_events
            WHERE workspace_id = :workspace_id AND job_family = :job_family AND job_id = :job_id
         ON CONFLICT (id) DO NOTHING`,
        {
          workspace_id: context.workspaceId,
          job_family: family,
          job_id: jobId,
          attempt_id: activeAttemptId,
          event_payload: detail,
        },
      );
    }
    await settlePipelineJob(tx, {
      workspaceId: context.workspaceId,
      jobFamily: family,
      jobId,
      outcome: "cancelled",
    });
    return true;
  });
  return { job: await getOperationalJob(context, jobId), family, mutated };
}

export async function cancelOperationalJob(context: AppContext, jobId: string) {
  return (await cancelOperationalJobWithResult(context, jobId)).job;
}
