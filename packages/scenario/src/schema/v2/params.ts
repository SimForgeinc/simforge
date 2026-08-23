/**
 * Parameter declarations and constraints.
 *
 * A template is a *logical* scenario: it declares axes and ranges, and the
 * sampler makes the thousands of concretes (`docs/research/
 * interactions-and-edge-cases.md` §Parameterization). Four kinds:
 *
 * - `continuous` — sampled over a closed range (Halton/LHS for coverage);
 * - `discrete` — an explicit list of numbers, or a range walked in steps
 *   (full-factorial when small);
 * - `categorical` — a list of strings (actor class, weather preset, …);
 * - `derived` — not sampled at all: an expression over the other params and
 *   site facts, so `param.gapM = param.headwayS * param.vLeadKph / 3.6` stays
 *   consistent by construction instead of by the author's arithmetic.
 *
 * `ParamConstraint` is a relation between two expressions. Constraints are the
 * reason the AST stays numeric-only: a boolean expression grammar would need
 * its own type system, whereas `{left, op, right}` covers every constraint the
 * research documents actually ask for (`v_lead <= v_ego`, `gap >= 2 * length`)
 * and is trivially renderable in a UI as three widgets.
 */

import { z } from 'zod';

import { ExprSchema, NumberOrExprSchema } from '../../expr/index.js';
import { ParamIdSchema, RangeSchema } from './common.js';

/** Sampling strategy hint for continuous params. The sampler owns the details. */
export const DistributionSchema = z.enum(['uniform', 'halton', 'lhs', 'normal']);

const paramBase = {
  id: ParamIdSchema,
  /** One line, shown in the parameter panel and in generated manifests. */
  description: z.string().max(500).optional(),
  /** Physical unit, e.g. `kph`, `s`, `m`, `m/s^2`. Documentation only. */
  unit: z.string().max(32).optional(),
  /**
   * Criticality tier from the research: 1 = criticality axis, 2 = coverage
   * axis, 3 = fix or seed. Batch planners use it to decide what to vary.
   */
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
};

/** A continuous axis over a closed range. */
export const ContinuousParamSchema = z
  .strictObject({
    ...paramBase,
    type: z.literal('continuous'),
    range: RangeSchema,
    default: z.number().optional(),
    distribution: DistributionSchema.default('uniform'),
  })
  .check((ctx) => {
    const [min, max] = ctx.value.range;
    if (min === null || max === null) {
      ctx.issues.push({
        code: 'custom',
        message: 'a continuous parameter needs both ends of its range; sampling an open range is undefined',
        path: ['range'],
        input: ctx.value.range,
      });
    }
  });

/** A numeric axis with a finite set of values. */
export const DiscreteParamSchema = z
  .strictObject({
    ...paramBase,
    type: z.literal('discrete'),
    /** Explicit values. Mutually exclusive with `range` + `step`. */
    values: z.array(z.number().finite()).min(1).optional(),
    /** Walked range. Mutually exclusive with `values`. */
    range: RangeSchema.optional(),
    step: z.number().positive().optional(),
    default: z.number().optional(),
  })
  .check((ctx) => {
    const { values, range, step } = ctx.value;
    const hasValues = values !== undefined;
    const hasWalk = range !== undefined || step !== undefined;
    if (hasValues === hasWalk) {
      ctx.issues.push({
        code: 'custom',
        message: 'a discrete parameter needs exactly one of `values` or (`range` + `step`)',
        path: [],
        input: ctx.value,
      });
      return;
    }
    if (hasWalk && (range === undefined || step === undefined)) {
      ctx.issues.push({
        code: 'custom',
        message: '`range` and `step` must be given together',
        path: [],
        input: ctx.value,
      });
    }
    if (range && (range[0] === null || range[1] === null)) {
      ctx.issues.push({
        code: 'custom',
        message: 'a walked discrete range must be closed at both ends',
        path: ['range'],
        input: range,
      });
    }
  });

/** A string-valued axis. */
export const CategoricalParamSchema = z
  .strictObject({
    ...paramBase,
    type: z.literal('categorical'),
    values: z.array(z.string().min(1).max(64)).min(1),
    default: z.string().optional(),
  })
  .check((ctx) => {
    const { values, default: dflt } = ctx.value;
    if (dflt !== undefined && !values.includes(dflt)) {
      ctx.issues.push({
        code: 'custom',
        message: `default "${dflt}" is not one of the declared values`,
        path: ['default'],
        input: dflt,
      });
    }
    if (new Set(values).size !== values.length) {
      ctx.issues.push({
        code: 'custom',
        message: 'categorical values must be unique',
        path: ['values'],
        input: values,
      });
    }
  });

/** A value computed from other params and site facts; never sampled. */
export const DerivedParamSchema = z.strictObject({
  ...paramBase,
  type: z.literal('derived'),
  expr: ExprSchema,
});

/** Any parameter declaration. */
export const ParamDeclSchema = z.discriminatedUnion('type', [
  ContinuousParamSchema,
  DiscreteParamSchema,
  CategoricalParamSchema,
  DerivedParamSchema,
]);

/** Relational operators available to constraints and variant conditions. */
export const RELATION_OPS = ['<', '<=', '>', '>=', '==', '!='] as const;
/** A relational operator. */
export const RelationOpSchema = z.enum(RELATION_OPS);

/**
 * A relation between two numeric expressions.
 *
 * Used for `params.constraints` (rejected draws) and for `variants[].when`
 * (author-defined degraded renditions keyed on a site fact such as
 * `lane.widthM < 3`).
 */
export const ParamConstraintSchema = z.strictObject({
  left: NumberOrExprSchema,
  op: RelationOpSchema,
  right: NumberOrExprSchema,
  /** Shown to the author (and to the LLM) when the constraint rejects a draw. */
  message: z.string().max(300).optional(),
});

/** The `params` block: declarations plus cross-parameter constraints. */
export const ParamsBlockSchema = z.strictObject({
  declarations: z.array(ParamDeclSchema).max(64).default([]),
  constraints: z.array(ParamConstraintSchema).max(64).default([]),
});

/** A parameter declaration. */
export type ParamDecl = z.infer<typeof ParamDeclSchema>;
/** A continuous parameter. */
export type ContinuousParam = z.infer<typeof ContinuousParamSchema>;
/** A discrete parameter. */
export type DiscreteParam = z.infer<typeof DiscreteParamSchema>;
/** A categorical parameter. */
export type CategoricalParam = z.infer<typeof CategoricalParamSchema>;
/** A derived parameter. */
export type DerivedParam = z.infer<typeof DerivedParamSchema>;
/** A relation between two expressions. */
export type ParamConstraint = z.infer<typeof ParamConstraintSchema>;
/** The parameter block. */
export type ParamsBlock = z.infer<typeof ParamsBlockSchema>;
/** A relational operator. */
export type RelationOp = z.infer<typeof RelationOpSchema>;

/** Evaluate a relation once both sides are known. */
export function compareWith(op: RelationOp, left: number, right: number): boolean {
  switch (op) {
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '==':
      return left === right;
    case '!=':
      return left !== right;
  }
}

/**
 * The value a parameter takes when nothing has sampled it yet.
 *
 * Used by the static validator to evaluate trigger times: a template whose
 * timings depend on parameters is still statically analysable at its declared
 * defaults, which is where authoring mistakes actually live. Falls back to the
 * range midpoint / first value so an author who omitted `default` still gets
 * the timing analysis.
 */
export function paramDefault(decl: ParamDecl): number | undefined {
  switch (decl.type) {
    case 'continuous': {
      if (decl.default !== undefined) return decl.default;
      const [min, max] = decl.range;
      return min !== null && max !== null ? (min + max) / 2 : undefined;
    }
    case 'discrete': {
      if (decl.default !== undefined) return decl.default;
      if (decl.values && decl.values.length > 0) return decl.values[0];
      if (decl.range && decl.range[0] !== null) return decl.range[0];
      return undefined;
    }
    case 'categorical':
    case 'derived':
      return undefined;
  }
}
