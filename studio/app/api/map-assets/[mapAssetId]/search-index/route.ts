import { NextRequest, NextResponse } from "next/server";
import { AssetUrlServiceError, getBrowserAssetUrl } from "@/app/lib/assets/asset-url-service";
import { getMapArtifactLocation } from "@/app/lib/db/map-asset-store";
import { MapAssetIdParams } from "@/app/lib/api-schemas";
import { objectRedirect } from "@/app/lib/s3/local-object-redirect";
void MapAssetIdParams;

type RouteContext = { params: Promise<{ mapAssetId: string }> };

/**
 * Get map asset search index
 * @description Redirects to a presigned S3 URL for the asset's search-index JSON
 *   sidecar. The artifact is stored gzipped with `Content-Encoding: gzip`, so
 *   browsers and `curl --compressed` decompress transparently.
 * @pathParams MapAssetIdParams
 * @response 302
 * @add 404
 * @responseSet common
 * @tag Map assets
 * @openapi
 */
export async function GET(_req: NextRequest, { params }: RouteContext) {
  const { mapAssetId } = await params;

  const location = await getMapArtifactLocation(mapAssetId, "search_index");
  if (!location) {
    return NextResponse.json(
      { error: "No search_index artifact for this map asset" },
      { status: 404 },
    );
  }

  try {
    const url = await getBrowserAssetUrl({
      bucket: location.bucket,
      key: location.key,
      allowedPrefix: `maps/${mapAssetId}/`,
      responseContentType: "application/json; charset=utf-8",
    });
    return objectRedirect(url, 302);
  } catch (e) {
    const err = e as { name?: string };
    if (e instanceof AssetUrlServiceError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    }
    if (
      err?.name === "CredentialsProviderError" ||
      String(e).includes("Could not load credentials")
    ) {
      return NextResponse.json(
        { error: "S3 credentials not configured" },
        { status: 503 },
      );
    }
    console.error("search-index presign error:", e);
    return NextResponse.json(
      { error: "Failed to generate search index URL" },
      { status: 500 },
    );
  }
}
