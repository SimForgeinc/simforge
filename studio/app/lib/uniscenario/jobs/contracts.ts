import { z } from "zod";
import {
  CompilerFenceSchema,
  CompilerOutputKindSchema,
  CompilerDigestSchema,
} from "../compiler-contracts";

/** The only product-facing operational job vocabulary. */
export const UNISCENARIO_JOB_FAMILIES = [
  "openscenario_compile",
  "openscenario_validate",
  "openscenario_render",
  "artifact_postprocess",
] as const;

export type UniScenarioJobFamily = (typeof UNISCENARIO_JOB_FAMILIES)[number];
/** Families claimable by the generic CPU worker lane, including browser rendering. */
export type UniScenarioCpuJobFamily = UniScenarioJobFamily;

export const UNISCENARIO_CPU_JOB_FAMILIES = [
  "openscenario_compile",
  "openscenario_validate",
  "openscenario_render",
  "artifact_postprocess",
] as const satisfies readonly UniScenarioCpuJobFamily[];
/** Default claim scope for compiler, validator, browser-render, and postprocess workers. */
export const UNISCENARIO_DEFAULT_CPU_CLAIM_FAMILIES = [
  "openscenario_compile",
  "openscenario_validate",
  "openscenario_render",
  "artifact_postprocess",
] as const;
const MAX_CPU_JOB_ARTIFACTS = 64;

export const ClaimCpuJobSchema = z.strictObject({
  workerId: z.string().trim().min(1).max(200),
  leaseSeconds: z.number().int().min(30).max(1_800).default(900),
  families: z
    .array(z.enum(UNISCENARIO_CPU_JOB_FAMILIES))
    .min(1)
    .max(UNISCENARIO_CPU_JOB_FAMILIES.length)
    .default([...UNISCENARIO_DEFAULT_CPU_CLAIM_FAMILIES]),
});

export const CpuJobFenceSchema = CompilerFenceSchema.extend({
  jobFamily: z.enum(UNISCENARIO_CPU_JOB_FAMILIES),
});

export const HeartbeatCpuJobSchema = CpuJobFenceSchema.extend({
  leaseSeconds: z.number().int().min(30).max(1_800).default(900),
  progress: z.number().min(0).max(1).optional(),
});

export const ReserveCpuJobOutputSchema = CpuJobFenceSchema.extend({
  artifacts: z.array(z.strictObject({
    kind: z.union([
      CompilerOutputKindSchema,
      z.enum(["validation-report", "state-trace", "postprocess-result", "postprocess-provenance"]),
    ]),
    mediaType: z.string().trim().min(1).max(200),
    sha256: CompilerDigestSchema,
    sizeBytes: z.number().int().positive().max(512 * 1024 * 1024),
  })).min(1).max(MAX_CPU_JOB_ARTIFACTS),
});

export const CompleteCpuJobSchema = CpuJobFenceSchema.extend({
  artifacts: z.array(z.strictObject({
    id: z.string().trim().min(1),
    kind: z.string().trim().min(1).max(100),
    sha256: CompilerDigestSchema,
    sizeBytes: z.number().int().positive().max(512 * 1024 * 1024),
  })).min(1).max(MAX_CPU_JOB_ARTIFACTS),
  compile: z.strictObject({
    manifestSha256: CompilerDigestSchema,
    xsdSha256: CompilerDigestSchema,
    sourceInputDigest: CompilerDigestSchema,
  }).optional(),
  validation: z.strictObject({
    outcome: z.enum(["passed", "failed"]),
    summary: z.record(z.string(), z.unknown()),
  }).optional(),
  postprocess: z.strictObject({
    provenance: z.record(z.string(), z.unknown()),
  }).optional(),
  browserRender: z.strictObject({
    recordingJobId: z.string().trim().min(1),
  }).optional(),
});

export const FailCpuJobSchema = CpuJobFenceSchema.extend({
  code: z.string().trim().min(1).max(100),
  detail: z.record(z.string(), z.unknown()).default({}),
});

export const CpuJobEventSchema = CpuJobFenceSchema.extend({
  type: z.string().trim().min(1).max(100),
  payload: z.record(z.string(), z.unknown()).default({}),
});
