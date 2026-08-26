import { NextRequest, NextResponse } from "next/server";
import type { MapAssetArtifactType } from "@simforge-oss/studio-shared";
import { MapAssetIdParams, MediaUploadUrlsBody, MediaUploadUrlsResponse } from "@/app/lib/api-schemas";
void MapAssetIdParams; void MediaUploadUrlsBody; void MediaUploadUrlsResponse;

import { getPresignedPutUrl } from "@/app/lib/s3/s3-presign";

function artifactTypeFromExtension(filename: string): MapAssetArtifactType {
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  if (ext === "mp4") return "mp4";
  if (ext === "jpg" || ext === "jpeg" || ext === "png" || ext === "webp") return "image";
  return "image";
}

function formatTimestamp(d: Date): string {
  const y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${y}${M}${D}-${h}${m}${s}`;
}

/**
 * Get presigned PUT URLs for adding new media (videos/images) to an existing map asset
 * @description Returns presigned S3 PUT URLs so the client can upload large files (e.g. 100+ MB fly-by videos) directly to S3, avoiding request body size limits.
 * @pathParams MapAssetIdParams
 * @body MediaUploadUrlsBody
 * @response 200:MediaUploadUrlsResponse
 * @responseSet common
 * @tag Map assets
 * @openapi
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ mapAssetId: string }> }
) {
  try {
    const { mapAssetId } = await context.params;
    const body = await request.json();
    const files = body.files as Array<{ id: string; filename: string; contentType?: string }> | undefined;

    if (!mapAssetId || !Array.isArray(files) || files.length === 0) {
      return NextResponse.json(
        { error: "Missing required fields: mapAssetId and non-empty files array" },
        { status: 400 }
      );
    }

    const prefix = `maps/${mapAssetId}/`;
    const timestamp = formatTimestamp(new Date());
    const uploads: { id: string; url: string; key: string }[] = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const id = String(f?.id ?? i).trim();
      const filename = String(f?.filename ?? "").trim();
      if (!filename) continue;

      const artifactType = artifactTypeFromExtension(filename);
      const ext = filename.split(".").pop()?.toLowerCase() ?? (artifactType === "mp4" ? "mp4" : "jpg");
      const key = `${prefix}${mapAssetId}-${artifactType}-${timestamp}-${i}.${ext}`;

      if (!key.startsWith(prefix)) {
        return NextResponse.json({ error: "Invalid key generated" }, { status: 400 });
      }

      const contentType = (f?.contentType as string | undefined) || (artifactType === "mp4" ? "video/mp4" : "image/jpeg");
      const url = await getPresignedPutUrl(key, contentType);
      uploads.push({ id, url, key });
    }

    if (uploads.length === 0) {
      return NextResponse.json({ error: "No valid file entries" }, { status: 400 });
    }

    return NextResponse.json({ uploads });
  } catch (e) {
    const err = e as { name?: string };
    if (err?.name === "CredentialsProviderError" || String(e).includes("Could not load credentials")) {
      return NextResponse.json(
        {
          error: "S3 credentials not configured",
          detail: "Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and optionally AWS_REGION) in your environment or .env.local.",
        },
        { status: 503 }
      );
    }
    console.error("map-assets [mapAssetId] upload-urls error:", e);
    return NextResponse.json(
      { error: "Failed to generate upload URLs" },
      { status: 500 }
    );
  }
}
