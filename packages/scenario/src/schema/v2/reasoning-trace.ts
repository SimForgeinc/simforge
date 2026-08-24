import { z } from 'zod';

import { RoleRefSchema, V2_ID_PATTERN } from './common.js';

export const ReasoningTraceSegmentSchema = z.strictObject({
  id: z.string().regex(V2_ID_PATTERN, 'reasoning trace id must use v2 id syntax'),
  actor: RoleRefSchema,
  startS: z.number().min(0).max(120),
  endS: z.number().gt(0).max(120),
  observation: z.string().max(4000).default(''),
  action: z.string().max(4000).default(''),
}).check((ctx) => {
  if (ctx.value.endS <= ctx.value.startS) {
    ctx.issues.push({
      code: 'custom',
      message: 'reasoning trace endS must be after startS',
      path: ['endS'],
      input: ctx.value.endS,
    });
  }
});

export type ReasoningTraceSegment = z.infer<typeof ReasoningTraceSegmentSchema>;
