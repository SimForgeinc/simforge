import { z } from "zod";

import { DatasetExportScopeSchema } from "./dataset-export-scope";

export const SnapshotResolveTaskInputSchema = z
  .object({
    stage: z.literal("snapshot_resolve"),
    datasetId: z.string().min(1),
    scope: DatasetExportScopeSchema.nullable().optional(),
  })
  .strict();
export type SnapshotResolveTaskInput = z.infer<
  typeof SnapshotResolveTaskInputSchema
>;

export const PrefixMaterializeTaskInputSchema = z
  .object({
    stage: z.literal("prefix_materialize"),
    datasetSnapshotId: z.string().min(1),
  })
  .strict();
export type PrefixMaterializeTaskInput = z.infer<
  typeof PrefixMaterializeTaskInputSchema
>;

export const PackageArchiveTaskInputSchema = z
  .object({
    stage: z.literal("package_archive"),
    prefix: z.string().min(1),
    manifestKey: z.string().min(1),
    delivery: z.enum(["tar", "zip"]).default("zip"),
  })
  .strict();
export type PackageArchiveTaskInput = z.infer<
  typeof PackageArchiveTaskInputSchema
>;

export const PublicationFinalizeTaskInputSchema = z
  .union([
    z
      .object({
        stage: z.literal("publication_finalize"),
        prefix: z.string().min(1),
        manifestKey: z.string().min(1),
      })
      .strict(),
    z
      .object({
        stage: z.literal("publication_finalize"),
        packageKey: z.string().min(1),
      })
      .strict(),
  ]);
export type PublicationFinalizeTaskInput = z.infer<
  typeof PublicationFinalizeTaskInputSchema
>;

export const DatasetExportTaskInputSchema = z.union([
  SnapshotResolveTaskInputSchema,
  PrefixMaterializeTaskInputSchema,
  PackageArchiveTaskInputSchema,
  PublicationFinalizeTaskInputSchema,
]);
export type DatasetExportTaskInput = z.infer<
  typeof DatasetExportTaskInputSchema
>;
