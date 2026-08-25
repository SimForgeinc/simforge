import { type NextRequest, NextResponse } from "next/server";
import {
  AssetUrlServiceError,
  assertAssetKeyAllowed,
  getBrowserAssetUrl,
} from "@/app/lib/assets/asset-url-service";
import {
  isLocalBelmontEnabled,
  serveLocalBelmontFile,
} from "@/app/lib/local-belmont-override";
import { S3_BUCKET } from "@/app/lib/s3/s3-config";
import { headS3ObjectInfo } from "@/app/lib/s3/s3-get-object";
import { browserAssetRedirectCacheControl } from "@/app/api/simforge/maps/[mapVersionId]/browser-assets/[...assetPath]/route";

type RouteContext = { params: Promise<{ mapAssetId: string; path: string[] }> };

/**
 * Redirect to a presigned S3 URL for 3D digital twin asset files
 * (GLB tiles, HDR env maps, manifest JSON).
 * Assets are scoped to maps/{mapAssetId}/3d/ — preventing cross-asset access.
 * Uses 302 redirect to bypass Amplify's response body size limit.
 *
 * Dev override: when `USE_LOCAL_BELMONT=1` is set in a non-production
 * environment, the route streams files from `~/city-digital-twin/data/belmont`
 * regardless of `mapAssetId`. The S3-presign path is unchanged when the flag
 * is off. The flag is rejected at module load under production.
 * @tag Map assets
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  const { mapAssetId, path } = await params;

  if (isLocalBelmontEnabled()) {
    return serveLocalBelmontFile(path);
  }

  const allowedPrefix = `maps/${mapAssetId}/3d`;

  try {
    const key = assertAssetKeyAllowed(
      `maps/${mapAssetId}/3d/${path.join("/")}`,
      allowedPrefix,
    );
    if (request.nextUrl.searchParams.get("optional") === "1") {
      const object = await headS3ObjectInfo(S3_BUCKET, key);
      if (!object.exists) return new NextResponse(null, { status: 204 });
    }
    const url = await getBrowserAssetUrl({ key, allowedPrefix });
    const response = NextResponse.redirect(url, 302);
    // Same policy as the scenario browser-assets route: development reuses
    // the redirect for most of the presign TTL so cold loads skip the
    // per-asset presign hop; shared environments keep the authenticated
    // no-store boundary (the map-asset-cache gateway is the caching layer).
    response.headers.set("Cache-Control", browserAssetRedirectCacheControl());
    return response;
  } catch (e) {
    const err = e as { name?: string; message?: string };
    if (e instanceof AssetUrlServiceError) {
      if (e.status === 403) {
        return new NextResponse("Forbidden", { status: 403 });
      }
      return new NextResponse(e.message, { status: e.status });
    }
    if (err?.message?.includes("allowed prefix") || err?.message?.includes("traversal")) {
      return new NextResponse("Forbidden", { status: 403 });
    }
    if (
      err?.name === "CredentialsProviderError" ||
      String(e).includes("Could not load credentials")
    ) {
      return NextResponse.json(
        { error: "S3 credentials not configured" },
        { status: 503 }
      );
    }
    console.error("3d-asset presign error:", e);
    return NextResponse.json(
      { error: "Failed to generate asset URL" },
      { status: 500 }
    );
  }
}
