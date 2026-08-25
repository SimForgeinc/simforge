import type {
  MapAsset,
  MapAssetArtifact,
  MapEnrichmentSummary,
  MapImageryTileset,
  MapPlaceContext,
  MapStats,
} from "@simforge/studio-shared";
import { cache } from "react";
import { mapAssetArtifactRowId } from "./ids";
import { execute, queryOne, queryRows, withTransaction } from "./data-api";
import {
  FLYBY_PREVIEW_ARTIFACT_TYPE,
  flybyPreviewKeyForOriginalKey,
} from "../maps/flyby-preview";

export type MapAssetRow = {
  map_asset_id: string;
  name: string;
  carla_map_name: string | null;
  ue5_carla_map_name: string | null;
  imagery_tilesets_json: string | null;
  description: string | null;
  crs: string;
  bbox_min_lat: number;
  bbox_min_lng: number;
  bbox_max_lat: number;
  bbox_max_lng: number;
  center_lat: number;
  center_lng: number;
  created_at: string;
  tags_json: string;
  artifacts_json: string;
  map_source_json: string | null;
  map_coordinate_ref_json: string | null;
  place_context_json: string | null;
  metadata_last_populated_at: string | null;
  map_stats_json: string | null;
  enrichment_summary_json: string | null;
};

function parseS3Uri(uri: string): { bucket: string; key: string } {
  if (!uri.startsWith("s3://")) {
    throw new Error(`Expected s3:// URI, received ${uri}`);
  }

  const withoutScheme = uri.slice("s3://".length);
  const slashIndex = withoutScheme.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(`Invalid S3 URI: ${uri}`);
  }

  return {
    bucket: withoutScheme.slice(0, slashIndex),
    key: withoutScheme.slice(slashIndex + 1),
  };
}

function serializeArtifactUri(bucket: string, key: string) {
  return `s3://${bucket}/${key}`;
}

function parseOptionalJsonObject<T>(raw: string | null): T | undefined {
  if (raw == null || raw === "" || raw === "null") return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function mapAssetFromRow(row: MapAssetRow): MapAsset {
  const tags = JSON.parse(row.tags_json) as string[];
  const artifacts = JSON.parse(row.artifacts_json) as MapAssetArtifact[];
  const map_source = parseOptionalJsonObject<MapAsset["map_source"]>(row.map_source_json);
  const map_coordinate_ref = parseOptionalJsonObject<MapAsset["map_coordinate_ref"]>(
    row.map_coordinate_ref_json,
  );
  const place_context = parseOptionalJsonObject<MapPlaceContext>(row.place_context_json);
  const map_stats = parseOptionalJsonObject<MapStats>(row.map_stats_json);
  const enrichment_summary = parseOptionalJsonObject<MapEnrichmentSummary>(row.enrichment_summary_json);

  return {
    map_asset_id: row.map_asset_id,
    name: row.name,
    carla_map_name: row.carla_map_name ?? undefined,
    ue5_carla_map_name: row.ue5_carla_map_name ?? undefined,
    imagery_tilesets: parseOptionalJsonObject<MapImageryTileset[]>(row.imagery_tilesets_json),
    description: row.description ?? undefined,
    crs: row.crs,
    bbox: {
      min_lat: row.bbox_min_lat,
      min_lng: row.bbox_min_lng,
      max_lat: row.bbox_max_lat,
      max_lng: row.bbox_max_lng,
    },
    center: {
      lat: row.center_lat,
      lng: row.center_lng,
    },
    created_at: row.created_at,
    artifacts,
    tags: tags.length > 0 ? tags : undefined,
    map_source,
    map_coordinate_ref,
    place_context,
    metadata_last_populated_at: row.metadata_last_populated_at ?? undefined,
    map_stats,
    enrichment_summary,
  };
}

const MAP_ASSET_SELECT = `
  SELECT
    m.id AS map_asset_id,
    m.name,
    m.carla_map_name,
    m.ue5_carla_map_name,
    m.imagery_tilesets::text AS imagery_tilesets_json,
    m.description,
    m.crs,
    m.bbox_min_lat,
    m.bbox_min_lng,
    m.bbox_max_lat,
    m.bbox_max_lng,
    m.center_lat,
    m.center_lng,
    m.created_at::text AS created_at,
    m.tags::text AS tags_json,
    m.map_source::text AS map_source_json,
    m.map_coordinate_ref::text AS map_coordinate_ref_json,
    m.place_context::text AS place_context_json,
    m.metadata_last_populated_at::text AS metadata_last_populated_at,
    MAX(s.stats::text) AS map_stats_json,
    MAX(e.summary_json::text) AS enrichment_summary_json,
    COALESCE(
      jsonb_agg(
        jsonb_strip_nulls(
          jsonb_build_object(
            'artifact_type', a.artifact_type,
            'uri', 's3://' || a.s3_bucket || '/' || a.s3_key,
            'sha256', a.checksum_sha256,
            'label', a.label,
            'size_bytes', a.size_bytes,
            'created_at', a.created_at
          )
        )
        ORDER BY a.sort_order ASC, a.created_at ASC
      ) FILTER (WHERE a.id IS NOT NULL),
      '[]'::jsonb
    )::text AS artifacts_json
  FROM map_assets m
  LEFT JOIN map_asset_stats s ON s.map_asset_id = m.id
  LEFT JOIN map_asset_enrichments e ON e.map_asset_id = m.id
  LEFT JOIN map_asset_artifacts a ON a.map_asset_id = m.id
`;

export async function listMapAssetsFromDb(): Promise<MapAsset[]> {
  const rows = await queryRows<MapAssetRow>(
    `
      ${MAP_ASSET_SELECT}
      WHERE m.is_active = TRUE
      GROUP BY
        m.id,
        m.name,
        m.description,
        m.crs,
        m.bbox_min_lat,
        m.bbox_min_lng,
        m.bbox_max_lat,
        m.bbox_max_lng,
        m.center_lat,
        m.center_lng,
        m.tags,
        m.created_at,
        m.map_source,
        m.map_coordinate_ref,
        m.place_context,
        m.metadata_last_populated_at
      ORDER BY m.created_at DESC, m.id ASC
    `,
  );

  return rows.map(mapAssetFromRow);
}

/**
 * One map-asset row per request, however many callers ask for it.
 *
 * This is a GROUP BY aggregate over joins against Aurora, measured at a very
 * consistent 87-91 ms, and it is uncached. Every map-scoped route on the
 * editor's load path calls it — and `runtime-geometry` calls it twice, once in
 * the route and once inside the topology service. Across a load that was
 * roughly 0.6 s of server time spent re-reading a row that cannot change
 * within a request.
 *
 * React's `cache()` is request-scoped, so this cannot serve a stale row across
 * requests the way a module-level Map would.
 */
export const getMapAssetByIdFromDb = cache(getMapAssetByIdFromDbUncached);

async function getMapAssetByIdFromDbUncached(mapAssetId: string): Promise<MapAsset | null> {
  const row = await queryOne<MapAssetRow>(
    `
      ${MAP_ASSET_SELECT}
      WHERE m.id = :map_asset_id
        AND m.is_active = TRUE
      GROUP BY
        m.id,
        m.name,
        m.description,
        m.crs,
        m.bbox_min_lat,
        m.bbox_min_lng,
        m.bbox_max_lat,
        m.bbox_max_lng,
        m.center_lat,
        m.center_lng,
        m.tags,
        m.created_at,
        m.map_source,
        m.map_coordinate_ref,
        m.place_context,
        m.metadata_last_populated_at
      LIMIT 1
    `,
    { map_asset_id: mapAssetId },
  );

  return row ? mapAssetFromRow(row) : null;
}

export type RuntimeMapAssetIdentity = Pick<
  MapAsset,
  "map_asset_id" | "name" | "carla_map_name" | "ue5_carla_map_name"
>;

export async function getMapAssetByRuntimeNameFromDb(
  mapName: string,
): Promise<RuntimeMapAssetIdentity | null> {
  const row = await queryOne<{
    map_asset_id: string;
    name: string;
    carla_map_name: string | null;
    ue5_carla_map_name: string | null;
  }>(
    `
      SELECT id AS map_asset_id, name, carla_map_name, ue5_carla_map_name
      FROM map_assets
      WHERE is_active = TRUE
        AND (carla_map_name = :map_name OR ue5_carla_map_name = :map_name)
      ORDER BY CASE WHEN ue5_carla_map_name = :map_name THEN 0 ELSE 1 END, id ASC
      LIMIT 1
    `,
    { map_name: mapName },
  );
  if (!row) return null;
  return {
    map_asset_id: row.map_asset_id,
    name: row.name,
    carla_map_name: row.carla_map_name ?? undefined,
    ue5_carla_map_name: row.ue5_carla_map_name ?? undefined,
  };
}

export async function mapAssetExistsInDb(mapAssetId: string): Promise<boolean> {
  const row = await queryOne<{ exists: number }>(
    `
      SELECT 1 AS exists
      FROM map_assets
      WHERE id = :map_asset_id
        AND is_active = TRUE
      LIMIT 1
    `,
    { map_asset_id: mapAssetId },
  );

  return row != null;
}

export async function upsertMapAsset(asset: MapAsset): Promise<void> {
  await withTransaction(async (tx) => {
    const mapSourceParam =
      asset.map_source != null ? (asset.map_source as Record<string, unknown>) : null;
    const mapCoordParam =
      asset.map_coordinate_ref != null
        ? (asset.map_coordinate_ref as Record<string, unknown>)
        : null;
    const placeContextParam =
      asset.place_context != null ? (asset.place_context as Record<string, unknown>) : null;
    const metaPopulatedParam = asset.metadata_last_populated_at ?? null;

    await tx.execute(
      `
        INSERT INTO map_assets (
          id,
          name,
          carla_map_name,
          imagery_tilesets,
          description,
          crs,
          bbox_min_lat,
          bbox_min_lng,
          bbox_max_lat,
          bbox_max_lng,
          center_lat,
          center_lng,
          tags,
          map_source,
          map_coordinate_ref,
          place_context,
          metadata_last_populated_at,
          created_at,
          updated_at
        )
        VALUES (
          :id,
          :name,
          :carla_map_name,
          CAST(:imagery_tilesets AS JSONB),
          :description,
          :crs,
          :bbox_min_lat,
          :bbox_min_lng,
          :bbox_max_lat,
          :bbox_max_lng,
          :center_lat,
          :center_lng,
          :tags,
          CAST(:map_source AS JSONB),
          CAST(:map_coordinate_ref AS JSONB),
          CAST(:place_context AS JSONB),
          CAST(NULLIF(:metadata_last_populated_at, '') AS TIMESTAMPTZ),
          CAST(REPLACE(REPLACE(:created_at, 'T', ' '), 'Z', '') AS TIMESTAMPTZ),
          NOW()
        )
        ON CONFLICT (id)
        DO UPDATE SET
          name = EXCLUDED.name,
          carla_map_name = EXCLUDED.carla_map_name,
          imagery_tilesets = EXCLUDED.imagery_tilesets,
          description = EXCLUDED.description,
          crs = EXCLUDED.crs,
          bbox_min_lat = EXCLUDED.bbox_min_lat,
          bbox_min_lng = EXCLUDED.bbox_min_lng,
          bbox_max_lat = EXCLUDED.bbox_max_lat,
          bbox_max_lng = EXCLUDED.bbox_max_lng,
          center_lat = EXCLUDED.center_lat,
          center_lng = EXCLUDED.center_lng,
          tags = EXCLUDED.tags,
          map_source = COALESCE(EXCLUDED.map_source, map_assets.map_source),
          map_coordinate_ref = COALESCE(EXCLUDED.map_coordinate_ref, map_assets.map_coordinate_ref),
          place_context = COALESCE(EXCLUDED.place_context, map_assets.place_context),
          metadata_last_populated_at = COALESCE(
            EXCLUDED.metadata_last_populated_at,
            map_assets.metadata_last_populated_at
          ),
          is_active = TRUE,
          updated_at = NOW()
      `,
      {
        id: asset.map_asset_id,
        name: asset.name,
        carla_map_name: asset.carla_map_name ?? null,
        imagery_tilesets:
          asset.imagery_tilesets && asset.imagery_tilesets.length > 0
            ? asset.imagery_tilesets
            : null,
        description: asset.description ?? null,
        crs: asset.crs,
        bbox_min_lat: asset.bbox.min_lat,
        bbox_min_lng: asset.bbox.min_lng,
        bbox_max_lat: asset.bbox.max_lat,
        bbox_max_lng: asset.bbox.max_lng,
        center_lat: asset.center.lat,
        center_lng: asset.center.lng,
        tags: asset.tags ?? [],
        map_source: mapSourceParam,
        map_coordinate_ref: mapCoordParam,
        place_context: placeContextParam,
        metadata_last_populated_at: metaPopulatedParam,
        created_at: asset.created_at,
      },
    );

    for (let index = 0; index < asset.artifacts.length; index += 1) {
      const artifact = asset.artifacts[index];
      if (!artifact) continue;
      const { bucket, key } = parseS3Uri(artifact.uri);
      await tx.execute(
        `
          INSERT INTO map_asset_artifacts (
            id,
            map_asset_id,
            artifact_type,
            s3_bucket,
            s3_key,
            checksum_sha256,
            label,
            size_bytes,
            sort_order
          )
          VALUES (
            :id,
            :map_asset_id,
            :artifact_type,
            :s3_bucket,
            :s3_key,
            :checksum_sha256,
            :label,
            :size_bytes,
            :sort_order
          )
          ON CONFLICT (map_asset_id, s3_bucket, s3_key)
          DO UPDATE SET
            artifact_type = EXCLUDED.artifact_type,
            checksum_sha256 = EXCLUDED.checksum_sha256,
            label = EXCLUDED.label,
            size_bytes = COALESCE(EXCLUDED.size_bytes, map_asset_artifacts.size_bytes),
            sort_order = EXCLUDED.sort_order
        `,
        {
          id: mapAssetArtifactRowId(asset.map_asset_id, key),
          map_asset_id: asset.map_asset_id,
          artifact_type: artifact.artifact_type,
          s3_bucket: bucket,
          s3_key: key,
          checksum_sha256: artifact.sha256,
          label: artifact.label ?? null,
          size_bytes: artifact.size_bytes ?? null,
          sort_order: index,
        },
      );
    }

    // Delete artifact rows that are no longer in the updated artifacts list.
    // The artifact row ID is a deterministic hash of (map_asset_id + s3_key),
    // so we can compute which IDs to keep and delete the rest.
    const keptIds = new Set(
      asset.artifacts.map((a) => {
        const { key } = parseS3Uri(a.uri);
        return mapAssetArtifactRowId(asset.map_asset_id, key);
      }),
    );
    // `mp4_preview` rows are written out-of-band by the map-flyby-preview
    // Lambda after the fly-by video lands in S3. The web edit flow's artifact
    // snapshot can predate that insert, so a preview for a still-present fly-by
    // video may be missing from `keptIds`. Protect those rows from the
    // reconciliation delete by recomputing the preview row IDs that legitimately
    // correspond to a fly-by video in the updated set. (A preview whose source
    // mp4 was removed is intentionally NOT protected — the PATCH route drops it
    // from the artifacts list so it gets cleaned up here.)
    const protectedPreviewIds = new Set(
      asset.artifacts
        .filter((a) => a.artifact_type === "mp4")
        .map((a) => {
          const { key } = parseS3Uri(a.uri);
          return mapAssetArtifactRowId(
            asset.map_asset_id,
            flybyPreviewKeyForOriginalKey(key),
          );
        }),
    );
    // Fetch all current artifact IDs for this map, then delete any that aren't in keptIds.
    const currentRows = await tx.queryRows<{ id: string; artifact_type: string }>(
      `SELECT id, artifact_type FROM map_asset_artifacts WHERE map_asset_id = :map_asset_id`,
      { map_asset_id: asset.map_asset_id },
    );
    for (const row of currentRows) {
      if (keptIds.has(row.id)) continue;
      if (
        row.artifact_type === FLYBY_PREVIEW_ARTIFACT_TYPE &&
        protectedPreviewIds.has(row.id)
      ) {
        continue;
      }
      await tx.execute(
        `DELETE FROM map_asset_artifacts WHERE id = :id`,
        { id: row.id },
      );
    }

    if (asset.map_stats != null) {
      const hashes = asset.artifacts.map((a) => ({
        type: a.artifact_type,
        sha256: a.sha256,
      }));
      await tx.execute(
        `
          INSERT INTO map_asset_stats (map_asset_id, stats, computed_at, source_artifact_hashes)
          VALUES (
            :map_asset_id,
            CAST(:stats AS JSONB),
            CAST(NULLIF(:computed_at, '') AS TIMESTAMPTZ),
            CAST(:source_artifact_hashes AS JSONB)
          )
          ON CONFLICT (map_asset_id)
          DO UPDATE SET
            stats = EXCLUDED.stats,
            computed_at = EXCLUDED.computed_at,
            source_artifact_hashes = EXCLUDED.source_artifact_hashes
        `,
        {
          map_asset_id: asset.map_asset_id,
          stats: asset.map_stats as Record<string, unknown>,
          computed_at: asset.map_stats.computed_at ?? "",
          source_artifact_hashes: hashes,
        },
      );
    }
  });
}

type MapArtifactLocationRow = {
  s3_bucket: string;
  s3_key: string;
};

export function normalizeMapArtifactBucket(bucket: string): string {
  const configuredBucket = process.env.S3_BUCKET?.trim();
  if (!configuredBucket || configuredBucket === bucket) {
    return bucket;
  }

  // Map assets are replicated per environment under stable keys. When a staging
  // or prod database is promoted from dev, copied rows can still point at the
  // source bucket even though the current environment should read from its own
  // asset bucket.
  if (bucket.startsWith("simforge-assets-") && configuredBucket.startsWith("simforge-assets-")) {
    return configuredBucket;
  }

  return bucket;
}

export async function getMapArtifactLocation(
  mapAssetId: string,
  artifactType: MapAssetArtifact["artifact_type"],
): Promise<{ bucket: string; key: string } | null> {
  const row = await queryOne<MapArtifactLocationRow>(
    `
      SELECT s3_bucket, s3_key
      FROM map_asset_artifacts
      WHERE map_asset_id = :map_asset_id
        AND artifact_type = :artifact_type
      ORDER BY sort_order ASC, created_at ASC
      LIMIT 1
    `,
    {
      map_asset_id: mapAssetId,
      artifact_type: artifactType,
    },
  );

  if (!row) return null;
  return { bucket: normalizeMapArtifactBucket(row.s3_bucket), key: row.s3_key };
}

type MapArtifactRevisionRow = {
  s3_bucket: string;
  s3_key: string;
  checksum_sha256: string | null;
};

/**
 * Cheap revision-signal lookup for an artifact: bucket/key plus the stored
 * SHA-256 checksum. Used by caches that need to invalidate when the
 * underlying S3 object is replaced without issuing a HEAD request.
 */
export async function getMapArtifactRevision(
  mapAssetId: string,
  artifactType: MapAssetArtifact["artifact_type"],
): Promise<{ bucket: string; key: string; sha256: string | null } | null> {
  const row = await queryOne<MapArtifactRevisionRow>(
    `
      SELECT s3_bucket, s3_key, checksum_sha256
      FROM map_asset_artifacts
      WHERE map_asset_id = :map_asset_id
        AND artifact_type = :artifact_type
      ORDER BY sort_order ASC, created_at ASC
      LIMIT 1
    `,
    {
      map_asset_id: mapAssetId,
      artifact_type: artifactType,
    },
  );

  if (!row) return null;
  return {
    bucket: normalizeMapArtifactBucket(row.s3_bucket),
    key: row.s3_key,
    sha256: row.checksum_sha256,
  };
}

/** Update only the tags column on a map asset (no artifact replacement). */
export async function updateMapAssetTags(
  mapAssetId: string,
  tags: string[] | undefined,
): Promise<void> {
  await execute(
    `UPDATE map_assets SET tags = :tags, updated_at = NOW() WHERE id = :id`,
    { id: mapAssetId, tags: tags ?? [] },
  );
}

export function mapArtifactToUri(bucket: string, key: string) {
  return serializeArtifactUri(bucket, key);
}

export function splitMapArtifactUri(uri: string) {
  return parseS3Uri(uri);
}

/** Hard-delete map row; `map_asset_artifacts` and `map_asset_stats` cascade. Caller must remove S3 objects. */
export async function deleteMapAssetById(mapAssetId: string): Promise<void> {
  await execute(`DELETE FROM map_assets WHERE id = :id`, { id: mapAssetId });
}
