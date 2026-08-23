import { z } from "zod";
import { BaseJobContractSchema } from "./job-family";
import { ExportFormatSchema } from "./dataset";
import { DatasetExportScopeSchema } from "./dataset-export-scope";
import {
  DatasetExportRequestedOutputSchema,
  DatasetExportRequestedOutputsSchema,
} from "./dataset-export-requested-outputs";

export const DatasetExportPublicationKindSchema = z.enum([
  "prefix",
  "manifest",
  "package",
  "odvg",
  "proof",
  "catalog",
]);
export type DatasetExportPublicationKind = z.infer<
  typeof DatasetExportPublicationKindSchema
>;

export const DatasetExportPublicationStatusSchema = z.enum([
  "pending",
  "ready",
  "failed",
  "expired",
]);
export type DatasetExportPublicationStatus = z.infer<
  typeof DatasetExportPublicationStatusSchema
>;

export const DatasetExportTaskStageSchema = z.enum([
  "snapshot_resolve",
  "prefix_materialize",
  "package_archive",
  "publication_finalize",
]);
export type DatasetExportTaskStage = z.infer<
  typeof DatasetExportTaskStageSchema
>;

export const DatasetExportTaskStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type DatasetExportTaskStatus = z.infer<
  typeof DatasetExportTaskStatusSchema
>;

export const RequestedExportOutputSchema = DatasetExportRequestedOutputSchema;
export type RequestedExportOutput = z.infer<typeof RequestedExportOutputSchema>;

export const DatasetExportJobSchema = BaseJobContractSchema.extend({
  datasetId: z.string().min(1),
  datasetSnapshotId: z.string().nullable().optional(),
  format: ExportFormatSchema,
  recipe: z.string().nullable().optional(),
  scopeJson: DatasetExportScopeSchema.nullable().optional(),
  requestedOutputsJson: DatasetExportRequestedOutputsSchema.default([
    {
      kind: "package",
      delivery: "zip",
      optional: false,
      allowPartial: false,
    },
  ]),
  defaultPublicationId: z.string().nullable().optional(),
});
export type DatasetExportJob = z.infer<typeof DatasetExportJobSchema>;

export const DatasetExportTaskSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  datasetExportJobId: z.string().min(1),
  stage: DatasetExportTaskStageSchema,
  partitionKey: z.string().nullable().optional(),
  status: DatasetExportTaskStatusSchema,
  leaseOwner: z.string().nullable().optional(),
  leaseToken: z.string().nullable().optional(),
  leaseExpiresAt: z.string().nullable().optional(),
  lastHeartbeatAt: z.string().nullable().optional(),
  attemptCount: z.number().int().min(0).default(0),
  maxAttempts: z.number().int().min(1).default(3),
  inputJson: z.record(z.unknown()).default({}),
  outputJson: z.record(z.unknown()).nullable().optional(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
});
export type DatasetExportTask = z.infer<typeof DatasetExportTaskSchema>;

export const DatasetExportPublicationSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  datasetExportJobId: z.string().min(1),
  datasetSnapshotId: z.string().nullable().optional(),
  kind: DatasetExportPublicationKindSchema,
  artifactId: z.string().min(1),
  status: DatasetExportPublicationStatusSchema,
  isDefault: z.boolean().default(false),
  publishedAt: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  metadataJson: z.record(z.unknown()).nullable().optional(),
});
export type DatasetExportPublication = z.infer<
  typeof DatasetExportPublicationSchema
>;
