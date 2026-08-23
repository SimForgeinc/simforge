import { getPresignedGetUrl } from "@/app/lib/s3/s3-presign";
import { NextResponse } from "next/server";
import { normalizeAssetKey } from "@/app/lib/assets/asset-url-service";
import { getUniScenarioMapBrowserAssets } from "@/app/lib/uniscenario/document-store";
import {
  requireUniScenarioContext,
  requireUniScenarioMutationOrigin,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";

const MAX_REQUESTS = 128;
const SIGNED_URL_TTL_SECONDS = 60 * 60;

type DownloadRequest = {
  mapVersionId: string;
  relativePath: string;
};

function parseRequests(value: unknown): DownloadRequest[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REQUESTS) {
    return null;
  }
  try {
    return value.map((candidate) => {
      if (!candidate || typeof candidate !== "object") throw new Error("invalid");
      const mapVersionId = (candidate as { mapVersionId?: unknown }).mapVersionId;
      const relativePath = (candidate as { relativePath?: unknown }).relativePath;
      if (typeof mapVersionId !== "string" || !mapVersionId.trim()) throw new Error("invalid");
      if (typeof relativePath !== "string") throw new Error("invalid");
      return {
        mapVersionId: mapVersionId.trim(),
        relativePath: normalizeAssetKey(relativePath),
      };
    });
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => null) as { assets?: unknown } | null;
  const requests = parseRequests(body?.assets);
  if (!requests) {
    return NextResponse.json(
      { error: "invalid_cache_download_request" },
      { status: 400 },
    );
  }
  const assets = await getUniScenarioMapBrowserAssets(auth.context, requests);
  const signed = await Promise.all(assets.map(async (asset) => {
    const url = await getPresignedGetUrl(
      asset.key,
      asset.bucket,
      SIGNED_URL_TTL_SECONDS,
    );
    return {
      mapVersionId: asset.mapVersionId,
      relativePath: asset.relativePath,
      url,
    };
  }));
  return NextResponse.json(
    { assets: signed },
    { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
