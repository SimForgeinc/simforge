import { z } from "zod";

export const JobFamilySchema = z.enum([
  "openscenario_compile",
  "openscenario_validate",
  "openscenario_render",
  "artifact_postprocess",
]);
export type JobFamily = z.infer<typeof JobFamilySchema>;
export const JOB_FAMILY_VALUES: readonly JobFamily[] = JobFamilySchema.options;

export const CanonicalJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type CanonicalJobStatus = z.infer<typeof CanonicalJobStatusSchema>;
export const CANONICAL_JOB_STATUS_VALUES: readonly CanonicalJobStatus[] = CanonicalJobStatusSchema.options;

export const InitiatorSurfaceSchema = z.enum(["web", "admin", "api", "runtime_provider", "worker", "system", "agent"]);
export type InitiatorSurface = z.infer<typeof InitiatorSurfaceSchema>;

export const JobPurposeSchema = z.enum([
  "preview",
  "render",
  "simulation",
  "sdg_source",
  "sdg_variant",
  "dataset_export",
  "dataset_curation",
  "training",
  "evaluation",
  "ops",
]);
export type JobPurpose = z.infer<typeof JobPurposeSchema>;

export const BaseJobContractSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  status: CanonicalJobStatusSchema,
  phase: z.string().min(1),
  jobType: z.string().min(1),
  jobPurpose: JobPurposeSchema.nullable().optional(),
  initiatorSurface: InitiatorSurfaceSchema.nullable().optional(),
  priority: z.number().int().default(0),
  createdByUserId: z.string().nullable().optional(),
  idempotencyKey: z.string().nullable().optional(),
  correlationId: z.string().nullable().optional(),
  requestJson: z.record(z.unknown()).default({}),
  resultJson: z.record(z.unknown()).nullable().optional(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  retryCount: z.number().int().min(0).default(0),
  cancelRequestedAt: z.string().nullable().optional(),
  cancelReason: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
});
export type BaseJobContract = z.infer<typeof BaseJobContractSchema>;

export function normalizeCanonicalJobStatus(status: unknown): CanonicalJobStatus {
  switch (status) {
    case "queued":
    case "pending":
    case "accepted":
      return "queued";
    case "running":
    case "processing":
    case "acquiring_gpu":
    case "loading_map":
    case "uploading":
      return "running";
    case "succeeded":
    case "completed":
    case "success":
      return "succeeded";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "queued";
  }
}

export function phaseForLegacyStatus(status: unknown): string {
  switch (status) {
    case "acquiring_gpu":
    case "loading_map":
    case "uploading":
      return status;
    case "processing":
      return "running";
    case "completed":
    case "succeeded":
      return "finalized";
    case "pending":
    case "accepted":
      return "queued";
    default:
      return typeof status === "string" && status.trim() ? status.trim() : "queued";
  }
}
