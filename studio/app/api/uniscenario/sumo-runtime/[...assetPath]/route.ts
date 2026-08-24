import { getPresignedGetUrl } from "@/app/lib/s3/s3-presign";
import { type NextRequest, NextResponse } from "next/server";
import { AssetUrlServiceError, normalizeAssetKey } from "@/app/lib/assets/asset-url-service";
import { SUMO_RUNTIME_VERSION } from "@/app/lib/scenario/sumo-runtime";
import { requireScenarioContext } from "@/app/lib/scenario/http";

type Context = { params: Promise<{ assetPath: string[] }> };

const SIGNED_URL_TTL_SECONDS = 15 * 60;
const IMMUTABLE_ASSET_CACHE_CONTROL = "private, max-age=31536000, immutable";
const SUMO_RUNTIME_S3_PREFIX = `uniscenario/sumo-runtime/${SUMO_RUNTIME_VERSION}/`;
const ASSET_MEDIA_TYPES = {
  "sumo.mjs": "text/javascript",
  "sumo.wasm": "application/wasm",
  "runtime-manifest.json": "application/json",
  "THIRD_PARTY_NOTICES.md": "text/markdown",
} as const;

function artifactBucket() {
  return process.env.UNISCENARIO_ARTIFACT_BUCKET?.trim() || "local-artifacts";
}

function requestedRange(request: NextRequest) {
  const range = request.headers.get("range");
  if (!range) return undefined;
  if (!/^bytes=(?:\d+-\d*|\d*-\d+)$/.test(range)) {
    throw new AssetUrlServiceError("asset_range_invalid", "Only one byte range is supported.", 416);
  }
  return range;
}

function resolveRuntimeAsset(assetPath: string[]) {
  const relativePath = normalizeAssetKey(assetPath.join("/"));
  const prefix = `${SUMO_RUNTIME_VERSION}/`;
  if (!relativePath.startsWith(prefix)) {
    throw new AssetUrlServiceError("sumo_runtime_asset_not_found", "SUMO runtime asset not found.", 404);
  }
  const fileName = relativePath.slice(prefix.length);
  const mediaType = ASSET_MEDIA_TYPES[fileName as keyof typeof ASSET_MEDIA_TYPES];
  if (!mediaType) {
    throw new AssetUrlServiceError("sumo_runtime_asset_not_found", "SUMO runtime asset not found.", 404);
  }
  return {
    key: `${SUMO_RUNTIME_S3_PREFIX}${fileName}`,
    mediaType,
  };
}

async function redirectAsset(request: NextRequest, route: Context, headOnly: boolean) {
  try {
    const auth = await requireScenarioContext();
    if (auth.response) return auth.response;

    const { assetPath } = await route.params;
    const asset = resolveRuntimeAsset(assetPath);
    const bucket = artifactBucket();
    requestedRange(request);
    const url = await getPresignedGetUrl(asset.key, bucket, SIGNED_URL_TTL_SECONDS);
    const response = NextResponse.redirect(url, 307);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    if (error instanceof AssetUrlServiceError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    const detail = error as { name?: string; message?: string };
    console.error("SUMO runtime asset redirect failed", {
      name: detail?.name,
      message: detail?.message,
    });
    return NextResponse.json({ error: "sumo_runtime_asset_unavailable" }, { status: 502 });
  }
}

/** Authenticate the immutable runtime identity, then let the browser fetch its bytes directly from S3. */
export async function GET(request: NextRequest, route: Context) {
  return redirectAsset(request, route, false);
}

export async function HEAD(request: NextRequest, route: Context) {
  return redirectAsset(request, route, true);
}
