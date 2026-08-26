import type {
  MapAssetEnrichmentManifest,
  MapAssetEnrichmentSnapshot,
  MapCandidateLocation,
  MapEnrichmentSummary,
  MapOverlayPayload,
} from "@simforge-oss/studio-shared";
import {
  MAP_CANDIDATE_LOCATION_KINDS,
  MAP_OVERLAY_LAYER_IDS,
  MapAssetEnrichmentSnapshotSchema,
  MapCandidateLocationSchema,
  MapEnrichmentSummarySchema,
  MapOverlayPayloadSchema,
} from "@simforge-oss/studio-shared";
import type { RoadSegmentForMatching } from "@simforge-oss/studio-shared";
import { execute, queryOne } from "./data-api";
import { normalizeMapArtifactBucket } from "./map-asset-store";
import { S3_BUCKET } from "../s3/s3-config";
import { parseJson as sharedParseJson } from "./json-helpers";
import { getS3ObjectUtf8 } from "../s3/s3-get-object";
import { putS3ObjectUtf8Gzipped } from "../s3/s3-put-object";
import { getBrowserAssetUrl } from "../assets/asset-url-service";

/**
 * Row shape after the 2026-05-11 migration. The overlay GeoJSON and candidate
 * locations no longer live as JSONB on the row — they're stored as gzipped
 * JSON in S3 and only the bucket/key are persisted here. Old snapshots written
 * before the migration have NULL in the S3 columns; readers treat that as
 * "snapshot needs re-extraction" and surface a 404 to the client.
 */
export type MapAssetEnrichmentRow = {
  map_asset_id: string;
  provider: string;
  provider_release: string;
  computed_at: string;
  summary_json: string;
  warnings_json: string;
  road_segments_json: string | null;
  overlay_geojson_s3_bucket: string | null;
  overlay_geojson_s3_key: string | null;
  candidate_locations_s3_bucket: string | null;
  candidate_locations_s3_key: string | null;
};

const VALID_OVERLAY_GEOMETRY_TYPES = new Set(["Point", "LineString", "Polygon", "GeoJSON"]);

const ENRICHMENT_ROW_SELECT = `
  SELECT
    map_asset_id,
    provider,
    provider_release,
    computed_at::text AS computed_at,
    summary_json::text AS summary_json,
    warnings_json::text AS warnings_json,
    road_segments_json::text AS road_segments_json,
    overlay_geojson_s3_bucket,
    overlay_geojson_s3_key,
    candidate_locations_s3_bucket,
    candidate_locations_s3_key
  FROM map_asset_enrichments
  WHERE map_asset_id = :map_asset_id
  LIMIT 1
`;

function parseJson<T>(raw: string, fallback: T): T {
  return sharedParseJson(raw, fallback);
}

function normalizeOverlayLayer(layer: unknown): unknown {
  if (layer == null || typeof layer !== "object" || Array.isArray(layer)) {
    return layer;
  }
  const record = layer as Record<string, unknown>;
  const geometryType = String(record.geometry_type ?? "");
  return {
    ...record,
    // Anything that's not a current canonical type — legacy "Mixed" from
    // pre-rename snapshots, or any unrecognised value from a forward-compat
    // future write — collapses to "GeoJSON". The renderer's "GeoJSON"
    // branch dispatches per-feature via geometry-type filters, so it
    // handles whatever heterogeneous shapes the layer actually contains.
    geometry_type: VALID_OVERLAY_GEOMETRY_TYPES.has(geometryType)
      ? geometryType
      : "GeoJSON",
  };
}

function collectLngLatPairs(value: unknown, out: Array<[number, number]>): void {
  if (!Array.isArray(value)) return;
  if (typeof value[0] === "number" && typeof value[1] === "number") {
    out.push([value[0], value[1]]);
    return;
  }
  for (const item of value) collectLngLatPairs(item, out);
}

function bboxFromCoordinates(coordinates: unknown) {
  const points: Array<[number, number]> = [];
  collectLngLatPairs(coordinates, points);
  if (points.length === 0) return null;
  const lngs = points.map(([lng]) => lng);
  const lats = points.map(([, lat]) => lat);
  return {
    min_lng: Math.min(...lngs),
    min_lat: Math.min(...lats),
    max_lng: Math.max(...lngs),
    max_lat: Math.max(...lats),
  };
}

function normalizeCandidateRegion(candidate: Record<string, unknown>) {
  const region = candidate.region;
  if (region == null || typeof region !== "object" || Array.isArray(region)) {
    return candidate;
  }
  const record = region as Record<string, unknown>;
  // Both BBOX and Polygon are valid MapCandidateRegion variants now (Polygon
  // was added so POIs promoted to a building footprint can ship the actual
  // shape instead of an AABB). Pass them through unchanged.
  if (record.type === "BBOX" || record.type === "Polygon") return candidate;
  // Legacy / unrecognised shapes — Point regions written before the schema
  // expanded, junk values from forward-compat future writes — collapse to
  // a degenerate BBOX at their first coordinate so downstream BBOX-only
  // consumers keep working.
  if (record.type === "Point") {
    const coordinates = record.coordinates;
    if (
      Array.isArray(coordinates) &&
      typeof coordinates[0] === "number" &&
      typeof coordinates[1] === "number"
    ) {
      const [lng, lat] = coordinates;
      return {
        ...candidate,
        region: {
          type: "BBOX",
          bbox: { min_lng: lng, min_lat: lat, max_lng: lng, max_lat: lat },
        },
      };
    }
  }
  const bbox = bboxFromCoordinates(record.coordinates);
  return bbox
    ? {
        ...candidate,
        region: { type: "BBOX", bbox },
      }
    : candidate;
}

function parseAndSanitizeOverlay(raw: string): MapOverlayPayload {
  const overlayRaw = parseJson<MapOverlayPayload>(raw, {
    bbox: { min_lat: 0, min_lng: 0, max_lat: 0, max_lng: 0 },
    layers: [],
  });
  // Strip overlay layers whose `layer_id` is no longer in the schema.
  // Persisted snapshots can lag the code (e.g. an overlay layer is removed
  // but old snapshots still reference it). Without this strip, strict Zod
  // validation would throw on every read until every map is re-extracted.
  const knownLayerIds = new Set<string>(MAP_OVERLAY_LAYER_IDS);
  const rawLayers = Array.isArray(overlayRaw.layers) ? overlayRaw.layers : [];
  overlayRaw.layers = rawLayers.filter(
    (l) => knownLayerIds.has(l.layer_id),
  ).map(normalizeOverlayLayer) as MapOverlayPayload["layers"];
  return MapOverlayPayloadSchema.parse(overlayRaw);
}

function parseAndSanitizeCandidates(raw: string): MapCandidateLocation[] {
  const knownLayerIds = new Set<string>(MAP_OVERLAY_LAYER_IDS);
  const knownCandidateKinds = new Set<string>(MAP_CANDIDATE_LOCATION_KINDS);
  const rawCandidateLocations = parseJson<unknown[]>(raw, []);
  const sanitized = rawCandidateLocations
    .filter(
      (candidate): candidate is Record<string, unknown> => {
        if (candidate == null || typeof candidate !== "object") return false;
        return knownCandidateKinds.has(
          String((candidate as Record<string, unknown>).kind),
        );
      },
    )
    .map((candidate) => ({
      ...normalizeCandidateRegion(candidate),
      evidence: Array.isArray(candidate.evidence)
        ? candidate.evidence.filter(
            (item) =>
              item != null &&
              typeof item === "object" &&
              knownLayerIds.has(String((item as { layer_id?: unknown }).layer_id)),
          )
        : [],
    }))
    .filter((candidate) => candidate.evidence.length > 0);
  return MapCandidateLocationSchema.array().parse(sanitized);
}

function parseSummary(row: MapAssetEnrichmentRow): MapEnrichmentSummary {
  return MapEnrichmentSummarySchema.parse(
    parseJson<MapEnrichmentSummary>(row.summary_json, {
      provider: "overture",
      provider_release: row.provider_release,
      computed_at: row.computed_at,
    }),
  );
}

function parseWarnings(row: MapAssetEnrichmentRow): string[] {
  return parseJson<string[]>(row.warnings_json, []).filter(
    (warning): warning is string => typeof warning === "string",
  );
}

/**
 * Pure transformation: combine a DB row's small metadata with the two
 * already-fetched S3 JSON strings into a validated `MapAssetEnrichmentSnapshot`.
 * Kept as a separate function so unit tests can exercise the sanitization /
 * Zod-parsing logic without mocking S3 reads.
 */
export function mapAssetEnrichmentFromRow(
  row: MapAssetEnrichmentRow,
  overlayPayloadJson: string,
  candidateLocationsJson: string,
): MapAssetEnrichmentSnapshot {
  return MapAssetEnrichmentSnapshotSchema.parse({
    map_asset_id: row.map_asset_id,
    provider: row.provider,
    provider_release: row.provider_release,
    computed_at: row.computed_at,
    summary: parseSummary(row),
    overlay_payload: parseAndSanitizeOverlay(overlayPayloadJson),
    candidate_locations: parseAndSanitizeCandidates(candidateLocationsJson),
    warnings: parseWarnings(row),
  });
}

/**
 * Returned by `getMapAssetEnrichmentManifest` and the GET /enrichment route.
 * Server-internal fields (raw bucket + key, snapshot rehydrated from S3) live
 * in `getMapAssetEnrichmentById`; the manifest is the client-facing wire
 * shape and replaces the in-row JSONB blobs with presigned S3 GET URLs.
 */
export type MapAssetEnrichmentManifestInternal = MapAssetEnrichmentManifest;

/**
 * Lightweight read: row metadata + presigned URLs for the two S3 blobs.
 * Used by the GET /enrichment route to keep responses small (<1 KB) and
 * lets the client parallel-fetch the heavy payloads directly from S3.
 *
 * Returns `null` when the snapshot row is missing OR when the S3 URI columns
 * are NULL (legacy rows written before the 2026-05-11 migration). The caller
 * surfaces this as 404 and the user is expected to re-run enrichment to
 * repopulate.
 */
export async function getMapAssetEnrichmentManifest(
  mapAssetId: string,
): Promise<MapAssetEnrichmentManifest | null> {
  const row = await queryOne<MapAssetEnrichmentRow>(ENRICHMENT_ROW_SELECT, {
    map_asset_id: mapAssetId,
  });
  if (!row) return null;
  if (
    !row.overlay_geojson_s3_bucket ||
    !row.overlay_geojson_s3_key ||
    !row.candidate_locations_s3_bucket ||
    !row.candidate_locations_s3_key
  ) {
    return null;
  }
  // Rewrite a stored source-bucket name to the current env's bucket when a
  // staging/prod DB was promoted from dev. Without this, presigned URLs sign
  // requests against the wrong bucket and the client fetch fails with
  // AccessDenied even though the key is valid under the env-scoped bucket.
  // Mirrors normalizeMapArtifactBucket usage on map_asset_artifacts reads.
  const overlayBucket = normalizeMapArtifactBucket(row.overlay_geojson_s3_bucket);
  const candidatesBucket = normalizeMapArtifactBucket(row.candidate_locations_s3_bucket);
  const [overlayUrl, candidatesUrl] = await Promise.all([
    getBrowserAssetUrl({
      bucket: overlayBucket,
      key: row.overlay_geojson_s3_key,
      allowedPrefix: `maps/${mapAssetId}/`,
    }),
    getBrowserAssetUrl({
      bucket: candidatesBucket,
      key: row.candidate_locations_s3_key,
      allowedPrefix: `maps/${mapAssetId}/`,
    }),
  ]);
  return {
    map_asset_id: row.map_asset_id,
    provider: parseSummary(row).provider,
    provider_release: row.provider_release,
    computed_at: row.computed_at,
    summary: parseSummary(row),
    warnings: parseWarnings(row),
    overlay_payload_url: overlayUrl,
    candidate_locations_url: candidatesUrl,
  };
}

/**
 * Full-hydrated snapshot. Fetches the lightweight metadata row from Aurora
 * and the two heavy JSON blobs (overlay payload + candidate locations) from
 * S3 in parallel, then reassembles the canonical `MapAssetEnrichmentSnapshot`
 * shape. This is the path used by every server-side consumer that needs the
 * actual feature data (bridged-map, search-index builder, search-service).
 *
 * Returns `null` when the row is missing OR when the S3 URI columns are NULL
 * (legacy snapshot from before the 2026-05-11 migration). Server callers can
 * treat that the same as "no enrichment yet".
 */
export async function getMapAssetEnrichmentById(
  mapAssetId: string,
): Promise<MapAssetEnrichmentSnapshot | null> {
  const row = await queryOne<MapAssetEnrichmentRow>(ENRICHMENT_ROW_SELECT, {
    map_asset_id: mapAssetId,
  });
  if (!row) return null;
  if (
    !row.overlay_geojson_s3_bucket ||
    !row.overlay_geojson_s3_key ||
    !row.candidate_locations_s3_bucket ||
    !row.candidate_locations_s3_key
  ) {
    return null;
  }

  // Same env-bucket rewrite as the manifest path — see the comment there.
  const overlayBucket = normalizeMapArtifactBucket(row.overlay_geojson_s3_bucket);
  const candidatesBucket = normalizeMapArtifactBucket(row.candidate_locations_s3_bucket);
  const [overlayRaw, candidatesRaw] = await Promise.all([
    getS3ObjectUtf8(overlayBucket, row.overlay_geojson_s3_key),
    getS3ObjectUtf8(candidatesBucket, row.candidate_locations_s3_key),
  ]);
  return mapAssetEnrichmentFromRow(row, overlayRaw, candidatesRaw);
}

/**
 * Fetch the cached road segments saved with the most recent 3rd-party
 * enrichment snapshot. Returns `null` when no snapshot exists, when the
 * snapshot pre-dates road segment persistence (migration 0059), or when the
 * stored JSON is unparseable. An empty array means the snapshot exists but
 * Overture returned no segments — this is a valid, distinct state from "no
 * snapshot yet".
 *
 * Note the literal SQL `NULL` is projected by `::text` as the string
 * `"null"`. We detect that explicitly and distinguish it from a parseable
 * empty array so the street-name-resolution Lambda can decide between
 * "nothing to resolve" and "snapshot missing, tell the user".
 */
export async function getMapAssetRoadSegments(
  mapAssetId: string,
): Promise<RoadSegmentForMatching[] | null> {
  const row = await queryOne<{ road_segments_json: string | null }>(
    `
      SELECT road_segments_json::text AS road_segments_json
      FROM map_asset_enrichments
      WHERE map_asset_id = :map_asset_id
      LIMIT 1
    `,
    { map_asset_id: mapAssetId },
  );

  if (!row) return null;
  const raw = row.road_segments_json;
  if (raw == null || raw === "" || raw === "null") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as RoadSegmentForMatching[]) : null;
  } catch {
    return null;
  }
}

/**
 * Web-side mirror of the Lambda writer. Uploads the overlay + candidate
 * blobs to S3 and then writes the row metadata + URIs to Aurora. Used by
 * unit tests and any web-initiated rewrite paths; the production writer is
 * `infra/lambdas/map-third-party-enrichment/src/persistence.ts`.
 */
export async function upsertMapAssetEnrichment(
  snapshot: MapAssetEnrichmentSnapshot,
  roadSegments?: RoadSegmentForMatching[],
): Promise<void> {
  const bucket = S3_BUCKET;
  const overlayKey = `maps/${snapshot.map_asset_id}/enrichment/overlay-payload.json`;
  const candidatesKey = `maps/${snapshot.map_asset_id}/enrichment/candidate-locations.json`;

  await Promise.all([
    putS3ObjectUtf8Gzipped(bucket, overlayKey, JSON.stringify(snapshot.overlay_payload)),
    putS3ObjectUtf8Gzipped(bucket, candidatesKey, JSON.stringify(snapshot.candidate_locations)),
  ]);

  await execute(
    `
      INSERT INTO map_asset_enrichments (
        map_asset_id,
        provider,
        provider_release,
        computed_at,
        summary_json,
        warnings_json,
        road_segments_json,
        overlay_geojson_s3_bucket,
        overlay_geojson_s3_key,
        candidate_locations_s3_bucket,
        candidate_locations_s3_key,
        updated_at
      )
      VALUES (
        :map_asset_id,
        :provider,
        :provider_release,
        CAST(NULLIF(:computed_at, '') AS TIMESTAMPTZ),
        CAST(:summary_json AS JSONB),
        CAST(:warnings_json AS JSONB),
        CAST(:road_segments_json AS JSONB),
        :overlay_geojson_s3_bucket,
        :overlay_geojson_s3_key,
        :candidate_locations_s3_bucket,
        :candidate_locations_s3_key,
        NOW()
      )
      ON CONFLICT (map_asset_id)
      DO UPDATE SET
        provider = EXCLUDED.provider,
        provider_release = EXCLUDED.provider_release,
        computed_at = EXCLUDED.computed_at,
        summary_json = EXCLUDED.summary_json,
        warnings_json = EXCLUDED.warnings_json,
        road_segments_json = COALESCE(EXCLUDED.road_segments_json, map_asset_enrichments.road_segments_json),
        overlay_geojson_s3_bucket = EXCLUDED.overlay_geojson_s3_bucket,
        overlay_geojson_s3_key = EXCLUDED.overlay_geojson_s3_key,
        candidate_locations_s3_bucket = EXCLUDED.candidate_locations_s3_bucket,
        candidate_locations_s3_key = EXCLUDED.candidate_locations_s3_key,
        updated_at = NOW()
    `,
    {
      map_asset_id: snapshot.map_asset_id,
      provider: snapshot.provider,
      provider_release: snapshot.provider_release,
      computed_at: snapshot.computed_at,
      summary_json: snapshot.summary,
      warnings_json: snapshot.warnings,
      road_segments_json: roadSegments ?? null,
      overlay_geojson_s3_bucket: bucket,
      overlay_geojson_s3_key: overlayKey,
      candidate_locations_s3_bucket: bucket,
      candidate_locations_s3_key: candidatesKey,
    },
  );
}
