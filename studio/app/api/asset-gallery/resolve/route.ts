import { NextRequest, NextResponse } from "next/server";
import { ResolveGalleryCatalogIdsInputSchema } from "@/app/lib/asset-gallery/contracts";
import { resolveGalleryCatalogIds } from "@/app/lib/asset-gallery/store";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import {
  readJson,
  requireUniScenarioMutationOrigin,
} from "@/app/lib/uniscenario/http";

export async function POST(request: NextRequest) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;

  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const parsed = ResolveGalleryCatalogIdsInputSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return auth.apply(
      NextResponse.json(
        { error: "invalid_gallery_catalog_ids", details: parsed.error.flatten() },
        { status: 400 },
      ),
    );
  }

  const result = await resolveGalleryCatalogIds(parsed.data.catalogIds);
  return auth.apply(
    NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } }),
  );
}
