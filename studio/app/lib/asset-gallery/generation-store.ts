import { randomUUID } from "node:crypto";
import type { GalleryActorClass } from "./contracts";
import type {
  CreateGalleryGenerationInput,
  GalleryGenerationState,
  GalleryGenerationSummary,
  GalleryReferenceImageMediaType,
} from "./generation-contracts";
import type { GlbMetadata } from "./glb-metadata";
import { execute, queryOne, queryRows, withTransaction } from "@/app/lib/db/data-api";
import { S3_BUCKET } from "@/app/lib/s3/s3-config";
import {
  generationReferenceImageKey,
  presignGalleryGenerationReferenceUploads,
} from "./generation-storage";

export interface GalleryGenerationRecord {
  id: string;
  state: GalleryGenerationState;
  actorClass: GalleryActorClass;
  title: string;
  description: string | null;
  texturePrompt: string | null;
  sourceBucket: string;
  images: {
    key: string;
    sha256: string;
    byteLength: number;
    mediaType: "image/jpeg" | "image/png";
  }[];
  providerTaskId: string | null;
  createdByUserId: string;
  createdByWorkspaceId: string;
}

type GalleryGenerationSummaryRow = {
  generation_id: string;
  state: GalleryGenerationState;
  title: string;
  actor_class: GalleryActorClass;
  progress: number;
  images_json: string;
  asset_id: string | null;
  catalog_id: string | null;
  dims_json: string | null;
  triangle_count: number | null;
  preview_url: string | null;
  failure_code: string | null;
  created_at: string;
  created_by_user_id: string;
  created_by_name: string | null;
};

type GalleryGenerationRecordRow = {
  id: string;
  state: GalleryGenerationState;
  actor_class: GalleryActorClass;
  title: string;
  description: string | null;
  texture_prompt: string | null;
  source_bucket: string;
  images_json: string;
  provider_task_id: string | null;
  created_by_user_id: string;
  created_by_workspace_id: string;
};

type StoredReferenceImage = {
  key: string;
  sha256: string;
  byteLength: number;
  mediaType: GalleryReferenceImageMediaType;
};

const GALLERY_GENERATION_SUMMARY_SELECT = `
  SELECT
    g.id::text AS generation_id,
    g.state,
    g.title,
    g.actor_class,
    g.progress,
    g.images::text AS images_json,
    g.asset_id::text AS asset_id,
    CASE WHEN g.asset_id IS NULL THEN NULL
      ELSE a.catalog_slug || '.v' || a.current_version::text
    END AS catalog_id,
    v.dims::text AS dims_json,
    v.triangle_count,
    g.preview_url,
    g.failure_code,
    g.created_at::text AS created_at,
    g.created_by_user_id,
    COALESCE(NULLIF(BTRIM(author.name), ''), NULLIF(BTRIM(author.email), '')) AS created_by_name
  FROM asset_gallery.generation_jobs g
  LEFT JOIN asset_gallery.assets a ON a.id = g.asset_id
  LEFT JOIN asset_gallery.asset_versions v
    ON v.asset_id = a.id AND v.version = a.current_version
  LEFT JOIN ba_user author ON author.id = g.created_by_user_id
`;

function parseStoredImages(raw: string): StoredReferenceImage[] {
  return JSON.parse(raw) as StoredReferenceImage[];
}

function generationSummaryFromRow(
  row: GalleryGenerationSummaryRow,
  viewerUserId: string,
): GalleryGenerationSummary {
  return {
    generationId: row.generation_id,
    state: row.state,
    title: row.title,
    actorClass: row.actor_class,
    progress: row.progress,
    imageCount: parseStoredImages(row.images_json).length,
    assetId: row.asset_id,
    catalogId: row.catalog_id,
    dims: row.dims_json ? JSON.parse(row.dims_json) as GalleryGenerationSummary["dims"] : null,
    triangleCount: row.triangle_count,
    previewUrl: row.preview_url,
    error: row.failure_code,
    createdAt: new Date(row.created_at).toISOString(),
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    ownedByViewer: row.created_by_user_id === viewerUserId,
  };
}

export async function createGalleryGeneration(
  input: CreateGalleryGenerationInput & {
    createdByUserId: string;
    createdByWorkspaceId: string;
  },
): Promise<{
  generationId: string;
  imageUploads: { url: string; headers: Record<string, string> }[];
}> {
  const generationId = randomUUID();
  const images = input.images.map((image, index) => ({
    key: generationReferenceImageKey(generationId, index, image.mediaType),
    sha256: image.sha256,
    byteLength: image.byteLength,
    mediaType: image.mediaType,
  }));

  await execute(
    `INSERT INTO asset_gallery.generation_jobs (
       id, state, title, description, actor_class, texture_prompt, source_bucket, images,
       created_by_user_id, created_by_workspace_id
     ) VALUES (
       CAST(:id AS UUID), 'draft', :title, :description, :actor_class, :texture_prompt,
       :source_bucket, CAST(:images AS JSONB), :created_by_user_id, :created_by_workspace_id
     )`,
    {
      id: generationId,
      title: input.title,
      description: input.description ?? null,
      actor_class: input.actorClass,
      texture_prompt: input.texturePrompt ?? null,
      source_bucket: S3_BUCKET,
      images,
      created_by_user_id: input.createdByUserId,
      created_by_workspace_id: input.createdByWorkspaceId,
    },
  );

  const imageUploads = await presignGalleryGenerationReferenceUploads(generationId, input.images);
  return { generationId, imageUploads };
}

export async function getGalleryGeneration(
  generationId: string,
  viewerUserId: string,
): Promise<GalleryGenerationSummary | null> {
  const row = await queryOne<GalleryGenerationSummaryRow>(
    `${GALLERY_GENERATION_SUMMARY_SELECT}
     WHERE g.id = CAST(:generation_id AS UUID)
       AND g.created_by_user_id = :viewer_user_id`,
    { generation_id: generationId, viewer_user_id: viewerUserId },
  );
  return row ? generationSummaryFromRow(row, viewerUserId) : null;
}

export async function listGalleryGenerations(input: {
  viewerUserId: string;
  limit: number;
}): Promise<GalleryGenerationSummary[]> {
  const rows = await queryRows<GalleryGenerationSummaryRow>(
    `${GALLERY_GENERATION_SUMMARY_SELECT}
     WHERE g.created_by_user_id = :viewer_user_id
     ORDER BY g.created_at DESC, g.id DESC
     LIMIT :row_limit`,
    { viewer_user_id: input.viewerUserId, row_limit: input.limit },
  );
  return rows.map((row) => generationSummaryFromRow(row, input.viewerUserId));
}

export async function countRecentGenerationsByUser(userId: string): Promise<number> {
  const row = await queryOne<{ generation_count: number }>(
    `SELECT COUNT(*)::int AS generation_count
     FROM asset_gallery.generation_jobs
     WHERE created_by_user_id = :user_id
       AND created_at >= NOW() - INTERVAL '1 hour'`,
    { user_id: userId },
  );
  return row?.generation_count ?? 0;
}

export async function loadGalleryGenerationRecord(
  generationId: string,
): Promise<GalleryGenerationRecord | null> {
  const row = await queryOne<GalleryGenerationRecordRow>(
    `SELECT id::text AS id, state, actor_class, title, description, texture_prompt,
       source_bucket, images::text AS images_json, provider_task_id,
       created_by_user_id, created_by_workspace_id
     FROM asset_gallery.generation_jobs
     WHERE id = CAST(:generation_id AS UUID)`,
    { generation_id: generationId },
  );
  if (!row) return null;
  return {
    id: row.id,
    state: row.state,
    actorClass: row.actor_class,
    title: row.title,
    description: row.description,
    texturePrompt: row.texture_prompt,
    sourceBucket: row.source_bucket,
    images: parseStoredImages(row.images_json),
    providerTaskId: row.provider_task_id,
    createdByUserId: row.created_by_user_id,
    createdByWorkspaceId: row.created_by_workspace_id,
  };
}

export async function markGalleryGenerationSubmitted(
  generationId: string,
  providerTaskId: string,
  request: Record<string, unknown>,
): Promise<void> {
  await execute(
    `UPDATE asset_gallery.generation_jobs
     SET state = 'generating', provider_task_id = :provider_task_id,
       request = CAST(:request AS JSONB), submitted_at = NOW(), updated_at = NOW()
     WHERE id = CAST(:generation_id AS UUID) AND state = 'draft'`,
    { generation_id: generationId, provider_task_id: providerTaskId, request },
  );
}

export async function markGalleryGenerationProgress(
  generationId: string,
  progress: number,
  previewUrl: string | null,
): Promise<void> {
  await execute(
    `UPDATE asset_gallery.generation_jobs
     SET progress = :progress, preview_url = :preview_url, updated_at = NOW()
     WHERE id = CAST(:generation_id AS UUID) AND state = 'generating'`,
    { generation_id: generationId, progress, preview_url: previewUrl },
  );
}

export async function markGalleryGenerationFailed(
  generationId: string,
  failureCode: string,
  providerError: string | null,
): Promise<void> {
  await execute(
    `UPDATE asset_gallery.generation_jobs
     SET state = 'failed', failure_code = :failure_code, provider_error = :provider_error,
       finished_at = NOW(), updated_at = NOW()
     WHERE id = CAST(:generation_id AS UUID) AND state NOT IN ('ready', 'cancelled')`,
    { generation_id: generationId, failure_code: failureCode, provider_error: providerError },
  );
}
/**
 * Backstop for a provider task that is never reported terminal.
 *
 * This repository has no cron driving generation cleanup, so request-time sweeps call this bound
 * before polling and prevent abandoned provider work from remaining live indefinitely.
 */
export async function failStalledGalleryGenerations(maxAgeMinutes: number): Promise<number> {
  const row = await queryOne<{ failed_count: number }>(
    `WITH failed AS (
       UPDATE asset_gallery.generation_jobs
       SET state = 'failed', failure_code = 'timed_out', finished_at = NOW(), updated_at = NOW()
       WHERE state NOT IN ('ready', 'failed', 'cancelled')
         AND submitted_at < NOW() - (:max_age_minutes * INTERVAL '1 minute')
       RETURNING 1
     )
     SELECT COUNT(*)::int AS failed_count FROM failed`,
    { max_age_minutes: maxAgeMinutes },
  );
  return row?.failed_count ?? 0;
}


export async function claimGalleryGenerationImport(
  generationId: string,
  leaseSeconds: number,
): Promise<boolean> {
  // Two browsers can poll the same generation concurrently; without a conditional lease both
  // requests would download the provider artifact and publish separate gallery assets. An expired
  // importing lease is reclaimable because it means the previous importer died before publishing.
  const claimed = await queryOne<{ id: string }>(
    `UPDATE asset_gallery.generation_jobs
     SET state = 'importing', import_lease_until = NOW() + (:lease_seconds * INTERVAL '1 second'),
       updated_at = NOW()
     WHERE id = CAST(:generation_id AS UUID)
       AND (
         state = 'generating'
         OR (state = 'importing' AND import_lease_until < NOW())
       )
     RETURNING id::text AS id`,
    { generation_id: generationId, lease_seconds: leaseSeconds },
  );
  return claimed !== null;
}

export async function publishGeneratedGalleryAsset(input: {
  generationId: string;
  metadata: GlbMetadata;
  glb: { key: string; sha256: string; byteLength: number };
  thumbnail: { key: string; sha256: string; byteLength: number };
}): Promise<{ assetId: string; catalogId: string }> {
  const generation = await loadGalleryGenerationRecord(input.generationId);
  if (!generation) throw new Error("Gallery generation does not exist.");

  const assetId = input.generationId;
  const versionId = randomUUID();
  const version = 1;
  const catalogSlug = `gallery.${assetId}`;

  // This path intentionally skips the browser upload's HEAD re-verification. The server wrote
  // both objects itself and computed the digests used in their immutable keys, so another HEAD
  // would only repeat evidence already held by the publishing process.
  await withTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO asset_gallery.assets (
         id, catalog_slug, title, description, actor_class, tags,
         created_by_user_id, created_by_workspace_id, visibility, status, current_version
       ) VALUES (
         CAST(:id AS UUID), :catalog_slug, :title, :description, :actor_class, ARRAY[]::TEXT[],
         :created_by_user_id, :created_by_workspace_id, 'public', 'ready', :version
       )`,
      {
        id: assetId,
        catalog_slug: catalogSlug,
        title: generation.title,
        description: generation.description,
        actor_class: generation.actorClass,
        created_by_user_id: generation.createdByUserId,
        created_by_workspace_id: generation.createdByWorkspaceId,
        version,
      },
    );

    await tx.execute(
      `INSERT INTO asset_gallery.asset_versions (
         id, asset_id, version, source_bucket, source_key, source_sha256, source_format,
         byte_length, media_type, dims, bounds, triangle_count, mesh_count, material_count,
         extensions, animation, thumbnail_key, thumbnail_sha256, thumbnail_byte_length,
         verification_state
       ) VALUES (
         CAST(:id AS UUID), CAST(:asset_id AS UUID), :version, :source_bucket, :source_key,
         :source_sha256, 'glb', :byte_length, 'model/gltf-binary', CAST(:dims AS JSONB),
         CAST(:bounds AS JSONB), :triangle_count, :mesh_count, :material_count,
         ARRAY(SELECT jsonb_array_elements_text(CAST(:extensions AS JSONB))),
         CAST(:animation AS JSONB), :thumbnail_key, :thumbnail_sha256,
         :thumbnail_byte_length, 'verified'
       )`,
      {
        id: versionId,
        asset_id: assetId,
        version,
        source_bucket: S3_BUCKET,
        source_key: input.glb.key,
        source_sha256: input.glb.sha256,
        byte_length: input.glb.byteLength,
        dims: input.metadata.dims,
        bounds: input.metadata.bounds,
        triangle_count: input.metadata.triangleCount,
        mesh_count: input.metadata.meshCount,
        material_count: input.metadata.materialCount,
        extensions: input.metadata.extensions,
        animation: {
          animated: input.metadata.animated,
          clips: input.metadata.clips,
          idleClip: null,
          locomotionClip: null,
        },
        thumbnail_key: input.thumbnail.key,
        thumbnail_sha256: input.thumbnail.sha256,
        thumbnail_byte_length: input.thumbnail.byteLength,
      },
    );

    await tx.execute(
      `UPDATE asset_gallery.generation_jobs
       SET state = 'ready', asset_id = CAST(:asset_id AS UUID), progress = 100,
         finished_at = NOW(), updated_at = NOW(), import_lease_until = NULL
       WHERE id = CAST(:generation_id AS UUID) AND state = 'importing'`,
      { generation_id: input.generationId, asset_id: assetId },
    );
  });

  return { assetId, catalogId: `${catalogSlug}.v${version}` };
}

export async function countScenariosUsingGalleryAsset(catalogSlug: string): Promise<number> {
  // The editor's live document is `uniscenario.drafts.canonical_content`; revisions are immutable
  // exports of the same scenario and would double-count a document. Deleted documents do not keep
  // an asset in active use. Searching every JSON string preserves references wherever the schema
  // stores a versioned catalog id rather than depending on one actor/prop path.
  const row = await queryOne<{ scenario_count: number }>(
    `SELECT COUNT(*)::int AS scenario_count
     FROM uniscenario.documents d
     JOIN uniscenario.drafts dr
       ON dr.document_id = d.id AND dr.workspace_id = d.workspace_id
     WHERE d.deleted_at IS NULL
       AND EXISTS (
         SELECT 1
         FROM jsonb_path_query(
           dr.canonical_content,
           '$.** ? (@.type() == "string")'
         ) AS matched(value)
         WHERE matched.value #>> '{}' LIKE :catalog_version_pattern
       )`,
    { catalog_version_pattern: `${catalogSlug}.v%` },
  );
  return row?.scenario_count ?? 0;
}
