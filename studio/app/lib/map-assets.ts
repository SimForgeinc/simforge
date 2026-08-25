import type { MapAsset } from "@simforge/studio-shared";
import { cache } from "react";
import {
  getMapAssetByIdFromDb,
  getMapAssetByRuntimeNameFromDb,
  listMapAssetsFromDb,
  type RuntimeMapAssetIdentity,
} from "./db/map-asset-store";

// Deduplicate DB fetches within a single render pass.
const getAllMapAssets = cache(async (): Promise<MapAsset[]> => {
  return listMapAssetsFromDb();
});

export async function getMapAssetsCatalog(): Promise<MapAsset[]> {
  return getAllMapAssets();
}

/**
 * Get map assets catalog from Aurora.
 */
export async function getMapAssets(): Promise<MapAsset[]> {
  return getAllMapAssets();
}

/**
 * Get a single map asset by ID from Aurora.
 */
export async function getMapAssetById(mapAssetId: string): Promise<MapAsset | undefined> {
  return (await getMapAssetByIdFromDb(mapAssetId)) ?? undefined;
}

export async function getMapAssetByRuntimeName(
  mapName: string,
): Promise<RuntimeMapAssetIdentity | undefined> {
  return (await getMapAssetByRuntimeNameFromDb(mapName)) ?? undefined;
}
