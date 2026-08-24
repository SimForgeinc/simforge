import { randomUUID } from "node:crypto";
import type {
  CreateGalleryUploadInput,
  GalleryActorClass,
  GalleryAssetSummary,
  GalleryCatalogEntryDto,
} from "./contracts";
import { execute, queryOne, queryRows, withTransaction } from "@/app/lib/db/data-api";
import { S3_BUCKET } from "@/app/lib/s3/s3-config";
import {
  galleryModelKey,
  galleryThumbnailKey,
  getGalleryModelUrl,
  getGalleryThumbnailUrl,
  verifyUploadedObject,
} from "./storage";

export type GalleryAssetRow = {
  asset_id: string;
  catalog_id: string;
  version: number;
  title: string;
  description: string | null;
  actor_class: GalleryActorClass;
  tags_json: string;
  thumbnail_key: string;
  dims_json: string;
  triangle_count: number;
  byte_length: number;
  source_format: string;
  animation_json: string;
  created_at: string;
  created_by_user_id: string;
  created_by_name: string | null;
};

export type GalleryAssetVersionRow = {
  version_id: string;
  asset_id: string;
  version: number;
  created_by_user_id: string;
  source_bucket: string;
  source_key: string;
  source_sha256: string;
  byte_length: number;
  thumbnail_key: string;
  thumbnail_sha256: string;
  thumbnail_byte_length: number;
  verification_state: "pending" | "verified" | "failed" | "quarantined";
};

type StoredAnimation = {
  animated?: boolean;
  clips?: string[];
  idleClip?: string | null;
  locomotionClip?: string | null;
};

type GalleryCatalogRow = {
  catalog_id: string;
  title: string;
  actor_class: GalleryActorClass;
  tags_json: string;
  dims_json: string;
  source_key: string;
  source_sha256: string;
  animation_json: string;
};

const GALLERY_ASSET_SELECT = `
  SELECT
    a.id::text AS asset_id,
    a.catalog_slug || '.v' || v.version::text AS catalog_id,
    v.version,
    a.title,
    a.description,
    a.actor_class,
    to_jsonb(a.tags)::text AS tags_json,
    v.thumbnail_key,
    v.dims::text AS dims_json,
    v.triangle_count,
    v.byte_length,
    v.source_format,
    v.animation::text AS animation_json,
    a.created_at::text AS created_at,
    a.created_by_user_id,
    COALESCE(NULLIF(BTRIM(author.name), ''), NULLIF(BTRIM(author.email), '')) AS created_by_name
  FROM asset_gallery.assets a
  JOIN asset_gallery.asset_versions v
    ON v.asset_id = a.id AND v.version = a.current_version
  LEFT JOIN ba_user author ON author.id = a.created_by_user_id
`;

function parseAnimation(raw: string): Required<StoredAnimation> {
  const parsed = JSON.parse(raw || "{}") as StoredAnimation;
  return {
    animated: parsed.animated === true,
    clips: Array.isArray(parsed.clips) ? parsed.clips : [],
    idleClip: parsed.idleClip ?? null,
    locomotionClip: parsed.locomotionClip ?? null,
  };
}

async function summaryFromRow(row: GalleryAssetRow, viewerUserId: string): Promise<GalleryAssetSummary> {
  const animation = parseAnimation(row.animation_json);
  return {
    assetId: row.asset_id,
    catalogId: row.catalog_id,
    version: row.version,
    title: row.title,
    description: row.description,
    actorClass: row.actor_class,
    tags: JSON.parse(row.tags_json) as string[],
    thumbnailUrl: await getGalleryThumbnailUrl(row.thumbnail_key),
    dims: JSON.parse(row.dims_json) as GalleryAssetSummary["dims"],
    triangleCount: row.triangle_count,
    byteLength: row.byte_length,
    sourceFormat: row.source_format as GalleryAssetSummary["sourceFormat"],
    animated: animation.animated,
    clips: animation.clips,
    idleClip: animation.idleClip,
    locomotionClip: animation.locomotionClip,
    createdAt: new Date(row.created_at).toISOString(),
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    ownedByViewer: row.created_by_user_id === viewerUserId,
  };
}

export type CreateGalleryAssetResult = {
  assetId: string;
  versionId: string;
  version: number;
  catalogId: string;
  modelKey: string;
  thumbnailKey: string;
};

export async function createGalleryAsset(
  input: CreateGalleryUploadInput & {
    createdByUserId: string;
    createdByWorkspaceId: string;
  },
): Promise<CreateGalleryAssetResult> {
  const assetId = randomUUID();
  const versionId = randomUUID();
  const version = 1;
  const catalogSlug = `gallery.${assetId}`;
  const modelKey = galleryModelKey(assetId, version, input.glb.sha256);
  const thumbnailKey = galleryThumbnailKey(assetId, version, input.thumbnail.sha256);

  await withTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO asset_gallery.assets (
         id, catalog_slug, title, description, actor_class, tags,
         created_by_user_id, created_by_workspace_id, visibility, status, current_version
       ) VALUES (
         CAST(:id AS UUID), :catalog_slug, :title, :description, :actor_class,
         ARRAY(SELECT jsonb_array_elements_text(CAST(:tags AS JSONB))),
         :created_by_user_id, :created_by_workspace_id, 'public', 'verifying', :version
       )`,
      {
        id: assetId,
        catalog_slug: catalogSlug,
        title: input.title,
        description: input.description ?? null,
        actor_class: input.actorClass,
        tags: input.tags ?? [],
        created_by_user_id: input.createdByUserId,
        created_by_workspace_id: input.createdByWorkspaceId,
        version,
      },
    );

    await tx.execute(
      `INSERT INTO asset_gallery.asset_versions (
         id, asset_id, version, source_bucket, source_key, source_sha256, source_format,
         byte_length, media_type, dims, bounds, triangle_count, animation,
         thumbnail_key, thumbnail_sha256, thumbnail_byte_length, verification_state
       ) VALUES (
         CAST(:id AS UUID), CAST(:asset_id AS UUID), :version, :source_bucket, :source_key,
         :source_sha256, :source_format, :byte_length, 'model/gltf-binary',
         CAST(:dims AS JSONB), CAST(:bounds AS JSONB), :triangle_count, CAST(:animation AS JSONB),
         :thumbnail_key, :thumbnail_sha256, :thumbnail_byte_length, 'pending'
       )`,
      {
        id: versionId,
        asset_id: assetId,
        version,
        source_bucket: S3_BUCKET,
        source_key: modelKey,
        source_sha256: input.glb.sha256,
        source_format: input.sourceFormat,
        byte_length: input.glb.byteLength,
        dims: input.dims,
        bounds: input.dims,
        triangle_count: input.triangleCount,
        animation: {
          animated: input.animated,
          clips: input.clips,
          idleClip: input.idleClip ?? null,
          locomotionClip: input.locomotionClip ?? null,
        },
        thumbnail_key: thumbnailKey,
        thumbnail_sha256: input.thumbnail.sha256,
        thumbnail_byte_length: input.thumbnail.byteLength,
      },
    );
  });

  return {
    assetId,
    versionId,
    version,
    catalogId: `${catalogSlug}.v${version}`,
    modelKey,
    thumbnailKey,
  };
}

export class InvalidGalleryCursorError extends Error {}

type GalleryCursor = { createdAt: string; id: string };

function decodeCursor(cursor: string): GalleryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<GalleryCursor>;
    if (
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(parsed.id)
    ) {
      throw new InvalidGalleryCursorError("Invalid gallery cursor.");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch (error) {
    if (error instanceof InvalidGalleryCursorError) throw error;
    throw new InvalidGalleryCursorError("Invalid gallery cursor.");
  }
}

function encodeCursor(row: GalleryAssetRow): string {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.asset_id })).toString("base64url");
}

export async function listGalleryAssets(input: {
  viewerUserId: string;
  q?: string;
  actorClass?: GalleryActorClass;
  mine?: boolean;
  cursor?: string;
  limit?: number;
}): Promise<{ items: GalleryAssetSummary[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 24, 1), 48);
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const clauses = ["a.status = 'ready'", "a.visibility = 'public'", "v.verification_state = 'verified'"];
  if (input.q) clauses.push("a.title ILIKE '%' || :q || '%'");
  if (input.actorClass) clauses.push("a.actor_class = :actor_class");
  if (input.mine) clauses.push("a.created_by_user_id = :viewer_user_id");
  if (cursor) {
    clauses.push("(a.created_at, a.id) < (CAST(:cursor_created_at AS TIMESTAMPTZ), CAST(:cursor_id AS UUID))");
  }

  const rows = await queryRows<GalleryAssetRow>(
    `${GALLERY_ASSET_SELECT}
     WHERE ${clauses.join(" AND ")}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT :fetch_limit`,
    {
      q: input.q ?? null,
      actor_class: input.actorClass ?? null,
      viewer_user_id: input.viewerUserId,
      cursor_created_at: cursor?.createdAt ?? null,
      cursor_id: cursor?.id ?? null,
      fetch_limit: limit + 1,
    },
  );

  const pageRows = rows.slice(0, limit);
  const items = await Promise.all(pageRows.map((row) => summaryFromRow(row, input.viewerUserId)));
  return {
    items,
    nextCursor:
      rows.length > limit && pageRows.length > 0
        ? encodeCursor(pageRows[pageRows.length - 1]!)
        : null,
  };
}

export async function getGalleryAsset(
  assetId: string,
  viewerUserId: string,
): Promise<GalleryAssetSummary | null> {
  const row = await queryOne<GalleryAssetRow>(
    `${GALLERY_ASSET_SELECT}
     WHERE a.id = CAST(:asset_id AS UUID)
       AND a.status = 'ready'
       AND a.visibility = 'public'
       AND v.verification_state = 'verified'`,
    { asset_id: assetId },
  );
  return row ? summaryFromRow(row, viewerUserId) : null;
}

export type CompleteGalleryAssetVersionResult =
  | { kind: "ready"; asset: GalleryAssetSummary }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "quarantined"; reason: string };

export async function completeGalleryAssetVersion(
  versionId: string,
  viewerUserId: string,
): Promise<CompleteGalleryAssetVersionResult> {
  const version = await queryOne<GalleryAssetVersionRow>(
    `SELECT
       v.id::text AS version_id, v.asset_id::text AS asset_id, v.version,
       a.created_by_user_id, v.source_bucket, v.source_key, v.source_sha256,
       v.byte_length, v.thumbnail_key, v.thumbnail_sha256, v.thumbnail_byte_length,
       v.verification_state
     FROM asset_gallery.asset_versions v
     JOIN asset_gallery.assets a ON a.id = v.asset_id
     WHERE v.id = CAST(:version_id AS UUID) AND a.status <> 'removed'`,
    { version_id: versionId },
  );
  if (!version) return { kind: "not_found" };
  if (version.created_by_user_id !== viewerUserId) return { kind: "forbidden" };
  if (version.verification_state === "quarantined" || version.verification_state === "failed") {
    return { kind: "quarantined", reason: "upload_verification_failed" };
  }

  if (version.verification_state === "pending") {
    const [model, thumbnail] = await Promise.all([
      verifyUploadedObject({
        bucket: version.source_bucket,
        key: version.source_key,
        sha256: version.source_sha256,
        byteLength: version.byte_length,
      }),
      verifyUploadedObject({
        bucket: version.source_bucket,
        key: version.thumbnail_key,
        sha256: version.thumbnail_sha256,
        byteLength: version.thumbnail_byte_length,
      }),
    ]);

    const verificationFailure = !model.ok
      ? `model_${model.reason}`
      : !thumbnail.ok
        ? `thumbnail_${thumbnail.reason}`
        : null;
    if (verificationFailure) {
      await withTransaction(async (tx) => {
        await tx.execute(
          `UPDATE asset_gallery.asset_versions
           SET verification_state = 'quarantined'
           WHERE id = CAST(:version_id AS UUID) AND verification_state = 'pending'`,
          { version_id: versionId },
        );
        await tx.execute(
          `UPDATE asset_gallery.assets SET status = 'rejected', updated_at = NOW()
           WHERE id = CAST(:asset_id AS UUID) AND status = 'verifying'`,
          { asset_id: version.asset_id },
        );
      });
      return { kind: "quarantined", reason: verificationFailure };
    }

    await withTransaction(async (tx) => {
      await tx.execute(
        `UPDATE asset_gallery.asset_versions
         SET verification_state = 'verified'
         WHERE id = CAST(:version_id AS UUID) AND verification_state = 'pending'`,
        { version_id: versionId },
      );
      await tx.execute(
        `UPDATE asset_gallery.assets
         SET status = 'ready', current_version = :version, updated_at = NOW()
         WHERE id = CAST(:asset_id AS UUID) AND status = 'verifying'`,
        { asset_id: version.asset_id, version: version.version },
      );
    });
  }

  const asset = await getGalleryAsset(version.asset_id, viewerUserId);
  return asset ? { kind: "ready", asset } : { kind: "not_found" };
}

export async function resolveGalleryCatalogIds(
  catalogIds: string[],
): Promise<{ entries: GalleryCatalogEntryDto[]; missing: string[] }> {
  const uniqueIds = Array.from(new Set(catalogIds));
  if (uniqueIds.length === 0) return { entries: [], missing: [] };

  const rows = await queryRows<GalleryCatalogRow>(
    `SELECT
       a.catalog_slug || '.v' || v.version::text AS catalog_id,
       a.title, a.actor_class, to_jsonb(a.tags)::text AS tags_json, v.dims::text AS dims_json,
       v.source_key, v.source_sha256, v.animation::text AS animation_json
     FROM asset_gallery.assets a
     JOIN asset_gallery.asset_versions v ON v.asset_id = a.id
     WHERE a.status = 'ready'
       AND a.visibility = 'public'
       AND v.verification_state = 'verified'
       AND (a.catalog_slug || '.v' || v.version::text) IN (
         SELECT jsonb_array_elements_text(CAST(:catalog_ids AS JSONB))
       )`,
    { catalog_ids: uniqueIds },
  );

  const rowById = new Map(rows.map((row) => [row.catalog_id, row]));
  const entries = await Promise.all(
    uniqueIds.flatMap((catalogId) => {
      const row = rowById.get(catalogId);
      if (!row) return [];
      return [
        (async (): Promise<GalleryCatalogEntryDto> => {
          const animation = parseAnimation(row.animation_json);
          const clips = {
            ...(animation.idleClip ? { idle: animation.idleClip } : {}),
            ...(animation.locomotionClip ? { locomotion: animation.locomotionClip } : {}),
          };
          return {
            catalogId: row.catalog_id,
            label: row.title,
            actorClass: row.actor_class,
            dims: JSON.parse(row.dims_json) as GalleryCatalogEntryDto["dims"],
            tags: JSON.parse(row.tags_json) as string[],
            model: {
              url: await getGalleryModelUrl(row.source_key),
              contentHash: row.source_sha256,
              animated: animation.animated,
              ...(Object.keys(clips).length > 0 ? { clips } : {}),
            },
          };
        })(),
      ];
    }),
  );

  return { entries, missing: uniqueIds.filter((catalogId) => !rowById.has(catalogId)) };
}

/**
 * Any signed-in member may moderate the public catalog. Removal stays recoverable because it is
 * soft, and the actor is recorded because an open policy must remain attributable.
 */
export async function deleteGalleryAsset(
  assetId: string,
  requesterUserId: string,
): Promise<"deleted" | "not_found"> {
  const removed = await queryOne<{ id: string }>(
    `UPDATE asset_gallery.assets
     SET status = 'removed', removed_by_user_id = :requester_user_id,
       removed_at = NOW(), updated_at = NOW()
     WHERE id = CAST(:asset_id AS UUID) AND status <> 'removed'
     RETURNING id::text AS id`,
    { asset_id: assetId, requester_user_id: requesterUserId },
  );
  return removed ? "deleted" : "not_found";
}

/**
 * Rename an asset in place, keeping its catalog id and every scenario binding.
 *
 * The title is the only thing an author can correct after publishing: a model's
 * geometry, dims and catalog id are what scenarios bind to, but its name is
 * routinely whatever the source file was called - `Meshy_AI_Silver_Autonomous_
 * Min_0820200054_texture` - and that is what every gallery tile and readiness
 * warning then says. Rename remains author/admin-only even though community deletion is open.
 */
export async function renameGalleryAsset(
  assetId: string,
  title: string,
  requesterUserId: string,
  platformAdmin: boolean,
): Promise<"renamed" | "forbidden" | "not_found"> {
  const asset = await queryOne<{ created_by_user_id: string; status: string }>(
    `SELECT created_by_user_id, status
     FROM asset_gallery.assets
     WHERE id = CAST(:asset_id AS UUID)`,
    { asset_id: assetId },
  );
  if (!asset || asset.status === "removed") return "not_found";
  if (asset.created_by_user_id !== requesterUserId && !platformAdmin) return "forbidden";

  await execute(
    `UPDATE asset_gallery.assets SET title = :title, updated_at = NOW()
     WHERE id = CAST(:asset_id AS UUID)`,
    { asset_id: assetId, title },
  );
  return "renamed";
}

export async function countRecentUploadsByUser(userId: string): Promise<number> {
  const row = await queryOne<{ upload_count: number }>(
    `SELECT COUNT(*)::int AS upload_count
     FROM asset_gallery.assets
     WHERE created_by_user_id = :user_id
       AND created_at >= NOW() - INTERVAL '1 hour'`,
    { user_id: userId },
  );
  return row?.upload_count ?? 0;
}
