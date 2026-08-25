/**
 * Published JSON Schemas for v2 — three of them, on purpose.
 *
 * The whole template is one document, but agents do not emit whole documents in
 * one shot, and constrained decoding works best against the smallest schema
 * that describes what is being produced right now. The generation pipeline in
 * the architecture doc emits an anchor first (that is the hard part, and the
 * part where hallucinated road ids would do the most damage), then a timeline
 * against the roles it just declared. So:
 *
 * - `scenario-template.v2.schema.json` — the whole document, for validators and
 *   for editors with `$schema` autocomplete;
 * - `logical-anchor.v2.schema.json` — **the LLM emission target**. Flat,
 *   enum-heavy, no coordinates expressible;
 * - `interactions.v2.schema.json` — the timeline alone, for the second call.
 *
 * `io: 'input'` throughout: the files describe what may be *written*, where
 * defaults are optional and expressions may still be strings.
 *
 * Cross-field rules that JSON Schema cannot express are listed in each
 * `description` rather than silently dropped — a model reading the schema sees
 * "dynamics is required for speed/gap/changeLane/laneOffset" even though the
 * schema itself only makes it optional.
 */

import { z } from 'zod';

import { ExprAstSchema, NumberOrExprSchema } from './expr/index.js';
import { LogicalAnchorSchema } from './schema/v2/anchor.js';
import { EssentialitySchema, RangeSchema } from './schema/v2/common.js';
import {
  ConditionSchema,
  DynamicsSchema,
  InteractionSchema,
  PointRefSchema,
  TriggerSchema,
} from './schema/v2/interactions.js';
import { ActorSpecSchema, FramePoseSchema } from './schema/v2/roles.js';
import { SCENARIO_TEMPLATE_VERSION, ScenarioTemplateV2ObjectSchema } from './schema/v2/template.js';

/**
 * Named `$defs` for the schemas that appear dozens of times.
 *
 * Without this the emitted template schema is 2.4 MB of inlined expression AST
 * — every speed, gap and offset in the document carries its own copy of the
 * recursive grammar. With it the same schema is under 100 KB and the repeated
 * parts read as `#/$defs/NumberOrExpr`, which is both diffable and usable as a
 * constrained-decoding grammar.
 *
 * Only v2-reachable schemas are registered, so the committed v1 schema is
 * byte-identical to what it was before v2 existed.
 */
const NAMED_DEFS: Array<[z.ZodType, string]> = [
  [ExprAstSchema, 'Expr'],
  [NumberOrExprSchema, 'NumberOrExpr'],
  [RangeSchema, 'Range'],
  [EssentialitySchema, 'Essentiality'],
  [FramePoseSchema, 'FramePose'],
  [ActorSpecSchema, 'ActorSpec'],
  [DynamicsSchema, 'Dynamics'],
  [TriggerSchema, 'Trigger'],
  [ConditionSchema, 'Condition'],
  [PointRefSchema, 'PointRef'],
];

for (const [schema, id] of NAMED_DEFS) {
  if (!z.globalRegistry.get(schema)) z.globalRegistry.add(schema, { id });
}

export const CANONICAL_V2_SCHEMA_BASE = 'https://schemas.simforge.dev';
export const LEGACY_V2_SCHEMA_BASE = 'https://schemas.uniscenarios.dev';
/** Digest-preserving writer switch; committed generated schemas stay legacy until cutover. */
export const EMIT_CANONICAL_V2_SCHEMA_IDS = false;
/** Base URL every emitted v2 `$id` hangs off. */
export const V2_SCHEMA_BASE = EMIT_CANONICAL_V2_SCHEMA_IDS
  ? CANONICAL_V2_SCHEMA_BASE
  : LEGACY_V2_SCHEMA_BASE;

export function isAcceptedV2SchemaId(value: string): boolean {
  return value.startsWith(`${CANONICAL_V2_SCHEMA_BASE}/`)
    || value.startsWith(`${LEGACY_V2_SCHEMA_BASE}/`);
}

/** Committed path of the whole-template schema. */
export const TEMPLATE_JSON_SCHEMA_PATH = 'schema/scenario-template.v2.schema.json';
/** Committed path of the anchor-only schema. */
export const ANCHOR_JSON_SCHEMA_PATH = 'schema/logical-anchor.v2.schema.json';
/** Committed path of the interaction-list schema. */
export const INTERACTIONS_JSON_SCHEMA_PATH = 'schema/interactions.v2.schema.json';

const STRUCTURAL_RULES = [
  'Rules enforced by the reference validator that JSON Schema cannot express:',
  '(1) ids must be unique within each list;',
  '(2) every role/feature/interaction reference must resolve;',
  '(3) `dynamics` is REQUIRED on the continuous verbs (speed, gap, changeLane, laneOffset);',
  '(4) `byLatest` is REQUIRED on every `when` trigger;',
  '(5) one axis has one owner: two interactions on the same actor and axis may not start at the same time;',
  '(6) `set` keys must exist in the typed key registry (rules.*, lights.*, doors.*, pose.*, signal:*, env.*);',
  '(7) `env.*` and `signal:*` sets must be performed by the reserved actor "@world";',
  '(8) `targetRevealToConflictS` requires `occludes`;',
  '(9) meta.modifiedAt must not precede meta.createdAt.',
].join(' ');

function build(schema: z.ZodType, id: string, title: string, description: string): Record<string, unknown> {
  const base = z.toJSONSchema(schema, { io: 'input', reused: 'ref' }) as Record<string, unknown>;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${V2_SCHEMA_BASE}/${id}`,
    title,
    description,
    ...base,
  };
}

/** The whole v2 template. */
export function buildTemplateJsonSchema(): Record<string, unknown> {
  return build(
    ScenarioTemplateV2ObjectSchema,
    'scenario-template.v2.schema.json',
    `SimForge scenario template, schema v${SCENARIO_TEMPLATE_VERSION}`,
    `A portable scenario template: a logical anchor (a predicate over road structure, with no coordinates and no road ids), roles bound to the matched structure, a frame-relative timeline of interactions, parameters, and the invariants that must survive retargeting. Numbers written as strings are parsed as expressions over lane.speedLimitKph, lane.widthM, junction.sizeM, clip.seconds and param.<name>, with + - * / and clamp/min/max/abs. ${STRUCTURAL_RULES}`,
  );
}

/** The LLM's primary emission target. */
export function buildAnchorJsonSchema(): Record<string, unknown> {
  return build(
    LogicalAnchorSchema,
    'logical-anchor.v2.schema.json',
    'SimForge logical anchor, schema v2',
    'A predicate over road structure that a scenario can be matched onto. Contains no coordinates, no road ids and no map names: only lane counts, speed limits, junction classes, turn relations and distances along a corridor. Every clause is {value, essentiality: required|preferred|cosmetic, weight?}; ranges are [min, max] with null for an open end. `required` clauses are pass/fail for the matcher; `preferred` and `cosmetic` are scored and may be substituted or dropped. Features are ordered along the corridor by `atM`, measured from the frame origin, negative upstream.',
  );
}

/** The timeline alone. */
export function buildInteractionsJsonSchema(): Record<string, unknown> {
  return build(
    z.array(InteractionSchema).max(256),
    'interactions.v2.schema.json',
    'SimForge interaction list, schema v2',
    `A timeline of interactions: {id, actor, trigger, verb, target, dynamics?, until?}. Seven verbs over five axes — speed and gap (longitudinal), changeLane and laneOffset (lateral), route (topology), exist (existence), set (discrete state). One axis has one owner and later preempts earlier; there are no priorities and no nesting. Triggers are at(t), after(id, delay), when(condition, byLatest, ifNever) or arrival(of, at, syncWith, ttc|deltaT) — the last back-solves a start so the actor reaches a conflict point at a declared criticality, and is what makes a generated scenario non-trivial. ${STRUCTURAL_RULES}`,
  );
}

/** Every published v2 schema, as `[path, document]` pairs. */
export function buildAllV2JsonSchemas(): Array<[string, Record<string, unknown>]> {
  return [
    [TEMPLATE_JSON_SCHEMA_PATH, buildTemplateJsonSchema()],
    [ANCHOR_JSON_SCHEMA_PATH, buildAnchorJsonSchema()],
    [INTERACTIONS_JSON_SCHEMA_PATH, buildInteractionsJsonSchema()],
  ];
}
