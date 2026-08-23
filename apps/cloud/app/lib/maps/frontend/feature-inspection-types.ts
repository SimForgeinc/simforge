/**
 * Types and constants for map-asset feature inspection (GeoJSON features under the selected map).
 * Used by MapAssetsMap, MapElementInspector, MapAssetAttributePanel, and MapAssetsPageClient.
 */

/** Feature id property added when normalizing GeoJSON (for highlight/selection state). */
export const GEOJSON_FEATURE_ID_PROP = "__mapId";

/** Payload when user selects a GeoJSON feature (for Feature Inspector panel). */
export type SelectedGeoJSONFeaturePayload = {
  id: number;
  summary: string;
  /** GeoJSON geometry type: Point, LineString, Polygon, etc. */
  geometryType: string;
  properties: Record<string, unknown>;
  /** For overlay features (enrichment, signals): coordinates for highlight marker. */
  coordinates?: [number, number];
  /** Full GeoJSON geometry object (for "Copy GeoJSON" export). */
  geometry?: Record<string, unknown>;
  /**
   * When the click landed on a filled lane polygon, the clicked polygon's unique
   * `lane_poly_id`. Highlight is keyed on THIS (not `id`/`__mapId`) so only the
   * clicked lane area lights up — several junction connectors can share one lane
   * `__mapId`, and we must not highlight them all.
   */
  lanePolygonId?: number;
};
