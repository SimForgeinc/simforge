import { z } from 'zod';

import type { RenderIntentV1, RenderSourceV3 } from '@simforge-oss/scenario';

export const FIXED_SCHEDULE_V1_SCHEMA = 'uniscenario.render-fixed-schedule/v1' as const;

export const FixedScheduleSchema = z.strictObject({
  schema: z.literal(FIXED_SCHEDULE_V1_SCHEMA),
  sourceId: z.string().min(1).max(128),
  startSeconds: z.number().finite().nonnegative(),
  endSeconds: z.number().finite().positive(),
  framesPerSecond: z.number().finite().positive().max(1000),
  frameCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).check((ctx) => {
  if (ctx.value.endSeconds <= ctx.value.startSeconds) {
    ctx.issues.push({ code: 'custom', path: ['endSeconds'], message: 'endSeconds must be greater than startSeconds', input: ctx.value.endSeconds });
  }
});

export type FixedSchedule = z.infer<typeof FixedScheduleSchema>;

function sourceRate(source: RenderSourceV3, videoRate: number | undefined): number {
  if (source.modality === 'lidar') return source.attributes.rotationFrequencyHz;
  if (source.modality === 'radar') {
    if (videoRate === undefined) {
      throw new Error(`radar source ${source.outputName} requires renderSpec.video.fps to define its fixed sample schedule`);
    }
    return videoRate;
  }
  return source.attributes.fps;
}

export function createFixedSchedules(intent: RenderIntentV1): readonly FixedSchedule[] {
  const { startSeconds, endSeconds } = intent.renderSpec.clip;
  return intent.renderSpec.sources.map((source) => {
    const framesPerSecond = sourceRate(source, intent.renderSpec.video?.fps);
    const exactFrames = (endSeconds - startSeconds) * framesPerSecond;
    const nearestInteger = Math.round(exactFrames);
    const frameCount = Math.abs(exactFrames - nearestInteger) <= Number.EPSILON * Math.max(1, exactFrames) * 8
      ? nearestInteger
      : Math.ceil(exactFrames);
    return FixedScheduleSchema.parse({
      schema: FIXED_SCHEDULE_V1_SCHEMA,
      sourceId: source.outputName,
      startSeconds,
      endSeconds,
      framesPerSecond,
      frameCount,
    });
  });
}

/** Returns the exact index-derived timestamp; callers must not accumulate dt. */
export function frameTimestampSeconds(schedule: FixedSchedule, frameIndex: number): number {
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= schedule.frameCount) {
    throw new RangeError(`frameIndex ${frameIndex} is outside [0, ${schedule.frameCount})`);
  }
  return schedule.startSeconds + frameIndex / schedule.framesPerSecond;
}
