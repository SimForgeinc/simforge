/**
 * Author-defined variants: "when the site only has two lanes, do it like *this*".
 *
 * Degradation (the matcher's automatic repairs) may relax presentation, never
 * intent. Variants are the other half of that contract: they let the **author**
 * define the degraded rendition explicitly, which is authoring, not repair, and
 * therefore may change intent as much as the author likes.
 *
 * ## Why paths carry `#id` selectors
 *
 * An override addressed as `roles.2.initialSpeedKph` breaks the moment someone
 * inserts a role above it — silently, because index 2 still exists and still
 * type-checks. `roles#challenger.initialSpeedKph` addresses by id, survives
 * reordering, and fails loudly when the target is renamed
 * (`variant_target_unknown`). Numeric indices remain legal for arrays whose
 * elements have no id (`target.points.0`).
 */

import { z } from 'zod';

import { ParamConstraintSchema } from './params.js';

/** Roots an override may address. Everything else is either derived or meta. */
export const OVERRIDE_ROOTS = [
  'roles',
  'props',
  'choreography',
  'invariants',
  'environment',
  'params',
  'metricSubject',
] as const;

const SEGMENT = String.raw`(?:[A-Za-z][A-Za-z0-9_-]*|\d+)`;
/**
 * `root` optionally followed by `#id`, then dotted segments.
 *
 * `roles#challenger.initialSpeedKph`, `choreography.interactions.0.dynamics.value`,
 * `environment.weather`.
 */
export const OVERRIDE_PATH_PATTERN = new RegExp(
  `^(?:${OVERRIDE_ROOTS.join('|')})(?:#[A-Za-z][A-Za-z0-9_-]*)?(?:\\.${SEGMENT})*$`,
);

/** One targeted edit applied when a variant's condition holds. */
export const OverrideSchema = z
  .strictObject({
    /** e.g. `roles#challenger.initialSpeedKph`, `choreography.clipSeconds`. */
    path: z.string().min(1).max(300).regex(OVERRIDE_PATH_PATTERN, {
      message: `override path must start with one of: ${OVERRIDE_ROOTS.join(', ')}`,
    }),
    op: z.enum(['set', 'remove']).default('set'),
    /** Required for `set`, forbidden for `remove`. Shape is checked on apply. */
    value: z.unknown().optional(),
  })
  .check((ctx) => {
    const { op, value } = ctx.value;
    if (op === 'set' && value === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'a `set` override needs a `value`',
        path: ['value'],
        input: value,
      });
    }
    if (op === 'remove' && value !== undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'a `remove` override must not carry a `value`',
        path: ['value'],
        input: value,
      });
    }
  });

/** A conditional rendition of the template. */
export const VariantSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  label: z.string().max(200).optional(),
  /**
   * Conditions, ANDed. Expressions may read site facts (`lane.widthM`) and
   * parameters, which is what lets a variant key on the site rather than on a
   * draw.
   */
  when: z.array(ParamConstraintSchema).min(1).max(8),
  overrides: z.array(OverrideSchema).min(1).max(64),
});

/** A variant. */
export type Variant = z.infer<typeof VariantSchema>;
/** An override. */
export type Override = z.infer<typeof OverrideSchema>;

/** One parsed path segment. */
export type PathSegment =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'id'; id: string };

/** Split an override path into segments. Returns `undefined` if malformed. */
export function parseOverridePath(path: string): PathSegment[] | undefined {
  if (!OVERRIDE_PATH_PATTERN.test(path)) return undefined;
  const out: PathSegment[] = [];
  for (const raw of path.split('.')) {
    const hash = raw.indexOf('#');
    if (hash >= 0) {
      out.push({ kind: 'key', key: raw.slice(0, hash) }, { kind: 'id', id: raw.slice(hash + 1) });
      continue;
    }
    out.push(/^\d+$/.test(raw) ? { kind: 'index', index: Number(raw) } : { kind: 'key', key: raw });
  }
  return out;
}
