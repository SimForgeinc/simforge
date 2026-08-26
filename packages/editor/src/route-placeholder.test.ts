import { describe, expect, it } from 'vitest';
import type { Interaction } from '@simforge-oss/scenario';

import { actionsForActor, interactionForAction } from './timeline-actions';
import { isRoutePlaceholder, routePlaceholderOnActor } from './route-placeholder';

const ANCHOR = { x: 412.3456, z: -87.6543 };

function catalogRoute(id: 'custom_route' | 'custom_timed_route'): Interaction {
  const definition = actionsForActor('car').find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`${id} is missing from the vehicle catalog`);
  return interactionForAction(definition, 'car', 0, 1);
}

describe('custom route placeholders', () => {
  // The regression these guard. The catalog used to span a metre, which cleared
  // the 0.05 m coincidence test every "has the author drawn this yet?" check
  // relies on, so an undrawn route read as a finished world path at the map
  // origin and playback dragged the actor off its spawn.
  it.each(['custom_route', 'custom_timed_route'] as const)(
    'ships %s with every point on the origin',
    (id) => {
      const interaction = catalogRoute(id);
      expect(isRoutePlaceholder(interaction)).toBe(true);
    },
  );

  it.each(['custom_route', 'custom_timed_route'] as const)(
    'seeds %s onto the actor',
    (id) => {
      const seeded = routePlaceholderOnActor(catalogRoute(id), ANCHOR);
      const points = (seeded.target as { points: { x: number; z: number }[] }).points;
      // One point is the whole placeholder: the actor stands where it is until
      // the author draws somewhere to go.
      expect(points).toHaveLength(1);
      for (const point of points) {
        expect(point.x).toBe(412.346);
        expect(point.z).toBe(-87.654);
      }
    },
  );

  it('preserves the keyframes of a timed placeholder', () => {
    const seeded = routePlaceholderOnActor(catalogRoute('custom_timed_route'), ANCHOR);
    const points = (seeded.target as { points: { timeS: number }[] }).points;
    expect(points.map((point) => point.timeS)).toEqual([0]);
  });

  // Seeding must not collapse an author's dwell into one keyframe.
  it('keeps every keyframe of a multi-point timed placeholder', () => {
    const stacked = {
      ...catalogRoute('custom_timed_route'),
      target: {
        mode: 'customTimedRoute',
        points: [{ timeS: 0, x: 0, z: 0 }, { timeS: 2, x: 0, z: 0 }],
      },
    } as Interaction;
    const points = (routePlaceholderOnActor(stacked, ANCHOR).target as {
      points: { timeS: number; x: number }[];
    }).points;
    expect(points.map((point) => point.timeS)).toEqual([0, 2]);
    expect(points.every((point) => point.x === 412.346)).toBe(true);
  });

  it('leaves a drawn path alone', () => {
    const drawn = {
      ...catalogRoute('custom_route'),
      target: { mode: 'customRoute', points: [{ x: 10, z: 0 }, { x: 40, z: 12 }] },
    } as Interaction;
    expect(isRoutePlaceholder(drawn)).toBe(false);
    expect(routePlaceholderOnActor(drawn, ANCHOR)).toBe(drawn);
  });

  // Time owns motion in a timed route, so two keyframes on one spot is an
  // instruction — wait here — not an unfinished route.
  it('leaves a timed hold away from the origin alone', () => {
    const hold = {
      ...catalogRoute('custom_timed_route'),
      target: {
        mode: 'customTimedRoute',
        points: [{ timeS: 0, x: 50, z: 30 }, { timeS: 1, x: 50, z: 30 }],
      },
    } as Interaction;
    expect(isRoutePlaceholder(hold)).toBe(false);
    expect(routePlaceholderOnActor(hold, ANCHOR)).toBe(hold);
  });

  // An untimed route has no time axis, so stacked points cannot mean a dwell.
  // A route with no extent is undrawn wherever it sits.
  it('treats an untimed route with no extent as undrawn wherever it sits', () => {
    const stacked = {
      ...catalogRoute('custom_route'),
      target: { mode: 'customRoute', points: [{ x: 50, z: 30 }, { x: 50, z: 30 }] },
    } as Interaction;
    expect(isRoutePlaceholder(stacked)).toBe(true);
    const seeded = routePlaceholderOnActor(stacked, ANCHOR);
    for (const point of (seeded.target as { points: { x: number; z: number }[] }).points) {
      expect(point).toEqual({ x: 412.346, z: -87.654 });
    }
  });

  // A five-centimetre step is a real authored move, and it is exactly the size
  // the editors' "has the author drawn this yet?" radius uses. Reusing that
  // radius here flattened such a route onto its actor and lost the step.
  it('keeps a small authored step near the origin', () => {
    const step = {
      ...catalogRoute('custom_timed_route'),
      target: {
        mode: 'customTimedRoute',
        points: [{ timeS: 0, x: 0, z: 0 }, { timeS: 1, x: 0.05, z: 0 }],
      },
    } as Interaction;
    expect(isRoutePlaceholder(step)).toBe(false);
    expect(routePlaceholderOnActor(step, ANCHOR)).toBe(step);
  });

  it('leaves the placeholder alone when the actor has no resolved pose', () => {
    const placeholder = catalogRoute('custom_timed_route');
    expect(routePlaceholderOnActor(placeholder, undefined)).toBe(placeholder);
  });

  it('ignores interactions that are not custom routes', () => {
    const stop = {
      id: 'stop',
      actor: 'car',
      trigger: { kind: 'at', t: 1 },
      until: { kind: 'at', t: 2 },
      verb: 'speed',
      target: { mode: 'stop' },
      dynamics: { shape: 'step', constraint: 'time', value: 0 },
    } as Interaction;
    expect(isRoutePlaceholder(stop)).toBe(false);
    expect(routePlaceholderOnActor(stop, ANCHOR)).toBe(stop);
  });
});
