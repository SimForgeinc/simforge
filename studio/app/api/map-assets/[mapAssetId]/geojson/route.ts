import { NextRequest, NextResponse } from "next/server";
import { AssetUrlServiceError, getBrowserAssetUrl } from "@/app/lib/assets/asset-url-service";
import { getMapArtifactLocation } from "@/app/lib/db/map-asset-store";
import { MapAssetIdParams } from "@/app/lib/api-schemas";
import { objectRedirect } from "@/app/lib/s3/local-object-redirect";
void MapAssetIdParams;

type RouteContext = { params: Promise<{ mapAssetId: string }> };

/**
 * Get map asset GeoJSON
 * @description Redirects to a presigned S3 URL for the asset's GeoJSON file.
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

  const location = await getMapArtifactLocation(mapAssetId, "geojson");
  if (!location) {
    return NextResponse.json({ error: "No GeoJSON artifact for this map asset" }, { status: 404 });
  }

  try {
    const url = await getBrowserAssetUrl({
      bucket: location.bucket,
      key: location.key,
      allowedPrefix: `maps/${mapAssetId}/`,
      responseContentType: "application/geo+json; charset=utf-8",
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
    console.error("geojson presign error:", e);
    return NextResponse.json({ error: "Failed to generate GeoJSON URL" }, { status: 500 });
  }
}
