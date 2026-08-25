/**
 * Data-API accessors for the `map_asset_enrichment_jobs` table (migration
 * 0040). Two job types share a single row shape — `third_party_enrichment`
 * (DuckDB/Overture worker that also resolves street names inline). Rows are
 * inserted by the Next.js API when enqueuing, and transitioned to running /
 * succeeded / failed / timeout by the Lambda worker itself.
 */
import type { EnrichmentJob, EnrichmentJobStatus, EnrichmentJobType } from "@simforge/studio-shared";
import { execute, queryOne, queryRows } from "./data-api";
import { parseJson as sharedParseJson } from "./json-helpers";

type EnrichmentJobRow = {
  id: string;
  map_asset_id: string;
  job_type: EnrichmentJobType;
  status: EnrichmentJobStatus;
  provider_release: string | null;
  requested_by: string | null;
  sqs_message_id: string | null;
  enqueued_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  attempt_count: number;
  result_json: string | null;
};

function parseJson<T>(raw: string | null): T | null {
  return sharedParseJson<T | null>(raw, null);
}

function rowToJob(row: EnrichmentJobRow): EnrichmentJob {
  return {
    id: row.id,
    map_asset_id: row.map_asset_id,
    job_type: row.job_type,
    status: row.status,
    provider_release: row.provider_release,
    requested_by: row.requested_by,
    sqs_message_id: row.sqs_message_id,
    enqueued_at: row.enqueued_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    error_message: row.error_message,
    attempt_count: Number(row.attempt_count) || 0,
    result_json: parseJson<Record<string, unknown>>(row.result_json),
  };
}

const SELECT_COLUMNS = `
  id,
  map_asset_id,
  job_type,
  status::text AS status,
  provider_release,
  requested_by,
  sqs_message_id,
  enqueued_at::text AS enqueued_at,
  started_at::text AS started_at,
  completed_at::text AS completed_at,
  error_message,
  attempt_count,
  result_json::text AS result_json
`;

/**
 * Atomically insert a new enrichment job row in the `pending` state, subject
 * to the `idx_mae_jobs_active_unique` partial unique index — only one
 * pending/running job per (map_asset_id, job_type) can exist at a time.
 *
 * Returns `true` if the row was inserted (caller should now send to SQS),
 * `false` if another concurrent request already has an active job (caller
 * should re-fetch and return the existing job).
 *
 * This replaces the previous two-step "SELECT then INSERT" pattern so
 * concurrent enqueue attempts can't dispatch duplicate Lambda work.
 */
export async function insertEnrichmentJob(input: {
  id: string;
  mapAssetId: string;
  jobType: EnrichmentJobType;
  providerRelease?: string | null;
  requestedBy?: string | null;
}): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(
    `
      INSERT INTO map_asset_enrichment_jobs (
        id, map_asset_id, job_type, status, provider_release, requested_by
      )
      VALUES (
        :id, :map_asset_id, CAST(:job_type AS map_asset_enrichment_job_type),
        'pending', :provider_release, :requested_by
      )
      ON CONFLICT (map_asset_id, job_type) WHERE status IN ('pending','running')
      DO NOTHING
      RETURNING id
    `,
    {
      id: input.id,
      map_asset_id: input.mapAssetId,
      job_type: input.jobType,
      provider_release: input.providerRelease ?? null,
      requested_by: input.requestedBy ?? null,
    },
  );
  return rows.length > 0;
}

/**
 * Mark a previously-enqueued pending/running job as failed. Used by the
 * enqueue helper's self-heal path: if the SQS send fails after the row was
 * inserted, we flip the row to `failed` so the unique index releases and
 * future enqueue attempts can proceed.
 */
export async function markEnrichmentJobFailed(
  jobId: string,
  errorMessage: string,
): Promise<void> {
  await execute(
    `
      UPDATE map_asset_enrichment_jobs
      SET status = 'failed',
          completed_at = NOW(),
          error_message = :error_message
      WHERE id = :id
        AND status IN ('pending','running')
    `,
    { id: jobId, error_message: errorMessage },
  );
}

/**
 * Store the SQS MessageId returned by SendMessageCommand. Purely for
 * operational debugging — DLQ inspection can cross-reference this column to
 * find the corresponding job row.
 */
export async function setEnrichmentJobSqsMessageId(
  jobId: string,
  sqsMessageId: string,
): Promise<void> {
  await execute(
    `
      UPDATE map_asset_enrichment_jobs
      SET sqs_message_id = :sqs_message_id
      WHERE id = :id
    `,
    { id: jobId, sqs_message_id: sqsMessageId },
  );
}

/**
 * Return the most recent pending/running job for a (map, job_type) pair, or
 * null if none exists. Used by {@link ../enrichment/enqueue-job.enqueueEnrichmentJob}
 * to enforce idempotency — re-enqueues short-circuit to the existing job.
 */
export async function getActiveEnrichmentJob(
  mapAssetId: string,
  jobType: EnrichmentJobType,
): Promise<EnrichmentJob | null> {
  const row = await queryOne<EnrichmentJobRow>(
    `
      SELECT ${SELECT_COLUMNS}
      FROM map_asset_enrichment_jobs
      WHERE map_asset_id = :map_asset_id
        AND job_type = CAST(:job_type AS map_asset_enrichment_job_type)
        AND status IN ('pending','running')
      ORDER BY enqueued_at DESC
      LIMIT 1
    `,
    { map_asset_id: mapAssetId, job_type: jobType },
  );
  return row ? rowToJob(row) : null;
}

/**
 * Return the latest job per job_type for the given map (at most one row per
 * type). Used by the polling endpoint
 * `GET /api/map-assets/{id}/enrichment/status` to surface progress to the UI.
 */
export async function getLatestEnrichmentJobs(
  mapAssetId: string,
): Promise<EnrichmentJob[]> {
  const rows = await queryRows<EnrichmentJobRow>(
    `
      SELECT DISTINCT ON (job_type) ${SELECT_COLUMNS}
      FROM map_asset_enrichment_jobs
      WHERE map_asset_id = :map_asset_id
      ORDER BY job_type, enqueued_at DESC
    `,
    { map_asset_id: mapAssetId },
  );
  return rows.map(rowToJob);
}

/** Lookup a single job by primary key. */
export async function getEnrichmentJobById(
  jobId: string,
): Promise<EnrichmentJob | null> {
  const row = await queryOne<EnrichmentJobRow>(
    `
      SELECT ${SELECT_COLUMNS}
      FROM map_asset_enrichment_jobs
      WHERE id = :id
      LIMIT 1
    `,
    { id: jobId },
  );
  return row ? rowToJob(row) : null;
}
