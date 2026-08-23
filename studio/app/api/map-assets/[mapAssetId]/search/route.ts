import { NextRequest, NextResponse } from "next/server";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import { searchMapLocations } from "@/app/lib/maps/search/server/map-search-service";
import { MapAssetIdParams, MapSearchRequestBody, MapSearchResponse } from "@/app/lib/api-schemas";
void MapAssetIdParams; void MapSearchRequestBody; void MapSearchResponse;

type RouteContext = { params: Promise<{ mapAssetId: string }> };

/**
 * Search places and objects within a map asset.
 * @description Runs a free-text query against the map's candidate locations,
 *   road-network junctions/streets, and overlay POIs. Returns the same result
 *   shape used by the in-UI fast path, plus `mapAssetId` and `totalDocuments`.
 * @pathParams MapAssetIdParams
 * @body MapSearchRequestBody
 * @response 200:MapSearchResponse
 * @responseSet common
 * @add 404
 * @tag Map assets
 * @openapi
 */
export async function POST(req: NextRequest, { params }: RouteContext) {
  const { mapAssetId } = await params;
  if (!mapAssetId?.trim()) {
    return NextResponse.json({ error: "Missing mapAssetId" }, { status: 400 });
  }

  const asset = await getMapAssetByIdFromDb(mapAssetId);
  if (!asset) {
    return NextResponse.json({ error: "Map asset not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parseResult = MapSearchRequestBody.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parseResult.error.issues },
      { status: 400 },
    );
  }

  const { query, limit } = parseResult.data;
  const result = await searchMapLocations({ mapAssetId, query, limit });
  return NextResponse.json(result);
}
