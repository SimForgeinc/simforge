import { z } from "zod";
import { BboxSchema } from "@simforge-oss/scenario/contracts";

// ── Source discriminator ────────────────────────────────────────────────────

export const CANDIDATE_LOCATION_SOURCES = [
  "geojson_junction",
  "geojson_crosswalk",
  "geojson_street_parking",
  "overture_bus_stop",
  "overture_school",
  "overture_hospital",
  "overture_gas_station",
  "overture_parking",
  "overture_crosswalk",
  // Overture footway/sidewalk segments (subclass=sidewalk). Dual-source
  // backfill against in-house `sidewalk_segment` candidates, same pattern
  // as `overture_crosswalk` — the corpus-builder dedupes geometry before
  // merging so in-house data wins on overlap.
  "overture_sidewalk",
  // Commercial-POI sources (PR-138 follow-up to the dual-source crosswalks
  // work). One source per Overture overlay layer that didn't previously
  // generate candidates — search and Scenario Insights both key off
  // CandidateLocation.
  "overture_retail",
  "overture_restaurant",
  "overture_hotel",
  "overture_airport",
  "overture_shopping_mall",
  "overture_transit_stop",
  "manual",
  // Detector-based sources (map intelligence pipeline)
  "detector_intersection",
  "detector_crosswalk",
  "detector_parking",
  "detector_road",
  "detector_turn",
  // Real-world accident / near-miss data (scenario intelligence pipeline)
  "ca_av_collision",
  // Occlusion-likelihood detectors. One source per subtype so each
  // detector's output can be idempotently delete-and-replaced without
  // disturbing siblings — same pattern as `overture_*` per layer.
  "detector_occlusion_curve",
  "detector_occlusion_crest",
  "detector_occlusion_parking_conflict",
  "detector_occlusion_narrow_corridor",
  "detector_occlusion_commercial_delivery",
  "detector_occlusion_bus_stop",
] as const;

export const CandidateLocationSourceSchema = z.enum(CANDIDATE_LOCATION_SOURCES);
export type CandidateLocationSource = z.infer<typeof CandidateLocationSourceSchema>;

// ── Kind discriminator ──────────────────────────────────────────────────────

export const CANDIDATE_LOCATION_KINDS = [
  // Artifact-derived
  "junction",
  "crosswalk_zone",
  "parking_cluster",
  "parking_lot",
  "street_parking",
  "road_segment",
  // Linear pedestrian corridor. One per Overture footway segment (or one per
  // in-house RoadRunner sidewalk lane once that ingestion lands). Geometry
  // is a polyline parallel to a road; region ships as the segment's BBOX.
  "sidewalk_segment",
  // Overture-derived
  "bus_stop_corridor",
  "school_frontage",
  "hospital_approach",
  "gas_station_approach",
  // Commercial-POI Overture-derived (PR-138 follow-up). Naming follows the
  // existing pattern: storefront-scale POIs use `_frontage`, larger drop-off /
  // entry zones use `_approach`, and transit hubs match the `_corridor` suffix
  // used by `bus_stop_corridor` since the semantic is identical (waiting +
  // dwell zone adjacent to a transit pickup point).
  "retail_frontage",
  "restaurant_frontage",
  "hotel_approach",
  "airport_approach",
  "shopping_mall_approach",
  "transit_stop_corridor",
  // Accident / near-miss pipeline
  "av_collision_point",
  // Occlusion-likelihood candidates. Single kind across all six subtypes; the
  // specific category lives on `occlusion.subtype` so consumers (LLM
  // retrieval, debug overlays) can filter without an enum explosion.
  "occlusion",
] as const;

export const CandidateLocationKindSchema = z.enum(CANDIDATE_LOCATION_KINDS);
export type CandidateLocationKind = z.infer<typeof CandidateLocationKindSchema>;

// ── Evidence ─────────────────────────────────────��──────────────────────────
// Typed detector evidence for the map intelligence pipeline.
// Importing here creates a circular reference, so we inline the shape.

export const CandidateLocationEvidenceSchema = z.object({
  detectorId: z.string(),
  detectorVersion: z.string(),
  primitives: z.record(z.union([z.number(), z.boolean(), z.string()])),
  confidence: z.number().min(0).max(1),
  matchedTags: z.array(z.string()),
  explanation: z.string(),
});
export type CandidateLocationEvidence = z.infer<typeof CandidateLocationEvidenceSchema>;

// ── Region geometry ─────────────────────────────────────────────────────────
// Discriminated union supporting multiple geometry types.
// Start with BBOX (most extractors) + Polygon (for irregular shapes like
// school zones or future road geometry). Point is included for completeness.

export const RegionBboxSchema = z.object({
  type: z.literal("BBOX"),
  bbox: BboxSchema,
});

export const RegionPolygonSchema = z.object({
  type: z.literal("Polygon"),
  /** GeoJSON-style [lng, lat] coordinate rings. Outer ring first, then holes. */
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
});

export const RegionPointSchema = z.object({
  type: z.literal("Point"),
  /** [lng, lat] */
  coordinates: z.tuple([z.number(), z.number()]),
});

/**
 * LineString region — a polyline of [lng, lat] vertices. Used for inherently
 * linear candidates like Overture sidewalks, where the geometry is a centerline
 * along a road and collapsing to BBOX (the prior fallback for line features)
 * produces a misleading 200 m square that covers half the map.
 *
 * Downstream consumers (clustering, search index POI bbox, frontend renderer)
 * derive a bbox from the vertices when needed, but the canonical geometry stays
 * on the candidate so the LLM scenario creator can sample pedestrian spawn
 * points along the actual sidewalk line.
 */
export const RegionLineStringSchema = z.object({
  type: z.literal("LineString"),
  /** GeoJSON-style [lng, lat] coordinate pairs in order along the line. */
  coordinates: z.array(z.tuple([z.number(), z.number()])),
});

export const CandidateLocationRegionSchema = z.discriminatedUnion("type", [
  RegionBboxSchema,
  RegionPolygonSchema,
  RegionPointSchema,
  RegionLineStringSchema,
]);

export type CandidateLocationRegion = z.infer<typeof CandidateLocationRegionSchema>;

// ── Occlusion enums ─────────────────────────────────────────────────────────
// Subtype + severity for the occlusion-likelihood detectors. The detectors
// emit these onto the standard CandidateLocation envelope:
//   • subtype       → tags (e.g. "OCCLUSION_CURVE") + primitives.occlusion_subtype
//   • severity      → primitives.severity
//   • supporting    → primitives.{crosswalk_nearby, intersection_nearby, …}
//   • templates     → primitives.supported_scenario_templates_json (stringified)
// No dedicated CandidateLocation field — same shape contract as every other
// kind in the table.

export const OCCLUSION_SUBTYPES = [
  "CURVE_OCCLUSION",
  "CREST_OCCLUSION",
  "PARKING_NEAR_CONFLICT_POINT",
  "NARROW_BUILDING_CORRIDOR",
  "COMMERCIAL_DELIVERY_OCCLUSION",
  "BUS_STOP_OCCLUSION",
] as const;
export const OcclusionSubtypeSchema = z.enum(OCCLUSION_SUBTYPES);
export type OcclusionSubtype = z.infer<typeof OcclusionSubtypeSchema>;

export const OcclusionSeveritySchema = z.enum(["low", "medium", "high"]);
export type OcclusionSeverity = z.infer<typeof OcclusionSeveritySchema>;

/**
 * Detector input type — surfaced to detectors so they can name supporting
 * conditions consistently. Not stored as a field on CandidateLocation;
 * `makeOcclusionCandidate` flattens these into evidence primitives.
 */
export type OcclusionSupportingFeatures = {
  crosswalkNearby?: boolean;
  intersectionNearby?: boolean;
  parkingNearby?: boolean;
  busStopNearby?: boolean;
  commercialNearby?: boolean;
  narrowRoad?: boolean;
  highCurvature?: boolean;
  crestDetected?: boolean;
};

// ── Main type ───────────────────────────────────────────────────────────────

export const CandidateLocationSchema = z.object({
  id: z.string(),
  map_asset_id: z.string(),
  kind: CandidateLocationKindSchema,
  source: CandidateLocationSourceSchema,
  label: z.string(),
  description: z.string().optional(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()),
  evidence: z.array(CandidateLocationEvidenceSchema),
  region: CandidateLocationRegionSchema,
  center: z.object({ lat: z.number(), lng: z.number() }),
  /** Tags this location is relevant for, from detector output. */
  scenarioTags: z.array(z.string()).optional(),
  /** Scene entity this candidate is anchored to. */
  anchorEntityId: z.string().optional(),
  /** Rank from the diversity-aware top-K selector (1-based). */
  rank: z.number().optional(),
  /** Structured explanation payload for UI / LLM agent consumption. */
  explanation: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type CandidateLocation = z.infer<typeof CandidateLocationSchema>;
