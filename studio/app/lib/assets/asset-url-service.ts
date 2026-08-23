import "server-only";

import { S3_BUCKET } from "@/app/lib/s3/s3-config";
import { getPresignedGetUrl } from "@/app/lib/s3/s3-presign";

const DEFAULT_ASSET_SIGNED_URL_TTL_SECONDS = 3600;

export type AssetDeliveryMode = "cdn" | "s3-presign" | "proxy";

export type BrowserAssetUrlInput = {
  key: string;
  bucket?: string | null;
  allowedPrefix?: string | null;
  responseContentType?: string;
  expiresInSeconds?: number;
};

export class AssetUrlServiceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = "AssetUrlServiceError";
    this.code = code;
    this.status = status;
  }
}


export function getAssetDeliveryMode(env: NodeJS.ProcessEnv = process.env): AssetDeliveryMode {
  const raw = String(env.ASSET_DELIVERY_MODE ?? "s3-presign").trim().toLowerCase();
  if (raw === "cdn" || raw === "s3-presign" || raw === "proxy") return raw;
  throw new AssetUrlServiceError(
    "asset_delivery_mode_invalid",
    `Unsupported ASSET_DELIVERY_MODE '${raw}'.`,
    500,
  );
}

export function getAssetSignedUrlTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ASSET_SIGNED_URL_TTL_SECONDS;
  if (!raw) return DEFAULT_ASSET_SIGNED_URL_TTL_SECONDS;
  const ttl = Number(raw);
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 86400) {
    throw new AssetUrlServiceError(
      "asset_signed_url_ttl_invalid",
      "ASSET_SIGNED_URL_TTL_SECONDS must be between 1 and 86400.",
      500,
    );
  }
  return Math.floor(ttl);
}

export function normalizeAssetKey(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new AssetUrlServiceError("asset_key_missing", "Asset key is required.", 400);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith("/")) {
    throw new AssetUrlServiceError(
      "asset_key_invalid",
      "Asset key must be a relative S3 key.",
      403,
    );
  }
  if (raw.includes("\\") || raw.includes("\0") || raw.includes("//")) {
    throw new AssetUrlServiceError("asset_key_invalid", "Asset key is invalid.", 403);
  }

  let decoded = raw;
  for (let i = 0; i < 2; i++) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break;
    }
  }
  if (decoded.includes("\\") || decoded.includes("\0") || decoded.includes("//")) {
    throw new AssetUrlServiceError("asset_key_invalid", "Asset key is invalid.", 403);
  }

  const rawSegments = raw.split("/");
  const decodedSegments = decoded.split("/");
  if (
    rawSegments.some((segment) => segment === "." || segment === ".." || segment === "") ||
    decodedSegments.some((segment) => segment === "." || segment === ".." || segment === "")
  ) {
    throw new AssetUrlServiceError(
      "asset_key_traversal",
      "Path traversal detected in asset key.",
      403,
    );
  }

  return raw;
}

export function normalizeAssetPrefix(input: string): string {
  const normalized = normalizeAssetKey(input.replace(/\/+$/, ""));
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

export function assertAssetKeyAllowed(key: string, allowedPrefix?: string | null): string {
  const normalizedKey = normalizeAssetKey(key);
  if (!allowedPrefix) return normalizedKey;
  const normalizedPrefix = normalizeAssetPrefix(allowedPrefix);
  if (normalizedKey !== normalizedPrefix.slice(0, -1) && !normalizedKey.startsWith(normalizedPrefix)) {
    throw new AssetUrlServiceError(
      "asset_key_outside_allowed_prefix",
      `Asset key is not within the allowed prefix (${allowedPrefix}).`,
      403,
    );
  }
  return normalizedKey;
}

export async function getBrowserAssetUrl(input: BrowserAssetUrlInput): Promise<string> {
  const key = assertAssetKeyAllowed(input.key, input.allowedPrefix);
  const mode = getAssetDeliveryMode();
  if (mode !== "s3-presign") {
    throw new AssetUrlServiceError(
      "asset_delivery_mode_unavailable",
      `ASSET_DELIVERY_MODE=${mode} is unavailable in the local cloud app.`,
      500,
    );
  }
  return getPresignedGetUrl(
    key,
    input.bucket ?? S3_BUCKET,
    input.expiresInSeconds ?? getAssetSignedUrlTtlSeconds(),
  );
}

