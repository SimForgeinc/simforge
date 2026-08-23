import { NextRequest, NextResponse } from "next/server";
import { suggestMapSearch } from "@/app/lib/maps/search/server/map-search-service";
import { MapAssetIdParams, MapSearchSuggestionsQuery, MapSearchSuggestionsResponse } from "@/app/lib/api-schemas";
void MapAssetIdParams; void MapSearchSuggestionsQuery; void MapSearchSuggestionsResponse;

type RouteContext = { params: Promise<{ mapAssetId: string }> };

/**
 * Return autocomplete suggestions for an in-progress map search query.
 * @description Suggestions are drawn from the static alias vocabulary, so
 *   this is an O(1) lookup regardless of map size. The `mapAssetId` path
 *   segment is included to keep the URL shape consistent with other
 *   map-asset-scoped endpoints and to allow per-map sources later.
 * @pathParams MapAssetIdParams
 * @queryParams MapSearchSuggestionsQuery
 * @response 200:MapSearchSuggestionsResponse
 * @responseSet common
 * @tag Map assets
 * @openapi
 */
export async function GET(req: NextRequest, { params }: RouteContext) {
  const { mapAssetId } = await params;
  if (!mapAssetId?.trim()) {
    return NextResponse.json({ error: "Missing mapAssetId" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") ?? "";
  // Use Number() (not parseInt) so malformed values like "3abc" come through
  // as NaN and fail Zod validation, rather than being silently truncated to 3
  // and bypassing the query contract.
  const limitRaw = searchParams.get("limit");
  const parsedLimit = limitRaw != null && limitRaw !== "" ? Number(limitRaw) : undefined;

  const parseResult = MapSearchSuggestionsQuery.safeParse({
    q,
    ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
  });
  if (!parseResult.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", issues: parseResult.error.issues },
      { status: 400 },
    );
  }

  const suggestions = suggestMapSearch({
    mapAssetId,
    query: parseResult.data.q,
    limit: parseResult.data.limit,
  });
  return NextResponse.json({ suggestions });
}
