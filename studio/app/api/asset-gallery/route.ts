import { NextRequest, NextResponse } from "next/server";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { ListGalleryAssetsQuerySchema } from "@/app/lib/asset-gallery/contracts";
import { InvalidGalleryCursorError, listGalleryAssets } from "@/app/lib/asset-gallery/store";

export async function GET(request: NextRequest) {
  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const parsed = ListGalleryAssetsQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return auth.apply(
      NextResponse.json(
        { error: "invalid_gallery_query", details: parsed.error.flatten() },
        { status: 400 },
      ),
    );
  }

  try {
    const result = await listGalleryAssets({
      viewerUserId: auth.session.sub,
      q: parsed.data.q,
      actorClass: parsed.data.actorClass,
      mine: parsed.data.mine === "1",
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    return auth.apply(
      NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } }),
    );
  } catch (error) {
    if (error instanceof InvalidGalleryCursorError) {
      return auth.apply(
        NextResponse.json({ error: "invalid_gallery_cursor" }, { status: 400 }),
      );
    }
    throw error;
  }
}
