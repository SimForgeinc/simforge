import { z } from "zod";
import { RuntimeTopologyProvenanceSchema, Vec2Schema } from "@simforge-oss/maps/topology";

export const SEMANTIC_FEATURE_GRAPH_SCHEMA_VERSION =
  "simforge.semantic-feature-graph.v1" as const;
export const SEMANTIC_FEATURE_GRAPH_COMPILER_VERSION =
  "semantic-feature-graph-compiler.v1" as const;

export const SemanticFeatureSourceSchema = z.enum([
  "opendrive",
  "carla_runtime",
  "geojson",
  "overture",
  "detector",
  "user",
]);
export type SemanticFeatureSource = z.infer<typeof SemanticFeatureSourceSchema>;

export const SemanticFeatureKindSchema = z.enum([
  "driving_corridor",
  "bicycle_corridor",
  "walking_corridor",
  "parking_lane",
  "parking_space",
  "parking_area",
  "crosswalk",
  "curb",
  "sidewalk_surface",
  "median",
  "refuge_island",
  "building",
  "vegetation",
  "occlusion_zone",
  "access_connector",
  "junction_movement",
  "vehicle_conflict_zone",
  "pedestrian_conflict_zone",
]);
export type SemanticFeatureKind = z.infer<typeof SemanticFeatureKindSchema>;

export const SemanticFeatureGeometrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("point"), point: Vec2Schema }).strict(),
  z.object({ type: z.literal("polyline"), points: z.array(Vec2Schema).min(2) }).strict(),
  z.object({ type: z.literal("polygon"), rings: z.array(z.array(Vec2Schema).min(3)).min(1) }).strict(),
]);
export type SemanticFeatureGeometry = z.infer<typeof SemanticFeatureGeometrySchema>;

export const SemanticFeatureRuntimeBindingSchema = z.object({
  status: z.enum(["exact", "projected", "unbound"]),
  laneRsls: z.array(z.string()).default([]),
  gateIds: z.array(z.string()).default([]),
  candidateId: z.string().nullable().default(null),
  maximumProjectionErrorM: z.number().nonnegative().nullable().default(null),
}).strict();
export type SemanticFeatureRuntimeBinding = z.infer<
  typeof SemanticFeatureRuntimeBindingSchema
>;

export const SemanticFeatureSchema = z.object({
  id: z.string().trim().min(1),
  kind: SemanticFeatureKindSchema,
  label: z.string().trim().min(1),
  geometry: SemanticFeatureGeometrySchema,
  sources: z.array(z.object({
    source: SemanticFeatureSourceSchema,
    sourceId: z.string().nullable().default(null),
    confidence: z.number().min(0).max(1),
    revision: z.string().nullable().default(null),
  }).strict()).min(1),
  runtimeBinding: SemanticFeatureRuntimeBindingSchema,
  authoringStatus: z.enum(["authorable", "candidate", "diagnostic_only"]),
  properties: z.record(z.unknown()).default({}),
  diagnosticCodes: z.array(z.string()).default([]),
}).strict();
export type SemanticFeature = z.infer<typeof SemanticFeatureSchema>;

export const SemanticFeatureRelationKindSchema = z.enum([
  "adjacent_to",
  "parallel_to",
  "connects_to",
  "crosses",
  "serves",
  "accesses",
  "contains",
  "occludes",
  "conflicts_with",
]);

export const SemanticFeatureRelationSchema = z.object({
  id: z.string().trim().min(1),
  kind: SemanticFeatureRelationKindSchema,
  fromFeatureId: z.string().trim().min(1),
  toFeatureId: z.string().trim().min(1),
  confidence: z.number().min(0).max(1),
  distanceM: z.number().nonnegative().nullable().default(null),
  properties: z.record(z.unknown()).default({}),
}).strict();
export type SemanticFeatureRelation = z.infer<typeof SemanticFeatureRelationSchema>;

export const SemanticFeatureGraphSchema = z.object({
  schemaVersion: z.literal(SEMANTIC_FEATURE_GRAPH_SCHEMA_VERSION),
  compilerVersion: z.literal(SEMANTIC_FEATURE_GRAPH_COMPILER_VERSION),
  graphRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  generatedAt: z.string(),
  mapAssetId: z.string().trim().min(1),
  mapName: z.string().trim().min(1),
  runtimeProvenance: RuntimeTopologyProvenanceSchema,
  features: z.array(SemanticFeatureSchema),
  relations: z.array(SemanticFeatureRelationSchema),
  stats: z.object({
    featureCount: z.number().int().nonnegative(),
    relationCount: z.number().int().nonnegative(),
    authorableCount: z.number().int().nonnegative(),
    exactRuntimeBoundCount: z.number().int().nonnegative(),
    projectedRuntimeBoundCount: z.number().int().nonnegative(),
    byKind: z.record(z.number().int().nonnegative()),
  }).strict(),
}).strict();
export type SemanticFeatureGraph = z.infer<typeof SemanticFeatureGraphSchema>;
