import { NextRequest, NextResponse } from "next/server";
import { GalleryAssetIdSchema } from "@/app/lib/asset-gallery/contracts";
import { countScenariosUsingGalleryAsset } from "@/app/lib/asset-gallery/generation-store";
import { getGalleryAsset } from "@/app/lib/asset-gallery/store";
import { requireRouteSession } from "@/app/lib/auth/route-session";

type AssetUsageRouteContext = { params: Promise<{ assetId: string }> };

/**
 * How many scenarios depend on this asset.
 *
 * Deleting a gallery asset is open to any signed-in user, but scenarios bind to
 * its catalog id, so a delete can break somebody else's work. This answers "how
 * much" immediately before that decision.
 *
 * It is a separate endpoint rather than a field on `GalleryAssetSummary`
 * deliberately: the count requires scanning stored scenario documents, and a
 * gallery page renders 24 summaries per request while needing the count for at
 * most the one asset somebody is about to delete. Putting it on the summary
 * would pay that cost 24 times per page for information almost never read.
 */
export async function GET(request: NextRequest, { params }: AssetUsageRouteContext) {
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

  // Resolving the asset first keeps this from being a probe for which asset ids
  // exist, and yields the catalog slug that scenario documents actually contain.
  const asset = await getGalleryAsset(parsed.data, auth.session.sub);
  if (!asset) {
    return auth.apply(NextResponse.json({ error: "gallery_asset_not_found" }, { status: 404 }));
  }

  const scenarioCount = await countScenariosUsingGalleryAsset(`gallery.${parsed.data}`);
  return auth.apply(
    NextResponse.json(
      { scenarioCount },
      { headers: { "Cache-Control": "private, no-store" } },
    ),
  );
}
