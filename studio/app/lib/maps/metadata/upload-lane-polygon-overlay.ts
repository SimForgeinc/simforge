/**
 * Upload a lane-polygon overlay GeoJSON to S3 and register it as a map artifact.
 *
 * Mirrors `upload-signal-overlay.ts`: the lane polygons are an auto-generated
 * sidecar derived from the XODR during Phase 1 metadata population, stored
 * under the `lane_polygons_geojson` artifact type and served via the
 * `/api/map-assets/{id}/lane-polygons-geojson` route.
 */
import { createHash } from "node:crypto";
import { putS3ObjectUtf8Gzipped } from "@/app/lib/s3/s3-put-object";
import { execute } from "@/app/lib/db/data-api";
import type { LanePolygonFeatureCollection } from "./lane-polygons";

import { S3_BUCKET } from "@/app/lib/s3/s3-config";

const BUCKET = S3_BUCKET;
const MAPS_PREFIX = "maps/";

function artifactRowId(mapAssetId: string, key: string): string {
  return createHash("sha256")
    .update(`${mapAssetId}:${key}`)
    .digest("hex")
    .slice(0, 32);
}

/** Upload a lane-polygon overlay GeoJSON to S3 and register it as a map asset artifact. */
export async function uploadAndRegisterLanePolygonOverlay(
  mapAssetId: string,
  lanePolygons: LanePolygonFeatureCollection,
): Promise<{ key: string; featureCount: number }> {
  const json = JSON.stringify(lanePolygons);
  const sha256 = createHash("sha256").update(json).digest("hex");
  const key = `${MAPS_PREFIX}${mapAssetId}/${mapAssetId}.lane-polygons.geojson`;

  await putS3ObjectUtf8Gzipped(BUCKET, key, json, "application/geo+json");

  await execute(
    `
      INSERT INTO map_asset_artifacts (
        id, map_asset_id, artifact_type, s3_bucket, s3_key, checksum_sha256, label, size_bytes, sort_order
      )
      VALUES (
        :id, :map_asset_id, :artifact_type, :s3_bucket, :s3_key, :checksum_sha256, :label, :size_bytes, :sort_order
      )
      ON CONFLICT (map_asset_id, s3_bucket, s3_key)
      DO UPDATE SET
        artifact_type = EXCLUDED.artifact_type,
        checksum_sha256 = EXCLUDED.checksum_sha256,
        label = EXCLUDED.label,
        size_bytes = EXCLUDED.size_bytes,
        sort_order = EXCLUDED.sort_order
    `,
    {
      id: artifactRowId(mapAssetId, key),
      map_asset_id: mapAssetId,
      artifact_type: "lane_polygons_geojson",
      s3_bucket: BUCKET,
      s3_key: key,
      checksum_sha256: sha256,
      label: "Lane polygons overlay (auto-generated from XODR)",
      size_bytes: Buffer.byteLength(json, "utf8"),
      sort_order: 98,
    },
  );

  return { key, featureCount: lanePolygons.features.length };
}
