import { NextRequest, NextResponse } from "next/server";
import { AssetUrlServiceError, getBrowserAssetUrl } from "@/app/lib/assets/asset-url-service";
import { getMapArtifactLocation } from "@/app/lib/db/map-asset-store";
import { MapAssetIdParams } from "@/app/lib/api-schemas";
void MapAssetIdParams;

type RouteContext = { params: Promise<{ mapAssetId: string }> };

/**
 * Get map asset signals GeoJSON overlay
 * @description Redirects to a presigned S3 URL for the auto-generated signals GeoJSON overlay.
 *   Uses 302 redirect to bypass Amplify's ~6 MB response body size limit.
 * @pathParams MapAssetIdParams
 * @response 302
 * @add 404
 * @responseSet common
 * @tag Map assets
 * @openapi
 */
export async function GET(_req: NextRequest, { params }: RouteContext) {
  const { mapAssetId } = await params;

  const location = await getMapArtifactLocation(mapAssetId, "signals_geojson");
  if (!location) {
    return NextResponse.json(
      { error: "No signals GeoJSON overlay for this map asset. Re-run populate-metadata to generate it." },
      { status: 404 },
    );
  }

  try {
    const url = await getBrowserAssetUrl({
      bucket: location.bucket,
      key: location.key,
      allowedPrefix: `maps/${mapAssetId}/`,
      responseContentType: "application/geo+json; charset=utf-8",
    });
    return NextResponse.redirect(url, 302);
  } catch (e) {
    const err = e as { name?: string };
    if (e instanceof AssetUrlServiceError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    }
    if (err?.name === "CredentialsProviderError" || String(e).includes("Could not load credentials")) {
      return NextResponse.json({ error: "S3 credentials not configured" }, { status: 503 });
    }
    console.error("signals-geojson presign error:", e);
    return NextResponse.json({ error: "Failed to generate signals GeoJSON URL" }, { status: 500 });
  }
}
