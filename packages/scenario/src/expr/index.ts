/** Typed numeric expressions: AST, string parser, evaluator, zod schemas. */

export {
  BIN_OPS,
  CALL_ARITY,
  CALL_FNS,
  EXPR_REFS,
  ExprAstSchema,
  ExpressionError,
  PARAM_REF_PATTERN,
  collectParamRefs,
  collectRefs,
  isKnownRef,
  printExpr,
  walkExpr,
  type BinNode,
  type BinOp,
  type CallFn,
  type CallNode,
  type Expr,
  type ExprRefDecl,
  type NegNode,
  type NumNode,
  type RefNode,
} from './ast.js';

export { parseExpr, tryParseExpr } from './parse.js';

export {
  ExprSchema,
  NumberOrExprSchema,
  evaluateExpr,
  isExpr,
  tryEvaluateExpr,
  type EvalOutcome,
  type ExprScope,
  type NumberOrExpr,
  type NumberOrExprInput,
} from './evaluate.js';
