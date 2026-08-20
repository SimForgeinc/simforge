/**
 * Trigger evaluation.
 *
 * Every interaction fires **at most once** and is **edge triggered**: a `when`
 * whose condition is already true at `t = 0` fires on the first tick, and one
 * that goes true→false→true fires only on the first rising edge.
 *
 * `byLatest` is mandatory on `when` (the research doc's rule — a never-firing
 * condition is a silent bug). At `t > byLatest` an unfired trigger resolves per
 * `ifNever`: `skip` retires it and records it in `metrics.triggerNeverFired`;
 * `fire` fires it at `byLatest` and records the forcing in the event log.
 *
 * Triggers are only evaluated for `t ≥ 0` — the warm-up prologue exists to let
 * controllers converge, not to run choreography.
 */

import { localFromScene } from '../frames.js';
import { pointInPolygon, type Vec2 } from '../core/math.js';
import type { Condition, Interaction, Region } from '../schema/input.js';
import type { SignalBook } from './signals.js';
import { hasLineOfSight, type OccluderShape } from './visibility.js';
import { headwayS, pairKey, readPair, alongRouteGapM } from './pairs.js';
import type { ActorRuntime, WorldState } from './state.js';

export interface ConditionContext {
  readonly t: number;
  readonly world: WorldState;
  readonly signals: SignalBook;
  readonly occluders: readonly OccluderShape[];
  readonly visibilityRangeM: number;
  /** Pair keys colliding on this tick. */
  readonly collisions: ReadonlySet<string>;
  /**
   * The tick's perception state, present only when some actor declares a
   * sensor. `visible` stays pure geometry; `detected` asks this.
   */
  readonly perception?: PerceptionQuery;
}

/** The read-back surface the `detected` condition needs. */
export interface PerceptionQuery {
  detects(observer: string, target: string, sensorId?: string): boolean;
  hasSensor(observer: string, sensorId?: string): boolean;
}

function actor(ctx: ConditionContext, id: string): ActorRuntime | undefined {
  const a = ctx.world.byId.get(id);
  return a && a.present && !a.retired ? a : undefined;
}

function compare(cmp: 'lte' | 'gte', value: number, threshold: number): boolean {
  return cmp === 'lte' ? value <= threshold : value >= threshold;
}

function inRegion(ctx: ConditionContext, a: ActorRuntime, region: Region): boolean {
  switch (region.kind) {
    case 'circle': {
      const c = localFromScene(region.center);
      return Math.hypot(a.position.x - c.x, a.position.y - c.y) <= region.radiusM;
    }
    case 'polygon': {
      const poly: Vec2[] = region.points.map(localFromScene);
      return pointInPolygon(a.position, poly);
    }
    case 'laneWindow': {
      const pose = a.route.poseAt(a.routeS);
      if (pose.rsl !== region.rsl) return false;
      return pose.laneS >= region.sMin && pose.laneS <= region.sMax;
    }
  }
}

export function evaluateCondition(ctx: ConditionContext, cond: Condition): boolean {
  switch (cond.kind) {
    case 'and':
      return cond.of.every((c) => evaluateCondition(ctx, c));
    case 'or':
      return cond.of.some((c) => evaluateCondition(ctx, c));
    case 'not':
      return !evaluateCondition(ctx, cond.of);
    case 'distance': {
      const a = actor(ctx, cond.a);
      const b = actor(ctx, cond.b);
      if (!a || !b) return false;
      const threshold = cond.cmp === 'lte'
        ? Math.max(0, cond.value - (cond.hysteresis ?? 0))
        : cond.value + (cond.hysteresis ?? 0);
      if (cond.mode === 'euclidean') {
        return compare(cond.cmp, readPair(a, b).gapM, threshold);
      }
      const gap = alongRouteGapM(a, b);
      if (gap === null) return false;
      return compare(cond.cmp, Math.abs(gap), threshold);
    }
    case 'ttc': {
      const a = actor(ctx, cond.a);
      const b = actor(ctx, cond.b);
      if (!a || !b) return false;
      const ttc = readPair(a, b).ttcS;
      // Missing, parallel and diverging trajectories have no collision time.
      // Fail closed for both comparison directions: "TTC >= N" must not turn
      // an undefined/infinite TTC into an actor command.
      if (!Number.isFinite(ttc)) return false;
      return compare(cond.cmp, ttc, cond.value);
    }
    case 'headway': {
      const a = actor(ctx, cond.a);
      const b = actor(ctx, cond.b);
      if (!a || !b) return false;
      const h = headwayS(a, b);
      if (h === null) return false;
      if (!Number.isFinite(h)) return cond.cmp === 'gte';
      return compare(cond.cmp, h, cond.value);
    }
    case 'reaches': {
      const a = actor(ctx, cond.actorId);
      return a ? inRegion(ctx, a, cond.region) : false;
    }
    case 'speed': {
      const a = actor(ctx, cond.actorId);
      return a ? compare(cond.cmp, a.speedMps, cond.value) : false;
    }
    case 'standstill': {
      const a = actor(ctx, cond.actorId);
      if (!a || a.standstillSinceS === null) return false;
      return ctx.t - a.standstillSinceS >= cond.durationS;
    }
    case 'signal':
      return ctx.signals.phaseAt(cond.signalId, ctx.t) === cond.phase;
    case 'collision': {
      if (cond.a !== undefined && cond.b !== undefined) {
        return ctx.collisions.has(pairKey(cond.a, cond.b));
      }
      const only = cond.a ?? cond.b;
      if (only === undefined) return ctx.collisions.size > 0;
      for (const key of ctx.collisions) {
        const [x, y] = key.split('|');
        if (x === only || y === only) return true;
      }
      return false;
    }
    case 'visible': {
      const a = actor(ctx, cond.a);
      const b = actor(ctx, cond.to);
      if (!a || !b) return false;
      const los = hasLineOfSight(b.position, a.position, ctx.occluders, ctx.visibilityRangeM);
      return los === cond.value;
    }
    case 'detected': {
      // Fail closed in both directions. Without a perception pass there is no
      // evidence either way, and turning "no answer" into "not detected" would
      // silently fire every `detected(..., value: false)` trigger in the clip.
      if (!ctx.perception) return false;
      const observer = actor(ctx, cond.by);
      // The *target* is checked for presence only, not for `retired`. `retired`
      // means route/interaction motion has finished, not that the body left the
      // world — a pedestrian stays at her terminal pose. Perception reports
      // what is physically there, so requiring `!retired` here would make
      // `detected` disagree with the channel the trace recorded.
      const target = ctx.world.byId.get(cond.a);
      if (!observer || !target || !target.present) return false;
      if (!ctx.perception.hasSensor(cond.by, cond.sensor)) return false;
      return ctx.perception.detects(cond.by, cond.a, cond.sensor) === cond.value;
    }
  }
}

export type TriggerStatus = 'pending' | 'fired' | 'skipped';

export interface TriggerRuntime {
  readonly interaction: Interaction;
  status: TriggerStatus;
  /** Simulation time the interaction fired. */
  firedAt: number | null;
  /** Simulation time the declared clip/command completed. */
  endedAt: number | null;
  /** `true` when `ifNever: 'fire'` forced it at `byLatest`. */
  forced: boolean;
  /** Resolved absolute time for `at` / solved `arrival` triggers. */
  readonly fixedTime: number | null;
}

export function makeTriggerRuntime(interaction: Interaction): TriggerRuntime {
  return {
    interaction,
    status: 'pending',
    firedAt: null,
    endedAt: null,
    forced: false,
    fixedTime: interaction.trigger.kind === 'at' ? interaction.trigger.t : null,
  };
}

/**
 * Truth value of the authored trigger predicate at this tick, independent of
 * eligibility windows, forced deadlines, and route-commit delays.  Recording
 * this separately is what lets an external runtime distinguish "condition
 * became true" from "the action happened to start".
 */
export function triggerPredicateValue(
  ctx: ConditionContext,
  tr: TriggerRuntime,
  byId: ReadonlyMap<string, TriggerRuntime>,
): boolean {
  const trigger = tr.interaction.trigger;
  switch (trigger.kind) {
    case 'at':
    case 'arrival':
      return tr.fixedTime !== null && ctx.t >= tr.fixedTime - 1e-9;
    case 'after': {
      const ref = byId.get(trigger.interactionId);
      if (!ref || ref.status === 'skipped') return false;
      const referenceTime = trigger.event === 'end' ? ref.endedAt : ref.firedAt;
      return referenceTime !== null && ctx.t >= referenceTime + trigger.delayS - 1e-9;
    }
    case 'when':
      return evaluateCondition(ctx, trigger.condition);
  }
}

/**
 * Decide whether a pending trigger fires on this tick. Only `pending` triggers
 * are ever passed here, so "first tick at or past the time" is the whole rule —
 * no edge bookkeeping is needed for time-based kinds.
 */
export function shouldFire(
  ctx: ConditionContext,
  tr: TriggerRuntime,
  byId: ReadonlyMap<string, TriggerRuntime>,
): { fire: boolean; forced: boolean; skip: boolean } {
  const trigger = tr.interaction.trigger;
  switch (trigger.kind) {
    case 'at':
    case 'arrival': {
      // `arrival` is resolved to a fixed time by `resolveArrivalTriggers`
      // before the run; an unresolved one never fires.
      const t = tr.fixedTime;
      if (t === null) return { fire: false, forced: false, skip: false };
      // `t + 1e-9` absorbs the float error in `(i - warmupTicks) * dt`, so a
      // trigger at exactly 5 s fires on the 5 s tick, not the one after.
      return { fire: ctx.t >= t - 1e-9, forced: false, skip: false };
    }
    case 'after': {
      const ref = byId.get(trigger.interactionId);
      if (!ref) return { fire: false, forced: false, skip: false };
      if (ref.status === 'skipped') return { fire: false, forced: false, skip: true };
      const referenceTime = trigger.event === 'end' ? ref.endedAt : ref.firedAt;
      if (referenceTime === null) return { fire: false, forced: false, skip: false };
      const target = referenceTime + trigger.delayS;
      return { fire: ctx.t >= target - 1e-9, forced: false, skip: false };
    }
    case 'when': {
      if (evaluateCondition(ctx, trigger.condition)) {
        return { fire: true, forced: false, skip: false };
      }
      if (ctx.t >= trigger.byLatest) {
        return trigger.ifNever === 'fire'
          ? { fire: true, forced: true, skip: false }
          : { fire: false, forced: false, skip: true };
      }
      return { fire: false, forced: false, skip: false };
    }
  }
}
