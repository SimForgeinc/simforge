import { GEOJSON_FEATURE_ID_PROP } from "./feature-inspection-types";

/**
 * Link each filled lane polygon to its authored RoadRunner centerline feature.
 *
 * The polygons (reconstructed from the XODR widths, served as the
 * `lane_polygons_geojson` sidecar) carry `lane_guid` — the RoadRunner lane GUID
 * read straight from the XODR `<vectorLane laneId>`. That GUID is identical to
 * the authored GeoJSON lane feature's `Id`, and `buildFeatureIdIndex` already
 * maps that GUID → the feature's `__mapId`. So linking is an exact dictionary
 * lookup: no geometry, no precision issues, and no junction-crossing ambiguity.
 *
 * We stamp the resolved `__mapId` onto each polygon so a click on the fill
 * resolves to the real lane feature (full attributes). Polygons without a
 * `lane_guid`, or whose GUID isn't in the authored GeoJSON, still resolve
 * nothing but stay independently selectable via their own id.
 *
 * Each polygon is ALSO given a unique `lane_poly_id` (its index). The lane GUID
 * is NOT unique across polygons — at a junction, several connector lanes share
 * one source-lane GUID — so highlighting by `__mapId` would light every
 * connector at once. `lane_poly_id` is the per-polygon handle the map uses to
 * highlight exactly the clicked lane area, while `__mapId` still drives the
 * attribute lookup.
 */

/** Property holding each polygon's unique highlight id (used as the source promoteId). */
export const LANE_POLYGON_ID_PROP = "lane_poly_id";

const BRACED_UUID_RE = /^\{([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\}$/i;

/** Normalize a RoadRunner GUID to the brace-stripped form `buildFeatureIdIndex` keys on. */
function normalizeGuid(raw: string): string {
  const m = BRACED_UUID_RE.exec(raw);
  return m ? m[1]! : raw;
}

type FeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: unknown;
    properties: (Record<string, unknown> & { lane_guid?: string }) | null;
  }>;
};

/**
 * Return a NEW lane-polygon FeatureCollection whose features carry the
 * `__mapId` of their authored centerline (resolved by `lane_guid`). Input is
 * returned as-is when it has no features or no index is available.
 */
export function stampLanePolygonMapIds(
  lanePolygons: object | null | undefined,
  guidToMapId: Map<string, number>,
): object | null {
  const polys = lanePolygons as FeatureCollection | null | undefined;
  if (!polys?.features?.length) return (lanePolygons as object) ?? null;
  if (guidToMapId.size === 0) return lanePolygons as object;

  const features = polys.features.map((feature, i) => {
    const guid = feature.properties?.lane_guid;
    const mapId = typeof guid === "string" ? guidToMapId.get(normalizeGuid(guid)) : undefined;
    return {
      ...feature,
      properties: {
        ...feature.properties,
        [LANE_POLYGON_ID_PROP]: i,
        ...(mapId === undefined ? {} : { [GEOJSON_FEATURE_ID_PROP]: mapId }),
      },
    };
  });

  return { type: "FeatureCollection", features } as object;
}
