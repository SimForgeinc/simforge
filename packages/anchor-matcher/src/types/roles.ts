/**
 * `RoleBinding` — how an actor attaches to matched structure.
 *
 * The seven kinds from `docs/research/retargeting.md` § Role bindings. The
 * matcher performs the **structural** pass only: which lane, which gate, which
 * conflict point, which route. The *longitudinal* solve (bisection on spawn s
 * for arrival invariants) belongs to `sim-engine`; this package hands it the
 * conflict points and route lane chains it needs.
 */

import { NumberOrExprSchema } from '@uniscenarios/scenario-model';
import { z } from 'zod';
import { EssentialitySchema, TurnSchema, ApproachRelationSchema } from './anchor.js';

/**
 * What to do when the requested lane offset does not exist at a site.
 *
 * The default is `fail` everywhere, deliberately. `clamp` moves an actor to the
 * nearest lane that does exist, which on a one-lane-per-direction corridor —
 * ~70% of the driving lanes on the dev maps — is the *reference* lane, i.e. the
 * ego's own. That silently converts "a car in the next lane over" into "a car
 * interpenetrating the ego", and it does so with a note rather than a failure,
 * so the cell still runs and still reports a metric. Relocation has to be
 * something an author asks for, never something they get by omission.
 */
export const OnMissingSchema = z.enum(['clamp', 'drop', 'fail']);
export type OnMissing = z.infer<typeof OnMissingSchema>;

const base = {
  role: z.string().min(1),
  /**
   * How essential this actor is. `required` roles can never be dropped or
   * clamped without the site becoming infeasible.
   */
  essentiality: EssentialitySchema.default('required'),
  requiredSameSegmentAs: z.string().min(1).optional(),
  requiredSameRoadSectionAs: z.string().min(1).optional(),
  requiredHeadingRelation: z.strictObject({
    role: z.string().min(1),
    relation: z.enum(['parallel', 'antiparallel']),
    maxErrorDeg: z.number().min(0).max(45),
  }).optional(),
};

/**
 * A station (`dsM`) is `number | Expr` for the same reason an initial speed is:
 * "eight seconds of run-up" is `-(0.8 * lane.speedLimitKph / 3.6) * 8`, and the
 * posted limit is a fact about the *site*, not about the template. Collapsing
 * that to a number before matching was the whole ENDPOINT_CLAMP defect class:
 * the adapter evaluated it as `0`, the matcher bound the ego at the stop line,
 * built a reference path with no run-up, and the materializer then clamped the
 * real station onto the road end. The matcher resolves it per candidate site
 * instead — see `roleStation` in `bind.ts`.
 */
export const RoleBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...base,
    kind: z.literal('on_reference'),
    dsM: NumberOrExprSchema.default(0),
    tFrac: z.number().default(0),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('lane_offset'),
    /** Signed same-direction lane index; +1 is one lane to the left of travel. */
    k: z.number().int(),
    onMissing: OnMissingSchema.default('fail'),
    dsM: NumberOrExprSchema.default(0),
    tFrac: z.number().default(0),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('at_lane_drop'),
    /** Anchor feature whose concrete identity is `lane_drop:<terminating-rsl>@<s>`. */
    feature: z.string().min(1),
    lane: z.enum(['terminating', 'continuing_sibling']),
    dsM: NumberOrExprSchema.default(0),
    tFrac: z.number().default(0),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('opposing'),
    /** 0 = innermost opposing lane. */
    index: z.number().int().min(0).default(0),
    dsM: NumberOrExprSchema.default(0),
    tFrac: z.number().default(0),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('conflicting_gate'),
    /** Anchor feature id of the junction this conflict happens in. */
    feature: z.string().min(1),
    from: ApproachRelationSchema,
    turn: TurnSchema,
    /** Crossing angle of the template's original site — used to rank candidates. */
    templateCrossingAngleDeg: z.number().min(0).max(180).optional(),
    arriveAtConflict: z
      .strictObject({ relativeTo: z.string().min(1), deltaT: z.number() })
      .optional(),
    /** Hard minimum connected route before the conflicting gate. */
    minUpstreamRunwayM: z.number().min(0).optional(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('on_crossing'),
    feature: z.string().min(1),
    startFrac: z.number().min(0).max(1).default(0),
    direction: z.enum(['left_to_right', 'right_to_left']).default('left_to_right'),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('in_parking_zone'),
    feature: z.string().min(1),
    side: z.enum(['left', 'right']).default('right'),
    slotIndex: z.number().int().min(0).default(0),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('relative_to'),
    ref: z.string().min(1),
    /** Lane delta relative to the referenced role, in signed same-direction k. */
    dLane: z.number().int().default(0),
    /**
     * What to do when `ref`'s lane plus `dLane` is not a lane at this site.
     * Same vocabulary and same loud default as {@link OnMissingSchema} on
     * `lane_offset`: a `dLane` is a lane request, not a hint.
     */
    onMissing: OnMissingSchema.default('fail'),
    dsM: NumberOrExprSchema.default(0),
    tFrac: z.number().optional(),
  }),
]);

export type RoleBinding = z.infer<typeof RoleBindingSchema>;
export type RoleBindingKind = RoleBinding['kind'];

/** Parse + default-fill an untrusted role list. */
export function parseRoleBindings(input: unknown): RoleBinding[] {
  return z.array(RoleBindingSchema).parse(input);
}
