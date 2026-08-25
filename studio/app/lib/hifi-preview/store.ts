/**
 * Queue store for the `hifi_preview` worker family (simforge schema; see
 * migrations/20260825090000_simforge_hifi_preview.sql). Mirrors the
 * model-run store conventions: API routes create/read requests with an
 * AppContext; the worker leases/completes them store-direct.
 */
import type { AppContext } from "../db/app-context";
import { queryOne, queryRows, withTransaction } from "../db/data-api";
import { hifiPreviewRequestId } from "../db/ids";
import { getPresignedGetUrl } from "../s3/s3-presign";
import type {
  CreateHifiPreviewInput,
  HifiPreviewProfile,
  HifiPreviewProvenance,
  HifiPreviewRecord,
  HifiPreviewStatus,
} from "./contracts";

type RequestRow = {
  id: string;
  workspace_id: string;
  document_id: string | null;
  map_version_id: string;
  profile: HifiPreviewProfile;
  tick: number;
  request_json: CreateHifiPreviewInput | string;
  status: HifiPreviewStatus;
  worker_id: string | null;
  error_code: string | null;
  error_detail: Record<string, unknown> | string | null;
  artifact_bucket: string | null;
  artifact_key: string | null;
  provenance_json: HifiPreviewProvenance | string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

/** PGlite/pg hand back jsonb as objects; the Data API may hand back text. */
function parseJsonb<T>(value: T | string | null): T | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

async function recordOf(row: RequestRow): Promise<HifiPreviewRecord> {
  return {
    id: row.id,
    documentId: row.document_id,
    mapVersionId: row.map_version_id,
    profile: row.profile,
    tick: row.tick,
    status: row.status,
    errorCode: row.error_code,
    errorDetail: parseJsonb(row.error_detail),
    artifactUrl:
      row.status === "succeeded" && row.artifact_bucket && row.artifact_key
        ? await getPresignedGetUrl(row.artifact_key, row.artifact_bucket)
        : null,
    provenance: parseJsonb(row.provenance_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function createHifiPreviewRequest(
  context: AppContext,
  input: CreateHifiPreviewInput,
): Promise<HifiPreviewRecord> {
  const id = hifiPreviewRequestId();
  const row = await queryOne<RequestRow>(
    `INSERT INTO simforge.hifi_preview_requests
       (id, workspace_id, document_id, map_version_id, profile, tick, request_json)
     VALUES (:id, :workspace_id, :document_id, :map_version_id, :profile, :tick, :request)
     RETURNING *`,
    {
      id,
      workspace_id: context.workspaceId,
      document_id: input.documentId ?? null,
      map_version_id: input.mapVersionId,
      profile: input.profile,
      tick: input.tick,
      request: input as unknown as Record<string, unknown>,
    },
  );
  return recordOf(row!);
}

export async function getHifiPreviewRequest(
  context: AppContext,
  requestId: string,
): Promise<HifiPreviewRecord | null> {
  const row = await queryOne<RequestRow>(
    `SELECT * FROM simforge.hifi_preview_requests
     WHERE id = :id AND workspace_id = :workspace_id`,
    { id: requestId, workspace_id: context.workspaceId },
  );
  return row ? recordOf(row) : null;
}

export type LeasedHifiPreview = {
  requestId: string;
  workspaceId: string;
  request: CreateHifiPreviewInput;
};

/** Lease the oldest queued request: queued -> running, single attempt. */
export async function leaseNextHifiPreview(input: {
  workerId: string;
}): Promise<LeasedHifiPreview | null> {
  return withTransaction(async (tx) => {
    const candidate = await tx.queryOne<RequestRow>(
      `SELECT * FROM simforge.hifi_preview_requests
       WHERE status = 'queued'
       ORDER BY created_at, id
       LIMIT 1`,
    );
    if (!candidate) return null;
    const updated = await tx.queryOne<{ id: string }>(
      `UPDATE simforge.hifi_preview_requests
       SET status = 'running', worker_id = :worker_id,
           started_at = NOW(), updated_at = NOW()
       WHERE id = :id AND status = 'queued'
       RETURNING id`,
      { id: candidate.id, worker_id: input.workerId },
    );
    if (!updated) return null;
    return {
      requestId: candidate.id,
      workspaceId: candidate.workspace_id,
      request: parseJsonb(candidate.request_json)!,
    };
  });
}

export async function completeHifiPreview(
  lease: Pick<LeasedHifiPreview, "requestId">,
  result: { artifactBucket: string; artifactKey: string; provenance: HifiPreviewProvenance },
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    `UPDATE simforge.hifi_preview_requests
     SET status = 'succeeded', artifact_bucket = :bucket, artifact_key = :key,
         provenance_json = :provenance, completed_at = NOW(), updated_at = NOW()
     WHERE id = :id AND status = 'running'
     RETURNING id`,
    {
      id: lease.requestId,
      bucket: result.artifactBucket,
      key: result.artifactKey,
      provenance: result.provenance as unknown as Record<string, unknown>,
    },
  );
  if (!row) throw new Error(`hifi preview ${lease.requestId} is not running`);
}

export async function failHifiPreview(
  lease: Pick<LeasedHifiPreview, "requestId">,
  failure: { errorCode: string; errorDetail?: Record<string, unknown> },
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    `UPDATE simforge.hifi_preview_requests
     SET status = 'failed', error_code = :code, error_detail = :detail,
         completed_at = NOW(), updated_at = NOW()
     WHERE id = :id AND status = 'running'
     RETURNING id`,
    {
      id: lease.requestId,
      code: failure.errorCode,
      detail: failure.errorDetail ?? {},
    },
  );
  if (!row) throw new Error(`hifi preview ${lease.requestId} is not running`);
}

export type MapBrowserPayload = {
  relativePath: string;
  bucket: string;
  key: string;
  sha256: string;
  byteLength: number;
};

/** All verified published 3D members for native-corpus source resolution. */
export async function getMapBrowserPayloads(
  workspaceId: string,
  mapVersionId: string,
): Promise<MapBrowserPayload[]> {
  const rows = await queryRows<{
    relative_path: string;
    storage_bucket: string;
    storage_key: string;
    sha256: string;
    byte_length: number | string;
  }>(
    `SELECT m.relative_path, b.storage_bucket, b.storage_key, b.sha256, b.byte_length
     FROM simforge.map_versions mv
     JOIN simforge.browser_asset_sets s ON s.id = mv.browser_asset_set_id
       AND s.workspace_id = mv.workspace_id AND s.map_version_id = mv.id
       AND s.asset_set_state = 'available'
     JOIN simforge.browser_asset_members m ON m.asset_set_id = s.id
       AND m.relative_path LIKE '3d/%'
     JOIN simforge.browser_asset_blobs b ON b.id = m.blob_id
       AND b.verification_state = 'verified'
     WHERE mv.id = :map_version_id
       AND mv.workspace_id = :workspace_id
       AND mv.retired_at IS NULL
     ORDER BY m.relative_path`,
    { workspace_id: workspaceId, map_version_id: mapVersionId },
  );
  return rows.map((row) => ({
    relativePath: row.relative_path,
    bucket: row.storage_bucket,
    key: row.storage_key,
    sha256: row.sha256,
    byteLength: Number(row.byte_length),
  }));
}
