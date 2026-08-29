import { z } from 'zod';

/** Compatibility-only values for normalizing pre-behavior-program documents. */
export const LEGACY_CREEP_SPEED_KPH = 5;
export const LEGACY_REVERSE_SPEED_KPH = 10;
export const LEGACY_FOLLOWING_DISTANCE_M = 5;
export const LEGACY_STOP_DECEL_WINDOW_S = 3;
export const DEFAULT_REACTION_AGGRESSIVENESS = 0.5;
export const LEGACY_WALKER_CONFLICT_TRIGGER_DISTANCE_M = 15;
export const LEGACY_SWERVE_OFFSET_M = -1;
export const BEHAVIOR_TIME_QUANTUM_S = 0.1;

export const BehaviorMapPointSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number().optional(),
});

export const BehaviorActorRefSchema = z.union([
  z.literal('self'),
  z.object({ actor_id: z.string().trim().min(1) }).strict(),
]);
export const BehaviorSignalRefSchema = z.object({
  junction_id: z.string().trim().min(1),
  movement_id: z.string().trim().min(1).optional(),
  signal_id: z.string().trim().min(1).optional(),
}).strict();

export const BehaviorTriggerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('at_time'),
    t: z.number().min(0).refine(
      (value) => Math.abs(value * 10 - Math.round(value * 10)) <= 1e-6,
      { message: `t must be quantized to ${BEHAVIOR_TIME_QUANTUM_S}s` },
    ),
  }).strict(),
  z.object({ kind: z.literal('after_clip'), clip_id: z.string().trim().min(1), delay_s: z.number().min(0).optional() }).strict(),
  z.object({ kind: z.literal('reach'), point: BehaviorMapPointSchema, radius_m: z.number().positive(), actor: BehaviorActorRefSchema.default('self') }).strict(),
  z.object({ kind: z.literal('proximity'), other: BehaviorActorRefSchema, distance_m: z.number().positive(), mode: z.enum(['closer', 'farther']).default('closer'), actor: BehaviorActorRefSchema.default('self') }).strict(),
  z.object({ kind: z.literal('ttc'), other: BehaviorActorRefSchema, seconds: z.number().positive(), actor: BehaviorActorRefSchema.default('self') }).strict(),
  z.object({ kind: z.literal('headway'), other: BehaviorActorRefSchema, seconds: z.number().positive(), actor: BehaviorActorRefSchema.default('self') }).strict(),
  z.object({ kind: z.literal('speed'), kph: z.number().min(0), rule: z.enum(['above', 'below']), actor: BehaviorActorRefSchema.default('self') }).strict(),
  z.object({ kind: z.literal('standstill'), seconds: z.number().positive(), actor: BehaviorActorRefSchema.default('self') }).strict(),
  z.object({ kind: z.literal('signal_state'), signal: BehaviorSignalRefSchema, state: z.enum(['red', 'yellow', 'green']) }).strict(),
]);
export type BehaviorTrigger = z.infer<typeof BehaviorTriggerSchema>;
export const DEFAULT_BEHAVIOR_TRIGGER: BehaviorTrigger = { kind: 'at_time', t: 0 };

export const BehaviorClipEndSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('duration'), seconds: z.number().positive() }).strict(),
  z.object({ kind: z.literal('until_trigger'), trigger: BehaviorTriggerSchema }).strict(),
  z.object({ kind: z.literal('completion'), on: z.literal('target_speed').optional() }).strict(),
]);
export type BehaviorClipEnd = z.infer<typeof BehaviorClipEndSchema>;
export const DEFAULT_BEHAVIOR_CLIP_END: BehaviorClipEnd = { kind: 'completion' };

export const CreepActionSchema = z.object({
  kind: z.literal('creep'),
  speed_kph: z.number().min(0).default(LEGACY_CREEP_SPEED_KPH),
}).strict();
export const ReverseActionSchema = z.object({
  kind: z.literal('reverse'),
  speed_kph: z.number().min(0).default(LEGACY_REVERSE_SPEED_KPH),
  distance_m: z.number().positive().optional(),
}).strict();
export const StopActionSchema = z.object({
  kind: z.literal('stop'),
  decel_window_s: z.number().positive().optional(),
  deceleration_mps2: z.number().positive().optional(),
}).strict();
export const YieldToActionSchema = z.object({
  kind: z.literal('yield_to'),
  actor: BehaviorActorRefSchema,
  gap_m: z.number().positive().default(LEGACY_FOLLOWING_DISTANCE_M),
  max_wait_s: z.number().positive().optional(),
}).strict();

export const ReactionProfileModeSchema = z.enum(['none', 'brake', 'brake_and_swerve']);
export const ReactionProfileSchema = z.object({
  mode: ReactionProfileModeSchema,
  aggressiveness: z.number().min(0).max(1).default(DEFAULT_REACTION_AGGRESSIVENESS),
  exempt_actor_ids: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type ReactionProfile = z.infer<typeof ReactionProfileSchema>;

/** Legacy road-bound placement, retained only for stored-document normalization. */
export const ScenarioEditorRoadAnchorSchema = z.object({
  road_id: z.string(),
  s_fraction: z.number().min(0).max(1).default(0.5),
  lane_id: z.number().int().nullable().optional(),
  section_id: z.number().int().nullable().optional(),
  speed_kph: z.number().min(0).nullable().optional(),
  resolution_mode: z.literal('runtime_exact').optional(),
  world_anchor: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
    yaw: z.number(),
  }).optional(),
});
export type ScenarioEditorRoadAnchor = z.infer<typeof ScenarioEditorRoadAnchorSchema>;

export const ScenarioEditorTimelineActionSchema = z.enum([
  'follow_route',
  'set_speed',
  'stop',
  'hold_position',
  'enable_autopilot',
  'disable_autopilot',
  'lane_change_left',
  'lane_change_right',
  'turn_left_at_next_intersection',
  'turn_right_at_next_intersection',
  'chase_actor',
  'ram_actor',
  'drive_reverse',
  'creep_forward',
  'yield_to_actor',
  'swerve',
]);
export const ScenarioEditorTimelineClipSchema = z.object({
  id: z.string(),
  start_time: z.number().min(0).default(0),
  end_time: z.number().min(0).nullable().optional(),
  action: ScenarioEditorTimelineActionSchema,
  target_speed_kph: z.number().min(0).nullable().optional(),
  target_actor_id: z.string().nullable().optional(),
  following_distance_m: z.number().min(0).nullable().optional(),
  enabled: z.boolean().default(true),
}).passthrough();
export type ScenarioEditorTimelineClip = z.infer<typeof ScenarioEditorTimelineClipSchema>;

export const TimedInstructionPrimitiveIdSchema = z.enum([
  'lane_follow',
  'turn_left_at_next_intersection',
  'turn_right_at_next_intersection',
  'go_straight_at_next_intersection',
  'lane_change_left',
  'lane_change_right',
  'set_speed',
  'stop',
  'hold_position',
]);
export const TimedInstructionArgsSchema = z.object({
  speedKph: z.number().min(0).max(130).optional(),
  distanceMeters: z.number().positive().optional(),
  durationSeconds: z.number().positive().optional(),
  transitionMeters: z.number().positive().optional(),
  maxWaitSeconds: z.number().positive().optional(),
  brakingWindowSeconds: z.number().positive().optional(),
  until: z.enum(['next_instruction', 'scenario_end']).optional(),
}).default({});
export const TimedInstructionIntentSchema = z.object({
  id: z.string().regex(/^tii_/),
  timestampSeconds: z.number().min(0),
  rowOrder: z.number().int().min(0),
  enabled: z.boolean().default(true),
  primitiveId: TimedInstructionPrimitiveIdSchema,
  args: TimedInstructionArgsSchema,
  source: z.enum(['manual', 'generator', 'migration']).default('manual'),
  generator: z.object({
    seed: z.string(),
    strategyId: z.string(),
    candidateRank: z.number().int().min(0),
    tags: z.array(z.string()).default([]),
  }).optional(),
  repair: z.object({
    accepted: z.boolean().default(false),
    originalTimestampSeconds: z.number().min(0).optional(),
    originalArgs: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().optional(),
  }).optional(),
  validationErrors: z.array(z.string()).default([]),
});
export type TimedInstructionIntent = z.infer<typeof TimedInstructionIntentSchema>;
