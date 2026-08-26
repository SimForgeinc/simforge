/**
 * Reward and termination assembly.
 *
 * Dense shaping derives from quantities the engine exposes per tick (route
 * progress, longitudinal acceleration, inter-actor clearance); terminal terms
 * come from the engine's own event stream. Weights are **provisional** (see
 * `RewardConfig`) and live in one config object so Phase 3 can retune without
 * touching semantics.
 */

import type { SessionPairMinima, SessionActorSnapshot, SimEvent } from '@simforge-oss/engine';

import type { RewardConfig } from './types.js';

export interface RewardTerms {
  /** Terminal collision penalty (present only when a collision occurred). */
  collision?: number;
  /** Terminal goal bonus (present only when the goal was met). */
  goal?: number;
  /** Route progress term. */
  progress: number;
  /** Proximity penalty across nearby actors. */
  proximity: number;
  /** Acceleration comfort penalty. */
  comfort: number;
}

export interface RewardContext {
  readonly config: RewardConfig;
  readonly egoId: string;
  readonly actors: readonly SessionActorSnapshot[];
  readonly minima: readonly SessionPairMinima[];
  readonly events: readonly SimEvent[];
  readonly goal: { interactionId?: string; routeEnd?: boolean } | undefined;
  readonly dtS: number;
  /** Ego route arc length at the previous decision; `null` on the first step. */
  readonly prevEgoS: number | null;
}

export interface RewardOutcome {
  readonly total: number;
  readonly terms: RewardTerms;
  readonly collision: boolean;
  readonly goal: boolean;
}

function collisionInvolvingEgo(events: readonly SimEvent[], egoId: string): boolean {
  return events.some((e) => e.kind === 'collision' && (e.a === egoId || e.b === egoId));
}

function goalMet(
  events: readonly SimEvent[],
  egoId: string,
  goal: { interactionId?: string; routeEnd?: boolean } | undefined,
): boolean {
  if (!goal) return false;
  if (goal.interactionId !== undefined) {
    const fired = events.some((e) => e.kind === 'trigger_fired' && e.interactionId === goal.interactionId);
    if (!fired) return false;
  }
  if (goal.routeEnd === true) {
    return events.some((e) => e.kind === 'despawn' && e.actorId === egoId && e.reason === 'route_end');
  }
  return true;
}

export function assembleReward(ctx: RewardContext): RewardOutcome {
  const cfg = ctx.config;
  const sorted = [...ctx.actors].sort((a, b) => (a.id < b.id ? -1 : 1));
  const ego = sorted.find((a) => a.id === ctx.egoId);
  if (!ego) throw new Error(`ego actor ${ctx.egoId} missing from snapshot`);

  const collision = collisionInvolvingEgo(ctx.events, ctx.egoId);
  const goal = goalMet(ctx.events, ctx.egoId, ctx.goal);

  let progress = 0;
  if (ctx.prevEgoS !== null) progress = cfg.progressWeight * (ego.s - ctx.prevEgoS);

  let proximity = 0;
  for (const a of sorted) {
    if (a.id === ctx.egoId) continue;
    const d = Math.hypot(a.x - ego.x, a.y - ego.y);
    if (d >= cfg.proximityRangeM) continue;
    // Exponential falloff with a 5 m decay length: cheap, smooth, monotone.
    proximity += Math.exp(-d / 5);
  }
  proximity *= cfg.proximityWeight;

  const comfort = cfg.comfortAccelWeight * Math.abs(ego.accelMps2) * ctx.dtS;

  const terms: RewardTerms = {
    progress,
    proximity: -proximity,
    comfort: -comfort,
    ...(collision ? { collision: cfg.collisionPenalty } : {}),
    ...(goal ? { goal: cfg.goalBonus } : {}),
  };

  const total =
    (terms.collision ?? 0) + (terms.goal ?? 0) + terms.progress + terms.proximity + terms.comfort;
  return { total, terms, collision, goal };
}
