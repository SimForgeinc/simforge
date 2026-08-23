/**
 * Expression evaluation and the `number | Expr` zod schema.
 *
 * The evaluator is total in the sense that matters: it either returns a finite
 * number or throws {@link ExpressionError}. Division by zero, an unbound
 * identifier and an overflow to Infinity are all errors, never `NaN` leaking
 * into a solver.
 *
 * {@link tryEvaluateExpr} is the form the *static* validator uses: at
 * template-authoring time `lane.speedLimitKph` has no value yet, so an
 * expression that reads it is **indeterminate**, not invalid. Everything that
 * only reads `param.*` and `clip.seconds` evaluates statically, which is what
 * makes the one-axis-one-owner timing analysis possible before a map is chosen.
 */

import { z } from 'zod';

import { ExprAstSchema, ExpressionError, type Expr } from './ast.js';
import { parseExpr } from './parse.js';

/** Values available to {@link evaluateExpr}. Anything absent makes its ref unbound. */
export interface ExprScope {
  /** Facts about the lane the referring role occupies. */
  lane?: { speedLimitKph?: number | undefined; widthM?: number | undefined };
  /** Facts about the anchor junction. */
  junction?: { sizeM?: number | undefined };
  /** Clip timing. */
  clip?: { seconds?: number | undefined };
  /** Resolved parameter values, by param id. */
  params?: Readonly<Record<string, number>>;
}

function lookup(name: string, scope: ExprScope): number {
  if (name.startsWith('param.')) {
    const id = name.slice('param.'.length);
    const value = scope.params?.[id];
    if (typeof value !== 'number') throw new ExpressionError(`parameter "${id}" has no value`);
    return value;
  }
  const value =
    name === 'lane.speedLimitKph'
      ? scope.lane?.speedLimitKph
      : name === 'lane.widthM'
        ? scope.lane?.widthM
        : name === 'junction.sizeM'
          ? scope.junction?.sizeM
          : name === 'clip.seconds'
            ? scope.clip?.seconds
            : undefined;
  if (typeof value !== 'number') throw new ExpressionError(`"${name}" is not bound in this scope`);
  return value;
}

/**
 * Evaluate an expression (or pass a literal through).
 *
 * @throws {ExpressionError} On an unbound identifier, division by zero, or a
 *   non-finite result.
 */
export function evaluateExpr(expr: Expr | number, scope: ExprScope = {}): number {
  if (typeof expr === 'number') return expr;
  const value = evalNode(expr, scope);
  if (!Number.isFinite(value)) throw new ExpressionError('expression is not finite');
  return value;
}

function evalNode(expr: Expr, scope: ExprScope): number {
  switch (expr.kind) {
    case 'num':
      return expr.value;
    case 'ref':
      return lookup(expr.name, scope);
    case 'neg':
      return -evalNode(expr.operand, scope);
    case 'bin': {
      const a = evalNode(expr.left, scope);
      const b = evalNode(expr.right, scope);
      switch (expr.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          if (b === 0) throw new ExpressionError('division by zero');
          return a / b;
      }
      break;
    }
    case 'call': {
      const args = expr.args.map((a) => evalNode(a, scope));
      switch (expr.fn) {
        case 'abs':
          return Math.abs(args[0] as number);
        case 'min':
          return Math.min(...args);
        case 'max':
          return Math.max(...args);
        case 'clamp': {
          const [x, lo, hi] = args as [number, number, number];
          if (lo > hi) throw new ExpressionError(`clamp() lower bound ${lo} exceeds upper bound ${hi}`);
          return Math.min(Math.max(x, lo), hi);
        }
      }
    }
  }
  /* c8 ignore next */
  throw new ExpressionError('unreachable expression node');
}

/** Result of a best-effort evaluation. `indeterminate` means "needs a site". */
export type EvalOutcome =
  | { status: 'value'; value: number }
  | { status: 'indeterminate'; reason: string }
  | { status: 'error'; reason: string };

/**
 * Evaluate without throwing, distinguishing "cannot know yet" from "wrong".
 *
 * A missing `param.*` value is *indeterminate* too: the static validator runs
 * before a param draw, and treating an unsampled parameter as an error would
 * make every parameterised template look broken.
 */
export function tryEvaluateExpr(expr: Expr | number, scope: ExprScope = {}): EvalOutcome {
  try {
    return { status: 'value', value: evaluateExpr(expr, scope) };
  } catch (error) {
    if (error instanceof ExpressionError) {
      const unbound = /is not bound in this scope|has no value/.test(error.message);
      return unbound
        ? { status: 'indeterminate', reason: error.message }
        : { status: 'error', reason: error.message };
    }
    /* c8 ignore next */
    throw error;
  }
}

/**
 * `Expr` accepted as either the string form or the stored AST, normalised to
 * the AST.
 */
export const ExprSchema = z.union([
  z.string().transform((source, ctx): Expr => {
    try {
      return parseExpr(source);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof ExpressionError ? error.message : String(error),
        input: source,
      });
      return z.NEVER as unknown as Expr;
    }
  }),
  ExprAstSchema,
]);

/**
 * A number or an expression — the type of every speed, gap, offset, time and
 * threshold in schema v2.
 */
export const NumberOrExprSchema = z.union([z.number().finite(), ExprSchema]);

/** A number or an expression, as stored. */
export type NumberOrExpr = z.infer<typeof NumberOrExprSchema>;
/** A number or an expression, as authored (strings allowed). */
export type NumberOrExprInput = z.input<typeof NumberOrExprSchema>;

/** True when the value is an expression node rather than a literal. */
export function isExpr(value: NumberOrExpr): value is Expr {
  return typeof value === 'object' && value !== null;
}
