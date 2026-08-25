"use client";

import type {
  CandidateLocation,
  MapAsset,
  MapAssetEnrichmentSnapshot,
} from "@simforge/studio-shared";
import { candidateLocationBounds } from "./candidate-location-utils";
import { candidateToFocusTarget,
lonLatToScene,
type FocusTarget, } from "@/app/lib/maps/frontend/city-scene-coordinates"
import { GEOJSON_FEATURE_ID_PROP } from "./feature-inspection-types";
import type { MapSearchDocumentGeometryRef } from "../search/map-search-corpus";

export type PlaceRef = MapSearchDocumentGeometryRef;

export interface PlaceHighlightContext {
  candidates: CandidateLocation[];
  roadNetwork: object | null | undefined;
  enrichment: MapAssetEnrichmentSnapshot | null | undefined;
  coordRef: MapAsset["map_coordinate_ref"] | null | undefined;
}

export interface PlaceHighlight {
  /** CandidateLocation id to drive the orange-polygon overlay; null for non-candidate refs. */
  candidateId: string | null;
  /** GeoJSON __mapId values to set feature-state `highlighted` on. */
  highlightedFeatureIds: number[];
  /** Point highlight ring for overlay POIs. */
  overlayCoords: [number, number] | null;
  /** 2D zoom target. */
  bounds: [[number, number], [number, number]] | null;
  /** 3D camera target. */
  focusTarget: FocusTarget | null;
}

const EMPTY_HIGHLIGHT: PlaceHighlight = {
  candidateId: null,
  highlightedFeatureIds: [],
  overlayCoords: null,
  bounds: null,
  focusTarget: null,
};

const DEG2RAD = Math.PI / 180;
const METERS_PER_DEG = 111320;
const MIN_ORBIT_RADIUS = 50;
const MAX_ORBIT_RADIUS = 500;

type GeoJSONFeature = {
  type?: string;
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
  id?: string | number;
};
type GeoJSONFeatureCollection = { type?: string; features?: GeoJSONFeature[] };

function asFeatureCollection(value: unknown): GeoJSONFeatureCollection | null {
  if (!value || typeof value !== "object") return null;
  const fc = value as GeoJSONFeatureCollection;
  if (!Array.isArray(fc.features)) return null;
  return fc;
}

/** Walk a GeoJSON coordinate blob and accumulate a bbox. */
function accumulateBbox(coords: unknown, bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number }): void {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === "number" && typeof coords[1] === "number") {
    const lng = coords[0] as number;
    const lat = coords[1] as number;
    if (lng < bbox.minLng) bbox.minLng = lng;
    if (lng > bbox.maxLng) bbox.maxLng = lng;
    if (lat < bbox.minLat) bbox.minLat = lat;
    if (lat > bbox.maxLat) bbox.maxLat = lat;
    return;
  }
  for (const inner of coords) accumulateBbox(inner, bbox);
}

function geometryBounds(
  geometry: { type?: string; coordinates?: unknown } | null | undefined,
): [[number, number], [number, number]] | null {
  if (!geometry || !geometry.coordinates) return null;
  const bbox = { minLng: Infinity, minLat: Infinity, maxLng: -Infinity, maxLat: -Infinity };
  accumulateBbox(geometry.coordinates, bbox);
  if (!Number.isFinite(bbox.minLng)) return null;
  // Pad a single point so `fitBounds` still produces a meaningful zoom.
  if (bbox.minLng === bbox.maxLng && bbox.minLat === bbox.maxLat) {
    const pad = 0.00015;
    return [
      [bbox.minLng - pad, bbox.minLat - pad],
      [bbox.maxLng + pad, bbox.maxLat + pad],
    ];
  }
  return [
    [bbox.minLng, bbox.minLat],
    [bbox.maxLng, bbox.maxLat],
  ];
}

function unionBounds(
  bounds: Array<[[number, number], [number, number]] | null>,
): [[number, number], [number, number]] | null {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const b of bounds) {
    if (!b) continue;
    if (b[0][0] < minLng) minLng = b[0][0];
    if (b[0][1] < minLat) minLat = b[0][1];
    if (b[1][0] > maxLng) maxLng = b[1][0];
    if (b[1][1] > maxLat) maxLat = b[1][1];
  }
  if (!Number.isFinite(minLng)) return null;
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

function boundsToFocusTarget(
  bounds: [[number, number], [number, number]],
  coordRef: MapAsset["map_coordinate_ref"] | null | undefined,
): FocusTarget | null {
  if (coordRef?.origin_lat == null || coordRef?.origin_lon == null) return null;
  const [[minLng, minLat], [maxLng, maxLat]] = bounds;
  const centerLng = (minLng + maxLng) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const position = lonLatToScene(centerLng, centerLat, coordRef.origin_lon, coordRef.origin_lat, 0);
  const cosLat = Math.cos(coordRef.origin_lat * DEG2RAD);
  const dx = (maxLng - minLng) * METERS_PER_DEG * cosLat;
  const dy = (maxLat - minLat) * METERS_PER_DEG;
  const extent = Math.sqrt(dx * dx + dy * dy);
  const radius = Math.max(MIN_ORBIT_RADIUS, Math.min(MAX_ORBIT_RADIUS, extent * 1.5));
  return { position, radius };
}

function findFeatureByMapId(
  roadNetwork: object | null | undefined,
  mapId: number,
): GeoJSONFeature | null {
  const fc = asFeatureCollection(roadNetwork);
  if (!fc) return null;
  for (const feature of fc.features ?? []) {
    if (feature.properties?.[GEOJSON_FEATURE_ID_PROP] === mapId) return feature;
  }
  return null;
}

function findOverlayFeature(
  enrichment: MapAssetEnrichmentSnapshot | null | undefined,
  layerId: string,
  featureId: string,
): GeoJSONFeature | null {
  const layer = enrichment?.overlay_payload?.layers.find((l) => l.layer_id === layerId);
  if (!layer) return null;
  const fc = asFeatureCollection(layer.data);
  if (!fc) return null;
  for (const feature of fc.features ?? []) {
    const props = feature.properties ?? {};
    const ids = [
      props.id,
      props.feature_id,
      props.ID,
      props.Id,
      props.overture_id,
      feature.id,
    ];
    if (ids.some((v) => v != null && String(v) === featureId)) return feature;
  }
  return null;
}

function firstPointCoords(geometry: { type?: string; coordinates?: unknown } | null | undefined): [number, number] | null {
  if (!geometry || !geometry.coordinates) return null;
  const walk = (value: unknown): [number, number] | null => {
    if (!Array.isArray(value)) return null;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      return [value[0] as number, value[1] as number];
    }
    for (const inner of value) {
      const found = walk(inner);
      if (found) return found;
    }
    return null;
  };
  return walk(geometry.coordinates);
}

// ---------------------------------------------------------------------------
// Ref-kind dispatch
// ---------------------------------------------------------------------------

function resolveCandidateRef(
  candidateId: string,
  context: PlaceHighlightContext,
): PlaceHighlight {
  const candidate = context.candidates.find((c) => c.id === candidateId);
  if (!candidate) return { ...EMPTY_HIGHLIGHT, candidateId };
  const bounds = candidateLocationBounds(context.candidates, candidateId);
  let focusTarget: FocusTarget | null = null;
  if (context.coordRef?.origin_lat != null && context.coordRef?.origin_lon != null) {
    focusTarget = candidateToFocusTarget(
      candidate,
      context.coordRef.origin_lat,
      context.coordRef.origin_lon,
      0,
    );
  }
  return {
    candidateId,
    highlightedFeatureIds: [],
    overlayCoords: null,
    bounds,
    focusTarget,
  };
}

function resolveGeojsonFeatureRef(
  mapId: number,
  context: PlaceHighlightContext,
): PlaceHighlight {
  const feature = findFeatureByMapId(context.roadNetwork, mapId);
  const bounds = feature ? geometryBounds(feature.geometry) : null;
  return {
    candidateId: null,
    highlightedFeatureIds: [mapId],
    overlayCoords: null,
    bounds,
    focusTarget: bounds ? boundsToFocusTarget(bounds, context.coordRef) : null,
  };
}

function resolveRoadAggregateRef(
  featureIds: number[],
  context: PlaceHighlightContext,
): PlaceHighlight {
  const perFeatureBounds = featureIds
    .map((id) => findFeatureByMapId(context.roadNetwork, id))
    .map((feature) => (feature ? geometryBounds(feature.geometry) : null));
  const bounds = unionBounds(perFeatureBounds);
  return {
    candidateId: null,
    highlightedFeatureIds: featureIds,
    overlayCoords: null,
    bounds,
    focusTarget: bounds ? boundsToFocusTarget(bounds, context.coordRef) : null,
  };
}

function resolveOverlayFeatureRef(
  layerId: string,
  featureId: string,
  context: PlaceHighlightContext,
): PlaceHighlight {
  const feature = findOverlayFeature(context.enrichment, layerId, featureId);
  const coords = feature ? firstPointCoords(feature.geometry) : null;
  const bounds = feature ? geometryBounds(feature.geometry) : null;
  return {
    candidateId: null,
    highlightedFeatureIds: [],
    overlayCoords: coords,
    bounds,
    focusTarget: bounds ? boundsToFocusTarget(bounds, context.coordRef) : null,
  };
}

export function resolvePlaceHighlight(
  ref: PlaceRef | null | undefined,
  context: PlaceHighlightContext,
): PlaceHighlight {
  if (!ref) return EMPTY_HIGHLIGHT;
  switch (ref.kind) {
    case "candidate":
      return ref.candidateId
        ? resolveCandidateRef(ref.candidateId, context)
        : EMPTY_HIGHLIGHT;
    case "geojson_feature":
      return ref.geojsonFeatureId != null
        ? resolveGeojsonFeatureRef(ref.geojsonFeatureId, context)
        : EMPTY_HIGHLIGHT;
    case "road_aggregate":
      return ref.geojsonFeatureIds && ref.geojsonFeatureIds.length > 0
        ? resolveRoadAggregateRef(ref.geojsonFeatureIds, context)
        : EMPTY_HIGHLIGHT;
    case "overlay_feature":
      return ref.overlayLayerId && ref.overlayFeatureId
        ? resolveOverlayFeatureRef(ref.overlayLayerId, ref.overlayFeatureId, context)
        : EMPTY_HIGHLIGHT;
    default:
      return EMPTY_HIGHLIGHT;
  }
}
