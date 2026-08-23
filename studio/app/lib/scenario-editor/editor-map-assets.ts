import "server-only";

import type { MapAsset } from "@simcloud/shared";
import {
  acceptedSemanticGraphPublicationKey,
  readAcceptedSemanticGraphPublicationManifest,
} from "@/app/lib/maps/topology/server/semantic-graph-publication-store";
import { type EditorMapAsset } from "@/app/lib/scenario-editor/map-asset-utils";

export async function withEditorRuntimeBundleAvailability(
  assets: MapAsset[],
  options: { verifyBundles?: boolean; runtime?: string | null } = {},
): Promise<EditorMapAsset[]> {
  const runtimeNameForAsset = (asset: MapAsset) =>
    asset.ue5_carla_map_name?.trim() || null;

  if (options.verifyBundles === false) {
    return assets.map((asset): EditorMapAsset => {
      const runtimeName = runtimeNameForAsset(asset);
      return {
        ...asset,
        editor_runtime_bundle_ready: runtimeName ? undefined : false,
        editor_runtime_bundle_key: runtimeName
          ? acceptedSemanticGraphPublicationKey({ mapAssetId: asset.map_asset_id, runtime: "carla_ue5" })
          : null,
        editor_runtime_bundle_error: runtimeName
          ? null
          : "Map has no CARLA runtime name.",
      };
    });
  }

  return Promise.all(
    assets.map(async (asset): Promise<EditorMapAsset> => {
      const runtimeName = runtimeNameForAsset(asset);
      if (!runtimeName) {
        return {
          ...asset,
          editor_runtime_bundle_ready: false,
          editor_runtime_bundle_key: null,
          editor_runtime_bundle_error: "Map has no CARLA runtime name.",
        };
      }

      const key = acceptedSemanticGraphPublicationKey({
        mapAssetId: asset.map_asset_id,
        runtime: "carla_ue5",
      });
      try {
        const manifest = await readAcceptedSemanticGraphPublicationManifest({
          mapAssetId: asset.map_asset_id,
          runtime: "carla_ue5",
        });
        const bundleReady = manifest?.runtimeMapName === runtimeName;
        return {
          ...asset,
          editor_runtime_bundle_ready: bundleReady,
          editor_runtime_bundle_key: key,
          editor_runtime_bundle_error: bundleReady ? null : "Accepted semantic publication missing or mismatched.",
        };
      } catch (error) {
        console.error(
          `Failed to check accepted semantic publication for ${asset.map_asset_id}:`,
          error,
        );
        return {
          ...asset,
          editor_runtime_bundle_ready: false,
          editor_runtime_bundle_key: key,
          editor_runtime_bundle_error: "Unable to verify accepted semantic publication.",
        };
      }
    }),
  );
}
