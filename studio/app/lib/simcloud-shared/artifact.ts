import { z } from "zod";
import { JobFamilySchema } from "./job-family";
import { SensorCategory, SensorOutputModality } from "./simulation-run";

export const ArtifactStatusSchema = z.enum(["pending", "ready", "failed", "deleted", "quarantined"]);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const ArtifactRetentionClassSchema = z.enum([
  "ephemeral",
  "debug",
  "raw_source",
  "derived_intermediate",
  "published",
  "compliance_locked",
]);
export type ArtifactRetentionClass = z.infer<typeof ArtifactRetentionClassSchema>;

export const ArtifactFamilySchema = z.enum([
  "carla",
  "cosmos",
  "dataset_export",
  "dataset_publication",
  "evaluation",
  "model",
  "model_output",
  "system",
]);
export type ArtifactFamily = z.infer<typeof ArtifactFamilySchema>;

export const CanonicalArtifactSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  artifactFamily: ArtifactFamilySchema,
  artifactType: z.string().min(1),
  modality: z.string().nullable().optional(),
  producerJobFamily: JobFamilySchema.nullable().optional(),
  producerJobId: z.string().nullable().optional(),
  sourceArtifactId: z.string().nullable().optional(),
  scenarioId: z.string().nullable().optional(),
  simulationId: z.string().nullable().optional(),
  sensorId: z.string().nullable().optional(),
  sensorLabel: z.string().nullable().optional(),
  sensorCategory: SensorCategory.nullable().optional(),
  outputModality: SensorOutputModality.nullable().optional(),
  sequenceId: z.string().nullable().optional(),
  frameIndex: z.number().int().nullable().optional(),
  timestampSeconds: z.number().nullable().optional(),
  datasetSnapshotId: z.string().nullable().optional(),
  s3Bucket: z.string().min(1),
  s3Key: z.string().nullable().optional(),
  s3Prefix: z.string().nullable().optional(),
  contentType: z.string().nullable().optional(),
  sizeBytes: z.number().int().nonnegative().nullable().optional(),
  checksumSha256: z.string().nullable().optional(),
  isRaw: z.boolean().default(true),
  status: ArtifactStatusSchema.default("ready"),
  retentionClass: ArtifactRetentionClassSchema.default("raw_source"),
  encodingLossless: z.boolean().nullable().optional(),
  lossyReason: z.string().nullable().optional(),
  metadataJson: z.record(z.unknown()).nullable().optional(),
  createdAt: z.string(),
});
export type CanonicalArtifact = z.infer<typeof CanonicalArtifactSchema>;

export const ArtifactManifestItemSchema = CanonicalArtifactSchema.omit({
  id: true,
  createdAt: true,
}).extend({
  id: z.string().optional(),
  createdAt: z.string().optional(),
});
export type ArtifactManifestItem = z.infer<typeof ArtifactManifestItemSchema>;

export const ArtifactManifestSchema = z.object({
  contractVersion: z.literal("simforge.artifact-manifest.v1"),
  workspaceId: z.string().min(1),
  producerJobFamily: JobFamilySchema,
  producerJobId: z.string().min(1),
  scenarioId: z.string().nullable().optional(),
  simulationId: z.string().nullable().optional(),
  generatedAt: z.string(),
  artifacts: z.array(ArtifactManifestItemSchema),
});
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
