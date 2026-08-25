import { z } from "zod";

/**
 * Map search index ("sidecar") schema.
 *
 * One versioned JSON artifact per map, built at upload time (and refreshed
 * after third-party enrichment completes). Owns the canonical per-object
 * model of the map — junctions, streets, street segments, POIs — along with
 * scalar facts, feature references into the source GeoJSON / candidate rows,
 * centroids / bboxes for spatial lookup, and a graph for topology queries.
 *
 * Consumers:
 *   - Map search (corpus builder reads this directly; no query-time geometry
 *     parsing).
 *   - CARLA scenario autogeneration (downstream; XODR-derived IDs so a search
 *     result is directly addressable in CARLA's input geometry).
 *   - Future Phase B (proximity) and Phase C (topology) operators.
 *
 * The sidecar does NOT own geometry. It holds IDs, centroids, and bboxes.
 * Authoritative geometry lives in the uploaded GeoJSON (for road-network
 * features) and in `map_candidate_locations` rows (for detector-built
 * composites like parking-lot polygons and crosswalk clusters).
 */

export const MAP_SEARCH_INDEX_VERSION = 1;

/**
 * Road hierarchy vocabulary — the OSM `highway=*` classes as carried on
 * Overture `transportation/segment.class`, restricted to the drivable set the
 * enrichment query ingests. Ordered most→least major.
 */
export const OSM_ROAD_CLASSES = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "unclassified",
] as const;
export type OsmRoadClass = (typeof OSM_ROAD_CLASSES)[number];

// ── Source signatures ───────────────────────────────────────────────────────
// Recorded at build time to help identify when a sidecar is stale relative
// to its inputs. Cheap fingerprint, not a full revision graph.

export const MapSearchIndexSourceSignaturesSchema = z.object({
  geojson_sha256: z.string().nullable().optional(),
  xodr_sha256: z.string().nullable().optional(),
  rrdata_sha256: z.string().nullable().optional(),
  candidates_revision: z.string().nullable().optional(),
  enrichment_revision: z.string().nullable().optional(),
});
export type MapSearchIndexSourceSignatures = z.infer<
  typeof MapSearchIndexSourceSignaturesSchema
>;

// ── Feature references ──────────────────────────────────────────────────────
// Every canonical object can point back to constituent features in either the
// uploaded road-network GeoJSON or in the signal overlay. The `role` enumerates
// what each feature contributes to the object (polygon, internal lane, access
// point, etc.). Parking lots deliberately expose only `access_point` roles —
// their aggregated polygon lives in candidate_locations and is referenced via
// `candidate_id` at the object level.

export const MapSearchIndexFeatureRoleSchema = z.enum([
  "junction_polygon",
  "internal_lane",
  "approach_gate",
  "driving_lane",
  "access_point",
  "crosswalk_marking",
  "signal_feature",
]);
export type MapSearchIndexFeatureRole = z.infer<
  typeof MapSearchIndexFeatureRoleSchema
>;

export const MapSearchIndexFeatureRefSchema = z.object({
  role: MapSearchIndexFeatureRoleSchema,
  /**
   * Index into the sidecar's root `geojson_feature_uuids` array — also the
   * feature's array position in the source GeoJSON. Resolving a ref to its
   * stable RoadRunner UUID is `index.geojson_feature_uuids[geojson_feature_id]`,
   * which lets consumers identify the feature without the source GeoJSON loaded.
   */
  geojson_feature_id: z.number().optional(),
  /** Opaque feature id for the signals overlay GeoJSON. */
  signal_feature_id: z.string().optional(),
});
export type MapSearchIndexFeatureRef = z.infer<
  typeof MapSearchIndexFeatureRefSchema
>;

// ── Spatial primitives ──────────────────────────────────────────────────────
// Centroids are [lng, lat] in WGS84 (matches GeoJSON ordering). Bboxes are
// [min_lng, min_lat, max_lng, max_lat], also WGS84.

export const MapSearchIndexCentroidSchema = z.tuple([
  z.number(), // lng
  z.number(), // lat
]);
export type MapSearchIndexCentroid = z.infer<
  typeof MapSearchIndexCentroidSchema
>;

export const MapSearchIndexBboxSchema = z.tuple([
  z.number(), // min_lng
  z.number(), // min_lat
  z.number(), // max_lng
  z.number(), // max_lat
]);
export type MapSearchIndexBbox = z.infer<typeof MapSearchIndexBboxSchema>;

// ── Anchors ─────────────────────────────────────────────────────────────────
// POIs anchor to a junction or street/segment so topology queries can reach
// them. Distance in meters helps rank "closest to road" candidates.

export const MapSearchIndexAnchorSchema = z.object({
  /** Canonical object id, e.g. `junction:J18` or `street:R22`. */
  object_id: z.string(),
  distance_m: z.number(),
});
export type MapSearchIndexAnchor = z.infer<typeof MapSearchIndexAnchorSchema>;

// ── Facts ───────────────────────────────────────────────────────────────────
// Flat scalar blocks per object kind. Every fact in every block must be a
// primitive (string / number / boolean) or a string[] — no nested objects.
// This keeps the searchText derivation trivial, survives JSON round-tripping,
// and stays Fuse.js-indexable when Phase 2 lands.

export const MapSearchIndexJunctionFactsSchema = z
  .object({
    approach_count: z.number().optional(),
    leg_label: z.enum(["3-leg", "4-way", "multi-leg"]).optional(),
    control_type: z
      .enum(["uncontrolled", "stop", "all_way_stop", "traffic_light"])
      .optional(),
    complexity_class: z.enum(["simple", "standard", "complex"]).optional(),
    /** Polygon-area bucket for the junction footprint. Independent of POI size_class. */
    size_class: z.enum(["small", "medium", "large"]).optional(),
    is_t_intersection: z.boolean().optional(),
    has_signal: z.boolean().optional(),
    has_stop_sign: z.boolean().optional(),
    is_all_way_stop: z.boolean().optional(),
    connected_road_names: z.array(z.string()).optional(),
    // ── Scenario affordances (Phase C+) ─────────────────────────────────────
    /** An unprotected left turn is plausible here (uncontrolled ≥3-leg junction). */
    unprotected_left_candidate: z.boolean().optional(),
    /** At least one parking lot anchors to this junction — a vehicle can egress here. */
    parking_lot_egress: z.boolean().optional(),
    /** Vehicles can spawn here (true for every junction). */
    vehicle_spawn: z.boolean().optional(),
    /** Pedestrians can spawn here (derived from crosswalks or near-junction sidewalks). */
    pedestrian_spawn: z.boolean().optional(),
    /** Cyclists can spawn here (junction is on a bike-lane-bearing street). */
    cyclist_spawn: z.boolean().optional(),
    /** True when at least one approach road has `bike_lane_present`. Same predicate as `cyclist_spawn` today; kept distinct so query language can target adjacency without coupling to spawn semantics. */
    bike_lane_adjacent: z.boolean().optional(),
  })
  .passthrough();
export type MapSearchIndexJunctionFacts = z.infer<
  typeof MapSearchIndexJunctionFactsSchema
>;

export const MapSearchIndexStreetFactsSchema = z
  .object({
    resolved_name: z.string().optional(),
    length_m: z.number().optional(),
    lane_count: z.number().optional(),
    lane_count_class: z.enum(["single-lane", "multi-lane"]).optional(),
    speed_class: z.enum(["low", "medium", "high"]).optional(),
    /** Posted maximum speed limit in mph, from the matching Overture road
     *  segment's `speed_limits` attribute. The `overture_` prefix marks the
     *  provenance: third-party map data, empirically not guaranteed correct,
     *  so it never feeds derived classifications (`speed_class` stays the
     *  XODR design-speed bucket). Absent when no name-matching segment
     *  carries a limit. */
    overture_speed_limit_mph: z.number().optional(),
    width_class: z.enum(["narrow", "medium", "wide"]).optional(),
    bike_lane_present: z.boolean().optional(),
    parking_present: z.boolean().optional(),
    /** Both the left and right lane sets carry parking lanes for ≥50% of the road's `<laneSection>`s. */
    parking_both_sides: z.boolean().optional(),
    sidewalk_present: z.boolean().optional(),
    grade_class: z.enum(["flat", "moderate", "steep"]).optional(),
    crest_present: z.boolean().optional(),
    /**
     * Road curvature bucket derived from XODR arc/spiral geometry.
     *   - straight : max curvature < 0.005 (radius > 200 m)
     *   - curved   : 0.005 ≤ curvature < 0.02 (radius 50–200 m)
     *   - sharp    : curvature ≥ 0.02 (radius < 50 m — tight turns)
     * Only arcs/spirals longer than ~10 m contribute, so tiny junction
     * transition arcs don't tag an otherwise-straight road as sharp.
     */
    curvature_class: z.enum(["straight", "curved", "sharp"]).optional(),
    /** Minimum turning radius (m) over the road's geometry. */
    min_radius_m: z.number().optional(),
    // ── Scenario affordances (Phase C+) ─────────────────────────────────────
    /** Road hierarchy in the OSM/Overture `class` vocabulary. Sourced from the
     *  name-matching Overture segments when available; otherwise derived from
     *  XODR speed/lanes, mapped conservatively (arterial→secondary,
     *  collector→tertiary, local→residential) so motorway/trunk/primary can
     *  only come from real Overture data. */
    road_class: z.enum(OSM_ROAD_CLASSES).optional(),
    /** True when a parking-lot POI anchors to this street — vehicle can egress onto it. */
    parking_lot_egress: z.boolean().optional(),
    /** Reserved for lane-continuity detection. Unset until Phase D. */
    merge_zone: z.boolean().optional(),
    /** Vehicles can spawn on this street (true for every driving street). */
    vehicle_spawn: z.boolean().optional(),
    /** Pedestrians can spawn here (sidewalk_present). */
    pedestrian_spawn: z.boolean().optional(),
    /** Cyclists can spawn here (bike_lane_present). */
    cyclist_spawn: z.boolean().optional(),
  })
  .passthrough();
export type MapSearchIndexStreetFacts = z.infer<
  typeof MapSearchIndexStreetFactsSchema
>;

export const MapSearchIndexSegmentFactsSchema = MapSearchIndexStreetFactsSchema;
export type MapSearchIndexSegmentFacts = z.infer<
  typeof MapSearchIndexSegmentFactsSchema
>;

export const MapSearchIndexPoiFactsSchema = z
  .object({
    poi_type: z.string().optional(),
    space_count: z.number().optional(),
    access_point_count: z.number().optional(),
    access_point_count_estimated: z.number().optional(),
    is_signalized: z.boolean().optional(),
    is_marked: z.boolean().optional(),
    /**
     * Parking-lot only. Size bucket derived from `space_count` so natural-
     * language queries like `small parking lot` or `large parking lot` can
     * match without users needing to guess space counts.
     *   - small  : < 30 spaces
     *   - medium : 30–200 spaces
     *   - large  : > 200 spaces
     */
    size_class: z.enum(["small", "medium", "large"]).optional(),
    // ── Occlusion-only facts ────────────────────────────────────────────────
    // Set on POI objects with `kind === "occlusion"`. Subtype + severity drive
    // search ranking / filter chips; the supporting flags are kept flat so the
    // sidecar facts contract (no nested objects) holds and Fuse.js can index
    // them as scalar booleans.
    occlusion_subtype: z
      .enum([
        "CURVE_OCCLUSION",
        "CREST_OCCLUSION",
        "PARKING_NEAR_CONFLICT_POINT",
        "NARROW_BUILDING_CORRIDOR",
        "COMMERCIAL_DELIVERY_OCCLUSION",
        "BUS_STOP_OCCLUSION",
      ])
      .optional(),
    severity: z.enum(["low", "medium", "high"]).optional(),
    confidence: z.number().optional(),
    crosswalk_nearby: z.boolean().optional(),
    intersection_nearby: z.boolean().optional(),
    parking_nearby: z.boolean().optional(),
    bus_stop_nearby: z.boolean().optional(),
    commercial_nearby: z.boolean().optional(),
    narrow_road: z.boolean().optional(),
    high_curvature: z.boolean().optional(),
    crest_detected: z.boolean().optional(),
    supported_scenario_templates: z.array(z.string()).optional(),
    // ── Scenario affordances ─────────────────────────────────────────────────
    /**
     * The POI is inherently a pedestrian-spawn location given its kind —
     * see `isPedestrianSpawnCandidate` in `shared/enrichment/pedestrian-spawn`
     * for the authoritative set. Surfaces to the LLM through the existing
     * `semantic: ["pedestrian_spawn"]` alias (no client-side substring
     * matching) and to the scenario builder through `GeometryReport`.
     */
    pedestrian_spawn: z.boolean().optional(),
  })
  .passthrough();
export type MapSearchIndexPoiFacts = z.infer<
  typeof MapSearchIndexPoiFactsSchema
>;

// ── Canonical objects ───────────────────────────────────────────────────────
// Discriminated by `kind`. Junction, street, street_segment, and several POI
// kinds. Every object carries at minimum a canonical id, centroid, and name;
// facts are kind-specific.

const MapSearchIndexObjectBaseSchema = z.object({
  /** Canonical id — e.g. `junction:J7`, `street:R12`, `segment:R12:0-120`, `poi:parking_lot:...`. */
  id: z.string(),
  /** Display label — resolved street name for streets/junctions when available, else fallback. */
  name: z.string(),
  /** Scenario-relevance tags (from candidate tags if candidate-backed). */
  scenario_tags: z.array(z.string()).optional(),
  /** Candidate-row id if this object is backed by a detector-built candidate. */
  candidate_id: z.string().optional(),
  /** Canonical id (`junction:...` / `street:...` / `segment:...`) this POI anchors to. */
  anchor: MapSearchIndexAnchorSchema.optional(),
  feature_refs: z.array(MapSearchIndexFeatureRefSchema).default([]),
  centroid: MapSearchIndexCentroidSchema,
  bbox: MapSearchIndexBboxSchema.optional(),
});

export const MapSearchIndexJunctionObjectSchema =
  MapSearchIndexObjectBaseSchema.extend({
    kind: z.literal("junction"),
    facts: MapSearchIndexJunctionFactsSchema.default({}),
  });

export const MapSearchIndexStreetObjectSchema =
  MapSearchIndexObjectBaseSchema.extend({
    kind: z.literal("street"),
    facts: MapSearchIndexStreetFactsSchema.default({}),
  });

export const MapSearchIndexSegmentObjectSchema =
  MapSearchIndexObjectBaseSchema.extend({
    kind: z.literal("street_segment"),
    /** Canonical id of the parent street. */
    parent: z.string(),
    facts: MapSearchIndexSegmentFactsSchema.default({}),
  });

export const MapSearchIndexPoiKindSchema = z.enum([
  "bus_stop",
  "school_frontage",
  "hospital_approach",
  "gas_station_approach",
  "parking_lot",
  "parking_cluster",
  "street_parking",
  "crosswalk_zone",
  // Pedestrian corridor (Overture footway segments today, in-house RoadRunner
  // sidewalks once that ingestion lands). 1:1 with the CandidateLocation
  // kind — no historical rename to preserve.
  "sidewalk_segment",
  "road_segment_feature",
  // Commercial POIs — sidecar kinds match the candidate kinds 1:1 (no rename
  // needed since neither family had a bus_stop_corridor → bus_stop style
  // historical mismatch to preserve).
  "retail_frontage",
  "restaurant_frontage",
  "hotel_approach",
  "airport_approach",
  "shopping_mall_approach",
  "transit_stop_corridor",
  // Occlusion-likelihood candidates (curve, crest, parking-near-conflict,
  // narrow building corridor, commercial delivery, bus stop). One sidecar
  // kind covers all six subtypes; the subtype lives on facts so a single
  // family chip in the search UI can fan out by severity / subtype filter.
  "occlusion",
]);
export type MapSearchIndexPoiKind = z.infer<
  typeof MapSearchIndexPoiKindSchema
>;

export const MapSearchIndexPoiObjectSchema =
  MapSearchIndexObjectBaseSchema.extend({
    kind: MapSearchIndexPoiKindSchema,
    facts: MapSearchIndexPoiFactsSchema.default({}),
  });

// ── Address object ──────────────────────────────────────────────────────────
// Overture address points, lifted into the sidecar so natural-language queries
// like "200 Main St" resolve to a known location AND so two-hop queries like
// "3-way junction near 200 Main St" can use the address as a spatial anchor.
//
// Carries the address text (matched by the search corpus), the road-access
// snap that turns the address into a callable point on a drivable surface,
// and an optional anchor to the address's enclosing building or its frontage
// street so topology queries can two-hop without proximity scans.

export const MapSearchIndexAddressFactsSchema = z
  .object({
    /** Postal-formatted address ("200 Main St, Palo Alto, CA, 94301"). */
    formatted: z.string(),
    /** Component fields, present when Overture had them. */
    number: z.string().nullable().optional(),
    street: z.string().nullable().optional(),
    postcode: z.string().nullable().optional(),
    locality: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    /**
     * Closest named drivable Overture road segment to (lat,lng). Lets queries
     * like "address on Main St" or "anything on Main St" pivot off the
     * address's frontage road without a proximity hop. Null when the address
     * sits more than the proximity radius from any named road.
     */
    road_access_road_name: z.string().nullable().optional(),
    road_access_distance_m: z.number().nullable().optional(),
    /**
     * When the address point falls inside an Overture building footprint,
     * the building's id and name are mirrored here for join-free lookups
     * ("address X is at <building name>"). The building↔address relationship
     * runs in BOTH directions in the data: the building row carries
     * primary_address (closest-to-centroid address), addresses carry
     * building_id (the enclosing footprint).
     */
    building_id: z.string().nullable().optional(),
    building_name: z.string().nullable().optional(),
  })
  .passthrough();
export type MapSearchIndexAddressFacts = z.infer<
  typeof MapSearchIndexAddressFactsSchema
>;

export const MapSearchIndexAddressObjectSchema =
  MapSearchIndexObjectBaseSchema.extend({
    kind: z.literal("address"),
    facts: MapSearchIndexAddressFactsSchema,
  });
export type MapSearchIndexAddressObject = z.infer<
  typeof MapSearchIndexAddressObjectSchema
>;

export const MapSearchIndexObjectSchema = z.discriminatedUnion("kind", [
  MapSearchIndexJunctionObjectSchema,
  MapSearchIndexStreetObjectSchema,
  MapSearchIndexSegmentObjectSchema,
  MapSearchIndexPoiObjectSchema,
  MapSearchIndexAddressObjectSchema,
]);
export type MapSearchIndexObject = z.infer<typeof MapSearchIndexObjectSchema>;

// ── Graph ───────────────────────────────────────────────────────────────────
// Directed edges between canonical objects. Populated in Phase C to drive
// topology operators (`leads_to`, `connected_to`, `upstream_of`,
// `downstream_of`). Edges are always undirected-by-default (`direction: both`)
// — directional flow is reserved for future lane-level data.
//
// `relation` describes the kind of connection:
//   - `approaches`  : junction ↔ street (XODR `<link>` predecessor/successor)
//   - `adjacent_to` : same-road neighboring segments (reserved for segment-level)
//   - `anchors_to`  : POI → its anchor object (generic fallback)
//   - `accesses`    : parking lot / driveway → its anchor street (POI→street)

export const MapSearchIndexGraphRelationSchema = z.enum([
  "approaches",
  "adjacent_to",
  "anchors_to",
  "accesses",
]);
export type MapSearchIndexGraphRelation = z.infer<
  typeof MapSearchIndexGraphRelationSchema
>;

export const MapSearchIndexGraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  relation: MapSearchIndexGraphRelationSchema,
  direction: z.enum(["in", "out", "both"]).default("both"),
  /** Hop distance in meters. Used to cap BFS during traversal. */
  distance_m: z.number().optional(),
  length_m: z.number().optional(),
});
export type MapSearchIndexGraphEdge = z.infer<
  typeof MapSearchIndexGraphEdgeSchema
>;

export const MapSearchIndexGraphSchema = z.object({
  edges: z.array(MapSearchIndexGraphEdgeSchema).default([]),
});
export type MapSearchIndexGraph = z.infer<typeof MapSearchIndexGraphSchema>;

// ── Root ────────────────────────────────────────────────────────────────────

export const MapSearchIndexSchema = z.object({
  version: z.literal(MAP_SEARCH_INDEX_VERSION),
  map_asset_id: z.string(),
  built_at: z.string(),
  source_signatures: MapSearchIndexSourceSignaturesSchema,
  /**
   * Per-feature stable UUIDs from the source GeoJSON, in array order.
   * Position N = `properties.Id` of feature N (the RoadRunner-stamped UUID,
   * braces preserved). `feature_refs.geojson_feature_id` is an index into
   * this array. Empty (`[]`) on legacy sidecars built before this field was
   * added — frontends should fall back to walking the GeoJSON in array order.
   */
  geojson_feature_uuids: z.array(z.string()).default([]),
  /** Keyed by canonical object id. */
  objects: z.record(z.string(), MapSearchIndexObjectSchema),
  graph: MapSearchIndexGraphSchema.default({ edges: [] }),
});
export type MapSearchIndex = z.infer<typeof MapSearchIndexSchema>;

// ── Canonical id helpers ────────────────────────────────────────────────────
// Tight wrappers so all producers and consumers agree on the format.

export function junctionObjectId(xodrJunctionId: string): string {
  return `junction:${xodrJunctionId}`;
}

export function streetObjectId(xodrRoadId: string): string {
  return `street:${xodrRoadId}`;
}

export function segmentObjectId(
  xodrRoadId: string,
  sStart: number,
  sEnd: number,
): string {
  return `segment:${xodrRoadId}:${Math.round(sStart)}-${Math.round(sEnd)}`;
}

export function poiObjectId(kind: MapSearchIndexPoiKind, slug: string): string {
  return `poi:${kind}:${slug}`;
}

export function addressObjectId(slug: string): string {
  return `address:${slug}`;
}
