/**
 * Extract lane-area polygons from an XODR file as a GeoJSON FeatureCollection.
 *
 * RoadRunner's road-network GeoJSON only carries lane *centerlines* (rendered
 * as polylines). The XODR, however, declares each lane's `<width>` polynomial,
 * so we can reconstruct the true filled lane area. The geometry engine lives in
 * `@simforge-oss/studio-shared` (`buildLanePolygonsLocal`, shared with the topology
 * builder); here we project each ring from the XODR planView meter frame to
 * WGS84 using the file's `<geoReference>` projection — the same projection the
 * authored GeoJSON and runtime overlay already align on.
 *
 * The result is uploaded as a per-map sidecar artifact (`lane_polygons_geojson`)
 * during Phase 1 metadata population, mirroring the signals overlay sidecar.
 */
import {
  MapProjection,
} from "@simforge-oss/studio-shared";
import {
  buildLanePolygonsLocal,
} from "@simforge-oss/maps/topology";
import { extractCoordinateRefFromXodr } from "./xodr";

type GeoJSONPolygon = { type: "Polygon"; coordinates: [number, number][][] };

// Lane polygons are the bulkiest geometry on a map (two edge vertices per
// centerline sample). Full float precision from the projection is wasteful, so
// coordinates are rounded to 7 decimal places (~1 cm at the equator — far finer
// than lane rendering needs) which trims the JSON ~30-40% before gzip.
const COORD_DECIMALS = 7;
function round(value: number): number {
  const factor = 10 ** COORD_DECIMALS;
  return Math.round(value * factor) / factor;
}

export type LanePolygonFeature = {
  type: "Feature";
  geometry: GeoJSONPolygon;
  properties: {
    feature_kind: "lane_polygon";
    /** Mirrors the authored RoadRunner lane property so the same toggles/filters apply. */
    Type: "Lane";
    /** Lowercased XODR lane type (driving / sidewalk / biking / …). */
    LaneType: string;
    road_id: string;
    section_id: number;
    lane_id: number;
    is_junction: boolean;
    /**
     * RoadRunner lane GUID (from the XODR `<vectorLane laneId>`), identical to
     * the authored GeoJSON lane feature's `Id`. Lets the frontend resolve the
     * polygon to its centerline feature exactly, with no geometric matching.
     */
    lane_guid?: string;
  };
};

export type LanePolygonFeatureCollection = {
  type: "FeatureCollection";
  features: LanePolygonFeature[];
};

/**
 * Reconstruct filled lane-area polygons from the XODR and project them to WGS84.
 *
 * Returns an empty collection when the XODR has no usable projection (no
 * `<geoReference>` PROJ string and no origin) — without a projection the rings
 * cannot be placed on the map, and emitting local-meter coordinates would
 * silently misregister every lane.
 */
export function extractLanePolygonsFromXodr(
  xodrText: string,
): LanePolygonFeatureCollection {
  const coordinateRef = extractCoordinateRefFromXodr(xodrText);
  const projection = MapProjection.fromCoordinateRef(coordinateRef);
  if (!projection) return { type: "FeatureCollection", features: [] };

  const lanePolygons = buildLanePolygonsLocal(xodrText);
  const features: LanePolygonFeature[] = [];

  for (const lane of lanePolygons) {
    const ring = lane.ring.map((point) => {
      const { lon, lat } = projection.localToGeo(point.x, point.y);
      return [round(lon), round(lat)] as [number, number];
    });

    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: {
        feature_kind: "lane_polygon",
        Type: "Lane",
        LaneType: lane.laneType,
        road_id: String(lane.roadId),
        section_id: lane.section,
        lane_id: lane.laneId,
        is_junction: lane.isJunction,
        ...(lane.laneGuid ? { lane_guid: lane.laneGuid } : {}),
      },
    });
  }

  return { type: "FeatureCollection", features };
}
