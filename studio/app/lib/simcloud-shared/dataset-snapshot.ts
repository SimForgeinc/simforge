import { z } from "zod";
import { JobFamilySchema } from "./job-family";

export const DatasetSnapshotSchema = z.object({
  id: z.string().min(1),
  datasetId: z.string().min(1),
  workspaceId: z.string().min(1),
  sourceQueryJson: z.record(z.unknown()).default({}),
  summaryJson: z.record(z.unknown()).default({}),
  createdByJobFamily: JobFamilySchema.nullable().optional(),
  createdByJobId: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type DatasetSnapshot = z.infer<typeof DatasetSnapshotSchema>;

export const DatasetSnapshotItemRoleSchema = z.enum([
  "source",
  "label",
  "calibration",
  "metadata",
  "manifest",
  "publication",
]);
export type DatasetSnapshotItemRole = z.infer<typeof DatasetSnapshotItemRoleSchema>;

export const DatasetSplitSchema = z.enum(["train", "val", "test", "unsplit"]);
export type DatasetSplit = z.infer<typeof DatasetSplitSchema>;

export const DatasetSnapshotItemSchema = z.object({
  datasetSnapshotId: z.string().min(1),
  artifactId: z.string().min(1),
  artifactCatalog: z.enum(["legacy", "scenario"]).optional(),
  sampleKey: z.string().nullable().optional(),
  sequenceId: z.string().nullable().optional(),
  split: DatasetSplitSchema.default("unsplit"),
  role: DatasetSnapshotItemRoleSchema.default("source"),
  metadataJson: z.record(z.unknown()).nullable().optional(),
});
export type DatasetSnapshotItem = z.infer<typeof DatasetSnapshotItemSchema>;

export const DatasetPublicationKindSchema = z.enum(["prefix", "manifest", "package", "index"]);
export type DatasetPublicationKind = z.infer<typeof DatasetPublicationKindSchema>;

export const DatasetPublicationSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  datasetSnapshotId: z.string().min(1),
  kind: DatasetPublicationKindSchema,
  artifactId: z.string().min(1),
  isDefault: z.boolean().default(false),
  metadataJson: z.record(z.unknown()).nullable().optional(),
  createdAt: z.string(),
});
export type DatasetPublication = z.infer<typeof DatasetPublicationSchema>;
