/**
 * SimTrace (xodr-local) → scene-state.v1 document.
 *
 * Deterministic: same trace bytes → same document bytes (sorted actor ids,
 * fixed precision via the trace's own quantisation — no extra rounding).
 *
 * Input is typed structurally (the subset of `SimTrace` this consumes) so the
 * emitter runs anywhere without pulling the engine's build graph. The frame
 * flip mirrors packages/engine/src/frames.ts (`toSceneXZ`: scene
 * `{x, z} = {x, -y}`, headings numerically identical).
 */

import {
  SCENE_STATE_VERSION,
  type ActorClass,
  type ActorDesc,
  type ActorTick,
  type SceneFrame,
  type SceneState,
  type Weather,
} from './schema.js';

/** Structural subset of `SimTrace` consumed here. */
export interface TraceInput {
  readonly header: {
    readonly mapId: string;
    readonly dt: number;
    readonly actorMetadata?: Record<
      string,
      { readonly kind: string; readonly static?: boolean; readonly dims?: { l: number; w: number; h: number }; readonly tags?: readonly string[] } | undefined
    >;
    readonly operationalConditions?: {
      readonly weather?: 'clear' | 'rain' | 'overcast';
      readonly timeOfDay?: 'day' | 'dusk' | 'night' | 'dawn';
    };
  };
  readonly ticks: {
    readonly t: readonly number[];
    readonly actors: Record<
      string,
      {
        readonly x: readonly number[];
        readonly y: readonly number[];
        readonly headingRad: readonly number[];
        readonly speedMps: readonly number[];
        readonly present: readonly (boolean | number)[];
      }
    >;
  };
}

/** Quantise emitted floats so JSON/msgpack hashes are stable across engines. */
function q(v: number): number {
  return Number(v.toFixed(6));
}

/** Yaw about +Y → y-up quaternion `[x, y, z, w]`. */
export function yawToQuaternion(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

const CLASS_BY_KIND: Record<string, ActorClass> = {
  car: 'car',
  truck: 'truck',
  bus: 'bus',
  motorcycle: 'motorcycle',
  bicycle: 'bicycle',
  pedestrian: 'pedestrian',
  obstacle: 'prop',
};

const CATALOG_BY_KIND: Record<string, string> = {
  pedestrian: 'pedestrian.adult',
  bicycle: 'cyclist.commuter',
  bus: 'vehicle.transit-bus',
  truck: 'vehicle.box-truck',
  motorcycle: 'vehicle.motorcycle',
  obstacle: 'prop.traffic-cone',
};

/**
 * Catalog binding for an actor. Traces tag actors with
 * `catalog:<prop-catalog id>` when authored; otherwise a deterministic class
 * default keeps browser/native consistent.
 */
export function catalogIdFor(meta:
  | { readonly kind: string; readonly tags?: readonly string[] }
  | undefined): string {
  const tagged = meta?.tags?.find((t) => t.startsWith('catalog:'));
  if (tagged) return tagged.slice('catalog:'.length);
  return CATALOG_BY_KIND[meta?.kind ?? ''] ?? 'vehicle.sedan';
}

/** Trace `operationalConditions`-compatible defaults for older traces. */
function weatherFrom(conditions?: TraceInput['header']['operationalConditions']): {
  weather: Weather;
  timeOfDay: number;
} {
  const preset =
    conditions?.timeOfDay === 'night'
      ? 'night'
      : conditions?.weather === 'rain'
        ? 'rain'
        : conditions?.weather === 'overcast'
          ? 'fog'
          : 'clear';
  const timeOfDay =
    conditions?.timeOfDay === 'night'
      ? 2
      : conditions?.timeOfDay === 'dusk'
        ? 19.5
        : conditions?.timeOfDay === 'dawn'
          ? 6
          : 12;
  return {
    weather: {
      preset,
      fogDensity: preset === 'fog' ? 0.35 : preset === 'night' ? 0.05 : 0,
      rainIntensity: preset === 'rain' ? 0.7 : 0,
      wetness: preset === 'rain' ? 0.8 : 0,
    },
    timeOfDay,
  };
}

/**
 * Emit the per-tick scene-state document from a trace.
 *
 * Spawn/despawn derive from the actor's `present` channel transitions; an
 * actor that is never absent emits exactly one leading `spawn`. Velocity is
 * the exact forward-speed × heading vector the engine integrates (not a finite
 * difference), so motion-vector ground truth matches solver state.
 */
export function emitSceneState(trace: TraceInput): SceneState {
  const header = trace.header;
  const t = trace.ticks.t;
  const { weather, timeOfDay } = weatherFrom(header.operationalConditions);

  const actorIds = Object.keys(trace.ticks.actors).sort();
  const actors: ActorDesc[] = actorIds.map((id) => {
    const meta = header.actorMetadata?.[id];
    const colorTag = meta?.tags?.find((tag) => tag.startsWith('color:'));
    return {
      id,
      catalogId: catalogIdFor(meta),
      actorClass: CLASS_BY_KIND[meta?.kind ?? 'car'] ?? 'car',
      ...(meta?.dims ? { dims: { ...meta.dims } } : {}),
      ...(colorTag ? { color: colorTag.slice('color:'.length) } : {}),
    };
  });

  const frames: SceneFrame[] = [];
  // prevPresent is undefined until the actor's first record: traces start at
  // t=0 with present=false for delayed entrances, true for immediate ones.
  const prevPresent = new Map<string, boolean>();
  // Previous world-frame velocity per actor, for the backward acceleration
  // difference. Reset on spawn so a re-entering body never inherits history.
  const prevVelocity = new Map<string, [number, number, number]>();

  for (let i = 0; i < t.length; i++) {
    const records: ActorTick[] = [];
    for (const id of actorIds) {
      const tr = trace.ticks.actors[id]!;
      // Traces serialise `present` as 0/1 numbers; normalise once.
      const present = tr.present[i] === true || tr.present[i] === 1;
      const was = prevPresent.get(id) === true;
      prevPresent.set(id, present);

      if (!present && !was) continue; // nothing on screen to emit
      let kind: ActorTick['kind'];
      if (present && !was) kind = 'spawn';
      else if (!present && was) kind = 'despawn';
      else kind = 'update';

      const headingRad = tr.headingRad[i]!;
      const speedMps = tr.speedMps[i]!;
      const velocity: [number, number, number] = [
        speedMps * Math.cos(headingRad),
        0,
        -speedMps * Math.sin(headingRad),
      ];
      // Backward finite difference of the velocity channel — includes the
      // centripetal term when the heading turns. First record and fresh
      // spawns have no prior sample: acceleration is zero, not unknown.
      const prev = kind === 'update' ? prevVelocity.get(id) : undefined;
      const invDt = 1 / header.dt;
      const acceleration: [number, number, number] = prev
        ? [(velocity[0] - prev[0]) * invDt, 0, (velocity[2] - prev[2]) * invDt]
        : [0, 0, 0];
      prevVelocity.set(id, velocity);
      records.push({
        id,
        kind,
        position: [q(tr.x[i]!), 0, q(-tr.y[i]!)],
        rotation: yawToQuaternion(headingRad).map(q) as [number, number, number, number],
        yawRad: q(headingRad),
        velocity: [q(velocity[0]), 0, q(velocity[2])],
        acceleration: [q(acceleration[0]), 0, q(acceleration[2])],
      });
    }
    frames.push({ tick: i, t: q(t[i]!), actors: records });
  }

  return {
    version: SCENE_STATE_VERSION,
    mapId: header.mapId,
    frame: 'scene-yup',
    dt: header.dt,
    tickHz: q(1 / header.dt),
    tickCount: frames.length,
    weather,
    timeOfDay,
    profile: 'sensor',
    groundY: null,
    actors,
    frames,
  };
}
