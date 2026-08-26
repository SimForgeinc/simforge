import type { MapAsset } from "@simforge-oss/studio-shared";
import type { Map as MapLibreMap } from "maplibre-gl";
import { GEOJSON_FEATURE_ID_PROP } from "./feature-inspection-types";
import {
  ROAD_NETWORK_FEATURE_TYPES,
  classifyRoadNetworkFeatureType,
  getFeatureType,
} from "./road-network-feature-types";

// ---- GeoJSON builders and bounds (for map display) ----

/** Convert map assets into a polygon FeatureCollection of bounding boxes. */
export function assetsToPolygonGeoJSON(assets: MapAsset[]) {
  const features = assets.map((asset) => {
    const { min_lat, min_lng, max_lat, max_lng } = asset.bbox;
    return {
      type: "Feature" as const,
      geometry: {
        type: "Polygon" as const,
        coordinates: [
          [
            [min_lng, min_lat],
            [max_lng, min_lat],
            [max_lng, max_lat],
            [min_lng, max_lat],
            [min_lng, min_lat],
          ],
        ],
      },
      properties: { map_asset_id: asset.map_asset_id },
    };
  });
  return { type: "FeatureCollection" as const, features };
}

/** Convert map assets into a point FeatureCollection of center coordinates. */
export function assetsToPointsGeoJSON(assets: MapAsset[]) {
  const features = assets.map((asset) => ({
    type: "Feature" as const,
    geometry: {
      type: "Point" as const,
      coordinates: [asset.center.lng, asset.center.lat] as [number, number],
    },
    properties: { map_asset_id: asset.map_asset_id },
  }));
  return { type: "FeatureCollection" as const, features };
}

/** Convert a single map asset bounding box into a polygon FeatureCollection. */
export function assetToBboxGeoJSON(asset: MapAsset) {
  const { min_lat, min_lng, max_lat, max_lng } = asset.bbox;
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [
              [min_lng, min_lat],
              [max_lng, min_lat],
              [max_lng, max_lat],
              [min_lng, max_lat],
              [min_lng, min_lat],
            ],
          ],
        },
        properties: {},
      },
    ],
  };
}

/** Return the [sw, ne] LngLat bounds for a map asset. */
export function assetBounds(asset: MapAsset): [[number, number], [number, number]] {
  return [
    [asset.bbox.min_lng, asset.bbox.min_lat],
    [asset.bbox.max_lng, asset.bbox.max_lat],
  ];
}

const DEFAULT_VIEW = { longitude: 0, latitude: 20, zoom: 2 };

/** Compute the aggregate [sw, ne] bounds across all assets, or null if empty. */
export function computeAllBounds(assets: MapAsset[]): [[number, number], [number, number]] | null {
  if (assets.length === 0) return null;
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const asset of assets) {
    const b = asset.bbox;
    minLng = Math.min(minLng, b.min_lng);
    maxLng = Math.max(maxLng, b.max_lng);
    minLat = Math.min(minLat, b.min_lat);
    maxLat = Math.max(maxLat, b.max_lat);
  }
  return [[minLng, minLat], [maxLng, maxLat]];
}

/** Derive an initial map view state (center + zoom) from the asset bounds. */
export function computeInitialViewState(assets: MapAsset[]) {
  const b = computeAllBounds(assets);
  if (!b) return DEFAULT_VIEW;
  const [[minLng, minLat], [maxLng, maxLat]] = b;
  const longitude = (minLng + maxLng) / 2;
  const latitude = (minLat + maxLat) / 2;
  const span = Math.max(maxLat - minLat, maxLng - minLng, 0.1);
  const zoom = Math.min(10, Math.max(1, Math.log2(360 / span) - 0.5));
  return { longitude, latitude, zoom };
}

// ---- Feature inspection helpers (MapLibre query results → panel payload) ----

/** Geometry type from MapLibre queried feature. */
export function getGeometryType(feature: { layer?: { id?: string }; geometry?: { type?: string } }): string {
  const layerId = feature.layer?.id ?? "";
  if (layerId === "selected-geojson-fill" || layerId.startsWith("geojson-fill-")) {
    return "Polygon";
  }
  if (
    layerId === "selected-geojson-line" ||
    layerId.startsWith("geojson-line-") ||
    layerId.startsWith("geojson-outline-")
  ) {
    return "LineString";
  }
  return feature.geometry?.type ?? "Feature";
}

/** One-line summary: prefer type/Type property when available; else geometry type + optional class/name. */
export function getFeatureSummaryLine(feature: {
  layer?: { id?: string };
  geometry?: { type?: string };
  properties?: Record<string, unknown>;
}): string {
  const props = feature.properties;
  if (props && typeof props === "object") {
    const roadNetworkFeatureType = classifyRoadNetworkFeatureType(props);
    const roadNetworkFeatureLabel = roadNetworkFeatureType
      ? getFeatureType(roadNetworkFeatureType)?.label
      : null;
    if (roadNetworkFeatureLabel) {
      return roadNetworkFeatureLabel;
    }
    const typeVal = props.type ?? props.Type ?? (props as Record<string, unknown>)["TYPE"];
    if (typeVal != null && typeVal !== "") {
      return String(typeVal);
    }
  }
  const geom = getGeometryType(feature);
  const label =
    (props && (props.class ?? props.name ?? (props as Record<string, unknown>).Class ?? (props as Record<string, unknown>).Name) != null)
      ? String(props.class ?? props.name ?? (props as Record<string, unknown>).Class ?? (props as Record<string, unknown>).Name)
      : "";
  return label ? `${geom} · ${label}` : geom;
}

/** Feature id for highlight (from normalized GeoJSON __mapId). */
export function getFeatureMapId(properties: Record<string, unknown> | null | undefined): number | undefined {
  if (!properties || typeof properties !== "object") return undefined;
  const v = properties[GEOJSON_FEATURE_ID_PROP];
  return typeof v === "number" ? v : undefined;
}

/**
 * Resolve a __mapId back to its authored road-network feature. `__mapId` is the
 * feature's array index (assigned by `normalizeGeoJSONWithFeatureIds`), so the
 * direct index hit is the common path; a linear scan guards against any reorder.
 *
 * Used so a click on a filled lane *polygon* (a separate source that only
 * carries the matched __mapId) resolves to the real centerline feature, and the
 * inspector shows its full attributes rather than the polygon's sparse ones.
 */
export function featureByMapId(
  geojson: object | null | undefined,
  id: number,
): { properties?: Record<string, unknown>; geometry?: { type?: string } } | undefined {
  const fc = geojson as
    | { features?: Array<{ properties?: Record<string, unknown>; geometry?: { type?: string } }> }
    | null
    | undefined;
  const features = fc?.features;
  if (!Array.isArray(features)) return undefined;
  const direct = features[id];
  if (direct?.properties?.[GEOJSON_FEATURE_ID_PROP] === id) return direct;
  return features.find((f) => f?.properties?.[GEOJSON_FEATURE_ID_PROP] === id);
}

/** Properties for panel display (skip internal __mapId). */
export function featurePropertiesForPanel(properties: Record<string, unknown> | null): Record<string, unknown> {
  if (!properties || typeof properties !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(properties)) {
    if (v === undefined || v === null) continue;
    if (k === GEOJSON_FEATURE_ID_PROP) continue;
    if (k === "id" && typeof v === "number") continue;
    out[k] = v;
  }
  return out;
}

// ---- Thumbnail helpers ----

/** Find the thumbnail artifact S3 key for a map asset, if one exists. */
export function getThumbnailKey(asset: MapAsset): string | undefined {
  const thumb = asset.artifacts?.find((a) => a.artifact_type === "thumbnail");
  if (!thumb) return undefined;
  // uri format: "s3://bucket/maps/{id}/{id}_thumbnail.png" — extract the key after bucket
  const match = thumb.uri.match(/^s3:\/\/[^/]+\/(.+)$/);
  return match?.[1];
}

/** Build the media route URL that redirects to a presigned S3 thumbnail URL. */
export function getThumbnailUrl(asset: MapAsset): string | undefined {
  const key = getThumbnailKey(asset);
  if (!key) return undefined;
  return `/api/map-assets/${asset.map_asset_id}/media?key=${encodeURIComponent(key)}`;
}

// ---- Map layer ID constants ----

export const CLICKABLE_LAYER_IDS = [
  "map-assets-clusters",
  "map-assets-cluster-count",
  "map-assets-unclustered",
] as const;

export const ALL_LAYER_IDS = ["map-assets-fill", "map-assets-line", ...CLICKABLE_LAYER_IDS] as const;

export const SELECTED_GEOJSON_LAYER_IDS: string[] = ROAD_NETWORK_FEATURE_TYPES.flatMap((ft) => {
  if (ft.geometryRendering === "fill") {
    return [`geojson-fill-${ft.id}`, `geojson-outline-${ft.id}`];
  }
  // The chip symbol layer covers area beyond the thin line stroke; include it
  // so clicking the icon selects the lane (filtered to existing layers, so
  // types without a chip are a harmless no-op).
  const ids = [`geojson-line-${ft.id}`, `geojson-chip-${ft.id}`];
  // When lanes render as filled polygons the visible stripe is hidden, so the
  // `lane-polygon-fill-*` layer is the real hit-target — include it so clicking
  // anywhere on the lane area selects it. It carries the same __mapId as the
  // centerline, so index resolution still shows the full lane attributes.
  if (ft.id.startsWith("lanes_")) ids.push(`lane-polygon-fill-${ft.id}`);
  return ids;
});

/** Filter layer IDs to only those currently present on the map instance. */
export function getExistingLayerIds(map: MapLibreMap, layerIds: readonly string[]): string[] {
  return layerIds.filter((id) => map.getLayer(id) != null);
}
