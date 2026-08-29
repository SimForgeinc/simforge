import { z } from 'zod';

import { RenderIntentV1Schema, RenderSha256Schema } from '@simforge-oss/scenario';

import { ArtifactIdentitySchema } from './artifacts.js';
import { EngineCapabilityDeclarationSchema } from './capabilities.js';
import { RenderProgressRecordSchema } from './progress.js';

export const RENDER_WORKER_CONTROL_V2_SCHEMA = 'simforge.render-worker-control/v2' as const;

const ControlBaseShape = {
  schema: z.literal(RENDER_WORKER_CONTROL_V2_SCHEMA),
} as const;
const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const FenceTokenSchema = z.string().min(16).max(1024);
const HeadersSchema = z.record(z.string().min(1).max(255), z.string().max(8192));
const LeaseShape = {
  leaseId: IdSchema,
  fenceToken: FenceTokenSchema,
} as const;

export const WorkerRegisterRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('worker.register'),
  workerId: IdSchema,
  instanceId: IdSchema,
  engine: EngineCapabilityDeclarationSchema,
  labels: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/), z.string().max(256)),
});
export const WorkerRegisteredResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('worker.registered'),
  registrationId: IdSchema,
  heartbeatIntervalMs: z.number().int().min(1000).max(300_000),
});
export const JobClaimRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('job.claim'),
  registrationId: IdSchema,
});
export const NoJobResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('job.none'),
  retryAfterMs: z.number().int().min(100).max(300_000),
});
export const JobInputTransferSchema = z.strictObject({
  inputId: z.string().min(1).max(256),
  sha256: RenderSha256Schema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  download: z.strictObject({
    url: z.url(),
    headers: HeadersSchema,
  }),
});
export const JobLeasedResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('job.leased'),
  jobId: IdSchema,
  attempt: z.number().int().positive().max(1_000_000),
  lease: z.strictObject({
    ...LeaseShape,
    expiresAt: z.iso.datetime({ offset: true }),
  }),
  intent: RenderIntentV1Schema,
  intentSha256: RenderSha256Schema,
  executionPackageControlSha256: RenderSha256Schema,
  inputs: z.array(JobInputTransferSchema).max(4096),
});
export const JobClaimResponseSchema = z.discriminatedUnion('type', [NoJobResponseSchema, JobLeasedResponseSchema]);

export const LeaseHeartbeatRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('lease.heartbeat'),
  ...LeaseShape,
  progressSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const LeaseHeartbeatResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('lease.heartbeat-ack'),
  leaseExpiresAt: z.iso.datetime({ offset: true }),
  cancelRequested: z.boolean(),
  cancelReason: z.string().min(1).max(4096).nullable(),
});
export const LeaseProgressRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('lease.progress'),
  ...LeaseShape,
  records: z.array(RenderProgressRecordSchema).min(1).max(256),
});
export const LeaseProgressResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('lease.progress-ack'),
  acceptedThroughSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const ArtifactReserveRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('artifact.reserve'),
  ...LeaseShape,
  identity: ArtifactIdentitySchema,
  sha256: RenderSha256Schema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mediaType: z.string().min(1).max(255),
});
export const ArtifactReservedResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('artifact.reserved'),
  artifactId: IdSchema,
  upload: z.strictObject({
    url: z.url(),
    method: z.literal('PUT'),
    headers: HeadersSchema,
  }),
});
export const CompletedArtifactSchema = z.strictObject({
  artifactId: IdSchema,
  identity: ArtifactIdentitySchema,
  sha256: RenderSha256Schema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mediaType: z.string().min(1).max(255),
});
export const JobCompleteRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('job.complete'),
  ...LeaseShape,
  intentSha256: RenderSha256Schema,
  manifest: z.strictObject({
    artifacts: z.array(CompletedArtifactSchema).min(1).max(4096),
  }),
});
export const JobFailureSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/),
  message: z.string().min(1).max(8192),
  retryable: z.boolean(),
  details: z.json().optional(),
});
export const JobFailRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('job.fail'),
  ...LeaseShape,
  intentSha256: RenderSha256Schema,
  failure: JobFailureSchema,
});
export const FencedMutationResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('mutation.accepted'),
});
export const WorkerDrainRequestSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('worker.drain'),
  registrationId: IdSchema,
});
export const WorkerDrainResponseSchema = z.strictObject({
  ...ControlBaseShape,
  type: z.literal('worker.draining'),
});

export type WorkerRegisterRequest = z.infer<typeof WorkerRegisterRequestSchema>;
export type WorkerRegisteredResponse = z.infer<typeof WorkerRegisteredResponseSchema>;
export type JobClaimRequest = z.infer<typeof JobClaimRequestSchema>;
export type JobClaimResponse = z.infer<typeof JobClaimResponseSchema>;
export type JobInputTransfer = z.infer<typeof JobInputTransferSchema>;
export type JobLeasedResponse = z.infer<typeof JobLeasedResponseSchema>;
export type LeaseHeartbeatRequest = z.infer<typeof LeaseHeartbeatRequestSchema>;
export type LeaseHeartbeatResponse = z.infer<typeof LeaseHeartbeatResponseSchema>;
export type LeaseProgressRequest = z.infer<typeof LeaseProgressRequestSchema>;
export type LeaseProgressResponse = z.infer<typeof LeaseProgressResponseSchema>;
export type ArtifactReserveRequest = z.infer<typeof ArtifactReserveRequestSchema>;
export type ArtifactReservedResponse = z.infer<typeof ArtifactReservedResponseSchema>;
export type CompletedArtifact = z.infer<typeof CompletedArtifactSchema>;
export type JobCompleteRequest = z.infer<typeof JobCompleteRequestSchema>;
export type JobFailRequest = z.infer<typeof JobFailRequestSchema>;
export type FencedMutationResponse = z.infer<typeof FencedMutationResponseSchema>;
export type WorkerDrainRequest = z.infer<typeof WorkerDrainRequestSchema>;
export type WorkerDrainResponse = z.infer<typeof WorkerDrainResponseSchema>;
