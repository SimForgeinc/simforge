import type { Interaction } from '@simforge-oss/scenario';

/**
 * How far a placeholder's points may sit from the scene origin, in metres.
 *
 * Deliberately a float-noise tolerance rather than a human-scale radius. The
 * catalog emits its points at exactly the origin, so nothing wider is needed to
 * recognise one — and anything wider destroys real authoring. A five-centimetre
 * radius, the figure the editors use to ask "has the author drawn this yet?",
 * swallows a genuine five-centimetre pedestrian step taken near the origin and
 * flattens that route onto its actor.
 */
export const ROUTE_PLACEHOLDER_EPSILON_M = 1e-6;

/** Ground-plane position, in scene metres, a placeholder route is seeded on. */
export interface RouteAnchor {
  readonly x: number;
  readonly z: number;
}

/**
 * True when a custom route still holds catalog geometry rather than a path.
 *
 * The two route kinds need different tests, because repeated points mean
 * different things in each:
 *
 * - `customRoute` has no time axis, so stacking points on one spot expresses
 *   nothing an author would want. A route with no extent is undrawn wherever it
 *   sits, and the schema's two-point minimum is the only reason it has a second
 *   point at all.
 * - `customTimedRoute` interpolates between keyframes, so two coincident points
 *   at different times is a real instruction — hold here. Only the catalog's
 *   signature counts as undrawn there: every point still on the scene origin.
 *
 * A drawn path covers ground either way, so neither test can mistake one.
 */
export function isRoutePlaceholder(interaction: Interaction): boolean {
  if (interaction.verb !== 'route') return false;
  const { target } = interaction;
  if (target.mode !== 'customRoute' && target.mode !== 'customTimedRoute') return false;
  const points: readonly { x: number; z: number }[] = target.points;
  const first = points[0];
  if (!first) return false;
  const withoutExtent = points.every(
    (point) => Math.hypot(point.x - first.x, point.z - first.z) <= ROUTE_PLACEHOLDER_EPSILON_M,
  );
  if (!withoutExtent) return false;
  if (target.mode === 'customRoute') return true;
  return Math.hypot(first.x, first.z) <= ROUTE_PLACEHOLDER_EPSILON_M;
}

/**
 * Move an unconfigured custom route onto the actor that will drive it.
 *
 * A catalog placeholder committed unchanged is not a placeholder at all but a
 * world path to the middle of the map: a timed route pins the actor there at
 * t=0, an untimed one drives it the whole way. Anything already authored, and
 * any interaction whose actor has no resolved pose, is returned untouched.
 *
 * Point count and per-point timing are preserved, so a timed placeholder keeps
 * its keyframes and only its position changes.
 */
export function routePlaceholderOnActor(
  interaction: Interaction,
  anchor: RouteAnchor | undefined,
): Interaction {
  if (!anchor || !isRoutePlaceholder(interaction)) return interaction;
  const target = interaction.target as { mode: string; points: readonly { x: number; z: number }[] };
  const x = Number(anchor.x.toFixed(3));
  const z = Number(anchor.z.toFixed(3));
  return {
    ...interaction,
    target: { ...target, points: target.points.map((point) => ({ ...point, x, z })) },
  } as Interaction;
}
