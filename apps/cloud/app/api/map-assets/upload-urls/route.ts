import { NextRequest, NextResponse } from "next/server";
import type { MapAssetArtifactType } from "@simcloud/shared";
import { UploadUrlsBody, UploadUrlsResponse } from "@/app/lib/api-schemas";
void UploadUrlsBody; void UploadUrlsResponse;

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
  if (fileId === "geojson") {
    return `maps/${mapAssetId}/${mapAssetId}.geojson`;
  }
  if (fileId === "xodr") {
    return `maps/${mapAssetId}/${mapAssetId}.xodr`;
  }
  if (fileId === "rrdata_xml") {
    return `maps/${mapAssetId}/${mapAssetId}_rrdata.xml`;
  }
  if (fileId === "thumbnail") {
    return `maps/${mapAssetId}/${mapAssetId}_thumbnail.png`;
  }

  const extByType: Record<string, string> = {
    geojson: "geojson",
    xodr: "xodr",
    rrdata_xml: "rrdata.xml",
    fbx: "fbx",
    mp4: "mp4",
    image: filename.split(".").pop()?.toLowerCase() ?? "jpg",
  };
  const artifactType = artifactTypeFromExtension(filename);
  if (artifactType == null) {
    return null;
  }
  const ext = extByType[artifactType] ?? filename.split(".").pop()?.toLowerCase() ?? "bin";
  const match = fileId.match(/^artifact-(\d+)$/);
  const index = match ? match[1] : "0";
  return `maps/${mapAssetId}/${mapAssetId}_artifact_${index}.${ext}`;
}

function validateRequiredFileTypes(
  files: Array<{ id: string; filename: string }>,
): { ok: true } | { ok: false; error: string } {
  const types = new Set<MapAssetArtifactType>();
  for (const f of files) {
    const t = artifactTypeFromExtension(f.filename);
    if (t != null) types.add(t);
  }
  if (!types.has("geojson")) {
    return { ok: false, error: "A .geojson (or .json) file is required." };
  }
  if (!types.has("xodr")) {
    return { ok: false, error: "A .xodr (OpenDRIVE) file is required." };
  }
  if (!types.has("rrdata_xml")) {
    return { ok: false, error: "A RoadRunner metadata .xml file is required." };
  }
  return { ok: true };
}

/**
 * Get presigned PUT URLs for map asset file uploads
 * @description Returns presigned S3 PUT URLs so the client can upload files directly to S3, avoiding Amplify's request body size limit (413).
 * @body UploadUrlsBody
 * @response 200:UploadUrlsResponse
 * @responseSet common
 * @tag Map assets
 * @openapi
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const mapAssetId = (body.mapAssetId as string)?.trim();
    const name = (body.name as string)?.trim();
    const files = body.files as Array<{ id: string; filename: string; contentType?: string }> | undefined;

    if (!mapAssetId || !name || !Array.isArray(files) || files.length === 0) {
      return NextResponse.json(
        { error: "Missing required fields: mapAssetId, name, and non-empty files array" },
        { status: 400 }
      );
    }

    const normalized = files
      .map((f) => ({
        id: String(f?.id ?? "").trim(),
        filename: String(f?.filename ?? "").trim(),
        contentType: (f?.contentType as string) || "application/octet-stream",
      }))
      .filter((f) => f.id && f.filename);

    const reqCheck = validateRequiredFileTypes(normalized);
    if (!reqCheck.ok) {
      return NextResponse.json({ error: reqCheck.error }, { status: 400 });
    }

    const prefix = `maps/${mapAssetId}/`;
    const uploads: { id: string; url: string; key: string }[] = [];

    for (const f of normalized) {
      const key = buildS3Key(mapAssetId, f.id, f.filename);
      if (key == null) {
        return NextResponse.json(
          { error: `Unrecognised file type for "${f.filename}". Use geojson, xodr, rrdata xml, fbx, mp4, or an image.` },
          { status: 400 },
        );
      }
      if (!key.startsWith(prefix)) {
        return NextResponse.json({ error: "Invalid key generated" }, { status: 400 });
      }

      const url = await getPresignedPutUrl(key, f.contentType || "application/octet-stream");
      uploads.push({ id: f.id, url, key });
    }

    if (uploads.length === 0) {
      return NextResponse.json({ error: "No valid file entries" }, { status: 400 });
    }

    return NextResponse.json({ uploads, mapAssetId });
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
    console.error("map-assets upload-urls error:", e);
    return NextResponse.json(
      { error: "Failed to generate upload URLs" },
      { status: 500 }
    );
  }
}
