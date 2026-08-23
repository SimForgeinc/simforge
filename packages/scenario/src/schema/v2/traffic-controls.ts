/** Portable, authored traffic-control furniture and its deterministic program. */
import { z } from 'zod';

import { NumberOrExprSchema } from '../../expr/index.js';
import { FeatureRefSchema } from './common.js';
import { FramePoseSchema } from './roles.js';

export const CONTROL_INDICATIONS = [
  'green', 'yellow', 'red', 'flashing_yellow', 'flashing_red', 'off',
  'green_arrow', 'yellow_arrow', 'red_x', 'proceed', 'stop',
  /**
   * The two indications that change *turn* logic rather than through logic. A
   * flashing yellow arrow is what turns a protected left permissive — the whole
   * point of the FYA in the field — and a flashing red arrow is stop-then-turn.
   * Reversible-lane heads use the same pair. Without them an author has to fake
   * a permissive left with a round `flashing_yellow` on a head that is an arrow.
   */
  'flashing_yellow_arrow', 'flashing_red_arrow',
] as const;

export const ControlIndicationSchema = z.enum(CONTROL_INDICATIONS);

/**
 * What the law does while a control shows nothing at all.
 *
 * A dark head is not an uncontrolled junction. It reverts to an **all-way
 * stop** (MUTCD 4D.34, UVC 11-205, Highway Code r.176), which is the opposite
 * of "proceed". The exceptions are real but rare — a decommissioned head, a
 * jurisdiction that signs the blackout as a yield — so the default is the law
 * and the exception has to be written down.
 */
export const DARK_FALLBACKS = ['all_way_stop', 'uncontrolled', 'yield'] as const;

/** Right-of-way rule during a blackout. */
export const DarkFallbackSchema = z.enum(DARK_FALLBACKS);

export const TrafficControlPhaseSchema = z.strictObject({
  indication: ControlIndicationSchema,
  durationS: NumberOrExprSchema,
});

/** A portable stop line expressed in the scenario reference frame. */
export const PortableStopLineSchema = z.strictObject({
  pose: FramePoseSchema,
  feature: FeatureRefSchema.optional(),
});

/**
 * A temporary or scenario-owned control. Multiple controls may share a program
 * simply by authoring identical, offset phase lists (for example the two ends
 * of a one-lane work zone). `pose` is render placement; `stopLines` are the
 * executable right-of-way boundary and remain frame-relative across maps.
 */
export const TrafficControlSchema = z.strictObject({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/),
  kind: z.enum(['temporary_signal', 'lane_control', 'normal_signal', 'human_director']),
  pose: FramePoseSchema,
  feature: FeatureRefSchema.optional(),
  stopLines: z.array(PortableStopLineSchema).min(1).max(8),
  phases: z.array(TrafficControlPhaseSchema).min(1).max(32),
  offsetS: NumberOrExprSchema.default(0),
  loop: z.boolean().default(false),
  /** The right-of-way rule that applies while this control shows `off`. */
  darkFallback: DarkFallbackSchema.default('all_way_stop'),
  /** Minimum standstill at the line while this control is dark or flashing red, seconds. */
  darkDwellS: NumberOrExprSchema.default(1),
  label: z.string().max(200).optional(),
}).superRefine((control, ctx) => {
  const allowed: Record<typeof control.kind, readonly string[]> = {
    temporary_signal: ['green', 'yellow', 'red', 'flashing_yellow', 'flashing_red', 'off'],
    // A protected-turn head is a normal signal that can also show arrows, and
    // the flashing pair is exactly how a permissive-left conflict is authored.
    normal_signal: [
      'green', 'yellow', 'red', 'flashing_yellow', 'flashing_red', 'off',
      'green_arrow', 'yellow_arrow', 'flashing_yellow_arrow', 'flashing_red_arrow',
    ],
    // Lane-use control: the reversible-lane vocabulary. `red_x` closes the lane,
    // `green_arrow` opens it in the head's direction, and the flashing arrows
    // are the transitional states a reversal actually passes through.
    lane_control: [
      'green_arrow', 'yellow_arrow', 'red_x', 'off',
      'flashing_yellow_arrow', 'flashing_red_arrow',
    ],
    human_director: ['proceed', 'stop'],
  };
  control.phases.forEach((phase, index) => {
    if (!allowed[control.kind].includes(phase.indication)) {
      ctx.addIssue({
        code: 'custom', path: ['phases', index, 'indication'],
        message: `${phase.indication} is not valid for ${control.kind}`,
      });
    }
  });
});

export type TrafficControl = z.infer<typeof TrafficControlSchema>;
export type TrafficControlInput = z.input<typeof TrafficControlSchema>;
/** A control indication. */
export type ControlIndication = z.infer<typeof ControlIndicationSchema>;
/** Right-of-way rule during a blackout. */
export type DarkFallback = z.infer<typeof DarkFallbackSchema>;
