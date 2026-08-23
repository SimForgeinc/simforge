/**
 * Shared v2 building blocks: reference types, ranges, and the clause wrapper.
 *
 * ## Reference discipline
 *
 * The single hardest-won rule in this schema is that **an LLM may never write a
 * coordinate or a road id**. Every spatial thing is named by a reference into
 * the document itself — a role id, a feature id, an interaction id — or by a
 * frame-relative pose whose meaning is fixed by the matched site, not by the
 * template. There is therefore nothing in a v2 template that can be
 * hallucinated into a map; the worst an author can do is name something the
 * document does not contain, which the structural validator catches by id.
 *
 * The four reference kinds get their own schemas and their own type aliases so
 * the *intent* is visible at every call site. They are not branded types: a
 * brand would have to be stripped at every JSON boundary (files, CLI, LLM
 * output) and the strip points are exactly where the confusion happens, so the
 * brand buys nothing. Resolution is enforced instead — the structural validator
 * checks every reference against the list it is supposed to name, and reports
 * `role_ref_unknown` / `feature_ref_unknown` / `interaction_ref_unknown`
 * separately, which is the check a brand would only have approximated.
 */

import { z } from 'zod';

/** Identifier syntax shared by every id in a v2 template. */
export const V2_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const idSchema = (what: string) =>
  z
    .string()
    .regex(V2_ID_PATTERN, `${what} must start with a letter and use only [A-Za-z0-9_-], max 64 chars`);

/** Id of a {@link RoleBinding}. */
export const RoleIdSchema = idSchema('role id');
/** Id of an anchor feature. */
export const FeatureIdSchema = idSchema('feature id');
/** Id of an {@link Interaction}. */
export const InteractionIdSchema = idSchema('interaction id');
/** Id of a parameter. */
export const ParamIdSchema = idSchema('param id');
/** Id of a prop placement. */
export const PropIdSchema = idSchema('prop id');

/**
 * Reference to a role. `@world` is the one reserved value: it is the actor of
 * `set` interactions that address the environment or a traffic signal rather
 * than a vehicle.
 */
export const WORLD_ROLE_REF = '@world';

/** A role reference (a role id). */
export const RoleRefSchema = RoleIdSchema;
/** A role reference that may also be `@world`. */
export const ActorRefSchema = z.union([z.literal(WORLD_ROLE_REF), RoleIdSchema]);
/** A reference to an anchor feature. */
export const FeatureRefSchema = FeatureIdSchema;
/** A reference to another interaction (for `after` and `event_order`). */
export const InteractionRefSchema = InteractionIdSchema;

/** A role reference. */
export type RoleRef = z.infer<typeof RoleRefSchema>;
/** A role reference or `@world`. */
export type ActorRef = z.infer<typeof ActorRefSchema>;
/** An anchor-feature reference. */
export type FeatureRef = z.infer<typeof FeatureRefSchema>;
/** An interaction reference. */
export type InteractionRef = z.infer<typeof InteractionRefSchema>;

/**
 * How badly a clause is wanted.
 *
 * `required` clauses are pass/fail for the matcher and may never be relaxed by
 * degradation; `preferred` contributes to the score and may be substituted;
 * `cosmetic` may be dropped entirely. See `docs/research/retargeting.md`
 * §Degradation semantics — *degradation may relax presentation, never intent*.
 */
export const EssentialitySchema = z.enum(['required', 'preferred', 'cosmetic']);
/** Clause essentiality. */
export type Essentiality = z.infer<typeof EssentialitySchema>;

/**
 * An inclusive numeric range `[min, max]`; `null` on either end means open.
 *
 * A tuple rather than `{min, max}` because it is half the tokens for an LLM to
 * emit and impossible to get half-right (an object invites `{min: 3}` with a
 * silently-absent max, which reads as "exactly 3 or more" to a human and as
 * "unconstrained above" to the matcher).
 */
export const RangeSchema = z
  .tuple([z.number().nullable(), z.number().nullable()])
  .check((ctx) => {
    const [min, max] = ctx.value;
    if (min !== null && max !== null && min > max) {
      ctx.issues.push({
        code: 'custom',
        message: `range [${min}, ${max}] is empty: min exceeds max`,
        path: [],
        input: ctx.value,
      });
    }
    if (min === null && max === null) {
      ctx.issues.push({
        code: 'custom',
        message: 'range [null, null] constrains nothing; drop the clause instead',
        path: [],
        input: ctx.value,
      });
    }
  });

/** An inclusive `[min, max]` range with open ends allowed. */
export type Range = z.infer<typeof RangeSchema>;

/** True when `value` falls inside `range` (open ends always satisfied). */
export function rangeContains(range: Range, value: number): boolean {
  const [min, max] = range;
  if (min !== null && value < min) return false;
  if (max !== null && value > max) return false;
  return true;
}

/**
 * Wrap a predicate value in the clause envelope the matcher scores.
 *
 * Every anchor clause has the same shape — `{value, essentiality, weight?}` —
 * so `ClauseResult`s come back with a uniform explanation, and the site picker
 * can render any clause it has never heard of.
 */
export function clause<T extends z.ZodType>(value: T) {
  return z.strictObject({
    value,
    essentiality: EssentialitySchema.default('required'),
    /** Relative weight among `preferred`/`cosmetic` clauses. Ignored when `required`. */
    weight: z.number().min(0).max(100).optional(),
  });
}

/** The clause envelope for a value of type `T`. */
export interface Clause<T> {
  value: T;
  essentiality: Essentiality;
  weight?: number | undefined;
}

/** Convenience: a `[min, max]` clause. */
export const RangeClauseSchema = clause(RangeSchema);
/** A range clause. */
export type RangeClause = z.infer<typeof RangeClauseSchema>;

/** Untyped forward-compat bag, identical in meaning to the v1 one. */
export const V2ExtensionsSchema = z.record(z.string(), z.unknown());
