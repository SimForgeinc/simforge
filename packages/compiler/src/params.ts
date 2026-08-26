/**
 * Browser-safe per-cell parameter resolution.
 *
 * The rule that makes a 500-cell batch reproducible is that a cell's randomness
 * is a **pure function of its coordinates**, never of the order the batch
 * happened to visit it in:
 *
 * ```
 * paramSeed = sha256(`${templateId}|${paramsVersion}|${siteId}|${drawIndex}`)
 * ```
 *
 * `paramsVersion` is a content hash of the *declarations* (not of the whole
 * template), so editing a trigger threshold does not resample every parameter
 * in the library, while adding a parameter or moving a range does — which is
 * exactly when the old draws stopped meaning anything.
 *
 * Each declaration then draws from `rng.fork(paramId)` rather than from the
 * shared stream, so inserting a parameter does not shift the values of the ones
 * declared after it.
 */

import {
  Rng,
  contentHash,
  sha256,
} from '@simforge-oss/engine';
import {
  compareWith,
  evaluateExpr,
  paramDefault,
  type ExprScope,
  type ParamDecl,
  type ScenarioTemplateV2,
} from '@simforge-oss/scenario';

import { CliError } from './errors.js';

export interface ParamDraw {
  /** Numeric parameter values, by id — the scope `param.*` reads. */
  readonly values: Readonly<Record<string, number>>;
  /** Categorical parameter values, by id. Not visible to expressions. */
  readonly categorical: Readonly<Record<string, string>>;
  /** The hex seed the draw came from. */
  readonly paramSeed: string;
  /** Constraints that rejected, with their messages. Empty on a good draw. */
  readonly rejectedConstraints: string[];
}

/** Content hash of the parameter block alone. */
export function paramsVersion(template: ScenarioTemplateV2): string {
  return contentHash({
    declarations: template.params.declarations,
    constraints: template.params.constraints,
  }).slice(0, 16);
}

/** The stable identity of a template, used in the replay key. */
export function templateId(template: ScenarioTemplateV2): string {
  return template.anchor.id ?? template.meta.name;
}

/** `sha256(templateId|paramsVersion|siteId|drawIndex)`. */
export function cellSeed(
  templateIdValue: string,
  paramsVersionValue: string,
  siteId: string,
  drawIndex: number,
): string {
  return sha256(`${templateIdValue}|${paramsVersionValue}|${siteId}|${drawIndex}`);
}

/** Discrete parameter values, expanded from `values` or `range` + `step`. */
export function discreteValues(decl: Extract<ParamDecl, { type: 'discrete' }>): number[] {
  if (decl.values && decl.values.length > 0) return [...decl.values];
  const [lo, hi] = decl.range ?? [null, null];
  const step = decl.step;
  if (lo === null || hi === null || step === undefined) return [];
  const out: number[] = [];
  // Integer-indexed accumulation, not `v += step`: a float walk over
  // [0.2, 0.9] step 0.1 drifts and can drop the last value.
  const n = Math.floor((hi - lo) / step + 1e-9);
  for (let i = 0; i <= n; i += 1) out.push(lo + i * step);
  return out;
}

function drawOne(decl: ParamDecl, rng: Rng, scope: ExprScope): number | string | undefined {
  switch (decl.type) {
    case 'continuous': {
      const [lo, hi] = decl.range;
      if (lo === null || hi === null) return paramDefault(decl);
      return rng.range(lo, hi);
    }
    case 'discrete': {
      const values = discreteValues(decl);
      if (values.length === 0) return paramDefault(decl);
      return values[Math.min(values.length - 1, Math.floor(rng.next() * values.length))];
    }
    case 'categorical':
      return decl.values[Math.min(decl.values.length - 1, Math.floor(rng.next() * decl.values.length))];
    case 'derived':
      return evaluateExpr(decl.expr, scope);
  }
}

/**
 * Resolve every declared parameter for one `(site, draw)` cell.
 *
 * `drawIndex < 0` means "do not sample": every parameter takes its declared
 * default. That is what `--seed` with no `--draw` and what tier-1 validation
 * use, and it keeps a hand-authored template's numbers exactly what the author
 * wrote.
 */
export function resolveParams(
  template: ScenarioTemplateV2,
  options: { siteId: string; drawIndex: number; seedOverride?: string | undefined },
): ParamDraw {
  const version = paramsVersion(template);
  const paramSeed =
    options.seedOverride ??
    cellSeed(templateId(template), version, options.siteId, options.drawIndex);
  const rng = new Rng(paramSeed);

  const values: Record<string, number> = {};
  const categorical: Record<string, string> = {};
  const scope: ExprScope = {
    params: values,
    clip: { seconds: template.choreography.clipSeconds },
  };

  // `derived` last: it reads the others. Declaration order is otherwise
  // irrelevant because each parameter draws from its own forked stream.
  const ordered = [
    ...template.params.declarations.filter((d) => d.type !== 'derived'),
    ...template.params.declarations.filter((d) => d.type === 'derived'),
  ];

  for (const decl of ordered) {
    let drawn: number | string | undefined;
    if (options.drawIndex < 0 && decl.type !== 'derived') {
      drawn = decl.type === 'categorical' ? (decl.default ?? decl.values[0]) : paramDefault(decl);
    } else {
      try {
        drawn = drawOne(decl, rng.fork(decl.id), scope);
      } catch (error) {
        throw new CliError('param_unresolvable', `parameter "${decl.id}" could not be resolved`, {
          path: `params.declarations.${decl.id}`,
          detail: { reason: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    if (typeof drawn === 'number') values[decl.id] = drawn;
    else if (typeof drawn === 'string') categorical[decl.id] = drawn;
    else {
      throw new CliError('param_unresolvable', `parameter "${decl.id}" has no value or default`, {
        path: `params.declarations.${decl.id}`,
      });
    }
  }

  const rejected: string[] = [];
  for (const [i, constraint] of template.params.constraints.entries()) {
    try {
      const left = evaluateExpr(constraint.left, scope);
      const right = evaluateExpr(constraint.right, scope);
      if (!compareWith(constraint.op, left, right)) {
        rejected.push(
          constraint.message ??
            `constraint ${i} rejected the draw: ${left} ${constraint.op} ${right} is false`,
        );
      }
    } catch {
      // A site-dependent constraint cannot be judged before the site is bound;
      // the materializer re-checks it with the full scope.
    }
  }

  return { values, categorical, paramSeed, rejectedConstraints: rejected };
}
