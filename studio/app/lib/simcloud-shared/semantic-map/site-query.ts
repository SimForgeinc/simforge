import { z } from "zod";
import { SemanticFeatureKindSchema } from "./feature-graph";
import { SemanticMapAuthoringStatusSchema, SemanticMapPointSchema } from "./types";
import { TurnRelationSchema, Vec2Schema } from "../map-topology/types";

export const SEMANTIC_SITE_QUERY_SCHEMA_VERSION =
  "simforge.semantic-site-query.v1" as const;
export const SEMANTIC_SITE_QUERY_RESULT_SCHEMA_VERSION =
  "simforge.semantic-site-query-result.v1" as const;

export const SemanticSiteAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("corridor") }).strict(),
  z.object({ kind: z.literal("movement") }).strict(),
  z.object({ kind: z.literal("conflict_zone") }).strict(),
  z.object({
    kind: z.literal("environment_feature"),
    featureKinds: z.array(SemanticFeatureKindSchema).min(1),
  }).strict(),
]);

export const SemanticSiteNearbyRequirementSchema = z.object({
  featureKinds: z.array(SemanticFeatureKindSchema).min(1),
  minCount: z.number().int().min(1).default(1),
  maximumDistanceM: z.number().positive().max(1000),
  bindingStatuses: z.array(z.enum(["exact", "projected", "unbound"])).default([
    "exact",
    "projected",
  ]),
}).strict();

export const SemanticSiteQuerySchema = z.object({
  schemaVersion: z.literal(SEMANTIC_SITE_QUERY_SCHEMA_VERSION),
  anchor: SemanticSiteAnchorSchema,
  authoringStatuses: z.array(SemanticMapAuthoringStatusSchema).default(["authorable"]),
  corridor: z.object({
    minimumLengthM: z.number().nonnegative().optional(),
    maximumLengthM: z.number().positive().optional(),
    minimumWidthM: z.number().positive().optional(),
    maximumWidthM: z.number().positive().optional(),
    minimumDistanceFromBoundaryM: z.number().nonnegative().default(0),
    progressRange: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).default([0, 1]),
    endpointKinds: z.array(z.enum(["map_boundary", "junction", "branch", "dead_end", "cycle"])).optional(),
    laneRoles: z.array(z.enum(["single", "leftmost", "inner", "rightmost", "unknown"])).optional(),
    minimumApproachLaneCount: z.number().int().positive().optional(),
  }).strict().optional(),
  movement: z.object({
    turnRelations: z.array(TurnRelationSchema).optional(),
  }).strict().optional(),
  conflict: z.object({
    kinds: z.array(z.enum(["crossing", "merge", "diverge", "shared_path"])).optional(),
  }).strict().optional(),
  nearby: z.array(SemanticSiteNearbyRequirementSchema).max(12).default([]),
  diversityRadiusM: z.number().nonnegative().max(5000).default(50),
  limit: z.number().int().min(1).max(200).default(50),
}).strict().superRefine((query, context) => {
  const range = query.corridor?.progressRange;
  if (range && range[0] > range[1]) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["corridor", "progressRange"], message: "progressRange must be ascending" });
  }
  if (
    query.corridor?.minimumLengthM != null &&
    query.corridor.maximumLengthM != null &&
    query.corridor.minimumLengthM > query.corridor.maximumLengthM
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["corridor"], message: "length range must be ascending" });
  }
});

export const SemanticSiteQueryCandidateSchema = z.object({
  id: z.string(),
  rank: z.number().int().positive(),
  anchorKind: z.enum(["corridor", "movement", "conflict_zone", "environment_feature"]),
  anchorId: z.string(),
  anchorFraction: z.number().min(0).max(1).nullable(),
  point: SemanticMapPointSchema,
  headingRad: z.number().nullable(),
  previewGeometry: z.discriminatedUnion("type", [
    z.object({ type: z.literal("point"), point: Vec2Schema }).strict(),
    z.object({ type: z.literal("polyline"), points: z.array(Vec2Schema).min(2) }).strict(),
    z.object({ type: z.literal("polygon"), rings: z.array(z.array(Vec2Schema).min(3)).min(1) }).strict(),
  ]),
  compatibilityScore: z.number().min(0).max(1),
  diversityCluster: z.string(),
  matchedReasons: z.array(z.string()),
  runtimeBindingStatus: z.enum(["exact", "projected", "unbound"]).nullable(),
}).strict();

export const SemanticSiteQueryPruningSummarySchema = z.object({
  code: z.string(),
  count: z.number().int().nonnegative(),
  message: z.string(),
}).strict();

export const SemanticSiteQueryResultSchema = z.object({
  schemaVersion: z.literal(SEMANTIC_SITE_QUERY_RESULT_SCHEMA_VERSION),
  query: SemanticSiteQuerySchema,
  mapAssetId: z.string(),
  runtime: z.literal("carla_ue5"),
  publicationRevision: z.string(),
  graphRevision: z.string(),
  examinedCount: z.number().int().nonnegative(),
  compatibleCount: z.number().int().nonnegative(),
  candidates: z.array(SemanticSiteQueryCandidateSchema),
  pruning: z.array(SemanticSiteQueryPruningSummarySchema),
  budget: z.object({
    candidateLimit: z.number().int().positive(),
    distanceComparisonLimit: z.number().int().positive(),
    distanceComparisons: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export type SemanticSiteQuery = z.infer<typeof SemanticSiteQuerySchema>;
export type SemanticSiteQueryCandidate = z.infer<typeof SemanticSiteQueryCandidateSchema>;
export type SemanticSiteQueryResult = z.infer<typeof SemanticSiteQueryResultSchema>;
