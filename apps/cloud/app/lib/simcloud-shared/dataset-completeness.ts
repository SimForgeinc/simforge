import { z } from "zod";

export const DatasetReadinessLevelSchema = z.enum(["demo_ready", "ready", "partial", "blocked", "not_supported"]);
export type DatasetReadinessLevel = z.infer<typeof DatasetReadinessLevelSchema>;

export const DatasetContractKindSchema = z.enum([
  "playback_bundle",
  "detection_training",
  "multimodal_training",
  "tao_detection",
  "sdg",
]);
export type DatasetContractKind = z.infer<typeof DatasetContractKindSchema>;

export const DatasetCompletenessBlockerSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["info", "warning", "error", "critical"]),
  message: z.string().min(1),
  count: z.number().int().nonnegative().optional(),
  sampleKeys: z.array(z.string()).default([]),
});
export type DatasetCompletenessBlocker = z.infer<typeof DatasetCompletenessBlockerSchema>;

export const DatasetCompletenessReportSchema = z.object({
  datasetId: z.string().min(1),
  datasetSnapshotId: z.string().nullable().optional(),
  contractKind: DatasetContractKindSchema,
  readinessLevel: DatasetReadinessLevelSchema,
  ready: z.boolean(),
  generatedAt: z.string(),
  totals: z.object({
    scenarios: z.number().int().nonnegative().default(0),
    simulations: z.number().int().nonnegative().default(0),
    artifacts: z.number().int().nonnegative().default(0),
    sensors: z.number().int().nonnegative().default(0),
    frames: z.number().int().nonnegative().default(0),
  }),
  coverage: z.object({
    scenarioPct: z.number().min(0).max(100).default(0),
    calibrationPct: z.number().min(0).max(100).default(0),
    frameCompletenessPct: z.number().min(0).max(100).default(0),
  }),
  missingScenarios: z.array(z.string()).default([]),
  missingSimulations: z.array(z.string()).default([]),
  missingSensors: z.array(z.string()).default([]),
  missingFrames: z.array(z.string()).default([]),
  missingModalities: z.array(z.string()).default([]),
  missingAnnotations: z.array(z.string()).default([]),
  missingCalibration: z.array(z.string()).default([]),
  missingMapMetadata: z.array(z.string()).default([]),
  lossyArtifacts: z.array(z.string()).default([]),
  placeholderFields: z.array(z.string()).default([]),
  blockers: z.array(DatasetCompletenessBlockerSchema).default([]),
});
export type DatasetCompletenessReport = z.infer<typeof DatasetCompletenessReportSchema>;
