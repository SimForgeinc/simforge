/**
 * Shapes of the raw per-map artifacts, as they actually are on disk.
 *
 * These are descriptions of foreign data, not contracts we control, so every
 * field that the real files were observed to omit is optional. Verified against
 * all five dev maps on 2026-07-31.
 */

/** `topology-index.json.gz` — the spatial spine. */
export interface TopologyIndex {
  schemaVersion: number;
  mapName: string;
  generatedAt?: string;
  source?: {
    xodrSha256?: string;
    generationTool?: string;
    generationToolVersion?: string;
    runtimeCatalogVersion?: string | null;
  };
  lanes: Record<string, TopologyLane>;
  gates: TopologyGate[];
  junctions: Record<string, TopologyJunction>;
  stats?: Record<string, unknown>;
}

/** A lane node in the topology index. Polylines are xodr-local metres. */
export interface TopologyLane {
  rsl: string;
  roadId: number;
  section: number;
  laneId: number;
  laneType: string;
  isJunction: boolean;
  junctionId: string | null;
  predecessors: string[];
  successors: string[];
  speedLimitKph: number | null;
  // The four fields below match what actually reaches this package. The builder
  // that writes topology-index.json declares them omittable, and the reference
  // lane of every road has no width samples at all, so it writes
  // `representativeWidthM: null`. This package's own readers already cope —
  // `representativeWidthM ?? 0`, `widthSamples` guarded by `!samples`,
  // `adjacentLanes?.[side]`, `laneChangePermissions ?? []` — and sim-engine's
  // equivalent TopologyLane has always declared them optional. This
  // declaration was the outlier, and it rejected valid on-disk indexes.
  representativeWidthM?: number | null;
  widthSamples?: { s: number; widthM: number }[];
  adjacentLanes?: {
    left?: TopologyAdjacency;
    right?: TopologyAdjacency;
  };
  laneChangePermissions?: TopologyLaneChangePermission[];
  polyline: { x: number; y: number }[];
}

/** Immediate drivable neighbour, as reported by the topology index. */
export interface TopologyAdjacency {
  side: 'left' | 'right';
  laneRsl: string | null;
  sameDirection: boolean;
  permissionIds: string[];
}

/** A lane-change permission interval. */
export interface TopologyLaneChangePermission {
  id: string;
  side: 'left' | 'right';
  startS: number;
  endS: number;
  allowed: boolean;
  marking?: string;
  source?: string;
}

/** A junction movement: approach lane → connecting lane → exit lane(s). */
export interface TopologyGate {
  id: string;
  junctionId: string;
  turnRelation: string;
  headingChangeRad: number;
  connectingLaneRsl: string;
  approachLaneRsl: string;
  exitLaneRsls: string[];
}

/** A junction in the topology index. */
export interface TopologyJunction {
  junctionId: string;
  gateIds: string[];
  internalLaneRsls: string[];
  approachLaneRsls: string[];
}

/** `search-index.json.gz` — the ~700 typed catalog objects to adopt. */
export interface SearchIndex {
  version: number;
  map_asset_id: string;
  built_at?: string;
  source_signatures?: Record<string, string>;
  objects: Record<string, SearchObject>;
  graph: { edges: SearchEdge[] };
}

/** One adopted catalog object. `kind` (not `type`) is the discriminator. */
export interface SearchObject {
  id: string;
  kind: string;
  name: string;
  /** `[lng, lat]`. */
  centroid: [number, number];
  /** `[minLng, minLat, maxLng, maxLat]`. */
  bbox: [number, number, number, number];
  candidate_id?: string;
  feature_refs?: { role: string; geojson_feature_id: number }[];
  anchor?: { object_id: string; distance_m: number };
  scenario_tags?: string[];
  facts?: Record<string, unknown>;
}

/** An adopted graph edge. */
export interface SearchEdge {
  from: string;
  to: string;
  relation: string;
  direction?: string;
}

/** Minimal GeoJSON shapes (the map artifacts are plain FeatureCollections). */
export interface GeoFeature<P = Record<string, unknown>> {
  type: 'Feature';
  id?: string | number;
  geometry: {
    type: string;
    coordinates: unknown;
  };
  properties: P;
}

/** A GeoJSON FeatureCollection. */
export interface GeoFeatureCollection<P = Record<string, unknown>> {
  type: 'FeatureCollection';
  features: GeoFeature<P>[];
}

/** Properties on `signals.geojson.gz` features. */
export interface SignalProperties {
  feature_kind?: string;
  id?: string;
  name?: string;
  source_name?: string;
  road_id?: string;
  s?: number;
  t?: number;
  signal_category?: string;
  dynamic?: string;
  mutcd_code?: string;
  sign_description?: string;
  sign_group?: string;
  street_name?: string;
  hdg?: number;
  z_offset?: number;
}

/** Properties on `lane-polygons.geojson.gz` features (carries the guid ↔ rsl join). */
export interface LanePolygonProperties {
  feature_kind?: string;
  Type?: string;
  LaneType?: string;
  road_id?: string;
  section_id?: number;
  lane_id?: number;
  is_junction?: boolean;
  lane_guid?: string;
}

/** Properties on the RoadRunner `map.geojson.gz` features. */
export interface MapGeojsonProperties {
  Type?: string;
  Id?: string;
  LaneType?: string;
  SpeedLimit?: string;
  TravelDir?: string;
  /** `[lng, lat, elevation]` on `Type=ParkingSpace`. */
  EntryPosition?: [number, number, number];
}

/** `enrichment/overlay-payload.json` — 15 Overture layers. */
export interface OverlayPayload {
  bbox?: { min_lat: number; min_lng: number; max_lat: number; max_lng: number };
  layers: OverlayLayer[];
}

/** One Overture layer. `data` is a FeatureCollection despite `feature_count`. */
export interface OverlayLayer {
  layer_id: string;
  label?: string;
  feature_count?: number;
  geometry_type?: string;
  data?: GeoFeatureCollection<OverlayFeatureProperties>;
}

/** Overture feature properties we read. */
export interface OverlayFeatureProperties {
  id?: string;
  overture_id?: string;
  layer_id?: string;
  name?: string | null;
  number?: string | null;
  street?: string | null;
  postcode?: string | null;
  region?: string | null;
  formatted?: string | null;
  building_id?: string | null;
  street_name?: string | null;
  road_access_lat?: number;
  road_access_lng?: number;
  road_access_distance_m?: number;
  road_access_road_name?: string | null;
}
