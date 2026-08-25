/**
 * scene-state.v1 — the one scene description both native-renderer ingestion
 * modes consume.
 *
 * Produced from a `SimTrace` (trace.json.gz) by `emitSceneState` for trace
 * playback, and by the env-server bridge per tick for closed-loop live mode.
 * Wire formats: JSON (file playback, hashing) and msgpack (live stream); the
 * schema is identical in both.
 *
 * Coordinate frame: y-up **scene** frame — `position = [x, groundY, z]` with
 * `x/z = toSceneXZ(trace xodr-local x/y)` and headings numerically identical
 * (see packages/engine/src/frames.ts). Actor origins are on the ground
 * plane at the actor's centre; `groundY` (per document or per frame) carries
 * the renderer's road-surface elevation because traces have no height channel.
 */

import { z } from 'zod';

export const CANONICAL_SCENE_STATE_VERSION = 'simforge.scene-state.v1' as const;
export const LEGACY_SCENE_STATE_VERSION = 'scene-state.v1' as const;
/**
 * Digest-preserving emission switch. Keep false until stored recordings and
 * renderers are deliberately re-canonicalized in one coordinated release.
 */
export const EMIT_CANONICAL_SCENE_STATE_VERSION = false;
export const SCENE_STATE_VERSION = (
  EMIT_CANONICAL_SCENE_STATE_VERSION
    ? CANONICAL_SCENE_STATE_VERSION
    : LEGACY_SCENE_STATE_VERSION
) as typeof CANONICAL_SCENE_STATE_VERSION | typeof LEGACY_SCENE_STATE_VERSION;

/** Render profiles; part of the render intent (WSB4 owns `cinematic`). */
export const renderProfileSchema = z.enum(['sensor', 'cinematic']);
export type RenderProfile = z.infer<typeof renderProfileSchema>;

export const weatherSchema = z.object({
  /** Coarse preset driving the WSB4 weather ladder. */
  preset: z.enum(['clear', 'fog', 'rain', 'night']).default('clear'),
  fogDensity: z.number().finite().min(0).max(1).default(0),
  rainIntensity: z.number().finite().min(0).max(1).default(0),
  /** Road wetness fraction for reflectance ramp. */
  wetness: z.number().finite().min(0).max(1).default(0),
});
export type Weather = z.infer<typeof weatherSchema>;

export const actorClassSchema = z.enum(['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian', 'prop']);
export type ActorClass = z.infer<typeof actorClassSchema>;

export const actorDimsSchema = z.object({
  l: z.number().finite().positive(),
  w: z.number().finite().positive(),
  h: z.number().finite().positive(),
});

/** Static per-actor description: identity + geometry binding, never per-tick. */
export const actorDescSchema = z.object({
  /** Stable across ticks and across browser/native renderers. */
  id: z.string().min(1),
  /** prop-catalog entry used for mesh selection (`vehicle.sedan`, …). */
  catalogId: z.string().min(1),
  actorClass: actorClassSchema,
  dims: actorDimsSchema.optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
export type ActorDesc = z.infer<typeof actorDescSchema>;

/**
 * Per-tick record for one actor.
 *
 * `kind` gives spawn/despawn semantics explicitly so consumers never infer
 * from presence gaps:
 * - `spawn`   first tick the actor is present; transform is authoritative.
 * - `update`  continues to be present.
 * - `despawn` last tick it was present; after this tick the consumer removes
 *             the instance. A later `spawn` re-creates it (new instance is a
 *             fresh ID-band entry only if the id differs).
 */
export const actorTickSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['spawn', 'update', 'despawn']),
  position: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  /** Y-up quaternion `[x, y, z, w]`. */
  rotation: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
  /** Yaw in radians, CCW from +X about +Y; redundant with rotation, kept exact. */
  yawRad: z.number().finite(),
  /** World-frame linear velocity m/s `[vx, vy, vz]`. */
  velocity: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  /**
   * World-frame linear acceleration m/s² `[ax, ay, az]`. Additive optional
   * field (schema stays v1): emitters that can compute it include it;
   * consumers must tolerate its absence on older documents. Provenance is
   * emitter-declared, not encoded — the trace emitter derives it by backward
   * finite difference of the velocity channel (so it carries the centripetal
   * term when a body turns); the live env-server stream projects the engine's
   * planned longitudinal acceleration onto the heading.
   */
  acceleration: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
});
export type ActorTick = z.infer<typeof actorTickSchema>;

export const frameSchema = z.object({
  tick: z.number().int().nonnegative(),
  /** Seconds since clip start (trace ticks.t). */
  t: z.number().finite(),
  actors: z.array(actorTickSchema),
});
export type SceneFrame = z.infer<typeof frameSchema>;

export const sceneStateSchema = z.object({
  version: z.union([
    z.literal(CANONICAL_SCENE_STATE_VERSION),
    z.literal(LEGACY_SCENE_STATE_VERSION),
  ]),
  mapId: z.string().min(1),
  frame: z.literal('scene-yup'),
  dt: z.number().finite().positive(),
  tickHz: z.number().finite().positive(),
  tickCount: z.number().int().nonnegative(),
  weather: weatherSchema,
  /** Hour of day [0, 24); sun position/exposure derive from this. */
  timeOfDay: z.number().finite().min(0).max(24),
  profile: renderProfileSchema.default('sensor'),
  /**
   * Road-surface elevation hint for placing actor origins when no height
   * channel exists; null when the consumer must resolve it (raycast/tiles).
   */
  groundY: z.number().finite().nullable().default(null),
  actors: z.array(actorDescSchema),
  frames: z.array(frameSchema),
});
export type SceneState = z.infer<typeof sceneStateSchema>;
