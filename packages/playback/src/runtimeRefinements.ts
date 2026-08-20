import type { ActorRenderer, ActorView } from '@uniscenarios/editor-core';
import {
  parseSimScenarioInput,
  type Interaction,
  type SimScenarioInput,
} from '@uniscenarios/sim-engine';
import type { PlaybackBundle } from './model';

const HIGH_SPEED_WORLD_ROUTE_MPS = 20;
const PASSENGER_CAR_MAX_LATERAL_ACCELERATION_MPS2 = 7;
const MIN_STABLE_YAW_RATE_RADPS = 0.08;
const CRUISE_RESTORE_ACCELERATION_MPS2 = 3;
const GRAVITY_MPS2 = 9.81;
const MIN_CURB_RISE_M = 0.04;
const MAX_CURB_RISE_M = 0.35;
const MIN_CURB_SLOPE = 0.08;
const CURB_EVENT_COOLDOWN_S = 0.45;

const WHEELED_ROAD_ACTOR_KINDS = new Set([
  'vehicle',
  'car',
  'van',
  'truck',
  'bus',
  'motorcycle',
  'bicycle',
]);

/** Stabilize high-speed authored world routes before they reach dynamic-v1. */
export function withStableHighSpeedWorldRoutes(input: SimScenarioInput): SimScenarioInput {
  const actorIds = new Set(
    input.interactions
      .filter((interaction) =>
        interaction.verb === 'route'
        && interaction.target.kind === 'polyline'
        && interaction.bestEffortWorldPath === true)
      .map((interaction) => interaction.actorId),
  );
  if (actorIds.size === 0) return input;

  const existingProfiles = input.physics?.vehicleProfiles ?? {};
  const vehicleProfiles = { ...existingProfiles };
  const stabilizedActorIds = new Set<string>();
  let changed = false;

  for (const actor of input.actors) {
    if (!actorIds.has(actor.id) || actor.static || !WHEELED_ROAD_ACTOR_KINDS.has(actor.kind)) continue;
    const referenceSpeedMps = Math.max(
      Math.abs(actor.initial.speedMps),
      Math.abs(actor.behavior.cruiseSpeedMps ?? 0),
    );
    if (referenceSpeedMps < HIGH_SPEED_WORLD_ROUTE_MPS) continue;

    const existing = existingProfiles[actor.id] ?? {};
    const lateralAccelerationMps2 = existing.maxLateralAccelerationMps2
      ?? PASSENGER_CAR_MAX_LATERAL_ACCELERATION_MPS2;
    const feasibleYawRateRadps = Math.max(
      MIN_STABLE_YAW_RATE_RADPS,
      lateralAccelerationMps2 / referenceSpeedMps,
    );
    const maxYawRateRadps = existing.maxYawRateRadps === undefined
      ? feasibleYawRateRadps
      : Math.min(existing.maxYawRateRadps, feasibleYawRateRadps);
    vehicleProfiles[actor.id] = { ...existing, maxYawRateRadps };
    stabilizedActorIds.add(actor.id);
    changed = true;
  }

  const interactions = input.interactions.map((interaction) => {
    if (
      !stabilizedActorIds.has(interaction.actorId)
      || interaction.verb !== 'route'
      || interaction.target.kind !== 'polyline'
      || interaction.joinFromCurrentPose !== true
    ) return interaction;
    changed = true;
    return { ...interaction, joinFromCurrentPose: false };
  });

  if (!changed) return input;
  return parseSimScenarioInput({
    ...input,
    physics: {
      ...input.physics,
      mode: input.physics?.mode ?? 'dynamic-v1',
      vehicleProfiles,
    },
    interactions,
  });
}

/** Restore an actor's baseline cruise speed when a bounded speed action releases. */
export function withBoundedSpeedCruiseRestoration(input: SimScenarioInput): SimScenarioInput {
  const actors = new Map(input.actors.map((actor) => [actor.id, actor]));
  const existingIds = new Set(input.interactions.map((interaction) => interaction.id));
  const restorations: Interaction[] = [];

  for (const interaction of input.interactions) {
    if (interaction.verb !== 'speed' || !interaction.window) continue;
    const actor = actors.get(interaction.actorId);
    const cruiseSpeedMps = actor?.behavior.cruiseSpeedMps;
    if (!actor || cruiseSpeedMps === undefined || actor.static) continue;
    const releaseTime = interaction.window.endS;
    if (releaseTime >= input.clipSeconds - 1e-9) continue;
    if (hasLongitudinalCommandAt(input.interactions, interaction.id, interaction.actorId, releaseTime)) continue;
    const id = `restore-cruise-${interaction.id}`;
    if (existingIds.has(id)) continue;
    existingIds.add(id);
    restorations.push({
      id,
      actorId: interaction.actorId,
      trigger: { kind: 'at', t: releaseTime },
      verb: 'speed',
      target: { mode: 'absolute', value: cruiseSpeedMps },
      dynamics: {
        shape: 'linear',
        constraint: 'rate',
        value: CRUISE_RESTORE_ACCELERATION_MPS2,
      },
    });
  }

  if (restorations.length === 0) return input;
  return parseSimScenarioInput({ ...input, interactions: [...input.interactions, ...restorations] });
}

function hasLongitudinalCommandAt(
  interactions: readonly Interaction[],
  releasedInteractionId: string,
  actorId: string,
  time: number,
): boolean {
  return interactions.some(
    (candidate) =>
      candidate.id !== releasedInteractionId
      && candidate.actorId === actorId
      && (candidate.verb === 'speed' || candidate.verb === 'gap')
      && candidate.trigger.kind === 'at'
      && Math.abs(candidate.trigger.t - time) <= 1e-9,
  );
}

interface HopEvent {
  readonly t: number;
  readonly launchVelocityMps: number;
}

export interface PlaybackVerticalMotion {
  readonly offsetAt: (actorId: string, timeS: number) => number;
  readonly eventsByActor: ReadonlyMap<string, readonly HopEvent[]>;
}

/** Deterministic presentation motion layered over the planar evidence trace. */
export function createPlaybackVerticalMotion(
  bundle: PlaybackBundle,
  sampleHeight: (x: number, z: number) => number | null,
): PlaybackVerticalMotion {
  const mutable = new Map<string, HopEvent[]>();
  const actorById = new Map(bundle.actors.map((actor) => [actor.id, actor]));
  const times = bundle.trace.ticks.t;

  for (const event of bundle.trace.events) {
    if (event.kind !== 'collision') continue;
    const actorId = event.a.startsWith('map:') ? event.b : event.b.startsWith('map:') ? event.a : null;
    if (!actorId || !actorById.has(actorId)) continue;
    const track = bundle.trace.ticks.actors[actorId];
    if (!track) continue;
    const tick = nearestTick(times, event.t);
    const speedMps = track.speedMps[tick] ?? 0;
    addHop(mutable, actorId, {
      t: event.t,
      launchVelocityMps: clamp(0.9 + speedMps * 0.035, 0.9, 2.4),
    });
  }

  for (const actor of bundle.actors) {
    if (
      actor.static
      || actor.tags.some((tag) => tag === 'ambient' || tag.startsWith('ambient:'))
      || actor.kind === 'pedestrian'
      || actor.kind === 'animal'
      || actor.kind === 'static_object'
    ) continue;
    const track = bundle.trace.ticks.actors[actor.id];
    if (!track) continue;
    let priorHeight = sampleHeight(track.x[0]!, track.z[0]!);
    let lastEventT = Number.NEGATIVE_INFINITY;
    for (let index = 1; index < times.length; index += 1) {
      const height = sampleHeight(track.x[index]!, track.z[index]!);
      if (height === null || priorHeight === null) {
        priorHeight = height;
        continue;
      }
      const riseM = height - priorHeight;
      const distanceM = Math.hypot(
        track.x[index]! - track.x[index - 1]!,
        track.z[index]! - track.z[index - 1]!,
      );
      const timeS = times[index]!;
      if (
        riseM >= MIN_CURB_RISE_M
        && riseM <= MAX_CURB_RISE_M
        && distanceM > 1e-3
        && riseM / distanceM >= MIN_CURB_SLOPE
        && (track.speedMps[index - 1] ?? 0) > 1.5
        && timeS - lastEventT >= CURB_EVENT_COOLDOWN_S
      ) {
        addHop(mutable, actor.id, {
          t: timeS,
          launchVelocityMps: clamp(
            0.55 + riseM * 2.8 + (track.speedMps[index - 1] ?? 0) * 0.012,
            0.7,
            1.65,
          ),
        });
        lastEventT = timeS;
      }
      priorHeight = height;
    }
  }

  const eventsByActor = new Map(
    [...mutable.entries()].map(([actorId, events]) => [actorId, events.sort((a, b) => a.t - b.t)]),
  );
  return {
    eventsByActor,
    offsetAt(actorId, timeS) {
      let offsetM = 0;
      for (const event of eventsByActor.get(actorId) ?? []) {
        const elapsedS = timeS - event.t;
        if (elapsedS < 0) break;
        const flightS = (2 * event.launchVelocityMps) / GRAVITY_MPS2;
        if (elapsedS > flightS) continue;
        offsetM = Math.max(
          offsetM,
          event.launchVelocityMps * elapsedS - 0.5 * GRAVITY_MPS2 * elapsedS ** 2,
        );
      }
      return offsetM;
    },
  };
}

/** Keep the shared renderer owner while changing only trace-playback poses. */
export function withPlaybackVerticalMotion(
  renderer: ActorRenderer,
  motion: PlaybackVerticalMotion,
): ActorRenderer {
  return new Proxy(renderer, {
    get(target, property) {
      if (property === 'syncLayer') {
        return (layer: string, actors: readonly ActorView[]) => {
          target.syncLayer(layer, layer === 'playback'
            ? actors.map((actor) => ({
              ...actor,
              y: actor.y + motion.offsetAt(actor.id, actor.animationTimeS ?? 0),
            }))
            : actors);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function addHop(target: Map<string, HopEvent[]>, actorId: string, event: HopEvent): void {
  const events = target.get(actorId) ?? [];
  if (!events.some((candidate) => Math.abs(candidate.t - event.t) < 1e-3)) events.push(event);
  target.set(actorId, events);
}

function nearestTick(times: readonly number[], timeS: number): number {
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (times[middle]! < timeS) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  return Math.abs(times[low]! - timeS) < Math.abs(times[low - 1]! - timeS) ? low : low - 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Post-impact poses that override immutable trace samples before rendering. */
export class CollisionActorOverrides {
  private actors = new Map<string, ActorView>();

  replace(actors: readonly ActorView[]): void {
    this.actors = new Map(actors.map((actor) => [actor.id, actor] as const));
  }

  apply(actors: readonly ActorView[]): readonly ActorView[] {
    if (this.actors.size === 0) return actors;
    return actors.map((actor) => this.actors.get(actor.id) ?? actor);
  }

  clear(): void {
    this.actors.clear();
  }

  get size(): number {
    return this.actors.size;
  }
}

export function withCollisionActorOverrides(
  renderer: ActorRenderer,
  overrides: CollisionActorOverrides,
): ActorRenderer {
  return new Proxy(renderer, {
    get(target, property) {
      if (property === 'syncLayer') {
        return (layer: string, actors: readonly ActorView[]) => {
          target.syncLayer(layer, layer === 'playback' ? overrides.apply(actors) : actors);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
