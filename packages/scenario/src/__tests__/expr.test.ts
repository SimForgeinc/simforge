import { describe, expect, it } from 'vitest';

import {
  EXPR_REFS,
  ExprAstSchema,
  ExpressionError,
  NumberOrExprSchema,
  collectParamRefs,
  collectRefs,
  evaluateExpr,
  isKnownRef,
  parseExpr,
  printExpr,
  tryEvaluateExpr,
  tryParseExpr,
  type Expr,
} from '../expr/index.js';

const SCOPE = {
  lane: { speedLimitKph: 50, widthM: 3.2 },
  junction: { sizeM: 24 },
  clip: { seconds: 20 },
  params: { vEgo: 40, gapS: 1.5 },
};

describe('expression parser', () => {
  it('parses the canonical retargeting example', () => {
    expect(parseExpr('clamp(0.9 * lane.speedLimitKph, 25, 65)')).toEqual({
      kind: 'call',
      fn: 'clamp',
      args: [
        {
          kind: 'bin',
          op: '*',
          left: { kind: 'num', value: 0.9 },
          right: { kind: 'ref', name: 'lane.speedLimitKph' },
        },
        { kind: 'num', value: 25 },
        { kind: 'num', value: 65 },
      ],
    });
  });

  it('respects operator precedence and parentheses', () => {
    expect(evaluateExpr(parseExpr('2 + 3 * 4'), SCOPE)).toBe(14);
    expect(evaluateExpr(parseExpr('(2 + 3) * 4'), SCOPE)).toBe(20);
    expect(evaluateExpr(parseExpr('-2 + 3'), SCOPE)).toBe(1);
    expect(evaluateExpr(parseExpr('10 - 2 - 3'), SCOPE)).toBe(5);
    expect(evaluateExpr(parseExpr('10 / 2 / 5'), SCOPE)).toBe(1);
  });

  it('accepts decimals and exponents', () => {
    expect(evaluateExpr(parseExpr('1.5e1'), SCOPE)).toBe(15);
    expect(evaluateExpr(parseExpr('0.25 * 8'), SCOPE)).toBe(2);
  });

  it('rejects unknown identifiers with a pointed message', () => {
    const result = tryParseExpr('params.vEgo * 2');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/unknown identifier "params.vEgo"/);
      expect(result.error.column).toBe(0);
      expect(result.error.message).toMatch(/at column 1/);
    }
  });

  it('rejects unknown functions', () => {
    expect(() => parseExpr('sqrt(4)')).toThrow(/unknown function "sqrt"/);
  });

  it('rejects wrong arity', () => {
    expect(() => parseExpr('clamp(1, 2)')).toThrow(/clamp\(\) takes exactly 3/);
    expect(() => parseExpr('min(1)')).toThrow(/min\(\) takes at least 2/);
    expect(() => parseExpr('abs(1, 2)')).toThrow(/abs\(\) takes exactly 1/);
  });

  it('rejects syntax errors, empty input and stray characters', () => {
    for (const bad of ['', '   ', '2 +', '(2', '2)', '2 3', '2 $ 3', 'lane.widthM lane.widthM']) {
      expect(() => parseExpr(bad), bad).toThrow(ExpressionError);
    }
  });

  it('round-trips through printExpr to an identical AST', () => {
    const sources = [
      'clamp(0.9 * lane.speedLimitKph, 25, 65)',
      'param.vEgo / 3.6 * clip.seconds',
      'max(param.gapS * param.vEgo, 5)',
      '-(param.vEgo + 2) * 3',
      '10 - (2 - 3)',
      '10 / (2 / 5)',
      'junction.sizeM + lane.widthM * 2',
      'abs(param.vEgo - 30)',
    ];
    for (const source of sources) {
      const ast = parseExpr(source);
      const printed = printExpr(ast);
      expect(parseExpr(printed), source).toEqual(ast);
      // printExpr is a normal form: printing twice changes nothing.
      expect(printExpr(parseExpr(printed))).toBe(printed);
    }
  });

  it('preserves the value through a print/parse round trip', () => {
    for (const source of ['10 - (2 - 3)', '10 / (2 / 5)', '-(2 + 3) * 4', '2 - 3 * 4']) {
      const ast = parseExpr(source);
      expect(evaluateExpr(parseExpr(printExpr(ast)), SCOPE)).toBe(evaluateExpr(ast, SCOPE));
    }
  });
});

describe('expression evaluator', () => {
  it('reads every registered identifier', () => {
    for (const ref of EXPR_REFS) {
      expect(isKnownRef(ref.name)).toBe(true);
      expect(evaluateExpr(parseExpr(ref.name), SCOPE)).toBeTypeOf('number');
    }
  });

  it('clamps, mins, maxes and abses', () => {
    expect(evaluateExpr(parseExpr('clamp(200, 25, 65)'), SCOPE)).toBe(65);
    expect(evaluateExpr(parseExpr('clamp(1, 25, 65)'), SCOPE)).toBe(25);
    expect(evaluateExpr(parseExpr('min(3, 1, 2)'), SCOPE)).toBe(1);
    expect(evaluateExpr(parseExpr('max(3, 1, 2)'), SCOPE)).toBe(3);
    expect(evaluateExpr(parseExpr('abs(0 - 7)'), SCOPE)).toBe(7);
  });

  it('passes literals through', () => {
    expect(evaluateExpr(42, SCOPE)).toBe(42);
  });

  it('throws on division by zero and inverted clamp bounds', () => {
    expect(() => evaluateExpr(parseExpr('1 / 0'), SCOPE)).toThrow(/division by zero/);
    expect(() => evaluateExpr(parseExpr('clamp(1, 65, 25)'), SCOPE)).toThrow(/lower bound/);
  });

  it('distinguishes indeterminate from wrong', () => {
    const siteFact = tryEvaluateExpr(parseExpr('lane.speedLimitKph * 0.9'), { params: {} });
    expect(siteFact.status).toBe('indeterminate');

    const missingParam = tryEvaluateExpr(parseExpr('param.nope + 1'), SCOPE);
    expect(missingParam.status).toBe('indeterminate');

    const broken = tryEvaluateExpr(parseExpr('1 / 0'), SCOPE);
    expect(broken.status).toBe('error');

    const fine = tryEvaluateExpr(parseExpr('param.vEgo + 1'), SCOPE);
    expect(fine).toEqual({ status: 'value', value: 41 });
  });

  it('collects the identifiers an expression reads', () => {
    const ast = parseExpr('clamp(param.vEgo * lane.widthM, param.gapS, junction.sizeM)');
    expect(collectRefs(ast)).toEqual([
      'junction.sizeM',
      'lane.widthM',
      'param.gapS',
      'param.vEgo',
    ]);
    expect(collectParamRefs(ast)).toEqual(['gapS', 'vEgo']);
  });
});

describe('NumberOrExpr schema', () => {
  it('accepts a bare number', () => {
    expect(NumberOrExprSchema.parse(40)).toBe(40);
  });

  it('parses the string form into the stored AST', () => {
    expect(NumberOrExprSchema.parse('param.vEgo + 1')).toEqual({
      kind: 'bin',
      op: '+',
      left: { kind: 'ref', name: 'param.vEgo' },
      right: { kind: 'num', value: 1 },
    });
  });

  it('accepts an already-stored AST unchanged', () => {
    const ast: Expr = { kind: 'ref', name: 'lane.widthM' };
    expect(NumberOrExprSchema.parse(ast)).toEqual(ast);
  });

  it('rejects a string that does not parse, and says why', () => {
    const result = NumberOrExprSchema.safeParse('lane.speedLimit * 2');
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/unknown identifier/);
  });

  it('rejects an AST with an unregistered identifier', () => {
    const result = ExprAstSchema.safeParse({ kind: 'ref', name: 'window.location' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/unknown identifier/);
  });

  it('rejects an AST with the wrong call arity', () => {
    const result = ExprAstSchema.safeParse({
      kind: 'call',
      fn: 'clamp',
      args: [{ kind: 'num', value: 1 }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/takes exactly 3/);
  });

  it('rejects non-finite literals', () => {
    expect(NumberOrExprSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(ExprAstSchema.safeParse({ kind: 'num', value: Number.NaN }).success).toBe(false);
  });

  it('rejects unknown node kinds and stray keys', () => {
    expect(ExprAstSchema.safeParse({ kind: 'sqrt', operand: { kind: 'num', value: 4 } }).success).toBe(
      false,
    );
    expect(ExprAstSchema.safeParse({ kind: 'num', value: 1, unit: 'kph' }).success).toBe(false);
  });
});
