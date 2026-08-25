import { NextRequest, NextResponse } from "next/server";
import type { MapAssetArtifactType } from "@simforge/studio-shared";
import { UploadUrlBody, UploadUrlResponse } from "@/app/lib/api-schemas";
void UploadUrlBody; void UploadUrlResponse;

import { getPresignedPutUrl } from "@/app/lib/s3/s3-presign";

function artifactTypeFromExtension(filename: string): MapAssetArtifactType | null {
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  if (ext === "geojson" || ext === "json") return "geojson";
  if (ext === "xodr") return "xodr";
  if (ext === "xml") return "rrdata_xml";
  if (ext === "fbx") return "fbx";
  if (ext === "mp4") return "mp4";
  if (ext === "jpg" || ext === "jpeg" || ext === "png" || ext === "webp") return "image";
  return null;
}

function buildS3Key(mapAssetId: string, fileId: string, filename: string): string | null {
  if (fileId === "geojson") return `maps/${mapAssetId}/${mapAssetId}.geojson`;
  if (fileId === "xodr") return `maps/${mapAssetId}/${mapAssetId}.xodr`;
  if (fileId === "rrdata_xml") return `maps/${mapAssetId}/${mapAssetId}_rrdata.xml`;
  if (fileId === "thumbnail") return `maps/${mapAssetId}/${mapAssetId}_thumbnail.png`;

  const extByType: Record<string, string> = {
    geojson: "geojson", xodr: "xodr", rrdata_xml: "rrdata.xml",
    fbx: "fbx", mp4: "mp4",
    image: filename.split(".").pop()?.toLowerCase() ?? "jpg",
  };
  const artifactType = artifactTypeFromExtension(filename);
  if (artifactType == null) return null;
  const ext = extByType[artifactType] ?? filename.split(".").pop()?.toLowerCase() ?? "bin";
  const match = fileId.match(/^artifact-(\d+)$/);
  const index = match ? match[1] : "0";
  return `maps/${mapAssetId}/${mapAssetId}_artifact_${index}.${ext}`;
}

/**
 * Get a presigned PUT URL for a single map asset file upload.
 * @description Like upload-urls but for a single file, without requiring all three artifact types.
 * @body UploadUrlBody
 * @response 200:UploadUrlResponse
 * @responseSet common
 * @tag Map assets
 * @openapi
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const mapAssetId = (body.mapAssetId as string)?.trim();
    const fileId = (body.fileId as string)?.trim();
    const filename = (body.filename as string)?.trim();
    const contentType = (body.contentType as string) || "application/octet-stream";

    if (!mapAssetId || !fileId || !filename) {
      return NextResponse.json(
        { error: "Missing required fields: mapAssetId, fileId, filename" },
        { status: 400 },
      );
    }

    const key = buildS3Key(mapAssetId, fileId, filename);
    if (key == null) {
      return NextResponse.json(
        { error: `Unrecognised file type for "${filename}".` },
        { status: 400 },
      );
    }

    const prefix = `maps/${mapAssetId}/`;
    if (!key.startsWith(prefix)) {
      return NextResponse.json({ error: "Invalid key generated" }, { status: 400 });
    }

    const url = await getPresignedPutUrl(key, contentType);

    return NextResponse.json({ url, key });
  } catch (e) {
    const err = e as { name?: string };
    if (err?.name === "CredentialsProviderError" || String(e).includes("Could not load credentials")) {
      return NextResponse.json(
        {
          error: "S3 credentials not configured",
          detail: "Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and optionally AWS_REGION) in your environment or .env.local.",
        },
        { status: 503 },
      );
    }
    console.error("map-assets upload-url error:", e);
    return NextResponse.json({ error: "Failed to generate upload URL" }, { status: 500 });
  }
}
