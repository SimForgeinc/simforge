import { NextRequest, NextResponse } from "next/server";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { getMapAssetById } from "@/app/lib/map-assets";
import { getScenarioSummaries } from "@/app/lib/scenarios";
import { listTemplateScenariosForMap } from "@/app/lib/db/scenario-query-store";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ mapAssetId: string }> },
) {
  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const { mapAssetId } = await context.params;
  const asset = await getMapAssetById(mapAssetId);
  if (!asset) {
    return auth.apply(NextResponse.json({ error: "Map asset not found." }, { status: 404 }));
  }

  const [runs, templateScenarios] = await Promise.all([
    getScenarioSummaries(),
    listTemplateScenariosForMap({
      mapAssetId: asset.map_asset_id,
      mapName: asset.carla_map_name ?? asset.name,
      assetName: asset.name,
    }),
  ]);

  return auth.apply(NextResponse.json({ runs, templateScenarios }, {
    headers: { "cache-control": "private, max-age=30" },
  }));
}
