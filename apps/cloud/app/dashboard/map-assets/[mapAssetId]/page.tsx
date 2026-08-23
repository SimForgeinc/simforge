import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import { getMapAssetById, getMapAssets } from "@/app/lib/map-assets";
import { getScenarioSummaries } from "@/app/lib/scenarios";
import { listTemplateScenariosForMap } from "@/app/lib/db/scenario-query-store";
import { MapDetailPageClient } from "./MapDetailPageClient";
import MapDetailLoading from "./loading";

type Props = { params: Promise<{ mapAssetId: string }> };

async function MapDetailContent({ params }: Props) {
  await connection();
  // Authenticate before reading, rather than inheriting the gate in
  // `app/dashboard/layout.tsx`. None of the three reads below is a tenancy risk
  // on its own — `map_assets` is a global catalog with no `workspace_id`,
  // `getScenarioSummaries()` scopes itself and fails closed, and
  // `listTemplateScenariosForMap` binds `SYSTEM_GLOBAL_WORKSPACE_ID` and
  // `TEMPLATE_SCENARIOS_DATASET_ID` as constants. This makes the page's own
  // authorization explicit rather than positional.
  await requireAppContext("/dashboard/map-assets");
  const { mapAssetId } = await params;
  const [asset, allAssets, runs] = await Promise.all([
    getMapAssetById(mapAssetId),
    getMapAssets(),
    getScenarioSummaries(),
  ]);

  if (!asset) notFound();

  const templateScenarios = await listTemplateScenariosForMap({
    mapAssetId: asset.map_asset_id,
    mapName: asset.carla_map_name ?? asset.name,
    assetName: asset.name,
  });

  return (
    <div className="h-full overflow-hidden">
      <MapDetailPageClient
        asset={asset}
        allAssets={allAssets}
        runs={runs}
        initialTemplateScenarios={templateScenarios}
      />
    </div>
  );
}

export default function MapDetailPage({ params }: Props) {
  return (
    <Suspense fallback={<MapDetailLoading />}>
      <MapDetailContent params={params} />
    </Suspense>
  );
}
