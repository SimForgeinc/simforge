"use client";

import { useCallback } from "react";
import type { MutableRefObject } from "react";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapAsset } from "@simforge-oss/studio-shared";
import {
  ALL_LAYER_IDS,
  CLICKABLE_LAYER_IDS,
  getExistingLayerIds,
} from "@/app/lib/maps/frontend/map-assets-map-utils";

type UseAssetHoverArgs = {
  assetsRef: MutableRefObject<MapAsset[]>;
  scheduleClearHover: () => void;
  setHoverInfo: (value: { count: number; name?: string } | null) => void;
  setTooltipPosition: (value: { x: number; y: number } | null) => void;
};

export function useAssetHover({
  assetsRef,
  scheduleClearHover,
  setHoverInfo,
  setTooltipPosition,
}: UseAssetHoverArgs) {
  return useCallback(
    (map: MapLibreMap, evt: MapLayerMouseEvent) => {
      const existingIds = getExistingLayerIds(map, ALL_LAYER_IDS);
      if (existingIds.length === 0) {
        scheduleClearHover();
        return;
      }

      let features: ReturnType<MapLibreMap["queryRenderedFeatures"]>;
      try {
        features = map.queryRenderedFeatures(evt.point, { layers: existingIds });
      } catch {
        scheduleClearHover();
        return;
      }

      const feature = features.find(
        (entry) =>
          entry.layer.id === "map-assets-clusters" ||
          entry.layer.id === "map-assets-cluster-count" ||
          entry.layer.id === "map-assets-unclustered",
      );
      const count =
        feature?.properties?.point_count != null
          ? Number(feature.properties.point_count)
          : feature?.properties?.map_asset_id != null
            ? 1
            : undefined;
      if (count == null) {
        scheduleClearHover();
        return;
      }
      const name =
        count === 1 && feature?.properties?.map_asset_id
          ? assetsRef.current.find((asset) => asset.map_asset_id === feature.properties!.map_asset_id)?.name
          : undefined;
      setHoverInfo({ count, name });
      setTooltipPosition({ x: evt.point.x, y: evt.point.y });
    },
    [assetsRef, scheduleClearHover, setHoverInfo, setTooltipPosition],
  );
}

type UseAssetClusterClickArgs = {
  assetsRef: MutableRefObject<MapAsset[]>;
  onSelectAsset?: (id: string | null) => void;
  onSelectFeature?: (payload: [] | never[]) => void;
  setClusterAssets: (assets: MapAsset[] | null) => void;
  setClusterPosition: (position: { x: number; y: number } | null) => void;
};

export function useAssetClusterClick({
  assetsRef,
  onSelectAsset,
  onSelectFeature,
  setClusterAssets,
  setClusterPosition,
}: UseAssetClusterClickArgs) {
  return useCallback(
    async (map: MapLibreMap, evt: MapLayerMouseEvent) => {
      const clickableIds = getExistingLayerIds(map, CLICKABLE_LAYER_IDS);
      if (clickableIds.length === 0) {
        setClusterAssets(null);
        setClusterPosition(null);
        return false;
      }

      let features: ReturnType<MapLibreMap["queryRenderedFeatures"]>;
      try {
        features = map.queryRenderedFeatures(evt.point, { layers: clickableIds });
      } catch {
        return false;
      }

      const feature = features[0];
      if (!feature) {
        setClusterAssets(null);
        setClusterPosition(null);
        onSelectFeature?.([]);
        return false;
      }

      const isCluster = feature.properties?.point_count != null;
      if (isCluster) {
        const clusterId = feature.properties.cluster_id as number;
        const source = map.getSource("map-assets-points") as import("maplibre-gl").GeoJSONSource;
        if (!source?.getClusterLeaves) return false;
        const leaves = await source.getClusterLeaves(clusterId, 500, 0);
        const ids = leaves
          .map((leaf) => leaf.properties?.map_asset_id as string | undefined)
          .filter(Boolean);
        const found = ids
          .map((id) => assetsRef.current.find((asset) => asset.map_asset_id === id))
          .filter((asset): asset is MapAsset => asset != null);
        if (found.length === 0) return false;
        if (found.length === 1) {
          onSelectAsset?.(found[0]!.map_asset_id);
          setClusterAssets(null);
          setClusterPosition(null);
        } else {
          setClusterAssets(found);
          setClusterPosition({ x: evt.point.x, y: evt.point.y });
        }
        return true;
      }

      const mapAssetId = feature.properties?.map_asset_id as string | undefined;
      if (!mapAssetId) return false;
      onSelectAsset?.(mapAssetId);
      setClusterAssets(null);
      setClusterPosition(null);
      return true;
    },
    [assetsRef, onSelectAsset, onSelectFeature, setClusterAssets, setClusterPosition],
  );
}
