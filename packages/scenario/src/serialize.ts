/**
 * Canonical `.scenario.json` text.
 *
 * Two files with the same content must produce byte-identical text, whatever
 * order the app happened to build the objects in — otherwise every save churns
 * the git diff. The rules:
 *
 * 1. **Key order is lexicographic**, recursively, by UTF-16 code unit. Not
 *    schema-declaration order: declaration order drifts as the schema grows and
 *    would rewrite every file on a refactor. Sorted order is stable forever and
 *    trivially re-derivable by any other tool.
 * 2. **Array order is preserved.** `entities` is author-ordered (it is the
 *    outliner order), so sorting it would be data loss.
 * 3. **Floats are rounded to {@link FLOAT_DECIMALS} = 6 decimal places.** For
 *    scene metres that is 1 µm, ~4 orders of magnitude finer than any placement
 *    a user can perform and finer than the 7.4 m median calibration residual of
 *    the map pipeline itself; for radians it is 1 µrad. It kills the
 *    `0.30000000000000004` noise that makes float diffs unreadable, and it is
 *    idempotent — rounding an already-rounded value is a no-op, so
 *    `serialize(parse(serialize(d))) === serialize(d)`.
 * 4. **`-0` is normalised to `0`** and non-finite numbers are rejected, since
 *    JSON cannot represent them.
 * 5. Two-space indent, one trailing newline: line-oriented diffs.
 *
 * Rounding happens at serialization time only. The in-memory document keeps
 * full double precision, so repeated nudges of an entity do not accumulate
 * rounding error — only the last write to disk is quantised.
 */

import { ScenarioValidationError, toScenarioIssues } from './errors.js';
import { ScenarioV1Schema, type ScenarioV1 } from './schema/v1.js';
import { ScenarioTemplateV2Schema, type ScenarioTemplateV2 } from './schema/v2/template.js';

/** Decimal places kept for every non-integer number. See module docs. */
export const FLOAT_DECIMALS = 6;

/** Above this magnitude `toFixed` starts emitting exponent notation; pass through instead. */
const ROUND_LIMIT = 1e15;

/**
 * Quantise one number for serialization.
 *
 * @throws If the value is `NaN` or infinite.
 */
export function roundFloat(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`cannot serialize non-finite number: ${value}`);
  }
  if (Number.isInteger(value)) return value === 0 ? 0 : value;
  if (Math.abs(value) >= ROUND_LIMIT) return value;
  const rounded = Number(value.toFixed(FLOAT_DECIMALS));
  return rounded === 0 ? 0 : rounded;
}

/**
 * Recursively sort object keys and round numbers.
 *
 * `undefined` properties are dropped (matching `JSON.stringify`), so an
 * optional field explicitly set to `undefined` never reaches the file.
 */
export function canonicalize(value: unknown): unknown {
  if (typeof value === 'number') return roundFloat(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const v = source[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/**
 * Render a document as canonical `.scenario.json` text.
 *
 * @param doc A validated document.
 * @returns Pretty-printed JSON with a trailing newline.
 */
export function serializeScenario(doc: ScenarioV1): string {
  return `${JSON.stringify(canonicalize(doc), null, 2)}\n`;
}

/**
 * Validate an already-parsed object as a v1 document.
 *
 * Does **not** migrate — use `migrate()` (or {@link deserializeScenario}) for
 * files of unknown vintage.
 *
 * @throws {ScenarioValidationError} With every issue found.
 */
export function parseScenario(json: unknown): ScenarioV1 {
  const result = ScenarioV1Schema.safeParse(json);
  if (!result.success) {
    throw new ScenarioValidationError(
      'invalid scenario document',
      toScenarioIssues(result.error.issues),
    );
  }
  return result.data;
}

/**
 * Validate an already-parsed object as a v2 template.
 *
 * Note what parsing *normalises*: string expressions become AST nodes, and
 * every default is materialised. So `serializeTemplate(parseTemplate(x))` is
 * not byte-identical to `x` when `x` was hand-authored — it is the canonical
 * form of the same document, and re-parsing it is a fixed point.
 *
 * @throws {ScenarioValidationError} With every issue found.
 */
export function parseTemplate(json: unknown): ScenarioTemplateV2 {
  const result = ScenarioTemplateV2Schema.safeParse(json);
  if (!result.success) {
    throw new ScenarioValidationError(
      'invalid scenario template',
      toScenarioIssues(result.error.issues),
    );
  }
  return result.data;
}

/** Render a v2 template as canonical text. Same rules as {@link serializeScenario}. */
export function serializeTemplate(template: ScenarioTemplateV2): string {
  return `${JSON.stringify(canonicalize(template), null, 2)}\n`;
}

/**
 * Deep-freeze a value in place. Used to hand out documents that UI code cannot
 * accidentally mutate outside the operation log.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
