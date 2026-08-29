import { pointInBbox, pointInPolygon } from "../point-in-polygon";
import {
  parseRoadSegments,
  snapPointToNearestRoad,
  type ParsedRoadSegment,
  type SnapResult,
} from "../snap-to-road";
import type { RoadSegmentForMatching } from "../street-name-resolver";
import type { ExtractedBuilding } from "./overture-building-extractor";

/**
 * Final enrichment step — "apply address and street context where possible".
 *
 * The pipeline ingests every layer in parallel: addresses, buildings, POIs,
 * parking, crosswalks, in-house junctions, in-house parking, etc. This pass
 * runs after every parallel branch has finished and is the single point
 * where both third-party and in-house features pick up:
 *
 *   1. Street name + road access link from the nearest named road segment
 *      (works on Point, LineString, and Polygon features alike — uses each
 *      geometry's representative point).
 *
 *   2. Building context — POIs whose point falls inside an Overture building
 *      footprint inherit the building's id, name, class, height, footprint
 *      geometry, and primary_address. This lifts a "shopping mall" or
 *      "restaurant" point feature into a building-aware entity downstream.
 *
 *   3. Building features mirror their row's primary_address + address_count
 *      onto feature.properties so the map inspector and search index can
 *      read them off the overlay payload without an Aurora round-trip.
 *
 * Pure mutation, no I/O. Idempotent: re-running on the same inputs writes
 * the same values.
 */

const DEFAULT_MAX_ROAD_DISTANCE_M = 250;

interface FeatureGeometry {
  type?: string;
  coordinates?: unknown;
}

interface AnyFeature {
  geometry?: FeatureGeometry;
  properties?: Record<string, unknown> | null;
}

interface FeatureCollection {
  features?: unknown;
}

/**
 * Mirror the building row's address fields onto its GeoJSON feature
 * properties so the map inspector and any downstream renderer that only
 * touches the overlay payload can see them.
 */
export function copyBuildingRowAddressFieldsToFeature(b: ExtractedBuilding): void {
  if (b.feature.properties == null) {
    (b.feature as { properties: Record<string, unknown> }).properties = {};
  }
  b.feature.properties.primary_address = b.row.primary_address;
  b.feature.properties.address_count = b.row.address_count;
}

function findEnclosingBuilding(
  lng: number,
  lat: number,
  buildings: ExtractedBuilding[],
): ExtractedBuilding | null {
  for (const b of buildings) {
    if (!pointInBbox(lng, lat, b.bbox)) continue;
    if (b.rings == null) continue;
    if (b.rings.some((rings) => pointInPolygon(lng, lat, rings))) return b;
  }
  return null;
}

function inheritBuildingAttrs(feature: AnyFeature, b: ExtractedBuilding): void {
  if (feature.properties == null) feature.properties = {};
  const props = feature.properties;
  props.building_id = b.row.id;
  props.building_name = b.row.name;
  props.building_class = b.row.class;
  props.building_subtype = b.row.subtype;
  props.building_height = b.row.height;
  props.building_num_floors = b.row.num_floors;
  props.building_centroid_lat = b.row.centroid_lat;
  props.building_centroid_lng = b.row.centroid_lng;
  // The "applied" address — the building's primary postal address. Reading
  // it off the POI is what makes "park at the Stanford Mall" resolve to
  // an actual street address downstream.
  props.address = b.row.primary_address;
  props.address_count = b.row.address_count;
}

/**
 * Promote a Point POI feature's geometry to the enclosing building's
 * footprint, preserving the original POI point in `point_geometry` so
 * downstream consumers (label placement, click hit-test) can still get a
 * deterministic anchor. The shared reference to b.feature.geometry is
 * fine — nothing mutates polygons after this pass; on serialization the
 * polygon coordinates are written once per consumer (overlay JSON, local storage),
 * which is the duplication cost we already accepted.
 */
function promotePointToBuildingFootprint(
  feature: AnyFeature,
  b: ExtractedBuilding,
): void {
  if (feature.geometry?.type !== "Point") return;
  if (feature.properties == null) feature.properties = {};
  feature.properties.point_geometry = feature.geometry;
  feature.geometry = b.feature.geometry;
}

function stampStreetSnap(feature: AnyFeature, snap: SnapResult): void {
  if (feature.properties == null) feature.properties = {};
  const props = feature.properties;
  props.street_name = snap.roadName;
  props.road_access_lat = snap.lat;
  props.road_access_lng = snap.lng;
  props.road_access_distance_m = snap.distanceM;
}

/**
 * Pick a single representative point from any feature geometry, used as
 * the query point for the nearest-road snap. Polygons use the centroid of
 * the bounding box of the outer ring (cheap; matches what bboxToPoint
 * does for Polygon overlays). LineStrings use the midpoint of the chain.
 * Returns null when the geometry is unrecognised or coordinates are
 * malformed — those features are skipped.
 */
function representativePoint(geom: FeatureGeometry | undefined): { lat: number; lng: number } | null {
  if (!geom) return null;
  const c = geom.coordinates;

  if (geom.type === "Point" && Array.isArray(c) && c.length >= 2) {
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }

  if (geom.type === "LineString" && Array.isArray(c) && c.length >= 1) {
    // Midpoint of the polyline by index — for short urban segments (typical
    // 50–200 m) the midpoint is within a few metres of the centroid; for
    // longer segments using the centroid would require area-weighting,
    // which doesn't pay back for this use case.
    const mid = c[Math.floor(c.length / 2)] as unknown;
    if (!Array.isArray(mid) || mid.length < 2) return null;
    const lng = Number(mid[0]);
    const lat = Number(mid[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }

  if ((geom.type === "Polygon" || geom.type === "MultiPolygon") && Array.isArray(c)) {
    // Outer ring of the (first) polygon part. MultiPolygon uses the first
    // part's outer ring — for our use case (giving a parking lot or
    // building a representative road snap) any part is fine; if a future
    // need cares about per-part snapping we can iterate parts here.
    let ring: unknown;
    if (geom.type === "Polygon") {
      ring = (c as unknown[])[0];
    } else {
      const firstPart = (c as unknown[][])[0];
      ring = firstPart?.[0];
    }
    if (!Array.isArray(ring) || ring.length === 0) return null;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const pt of ring) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const lng = Number(pt[0]);
      const lat = Number(pt[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
    if (!Number.isFinite(minLat)) return null;
    return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
  }

  return null;
}

export interface ApplyAddressContextOptions {
  /**
   * Buildings act as both context source (their primary_address gets
   * mirrored to feature properties; their footprint hosts POIs) AND as
   * features in their own right (they get snapped to a street).
   */
  buildings: ExtractedBuilding[];
  /**
   * Feature collections whose Point features are themselves the visible
   * face of a building — schools, hospitals, retail, restaurants, hotels,
   * airports, shopping malls, transit stations, gas stations. When a
   * feature here falls inside an Overture building footprint, it
   * inherits the building's identity, address, and geometry (its Point
   * is promoted to the building's polygon so the map renders the
   * footprint).
   */
  buildingHostedFeatureCollections: FeatureCollection[];
  /**
   * Feature collections that get only street-name + road-access
   * snapping, NOT building inheritance. Addresses (the address point is
   * itself the lookup target — it shouldn't be subsumed by the building
   * it sits inside; the building↔address link is the other direction
   * via building.primary_address). Crosswalks. Bus stops (just a stop
   * sign on a sidewalk). Parking lots (already polygons, not buildings).
   */
  streetSnapOnlyFeatureCollections: FeatureCollection[];
  /** Named drivable Overture road segments. Empty / undefined makes the
   *  street-snap step a no-op (no road network available). */
  roadSegments: RoadSegmentForMatching[];
  /** Search radius for street snapping. Default 250 m. */
  maxRoadDistanceM?: number;
}

/**
 * The unified final step. Calls the three sub-passes in order; safe to
 * skip individually by passing empty arrays.
 */
export function applyAddressContext(opts: ApplyAddressContextOptions): void {
  const maxDist = opts.maxRoadDistanceM ?? DEFAULT_MAX_ROAD_DISTANCE_M;
  const parsed = opts.roadSegments.length > 0 ? parseRoadSegments(opts.roadSegments) : [];

  // 1. Building features: mirror address fields, then snap centroid to
  //    nearest street so clicking a building shows "Main St — 600 Main St".
  for (const b of opts.buildings) {
    copyBuildingRowAddressFieldsToFeature(b);
    if (parsed.length === 0) continue;
    const snap = snapPointToNearestRoad(
      b.row.centroid_lat,
      b.row.centroid_lng,
      parsed,
      { maxDistanceM: maxDist },
    );
    if (snap) stampStreetSnap(b.feature, snap);
  }

  // 2. Building-hosted POIs: building inheritance + geometry promotion +
  //    street snap.
  attachContextToFeatures(
    opts.buildingHostedFeatureCollections,
    opts.buildings,
    parsed,
    maxDist,
    /* allowBuildingInheritance */ true,
  );

  // 3. Everything else: street snap only.
  attachContextToFeatures(
    opts.streetSnapOnlyFeatureCollections,
    opts.buildings,
    parsed,
    maxDist,
    /* allowBuildingInheritance */ false,
  );
}

function attachContextToFeatures(
  collections: FeatureCollection[],
  buildings: ExtractedBuilding[],
  parsed: ParsedRoadSegment[],
  maxDistanceM: number,
  allowBuildingInheritance: boolean,
): void {
  if (collections.length === 0) return;

  for (const collection of collections) {
    const features = collection.features;
    if (!Array.isArray(features)) continue;

    for (const feature of features as AnyFeature[]) {
      const rep = representativePoint(feature.geometry);
      if (rep == null) continue;

      // Point features that fall inside a building inherit its attrs and
      // adopt the building's footprint as their own geometry — a "school"
      // or "shopping_mall" point becomes a polygon on the map. The
      // original POI point is preserved on `properties.point_geometry`
      // for label placement / click hit-tests. Polygon / LineString
      // features skip this — a road that crosses a building footprint
      // isn't "inside" it in the useful sense.
      if (
        allowBuildingInheritance &&
        feature.geometry?.type === "Point" &&
        buildings.length > 0
      ) {
        const enclosing = findEnclosingBuilding(rep.lng, rep.lat, buildings);
        if (enclosing) {
          inheritBuildingAttrs(feature, enclosing);
          promotePointToBuildingFootprint(feature, enclosing);
        }
      }

      if (parsed.length === 0) continue;
      // Snap the original representative point — for promoted POIs this
      // is still the POI's centroid (rep was computed before the
      // geometry swap above), so the street name reflects the POI's
      // location, not the building centroid.
      const snap = snapPointToNearestRoad(rep.lat, rep.lng, parsed, { maxDistanceM });
      if (snap) stampStreetSnap(feature, snap);
    }
  }
}
