import { Suspense } from "react";
import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import { getMapAssets } from "@/app/lib/map-assets";
import { listScenarioMapDescriptors } from "@/app/lib/scenario/document-store";
import { MapGalleryPageClient } from "@/app/dashboard/map-assets/catalog/MapGalleryPageClient";
import MapAssetsLoading from "./loading";

export async function MapAssetsContent() {
  await connection();
  // Authenticate before touching Aurora rather than inheriting the gate in
  // `app/dashboard/layout.tsx`. Both catalogs are read only after the page has
  // established the current workspace context.
  const context = await requireAppContext("/dashboard/map-assets");
  const [assets, maps] = await Promise.all([
    getMapAssets(),
    listScenarioMapDescriptors(context),
  ]);

  return (
    <div className="h-full overflow-hidden">
      <MapGalleryPageClient assets={assets} maps={maps} />
    </div>
  );
}

export default function MapAssetsPage() {
  return (
    <Suspense fallback={<MapAssetsLoading />}>
      <MapAssetsContent />
    </Suspense>
  );
}
