import type { CandidateLocation, CandidateLocationSource, CandidateLocationRegion, CandidateLocationEvidence } from "@simforge/studio-shared";
import { batchExecute, execute, queryRows } from "./data-api";
import { parseJson as sharedParseJson, parseJsonArray as sharedParseJsonArray } from "./json-helpers";

// ── Row shape ────────────────────────────────────────────────────────────────

type CandidateLocationRow = {
  id: string;
  map_asset_id: string;
  kind: string;
  source: string;
  label: string;
  description: string | null;
  reason: string;
  confidence: number;
  tags_json: string;
  evidence_json: string;
  geometry_json: string;
  center_lat: number;
  center_lng: number;
  created_at: string;
  updated_at: string;
};

function parseJson<T>(raw: string | null, fallback: T): T {
  return sharedParseJson(raw, fallback);
}

function parseJsonArray<T>(raw: string | null): T[] {
  return sharedParseJsonArray<T>(raw);
}

function rowToLocation(row: CandidateLocationRow): CandidateLocation {
  return {
    id: row.id,
    map_asset_id: row.map_asset_id,
    kind: row.kind as CandidateLocation["kind"],
    source: row.source as CandidateLocation["source"],
    label: row.label,
    description: row.description ?? undefined,
    reason: row.reason,
    confidence: row.confidence,
    tags: parseJsonArray<string>(row.tags_json),
    evidence: parseJsonArray<CandidateLocationEvidence>(row.evidence_json),
    region: parseJson<CandidateLocationRegion>(row.geometry_json, { type: "Point", coordinates: [row.center_lng, row.center_lat] }),
    center: { lat: row.center_lat, lng: row.center_lng },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Queries ──────────────────────────────────────────────────────────────────

const SELECT_COLS = `
  id, map_asset_id, kind, source, label, description, reason, confidence,
  tags::text AS tags_json, evidence::text AS evidence_json,
  geometry::text AS geometry_json,
  center_lat, center_lng,
  created_at::text AS created_at, updated_at::text AS updated_at
`;

// Single SELECT page size. The Aurora Data API caps each response at 1 MB;
// candidate rows can carry kilobytes of JSONB (geometry + evidence + the new
// occlusion block) so we page the read to stay well under that ceiling.
// 200 rows × ~4 KB worst case ≈ 800 KB. The tiebreaker on `id` keeps OFFSET
// stable across pages even when confidence + kind tie.
const PAGE_SIZE = 200;

export async function getCandidateLocationsByMapAssetId(
  mapAssetId: string,
): Promise<CandidateLocation[]> {
  const all: CandidateLocationRow[] = [];
  let offset = 0;
  for (;;) {
    const rows = await queryRows<CandidateLocationRow>(
      `SELECT ${SELECT_COLS} FROM map_candidate_locations
         WHERE map_asset_id = :map_asset_id
         ORDER BY confidence DESC, kind, id
         LIMIT :limit OFFSET :offset`,
      { map_asset_id: mapAssetId, limit: PAGE_SIZE, offset },
    );
    const batch = rows ?? [];
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all.map(rowToLocation);
}

export async function getCandidateLocationsByTag(
  tag: string,
): Promise<CandidateLocation[]> {
  const rows = await queryRows<CandidateLocationRow>(
    `SELECT ${SELECT_COLS} FROM map_candidate_locations WHERE tags @> CAST(:tag_filter AS JSONB) ORDER BY confidence DESC`,
    { tag_filter: JSON.stringify([tag]) },
  );
  return (rows ?? []).map(rowToLocation);
}

/**
 * Upsert candidate locations for a map + source combination.
 * Deletes existing rows for the given (mapAssetId, source) pair, then inserts new ones.
 * This makes re-extraction idempotent per source without touching other sources.
 */
export async function upsertCandidateLocations(
  mapAssetId: string,
  source: CandidateLocationSource,
  locations: CandidateLocation[],
): Promise<void> {
  // Delete existing rows for this map + source
  await execute(
    `DELETE FROM map_candidate_locations WHERE map_asset_id = :map_asset_id AND source = :source`,
    { map_asset_id: mapAssetId, source },
  );

  if (locations.length === 0) return;

  // Batch insert all rows in a single Data API HTTP call (up to 1000 per batch).
  await batchExecute(
    `INSERT INTO map_candidate_locations (
      id, map_asset_id, kind, source, label, description, reason, confidence,
      tags, evidence, geometry,
      center_lat, center_lng
    ) VALUES (
      :id, :map_asset_id, :kind, :source, :label, :description, :reason, :confidence,
      CAST(:tags AS JSONB), CAST(:evidence AS JSONB), CAST(:geometry AS JSONB),
      :center_lat, :center_lng
    )`,
    locations.map((loc) => ({
      id: loc.id,
      map_asset_id: loc.map_asset_id,
      kind: loc.kind,
      source: loc.source,
      label: loc.label,
      description: loc.description ?? null,
      reason: loc.reason,
      confidence: loc.confidence,
      tags: loc.tags,
      evidence: loc.evidence,
      geometry: loc.region,
      center_lat: loc.center.lat,
      center_lng: loc.center.lng,
    })),
  );
}

/**
 * Update labels (and optionally descriptions) for existing candidate locations.
 * Used after street name resolution to apply human-readable names.
 */
export async function updateCandidateLocationLabels(
  mapAssetId: string,
  updates: Array<{ id: string; label: string; description?: string }>,
): Promise<void> {
  if (updates.length === 0) return;

  // Batch update all labels in a single Data API HTTP call (up to 1000 per batch).
  await batchExecute(
    `UPDATE map_candidate_locations
     SET label = :label,
         description = COALESCE(:description, description),
         updated_at = NOW()
     WHERE id = :id AND map_asset_id = :map_asset_id`,
    updates.map((u) => ({
      id: u.id,
      label: u.label,
      description: u.description ?? null,
      map_asset_id: mapAssetId,
    })),
  );
}

export async function deleteCandidateLocationsByMapAssetId(
  mapAssetId: string,
): Promise<void> {
  await execute(
    `DELETE FROM map_candidate_locations WHERE map_asset_id = :map_asset_id`,
    { map_asset_id: mapAssetId },
  );
}
