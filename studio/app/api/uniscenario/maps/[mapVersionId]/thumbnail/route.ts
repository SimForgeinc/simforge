import { getPresignedGetUrl } from "@/app/lib/s3/s3-presign";
import { NextResponse } from "next/server";
import { getScenarioMapThumbnail } from "@/app/lib/scenario/map-thumbnail-store";
import { requireScenarioContext } from "@/app/lib/scenario/http";

type Context = { params: Promise<{ mapVersionId: string }> };

async function redirectThumbnail(route: Context, headOnly: boolean) {
  try {
    const auth = await requireScenarioContext();
    if (auth.response) return auth.response;
    const { mapVersionId } = await route.params;
    const thumbnail = await getScenarioMapThumbnail(auth.context, mapVersionId);
    if (!thumbnail) {
      return NextResponse.json({ error: "map_thumbnail_not_found" }, { status: 404 });
    }
    const url = await getPresignedGetUrl(thumbnail.key, thumbnail.bucket, 60 * 60);
    const response = NextResponse.redirect(url, 307);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch {
    return NextResponse.json(
      { error: "map_thumbnail_unavailable" },
      { status: 502, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

export async function GET(_request: Request, route: Context) {
  return redirectThumbnail(route, false);
}

export async function HEAD(_request: Request, route: Context) {
  return redirectThumbnail(route, true);
}
