/** Map-bound edits to the phase plan of existing physical traffic signals. */
import { z } from 'zod';

import { ControlIndicationSchema } from './traffic-controls.js';

const IdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);

/** A normal road signal cannot display lane-control or human-director states. */
export const MAP_SIGNAL_INDICATIONS = [
  'green', 'yellow', 'red', 'flashing_yellow', 'flashing_red', 'off',
] as const;

export const MapSignalPlanClipSchema = z.strictObject({
  id: IdSchema,
  startS: z.number().finite().min(0),
  endS: z.number().finite().gt(0),
  reference: z.strictObject({
    controllerId: z.string().min(1).max(256),
    headId: z.string().min(1).max(256),
  }),
  indication: ControlIndicationSchema.refine(
    (value): value is typeof MAP_SIGNAL_INDICATIONS[number] => MAP_SIGNAL_INDICATIONS.includes(value as typeof MAP_SIGNAL_INDICATIONS[number]),
    { message: 'map signal clips require a normal-signal indication' },
  ),
}).check((ctx) => {
  if (ctx.value.endS <= ctx.value.startS) {
    ctx.issues.push({
      code: 'custom', path: ['endS'], input: ctx.value.endS,
      message: 'map signal clip endS must be greater than startS (clips are half-open)',
    });
  }
});

export const MapSignalPlanSchema = z.strictObject({
  id: IdSchema,
  version: z.literal(1),
  binding: z.strictObject({
    mapId: z.string().min(1).max(256),
    junctionId: z.string().min(1).max(256),
    controlDigest: z.string().min(1).max(256),
  }),
  clips: z.array(MapSignalPlanClipSchema).max(256).default([]),
}).check((ctx) => {
  const seen = new Set<string>();
  ctx.value.clips.forEach((clip, index) => {
    if (seen.has(clip.id)) {
      ctx.issues.push({
        code: 'custom', path: ['clips', index, 'id'], input: clip.id,
        message: `duplicate map signal clip id "${clip.id}"`,
      });
    }
    seen.add(clip.id);
  });
  const ordered = ctx.value.clips
    .map((clip, index) => ({ clip, index }))
    .sort((a, b) => a.clip.startS - b.clip.startS || a.clip.endS - b.clip.endS || a.clip.id.localeCompare(b.clip.id));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (current.clip.startS < previous.clip.endS) {
      ctx.issues.push({
        code: 'custom', path: ['clips', current.index, 'startS'], input: current.clip.startS,
        message: `map signal clip overlaps "${previous.clip.id}"; clip intervals are half-open [startS, endS)`,
      });
    }
  }
});

export type MapSignalPlanClip = z.infer<typeof MapSignalPlanClipSchema>;
export type MapSignalPlan = z.infer<typeof MapSignalPlanSchema>;
export type MapSignalIndication = typeof MAP_SIGNAL_INDICATIONS[number];
