/**
 * `claims.v1` — the versioned claim schema for examiner reasoning output.
 *
 * A *claim set* is a typed decomposition of a natural-language episode
 * description into propositions over engine state. Four proposition types,
 * per the WS2 contract:
 *
 * - `visibility`      — an actor's line-of-sight state to an observer over a
 *                       tick range;
 * - `causal-trigger`  — an ordered event→event proposition (a trigger fired
 *                       before/caused another engine event);
 * - `intent`          — an authored, executed interaction intent of one actor;
 * - `spatial`         — a relation between two actors (or an actor and the
 *                       ego) over a tick range.
 *
 * Every claim carries `actorIds`, a half-open `tickRange` in decision seconds,
 * and the contract's `checkable` flag: `deterministic` claims are judged by
 * `checkers.ts` against engine ground truth; `extracted` claims are recorded
 * but deferred — truth judgment never leaves the deterministic layer.
 *
 * The zod schemas below are the parsing boundary; `CLAIMS_V1_JSON_SCHEMA` is
 * the same contract as JSON Schema for LLM constrained decoding.
 */

import { z } from 'zod';

export const CLAIMS_SCHEMA_ID = 'https://uniscenarios.dev/schemas/claims.v1.json';
export const CLAIMS_SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ shared */

export const tickRangeSchema = z.object({
  /** First decision second (inclusive). */
  fromTS: z.number().finite().nonnegative(),
  /** Last decision second (exclusive; must exceed `fromTS`). */
  toTS: z.number().finite(),
}).refine((r) => r.toTS > r.fromTS, { message: 'tickRange.toTS must be > fromTS' });

/** Engine event reference for causal propositions. */
export const eventRefSchema = z.object({
  kind: z.enum([
    'trigger-fired',
    'trigger-skipped',
    'preemption',
    'released',
    'completed',
    'conflict-genesis',
  ]),
  interactionId: z.string().min(1).optional(),
  actorId: z.string().min(1).optional(),
  /** For `conflict-genesis`: which metric genesis this refers to. */
  metric: z.enum(['ttc', 'distance']).optional(),
});

export type EventRef = z.infer<typeof eventRefSchema>;

/* ------------------------------------------------------- proposition types */

const visibilityPayload = z.object({
  /** Observer whose line of sight is claimed; defaults to the ego. */
  observerId: z.string().min(1).optional(),
  /** `visible` = clear LOS; `occluded` = evaluated but blocked. */
  state: z.enum(['visible', 'occluded']),
});

const causalTriggerPayload = z.object({
  cause: eventRefSchema,
  effect: eventRefSchema,
  /**
   * `causes` — the effect happened within {@link CAUSAL_GAP_S} of the cause
   * with no intervening trigger on the same actor; `precedes` — ordering only.
   */
  relation: z.enum(['causes', 'precedes']),
});

/** Intent verb classes — exactly the materializer's interaction verb set. */
export const INTENT_VERBS = [
  'speed',
  'gap',
  'changeLane',
  'laneOffset',
  'route',
  'exist-present',
  'exist-absent',
  'set',
] as const;

const intentPayload = z.object({
  verb: z.enum(INTENT_VERBS),
  interactionId: z.string().min(1).optional(),
});

export const SPATIAL_RELATIONS = [
  'ahead-of',
  'behind',
  'left-of',
  'right-of',
  'same-lane',
  'within-distance',
] as const;

const spatialPayload = z.object({
  relation: z.enum(SPATIAL_RELATIONS),
  /** The frame actor (origin); defaults to the ego. */
  referenceActorId: z.string().min(1).optional(),
  /** Metres — required by and only meaningful for `within-distance`. */
  valueM: z.number().finite().positive().optional(),
}).refine(
  (p) => p.relation !== 'within-distance' || p.valueM !== undefined,
  { message: 'spatial relation within-distance requires valueM' },
);

/* ------------------------------------------------------------ claim + set */

export const claimSchema = z.intersection(
  z.object({
    id: z.string().min(1),
    type: z.enum(['visibility', 'causal-trigger', 'intent', 'spatial']),
    /** Every actor the proposition is about; ≥1 for all current types. */
    actorIds: z.array(z.string().min(1)).min(1),
    tickRange: tickRangeSchema,
    checkable: z.enum(['deterministic', 'extracted']),
    /** Optional source span/quotation from the description, for audits. */
    quote: z.string().max(500).optional(),
  }),
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('visibility'), ...visibilityPayload.shape }).loose(),
    z.object({ type: z.literal('causal-trigger'), ...causalTriggerPayload.shape }).loose(),
    z.object({ type: z.literal('intent'), ...intentPayload.shape }).loose(),
    z.object({ type: z.literal('spatial'), ...spatialPayload.shape }).loose().refine(
      (p) => p.relation !== 'within-distance' || p.valueM !== undefined,
      { message: 'spatial relation within-distance requires valueM' },
    ),
  ]),
);

export const claimSetSchema = z.object({
  schema: z.literal(CLAIMS_SCHEMA_ID),
  scenarioId: z.string().min(1),
  claims: z.array(claimSchema),
});

export type Claim = z.infer<typeof claimSchema>;
export type ClaimSet = z.infer<typeof claimSetSchema>;

/**
 * The gap (in seconds) within which a `causes` effect may follow its cause.
 * Deliberately a small band: `causes` is a strong claim.
 */
export const CAUSAL_GAP_S = 2.0;

/** Slack around a claim's tick range when locating referenced events. */
export const EVENT_LOCATE_SLACK_S = 0.5;

/* ------------------------------------------------------------ JSON Schema */

function ref(name: string): { $ref: string } {
  return { $ref: `#/$defs/${name}` };
}

/**
 * JSON Schema twin of {@link claimSetSchema} — the payload sent to
 * OpenAI-compatible endpoints for structured output (`response_format`
 * `json_schema`). Kept hand-written and in sync with the zod tree; the
 * extractor validates every parse through zod regardless, so drift here can
 * only cost a retry, never correctness.
 */
export const CLAIMS_V1_JSON_SCHEMA = {
  name: 'claims_v1',
  schema: {
    $id: CLAIMS_SCHEMA_ID,
    title: 'SimForge claims.v1',
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'scenarioId', 'claims'],
    properties: {
      schema: { const: CLAIMS_SCHEMA_ID },
      scenarioId: { type: 'string', minLength: 1 },
      claims: { type: 'array', items: ref('claim') },
    },
    $defs: {
      tickRange: {
        type: 'object',
        additionalProperties: false,
        required: ['fromTS', 'toTS'],
        properties: {
          fromTS: { type: 'number', minimum: 0, description: 'first decision second (inclusive)' },
          toTS: { type: 'number', description: 'last decision second (exclusive)' },
        },
      },
      eventRef: {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: {
          kind: {
            enum: [
              'trigger-fired',
              'trigger-skipped',
              'preemption',
              'released',
              'completed',
              'conflict-genesis',
            ],
          },
          interactionId: { type: 'string' },
          actorId: { type: 'string' },
          metric: { enum: ['ttc', 'distance'] },
        },
      },
      visibility: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'id', 'actorIds', 'tickRange', 'checkable', 'state'],
        properties: {
          type: { const: 'visibility' },
          id: { type: 'string' },
          actorIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
          tickRange: ref('tickRange'),
          checkable: { enum: ['deterministic', 'extracted'] },
          observerId: { type: 'string', description: 'defaults to the ego' },
          state: { enum: ['visible', 'occluded'] },
          quote: { type: 'string' },
        },
      },
      causalTrigger: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'id', 'actorIds', 'tickRange', 'checkable', 'cause', 'effect', 'relation'],
        properties: {
          type: { const: 'causal-trigger' },
          id: { type: 'string' },
          actorIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
          tickRange: ref('tickRange'),
          checkable: { enum: ['deterministic', 'extracted'] },
          cause: ref('eventRef'),
          effect: ref('eventRef'),
          relation: { enum: ['causes', 'precedes'] },
          quote: { type: 'string' },
        },
      },
      intent: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'id', 'actorIds', 'tickRange', 'checkable', 'verb'],
        properties: {
          type: { const: 'intent' },
          id: { type: 'string' },
          actorIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
          tickRange: ref('tickRange'),
          checkable: { enum: ['deterministic', 'extracted'] },
          verb: { enum: [...INTENT_VERBS] },
          interactionId: { type: 'string' },
          quote: { type: 'string' },
        },
      },
      spatial: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'id', 'actorIds', 'tickRange', 'checkable', 'relation'],
        properties: {
          type: { const: 'spatial' },
          id: { type: 'string' },
          actorIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
          tickRange: ref('tickRange'),
          checkable: { enum: ['deterministic', 'extracted'] },
          relation: { enum: [...SPATIAL_RELATIONS] },
          referenceActorId: { type: 'string', description: 'frame actor; defaults to the ego' },
          valueM: { type: 'number', exclusiveMinimum: 0, description: 'required for within-distance' },
          quote: { type: 'string' },
        },
      },
      claim: {
        oneOf: [ref('visibility'), ref('causalTrigger'), ref('intent'), ref('spatial')],
      },
    },
  },
} as const;
