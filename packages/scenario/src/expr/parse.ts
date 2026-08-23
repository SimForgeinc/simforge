/**
 * Recursive-descent parser for the expression string grammar.
 *
 * ```
 * expr    := term (('+' | '-') term)*
 * term    := unary (('*' | '/') unary)*
 * unary   := '-' unary | primary
 * primary := number | call | ref | '(' expr ')'
 * call    := ident '(' expr (',' expr)* ')'
 * ref     := ident ('.' ident)+
 * ```
 *
 * ~150 lines, no dependency, no `eval`. Unknown identifiers are rejected at
 * parse time against the registry in `ast.ts`, so `param.vEgo` typo'd as
 * `params.vEgo` fails at the point of authoring rather than silently evaluating
 * to `NaN` three layers down.
 */

import {
  CALL_ARITY,
  CALL_FNS,
  ExpressionError,
  isKnownRef,
  type BinOp,
  type CallFn,
  type Expr,
} from './ast.js';

type Token =
  | { type: 'num'; value: number; at: number }
  | { type: 'ident'; value: string; at: number }
  | { type: 'op'; value: string; at: number }
  | { type: 'eof'; at: number };

const CALL_FN_SET = new Set<string>(CALL_FNS);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    if ('+-*/(),'.includes(c)) {
      tokens.push({ type: 'op', value: c, at: i });
      i += 1;
      continue;
    }
    if (c >= '0' && c <= '9') {
      const start = i;
      while (i < source.length && /[0-9]/.test(source[i] as string)) i += 1;
      if (source[i] === '.') {
        i += 1;
        while (i < source.length && /[0-9]/.test(source[i] as string)) i += 1;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        const save = i;
        i += 1;
        if (source[i] === '+' || source[i] === '-') i += 1;
        if (/[0-9]/.test(source[i] ?? '')) {
          while (i < source.length && /[0-9]/.test(source[i] as string)) i += 1;
        } else {
          i = save;
        }
      }
      const text = source.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new ExpressionError(`bad number "${text}"`, start);
      tokens.push({ type: 'num', value, at: start });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_.]/.test(source[i] as string)) i += 1;
      tokens.push({ type: 'ident', value: source.slice(start, i), at: start });
      continue;
    }
    throw new ExpressionError(`unexpected character "${c}"`, i);
  }
  tokens.push({ type: 'eof', at: source.length });
  return tokens;
}

class Parser {
  #tokens: Token[];
  #pos = 0;

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  #peek(): Token {
    return this.#tokens[this.#pos] as Token;
  }

  #next(): Token {
    const token = this.#peek();
    if (token.type !== 'eof') this.#pos += 1;
    return token;
  }

  #eatOp(value: string): boolean {
    const token = this.#peek();
    if (token.type === 'op' && token.value === value) {
      this.#pos += 1;
      return true;
    }
    return false;
  }

  #expectOp(value: string): void {
    const token = this.#peek();
    if (token.type !== 'op' || token.value !== value) {
      throw new ExpressionError(`expected "${value}"`, token.at);
    }
    this.#pos += 1;
  }

  parseTop(): Expr {
    const expr = this.parseExpr();
    const token = this.#peek();
    if (token.type !== 'eof') {
      throw new ExpressionError(
        `unexpected trailing input "${token.type === 'op' ? token.value : String((token as { value?: unknown }).value)}"`,
        token.at,
      );
    }
    return expr;
  }

  parseExpr(): Expr {
    let left = this.parseTerm();
    for (;;) {
      const token = this.#peek();
      if (token.type === 'op' && (token.value === '+' || token.value === '-')) {
        this.#pos += 1;
        left = { kind: 'bin', op: token.value as BinOp, left, right: this.parseTerm() };
        continue;
      }
      return left;
    }
  }

  parseTerm(): Expr {
    let left = this.parseUnary();
    for (;;) {
      const token = this.#peek();
      if (token.type === 'op' && (token.value === '*' || token.value === '/')) {
        this.#pos += 1;
        left = { kind: 'bin', op: token.value as BinOp, left, right: this.parseUnary() };
        continue;
      }
      return left;
    }
  }

  parseUnary(): Expr {
    if (this.#eatOp('-')) return { kind: 'neg', operand: this.parseUnary() };
    if (this.#eatOp('+')) return this.parseUnary();
    return this.parsePrimary();
  }

  parsePrimary(): Expr {
    const token = this.#next();
    if (token.type === 'num') return { kind: 'num', value: token.value };
    if (token.type === 'op' && token.value === '(') {
      const inner = this.parseExpr();
      this.#expectOp(')');
      return inner;
    }
    if (token.type === 'ident') {
      const isCall = this.#peek().type === 'op' && (this.#peek() as { value: string }).value === '(';
      if (isCall) {
        if (!CALL_FN_SET.has(token.value)) {
          throw new ExpressionError(
            `unknown function "${token.value}"; known: ${CALL_FNS.join(', ')}`,
            token.at,
          );
        }
        const fn = token.value as CallFn;
        this.#expectOp('(');
        const args: Expr[] = [this.parseExpr()];
        while (this.#eatOp(',')) args.push(this.parseExpr());
        this.#expectOp(')');
        const arity = CALL_ARITY[fn];
        if (args.length < arity.min || (arity.max !== null && args.length > arity.max)) {
          throw new ExpressionError(
            arity.max === null
              ? `${fn}() takes at least ${arity.min} arguments, got ${args.length}`
              : `${fn}() takes exactly ${arity.min} arguments, got ${args.length}`,
            token.at,
          );
        }
        return { kind: 'call', fn, args };
      }
      if (!isKnownRef(token.value)) {
        throw new ExpressionError(
          `unknown identifier "${token.value}"; use param.<name> or a site fact`,
          token.at,
        );
      }
      return { kind: 'ref', name: token.value };
    }
    throw new ExpressionError('expected a number, identifier or "("', token.at);
  }
}

/**
 * Parse the string form into an AST.
 *
 * @throws {ExpressionError} On any syntax error or unknown identifier/function.
 */
export function parseExpr(source: string): Expr {
  if (source.trim() === '') throw new ExpressionError('empty expression', 0);
  return new Parser(tokenize(source)).parseTop();
}

/** Non-throwing {@link parseExpr}. */
export function tryParseExpr(source: string): { ok: true; expr: Expr } | { ok: false; error: ExpressionError } {
  try {
    return { ok: true, expr: parseExpr(source) };
  } catch (error) {
    if (error instanceof ExpressionError) return { ok: false, error };
    throw error;
  }
}
