/** Error types the package throws. All extend `Error` and set `name`. */

import type { $ZodIssue } from 'zod/v4/core';

/** A structured, JSON-safe view of one schema violation. */
export interface ScenarioIssue {
  /** Dotted/indexed path into the document, e.g. `entities.0.pose.headingRad`. */
  path: string;
  message: string;
  code: string;
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map((p) => String(p)).join('.');
}

/**
 * Convert zod issues into the package's flat issue shape.
 *
 * Zod reports unrecognised keys as a single issue on the *parent* object; this
 * fans them out to one issue per offending key so the path points at the thing
 * the author actually has to delete.
 */
export function toScenarioIssues(issues: ReadonlyArray<$ZodIssue>): ScenarioIssue[] {
  const out: ScenarioIssue[] = [];
  for (const issue of issues) {
    const base = issue.path ?? [];
    if (issue.code === 'invalid_union') {
      // A union reports one issue per branch, and the raw list is unreadable
      // ("expected number", "expected object", ...). Prefer the branch that
      // structurally matched and failed a *semantic* check — for a
      // `number | expression-string | expression-AST` field that is the branch
      // carrying the real message ("unknown identifier \"lane.speed\"").
      const branches = issue.errors ?? [];
      const semantic = branches.filter((branch) =>
        branch.every((i) => i.code !== 'invalid_type' || (i.path?.length ?? 0) > 0),
      );
      if (semantic.length === 1) {
        for (const nested of toScenarioIssues(semantic[0] as $ZodIssue[])) {
          out.push({
            path: formatPath([...base, ...(nested.path ? nested.path.split('.') : [])]),
            message: nested.message,
            code: nested.code,
          });
        }
        continue;
      }
      const alternatives = branches
        .map((branch) => branch[0]?.message)
        .filter((m): m is string => Boolean(m));
      out.push({
        path: formatPath(base),
        message:
          alternatives.length > 0
            ? `no accepted form matched: ${[...new Set(alternatives)].join(' | ')}`
            : issue.message,
        code: issue.code,
      });
      continue;
    }
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        out.push({
          path: formatPath([...base, key]),
          message: `unrecognized key "${key}"; unknown fields belong under "extensions"`,
          code: issue.code,
        });
      }
      continue;
    }
    out.push({ path: formatPath(base), message: issue.message, code: issue.code ?? 'custom' });
  }
  return out;
}

/** A document failed schema validation. */
export class ScenarioValidationError extends Error {
  override readonly name = 'ScenarioValidationError';
  /** Every violation found, not just the first. */
  readonly issues: ScenarioIssue[];

  constructor(message: string, issues: ScenarioIssue[]) {
    const detail = issues
      .slice(0, 8)
      .map((i) => `  - ${i.path || '<root>'}: ${i.message}`)
      .join('\n');
    super(
      issues.length > 8
        ? `${message}\n${detail}\n  - ...and ${issues.length - 8} more`
        : `${message}\n${detail}`,
    );
    this.issues = issues;
  }
}

/** A document could not be migrated to the current schema version. */
export class ScenarioMigrationError extends Error {
  override readonly name = 'ScenarioMigrationError';
  /** The version found in the input, when one could be read. */
  readonly fromVersion: number | undefined;

  constructor(message: string, fromVersion?: number) {
    super(message);
    this.fromVersion = fromVersion;
  }
}

/** An operation referenced something that is not in the document. */
export class ScenarioOperationError extends Error {
  override readonly name: string = 'ScenarioOperationError';
}


/** A file store was asked for a scenario it does not hold. */
export class ScenarioNotFoundError extends Error {
  override readonly name = 'ScenarioNotFoundError';
  readonly scenarioName: string;

  constructor(scenarioName: string) {
    super(`no scenario named "${scenarioName}"`);
    this.scenarioName = scenarioName;
  }
}
