import { describe, expect, it } from 'vitest';

import {
  ACTOR_AUTHORING_POLICY,
  COLLISION_INFERENCE_MAX_CLOSEST_APPROACH_M,
  DEFAULT_AUTHORED_VEHICLE_SPEED_KPH,
  isCollisionInferenceCandidate,
  CreepActionSchema,
  DEFAULT_BEHAVIOR_CLIP_END,
  DEFAULT_BEHAVIOR_TRIGGER,
  LEGACY_STOP_DECEL_WINDOW_S,
  LEGACY_SWERVE_OFFSET_M,
  LEGACY_WALKER_CONFLICT_TRIGGER_DISTANCE_M,
  ReactionProfileSchema,
  ReverseActionSchema,
  ScenarioEditorRoadAnchorSchema,
  ScenarioEditorTimelineClipSchema,
  TimedInstructionIntentSchema,
  YieldToActionSchema,
} from '../contracts.js';

describe('legacy behavior compatibility defaults', () => {
  it('preserves behavior action, trigger, completion, and reaction defaults', () => {
    expect(DEFAULT_BEHAVIOR_TRIGGER).toEqual({ kind: 'at_time', t: 0 });
    expect(DEFAULT_BEHAVIOR_CLIP_END).toEqual({ kind: 'completion' });
    expect(CreepActionSchema.parse({ kind: 'creep' })).toEqual({ kind: 'creep', speed_kph: 5 });
    expect(ReverseActionSchema.parse({ kind: 'reverse' })).toEqual({ kind: 'reverse', speed_kph: 10 });
    expect(YieldToActionSchema.parse({ kind: 'yield_to', actor: 'self' })).toEqual({
      kind: 'yield_to', actor: 'self', gap_m: 5,
    });
    expect(ReactionProfileSchema.parse({ mode: 'brake' })).toEqual({
      mode: 'brake', aggressiveness: 0.5, exempt_actor_ids: [],
    });
    expect(LEGACY_STOP_DECEL_WINDOW_S).toBe(3);
    expect(LEGACY_WALKER_CONFLICT_TRIGGER_DISTANCE_M).toBe(15);
    expect(LEGACY_SWERVE_OFFSET_M).toBe(-1);
  });

  it('preserves road-anchor, timeline, and instruction defaults', () => {
    expect(ScenarioEditorRoadAnchorSchema.parse({ road_id: '17' })).toMatchObject({ s_fraction: 0.5 });
    expect(ScenarioEditorTimelineClipSchema.parse({ id: 'clip', action: 'stop' })).toMatchObject({
      start_time: 0,
      enabled: true,
    });
    expect(TimedInstructionIntentSchema.parse({
      id: 'tii_1',
      timestampSeconds: 0,
      rowOrder: 0,
      primitiveId: 'stop',
    })).toMatchObject({ enabled: true, source: 'manual', args: {}, validationErrors: [] });
  });

  it('publishes actor and collision authoring policy from the same barrel', () => {
    expect(ACTOR_AUTHORING_POLICY).toMatchObject({
      vehicleSpeedCapKph: 240,
      walkerSpeedCapKph: 25,
      defaultAutopilot: false,
      defaultVehicleColor: '230,200,40',
    });
    expect(DEFAULT_AUTHORED_VEHICLE_SPEED_KPH).toBe(48.28032);
    expect(COLLISION_INFERENCE_MAX_CLOSEST_APPROACH_M).toBe(8);
    expect(isCollisionInferenceCandidate(8)).toBe(true);
    expect(isCollisionInferenceCandidate(8.001)).toBe(false);
  });
});
