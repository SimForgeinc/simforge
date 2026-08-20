/**
 * Portable semantic evidence emitted by a scenario runtime.
 *
 * The ledger is deliberately versioned independently of a renderer or trace
 * container.  A browser simulation, OpenSCENARIO executor, and CARLA worker can
 * therefore publish the same behavioral surface without claiming pixel or
 * physics identity.  Continuous motion is sampled; discrete semantics are
 * represented as ordered events and explicit action/trigger outcomes.
 */

import { z } from 'zod';

export const SEMANTIC_LEDGER_SCHEMA = 'uniscenarios.semantic-ledger/v1' as const;
export const SEMANTIC_LEDGER_VERSION = 1 as const;

const finite = z.number().finite();
const nullableFinite = finite.nullable();
const scalar = z.union([z.string(), z.boolean(), finite]);
const token = z.string().min(1).max(256);

export const SemanticLedgerSourceSchema = z.strictObject({
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  producer: token,
  producerVersion: token,
  mapId: token,
  frame: z.enum(['xodr-local', 'scene', 'carla-world']),
  dt: finite.positive(),
  clipSeconds: finite.nonnegative(),
  motionAuthority: z.enum([
    'kinematic-replay',
    'uniscenarios-physics',
    'carla-physics',
    'external-physics',
  ]),
  complete: z.boolean(),
});

export const SemanticActorTrackSchema = z.strictObject({
  kind: token,
  initialRouteRef: token,
  initialState: z.record(z.string(), scalar),
  t: z.array(finite),
  x: z.array(finite),
  y: z.array(finite),
  headingRad: z.array(finite),
  velocityXMps: z.array(finite),
  velocityYMps: z.array(finite),
  speedMps: z.array(finite.nonnegative()),
  motionDirection: z.array(z.union([z.literal(-1), z.literal(1)])),
  laneRsl: z.array(z.string().nullable()),
  routeS: z.array(finite.nonnegative()),
  routeRef: z.array(token),
  present: z.array(z.union([z.literal(0), z.literal(1)])),
}).superRefine((track, ctx) => {
  const expected = track.t.length;
  for (const key of [
    'x', 'y', 'headingRad', 'velocityXMps', 'velocityYMps', 'speedMps',
    'motionDirection', 'laneRsl', 'routeS', 'routeRef', 'present',
  ] as const) {
    if (track[key].length !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} must contain ${expected} samples (one per t sample)`,
      });
    }
  }
});

export const SemanticTriggerSchema = z.strictObject({
  interactionId: token,
  actorId: token,
  kind: z.enum(['at', 'after', 'when', 'arrival']),
  status: z.enum(['pending', 'fired', 'skipped']),
  forced: z.boolean(),
  firedAt: nullableFinite,
  endedAt: nullableFinite,
  skipReason: z.string().min(1).max(256).nullable(),
  truthTransitions: z.array(z.strictObject({ t: finite, value: z.boolean() })),
});

export const SemanticActionSchema = z.strictObject({
  interactionId: token,
  actorId: token,
  verb: token,
  axis: token,
  status: z.enum([
    'pending',
    'skipped',
    'active',
    'completed',
    'released',
    'preempted',
    'aborted',
    'rejected',
  ]),
  startT: nullableFinite,
  endT: nullableFinite,
  forced: z.boolean(),
  reason: z.string().min(1).max(512).nullable(),
  preemptedByInteractionId: token.nullable(),
});

export const SemanticEventSchema = z.strictObject({
  t: finite,
  kind: token,
  actorId: token.optional(),
  interactionId: token.optional(),
  payload: z.record(z.string(), z.unknown()),
});

export const SemanticSignalTrackSchema = z.strictObject({
  phase: z.array(token),
  transitions: z.array(z.strictObject({ t: finite, phase: token })),
});

export const SemanticCollisionSchema = z.strictObject({
  t: finite,
  a: token,
  b: token,
  colliderA: token.nullable(),
  colliderB: token.nullable(),
});

export const SemanticInvariantResultSchema = z.strictObject({
  id: token,
  kind: token,
  target: finite,
  achieved: finite,
  residual: finite,
});

export const SemanticLedgerSchema = z.strictObject({
  schema: z.literal(SEMANTIC_LEDGER_SCHEMA),
  version: z.literal(SEMANTIC_LEDGER_VERSION),
  source: SemanticLedgerSourceSchema,
  actors: z.record(z.string(), SemanticActorTrackSchema),
  triggers: z.array(SemanticTriggerSchema),
  actions: z.array(SemanticActionSchema),
  events: z.array(SemanticEventSchema),
  signals: z.record(z.string(), SemanticSignalTrackSchema),
  collisions: z.array(SemanticCollisionSchema),
  discreteState: z.array(z.strictObject({
    t: finite,
    actorId: token,
    key: token,
    value: scalar,
  })),
  environment: z.strictObject({
    operationalConditions: z.record(z.string(), z.unknown()),
    surfacePatches: z.array(z.unknown()),
    perception: z.unknown().nullable(),
  }),
  sensors: z.strictObject({
    declarations: z.record(z.string(), z.array(z.unknown())),
    channels: z.record(z.string(), z.unknown()),
    mapDivergence: z.record(z.string(), z.unknown()),
  }),
  invariants: z.array(SemanticInvariantResultSchema),
});

export type SemanticLedger = z.infer<typeof SemanticLedgerSchema>;
export type SemanticLedgerSource = z.infer<typeof SemanticLedgerSourceSchema>;
export type SemanticActorTrack = z.infer<typeof SemanticActorTrackSchema>;
export type SemanticTrigger = z.infer<typeof SemanticTriggerSchema>;
export type SemanticAction = z.infer<typeof SemanticActionSchema>;
export type SemanticEvent = z.infer<typeof SemanticEventSchema>;

export function parseSemanticLedger(value: unknown): SemanticLedger {
  return SemanticLedgerSchema.parse(value);
}

export function safeParseSemanticLedger(value: unknown): ReturnType<typeof SemanticLedgerSchema.safeParse> {
  return SemanticLedgerSchema.safeParse(value);
}
