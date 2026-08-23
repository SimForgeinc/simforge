/**
 * Free-flow ("nominal") longitudinal motion — the reference the arrival solver
 * and the runway guard reason about.
 *
 * A nominal run is the actor alone on its route: it converges on its cruise
 * speed with the same first-order law the engine's default controller uses, and
 * ignores every interaction, leader, signal and conflict. That is exactly the
 * "reference actor's nominal motion" the research doc back-solves against, and
 * it makes arrival time a **monotone** function of spawn `s` — which is what
 * lets bisection be both deterministic and cheap (no full sim per probe).
 *
 * Integration starts at `t = -warmupSeconds` so the warm-up prologue is part of
 * the answer: an actor spawned below its cruise speed really does take a moment
 * to get there, and the solver accounts for it.
 */

import { clamp } from '../core/math.js';
import type { LaneGraph } from '../map/lane-graph.js';
import type { Route } from '../map/route.js';
import { isPedestrianLikeKind, type ActorKind, type Interaction } from '../schema/input.js';
import { limitsFor } from '../sim/controllers.js';
import { transitionDuration, transitionValue } from '../sim/dynamics.js';

export interface NominalActor {
  readonly kind: ActorKind;
  readonly route: Route;
  readonly startS: number;
  readonly initialSpeedMps: number;
  readonly speedFactor: number;
  readonly cruiseOverrideMps: number | null;
}

const CRUISE_GAIN = 2.0;

function cruiseAt(graph: LaneGraph, a: NominalActor, s: number): number {
  if (a.cruiseOverrideMps !== null) return a.cruiseOverrideMps;
  const pose = a.route.poseAt(s);
  if (!pose.rsl) return (isPedestrianLikeKind(a.kind) ? 1.4 : 13.4) * a.speedFactor;
  const g = graph.geometry(pose.rsl);
  return (g ? g.speedLimitMps : 13.4) * a.speedFactor;
}

export interface NominalProbe {
  /** Simulation time the actor reaches `targetS`, or `null` if it never does. */
  readonly tAtTarget: number | null;
  /** Distance covered by the end of the horizon. */
  readonly distanceM: number;
  /** Speed at the horizon. */
  readonly finalSpeedMps: number;
}

/**
 * Integrate free-flow motion from `-warmupSeconds` and report when the actor
 * passes `targetS` (linear interpolation inside the crossing tick).
 */
export function nominalRun(
  graph: LaneGraph,
  a: NominalActor,
  targetS: number | null,
  opts: { dt: number; warmupSeconds: number; horizonSeconds: number; boundByRoute?: boolean },
): NominalProbe {
  const boundByRoute = opts.boundByRoute ?? true;
  const lim = limitsFor(a);
  let v = a.initialSpeedMps;
  let s = a.startS;
  let t = -opts.warmupSeconds;
  const end = opts.horizonSeconds;
  if (targetS !== null && s >= targetS) {
    return { tAtTarget: t, distanceM: 0, finalSpeedMps: v };
  }
  const steps = Math.ceil((end + opts.warmupSeconds) / opts.dt);
  for (let i = 0; i < steps; i++) {
    const target = cruiseAt(graph, a, s);
    const accel = clamp((target - v) * CRUISE_GAIN, -lim.brakeComfort, lim.accelMax);
    const vNext = Math.max(0, v + accel * opts.dt);
    const sNext = s + vNext * opts.dt;
    if (targetS !== null && sNext >= targetS) {
      const span = sNext - s;
      const frac = span > 1e-9 ? (targetS - s) / span : 0;
      return { tAtTarget: t + frac * opts.dt, distanceM: targetS - a.startS, finalSpeedMps: vNext };
    }
    if (boundByRoute && sNext >= a.route.lengthM) {
      return { tAtTarget: null, distanceM: a.route.lengthM - a.startS, finalSpeedMps: vNext };
    }
    v = vNext;
    s = sNext;
    t += opts.dt;
  }
  return { tAtTarget: null, distanceM: s - a.startS, finalSpeedMps: v };
}

/** Distance a nominal actor covers within the clip — the runway guard's need. */
export function nominalRunwayNeedM(
  graph: LaneGraph,
  a: NominalActor,
  opts: { dt: number; warmupSeconds: number; clipSeconds: number },
): number {
  const probe = nominalRun(graph, a, null, {
    dt: opts.dt,
    warmupSeconds: opts.warmupSeconds,
    horizonSeconds: opts.clipSeconds,
    boundByRoute: false,
  });
  return probe.distanceM;
}

interface ScheduledSpeedAction {
  readonly interaction: Interaction & { verb: 'speed' };
  readonly fireT: number;
}

interface TriggerBounds {
  readonly earliest: number;
  readonly latest: number;
}

/** Earliest/latest time an interaction may fire in the recorded clip. */
function triggerBounds(
  interaction: Interaction,
  byId: ReadonlyMap<string, Interaction>,
  visiting = new Set<string>(),
): TriggerBounds {
  if (visiting.has(interaction.id)) return { earliest: 0, latest: Infinity };
  const trigger = interaction.trigger;
  if (trigger.kind === 'at') return { earliest: Math.max(0, trigger.t), latest: Math.max(0, trigger.t) };
  if (trigger.kind === 'arrival') return { earliest: 0, latest: Infinity };
  if (trigger.kind === 'when') {
    return {
      earliest: 0,
      latest: trigger.ifNever === 'fire' ? Math.max(0, trigger.byLatest) : Infinity,
    };
  }
  const parent = byId.get(trigger.interactionId);
  if (!parent) return { earliest: 0, latest: Infinity };
  const next = new Set(visiting);
  next.add(interaction.id);
  const bounds = triggerBounds(parent, byId, next);
  return {
    earliest: bounds.earliest + trigger.delayS,
    latest: Number.isFinite(bounds.latest) ? bounds.latest + trigger.delayS : Infinity,
  };
}

function targetDirection(
  action: Interaction & { verb: 'speed' },
  referenceSpeedMps: number,
): 'up' | 'down' | 'unknown' {
  switch (action.target.mode) {
    case 'absolute':
      return action.target.value >= referenceSpeedMps ? 'up' : 'down';
    case 'match':
      return 'unknown';
    case 'delta':
      return action.target.value >= 0 ? 'up' : 'down';
    case 'factor':
      return action.target.value >= 1 ? 'up' : 'down';
    case 'stop':
      return 'down';
  }
}

function speedTarget(action: Interaction & { verb: 'speed' }, speedMps: number): number | null {
  switch (action.target.mode) {
    case 'absolute': return action.target.value;
    case 'delta': return Math.max(0, speedMps + action.target.value);
    case 'factor': return Math.max(0, speedMps * action.target.value);
    case 'stop': return 0;
    case 'match': return null;
  }
}

/**
 * Conservative whole-clip distance envelope with authored speed actions.
 *
 * Speed increases fire at their earliest possible time; guaranteed speed
 * decreases fire at their latest possible time. This is an upper distance
 * bound, while still respecting transition profiles and semantic class
 * acceleration/braking limits. Uncertain decreases and match() commands are
 * ignored rather than used to weaken the runway guard.
 */
export function actionAwareRunwayNeedM(
  graph: LaneGraph,
  a: NominalActor,
  actorId: string,
  interactions: readonly Interaction[],
  opts: { dt: number; warmupSeconds: number; clipSeconds: number },
): number {
  const actorInteractions = interactions.filter((entry) => entry.actorId === actorId);
  if (actorInteractions.length === 0) return nominalRunwayNeedM(graph, a, opts);
  const byId = new Map(interactions.map((entry) => [entry.id, entry]));
  const scheduled: ScheduledSpeedAction[] = [];
  const referenceSpeedMps = Math.max(a.initialSpeedMps, cruiseAt(graph, a, a.startS));
  for (const entry of actorInteractions) {
    if (entry.verb !== 'speed') continue;
    const bounds = triggerBounds(entry, byId);
    const direction = targetDirection(entry, referenceSpeedMps);
    if (direction === 'unknown') continue;
    const fireT = direction === 'up' ? bounds.earliest : bounds.latest;
    if (!Number.isFinite(fireT) || fireT > opts.clipSeconds) continue;
    scheduled.push({ interaction: entry, fireT });
  }
  scheduled.sort((x, y) => x.fireT - y.fireT || x.interaction.id.localeCompare(y.interaction.id));

  const lim = limitsFor(a);
  let v = a.initialSpeedMps;
  let s = a.startS;
  let active: { action: ScheduledSpeedAction['interaction']; from: number; target: number; startedT: number; durationS: number } | null = null;
  let eventIndex = 0;
  const totalSteps = Math.ceil((opts.warmupSeconds + opts.clipSeconds) / opts.dt);
  for (let step = 0; step < totalSteps; step++) {
    const t = -opts.warmupSeconds + step * opts.dt;
    if (t >= 0) {
      while (eventIndex < scheduled.length && scheduled[eventIndex]!.fireT <= t + 1e-9) {
        const event = scheduled[eventIndex++]!;
        const target = speedTarget(event.interaction, v);
        if (target !== null) {
          active = {
            action: event.interaction,
            from: v,
            target,
            startedT: event.fireT,
            durationS: transitionDuration(event.interaction.dynamics, target - v, Math.max(v, 0.1)),
          };
        }
      }
    }
    const target = active
      ? transitionValue(active.action.dynamics, active.from, active.target, t + opts.dt - active.startedT, active.durationS)
      : cruiseAt(graph, a, s);
    const accel = clamp((target - v) / opts.dt, -lim.brakeHard, lim.accelMax);
    v = Math.max(0, v + accel * opts.dt);
    s += v * opts.dt;
  }
  return s - a.startS;
}
