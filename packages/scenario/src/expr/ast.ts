/**
 * Typed numeric expression AST — the "speeds are expressions, not literals" rule
 * from `docs/research/retargeting.md`.
 *
 * A template that says `65 kph` is wrong on a 25 mph residential street and wrong
 * on a motorway. A template that says `clamp(0.9 * lane.speedLimitKph, 25, 65)`
 * transfers. Everything an author can write is one of five node kinds, over a
 * **closed registry of identifiers** — there is no `eval`, no `Function`, no
 * property lookup on arbitrary objects, so a hostile or hallucinated expression
 * can at worst be rejected.
 *
 * Two serialized forms are accepted on input and one is stored:
 *
 * - `"clamp(0.9 * lane.speedLimitKph, 25, 65)"` — the authoring/LLM form,
 *   parsed by {@link parseExpr};
 * - `{kind: 'call', fn: 'clamp', args: [...]}` — the stored form, which is what
 *   {@link ExprSchema} normalises every input to.
 *
 * {@link printExpr} converts back, so the editor can show the string a human
 * typed and round-trip it.
 */

import { z } from 'zod';

/** Binary operators. Standard precedence: `*` `/` bind tighter than `+` `-`. */
export const BIN_OPS = ['+', '-', '*', '/'] as const;
/** Binary operator token. */
export type BinOp = (typeof BIN_OPS)[number];

/** Callable functions. Deliberately tiny: everything here is total and pure. */
export const CALL_FNS = ['clamp', 'min', 'max', 'abs'] as const;
/** Function name. */
export type CallFn = (typeof CALL_FNS)[number];

/** Arity constraints per function. `max === null` means variadic. */
export const CALL_ARITY: Record<CallFn, { min: number; max: number | null }> = {
  clamp: { min: 3, max: 3 },
  min: { min: 2, max: null },
  max: { min: 2, max: null },
  abs: { min: 1, max: 1 },
};

/** One entry in the identifier registry. */
export interface ExprRefDecl {
  /** Dotted identifier as written in an expression. */
  name: string;
  /** Unit of the value, for UI and for unit-mismatch review. */
  unit: string;
  /** Where the value comes from when the expression is evaluated. */
  source: 'site' | 'clip';
  description: string;
}

/**
 * Every identifier an expression may name, other than `param.<name>`.
 *
 * `source: 'site'` values are only known once a template is bound to a matched
 * site, which is exactly why the static validator treats expressions containing
 * them as *indeterminate* rather than as errors.
 */
export const EXPR_REFS: readonly ExprRefDecl[] = [
  {
    name: 'lane.speedLimitKph',
    unit: 'kph',
    source: 'site',
    description: 'Posted speed limit of the lane the referring role occupies.',
  },
  {
    name: 'lane.widthM',
    unit: 'm',
    source: 'site',
    description: 'Width of the lane the referring role occupies.',
  },
  {
    name: 'junction.sizeM',
    unit: 'm',
    source: 'site',
    description: 'Characteristic size (inscribed diameter) of the anchor junction.',
  },
  {
    name: 'clip.seconds',
    unit: 's',
    source: 'clip',
    description: 'Recorded clip length, i.e. `choreography.clipSeconds`.',
  },
];

const REF_NAMES = new Set(EXPR_REFS.map((r) => r.name));

/** `param.<ident>` — the one open namespace, checked against declared params. */
export const PARAM_REF_PATTERN = /^param\.[A-Za-z_][A-Za-z0-9_]*$/;

/** True when `name` is a legal identifier (registry entry or `param.<ident>`). */
export function isKnownRef(name: string): boolean {
  return REF_NAMES.has(name) || PARAM_REF_PATTERN.test(name);
}

/** Literal number. */
export interface NumNode {
  kind: 'num';
  value: number;
}
/** Identifier reference; `name` is registry-checked. */
export interface RefNode {
  kind: 'ref';
  name: string;
}
/** Unary minus. */
export interface NegNode {
  kind: 'neg';
  operand: Expr;
}
/** Binary arithmetic. */
export interface BinNode {
  kind: 'bin';
  op: BinOp;
  left: Expr;
  right: Expr;
}
/** Function application. */
export interface CallNode {
  kind: 'call';
  fn: CallFn;
  args: Expr[];
}

/** A numeric expression. */
export type Expr = NumNode | RefNode | NegNode | BinNode | CallNode;

/** Thrown by the parser and the evaluator. Carries a 0-based column when parsing. */
export class ExpressionError extends Error {
  override readonly name = 'ExpressionError';
  /** Column in the source string, when the error came from parsing. */
  readonly column: number | undefined;

  constructor(message: string, column?: number) {
    super(column === undefined ? message : `${message} (at column ${column + 1})`);
    this.column = column;
  }
}

/**
 * Zod schema for the **stored** AST form.
 *
 * Recursion is expressed with `z.lazy`, which `z.toJSONSchema` turns into a
 * `$defs` entry plus `$ref`s — so the published JSON Schema describes the same
 * recursive grammar and constrained-decoding clients can use it directly.
 */
export const ExprAstSchema: z.ZodType<Expr> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('num'), value: z.number().finite() }),
    z.strictObject({
      kind: z.literal('ref'),
      name: z.string().check((ctx) => {
        if (!isKnownRef(ctx.value)) {
          ctx.issues.push({
            code: 'custom',
            message: `unknown identifier "${ctx.value}"; known: ${EXPR_REFS.map((r) => r.name).join(', ')}, param.<name>`,
            path: [],
            input: ctx.value,
          });
        }
      }),
    }),
    z.strictObject({ kind: z.literal('neg'), operand: z.lazy(() => ExprAstSchema) }),
    z.strictObject({
      kind: z.literal('bin'),
      op: z.enum(BIN_OPS),
      left: z.lazy(() => ExprAstSchema),
      right: z.lazy(() => ExprAstSchema),
    }),
    z
      .strictObject({
        kind: z.literal('call'),
        fn: z.enum(CALL_FNS),
        args: z.array(z.lazy(() => ExprAstSchema)).min(1),
      })
      .check((ctx) => {
        const { fn, args } = ctx.value;
        const arity = CALL_ARITY[fn];
        if (args.length < arity.min || (arity.max !== null && args.length > arity.max)) {
          ctx.issues.push({
            code: 'custom',
            message:
              arity.max === null
                ? `${fn}() takes at least ${arity.min} arguments, got ${args.length}`
                : `${fn}() takes exactly ${arity.min} arguments, got ${args.length}`,
            path: ['args'],
            input: args,
          });
        }
      }),
  ]),
);

/** Walk every node of an expression, parents before children. */
export function walkExpr(expr: Expr, visit: (node: Expr) => void): void {
  visit(expr);
  switch (expr.kind) {
    case 'neg':
      walkExpr(expr.operand, visit);
      return;
    case 'bin':
      walkExpr(expr.left, visit);
      walkExpr(expr.right, visit);
      return;
    case 'call':
      for (const arg of expr.args) walkExpr(arg, visit);
      return;
    default:
      return;
  }
}

/** Every identifier the expression reads, sorted, deduplicated. */
export function collectRefs(expr: Expr): string[] {
  const out = new Set<string>();
  walkExpr(expr, (node) => {
    if (node.kind === 'ref') out.add(node.name);
  });
  return [...out].sort();
}

/** Every `param.<name>` the expression reads, as bare param ids. */
export function collectParamRefs(expr: Expr): string[] {
  return collectRefs(expr)
    .filter((name) => PARAM_REF_PATTERN.test(name))
    .map((name) => name.slice('param.'.length));
}

const PRECEDENCE: Record<BinOp, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };

/**
 * Render an AST back to the string grammar.
 *
 * Parentheses are emitted where precedence *or associativity* requires them, so
 * `printExpr(parseExpr(s))` is a normal form: parsing it again yields an
 * identical AST (tested against 300 random expressions), even though it need
 * not equal `s` character for character.
 */
export function printExpr(expr: Expr): string {
  switch (expr.kind) {
    case 'num':
      return String(expr.value);
    case 'ref':
      return expr.name;
    case 'neg':
      return expr.operand.kind === 'bin' || expr.operand.kind === 'neg'
        ? `-(${printExpr(expr.operand)})`
        : `-${printExpr(expr.operand)}`;
    case 'call':
      return `${expr.fn}(${expr.args.map(printExpr).join(', ')})`;
    case 'bin': {
      const me = PRECEDENCE[expr.op];
      const left =
        expr.left.kind === 'bin' && PRECEDENCE[expr.left.op] < me
          ? `(${printExpr(expr.left)})`
          : printExpr(expr.left);
      // A right operand of equal precedence always needs parens, not just for
      // `-` and `/`: the parser is left-associative, so printing
      // `a + (b + c)` as `a + b + c` would re-parse as `(a + b) + c`. Same
      // shape, different tree — and, in floating point, potentially a different
      // number. (Found by the v2 property test, which is what it is for.)
      const rightNeedsParens =
        expr.right.kind === 'bin' && PRECEDENCE[expr.right.op] <= me;
      const right = rightNeedsParens ? `(${printExpr(expr.right)})` : printExpr(expr.right);
      return `${left} ${expr.op} ${right}`;
    }
  }
}
