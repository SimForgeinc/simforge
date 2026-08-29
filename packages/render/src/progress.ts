import { z } from 'zod';

import { ArtifactIdentitySchema } from './artifacts.js';

export const RENDER_PROGRESS_V1_SCHEMA = 'simforge.render-progress/v1' as const;
export const RenderStageSchema = z.enum([
  'downloading',
  'preparing',
  'rendering',
  'encoding',
  'uploading',
  'finalizing',
]);
export const RenderProgressUnitSchema = z.enum(['frames', 'bytes', 'items', 'seconds']);

const BaseProgressShape = {
  schema: z.literal(RENDER_PROGRESS_V1_SCHEMA),
  jobId: z.string().min(1).max(128),
  attempt: z.number().int().positive().max(1_000_000),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  timestamp: z.iso.datetime({ offset: true }),
} as const;

export const JobStartedProgressSchema = z.strictObject({
  ...BaseProgressShape,
  event: z.literal('job.started'),
});
export const StageStartedProgressSchema = z.strictObject({
  ...BaseProgressShape,
  event: z.literal('stage.started'),
  stage: RenderStageSchema,
});
export const StageProgressSchema = z.strictObject({
  ...BaseProgressShape,
  event: z.literal('stage.progress'),
  stage: RenderStageSchema,
  completed: z.number().finite().nonnegative(),
  total: z.number().finite().positive(),
  unit: RenderProgressUnitSchema,
}).check((ctx) => {
  if (ctx.value.completed > ctx.value.total) {
    ctx.issues.push({ code: 'custom', path: ['completed'], message: 'completed must not exceed total', input: ctx.value.completed });
  }
});
export const ArtifactReadyProgressSchema = z.strictObject({
  ...BaseProgressShape,
  event: z.literal('artifact.ready'),
  identity: ArtifactIdentitySchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mediaType: z.string().min(1).max(255),
});
export const WarningProgressSchema = z.strictObject({
  ...BaseProgressShape,
  event: z.literal('warning'),
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(4096),
});
export const JobCanceledProgressSchema = z.strictObject({
  ...BaseProgressShape,
  event: z.literal('job.canceled'),
  reason: z.string().min(1).max(4096),
});

export const RenderProgressRecordSchema = z.discriminatedUnion('event', [
  JobStartedProgressSchema,
  StageStartedProgressSchema,
  StageProgressSchema,
  ArtifactReadyProgressSchema,
  WarningProgressSchema,
  JobCanceledProgressSchema,
]);

export type RenderStage = z.infer<typeof RenderStageSchema>;
export type RenderProgressUnit = z.infer<typeof RenderProgressUnitSchema>;
export type RenderProgressRecord = z.infer<typeof RenderProgressRecordSchema>;
export type RenderProgressEvent = RenderProgressRecord['event'];

export function encodeProgressJsonl(record: RenderProgressRecord): string {
  return `${JSON.stringify(RenderProgressRecordSchema.parse(record))}\n`;
}

export function parseProgressJsonl(line: string): RenderProgressRecord {
  return RenderProgressRecordSchema.parse(JSON.parse(line));
}
