import { z } from "zod";

/** Provenance extracted from OpenDRIVE + RoadRunner metadata XML. */
export const MapSourceSchema = z.object({
  tool: z.string().optional(),
  tool_version: z.string().optional(),
  vendor: z.string().optional(),
  opendrive_version: z.string().optional(),
  rrdata_schema_version: z.string().optional(),
  exported_at: z.string().optional(),
});
export type MapSource = z.infer<typeof MapSourceSchema>;

export const EuclideanBboxMSchema = z.object({
  north: z.number(),
  south: z.number(),
  east: z.number(),
  west: z.number(),
});
export type EuclideanBboxM = z.infer<typeof EuclideanBboxMSchema>;

/** Meter offset from projected map-local coordinates into the editor viewport coordinate plane. */
export const EditorOffsetMSchema = z.object({
  x: z.number(),
  y: z.number(),
});
export type EditorOffsetM = z.infer<typeof EditorOffsetMSchema>;

/** Coordinate reference from OpenDRIVE geoReference + derived fields. */
export const MapCoordinateRefSchema = z.object({
  proj_string: z.string().optional(),
  origin_lat: z.number().optional(),
  origin_lon: z.number().optional(),
  origin_alt_m: z.number().optional(),
  projection_type: z.string().optional(),
  datum: z.string().optional(),
  utm_zone: z.string().optional(),
  euclidean_bbox_m: EuclideanBboxMSchema.optional(),
  editor_offset_m: EditorOffsetMSchema.optional(),
  vertical_units: z.string().optional(),
  horizontal_units: z.string().optional(),
  source_file: z.literal("xodr").optional(),
  rr_version: z.string().optional(),
});
export type MapCoordinateRef = z.infer<typeof MapCoordinateRefSchema>;

export const MapStatsLaneCountsSchema = z.object({
  driving: z.number().optional(),
  sidewalk: z.number().optional(),
  biking: z.number().optional(),
  shoulder: z.number().optional(),
  parking: z.number().optional(),
  restricted: z.number().optional(),
  bidirectional: z.number().optional(),
  none: z.number().optional(),
});
export type MapStatsLaneCounts = z.infer<typeof MapStatsLaneCountsSchema>;

export const MapStatsRoadNetworkSchema = z.object({
  total_roads: z.number().optional(),
  total_junctions: z.number().optional(),
  total_centerline_length_m: z.number().optional(),
  lane_counts: MapStatsLaneCountsSchema.optional(),
  roads_with_bike_lanes: z.number().optional(),
  /** Total length (metres) of roads with at least one biking lane. */
  bike_lane_length_m: z.number().optional(),
  /** Length (metres) of roads with both biking and driving lanes (shared road). */
  shared_bike_lane_length_m: z.number().optional(),
  roads_with_sidewalks: z.number().optional(),
  /** Total length (metres) of roads that have at least one sidewalk lane. */
  sidewalk_length_m: z.number().optional(),
  roads_with_parking_lanes: z.number().optional(),
  /** Total length (metres) of roads with at least one parking lane. */
  parking_lane_length_m: z.number().optional(),
  signal_count: z.number().optional(),
  /** Breakdown of <signal> elements by category, classified from the name= attribute.
   *  RoadRunner uses MUTCD naming (Sign_R1-1 = stop, Signal_3Light_* = traffic light, etc.). */
  signal_breakdown: z.object({
    traffic_lights: z.number(),
    stop_signs: z.number(),
    yield_signs: z.number(),
    speed_limit_signs: z.number(),
    regulatory_signs: z.number().optional(),
    turn_restriction_signs: z.number().optional(),
    parking_signs: z.number().optional(),
    warning_signs: z.number().optional(),
    school_signs: z.number().optional(),
    street_name_signs: z.number().optional(),
    bus_stops: z.number(),
    stop_lines: z.number(),
    other_signs: z.number(),
    unknown: z.number(),
  }).optional(),
  crosswalk_count: z.number().optional(),
  parking_space_count: z.number().optional(),
  speed_limits_mph: z.array(z.number()).optional(),
  max_grade_pct: z.number().optional(),
  segments_above_4pct_grade: z.number().optional(),
  /** Total length (metres) of roads with net grade above 4%. */
  length_above_4pct_grade_m: z.number().optional(),
  /** Count of junctions by number of distinct incoming roads (road-level degree).
   *  Source: xodr <junction> <connection incomingRoad=> elements.
   *  Enables scenario queries like "maps with complex 5-way intersections". */
  junction_road_degree_counts: z.object({
    "2_or_fewer": z.number(),
    "3": z.number(),
    "4": z.number(),
    "5_plus": z.number(),
  }).optional(),
});
export type MapStatsRoadNetwork = z.infer<typeof MapStatsRoadNetworkSchema>;

export const MapStatsSignalizationSchema = z.object({
  // Count of <Junction> entries in the rrdata Signalization block. Each entry is
  // a RoadRunner scene-graph object assigned a traffic signal — NOT a 1:1 mapping
  // to xodr topological junctions (different ID space, count consistently exceeds
  // xodr junction count). Renamed from "signalized_junction_count" to avoid
  // implying correspondence with xodr <junction> elements. The former
  // "signalized_junction_ids" field was removed — those GUIDs are a third ID space
  // disconnected from both xodr junction id= integers and geojson Junction.Id
  // values, and cannot be joined to any other field in the metadata.
  signal_controlled_object_count: z.number().optional(),
  has_signal_phase_timing: z.boolean().optional(),
  signal_configurations_count: z.number().optional(),
  // Number of signalized junctions that have at least one <SignalPhase> child.
  // Present only when > 0 (i.e. when has_signal_phase_timing is true).
  junctions_with_phases: z.number().optional(),
  // Total <SignalPhase> blocks across all junctions. Each phase represents one
  // timed stage of a signal cycle (green/yellow/red intervals). Present only
  // when > 0.
  signal_phase_count: z.number().optional(),
});
export type MapStatsSignalization = z.infer<typeof MapStatsSignalizationSchema>;

export const MapStatsFeatureInventorySchema = z.object({
  junctions: z
    .object({
      // total: xodr topological junction count (from <junction> element count).
      // signal_controlled_objects and unsignalized are not included here — the
      // rrdata signal_controlled_object_count is a different ID space and cannot
      // be reliably joined to xodr junctions. See signalization block instead.
      total: z.number().optional(),
      // Junctions where at least one incoming or connecting road has a traffic
      // light signal. Computed by cross-referencing xodr <signal> elements on
      // incoming roads and connecting roads (via <connection incomingRoad=
      // connectingRoad=> pairs) with junction topology.
      signalized: z.number().optional(),
      // Junctions where at least one incoming or connecting road has a stop sign.
      stop_sign_controlled: z.number().optional(),
      // Junctions where ALL incoming approaches (degree >= 2) are covered by
      // stop signs (on incoming or their connecting roads).
      allway_stop: z.number().optional(),
    })
    .optional(),
  crosswalks: z
    .object({
      total: z.number().optional(),
      signalized: z.number().optional(),
      unsignalized: z.number().optional(),
    })
    .optional(),
  lanes: z
    .object({
      driving_total: z.number().optional(),
      bike_total: z.number().optional(),
      sidewalk_total: z.number().optional(),
      shoulder_total: z.number().optional(),
      parking_total: z.number().optional(),
    })
    .optional(),
  signals: z.number().optional(),
  traffic_lights: z.number().optional(),
  stop_signs: z.number().optional(),
  yield_signs: z.number().optional(),
  bus_stops: z.number().optional(),
  parking_spaces: z.number().optional(),
  turn_movements: z
    .object({
      straight: z.number().optional(),
      left: z.number().optional(),
      right: z.number().optional(),
      // U-turn variants — present on maps with divided roads or complex
      // intersections. Absent (undefined) on maps with no U-turn gates.
      uturn_left: z.number().optional(),
      uturn_right: z.number().optional(),
    })
    .optional(),
});
export type MapStatsFeatureInventory = z.infer<typeof MapStatsFeatureInventorySchema>;

/** Reverse-geocoded place context derived from map origin coordinates at upload time. */
export const MapPlaceContextSchema = z.object({
  /** City or municipality name (e.g. "Saratoga", "Munich"). */
  city: z.string().optional(),
  /** Admin-level-1 name: state, province, or region (e.g. "California", "Bavaria"). */
  state: z.string().optional(),
  /** Full country name (e.g. "United States"). */
  country: z.string().optional(),
  /** ISO 3166-1 alpha-2 country code (e.g. "US", "DE"). */
  country_code: z.string().optional(),
  /** Geocoder that produced this record. "manual" when overridden by a user. */
  geocoder: z.enum(["geonames-local", "manual"]).optional(),
});
export type MapPlaceContext = z.infer<typeof MapPlaceContextSchema>;

/** Computed map statistics (stored in `map_asset_stats`, also surfaced on MapAsset when loaded). */
export const MapStatsSchema = z.object({
  map_asset_id: z.string(),
  computed_at: z.string(),
  road_network: MapStatsRoadNetworkSchema.optional(),
  signalization: MapStatsSignalizationSchema.optional(),
  feature_inventory: MapStatsFeatureInventorySchema.optional(),
});
export type MapStats = z.infer<typeof MapStatsSchema>;
