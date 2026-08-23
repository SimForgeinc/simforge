import { z } from "zod";
import { ArtifactFamilySchema, ArtifactRetentionClassSchema, ArtifactStatusSchema } from "./artifact";

export const WorkspaceStorageAvailabilitySchema = z.enum([
  "available",
  "archived",
  "retrieving",
  "unavailable",
  "unknown",
]);

export const WorkspaceStorageProtectionReasonSchema = z.enum([
  "active_job",
  "compliance_locked",
  "dataset_snapshot",
  "dataset_publication",
  "downstream_lineage",
  "model_reference",
  "training_reference",
  "evaluation_reference",
  "scenario_source",
  "incident_reference",
  "calibration_reference",
  "metric_reference",
  "quarantined",
  "unknown_inventory",
]);

export const WorkspaceStorageSummarySchema = z.object({
  workspaceId: z.string().min(1),
  artifactCount: z.number().int().nonnegative(),
  knownBytes: z.number().int().nonnegative(),
  unknownSizeCount: z.number().int().nonnegative(),
  protectedBytes: z.number().int().nonnegative(),
  reclaimableBytes: z.number().int().nonnegative(),
  trashedCount: z.number().int().nonnegative(),
  trashedBytes: z.number().int().nonnegative(),
  sizeCoveragePercent: z.number().min(0).max(100),
  familyBreakdown: z.array(z.object({
    family: ArtifactFamilySchema.or(z.string().min(1)),
    artifactCount: z.number().int().nonnegative(),
    knownBytes: z.number().int().nonnegative(),
  })),
  generatedAt: z.string(),
});

export const WorkspaceStorageArtifactGroupSchema = z.object({
  id: z.string().min(1),
  resourceKind: z.enum(["render", "job", "scenario", "dataset_export", "standalone", "unindexed"]),
  label: z.string().min(1),
  contextLabel: z.string().nullable(),
  scenarioId: z.string().nullable(),
  datasetId: z.string().nullable(),
  producerJobFamily: z.string().nullable(),
  producerJobId: z.string().nullable(),
  artifactFamily: z.string(),
  artifactCount: z.number().int().nonnegative(),
  knownBytes: z.number().int().nonnegative(),
  unknownSizeCount: z.number().int().nonnegative(),
  availability: WorkspaceStorageAvailabilitySchema,
  status: ArtifactStatusSchema.or(z.string()),
  retentionClass: ArtifactRetentionClassSchema.or(z.string()),
  protected: z.boolean(),
  protectionReasons: z.array(WorkspaceStorageProtectionReasonSchema),
  createdAt: z.string(),
  latestAt: z.string(),
});

export const WorkspaceScenarioStorageRowSchema = z.object({
  scenarioId: z.string().min(1),
  scenarioName: z.string().min(1),
  artifactCount: z.number().int().nonnegative(),
  knownBytes: z.number().int().nonnegative(),
  unknownSizeCount: z.number().int().nonnegative(),
  protectedBytes: z.number().int().nonnegative(),
  reclaimableBytes: z.number().int().nonnegative(),
  renderCount: z.number().int().nonnegative(),
  olderRenderCount: z.number().int().nonnegative(),
  latestRenderJobId: z.string().nullable(),
  latestRenderAt: z.string().nullable(),
  datasetCount: z.number().int().nonnegative(),
  orphaned: z.boolean().default(false),
});

export const WorkspaceDatasetStorageRowSchema = z.object({
  datasetId: z.string().min(1),
  datasetName: z.string().min(1),
  scenarioCount: z.number().int().nonnegative(),
  directBytes: z.number().int().nonnegative(),
  uniqueScenarioBytes: z.number().int().nonnegative(),
  sharedScenarioBytes: z.number().int().nonnegative(),
  snapshotHeldBytes: z.number().int().nonnegative(),
  totalAttributedBytes: z.number().int().nonnegative(),
  unknownSizeCount: z.number().int().nonnegative(),
  protectedBytes: z.number().int().nonnegative(),
  lastActivityAt: z.string().nullable(),
});

export const WorkspaceTrashRowSchema = z.object({
  artifactId: z.string().min(1),
  label: z.string().min(1),
  artifactFamily: z.string(),
  scenarioId: z.string().nullable(),
  knownBytes: z.number().int().nonnegative(),
  trashedAt: z.string(),
  purgeAfter: z.string().nullable(),
  trashedByUserId: z.string().nullable(),
  purgedAt: z.string().nullable(),
});

export const WorkspaceStorageCleanupActionSchema = z.enum([
  "delete_artifacts",
  "keep_latest_render",
  "delete_all_outputs",
  "delete_scenario_and_outputs",
  "remove_failed_outputs",
]);

export const WorkspaceStorageSelectionSchema = z.object({
  artifactIds: z.array(z.string().min(1)).max(1000).optional(),
  groupIds: z.array(z.string().min(1)).max(1000).optional(),
  scenarioIds: z.array(z.string().min(1)).max(1000).optional(),
  datasetIds: z.array(z.string().min(1)).max(1000).optional(),
  allScenarios: z.boolean().optional(),
}).refine(
  (value) => Boolean(
    value.artifactIds?.length || value.groupIds?.length || value.scenarioIds?.length
      || value.datasetIds?.length || value.allScenarios,
  ),
  "At least one storage resource must be selected.",
);

export const WorkspaceStorageDeletionPreviewRequestSchema = z.object({
  action: WorkspaceStorageCleanupActionSchema,
  selection: WorkspaceStorageSelectionSchema,
  includeDerivedOutputs: z.boolean().default(false),
});

export const WorkspaceStorageBlockerSchema = z.object({
  artifactId: z.string().min(1),
  reason: WorkspaceStorageProtectionReasonSchema,
  message: z.string().min(1),
});

export const WorkspaceStorageDeletionPreviewSchema = z.object({
  previewId: z.string().min(1),
  previewToken: z.string().min(1),
  action: WorkspaceStorageCleanupActionSchema,
  artifactCount: z.number().int().nonnegative(),
  eligibleCount: z.number().int().nonnegative(),
  blockedCount: z.number().int().nonnegative(),
  knownBytes: z.number().int().nonnegative(),
  unknownSizeCount: z.number().int().nonnegative(),
  retainedRenderJobIds: z.record(z.string()).default({}),
  blockers: z.array(WorkspaceStorageBlockerSchema),
  expiresAt: z.string(),
});

export const WorkspaceStoragePolicySchema = z.object({
  workspaceId: z.string().min(1),
  automaticKeepLatestRender: z.boolean(),
  includeDerivedOutputs: z.boolean(),
  trashRecoveryDays: z.number().int().min(1).max(90),
  updatedAt: z.string().nullable(),
});

export type WorkspaceStorageSummary = z.infer<typeof WorkspaceStorageSummarySchema>;
export type WorkspaceStorageArtifactGroup = z.infer<typeof WorkspaceStorageArtifactGroupSchema>;
export type WorkspaceScenarioStorageRow = z.infer<typeof WorkspaceScenarioStorageRowSchema>;
export type WorkspaceDatasetStorageRow = z.infer<typeof WorkspaceDatasetStorageRowSchema>;
export type WorkspaceTrashRow = z.infer<typeof WorkspaceTrashRowSchema>;
export type WorkspaceStorageCleanupAction = z.infer<typeof WorkspaceStorageCleanupActionSchema>;
export type WorkspaceStorageSelection = z.infer<typeof WorkspaceStorageSelectionSchema>;
export type WorkspaceStorageDeletionPreviewRequest = z.infer<typeof WorkspaceStorageDeletionPreviewRequestSchema>;
export type WorkspaceStorageDeletionPreview = z.infer<typeof WorkspaceStorageDeletionPreviewSchema>;
export type WorkspaceStoragePolicy = z.infer<typeof WorkspaceStoragePolicySchema>;
