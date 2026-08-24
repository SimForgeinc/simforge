import { NextRequest, NextResponse } from "next/server";
import { CreateGalleryUploadInputSchema } from "@/app/lib/asset-gallery/contracts";
import {
  countRecentUploadsByUser,
  createGalleryAsset,
} from "@/app/lib/asset-gallery/store";
import { presignGalleryAssetUploads } from "@/app/lib/asset-gallery/storage";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { getAppContext } from "@/app/lib/db/app-context";
import {
  readJson,
  requireUniScenarioMutationOrigin,
} from "@/app/lib/uniscenario/http";

const MAX_UPLOADS_PER_HOUR = 40;

export async function POST(request: NextRequest) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;

  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const parsed = CreateGalleryUploadInputSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return auth.apply(
      NextResponse.json(
        { error: "invalid_gallery_upload", details: parsed.error.flatten() },
        { status: 400 },
      ),
    );
  }

  if ((await countRecentUploadsByUser(auth.session.sub)) >= MAX_UPLOADS_PER_HOUR) {
    return auth.apply(
      NextResponse.json(
        { error: "gallery_upload_quota_exceeded" },
        { status: 429, headers: { "Retry-After": "3600" } },
      ),
    );
  }

  const context = getAppContext(auth.session);
  const created = await createGalleryAsset({
    ...parsed.data,
    createdByUserId: context.userId,
    createdByWorkspaceId: context.workspaceId,
  });
  const uploads = await presignGalleryAssetUploads({
    modelKey: created.modelKey,
    modelSha256: parsed.data.glb.sha256,
    thumbnailKey: created.thumbnailKey,
    thumbnailSha256: parsed.data.thumbnail.sha256,
  });

  return auth.apply(
    NextResponse.json(
      {
        assetId: created.assetId,
        versionId: created.versionId,
        catalogId: created.catalogId,
        ...uploads,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    ),
  );
}
