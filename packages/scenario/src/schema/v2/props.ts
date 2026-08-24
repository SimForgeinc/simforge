/**
 * Layer 3 of the PEGASUS stack: temporary modifications — the placeable prop
 * layer (parked rows, cones, barriers, hedges, double-parked trucks).
 *
 * Props are frame-relative like roles, and they reference the prop catalog by
 * id. Two design points:
 *
 * 1. **Occlusion is a modifier, not a scenario.** A prop that occludes carries
 *    `targetRevealToConflictS` — the derived metric that actually matters
 *    (line-of-sight opening → collision point at current closing speeds;
 *    critical band 0.4–1.5 s). The author tunes that readout, not the prop's
 *    metres. Because the metric is a relation between an observer and a target,
 *    `occludes` (who is hidden from whom) is required whenever the target time
 *    is set — a bare "reveal time" with no pair is meaningless, and the
 *    structural validator says so rather than guessing the pair.
 * 2. **`repeat` exists** because a parked row is twenty props and no author
 *    should place twenty props. It expands at instantiation time, not here.
 */

import { z } from 'zod';

import { ExprSchema, NumberOrExprSchema } from '../../expr/index.js';
import { FeatureRefSchema, PropIdSchema, RoleRefSchema, V2ExtensionsSchema } from './common.js';
import { FramePoseSchema } from './roles.js';

/** Who is prevented from seeing whom. */
export const OcclusionPairSchema = z.strictObject({
  /** The actor whose view is blocked (usually the metric subject). */
  observer: RoleRefSchema,
  /** The actor that is hidden. */
  target: RoleRefSchema,
});

const TFracOrExprSchema = z.union([z.number().min(-1).max(1), ExprSchema]);

/** Repeat a prop along the corridor — parked rows, cone tapers, barrier runs. */
export const PropRepeatSchema = z.strictObject({
  count: z.number().int().min(2).max(200),
  /** Longitudinal spacing between instances, metres. */
  spacingM: NumberOrExprSchema,
  /** Lateral drift per instance, fraction of lane width — makes a taper. May be parameterised. */
  tFracStep: TFracOrExprSchema.default(0),
});

/**
 * Rigidly attach a prop to an actor-local frame. Longitudinal is forward,
 * lateral is left, and height is above the carrier's ground-contact point.
 * The prop inherits the carrier's route pose for the complete episode.
 */
export const PropAttachmentSchema = z.strictObject({
  role: RoleRefSchema,
  longitudinalM: z.number().finite().min(-20).max(20).default(0),
  lateralM: z.number().finite().min(-20).max(20).default(0),
  heightM: z.number().finite().min(0).max(20).default(0),
  headingOffsetRad: z.number().min(-Math.PI).max(Math.PI).default(0),
});

/** One placed prop (or a repeated run of them). */
export const PropPlacementSchema = z.strictObject({
  id: PropIdSchema,
  /** Prop catalog id. Resolved at author time; a miss must fail loudly. */
  catalogId: z.string().min(1).max(200),
  label: z.string().max(200).optional(),
  /** Frame-relative placement. */
  pose: FramePoseSchema,
  /** Anchor the pose to a feature instead of the frame origin. */
  feature: FeatureRefSchema.optional(),
  /** Rigid actor-local attachment; `pose` remains the authoring/fallback pose. */
  attachment: PropAttachmentSchema.optional(),
  /** Yaw relative to the lane tangent, radians. */
  headingOffsetRad: z.number().min(-Math.PI).max(Math.PI).default(0),
  /** Uniform scale. Height class is what decides whether a prop occludes. */
  scale: z.number().positive().max(10).default(1),
  /** Declares the prop as a sight-line blocker between two roles. */
  occludes: OcclusionPairSchema.optional(),
  /**
   * The authored criticality of the occlusion, seconds. The solver nudges the
   * prop along the corridor until the simulated reveal-to-conflict time matches.
   */
  targetRevealToConflictS: NumberOrExprSchema.optional(),
  repeat: PropRepeatSchema.optional(),
  /** `cosmetic` props may be dropped by degradation; occluders never should be. */
  essentiality: z.enum(['required', 'preferred', 'cosmetic']).default('preferred'),
  extensions: V2ExtensionsSchema.optional(),
});

/** A placed prop. */
export type PropPlacement = z.infer<typeof PropPlacementSchema>;
/** A placed prop as authored. */
export type PropPlacementInput = z.input<typeof PropPlacementSchema>;
export type PropAttachment = z.infer<typeof PropAttachmentSchema>;
/** An occlusion pair. */
export type OcclusionPair = z.infer<typeof OcclusionPairSchema>;
