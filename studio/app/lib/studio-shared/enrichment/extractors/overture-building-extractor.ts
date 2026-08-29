import type { MapAssetBuilding } from "../../map-asset-building";
import type { Bbox } from "../bbox-utils";
import { parsePolygonRings, type PolygonRings } from "../point-in-polygon";
import { filterByRoadProximityBbox, ROAD_PROXIMITY_THRESHOLD_M } from "../road-proximity-filter";
import { mapAssetBuildingRowId } from "./overture-row-ids";

/**
 * Hard cap on per-feature vertex count. Buildings keep their row + bbox +
 * ring data (so addresses can still be spatially joined to them) but the
 * GeoJSON geometry shipped to the overlay is replaced with a Polygon
 * derived from the bbox. The detailed footprint lives in the 3D model;
 * the Aurora copy is purely for metadata, so a building that ships with
 * 500+ vertices after SQL-side simplification is overwhelmingly likely
 * to be a Overture artifact (e.g. a stadium, a refinery, a complex
 * curtain wall traced from satellite) where rendering it as the AABB
 * is materially better than letting it bloat overlay_geojson_json.
 */
const MAX_GEOMETRY_VERTICES = 200;

function countPolygonVertices(geom: { type: string; coordinates: unknown } | null): number {
  if (!geom) return 0;
  let total = 0;
  if (geom.type === "Polygon" && Array.isArray(geom.coordinates)) {
    for (const ring of geom.coordinates as unknown[]) {
      if (Array.isArray(ring)) total += ring.length;
    }
  } else if (geom.type === "MultiPolygon" && Array.isArray(geom.coordinates)) {
    for (const part of geom.coordinates as unknown[]) {
      if (!Array.isArray(part)) continue;
      for (const ring of part as unknown[]) {
        if (Array.isArray(ring)) total += ring.length;
      }
    }
  }
  return total;
}

function bboxToGeoJsonPolygon(bbox: Bbox): { type: "Polygon"; coordinates: number[][][] } {
  return {
    type: "Polygon",
    coordinates: [[
      [bbox.min_lng, bbox.min_lat],
      [bbox.max_lng, bbox.min_lat],
      [bbox.max_lng, bbox.max_lat],
      [bbox.min_lng, bbox.max_lat],
      [bbox.min_lng, bbox.min_lat],
    ]],
  };
}

export interface OvertureBuildingInput {
  id: string;
  name: string | null;
  layer_class: string | null;
  subtype: string | null;
  height: number | null;
  num_floors: number | null;
  centroid_lng: number;
  centroid_lat: number;
  min_lng: number;
  min_lat: number;
  max_lng: number;
  max_lat: number;
  geom_json: string | null;
}

export interface ExtractedBuilding {
  /** Aurora-row shape; address_count is filled in by the address extractor. */
  row: MapAssetBuilding;
  /** GeoJSON feature ready for the local enrichment `buildings` overlay. */
  feature: {
    type: "Feature";
    id: string;
    geometry: { type: string; coordinates: unknown };
    properties: Record<string, unknown>;
  };
  /** Raw bbox for address point-in-polygon prefilter. */
  bbox: Bbox;
  /**
   * Parsed polygon rings used by the address spatial join. One ring set
   * for Polygon, multiple for MultiPolygon. null when parse failed —
   * those buildings are still persisted (so the user sees them rendered)
   * but no addresses will be linked to them.
   */
  rings: PolygonRings[] | null;
}

/**
 * Convert raw Overture building rows into Aurora-ready rows + GeoJSON
 * features. Applies the road-proximity relevance filter so we only keep
 * buildings within `proximityM` of the in-map road network — Overture has
 * buildings everywhere, but for scenario context we only care about ones
 * a driver could plausibly observe from the drivable surface. When
 * `roadNetworkPoints` is empty (e.g., the GeoJSON artifact failed to
 * load), the filter is a no-op and all buildings inside the bbox are kept.
 */
export function extractBuildings(
  rows: OvertureBuildingInput[],
  mapAssetId: string,
  roadNetworkPoints: { lat: number; lng: number }[] | undefined,
  proximityM: number = ROAD_PROXIMITY_THRESHOLD_M,
): ExtractedBuilding[] {
  if (rows.length === 0) return [];

  // Bbox-aware proximity: keep a building if any road point is within
  // `proximityM` of its axis-aligned footprint rectangle. Centroid-only
  // filtering would drop large landmarks (malls, factories, hospitals —
  // 100 m+ across) whose centroid sits deeper than the 50 m threshold
  // even when the frontage edge is right on the road. The clamp-to-rect
  // distance is exact for AABBs, so the only false positives come from
  // diagonal / concave shapes whose AABB overstates the footprint —
  // an acceptable trade-off vs. dropping major landmarks.
  const filtered = roadNetworkPoints && roadNetworkPoints.length > 0
    ? filterByRoadProximityBbox(
        rows,
        (b) => ({
          min_lat: Number(b.min_lat),
          min_lng: Number(b.min_lng),
          max_lat: Number(b.max_lat),
          max_lng: Number(b.max_lng),
        }),
        roadNetworkPoints,
        proximityM,
      )
    : rows;

  const out: ExtractedBuilding[] = [];
  for (const r of filtered) {
    const id = mapAssetBuildingRowId(mapAssetId, r.id);
    const bbox: Bbox = {
      min_lat: Number(r.min_lat),
      min_lng: Number(r.min_lng),
      max_lat: Number(r.max_lat),
      max_lng: Number(r.max_lng),
    };
    const rings = parsePolygonRings(r.geom_json);
    const parsedGeometry = rings != null && r.geom_json
      ? (JSON.parse(r.geom_json) as { type: string; coordinates: unknown })
      : null;

    // Vertex-cap safety net: if SQL-side simplification couldn't get the
    // footprint under MAX_GEOMETRY_VERTICES, ship the bbox polygon
    // instead. The point-in-polygon spatial join still uses the original
    // `rings` (in-memory only) so address↔building linking stays accurate;
    // only the user-visible overlay geometry degrades to a rectangle.
    const overshoot = countPolygonVertices(parsedGeometry) > MAX_GEOMETRY_VERTICES;
    const geometry = overshoot ? bboxToGeoJsonPolygon(bbox) : parsedGeometry;

    out.push({
      row: {
        id,
        map_asset_id: mapAssetId,
        name: r.name ?? null,
        class: r.layer_class ?? null,
        subtype: r.subtype ?? null,
        centroid_lat: Number(r.centroid_lat),
        centroid_lng: Number(r.centroid_lng),
        height: r.height ?? null,
        num_floors: r.num_floors ?? null,
        // Will be populated by extractAddresses() once it spatial-joins.
        address_count: 0,
        primary_address: null,
      },
      feature: {
        type: "Feature",
        id,
        geometry: geometry ?? { type: "Point", coordinates: [r.centroid_lng, r.centroid_lat] },
        properties: {
          id,
          overture_id: r.id,
          layer_id: "buildings",
          name: r.name ?? null,
          class: r.layer_class ?? null,
          subtype: r.subtype ?? null,
          height: r.height ?? null,
          num_floors: r.num_floors ?? null,
          bbox,
        },
      },
      bbox,
      rings,
    });
  }
  return out;
}
