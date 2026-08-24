import type { AppContext } from "@/app/lib/db/app-context";
import { queryOne, queryRows } from "@/app/lib/db/data-api";
import type { ScenarioGalleryItemDto } from "./contracts";

/**
 * Render gallery reads and the hide/unhide mutation.
 *
 * NOTHING IN THIS FILE IS CACHED, AND THAT IS NOT AN OVERSIGHT. Per plan §2.5, a read whose freshness
 * requirement is set by a background writer is dynamic regardless of how cacheable its shape looks.
 * Every gallery tile carries `job_state`, `progress`, `attempt_count`, `failure_code`, and an artifact
 * count — and each of those is advanced by the worker control plane (`leaseRenderJob`,
 * `heartbeatLease`, `appendJobEvent`, `completeRenderJob`, `failRenderJob` in `control-plane-store.ts`)
 * while the user is watching the gallery. Caching this and invalidating from a user-facing route would
 * freeze render progress at write time with nothing able to clear it, which is the exact defect §2.5
 * describes for `listScenarioDatasets`. Invalidating from the worker routes instead is possible but
 * self-defeating: job events fire continuously, so no entry would survive to be hit.
 *
 * `use cache` is therefore wrong on every function here. Do not add it, and do not add `cacheTag`
 * either — a tag implies a cache that does not exist and misleads the next reader.
 */

/**
 * The hide predicate. Present on every gallery read so the two partial indexes
 * 20260804025000 created are actually usable:
 *
 *   uniscenario_render_jobs_workspace_gallery_idx (workspace_id, created_at DESC, id) WHERE hidden_at IS NULL
 *   uniscenario_render_jobs_revision_gallery_idx  (workspace_id, revision_id, created_at DESC, id) WHERE hidden_at IS NULL
 *
 * A partial index can only serve a query that carries its predicate. Until this clause existed both
 * indexes were dead weight — they were created by an untracked migration for a feature that was never
 * implemented. Dropping this clause does not merely change which rows come back; it silently takes the
 * gallery off its index.
 */
const VISIBLE_ONLY = "rj.hidden_at IS NULL";

/**
 * Narrow on purpose. The gallery renders tiles, so it must not drag `render_spec`, `telemetry`,
 * `parity_result`, or `worker_attestation` across the wire — those are details-tab payloads and one of
 * them is unbounded.
 */
const GALLERY_SELECT = `
  SELECT rj.id, rj.revision_id, rj.job_mode, rj.job_state, rj.attempt_count,
         rj.failure_code, rj.created_at, rj.completed_at,
         rj.parent_render_job_id, rj.model_family,
         r.document_id, r.content_sha256, r.source_draft_version,
         (rj.progress * 100.0) AS progress_percent,
         (SELECT count(*) FROM uniscenario.artifact_links al
           WHERE al.workspace_id = rj.workspace_id AND al.render_job_id = rj.id) AS artifact_count,
         preview.artifact_id AS preview_artifact_id,
         preview.media_type AS preview_media_type
    FROM uniscenario.render_jobs rj
    JOIN uniscenario.revisions r
      ON r.id = rj.revision_id AND r.workspace_id = rj.workspace_id
    LEFT JOIN LATERAL (
      SELECT a.id AS artifact_id, a.media_type
        FROM uniscenario.artifact_links al
        JOIN uniscenario.artifacts a
          ON a.id = al.artifact_id AND a.workspace_id = al.workspace_id
       WHERE al.workspace_id = rj.workspace_id
         AND al.render_job_id = rj.id
         AND a.artifact_state = 'available'
         AND a.deleted_at IS NULL
         AND (a.media_type LIKE 'image/%' OR a.media_type LIKE 'video/%')
       -- Prefer a still (cheap poster) but fall back to the render's video: CARLA and browser
       -- renders emit only an MP4, and a tile with no preview at all reads as a broken render.
       ORDER BY CASE WHEN a.media_type LIKE 'image/%' THEN 0 ELSE 1 END, a.created_at DESC, a.id
       LIMIT 1
    ) preview ON TRUE`;

type GalleryRow = {
  id: string;
  revision_id: string;
  document_id: string | null;
  job_mode: ScenarioGalleryItemDto["jobMode"];
  job_state: ScenarioGalleryItemDto["jobState"];
  attempt_count: number;
  failure_code: string | null;
  created_at: string;
  completed_at: string | null;
  parent_render_job_id: string | null;
  model_family: string | null;
  content_sha256: string | null;
  source_draft_version: number | string | null;
  progress_percent: number | string | null;
  artifact_count: number | string;
  preview_artifact_id: string | null;
  preview_media_type: string | null;
};

function galleryItemDto(row: GalleryRow): ScenarioGalleryItemDto {
  return {
    id: row.id,
    revisionId: row.revision_id,
    documentId: row.document_id,
    jobMode: row.job_mode,
    jobState: row.job_state,
    // `?? null` rather than `|| null`: a genuine 0 percent is meaningful and must survive.
    progressPercent: row.progress_percent === null ? null : Number(row.progress_percent),
    failureCode: row.failure_code,
    attemptCount: Number(row.attempt_count),
    createdAt: row.created_at,
    completedAt: row.completed_at,
    parentRenderJobId: row.parent_render_job_id,
    modelFamily: row.model_family,
    revisionContentSha256: row.content_sha256,
    revisionSourceDraftVersion:
      row.source_draft_version === null ? null : Number(row.source_draft_version),
    artifactCount: Number(row.artifact_count),
    previewArtifactId: row.preview_artifact_id,
    previewMediaType: row.preview_media_type,
  };
}

function clampLimit(limit: number) {
  return Math.max(1, Math.min(Math.trunc(limit) || 1, 100));
}

/**
 * Workspace-wide gallery, newest first. Backs manifest #147 (job gallery) and #134's tile strip.
 *
 * Ordering matches `uniscenario_render_jobs_workspace_gallery_idx` exactly — `(workspace_id,
 * created_at DESC, id)` with the `hidden_at IS NULL` predicate — so this is an index scan rather than
 * a sort. Keep the ORDER BY and the predicate in step with that index or the gallery silently
 * degrades on a table that only grows.
 */
export async function listRenderGallery(
  context: AppContext,
  options: { limit?: number; jobMode?: ScenarioGalleryItemDto["jobMode"] | null } = {},
) {
  const rows = await queryRows<GalleryRow>(
    `${GALLERY_SELECT}
      WHERE rj.workspace_id = :workspace_id
        AND ${VISIBLE_ONLY}
        AND (CAST(:job_mode AS text) IS NULL OR rj.job_mode = :job_mode)
      ORDER BY rj.created_at DESC, rj.id
      LIMIT :row_limit`,
    {
      workspace_id: context.workspaceId,
      job_mode: options.jobMode ?? null,
      row_limit: clampLimit(options.limit ?? 50),
    },
  );
  return rows.map(galleryItemDto);
}

/**
 * One revision's renders, newest first. Backs the render tab for an open document (#134) and the
 * session cards (#137). Ordering matches `uniscenario_render_jobs_revision_gallery_idx`.
 */
export async function listRevisionRenderGallery(
  context: AppContext,
  revisionId: string,
  options: { limit?: number } = {},
) {
  const rows = await queryRows<GalleryRow>(
    `${GALLERY_SELECT}
      WHERE rj.workspace_id = :workspace_id
        AND rj.revision_id = :revision_id
        AND ${VISIBLE_ONLY}
      ORDER BY rj.created_at DESC, rj.id
      LIMIT :row_limit`,
    {
      workspace_id: context.workspaceId,
      revision_id: revisionId,
      row_limit: clampLimit(options.limit ?? 50),
    },
  );
  return rows.map(galleryItemDto);
}

/**
 * One document's renders across every revision, newest first.
 *
 * A render freezes its own snapshot at submit time, so an actively edited document accumulates
 * renders under several revisions. Scoping the render tab to a single revision would therefore hide
 * a scenario's earlier renders the moment the author changed anything, which is exactly the history
 * the tab exists to show.
 *
 * `revisions.document_id` carries the filter, so this cannot ride the revision gallery's partial
 * index; it sorts on `(created_at DESC, id)` after the join. Bounded by the same clamped limit.
 */
export async function listDocumentRenderGallery(
  context: AppContext,
  documentId: string,
  options: { limit?: number } = {},
) {
  const rows = await queryRows<GalleryRow>(
    `${GALLERY_SELECT}
      WHERE rj.workspace_id = :workspace_id
        AND r.document_id = :document_id
        AND ${VISIBLE_ONLY}
      ORDER BY rj.created_at DESC, rj.id
      LIMIT :row_limit`,
    {
      workspace_id: context.workspaceId,
      document_id: documentId,
      row_limit: clampLimit(options.limit ?? 50),
    },
  );
  return rows.map(galleryItemDto);
}

/**
 * The postprocess children of one render job — Cosmos and VLM outputs (#139, #140).
 *
 * Hidden children are excluded on the same rule as the top-level gallery: hiding is a gallery concept,
 * and a hidden derivative should not reappear because it happens to have a parent.
 */
export async function listPostprocessChildren(context: AppContext, parentRenderJobId: string) {
  const rows = await queryRows<GalleryRow>(
    `${GALLERY_SELECT}
      WHERE rj.workspace_id = :workspace_id
        AND rj.parent_render_job_id = :parent_id
        AND ${VISIBLE_ONLY}
      ORDER BY rj.created_at DESC, rj.id
      LIMIT 100`,
    { workspace_id: context.workspaceId, parent_id: parentRenderJobId },
  );
  return rows.map(galleryItemDto);
}

/**
 * Hide or unhide a render job in the gallery.
 *
 * This is the write path the `hidden_at` / `hidden_by_user_id` columns were waiting for. They were
 * added by the untracked 20260804025000 and adopted as-is by 20260806014000 precisely because they
 * already matched the schema's `deleted_at` / `deleted_by_user_id` convention — including
 * `render_jobs_hidden_by_user_id_fkey ... ON DELETE SET NULL`, so removing a user does not un-hide
 * their hidden jobs.
 *
 * A SOFT hide. The row, its attempts, its events, and every artifact stay exactly where they are — the
 * artifacts tab still reaches them by id, and `getRenderJobDetail` still returns a hidden job so a
 * deep link into a hidden render does not 404. Only the gallery lists filter it out. Nothing here
 * cancels or deletes; use `cancelRenderJob` for that.
 *
 * Idempotent by construction: hiding an already-hidden job leaves the original `hidden_at` and
 * attribution intact rather than moving the timestamp, so "who hid this, and when" survives a
 * double-click. Unhiding clears both columns together, never one.
 */
export async function setRenderJobHidden(
  context: AppContext,
  jobId: string,
  hidden: boolean,
) {
  const row = await queryOne<{ id: string; hidden_at: string | null; hidden_by_user_id: string | null }>(
    `UPDATE uniscenario.render_jobs
        SET hidden_at = CASE WHEN :hidden THEN COALESCE(hidden_at, NOW()) ELSE NULL END,
            hidden_by_user_id = CASE WHEN :hidden THEN COALESCE(hidden_by_user_id, :user_id) ELSE NULL END,
            updated_at = NOW()
      WHERE workspace_id = :workspace_id AND id = :job_id
      RETURNING id, hidden_at, hidden_by_user_id`,
    {
      workspace_id: context.workspaceId,
      job_id: jobId,
      user_id: context.userId,
      hidden,
    },
  );
  if (!row) return null;
  return {
    id: row.id,
    hiddenAt: row.hidden_at,
    hiddenByUserId: row.hidden_by_user_id,
  };
}

/**
 * Count hidden jobs, so the gallery can offer "show N hidden" without fetching them.
 *
 * Deliberately the one read that does NOT carry the `hidden_at IS NULL` predicate, so it cannot use
 * either gallery index. That is correct and not worth a third index: it returns a single scalar.
 */
export async function countHiddenRenderJobs(context: AppContext, revisionId?: string | null) {
  const row = await queryOne<{ hidden_count: number | string }>(
    `SELECT count(*) AS hidden_count
       FROM uniscenario.render_jobs
      WHERE workspace_id = :workspace_id
        AND hidden_at IS NOT NULL
        AND (CAST(:revision_id AS text) IS NULL OR revision_id = :revision_id)`,
    { workspace_id: context.workspaceId, revision_id: revisionId ?? null },
  );
  return Number(row?.hidden_count ?? 0);
}

/**
 * The same scalar for a whole document, since a document's renders span revisions.
 *
 * A sibling rather than another optional parameter on `countHiddenRenderJobs`: the two filters are
 * mutually exclusive, and one nullable-parameter matrix that can express "both" is a worse contract
 * than two functions that each mean one thing.
 */
export async function countHiddenRenderJobsForDocument(
  context: AppContext,
  documentId: string,
) {
  const row = await queryOne<{ hidden_count: number | string }>(
    `SELECT count(*) AS hidden_count
       FROM uniscenario.render_jobs rj
       JOIN uniscenario.revisions r
         ON r.id = rj.revision_id AND r.workspace_id = rj.workspace_id
      WHERE rj.workspace_id = :workspace_id
        AND rj.hidden_at IS NOT NULL
        AND r.document_id = :document_id`,
    { workspace_id: context.workspaceId, document_id: documentId },
  );
  return Number(row?.hidden_count ?? 0);
}
