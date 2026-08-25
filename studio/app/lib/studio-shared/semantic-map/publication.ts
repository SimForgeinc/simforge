import { z } from "zod";
import { RuntimeTopologyFamilySchema } from "../map-topology/types";

export const SEMANTIC_GRAPH_PUBLICATION_SCHEMA_VERSION =
  "simforge.semantic-graph-publication.v2" as const;

export const SemanticGraphArtifactDescriptorSchema = z.object({
  key: z.string().trim().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytesRaw: z.number().int().nonnegative(),
  sizeBytesStored: z.number().int().nonnegative(),
  encoding: z.literal("gzip-json"),
}).strict();

export const SemanticGraphPublicationManifestSchema = z.object({
  schemaVersion: z.literal(SEMANTIC_GRAPH_PUBLICATION_SCHEMA_VERSION),
  status: z.literal("accepted"),
  publicationRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  publishedAt: z.string().datetime(),
  mapAssetId: z.string().trim().min(1),
  runtime: RuntimeTopologyFamilySchema,
  runtimeMapName: z.string().trim().min(1),
  runtimeCatalogVersion: z.string().trim().min(1),
  bundleVersion: z.string().trim().min(1),
  imageDigest: z.string().trim().min(1),
  xodrSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeRoadGraphSha256: z.string().regex(/^[a-f0-9]{64}$/),
  projectionIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  topologyCompilerVersion: z.string().trim().min(1),
  semanticMapCompilerVersion: z.string().trim().min(1),
  semanticFeatureCompilerVersion: z.string().trim().min(1),
  semanticExecutionIndexCompilerVersion: z.string().trim().min(1),
  semanticMapGraphRevision: z.string().trim().min(1),
  semanticFeatureGraphRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  semanticExecutionIndexRevision: z.string().trim().min(1),
  roadwayConsistency: z.object({
    schemaVersion: z.literal("simforge.roadway-consistency-attestation.v1"),
    verdict: z.enum(["pass", "review", "fail"]),
    issueCount: z.number().int().nonnegative(),
    stats: z.object({
      eligibleLaneCount: z.number().int().nonnegative(),
      candidatePairCount: z.number().int().nonnegative(),
      inferredIntervalCount: z.number().int().nonnegative(),
      issueCount: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  artifacts: z.object({
    topology: SemanticGraphArtifactDescriptorSchema,
    semanticMap: SemanticGraphArtifactDescriptorSchema,
    semanticFeatureGraph: SemanticGraphArtifactDescriptorSchema,
    semanticExecutionIndex: SemanticGraphArtifactDescriptorSchema,
    roadwayConsistency: SemanticGraphArtifactDescriptorSchema,
  }).strict(),
}).strict();

export type SemanticGraphArtifactDescriptor = z.infer<
  typeof SemanticGraphArtifactDescriptorSchema
>;
export type SemanticGraphPublicationManifest = z.infer<
  typeof SemanticGraphPublicationManifestSchema
>;
