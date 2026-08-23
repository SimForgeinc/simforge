import type { AppContext } from "@/app/lib/db/app-context";
import { queryRows } from "@/app/lib/db/data-api";
import type { UniScenarioMapBrowserAsset } from "./document-store";

async function readUniScenarioMapThumbnail(
  mapVersionId: string,
): Promise<UniScenarioMapBrowserAsset | null> {
  const rows = await queryRows<{
    storage_bucket: string;
    storage_key: string;
    sha256: string;
    byte_length: number;
    media_type: string;
  }>(
    `SELECT a.storage_bucket, a.storage_key, a.sha256, a.byte_length, a.media_type
     FROM uniscenario.map_versions mv
     JOIN uniscenario.artifacts a ON a.id = mv.thumbnail_artifact_id
       AND a.workspace_id = mv.workspace_id
       AND a.artifact_kind = 'map-thumbnail-v2'
       AND a.artifact_state = 'available'
       AND a.deleted_at IS NULL
     WHERE mv.id = :map_version_id
       AND mv.retired_at IS NULL
     LIMIT 1`,
    { map_version_id: mapVersionId },
  );
  const row = rows[0];
  return row
    ? {
        bucket: row.storage_bucket,
        key: row.storage_key,
        objectVersionId: null,
        sha256: row.sha256,
        byteLength: Number(row.byte_length),
        mediaType: row.media_type,
      }
    : null;
}

export async function getUniScenarioMapThumbnail(
  _context: AppContext,
  mapVersionId: string,
): Promise<UniScenarioMapBrowserAsset | null> {
  return readUniScenarioMapThumbnail(mapVersionId);
}
