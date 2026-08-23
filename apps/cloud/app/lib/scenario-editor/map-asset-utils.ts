import type { MapAsset } from "@simcloud/shared";

export type EditorMapAsset = MapAsset & {
  editor_runtime_bundle_ready?: boolean;
  editor_runtime_bundle_key?: string | null;
  editor_runtime_bundle_error?: string | null;
};

export const RUNTIME_MAP_ASSET_ID_PREFIX = "runtime-map-";

export function buildRuntimeMapAssetId(runtimeName: string) {
  return `${RUNTIME_MAP_ASSET_ID_PREFIX}${runtimeName.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

export function isRuntimeMapAssetId(value: string | null | undefined) {
  return Boolean(value?.startsWith(RUNTIME_MAP_ASSET_ID_PREFIX));
}

export function runtimeMapNameFromAssetId(value: string | null | undefined) {
  if (!isRuntimeMapAssetId(value)) return null;
  const name = value!.slice(RUNTIME_MAP_ASSET_ID_PREFIX.length).trim();
  return name || null;
}

export function isWorkerRuntimeMapAsset(
  asset:
    | Pick<EditorMapAsset, "map_asset_id" | "tags" | "map_source">
    | null
    | undefined,
) {
  if (!asset) return false;
  if (isRuntimeMapAssetId(asset.map_asset_id)) return true;
  if (asset.tags?.includes("WORKER_RUNTIME_MAP")) return true;
  return asset.map_source?.tool === "carla-worker-runtime";
}

export function resolveMapAssetRuntimeName(
  asset:
    | Pick<MapAsset, "carla_map_name" | "name">
    | null
    | undefined,
): string | null {
  const name = asset?.carla_map_name?.trim() || asset?.name?.trim() || "";
  return name || null;
}

/**
 * Every map name this asset is known by across runtimes. Cache validation must
 * accept any of them: a bundle fetched for the UE5 runtime reports
 * `ue5_carla_map_name` as its normalized map name while the asset's legacy
 * `carla_map_name` can differ (e.g. San_Ramon_P1_Roads vs San_Ramon_Phase_1_P1),
 * and comparing against a single name permanently misses the cache.
 */
export function resolveMapAssetRuntimeNames(
  asset:
    | Pick<MapAsset, "carla_map_name" | "ue5_carla_map_name" | "name">
    | null
    | undefined,
): string[] {
  const names = [
    asset?.ue5_carla_map_name?.trim(),
    asset?.carla_map_name?.trim(),
    asset?.name?.trim(),
  ].filter((name): name is string => Boolean(name));
  return [...new Set(names)];
}

export function isScenarioEditorMapAsset(
  asset:
    | Pick<MapAsset, "carla_map_name" | "name">
    | null
    | undefined,
): boolean {
  return resolveMapAssetRuntimeName(asset) !== null;
}
