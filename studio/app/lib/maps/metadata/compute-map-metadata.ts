import type {
  MapCoordinateRef,
  MapPlaceContext,
  MapSource,
  MapStats,
} from "@simforge-oss/studio-shared";
import { extractGeojsonDerivedStats } from "./geojson-stats";
import { extractRrdataSchemaVersion, extractSignalizationFromRrdata } from "./rrdata-xml";
import {
  extractCoordinateRefFromXodr,
  extractMapSourceFromXodr,
  extractXodrRoadStats,
} from "./xodr";
import { deriveIngestTagsFromMapStats } from "./ingest-tags";
import { reverseGeocodeCity } from "./reverse-geocode";
import { extractSignalFeaturesFromXodr, type SignalFeatureCollection } from "./xodr-signals";
import { extractLanePolygonsFromXodr, type LanePolygonFeatureCollection } from "./lane-polygons";

export type ComputeMapMetadataInput = {
  mapAssetId: string;
  geojsonText: string;
  xodrText: string;
  rrdataXmlText: string;
};

export type ComputeMapMetadataResult = {
  map_source: MapSource;
  map_coordinate_ref: MapCoordinateRef;
  map_stats: MapStats;
  place_context: MapPlaceContext | undefined;
  ingest_tags: string[];
  signal_features: SignalFeatureCollection;
  lane_polygon_features: LanePolygonFeatureCollection;
  warnings: string[];
};

function mapLaneCounts(raw: Record<string, number>) {
  const get = (k: string) => raw[k] ?? raw[k.toLowerCase()] ?? 0;
  return {
    driving: get("driving"),
    sidewalk: get("sidewalk"),
    biking: get("biking"),
    shoulder: get("shoulder"),
    parking: get("parking"),
    restricted: get("restricted"),
    bidirectional: get("bidirectional"),
    none: get("none"),
  };
}

export function computeMapMetadataBundle(input: ComputeMapMetadataInput): ComputeMapMetadataResult {
  const warnings: string[] = [];
  const { mapAssetId, geojsonText, xodrText, rrdataXmlText } = input;

  if (!xodrText.trim()) warnings.push("xodr: empty");
  if (!rrdataXmlText.trim()) warnings.push("rrdata_xml: empty");
  if (!geojsonText.trim()) warnings.push("geojson: empty");

  const rrVer = extractRrdataSchemaVersion(rrdataXmlText);
  const map_source = extractMapSourceFromXodr(xodrText, rrVer);
  const map_coordinate_ref = extractCoordinateRefFromXodr(xodrText, map_source.tool_version);

  // Reverse-geocode origin coordinates to city/state/country.
  const place_context =
    map_coordinate_ref.origin_lat != null && map_coordinate_ref.origin_lon != null
      ? reverseGeocodeCity(map_coordinate_ref.origin_lat, map_coordinate_ref.origin_lon)
      : undefined;

  const xodrStats = extractXodrRoadStats(xodrText);
  const geo = extractGeojsonDerivedStats(geojsonText);
  warnings.push(...geo.warnings);

  const signalization = extractSignalizationFromRrdata(rrdataXmlText);

  const totalJ = xodrStats.total_junctions;

  const computed_at = new Date().toISOString();
  const lane_counts = mapLaneCounts(xodrStats.lane_counts);

  // Parking comes exclusively from the geojson parser.
  const parking_space_count = geo.parking_space_count > 0 ? geo.parking_space_count : undefined;

  // crosswalk_count is always a concrete number from the xodr parser (0 is a valid
  // and meaningful value). Use null-coalescing rather than || so that 0 is preserved
  // rather than coerced to undefined. The crosswalks block is always emitted.
  const crosswalkTotal = xodrStats.crosswalk_count;

  const map_stats: MapStats = {
    map_asset_id: mapAssetId,
    computed_at,
    road_network: {
      total_roads: xodrStats.total_roads || undefined,
      total_junctions: xodrStats.total_junctions || undefined,
      total_centerline_length_m:
        xodrStats.total_centerline_length_m > 0
          ? xodrStats.total_centerline_length_m
          : undefined,
      lane_counts,
      roads_with_bike_lanes: xodrStats.roads_with_bike_lanes || undefined,
      bike_lane_length_m: xodrStats.bike_lane_length_m || undefined,
      shared_bike_lane_length_m: xodrStats.shared_bike_lane_length_m || undefined,
      roads_with_sidewalks: xodrStats.roads_with_sidewalks || undefined,
      sidewalk_length_m: xodrStats.sidewalk_length_m || undefined,
      roads_with_parking_lanes: xodrStats.roads_with_parking_lanes || undefined,
      parking_lane_length_m: xodrStats.parking_lane_length_m || undefined,
      signal_count: xodrStats.signal_count || undefined,
      signal_breakdown: xodrStats.signal_breakdown,
      // Emit 0 explicitly — absence of crosswalks is a meaningful fact for
      // scenario tagging (CROSSWALK_MARKED_UNSIGNALIZED won't fire if this is 0).
      crosswalk_count: crosswalkTotal,
      parking_space_count,
      speed_limits_mph:
        xodrStats.speed_limits_mph.length > 0 ? xodrStats.speed_limits_mph : undefined,
      max_grade_pct: xodrStats.max_grade_pct > 0 ? xodrStats.max_grade_pct : undefined,
      segments_above_4pct_grade:
        xodrStats.segments_above_4pct_grade > 0
          ? xodrStats.segments_above_4pct_grade
          : undefined,
      length_above_4pct_grade_m: xodrStats.length_above_4pct_grade_m || undefined,
      junction_road_degree_counts: xodrStats.junction_road_degree_counts,
    },
    signalization,
    feature_inventory: {
      junctions: {
        // signal_controlled_objects and unsignalized are omitted here: the rrdata
        // signal_controlled_object_count lives in a different ID space from xodr
        // <junction> elements and cannot be reliably joined to them. The count
        // is available in signalization.signal_controlled_object_count instead.
        total: totalJ || undefined,
        // Junction-level control counts from xodr signal-junction cross-referencing.
        // Preserve 0 — it means "computed, none found" vs undefined = "not computed".
        signalized: xodrStats.junction_control_counts.signalized,
        stop_sign_controlled: xodrStats.junction_control_counts.stop_sign_controlled,
        allway_stop: xodrStats.junction_control_counts.allway_stop,
      },
      crosswalks: {
        // Always emit all three crosswalk fields, even when counts are 0.
        // The previous code used `crosswalk_count || undefined` which coerced
        // 0 to undefined, dropping total and unsignalized from the output entirely.
        // All signalized crosswalk detection is geojson-phase-based (see design
        // spec); xodr provides only the total count, so signalized is always 0.
        total: crosswalkTotal,
        signalized: 0,
        unsignalized: crosswalkTotal,
      },
      lanes: {
        driving_total: lane_counts.driving,
        bike_total: lane_counts.biking,
        sidewalk_total: lane_counts.sidewalk,
        shoulder_total: lane_counts.shoulder,
        parking_total: lane_counts.parking,
      },
      signals: xodrStats.signal_count || undefined,
      traffic_lights: xodrStats.signal_breakdown.traffic_lights || undefined,
      stop_signs: xodrStats.signal_breakdown.stop_signs || undefined,
      yield_signs: xodrStats.signal_breakdown.yield_signs || undefined,
      bus_stops: xodrStats.signal_breakdown.bus_stops || undefined,
      parking_spaces: parking_space_count,
      turn_movements: {
        // Always emit all directions as concrete numbers (0 is meaningful —
        // it means no gates of that type exist in the junction network).
        straight: geo.turn_straight,
        left: geo.turn_left,
        right: geo.turn_right,
        uturn_left: geo.turn_uturn_left,
        uturn_right: geo.turn_uturn_right,
      },
    },
  };

  const ingest_tags = deriveIngestTagsFromMapStats(map_stats);

  const signal_features = extractSignalFeaturesFromXodr(xodrText);
  const lane_polygon_features = extractLanePolygonsFromXodr(xodrText);

  return {
    map_source,
    map_coordinate_ref,
    map_stats,
    place_context,
    ingest_tags,
    signal_features,
    lane_polygon_features,
    warnings,
  };
}

export function mergeMapTags(userTags: string[] | undefined, ingestTags: string[]): string[] {
  const set = new Set<string>();
  for (const t of userTags ?? []) {
    if (typeof t === "string" && t.trim()) set.add(t.trim());
  }
  for (const t of ingestTags) set.add(t);
  return [...set];
}
