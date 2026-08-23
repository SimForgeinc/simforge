/**
 * Static timing analysis — what the validator can know about *when* things
 * happen before anything has been simulated.
 *
 * Three answers are possible for a trigger, and keeping them distinct is the
 * whole trick:
 *
 * - **exact** — `at(3.5)`, or `after(x, 1)` where `x` is itself exact, or an
 *   expression over parameters at their declared defaults. Two exact times can
 *   be compared, so ordering is decidable.
 * - **window** — `when(cond, byLatest: 12)` fires *somewhere* in `[clipStart,
 *   12]`, or never. The bound is real information: it is why `byLatest` is
 *   mandatory.
 * - **unknown** — an arrival solve, or an expression that reads a site fact.
 *   Modelled as the widest window, `[clipStart, clipEnd]`.
 *
 * Everything downstream (one-axis-one-owner, out-of-clip triggers, event order)
 * is built on this, and every rule is written so that *indeterminacy never
 * produces an error* — at worst a warning. A static analyser that fails a
 * template because it could not see far enough is a static analyser people
 * turn off.
 */

import { evaluateExpr, ExpressionError, type ExprScope } from '../expr/index.js';
import {
  interactionAxis,
  type Axis,
  type Interaction,
  type Trigger,
} from '../schema/v2/interactions.js';

/** What the analyser managed to work out about a moment in time. */
export type TimeBound =
  | { kind: 'exact'; t: number }
  | { kind: 'window'; earliest: number; latest: number };

/** Inputs the analysis needs beyond the interactions themselves. */
export interface TimingContext {
  /** Earliest instant a trigger may reference: `-warmupSeconds`. */
  clipStart: number;
  /** Last recorded instant: `clipSeconds`. */
  clipEnd: number;
  /** Scope for evaluating time expressions (params at defaults, `clip.seconds`). */
  scope: ExprScope;
  /** Interactions by id, for `after` chains. */
  byId: ReadonlyMap<string, Interaction>;
}

/** The widest possible window. */
export function fullWindow(ctx: TimingContext): TimeBound {
  return { kind: 'window', earliest: ctx.clipStart, latest: ctx.clipEnd };
}

/** Earliest instant a bound can denote. */
export function earliestOf(bound: TimeBound): number {
  return bound.kind === 'exact' ? bound.t : bound.earliest;
}

/** Latest instant a bound can denote. */
export function latestOf(bound: TimeBound): number {
  return bound.kind === 'exact' ? bound.t : bound.latest;
}

function evalTime(value: number | object, ctx: TimingContext): number | undefined {
  try {
    return evaluateExpr(value as never, ctx.scope);
  } catch (error) {
    if (error instanceof ExpressionError) return undefined;
    /* c8 ignore next */
    throw error;
  }
}

/**
 * Resolve a trigger to a {@link TimeBound}.
 *
 * `visiting` guards `after` cycles: a cyclic chain resolves to the full window
 * rather than recursing, and the cycle itself is reported separately by the
 * structural pass.
 */
export function resolveTriggerTime(
  trigger: Trigger,
  ctx: TimingContext,
  visiting: ReadonlySet<string> = new Set(),
): TimeBound {
  switch (trigger.kind) {
    case 'at': {
      const t = evalTime(trigger.t, ctx);
      return t === undefined ? fullWindow(ctx) : { kind: 'exact', t };
    }
    case 'when': {
      const byLatest = trigger.byLatest === undefined ? undefined : evalTime(trigger.byLatest, ctx);
      return {
        kind: 'window',
        earliest: ctx.clipStart,
        latest: byLatest === undefined ? ctx.clipEnd : byLatest,
      };
    }
    case 'arrival':
      // Back-solved at bind time; nothing static to say about when it lands.
      return fullWindow(ctx);
    case 'after': {
      if (visiting.has(trigger.of)) return fullWindow(ctx);
      const target = ctx.byId.get(trigger.of);
      if (!target) return fullWindow(ctx);
      const next = new Set(visiting);
      next.add(trigger.of);
      const base =
        trigger.event === 'end'
          ? endBound(target, ctx, next)
          : resolveTriggerTime(target.trigger, ctx, next);
      const delay = evalTime(trigger.delayS, ctx);
      if (delay === undefined) return fullWindow(ctx);
      return base.kind === 'exact'
        ? { kind: 'exact', t: base.t + delay }
        : { kind: 'window', earliest: base.earliest + delay, latest: base.latest + delay };
    }
  }
}

/**
 * When an interaction stops owning its axis *by its own declaration*.
 *
 * An interaction with no `until` runs until something preempts it or the clip
 * ends; that is a fact about the neighbours, not about the interaction, so it
 * is computed in {@link axisTimeline} rather than here.
 */
export function endBound(
  interaction: Interaction,
  ctx: TimingContext,
  visiting: ReadonlySet<string> = new Set(),
): TimeBound {
  if (interaction.until) return resolveTriggerTime(interaction.until, ctx, visiting);
  const start = resolveTriggerTime(interaction.trigger, ctx, visiting);
  return { kind: 'window', earliest: earliestOf(start), latest: ctx.clipEnd };
}

/** One interaction's slot on an axis. */
export interface AxisSlot {
  interaction: Interaction;
  /** Index in `choreography.interactions`, for the issue path. */
  index: number;
  start: TimeBound;
  /** Only present when the author wrote `until`. */
  declaredEnd?: TimeBound;
}

/** Every interaction owning one axis of one actor, in start order. */
export interface AxisTimeline {
  actor: string;
  axis: Axis;
  slots: AxisSlot[];
}

/**
 * Group interactions by `(actor, axis)` and sort each group by earliest start.
 *
 * Ties keep document order, so the analysis is deterministic and an author's
 * ordering is the tiebreak they can see.
 */
export function axisTimeline(
  interactions: readonly Interaction[],
  ctx: TimingContext,
): AxisTimeline[] {
  const groups = new Map<string, AxisTimeline>();
  interactions.forEach((interaction, index) => {
    const axis = interactionAxis(interaction);
    const key = `${interaction.actor}|${axis}`;
    let group = groups.get(key);
    if (!group) {
      group = { actor: interaction.actor, axis, slots: [] };
      groups.set(key, group);
    }
    const slot: AxisSlot = {
      interaction,
      index,
      start: resolveTriggerTime(interaction.trigger, ctx),
    };
    if (interaction.until) {
      slot.declaredEnd = resolveTriggerTime(interaction.until, ctx);
    }
    group.slots.push(slot);
  });
  const out = [...groups.values()];
  for (const group of out) {
    group.slots.sort(
      (a, b) => earliestOf(a.start) - earliestOf(b.start) || a.index - b.index,
    );
  }
  // Sort the groups too: issue order must not depend on Map iteration order.
  out.sort((a, b) => a.actor.localeCompare(b.actor) || String(a.axis).localeCompare(String(b.axis)));
  return out;
}
