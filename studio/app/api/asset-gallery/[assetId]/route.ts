import { NextRequest, NextResponse } from "next/server";
import {
  GalleryAssetIdSchema,
  RenameGalleryAssetInputSchema,
} from "@/app/lib/asset-gallery/contracts";
import {
  deleteGalleryAsset,
  getGalleryAsset,
  renameGalleryAsset,
} from "@/app/lib/asset-gallery/store";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { readJson, requireScenarioMutationOrigin } from "@/app/lib/scenario/http";

type AssetRouteContext = { params: Promise<{ assetId: string }> };

export async function GET(request: NextRequest, { params }: AssetRouteContext) {
  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const parsed = GalleryAssetIdSchema.safeParse((await params).assetId);
  if (!parsed.success) {
    return auth.apply(
      NextResponse.json(
        { error: "invalid_gallery_asset_id", details: parsed.error.flatten() },
        { status: 400 },
      ),
    );
  }

  const asset = await getGalleryAsset(parsed.data, auth.session.sub);
  if (!asset) {
    return auth.apply(NextResponse.json({ error: "gallery_asset_not_found" }, { status: 404 }));
  }
  return auth.apply(
    NextResponse.json(
      { asset },
      { headers: { "Cache-Control": "private, no-store" } },
    ),
  );
}

export async function PATCH(request: NextRequest, { params }: AssetRouteContext) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;

  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const id = GalleryAssetIdSchema.safeParse((await params).assetId);
  if (!id.success) {
    return auth.apply(
      NextResponse.json(
        { error: "invalid_gallery_asset_id", details: id.error.flatten() },
        { status: 400 },
      ),
    );
  }

  const parsed = RenameGalleryAssetInputSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return auth.apply(
      NextResponse.json(
        { error: "invalid_gallery_asset_rename", details: parsed.error.flatten() },
        { status: 400 },
      ),
    );
  }

  const result = await renameGalleryAsset(
    id.data,
    parsed.data.title,
    auth.session.sub,
  );
  if (result === "not_found") {
    return auth.apply(NextResponse.json({ error: "gallery_asset_not_found" }, { status: 404 }));
  }
  if (result === "forbidden") {
    return auth.apply(NextResponse.json({ error: "gallery_asset_forbidden" }, { status: 403 }));
  }

  const asset = await getGalleryAsset(id.data, auth.session.sub);
  return auth.apply(
    NextResponse.json({ asset }, { headers: { "Cache-Control": "no-store" } }),
  );
}

export async function DELETE(request: NextRequest, { params }: AssetRouteContext) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;

  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const parsed = GalleryAssetIdSchema.safeParse((await params).assetId);
  if (!parsed.success) {
    return auth.apply(
      NextResponse.json(
        { error: "invalid_gallery_asset_id", details: parsed.error.flatten() },
        { status: 400 },
      ),
    );
  }

  const result = await deleteGalleryAsset(parsed.data, auth.session.sub);
  if (result === "not_found") {
    return auth.apply(NextResponse.json({ error: "gallery_asset_not_found" }, { status: 404 }));
  }
  return auth.apply(new NextResponse(null, { status: 204 }));
}
