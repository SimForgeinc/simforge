import { getPresignedGetUrl } from "@/app/lib/s3/s3-presign";
import { type NextRequest, NextResponse } from "next/server";
import {
  AssetUrlServiceError,
  normalizeAssetKey,
} from "@/app/lib/assets/asset-url-service";
import {
  getScenarioMapBrowserAsset,
  type ScenarioMapBrowserAsset,
} from "@/app/lib/scenario/document-store";
import { requireScenarioContext } from "@/app/lib/scenario/http";
import { simforgeEnv } from "@/lib/compat-env";
import { objectRedirect } from "@/app/lib/s3/local-object-redirect";

type Context = {
  params: Promise<{ mapVersionId: string; assetPath: string[] }>;
};

const DEFAULT_MAX_ASSET_BYTES = 512 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 60 * 60;
const DEV_REDIRECT_CACHE_SECONDS = 50 * 60;

export function browserAssetRedirectCacheControl(nodeEnv = process.env.NODE_ENV) {
  // Development assets are immutable and the redirect target remains valid
  // for one hour. Reusing it for fifty minutes lets the browser reuse the S3
  // response cache without risking an expired signature. Shared environments
  // retain the authenticated no-store boundary.
  return nodeEnv === "development"
    ? `private, max-age=${DEV_REDIRECT_CACHE_SECONDS}`
    : "private, no-store";
}

function developmentAssetCacheControl(nodeEnv = process.env.NODE_ENV) {
  return nodeEnv === "development"
    ? `private, max-age=${DEV_REDIRECT_CACHE_SECONDS}, immutable`
    : undefined;
}

function maxAssetBytes() {
  const value = Number(simforgeEnv("BROWSER_ASSET_MAX_BYTES") ?? DEFAULT_MAX_ASSET_BYTES);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_ASSET_BYTES;
}

function upstreamStatus(error: unknown) {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (value?.name === "NoSuchKey" || value?.name === "NotFound" || value?.$metadata?.httpStatusCode === 404) return 404;
  if (value?.name === "InvalidRange" || value?.$metadata?.httpStatusCode === 416) return 416;
  return 502;
}

type ResolvedAsset =
  | { kind: "response"; response: NextResponse }
  | { kind: "asset"; asset: ScenarioMapBrowserAsset };

async function resolveAsset(route: Context): Promise<ResolvedAsset> {
  const auth = await requireScenarioContext();
  if (auth.response) return { kind: "response", response: auth.response };
  const { mapVersionId, assetPath } = await route.params;
  const relativePath = normalizeAssetKey(assetPath.join("/"));
  const asset = await getScenarioMapBrowserAsset(auth.context, mapVersionId, relativePath);
  if (!asset) {
    return { kind: "response", response: NextResponse.json({ error: "map_browser_assets_not_found" }, { status: 404 }) };
  }
  normalizeAssetKey(asset.key);
  return { kind: "asset", asset };
}

async function redirectAsset(route: Context, headOnly: boolean): Promise<NextResponse> {
  try {
    const asset = await resolveAsset(route);
    if (asset.kind === "response") return asset.response;
    if (asset.asset.byteLength > maxAssetBytes()) {
      return NextResponse.json({ error: "map_browser_asset_too_large" }, { status: 413 });
    }
    const url = await getPresignedGetUrl(
      asset.asset.key,
      asset.asset.bucket,
      SIGNED_URL_TTL_SECONDS,
    );
    const response = objectRedirect(url, 307);
    response.headers.set("Cache-Control", browserAssetRedirectCacheControl());
    return response;
  } catch (error) {
    if (error instanceof AssetUrlServiceError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    const status = upstreamStatus(error);
    return NextResponse.json({
      error: status === 404 ? "map_browser_asset_not_found"
        : status === 416 ? "asset_range_invalid"
          : "map_browser_asset_unavailable",
    }, { status });
  }
}

/** Resolve the registered immutable object, then let the browser fetch it directly from S3. */
export async function GET(_request: NextRequest, route: Context) {
  return redirectAsset(route, false);
}

export async function HEAD(_request: NextRequest, route: Context) {
  return redirectAsset(route, true);
}
