import { NextRequest, NextResponse } from "next/server";

import { lngLatToRuntimePoint } from "@/app/lib/editor-map/coordinates";
import { getMapArtifactLocation, getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import { getS3ObjectUtf8 } from "@/app/lib/s3/s3-get-object";
import {
  extractParkingStalls,
  PARKING_STALL_SCHEMA_VERSION,
  type ParkingStallArtifact,
} from "@/app/lib/uniscenario/parking/stalls";
import { MapAssetIdParams } from "@/app/lib/api-schemas";
void MapAssetIdParams;

type RouteContext = { params: Promise<{ mapAssetId: string }> };

/**
 * Extracted stalls, per map asset, for the lifetime of the server process.
 *
 * Reducing them means reading and parsing the whole road-network GeoJSON —
 * 7.9 MB and ~3 s on Belmont — and a published map version's road network is
 * immutable, so the answer cannot change underneath us. Without this every
 * editor mount pays that cost again.
 *
 * Bounded because a workspace can hold many maps and this is per-process
 * memory: ~127 KB of JSON per map on Belmont.
 */
const stallCache = new Map<string, ParkingStallArtifact>();
const STALL_CACHE_LIMIT = 8;
/**
 * Get the placeable parking stalls of a map asset
 * @description Reduces the road-network GeoJSON's `ParkingSpace` polygons to
 *   stall centres, headings, and extents in the editor scene frame. Di Rosa's
 *   full GeoJSON is 7.9 MB; its 859 stalls are ~28 KiB gzipped, so the editor
 *   fetches this instead of the whole road network to place parked cars.
 * @pathParams MapAssetIdParams
 * @response 200
 * @add 404
 * @responseSet common
 * @tag Map assets
 * @openapi
 */
export async function GET(_req: NextRequest, { params }: RouteContext) {
  const { mapAssetId } = await params;

  const cached = stallCache.get(mapAssetId);
  if (cached) {
    return NextResponse.json(cached, {
      headers: { "Cache-Control": "private, max-age=3600", "X-Parking-Stalls-Cache": "hit" },
    });
  }

  const [asset, location] = await Promise.all([
    getMapAssetByIdFromDb(mapAssetId),
    getMapArtifactLocation(mapAssetId, "geojson"),
  ]);

  if (!asset) {
    return NextResponse.json({ error: `Unknown map asset: ${mapAssetId}` }, { status: 404 });
  }
  if (!location) {
    return NextResponse.json(
      { error: "No road-network GeoJSON for this map asset, so it has no parking stalls." },
      { status: 404 },
    );
  }
  // Without a projection every stall would land at the scene origin, which is
  // worse than reporting that the map cannot answer the question.
  if (!asset.map_coordinate_ref) {
    return NextResponse.json(
      { error: "Map asset has no coordinate reference, so stall positions cannot be projected." },
      { status: 409 },
    );
  }

  let geojsonText: string;
  try {
    geojsonText = await getS3ObjectUtf8(location.bucket, location.key);
  } catch (error) {
    console.error("parking-stalls geojson read failed:", error);
    return NextResponse.json({ error: "Failed to read the road-network GeoJSON" }, { status: 502 });
  }

  let geojson: unknown;
  try {
    geojson = JSON.parse(geojsonText);
  } catch {
    return NextResponse.json({ error: "Road-network GeoJSON is not valid JSON" }, { status: 502 });
  }

  const { stalls, skipped } = extractParkingStalls(geojson, (lng, lat) =>
    lngLatToRuntimePoint(lng, lat, asset),
  );

  const body: ParkingStallArtifact = {
    schemaVersion: PARKING_STALL_SCHEMA_VERSION,
    mapAssetId,
    stalls,
    skipped,
  };

  if (stallCache.size >= STALL_CACHE_LIMIT) {
    // Oldest insertion first — Map preserves it, and any eviction order is fine
    // for a cache whose entries are all equally valid.
    const oldest = stallCache.keys().next();
    if (!oldest.done) stallCache.delete(oldest.value);
  }
  stallCache.set(mapAssetId, body);

  return NextResponse.json(body, {
    headers: {
      // The road-network GeoJSON of a published map version is immutable, so the
      // derived stall set is too.
      "Cache-Control": "private, max-age=3600",
      "X-Parking-Stalls-Cache": "miss",
    },
  });
}
