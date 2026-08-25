import { withTransaction } from "@/app/lib/db/data-api";
import { scenarioId } from "../core";

export type JobTransaction = Parameters<Parameters<typeof withTransaction>[0]>[0];

/**
 * Every SimForge lifecycle writer takes this transaction-scoped lock before
 * locking or updating a job, attempt, lease, task, or event row. Keeping one
 * namespace and one job-id key makes job -> attempt/lease/task the global lock
 * order and also serializes MAX(event_ordinal) + 1 allocation.
 */
export const SCENARIO_JOB_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('scenario-job:' || :job_id)) AS locked";

export async function lockScenarioJob(tx: JobTransaction, jobId: string) {
  await tx.execute(SCENARIO_JOB_LOCK_SQL, { job_id: jobId });
}

export async function withScenarioJobTransaction<T>(
  jobId: string,
  fn: (tx: JobTransaction) => Promise<T>,
) {
  return withTransaction(async (tx) => {
    await lockScenarioJob(tx, jobId);
    return fn(tx);
  });
}

/**
 * Claim the first candidate that remains eligible after its lifecycle lock is
 * acquired. A raced head candidate cannot hide the rest of the bounded,
 * already-ordered admission batch from the current poll.
 */
export async function claimFirstEligibleScenarioJob<TCandidate, TClaim>(
  candidates: readonly TCandidate[],
  jobId: (candidate: TCandidate) => string,
  claim: (tx: JobTransaction, candidate: TCandidate) => Promise<TClaim | null>,
) {
  for (const candidate of candidates) {
    const result = await withScenarioJobTransaction(jobId(candidate), (tx) =>
      claim(tx, candidate),
    );
    if (result) return result;
  }
  return null;
}

export async function settlePipelineJob(
  tx: JobTransaction,
  input: {
    workspaceId: string;
    jobFamily:
      | "openscenario_compile"
      | "openscenario_validate"
      | "openscenario_render"
      | "artifact_postprocess";
    jobId: string;
    outcome: "completed" | "failed" | "cancelled";
  },
) {
  const terminalStatus = input.outcome === "completed" ? "completed" : "failed";
  const params = {
    workspace_id: input.workspaceId,
    job_family: input.jobFamily,
    job_id: input.jobId,
    stage_status: input.outcome,
    terminal_status: terminalStatus,
    request_seed: scenarioId("prr"),
  };
  // Different children have different lifecycle locks. Lock their shared
  // pipeline item first so a later child always sees the refs materialized by
  // an earlier child instead of overwriting them from a stale statement view.
  await tx.execute(
    `SELECT item.id
       FROM pipeline_run_items item
      WHERE item.workspace_id = :workspace_id AND item.job_family = :job_family
        AND item.stage_status IN ('dispatching', 'running')
        AND (
          item.job_id = :job_id OR jsonb_path_exists(
            COALESCE(item.output_refs_json, '[]'::jsonb),
            '$[*] ? (@.kind == "job" && @.id == $jobId && @.metadata.jobFamily == $jobFamily)',
            jsonb_build_object('jobId', :job_id, 'jobFamily', :job_family)
          )
        )
      ORDER BY item.id FOR UPDATE`,
    params,
  );
  await tx.execute(
    `WITH matched AS (
       SELECT item.id, item.pipeline_run_id, item.job_id, item.stage_status,
              COALESCE(item.output_refs_json, '[]'::jsonb) AS output_refs_json
         FROM pipeline_run_items item
        WHERE item.workspace_id = :workspace_id AND item.job_family = :job_family
          AND (
            item.job_id = :job_id OR jsonb_path_exists(
              COALESCE(item.output_refs_json, '[]'::jsonb),
              '$[*] ? (@.kind == "job" && @.id == $jobId && @.metadata.jobFamily == $jobFamily)',
              jsonb_build_object('jobId', :job_id, 'jobFamily', :job_family)
            )
          )
          AND item.stage_status IN ('dispatching', 'running')
     ), grouped AS (
       SELECT matched.*,
              MIN(ref.ordinality) FILTER (
                WHERE ref.value->>'kind' = 'job' AND ref.value->>'id' = :job_id
                  AND ref.value->'metadata'->>'jobFamily' = :job_family
              ) AS first_matching_ordinal
         FROM matched
         CROSS JOIN LATERAL jsonb_array_elements(matched.output_refs_json)
           WITH ORDINALITY AS ref(value, ordinality)
        GROUP BY matched.id, matched.pipeline_run_id, matched.job_id,
                 matched.stage_status, matched.output_refs_json
       HAVING BOOL_OR(ref.value->>'kind' = 'job')
          AND BOOL_OR(
            ref.value->>'kind' = 'job' AND ref.value->>'id' = :job_id
              AND ref.value->'metadata'->>'jobFamily' = :job_family
          )
     ), canonical_artifacts AS (
       SELECT DISTINCT artifact.id, artifact.artifact_kind
         FROM simforge.artifacts artifact
        WHERE :stage_status = 'completed'
          AND artifact.workspace_id = :workspace_id
          AND artifact.artifact_state = 'available' AND artifact.deleted_at IS NULL
          AND (
            EXISTS (
              SELECT 1 FROM simforge.operational_job_artifact_links link
               WHERE link.workspace_id = artifact.workspace_id
                 AND link.artifact_id = artifact.id AND link.job_family = :job_family
                 AND link.job_id = :job_id
            ) OR EXISTS (
              SELECT 1 FROM simforge.artifact_links link
               WHERE link.workspace_id = artifact.workspace_id
                 AND link.artifact_id = artifact.id AND link.render_job_id = :job_id
            )
          )
     ), expanded AS (
       SELECT grouped.id, grouped.pipeline_run_id, grouped.stage_status,
              ref.ordinality, COALESCE(artifact.artifact_kind, '') AS artifact_sort,
              COALESCE(artifact.id, '') AS artifact_sort_id,
              CASE
                WHEN ref.ordinality = grouped.first_matching_ordinal
                 AND :stage_status = 'completed' AND artifact.id IS NOT NULL
                THEN jsonb_build_object(
                  'kind', 'artifact', 'id', artifact.id, 'role', 'pipeline_child_output',
                  'metadata', COALESCE(ref.value->'metadata', '{}'::jsonb) || jsonb_build_object(
                    'artifactType', artifact.artifact_kind,
                    'sourceJobFamily', :job_family, 'sourceJobId', :job_id,
                    'sourceRole', ref.value->>'role',
                    'settlement', jsonb_build_object('state', 'completed', 'materialized', TRUE)
                  )
                )
                WHEN ref.ordinality = grouped.first_matching_ordinal
                THEN ref.value || jsonb_build_object(
                  'metadata', COALESCE(ref.value->'metadata', '{}'::jsonb) || jsonb_build_object(
                    'settlement', jsonb_build_object(
                      'state', :stage_status,
                      'jobFamily', :job_family, 'jobId', :job_id,
                      'materialized', FALSE
                    )
                  )
                )
                ELSE ref.value
              END AS output_ref
         FROM grouped
         CROSS JOIN LATERAL jsonb_array_elements(grouped.output_refs_json)
           WITH ORDINALITY AS ref(value, ordinality)
         LEFT JOIN canonical_artifacts artifact
           ON ref.ordinality = grouped.first_matching_ordinal AND :stage_status = 'completed'
        WHERE ref.ordinality <> grouped.first_matching_ordinal
           OR :stage_status <> 'completed'
           OR artifact.id IS NOT NULL
           OR NOT EXISTS (SELECT 1 FROM canonical_artifacts)
     ), ranked AS (
       SELECT expanded.*,
              ROW_NUMBER() OVER (
                PARTITION BY id,
                  COALESCE(output_ref->>'kind', '') || ':' ||
                  COALESCE(output_ref->>'id', output_ref::text)
                ORDER BY ordinality, artifact_sort, artifact_sort_id
              ) AS ref_rank
         FROM expanded
     ), rewritten AS (
       SELECT id, pipeline_run_id, stage_status,
              COALESCE(
                jsonb_agg(output_ref ORDER BY ordinality, artifact_sort, artifact_sort_id)
                  FILTER (WHERE ref_rank = 1),
                '[]'::jsonb
              ) AS output_refs_json
         FROM ranked GROUP BY id, pipeline_run_id, stage_status
     ), eligible AS (
       SELECT rewritten.id, rewritten.pipeline_run_id, rewritten.output_refs_json,
              CASE
                WHEN :stage_status <> 'completed' THEN :stage_status
                WHEN NOT jsonb_path_exists(
                  rewritten.output_refs_json, '$[*] ? (@.kind == "job")'
                ) THEN 'completed'
                ELSE rewritten.stage_status
              END AS next_status
         FROM rewritten
       UNION ALL
       SELECT matched.id, matched.pipeline_run_id, matched.output_refs_json,
              :stage_status AS next_status
         FROM matched
        WHERE matched.job_id = :job_id
          AND NOT jsonb_path_exists(
            matched.output_refs_json, '$[*] ? (@.kind == "job")'
          )
     ), changed AS (
       UPDATE pipeline_run_items item
          SET stage_status = eligible.next_status,
              output_refs_json = eligible.output_refs_json,
              error_code = CASE
                WHEN :stage_status = 'failed' THEN 'child_job_failed'
                WHEN :stage_status = 'cancelled' THEN 'child_job_cancelled'
                ELSE item.error_code
              END,
              error_message = CASE
                WHEN :stage_status = 'failed' THEN 'Canonical SimForge child job failed.'
                WHEN :stage_status = 'cancelled' THEN 'Canonical SimForge child job was cancelled.'
                ELSE item.error_message
              END,
              updated_at = NOW()
         FROM eligible WHERE item.id = eligible.id
       RETURNING item.pipeline_run_id
     )
     INSERT INTO pipeline_reconciliation_requests (
       id, workspace_id, pipeline_run_id, source_job_family, source_job_id,
       terminal_status, requested_at
     ) SELECT :request_seed || '_' || substr(md5(pipeline_run_id), 1, 12),
              :workspace_id, pipeline_run_id, :job_family, :job_id, :terminal_status, NOW()
         FROM (SELECT DISTINCT pipeline_run_id FROM changed) changed
     ON CONFLICT (pipeline_run_id) WHERE processed_at IS NULL
     DO UPDATE SET source_job_family = EXCLUDED.source_job_family,
                   source_job_id = EXCLUDED.source_job_id,
                   terminal_status = EXCLUDED.terminal_status,
                   generation = pipeline_reconciliation_requests.generation + 1,
                   requested_at = NOW(), processing_started_at = NULL,
                   processing_generation = NULL, processing_token = NULL,
                   last_error = NULL`,
    params,
  );
}

export function settleArtifactPostprocessPipelineJob(
  tx: JobTransaction,
  workspaceId: string,
  jobId: string,
  outcome: "completed" | "failed" | "cancelled",
) {
  return settlePipelineJob(tx, { workspaceId, jobFamily: "artifact_postprocess", jobId, outcome });
}
