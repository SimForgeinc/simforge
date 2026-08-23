import { NextRequest, NextResponse } from "next/server";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { getPresignedPutUrl } from "@/app/lib/s3/s3-presign";
import { contentTypeForExtension } from "@/app/lib/s3/content-type-map";
import { MapAssetIdParams, Upload3dUrlsBody, Upload3dUrlsResponse } from "@/app/lib/api-schemas";
void MapAssetIdParams; void Upload3dUrlsBody; void Upload3dUrlsResponse;

type Params = { params: Promise<{ mapAssetId: string }> };

/**
 * Generate presigned PUT URLs for uploading a folder of 3D tile assets.
 *
 * @description Accepts a list of files with relative paths (from a folder
 * selection via `<input webkitdirectory>`). Returns presigned S3 PUT URLs
 * that preserve the folder structure under `maps/{mapAssetId}/3d/`.
 * @pathParams MapAssetIdParams
 * @body Upload3dUrlsBody
 * @response 200:Upload3dUrlsResponse
 * @responseSet common
 * @tag Map assets
 * @openapi
 */
export async function POST(request: NextRequest, { params }: Params) {
  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  try {
    const { mapAssetId } = await params;
    const body = await request.json();
    const files = body.files as
      | Array<{ id: string; relativePath: string; contentType?: string }>
      | undefined;

    if (!mapAssetId || !Array.isArray(files) || files.length === 0) {
      return NextResponse.json(
        { error: "Missing required fields: mapAssetId and non-empty files array" },
        { status: 400 },
      );
    }

    // Validate that manifest.json is present
    const hasManifest = files.some(
      (f) => f.relativePath === "manifest.json",
    );
    if (!hasManifest) {
      return NextResponse.json(
        { error: "Selected folder must contain a manifest.json file" },
        { status: 400 },
      );
    }

    const prefix = `maps/${mapAssetId}/3d/`;
    const uploads: { id: string; url: string; key: string; contentType: string }[] = [];

    for (const f of files) {
      const id = String(f.id ?? "").trim();
      const relativePath = String(f.relativePath ?? "").trim();
      if (!relativePath) continue;

      // Prevent path traversal
      if (relativePath.includes("..") || relativePath.startsWith("/")) {
        return NextResponse.json(
          { error: `Invalid relative path: ${relativePath}` },
          { status: 400 },
        );
      }

      const key = `${prefix}${relativePath}`;

      // Double-check the key is under the expected prefix
      if (!key.startsWith(prefix)) {
        return NextResponse.json(
          { error: "Invalid key generated" },
          { status: 400 },
        );
      }

      const contentType =
        (f.contentType as string | undefined) ||
        contentTypeForExtension(relativePath);

      const url = await getPresignedPutUrl(key, contentType);
      uploads.push({ id, url, key, contentType });
    }

    if (uploads.length === 0) {
      return NextResponse.json(
        { error: "No valid file entries" },
        { status: 400 },
      );
    }

    return NextResponse.json({ uploads });
  } catch (e) {
    const err = e as { name?: string };
    if (
      err?.name === "CredentialsProviderError" ||
      String(e).includes("Could not load credentials")
    ) {
      return NextResponse.json(
        {
          error: "S3 credentials not configured",
          detail:
            "Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and optionally AWS_REGION) in your environment or .env.local.",
        },
        { status: 503 },
      );
    }
    console.error("map-assets [mapAssetId] upload-3d-urls error:", e);
    return NextResponse.json(
      { error: "Failed to generate 3D upload URLs" },
      { status: 500 },
    );
  }
}
