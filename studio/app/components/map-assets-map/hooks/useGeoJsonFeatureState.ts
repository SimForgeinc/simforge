"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

type UseGeoJsonFeatureStateArgs = {
  mapRef: RefObject<MapLibreMap | null>;
  selectedGeoJSON: object | null | undefined;
  selectedFeatureId: number | null;
  highlightedFeatureIds: number[];
  /** Subtle-tier ids for spatial-relation neighbors of the focused result. */
  relatedFeatureIds?: number[];
  /**
   * Unique `lane_poly_id` of the clicked filled lane polygon, if any. Highlight
   * is keyed on this (not `selectedFeatureId`/`__mapId`) so only the clicked
   * lane area lights up — several junction connectors can share one lane
   * `__mapId`, so highlighting by __mapId would light them all.
   */
  selectedLanePolygonId?: number | null;
};

// Selection/highlight tiers key off the authored road-network `__mapId`. The
// filled lane polygons do NOT share this id: one lane `__mapId` can map to
// several polygons (junction connectors), so the clicked polygon is highlighted
// separately by its own `lane_poly_id` (see the lane-polygons effect below).
function setSelectedGeoJsonState(
  map: MapLibreMap,
  id: number,
  state: Record<string, boolean>,
) {
  try {
    map.setFeatureState({ source: "selected-geojson", id }, state);
  } catch {
    // source may not be ready yet
  }
}

function setLanePolygonState(map: MapLibreMap, id: number, state: Record<string, boolean>) {
  try {
    if (!map.getSource("lane-polygons")) return;
    map.setFeatureState({ source: "lane-polygons", id }, state);
  } catch {
    // source absent (centerline mode / no sidecar) or not ready
  }
}

export function useGeoJsonFeatureState({
  mapRef,
  selectedGeoJSON,
  selectedFeatureId,
  highlightedFeatureIds,
  relatedFeatureIds = [],
  selectedLanePolygonId = null,
}: UseGeoJsonFeatureStateArgs) {
  const prevSelectedFeatureIdRef = useRef<number | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedGeoJSON) return;
    const prev = prevSelectedFeatureIdRef.current;
    prevSelectedFeatureIdRef.current = selectedFeatureId ?? null;
    if (prev != null) setSelectedGeoJsonState(map, prev, { selected: false });
    if (selectedFeatureId != null) setSelectedGeoJsonState(map, selectedFeatureId, { selected: true });
  }, [mapRef, selectedFeatureId, selectedGeoJSON]);

  // Highlight exactly the clicked filled lane polygon (by its own lane_poly_id).
  const prevLanePolygonIdRef = useRef<number | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const prev = prevLanePolygonIdRef.current;
    prevLanePolygonIdRef.current = selectedLanePolygonId ?? null;
    if (prev != null) setLanePolygonState(map, prev, { selected: false });
    if (selectedLanePolygonId != null) setLanePolygonState(map, selectedLanePolygonId, { selected: true });
  }, [mapRef, selectedLanePolygonId, selectedGeoJSON]);

  const prevHighlightedIdsRef = useRef<number[]>([]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedGeoJSON) return;
    const prev = prevHighlightedIdsRef.current;
    prevHighlightedIdsRef.current = highlightedFeatureIds;
    for (const id of prev) setSelectedGeoJsonState(map, id, { highlighted: false });
    for (const id of highlightedFeatureIds) setSelectedGeoJsonState(map, id, { highlighted: true });
  }, [highlightedFeatureIds, mapRef, selectedGeoJSON]);

  const prevRelatedIdsRef = useRef<number[]>([]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedGeoJSON) return;
    const prev = prevRelatedIdsRef.current;
    prevRelatedIdsRef.current = relatedFeatureIds;
    for (const id of prev) setSelectedGeoJsonState(map, id, { related: false });
    for (const id of relatedFeatureIds) setSelectedGeoJsonState(map, id, { related: true });
  }, [relatedFeatureIds, mapRef, selectedGeoJSON]);
}
