import type { AppContext } from "@/app/lib/db/app-context";
import { queryRows } from "@/app/lib/db/data-api";
import { MEDIA_URL_TTL_SECONDS, getPresignedGetUrl } from "@/app/lib/s3/s3-presign";
import { RenderArtifactIdentitySchema } from "@/app/lib/uniscenario/render-wire-contracts";
import type {
  UniScenarioPresignedArtifactDto,
  UniScenarioRenderArtifactDto,
} from "./contracts";

/**
 * Artifact reads for the artifacts tab (#146) and the render details tab (#136).
 *
 * THE SPLIT IN THIS FILE IS THE POINT. Plan §2.5.3 requires that a presigned URL is never cached, and
 * the arithmetic leaves no room to negotiate: `MEDIA_URL_TTL_SECONDS` is 3600s pinned at the IAM role
 * session ceiling, `cacheLife('minutes')` expires at exactly 3600s, and every longer profile serves
 * links that are already dead. There is no built-in profile under which caching one is correct, and a
 * cache would also sit beneath the `private, no-store` header the routes set for this exact reason.
 *
 * So the row read and the signing are separate functions: `listRenderJobArtifacts` returns metadata
 * only, and `presignRenderArtifacts` mints URLs per request. Anyone who later decides a metadata read
 * is worth caching can do it without dragging a signature into the cache with it.
 *
 * AS SHIPPED, NOTHING HERE IS CACHED EITHER, and the writer is the reason. `artifacts.artifact_state`
 * moves pending -> available -> quarantined and `verified_at` is stamped by the artifact verification
 * outbox (`bindArtifactUpload`, `completeRenderJob`, `drainArtifactCleanupOutbox` in
 * `control-plane-store.ts`) — worker paths, asynchronous, running while a user watches the tab. Under
 * §2.5 that makes these reads dynamic even though the immutable half of each row (`sha256`,
 * `byte_length`, `storage_key`) never changes. Splitting a row mid-way to cache only its immutable
 * columns would need a second query keyed per artifact id to fetch the mutable half, which costs more
 * round-trips than it saves on tables this size. Refused deliberately, not overlooked.
 */

const ARTIFACT_SELECT = `
  SELECT a.id, a.artifact_kind, a.media_type, a.byte_length, a.sha256,
         a.artifact_state, a.created_at, a.verified_at,
         al.relationship, al.render_job_id, al.render_attempt_id,
         al.artifact_role, al.artifact_actor_id, al.artifact_sensor_id, al.artifact_modality,
         CASE
           WHEN al.relationship IN ('source', 'job_level', 'output') AND al.render_attempt_id IS NULL THEN TRUE
           WHEN al.render_attempt_id IS NULL OR ra.id IS NULL THEN FALSE
           WHEN al.relationship = 'render_output' AND a.artifact_state = 'available'
             THEN ra.attempt_state = 'succeeded'
           ELSE TRUE
         END AS attempt_lineage_valid
    FROM uniscenario.artifact_links al
    JOIN uniscenario.artifacts a
      ON a.id = al.artifact_id AND a.workspace_id = al.workspace_id
    LEFT JOIN uniscenario.render_attempts ra
      ON ra.id = al.render_attempt_id
     AND ra.workspace_id = al.workspace_id
     AND ra.render_job_id = al.render_job_id`;

type ArtifactRow = {
  id: string;
  artifact_kind: string;
  media_type: string;
  byte_length: number | string;
  sha256: string;
  artifact_state: string;
  created_at: string;
  verified_at: string | null;
  relationship: string | null;
  render_job_id: string | null;
  render_attempt_id: string | null;
  artifact_role: string | null;
  artifact_actor_id: string | null;
  artifact_sensor_id: string | null;
  artifact_modality: string | null;
  attempt_lineage_valid: boolean;
};

function assertPublicArtifactLineage(rows: readonly ArtifactRow[]): void {
  if (rows.some((row) => row.attempt_lineage_valid !== true)) {
    throw new Error("uniscenario_render_lineage_invalid");
  }
}

function artifactDto(row: ArtifactRow): UniScenarioRenderArtifactDto {
  return {
    id: row.id,
    artifactKind: row.artifact_kind,
    mediaType: row.media_type,
    byteLength: Number(row.byte_length),
    sha256: row.sha256,
    artifactState: row.artifact_state,
    relationship: row.relationship,
    renderAttemptId: row.render_attempt_id,
    identity: row.artifact_role
      ? RenderArtifactIdentitySchema.parse({
          role: row.artifact_role,
          actorId: row.artifact_actor_id,
          sensorId: row.artifact_sensor_id,
          modality: row.artifact_modality,
        })
      : null,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}

/**
 * Every artifact linked to one render job, metadata only.
 *
 * Soft-deleted artifacts are excluded — `drainArtifactCleanupOutbox` stamps `deleted_at` before the
 * object leaves S3, so a row with `deleted_at` set may have no object behind it and must never be
 * offered for signing.
 */
export async function listRenderJobArtifacts(context: AppContext, jobId: string) {
  const rows = await queryRows<ArtifactRow>(
    `${ARTIFACT_SELECT}
      WHERE al.workspace_id = :workspace_id
        AND al.render_job_id = :job_id
        AND a.deleted_at IS NULL
      ORDER BY a.created_at, a.id`,
    { workspace_id: context.workspaceId, job_id: jobId },
  );
  assertPublicArtifactLineage(rows);
  return rows.map(artifactDto);
}

/**
 * The workspace artifacts tab: every artifact reachable from a render job, newest first.
 *
 * Filtered to visible jobs on the same rule as the gallery — hiding a render should hide its output
 * from the browse surface too, or "hidden" would mean nothing here. A hidden job's artifacts remain
 * reachable through `listRenderJobArtifacts` by id, so nothing becomes unrecoverable.
 */
export async function listWorkspaceRenderArtifacts(
  context: AppContext,
  options: { limit?: number; artifactKind?: string | null } = {},
) {
  const rows = await queryRows<ArtifactRow & { render_job_id: string }>(
    `${ARTIFACT_SELECT}
      JOIN uniscenario.render_jobs rj
        ON rj.id = al.render_job_id AND rj.workspace_id = al.workspace_id
      WHERE al.workspace_id = :workspace_id
        AND a.deleted_at IS NULL
        AND rj.hidden_at IS NULL
        AND (CAST(:artifact_kind AS text) IS NULL OR a.artifact_kind = :artifact_kind)
      ORDER BY a.created_at DESC, a.id
      LIMIT :row_limit`,
    {
      workspace_id: context.workspaceId,
      artifact_kind: options.artifactKind ?? null,
      row_limit: Math.max(1, Math.min(Math.trunc(options.limit ?? 100) || 1, 200)),
    },
  );
  assertPublicArtifactLineage(rows);
  return rows.map((row) => ({ ...artifactDto(row), renderJobId: row.render_job_id }));
}

/**
 * Mint short-lived URLs for artifacts already read and authorized.
 *
 * MUST be called per request, outside any cached function. It takes DTOs rather than ids so it cannot
 * be used as a back door around the workspace-scoped reads above — the caller has to have loaded the
 * rows (and therefore passed the tenancy predicate) before anything can be signed.
 *
 * Only `available` artifacts are signed. A `pending` artifact has no complete object behind it yet and
 * a `quarantined` one failed verification, so handing either to a browser would produce a broken or
 * untrusted download; both come back with `url: null` so the UI can render a state instead of a link.
 */
export async function presignRenderArtifacts(
  artifacts: UniScenarioRenderArtifactDto[],
  storageLocations: ReadonlyMap<string, { bucket: string; key: string }>,
): Promise<(UniScenarioPresignedArtifactDto | (UniScenarioRenderArtifactDto & { url: null }))[]> {
  return Promise.all(
    artifacts.map(async (artifact) => {
      const location = storageLocations.get(artifact.id);
      // No location means either not available, or the object was cleaned up between the metadata read
      // and this call. Either way there is nothing safe to sign.
      if (artifact.artifactState !== "available" || !location) {
        return { ...artifact, url: null as null };
      }
      // Render workers write to their own bucket (simforge-uniscenario-<env>), which is not the web
      // app's default S3_BUCKET — signing must use the bucket recorded on the artifact row.
      const url = await getPresignedGetUrl(location.key, location.bucket);
      return { ...artifact, url, expiresInSeconds: MEDIA_URL_TTL_SECONDS };
    }),
  );
}

/**
 * `storage_key` is deliberately absent from the DTO, so presigning needs it fetched separately rather
 * than shipped to the browser. Kept as a narrow lookup instead of widening the DTO, because a storage
 * key in a client payload is an invitation to construct URLs client-side.
 */
async function artifactStorageKeysFor(context: AppContext, artifactIds: string[]) {
  if (artifactIds.length === 0) return new Map<string, { bucket: string; key: string }>();
  const rows = await queryRows<{ id: string; storage_bucket: string; storage_key: string }>(
    `SELECT id, storage_bucket, storage_key
       FROM uniscenario.artifacts
      WHERE workspace_id = :workspace_id
        AND deleted_at IS NULL
        AND id = ANY(string_to_array(:artifact_ids, ','))`,
    { workspace_id: context.workspaceId, artifact_ids: artifactIds.join(",") },
  );
  return new Map(rows.map((row) => [row.id, { bucket: row.storage_bucket, key: row.storage_key }]));
}

/**
 * The function routes should call: load the storage keys for these artifacts, then sign the available
 * ones.
 *
 * The key map is threaded through as an argument rather than held in module state. That is deliberate
 * and load-bearing: module-level mutable state is shared across every concurrent request in this
 * runtime, so a per-artifact key map kept there could be cleared by one request while another is still
 * signing from it, and — far worse — a key fetched under one workspace could be read by a request
 * running under a different one. Passing it explicitly makes the lifetime exactly the call.
 */
export async function presignArtifactsForContext(
  context: AppContext,
  artifacts: UniScenarioRenderArtifactDto[],
) {
  const available = artifacts.filter((artifact) => artifact.artifactState === "available");
  const locations = await artifactStorageKeysFor(context, available.map((artifact) => artifact.id));
  return presignRenderArtifacts(artifacts, locations);
}
