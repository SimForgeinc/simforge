import { z } from "zod";

export const CARLA_MAPS = [
  "Belmont_Office_Park_Belmont_CA",
  "Richmond_Field_Station_Richmond_CA",
  "Saratoga_School_Area",
] as const;

export type CarlaMapName = (typeof CARLA_MAPS)[number];

export const DatasetStatusSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
]);
export type DatasetStatus = z.infer<typeof DatasetStatusSchema>;
export const DATASET_STATUS_VALUES: readonly DatasetStatus[] =
  DatasetStatusSchema.options;

export const DatasetScopeSchema = z.enum(["workspace", "global"]);
export type DatasetScope = z.infer<typeof DatasetScopeSchema>;

export const ResourceMutabilitySchema = z.enum(["editable", "read_only"]);
export type ResourceMutability = z.infer<typeof ResourceMutabilitySchema>;

export const ResourceCopyPolicySchema = z.enum(["allowed", "blocked"]);
export type ResourceCopyPolicy = z.infer<typeof ResourceCopyPolicySchema>;

export const ExportFormatSchema = z.enum([
  "REVIEW_BUNDLE",
  "NATIVE_FULL",
  "ODVG",
  "ALPAMAYO_SFT",
]);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;
export const EXPORT_FORMAT_VALUES: readonly ExportFormat[] =
  ExportFormatSchema.options;

export const SimulationArtifactClassSchema = z.enum([
  "recording",
  "image",
  "point_cloud",
  "annotation",
  "calibration",
  "manifest",
  "metadata",
  "log",
  "archive",
  "other",
]);
export type SimulationArtifactClass = z.infer<
  typeof SimulationArtifactClassSchema
>;

export const DatasetExportSourceFilterSchema = z.object({
  artifactIds: z.array(z.string()).optional(),
  scenarioIds: z.array(z.string()).optional(),
  simulationIds: z.array(z.string()).optional(),
  sensorIds: z.array(z.string()).optional(),
  s3Buckets: z.array(z.string()).optional(),
  sensorCategories: z.array(z.string()).optional(),
  outputModalities: z.array(z.string()).optional(),
  artifactClasses: z.array(z.string()).optional(),
  kinds: z.array(z.string()).optional(),
  rawOnly: z.boolean().optional(),
  search: z.string().optional(),
  pipelineRunId: z.string().optional(),
  pipelineRunItemId: z.string().optional(),
  stageId: z.string().optional(),
});
export type DatasetExportSourceFilter = z.infer<
  typeof DatasetExportSourceFilterSchema
>;

export const VariationConfigSchema = z.object({
  seed: z.number().int().optional(),
  count: z.number().int().min(1),
  weather_variations: z.array(z.string()).optional(),
  time_of_day_variations: z.array(z.string()).optional(),
  traffic_density_range: z.tuple([z.number(), z.number()]).optional(),
  ego_start_variation_m: z.number().optional(),
  extra_params: z.record(z.unknown()).optional(),
});
export type VariationConfig = z.infer<typeof VariationConfigSchema>;

export const DatasetStatsRepairStateSchema = z.enum([
  "healthy",
  "dirty",
  "repairing",
]);
export type DatasetStatsRepairState = z.infer<
  typeof DatasetStatsRepairStateSchema
>;

export const DatasetStatsSchema = z.object({
  scenarioCount: z.number().int().min(0),
  renderSubmittedCount: z.number().int().min(0),
  renderCompletedCount: z.number().int().min(0),
  cosmosSubmittedCount: z.number().int().min(0),
  cosmosCompletedCount: z.number().int().min(0),
  modelSubmittedCount: z.number().int().min(0),
  modelCompletedCount: z.number().int().min(0),
  exportCompletedCount: z.number().int().min(0),
  updatedAt: z.string().nullable(),
  repairState: DatasetStatsRepairStateSchema,
  version: z.number().int().min(1),
});
export type DatasetStats = z.infer<typeof DatasetStatsSchema>;

export const DatasetSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  baseScenarioId: z.string().nullable().optional(),
  variationConfig: VariationConfigSchema.nullable().optional(),
  status: DatasetStatusSchema,
  totalVariations: z.number().int().min(0),
  completedVariations: z.number().int().min(0),
  failedVariations: z.number().int().min(0),
  createdByUserId: z.string().nullable().optional(),
  scope: DatasetScopeSchema.default("workspace"),
  mutability: ResourceMutabilitySchema.default("editable"),
  copyPolicy: ResourceCopyPolicySchema.default("allowed"),
  systemSlug: z.string().nullable().optional(),
  isSystem: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  stats: DatasetStatsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Dataset = z.infer<typeof DatasetSchema>;

export const CreateDatasetInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  baseScenarioId: z.string().optional(),
  variationConfig: VariationConfigSchema.optional(),
});
export type CreateDatasetInput = z.infer<typeof CreateDatasetInputSchema>;

export const DatasetExportSchema = z.object({
  id: z.string(),
  datasetId: z.string(),
  format: ExportFormatSchema,
  sdgBatchId: z.string().nullable().optional(),
  s3Path: z.string().nullable().optional(),
  status: DatasetStatusSchema,
  qualityMetrics: z.record(z.unknown()).nullable().optional(),
  fileSizeBytes: z.number().int().nullable().optional(),
  sourceFilter: DatasetExportSourceFilterSchema.nullable().optional(),
  manifest: z.record(z.unknown()).nullable().optional(),
  bundleS3Bucket: z.string().nullable().optional(),
  bundleS3Key: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  createdAt: z.string(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
});
export type DatasetExport = z.infer<typeof DatasetExportSchema>;
