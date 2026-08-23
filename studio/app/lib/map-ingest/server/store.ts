import { createHash } from "node:crypto";
import type {
  CreateMapUploadInput,
  MapLayerInput,
  MapPreflight,
  MapUploadDraftSummary,
} from "@/app/lib/map-ingest/contracts";
import { execute, queryOne, queryRows } from "@/app/lib/db/data-api";

export type MapUploadDraftState = "pending" | "publishing" | "published" | "failed";

export type MapUploadDraft = {
  id: string;
  workspaceId: string;
  createdByUserId: string | null;
  label: string;
  locality: string;
  carlaMapName: string | null;
  sourceMapId: string;
  xodrSha256: string;
  xodrByteLength: number;
  thumbnailSha256: string;
  thumbnailByteLength: number;
  layers: MapLayerInput[];
  preflight: MapPreflight;
  state: MapUploadDraftState;
  failureReason: string | null;
  mapVersionId: string | null;
  createdAt: string;
  updatedAt: string;
};

type MapUploadDraftRow = {
  id: string;
  workspace_id: string;
  created_by_user_id: string | null;
  label: string;
  locality: string;
  carla_map_name: string | null;
  source_map_id: string;
  xodr_sha256: string;
  xodr_byte_length: number;
  thumbnail_sha256: string;
  thumbnail_byte_length: number;
  layers_json: string;
  preflight_json: string;
  draft_state: MapUploadDraftState;
  failure_reason: string | null;
  map_version_id: string | null;
  created_at: string;
  updated_at: string;
};

const MAP_UPLOAD_DRAFT_SELECT = `
  SELECT
    id,
    workspace_id,
    created_by_user_id,
    label,
    locality,
    carla_map_name,
    source_map_id,
    xodr_sha256,
    xodr_byte_length,
    thumbnail_sha256,
    thumbnail_byte_length,
    layers::text AS layers_json,
    preflight::text AS preflight_json,
    draft_state,
    failure_reason,
    map_version_id,
    created_at::text AS created_at,
    updated_at::text AS updated_at
  FROM uniscenario.map_upload_drafts
`;

function draftFromRow(row: MapUploadDraftRow): MapUploadDraft {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdByUserId: row.created_by_user_id,
    label: row.label,
    locality: row.locality,
    carlaMapName: row.carla_map_name,
    sourceMapId: row.source_map_id,
    xodrSha256: row.xodr_sha256,
    xodrByteLength: row.xodr_byte_length,
    thumbnailSha256: row.thumbnail_sha256,
    thumbnailByteLength: row.thumbnail_byte_length,
    layers: JSON.parse(row.layers_json) as MapLayerInput[],
    preflight: JSON.parse(row.preflight_json) as MapPreflight,
    state: row.draft_state,
    failureReason: row.failure_reason,
    mapVersionId: row.map_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deriveDraftDigest(
  workspaceId: string,
  xodrSha256: string,
  layers: readonly MapLayerInput[],
): string {
  const hash = createHash("sha256")
    .update(workspaceId)
    .update("\0")
    .update(xodrSha256)
    .update("\0");
  for (const layerSha256 of layers.map((layer) => layer.sha256).sort()) {
    hash.update(layerSha256).update("\0");
  }
  return hash.digest("hex");
}

/**
 * The logical map id: lowercase, hyphen-separated, no underscores.
 *
 * This is the identity map-intel brands with `asMapId`, whose pattern is
 * `^[a-z0-9][a-z0-9-]*$`, and it is the same distinction `config/uniscenario/
 * map-seeds.json` already draws — `mapId: "belmont-research-center"` beside
 * `sourceMapId: "belmont-research-center_20260410-184713"`.
 */
export function mapSlugFromLabel(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "map";
}

/**
 * The provenance identity a published version carries. The `upload-` marker
 * keeps it disjoint from the materializer's `<slug>_YYYYMMDD-HHMMSS` ids, and
 * the digest keeps re-submitting identical content idempotent.
 */
function sourceMapId(label: string, draftDigest: string): string {
  return `${mapSlugFromLabel(label)}_upload-${draftDigest.slice(0, 20)}`;
}

export async function createMapUploadDraft(
  input: CreateMapUploadInput & {
    workspaceId: string;
    createdByUserId: string;
  },
): Promise<MapUploadDraft> {
  const digest = deriveDraftDigest(input.workspaceId, input.xodr.sha256, input.layers);
  const id = `usmapdraft_${digest.slice(0, 32)}`;
  await execute(
    `INSERT INTO uniscenario.map_upload_drafts (
       id, workspace_id, created_by_user_id, label, locality, carla_map_name,
       source_map_id, xodr_sha256, xodr_byte_length, thumbnail_sha256,
       thumbnail_byte_length, layers, preflight
     ) VALUES (
       :id, :workspace_id, :created_by_user_id, :label, :locality, :carla_map_name,
       :source_map_id, :xodr_sha256, :xodr_byte_length, :thumbnail_sha256,
       :thumbnail_byte_length, CAST(:layers AS JSONB), CAST(:preflight AS JSONB)
     )
     ON CONFLICT (id) DO NOTHING`,
    {
      id,
      workspace_id: input.workspaceId,
      created_by_user_id: input.createdByUserId,
      label: input.label,
      locality: input.locality,
      carla_map_name: input.carlaMapName,
      source_map_id: sourceMapId(input.label, digest),
      xodr_sha256: input.xodr.sha256,
      xodr_byte_length: input.xodr.byteLength,
      thumbnail_sha256: input.thumbnail.sha256,
      thumbnail_byte_length: input.thumbnail.byteLength,
      layers: input.layers,
      preflight: input.preflight,
    },
  );
  const draft = await getMapUploadDraft(id);
  if (!draft) throw new Error(`map upload draft ${id} was not persisted`);
  return draft;
}

export async function getMapUploadDraft(id: string): Promise<MapUploadDraft | null> {
  const row = await queryOne<MapUploadDraftRow>(
    `${MAP_UPLOAD_DRAFT_SELECT} WHERE id = :id`,
    { id },
  );
  return row ? draftFromRow(row) : null;
}

export async function markMapUploadDraftPublishing(
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(
    `UPDATE uniscenario.map_upload_drafts
     SET draft_state = 'publishing', failure_reason = NULL, updated_at = NOW()
     WHERE id = :id
       AND workspace_id = :workspace_id
       AND draft_state IN ('pending', 'failed')
     RETURNING id`,
    { id, workspace_id: workspaceId },
  );
  return rows.length === 1;
}

export async function markMapUploadDraftPublished(
  id: string,
  workspaceId: string,
  mapVersionId: string,
): Promise<void> {
  await execute(
    `UPDATE uniscenario.map_upload_drafts
     SET draft_state = 'published', map_version_id = :map_version_id,
         failure_reason = NULL, updated_at = NOW()
     WHERE id = :id AND workspace_id = :workspace_id`,
    { id, workspace_id: workspaceId, map_version_id: mapVersionId },
  );
}

export async function markMapUploadDraftFailed(
  id: string,
  workspaceId: string,
  reason: string,
): Promise<void> {
  await execute(
    `UPDATE uniscenario.map_upload_drafts
     SET draft_state = 'failed', failure_reason = :failure_reason, updated_at = NOW()
     WHERE id = :id AND workspace_id = :workspace_id AND draft_state <> 'published'`,
    { id, workspace_id: workspaceId, failure_reason: reason },
  );
}

export async function listMapUploadDrafts(
  workspaceId: string,
  limit = 50,
): Promise<MapUploadDraftSummary[]> {
  const rows = await queryRows<MapUploadDraftRow>(
    `${MAP_UPLOAD_DRAFT_SELECT}
     WHERE workspace_id = :workspace_id
     ORDER BY created_at DESC, id DESC
     LIMIT :limit`,
    { workspace_id: workspaceId, limit: Math.min(Math.max(limit, 1), 100) },
  );
  return rows.map((row) => ({
    draftId: row.id,
    label: row.label,
    locality: row.locality,
    state: row.draft_state,
    failureReason: row.failure_reason,
    mapVersionId: row.map_version_id,
    createdAt: row.created_at,
  }));
}
