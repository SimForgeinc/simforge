/**
 * Invariants — what must stay true when a template is retargeted.
 *
 * `docs/research/retargeting.md` §Role bindings & invariants splits every fact
 * in a scenario into *preserved* and *re-derived*. Absolute transforms, `s`
 * values, route polylines and absolute speeds are re-derived on every site and
 * are never truth. What must survive is the *relations*: headways, gaps, TTC at
 * triggers, arrival offsets at the conflict point, closing-speed bands, event
 * order and the deceleration budget.
 *
 * That is this block. The solver treats invariants as the objective to hold
 * while it re-places actors; the tier-2 validator re-checks them against the
 * simulated trace and reports residuals. An invariant is therefore both the
 * author's intent and the acceptance test for the transfer — which is exactly
 * why "degradation may relax presentation, never intent" is checkable at all.
 */

import { z } from 'zod';

import { NumberOrExprSchema } from '../../expr/index.js';
import { InteractionRefSchema, RangeSchema, RoleRefSchema } from './common.js';
import { PointRefSchema } from './interactions.js';

const invariantBase = {
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  /** `required` invariants make a site infeasible when they cannot hold. */
  essentiality: z.enum(['required', 'preferred', 'cosmetic']).default('required'),
  /** Restrict the check to a window on the clip timeline, seconds. */
  window: z.tuple([NumberOrExprSchema, NumberOrExprSchema]).optional(),
  label: z.string().max(200).optional(),
};

/** Time headway between two actors must stay in range. */
export const HeadwayInvariantSchema = z.strictObject({
  ...invariantBase,
  kind: z.literal('headway'),
  of: RoleRefSchema,
  to: RoleRefSchema,
  /** Seconds. */
  range: RangeSchema,
});

/** Bumper-to-bumper gap, in seconds or metres. */
export const GapInvariantSchema = z.strictObject({
  ...invariantBase,
  kind: z.literal('gap'),
  of: RoleRefSchema,
  to: RoleRefSchema,
  unit: z.enum(['time', 'distance']),
  range: RangeSchema,
});

/** Time to collision, typically bounded to the 1.2–2.5 s critical band. */
export const TtcInvariantSchema = z.strictObject({
  ...invariantBase,
  kind: z.literal('ttc'),
  of: RoleRefSchema,
  to: RoleRefSchema,
  range: RangeSchema,
  /** `min` checks the episode minimum; `always` checks every tick in `window`. */
  mode: z.enum(['min', 'always']).default('min'),
});

/** Route-aware TTC at an overlapping future conflict-zone occupancy. */
export const PathTtcInvariantSchema = z.strictObject({
  ...invariantBase,
  kind: z.literal('path_ttc'),
  of: RoleRefSchema,
  to: RoleRefSchema,
  range: RangeSchema,
});

/** Predicted post-encroachment time at a future route intersection. */
export const PetInvariantSchema = z.strictObject({
  ...invariantBase,
  kind: z.literal('pet'),
  of: RoleRefSchema,
  to: RoleRefSchema,
  range: RangeSchema,
});

/** Contact-free closest OBB clearance for a pedestrian/target near miss. */
export const NearMissInvariantSchema = z.strictObject({
  ...invariantBase,
  kind: z.literal('near_miss'),
  pedestrian: RoleRefSchema,
  target: RoleRefSchema,
  /** Exact sampled footprint-to-footprint clearance, metres. Zero is contact. */
  clearanceRangeM: RangeSchema,
});

/** Arrival-time offset at a conflict point — the criticality of a crossing conflict. */
export const ArrivalInvariantSchema = z.strictObject({
  ...invariantBase,
  kind: z.literal('arrival'),
  of: RoleRefSchema,
  at: PointRefSchema,
  syncWith: RoleRefSchema,
  /** Seconds: `of` arrives this long after `syncWith`. */
  deltaTRange: RangeSchema,
});

/** Relative approach speed between two actors, kph. */
export const ClosingSpeedInvariantSchema = z.strictObject({
  ...invariantBase,
  kind: z.literal('closing_speed'),
  of: RoleRefSchema,
  to: RoleRefSchema,
  rangeKph: RangeSchema,
});

/**
 * Speed as a fraction of the posted limit.
 *
 * The portable way to say "flowing traffic" (≈[0.85, 1.05]) or "a speeder"
 * (≈[1.3, 1.6]) without writing a number that is wrong on the next map.
 */
export const SpeedRelLimitInvariantSchema = z.strictObject({
  ...invariantBase,
  kind: z.literal('speed_rel_limit'),
  of: RoleRefSchema,
  rangeFrac: RangeSchema,
});

/** Interactions must fire in this order. */
export const EventOrderInvariantSchema = z
  .strictObject({
    ...invariantBase,
    kind: z.literal('event_order'),
    events: z.array(InteractionRefSchema).min(2).max(16),
    /** `strict` forbids simultaneity; otherwise equal fire times are allowed. */
    strict: z.boolean().default(true),
    /** Minimum separation between consecutive events, seconds. */
    minSeparationS: NumberOrExprSchema.optional(),
  })
  .check((ctx) => {
    const seen = new Set<string>();
    ctx.value.events.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.issues.push({
          code: 'custom',
          message: `event "${id}" appears twice in the order`,
          path: ['events', index],
          input: id,
        });
      }
      seen.add(id);
    });
  });

/* ----------------------------------------------------------- perception --
 *
 * Invariants over the sensor channel. These exist so an author can REQUIRE a
 * perception failure rather than hope for one: a fog scenario whose ego happens
 * to detect the pedestrian on time is not the scenario that was written, and
 * without these it would pass silently.
 *
 * All four are relations, not absolutes, so they retarget like everything else:
 * "at least 4 s of dropout" survives a move to a different map, "detected at
 * 41 m" does not.
 */

const perceptionPairBase = {
  /** The observer — the actor carrying the sensor. */
  of: RoleRefSchema,
  /** The actor that should (or should not) be perceived. */
  to: RoleRefSchema,
  /** Sensor id on `of`. Omitted grades the whole suite. */
  sensor: z.string().min(1).max(128).optional(),
};

/**
 * A dropout: a run in which the target was geometrically available to the
 * sensor — in range, in frame, not occluded away — and still was not reported.
 *
 * `reason` narrows the requirement to a physical cause, so "the ego lost her in
 * the fog for four seconds" cannot be satisfied by "the ego lost her behind a
 * van for four seconds".
 */
export const DetectionGapInvariantSchema = z.strictObject({
  ...invariantBase,
  ...perceptionPairBase,
  kind: z.literal('detection_gap'),
  /** Seconds. */
  range: RangeSchema,
  /** `longest` checks the worst single dropout; `total` checks their sum. */
  metric: z.enum(['longest', 'total']).default('longest'),
  /** Require the dominant cause of the dropout to be this. */
  reason: z
    .enum([
      'occluded',
      'atmospheric_attenuation',
      'below_angular_resolution',
      'low_light',
      'glare',
    ])
    .optional(),
});

/** Clip time at which the sensor first reported the target, seconds. */
export const TimeToFirstDetectionInvariantSchema = z.strictObject({
  ...invariantBase,
  ...perceptionPairBase,
  kind: z.literal('time_to_first_detection'),
  range: RangeSchema,
});

/**
 * Seconds between the world making the target available and the sensor
 * admitting it exists.
 *
 * This is the one that says *the danger is the perception failure, not the
 * dynamics*: line of sight opened at t₀, the stack reported it at t₁, and the
 * scenario is about t₁ − t₀. Requiring it non-zero is requiring that geometry
 * was never the limiting factor.
 */
export const PerceptionLagInvariantSchema = z.strictObject({
  ...invariantBase,
  ...perceptionPairBase,
  kind: z.literal('perception_lag'),
  /** Seconds. */
  range: RangeSchema,
});

/**
 * Exposure to a declared map/percept divergence, in seconds.
 *
 * Recorded exposure only — the simulator does not feed a faded lane line back
 * into steering, and this invariant does not pretend it does. It requires that
 * the ego actually drove through the disagreement.
 */
export const MapDivergenceInvariantSchema = z.strictObject({
  ...invariantBase,
  kind: z.literal('map_divergence'),
  /** The observer whose exposure is measured. */
  of: RoleRefSchema,
  /** Id of a declared `perception.mapDivergences` entry. */
  divergence: z.string().min(1).max(128),
  /** Seconds of exposure. */
  range: RangeSchema,
});

/**
 * Deceleration budget, m/s².
 *
 * 5.5 is the comfort limit, 8.0 the hard limit used by the feasibility guards;
 * requiring more than about μ·g at first possible detection means the scenario
 * is physically unavoidable and belongs in the reject filter, not the library.
 */
export const DecelBudgetInvariantSchema = z.strictObject({
  ...invariantBase,
  kind: z.literal('decel_budget'),
  of: RoleRefSchema,
  maxMps2: NumberOrExprSchema,
});

/** Any invariant. */
export const InvariantSchema = z.discriminatedUnion('kind', [
  HeadwayInvariantSchema,
  GapInvariantSchema,
  TtcInvariantSchema,
  PathTtcInvariantSchema,
  PetInvariantSchema,
  NearMissInvariantSchema,
  ArrivalInvariantSchema,
  ClosingSpeedInvariantSchema,
  SpeedRelLimitInvariantSchema,
  EventOrderInvariantSchema,
  DecelBudgetInvariantSchema,
  DetectionGapInvariantSchema,
  TimeToFirstDetectionInvariantSchema,
  PerceptionLagInvariantSchema,
  MapDivergenceInvariantSchema,
]);

/** An invariant. */
export type Invariant = z.infer<typeof InvariantSchema>;
/** An invariant as authored. */
export type InvariantInput = z.input<typeof InvariantSchema>;

/** Comfort deceleration limit, m/s². */
export const COMFORT_DECEL_MPS2 = 5.5;
/** Hard deceleration limit, m/s². */
export const HARD_DECEL_MPS2 = 8.0;
