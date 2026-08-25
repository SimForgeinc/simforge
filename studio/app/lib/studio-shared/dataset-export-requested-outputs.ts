import { z } from "zod";

export const DatasetExportRequestedOutputKindSchema = z.enum([
  "prefix",
  "manifest",
  "package",
  "odvg",
]);
export type DatasetExportRequestedOutputKind = z.infer<
  typeof DatasetExportRequestedOutputKindSchema
>;

export const DatasetExportRequestedOutputDeliverySchema = z.enum([
  "prefix",
  "tar",
  "zip",
  "manifest",
]);
export type DatasetExportRequestedOutputDelivery = z.infer<
  typeof DatasetExportRequestedOutputDeliverySchema
>;

export const DatasetExportRequestedOutputSchema = z
  .object({
    kind: DatasetExportRequestedOutputKindSchema,
    delivery: DatasetExportRequestedOutputDeliverySchema.optional(),
    optional: z.boolean().default(true),
    allowPartial: z.boolean().default(false),
  })
  .strict();
export type DatasetExportRequestedOutput = z.infer<
  typeof DatasetExportRequestedOutputSchema
>;

export const DatasetExportRequestedOutputsSchema = z
  .array(DatasetExportRequestedOutputSchema)
  .min(1);
export type DatasetExportRequestedOutputs = z.infer<
  typeof DatasetExportRequestedOutputsSchema
>;
