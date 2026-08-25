import type {
  CandidateLocation,
  MapAsset,
  MapAssetEnrichmentSnapshot,
} from "@simforge/studio-shared";
import type { MapRecord, Bounds } from "@/app/lib/runtime/map-data";
import type {
  CarlaSessionStatus,
  RuntimeMapResponse,
  RuntimeStreetFurnitureResponse,
} from "@/app/lib/runtime/runtime-types";

export type GeoJsonGeometry =
  | { type: "Point"; coordinates: [number, number] | [number, number, number] }
  | { type: "LineString"; coordinates: Array<[number, number] | [number, number, number]> }
  | { type: "Polygon"; coordinates: Array<Array<[number, number] | [number, number, number]>> }
  | { type: "MultiLineString"; coordinates: Array<Array<[number, number] | [number, number, number]>> }
  | {
      type: "MultiPolygon";
      coordinates: Array<Array<Array<[number, number] | [number, number, number]>>>;
    };

export type GeoJsonFeature = {
  type: "Feature";
  geometry: GeoJsonGeometry | null;
  properties?: Record<string, unknown> | null;
};

export type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
};

export type LocalPoint = {
  x: number;
  y: number;
};

export type LocationFeatureFlags = {
  has_stop_control: boolean;
  has_crosswalk: boolean;
  has_traffic_light: boolean;
  has_parking: boolean;
  has_sidewalk: boolean;
  has_bike_lane: boolean;
  road_markings: string[];
  signal_categories: string[];
};

export type ApproachRoad = {
  road_id: string;
  name: string;
  bearing: string;
  lane_config: string;
  lane_types: string[];
  length_m: number;
};

export type MapLocation = {
  id: string;
  source:
    | "semantic_feature"
    | "semantic_approach"
    | "semantic_movement"
    | "simcloud_candidate"
    | "geojson_junction"
    | "geojson_crosswalk"
    | "fallback_road_cluster";
  kind: string;
  classification: string;
  label: string;
  description: string;
  bridge: "guid" | "spatial" | "mixed" | "heuristic";
  road_ids: string[];
  road_count: number;
  bounds: Bounds;
  center: LocalPoint | null;
  tags: string[];
  evidence: Array<Record<string, unknown>>;
  feature_flags: LocationFeatureFlags;
  approaches?: ApproachRoad[];
  junction_id?: string;
  related_lane_guids?: string[];
  related_feature_ids?: string[];
  related_road_names?: string[];
};

export type BridgeIndexSummary = {
  lane_guid_count: number;
  candidate_location_count: number;
  derived_location_count: number;
};

export type BridgedMapBundle = {
  asset: MapAsset;
  bundle_version: string | null;
  runtime_bundle_key: string | null;
  candidate_locations: CandidateLocation[];
  enrichment: MapAssetEnrichmentSnapshot | null;
  geojson: GeoJsonFeatureCollection;
  geojson_url: string | null;
  signals_geojson: GeoJsonFeatureCollection | null;
  generated: MapRecord | null;
  runtime: RuntimeMapResponse | null;
  xodr: string | null;
  street_furniture: RuntimeStreetFurnitureResponse | null;
  locations: MapLocation[];
  bridge_summary: BridgeIndexSummary;
  carla_status: CarlaSessionStatus;
  map_match: boolean;
};

export type RuntimeRoadOverlayFeature = {
  type: "Feature";
  geometry:
    | {
        type: "LineString";
        coordinates: Array<[number, number]>;
      }
    | {
        type: "Polygon";
        coordinates: Array<Array<[number, number]>>;
      };
  properties: {
    road_id: string;
    label: string;
    feature_kind: "lane_centerline" | "lane_boundary" | "surface" | "driving_surface";
    lane_type?: string | null;
    section_id?: number | null;
    lane_id?: number | null;
    boundary_kind?: "center" | "divider" | "edge" | null;
    /**
     * Whether an actor may be placed on this lane.
     *
     * The overlay draws the whole road surface, including the sidewalk,
     * shoulder, parking and bike lanes CARLA's driving-only crawl never binds.
     * Those are scenery, not spawn targets, and `runtimeLaneSelection` refuses
     * them. Absent reads as placeable so older payloads behave as before.
     */
    runtime_bound?: boolean;
    is_junction?: boolean;
    /**
     * Whether the lane is DRIVEN in the direction of increasing `s`.
     *
     * The `centerline` below is always in +s order, which says nothing about
     * which way traffic runs along it. Anything deriving a heading from the
     * centerline must consult this or it will face cars the wrong way on every
     * against-+s lane.
     */
    travel_increases_s?: boolean;
    lane_change?: string | null;
    /** Lane width in metres; the browser rebuilds the ribbon from it. */
    lane_width?: number | null;
    /** Whether CARLA/OpenDRIVE exposes a directed continuation for this lane. */
    has_successor?: boolean;
    successor_count?: number;
    predecessor_count?: number;
    successor_rsls?: string[];
    left_lane_rsl?: string | null;
    right_lane_rsl?: string | null;
    turn_relations?: string[];
    source: "runtime";
    dashed?: boolean;
    is_selected: boolean;
    /**
     * Projected exact CARLA lane centerline ([lng, lat]). Width-aware Polygon
     * features carry it in properties; compact whole-map LineStrings carry it
     * directly in geometry.
     */
    centerline?: Array<[number, number]>;
  };
};

export type RuntimeRoadOverlayCollection = {
  type: "FeatureCollection";
  features: RuntimeRoadOverlayFeature[];
};

export type EditorRuntimeRoadOverlay = {
  data: RuntimeRoadOverlayCollection;
  selected_road_ids: string[];
  current_location_id: string | null;
};

export type RuntimeLaneSelection = {
  road_id: string;
  section_id: number | null;
  lane_id: number | null;
  lane_type: string | null;
  label: string;
  is_junction: boolean;
  coordinates: Array<[number, number]>;
  selected_point: [number, number];
  selected_fraction: number;
};

export type LocationSearchInput = {
  features?: string[];
  kinds?: string[];
  tags?: string[];
  text?: string;
  junction_type?: string;
  lane_types?: string[];
  has_parking?: boolean;
  has_sidewalk?: boolean;
  has_bike_lane?: boolean;
  has_stop_control?: boolean;
  has_crosswalk?: boolean;
  has_traffic_light?: boolean;
  name_contains?: string;
  max_results?: number;
};

export type ListLocationsInput = {
  kinds?: string[];
  classifications?: string[];
  tags?: string[];
  has_parking?: boolean;
  has_sidewalk?: boolean;
  has_bike_lane?: boolean;
  has_stop_control?: boolean;
  has_crosswalk?: boolean;
  has_traffic_light?: boolean;
  road_name_contains?: string;
  limit?: number;
};

export type LocationCatalogItem = {
  id: string;
  label: string;
  kind: string;
  classification: string;
  tags: string[];
  feature_flags: LocationFeatureFlags;
  road_count: number;
  related_road_names?: string[];
};

export type LocationCatalogFacet = {
  value: string;
  count: number;
  examples: string[];
};

export type LocationCatalogFacets = {
  kinds: LocationCatalogFacet[];
  classifications: LocationCatalogFacet[];
  tags: LocationCatalogFacet[];
};

export type LocationCatalogResult = {
  total_locations: number;
  options: LocationCatalogOption[];
};

export type LocationCatalogOption = {
  selector: string;
  selector_type: "kind" | "classification" | "tag";
  count: number;
  examples: string[];
};

export type GetLocationInput = {
  location_id?: string;
  selectors?: string[];
  limit?: number;
};
