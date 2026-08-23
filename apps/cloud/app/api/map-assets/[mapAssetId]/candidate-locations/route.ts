import { NextRequest, NextResponse } from "next/server";
import {
  getCandidateLocationsByMapAssetId,
  deleteCandidateLocationsByMapAssetId,
} from "@/app/lib/db/map-candidate-location-store";
import { MapAssetIdParams, CandidateLocationsResponse, CandidateLocationsDeleteResponse } from "@/app/lib/api-schemas";
void MapAssetIdParams; void CandidateLocationsResponse; void CandidateLocationsDeleteResponse;

type RouteContext = { params: Promise<{ mapAssetId: string }> };

/**
 * Get candidate locations for a map asset.
 * @description Returns all candidate locations extracted from map artifacts and enrichment.
 *   Optional query params: ?source= and ?tag= for filtering.
 * @pathParams MapAssetIdParams
 * @response 200:CandidateLocationsResponse
 * @responseSet common
 * @tag Map assets
 * @openapi
 */
export async function GET(req: NextRequest, { params }: RouteContext) {
  const { mapAssetId } = await params;
  if (!mapAssetId?.trim()) {
    return NextResponse.json({ error: "Missing mapAssetId" }, { status: 400 });
  }

  const sourceFilter = req.nextUrl.searchParams.get("source");
  const tagFilter = req.nextUrl.searchParams.get("tag");

  let locations = await getCandidateLocationsByMapAssetId(mapAssetId);

  if (sourceFilter) {
    locations = locations.filter((l) => l.source === sourceFilter);
  }
  if (tagFilter) {
    locations = locations.filter((l) => l.tags.includes(tagFilter));
  }

  return NextResponse.json({ mapAssetId, locations, count: locations.length });
}

/**
 * Delete all candidate locations for a map asset.
 * @description Removes all candidate locations (for re-extraction).
 * @pathParams MapAssetIdParams
 * @response 200:CandidateLocationsDeleteResponse
 * @responseSet common
 * @tag Map assets
 * @openapi
 */
export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  const { mapAssetId } = await params;
  if (!mapAssetId?.trim()) {
    return NextResponse.json({ error: "Missing mapAssetId" }, { status: 400 });
  }

  await deleteCandidateLocationsByMapAssetId(mapAssetId);
  return NextResponse.json({ ok: true, mapAssetId });
}
