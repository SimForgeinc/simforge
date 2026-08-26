import { useCallback, useEffect, useRef } from "react";
import type { MapAsset } from "@simforge-oss/studio-shared";
import type { Map as MapLibreMap } from "maplibre-gl";
import { assetBounds } from "@/app/lib/maps/frontend/map-assets-map-utils";
import { registerMapIcons } from "../map-icons";

/**
 * How close a `focusBounds` fit may zoom. Bounds normally decide the zoom; this
 * only bites on bounds smaller than the viewport can show at this level, i.e.
 * a handful of metres.
 */
const DEFAULT_FOCUS_MAX_ZOOM = 18;

type UseMapViewportControllerArgs = {
  assets: MapAsset[];
  allBounds: [[number, number], [number, number]] | null;
  selectedAssetId: string | null | undefined;
  focusBounds: [[number, number], [number, number]] | null;
  /**
   * Raise the ceiling for THIS fit. The scenario editor frames a lone starter
   * car, which at zoom 18 is ~10 px in a 450 m-wide view — the caller that
   * knows it is framing something car-sized asks to go closer.
   */
  focusMaxZoom?: number;
  selectedCandidateBounds: [[number, number], [number, number]] | null;
  /**
   * Called once the map exists, WITH the instance. The argument is optional to
   * callers — most only want the timing — but the scenario editor's guided
   * tutorial needs the handle to move the camera to whatever a step is talking
   * about, and this is the one place that reliably has it.
   */
  onMapReady?: (map: MapLibreMap) => void;
  onSelectAsset?: (id: string | null) => void;
};

export function useMapViewportController({
  assets,
  allBounds,
  selectedAssetId,
  focusBounds,
  focusMaxZoom,
  selectedCandidateBounds,
  onMapReady,
  onSelectAsset,
}: UseMapViewportControllerArgs) {
  const mapRef = useRef<MapLibreMap | null>(null);
  const assetsRef = useRef(assets);
  const selectedAssetIdRef = useRef(selectedAssetId);
  assetsRef.current = assets;
  selectedAssetIdRef.current = selectedAssetId;

  const fitAll = useCallback(() => {
    if (!mapRef.current || !allBounds) return;
    mapRef.current.fitBounds(allBounds, { padding: 48, maxZoom: 14, duration: 600 });
  }, [allBounds]);

  const fitToBounds = useCallback(
    (
      bounds: [[number, number], [number, number]],
      maxZoom: number = DEFAULT_FOCUS_MAX_ZOOM,
    ) => {
      if (!mapRef.current) return;
      mapRef.current.fitBounds(bounds, {
        padding: 110,
        maxZoom,
        duration: 700,
      });
    },
    [],
  );

  const fitToAsset = useCallback((assetId: string) => {
    const asset = assetsRef.current.find((entry) => entry.map_asset_id === assetId);
    if (!asset || !mapRef.current) return;
    mapRef.current.fitBounds(assetBounds(asset), { padding: 80, maxZoom: 16, duration: 800 });
  }, []);

  const onMapLoad = useCallback(
    (evt: { target: MapLibreMap }) => {
      mapRef.current = evt.target;
      registerMapIcons(evt.target);
      onMapReady?.(evt.target);
      if (focusBounds) {
        fitToBounds(focusBounds, focusMaxZoom);
      } else if (selectedCandidateBounds) {
        fitToBounds(selectedCandidateBounds);
      } else if (selectedAssetIdRef.current) {
        fitToAsset(selectedAssetIdRef.current);
      } else {
        fitAll();
      }
    },
    [
      fitAll,
      fitToAsset,
      fitToBounds,
      focusBounds,
      focusMaxZoom,
      onMapReady,
      selectedCandidateBounds,
    ],
  );

  const prevSelectedAssetIdRef = useRef(selectedAssetId);
  useEffect(() => {
    if (prevSelectedAssetIdRef.current === selectedAssetId) return;
    prevSelectedAssetIdRef.current = selectedAssetId;
    if (selectedAssetId) {
      fitToAsset(selectedAssetId);
    } else {
      fitAll();
    }
  }, [fitAll, fitToAsset, selectedAssetId]);

  useEffect(() => {
    if (!focusBounds || !mapRef.current) return;
    fitToBounds(focusBounds, focusMaxZoom);
  }, [fitToBounds, focusBounds, focusMaxZoom]);

  useEffect(() => {
    if (focusBounds || !selectedCandidateBounds || !mapRef.current) return;
    fitToBounds(selectedCandidateBounds);
  }, [fitToBounds, focusBounds, selectedCandidateBounds]);

  const handleResetView = useCallback(() => {
    fitAll();
    onSelectAsset?.(null);
  }, [fitAll, onSelectAsset]);

  return {
    mapRef,
    fitAll,
    onMapLoad,
    handleResetView,
  };
}
