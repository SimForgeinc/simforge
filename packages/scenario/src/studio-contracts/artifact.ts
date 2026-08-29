import { z } from "zod-v3";

import { SensorCategory, SensorOutputModality } from "./simulation-run.js";

export const ArtifactStatusSchema = z.enum([
  "pending",
  "ready",
  "failed",
  "deleted",
  "quarantined",
]);
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
  "simulation",
  "render",
  "augmentation",
  "dataset",
  "evaluation",
  "model",
  "model_output",
  "system",
]);
export type ArtifactFamily = z.infer<typeof ArtifactFamilySchema>;

/**
 * Storage-neutral artifact metadata shared by local and hosted runtimes.
 *
 * `uri` may be a relative bundle path, file URL, or another runtime-owned
 * locator. Storage-provider coordinates and tenant ownership intentionally do
 * not form part of the published contract.
 */
export const CanonicalArtifactSchema = z.object({
  id: z.string().min(1),
  artifactFamily: ArtifactFamilySchema,
  artifactType: z.string().min(1),
  uri: z.string().min(1).nullable().optional(),
  modality: z.string().nullable().optional(),
  producerKind: z.string().min(1).nullable().optional(),
  producerId: z.string().min(1).nullable().optional(),
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
  contentType: z.string().nullable().optional(),
  sizeBytes: z.number().int().nonnegative().nullable().optional(),
  checksumSha256: z.string().nullable().optional(),
  isRaw: z.boolean().default(true),
  status: ArtifactStatusSchema.default("ready"),
  retentionClass: ArtifactRetentionClassSchema.default("raw_source"),
  encodingLossless: z.boolean().nullable().optional(),
  lossyReason: z.string().nullable().optional(),
  metadataJson: z.record(z.string(), z.unknown()).nullable().optional(),
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
  producerKind: z.string().min(1),
  producerId: z.string().min(1),
  scenarioId: z.string().nullable().optional(),
  simulationId: z.string().nullable().optional(),
  generatedAt: z.string(),
  artifacts: z.array(ArtifactManifestItemSchema),
});
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
