import { NextRequest, NextResponse } from "next/server";
import { AssetUrlServiceError, getBrowserAssetUrl } from "@/app/lib/assets/asset-url-service";
import { MapAssetIdParams, MediaQueryParams } from "@/app/lib/api-schemas";
void MapAssetIdParams;
void MediaQueryParams;

type RouteContext = { params: Promise<{ mapAssetId: string }> };

/**
 * Get presigned URL for map asset media
 * @description Redirects (302) to a presigned S3 URL for the asset's media (mp4/image). Use query param key.
 * @pathParams MapAssetIdParams
 * @params MediaQueryParams
 * @response 302
 * @add 403
 * @responseSet common
 * @tag Map assets
 * @openapi
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  const { mapAssetId } = await params;
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!key) {
    return NextResponse.json({ error: "Missing key query parameter" }, { status: 400 });
  }
  try {
    const url = await getBrowserAssetUrl({ key, allowedPrefix: `maps/${mapAssetId}/` });
    return NextResponse.redirect(url, 302);
  } catch (e) {
    const err = e as Error;
    if (e instanceof AssetUrlServiceError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    }
    if (err.message.includes("not within the allowed prefix")) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    console.error("map-asset media presign error:", e);
    return NextResponse.json({ error: "Failed to generate media URL" }, { status: 500 });
  }
}
