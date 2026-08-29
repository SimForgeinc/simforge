import { z } from "zod";
import { BboxSchema, RegionBboxSchema } from "@simforge-oss/scenario/contracts";
import {
  RegionLineStringSchema,
  RegionPolygonSchema,
} from "./map-candidate-location";

const GeoJsonRecordSchema: z.ZodType<Record<string, unknown>> = z.record(z.unknown());

export const MapEnrichmentProviderSchema = z.literal("overture");
export type MapEnrichmentProvider = z.infer<typeof MapEnrichmentProviderSchema>;

export const MAP_OVERLAY_LAYER_IDS = [
  "bus_stops",
  "schools",
  "hospitals",
  "gas_stations",
  "parking_lots",
  "retail",
  "restaurant",
  "hotel",
  "airport",
  "shopping_mall",
  "transit_stop",
  "crosswalks",
  // Sidewalks (Overture footway segments with subclass=sidewalk). LineString
  // overlay; deduped against in-house `sidewalk_segment` candidates by the
  // corpus-builder, mirroring the crosswalks dual-source pattern.
  "sidewalks",
  // Address + building layers (ingest-time geocoder backbone). Addresses are
  // Point features, buildings are Polygon footprints. Persisted searchable
  // metadata lives in map_asset_addresses / map_asset_buildings; the GeoJSON
  // here is the rendering source for the 3D viewer / overlay.
  "addresses",
  "buildings",
] as const;

export const MapOverlayLayerIdSchema = z.enum(MAP_OVERLAY_LAYER_IDS);
export type MapOverlayLayerId = z.infer<typeof MapOverlayLayerIdSchema>;

export const MAP_CANDIDATE_LOCATION_KINDS = [
  "bus_stop_corridor",
  "school_frontage",
  "hospital_approach",
  "gas_station_approach",
  "parking_lot",
  // Commercial-POI kinds emitted by buildCandidateLocations (PR-138 follow-up).
  // Must mirror the same kinds in CANDIDATE_LOCATION_KINDS — this enum is
  // the snapshot-embedded subset that the enrichment payload validates against.
  "retail_frontage",
  "restaurant_frontage",
  "hotel_approach",
  "airport_approach",
  "shopping_mall_approach",
  "transit_stop_corridor",
  // Overture footway/sidewalk segments emitted by buildCandidateLocations.
  // Mirrors the bus_stop_corridor flow: each Overture LineString becomes one
  // sidewalk_segment candidate that flows through the populate script into
  // map_candidate_locations, giving the search corpus a candidate-backed
  // doc the LLM agent can anchor on for pedestrian spawn placement.
  "sidewalk_segment",
] as const;

export const MapCandidateLocationKindSchema = z.enum(MAP_CANDIDATE_LOCATION_KINDS);
export type MapCandidateLocationKind = z.infer<typeof MapCandidateLocationKindSchema>;

export const MapOverlayFeatureReferenceSchema = z.object({
  layer_id: MapOverlayLayerIdSchema,
  feature_ids: z.array(z.string()),
});
export type MapOverlayFeatureReference = z.infer<typeof MapOverlayFeatureReferenceSchema>;

/**
 * Region for the snapshot-embedded candidate. Most candidates ship as a
 * BBOX (cheap, sufficient for ranking and clustering); POIs whose
 * underlying overlay feature carries a real polygon (e.g., a school
 * promoted to its building footprint, a parking lot polygon) ship as a
 * Polygon so downstream consumers (search index, scenario placement)
 * can use the actual shape rather than the AABB.
 */
export const MapCandidateRegionSchema = z.discriminatedUnion("type", [
  RegionBboxSchema,
  RegionPolygonSchema,
  // LineString — used by sidewalk_segment candidates so the snapshot carries
  // the actual sidewalk polyline rather than a giant axis-aligned bbox.
  RegionLineStringSchema,
]);
export type MapCandidateRegion = z.infer<typeof MapCandidateRegionSchema>;

export const MapCandidateLocationSchema = z.object({
  id: z.string(),
  kind: MapCandidateLocationKindSchema,
  label: z.string(),
  reason: z.string(),
  tags: z.array(z.string()),
  evidence: z.array(MapOverlayFeatureReferenceSchema),
  region: MapCandidateRegionSchema,
});
export type MapCandidateLocation = z.infer<typeof MapCandidateLocationSchema>;

export const MapOverlayLayerSchema = z.object({
  layer_id: MapOverlayLayerIdSchema,
  label: z.string(),
  feature_count: z.number(),
  /**
   * Layer geometry-type hint for renderers and consumers:
   *   "Point" / "LineString" / "Polygon" — every feature in the layer
   *     carries that one geometry type; renderers can pick a single
   *     style and apply it to all features.
   *   "GeoJSON" — features carry mixed geometry types (e.g., a POI
   *     layer where some POIs are still bare points and others have
   *     been promoted to their enclosing building footprint). Renderers
   *     should switch on each feature's own `geometry.type` rather
   *     than treating the layer as a single style.
   */
  geometry_type: z.enum(["Point", "LineString", "Polygon", "GeoJSON"]),
  data: GeoJsonRecordSchema,
});
export type MapOverlayLayer = z.infer<typeof MapOverlayLayerSchema>;

export const MapOverlayPayloadSchema = z.object({
  bbox: BboxSchema,
  layers: z.array(MapOverlayLayerSchema),
});
export type MapOverlayPayload = z.infer<typeof MapOverlayPayloadSchema>;

export const MapEnrichmentFeatureCountsSchema = z.object({
  bus_stops: z.number().optional(),
  schools: z.number().optional(),
  hospitals: z.number().optional(),
  gas_stations: z.number().optional(),
  parking_lots: z.number().optional(),
  retail: z.number().optional(),
  restaurant: z.number().optional(),
  hotel: z.number().optional(),
  airport: z.number().optional(),
  shopping_mall: z.number().optional(),
  transit_stop: z.number().optional(),
  crosswalks: z.number().optional(),
  sidewalks: z.number().optional(),
  addresses: z.number().optional(),
  buildings: z.number().optional(),
});
export type MapEnrichmentFeatureCounts = z.infer<typeof MapEnrichmentFeatureCountsSchema>;

export const MapEnrichmentSummarySchema = z.object({
  provider: MapEnrichmentProviderSchema,
  provider_release: z.string(),
  computed_at: z.string(),
  feature_counts: MapEnrichmentFeatureCountsSchema.optional(),
  derived_tags: z.array(z.string()).optional(),
  candidate_location_count: z.number().optional(),
  warnings_count: z.number().optional(),
  attribution: z.string().optional(),
});
export type MapEnrichmentSummary = z.infer<typeof MapEnrichmentSummarySchema>;

export const MapAssetEnrichmentSnapshotSchema = z.object({
  map_asset_id: z.string(),
  provider: MapEnrichmentProviderSchema,
  provider_release: z.string(),
  computed_at: z.string(),
  summary: MapEnrichmentSummarySchema,
  overlay_payload: MapOverlayPayloadSchema,
  candidate_locations: z.array(MapCandidateLocationSchema),
  warnings: z.array(z.string()),
});
export type MapAssetEnrichmentSnapshot = z.infer<typeof MapAssetEnrichmentSnapshotSchema>;

/**
 * Local API response. Large payloads are exposed as URLs so the client can
 * fetch them in parallel and assemble a `MapAssetEnrichmentSnapshot`.
 */
export const MapAssetEnrichmentManifestSchema = z.object({
  map_asset_id: z.string(),
  provider: MapEnrichmentProviderSchema,
  provider_release: z.string(),
  computed_at: z.string(),
  summary: MapEnrichmentSummarySchema,
  warnings: z.array(z.string()),
  overlay_payload_url: z.string().url(),
  candidate_locations_url: z.string().url(),
});
export type MapAssetEnrichmentManifest = z.infer<typeof MapAssetEnrichmentManifestSchema>;
