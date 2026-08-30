import { createHash } from 'node:crypto';

import {
  extractOpenScenarioExecutionPlan,
  type OpenScenarioExecutionPlan,
  type OpenScenarioPlanActor,
  type OpenScenarioPlanSample,
} from '@simforge-oss/openscenario';
import type { FixedSchedule } from '../schedule.js';

export interface NativeActorState {
  readonly id: string;
  readonly kind: 'spawn' | 'update' | 'despawn';
  readonly catalogId: string;
  readonly actorClass: string;
  readonly transform: {
    readonly position: readonly [number, number, number];
    readonly rotation: readonly [number, number, number, number];
  };
  readonly velocity: readonly [number, number, number];
}

export interface NativeSceneState {
  readonly version: 'scene-state.v1';
  readonly mapId: string;
  readonly tick: number;
  readonly tickHz: number;
  readonly weather: { readonly preset: 'clear' | 'rain' | 'fog' | 'night' };
  readonly timeOfDay: number;
  readonly actors: readonly NativeActorState[];
}

export interface NativeLowering {
  readonly plan: OpenScenarioExecutionPlan;
  readonly states: readonly NativeSceneState[];
  readonly frameTimes: readonly number[];
  readonly sha256: string;
}

function q(value: number): number {
  return Number(value.toFixed(6));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot contain non-finite numbers');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot contain ${typeof value}`);
}

function sampleAt(actor: OpenScenarioPlanActor, time: number): OpenScenarioPlanSample {
  const samples = actor.samples;
  if (time <= samples[0]!.t) return samples[0]!;
  if (time >= samples.at(-1)!.t) return samples.at(-1)!;
  let low = 0;
  let high = samples.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle]!.t <= time) low = middle;
    else high = middle;
  }
  const left = samples[low]!;
  const right = samples[high]!;
  const ratio = (time - left.t) / (right.t - left.t);
  const headingDelta = Math.atan2(
    Math.sin(right.headingRad - left.headingRad),
    Math.cos(right.headingRad - left.headingRad),
  );
  return {
    t: time,
    x: left.x + (right.x - left.x) * ratio,
    y: left.y + (right.y - left.y) * ratio,
    z: left.z + (right.z - left.z) * ratio,
    headingRad: left.headingRad + headingDelta * ratio,
    speedMps: left.speedMps + (right.speedMps - left.speedMps) * ratio,
    present: left.present && right.present,
  };
}

function actorClass(kind: string): string {
  const classes: Record<string, string> = {
    car: 'car', truck: 'truck', bus: 'bus', motorcycle: 'motorcycle', bicycle: 'cyclist',
    pedestrian: 'pedestrian', obstacle: 'prop', van: 'van', suv: 'suv', pickup: 'pickup',
  };
  return classes[kind] ?? 'prop';
}

function catalogId(kind: string, tags: readonly string[]): string {
  const tagged = tags.find((tag) => tag.startsWith('catalog:'));
  if (tagged) return tagged.slice('catalog:'.length);
  const defaults: Record<string, string> = {
    pedestrian: 'pedestrian.adult', bicycle: 'cyclist.commuter', bus: 'vehicle.transit-bus',
    truck: 'vehicle.box-truck', motorcycle: 'vehicle.motorcycle', obstacle: 'prop.traffic-cone',
  };
  return defaults[kind] ?? 'vehicle.sedan';
}

function environment(plan: OpenScenarioExecutionPlan): { preset: 'clear' | 'rain' | 'fog' | 'night'; hour: number } {
  const authored = plan.environment.authored;
  const preset = authored.timeOfDay === 'night'
    ? 'night'
    : authored.weather === 'rain'
      ? 'rain'
      : plan.environment.standard.fogVisualRangeM < 1_000
        ? 'fog'
        : 'clear';
  const hour = authored.timeOfDay === 'night' ? 2 : authored.timeOfDay === 'dusk' ? 19.5 : authored.timeOfDay === 'dawn' ? 6 : 12;
  return { preset, hour };
}

function unionFrameTimes(schedules: readonly FixedSchedule[]): number[] {
  const micros = new Set<number>();
  for (const schedule of schedules) {
    for (let index = 0; index < schedule.frameCount; index += 1) {
      micros.add(Math.round((schedule.startSeconds + index / schedule.framesPerSecond) * 1_000_000));
    }
  }
  return [...micros].sort((left, right) => left - right).map((value) => value / 1_000_000);
}

export function lowerOpenScenarioToNative(
  xosc: string,
  sourceSha256: string,
  schedules: readonly FixedSchedule[],
): NativeLowering {
  if (schedules.length === 0) throw new Error('native render requires at least one RGB schedule');
  const plan = extractOpenScenarioExecutionPlan(xosc, { sourceSha256 });
  const frameTimes = unionFrameTimes(schedules);
  const conditions = environment(plan);
  const previous = new Map<string, boolean>();
  const states = frameTimes.map((clipTime, tick): NativeSceneState => {
    const planTime = plan.warmupSeconds + clipTime;
    if (planTime > plan.stopTimeS + 1e-8) {
      throw new Error(`render frame ${tick} at ${planTime}s exceeds OpenSCENARIO stop time ${plan.stopTimeS}s`);
    }
    const actors: NativeActorState[] = [];
    for (const actor of [...plan.actors].sort((left, right) => left.id.localeCompare(right.id))) {
      const sample = sampleAt(actor, planTime);
      const wasPresent = previous.get(actor.id) === true;
      previous.set(actor.id, sample.present);
      if (!sample.present && !wasPresent) continue;
      const kind = sample.present ? (wasPresent ? 'update' : 'spawn') : 'despawn';
      const metadata = plan.actorMetadata[actor.id];
      const yaw = sample.headingRad;
      actors.push({
        id: actor.id,
        kind,
        catalogId: catalogId(actor.kind, metadata?.tags ?? actor.tags),
        actorClass: actorClass(actor.kind),
        transform: {
          position: [q(sample.x), q(sample.z), q(-sample.y)],
          rotation: [0, q(Math.sin(yaw / 2)), 0, q(Math.cos(yaw / 2))],
        },
        velocity: [q(sample.speedMps * Math.cos(yaw)), 0, q(-sample.speedMps * Math.sin(yaw))],
      });
    }
    const previousTime = tick === 0 ? frameTimes[1] ?? clipTime + plan.dt : frameTimes[tick - 1]!;
    const tickHz = q(1 / Math.max(1e-9, Math.abs(clipTime - previousTime)));
    return {
      version: 'scene-state.v1', mapId: plan.mapId, tick, tickHz,
      weather: { preset: conditions.preset }, timeOfDay: conditions.hour, actors,
    };
  });
  const sha256 = createHash('sha256').update(canonicalJson({ planSource: sourceSha256, states })).digest('hex');
  return { plan, states, frameTimes, sha256 };
}
