import type { ActorRenderer, ActorView } from '@simforge/viewer';
import type { PlaybackBundle } from './model';

const RESTING_SPEED_MPS = 1e-8;

export interface RestingHeading {
  /** Held heading for a resting actor, or null when the trace is authoritative. */
  headingAt(actorId: string, timeS: number): number | null;
}

/**
 * Precompute presentation headings for zero-velocity trace samples. A moving
 * actor holds its last travelling heading while stopped; an actor that never
 * moves retains its authored pose.
 */
export function createRestingHeading(bundle: PlaybackBundle): RestingHeading {
  const times = bundle.trace.ticks.t;
  const held = new Map<string, Array<number | null>>();
  for (const [actorId, track] of Object.entries(bundle.trace.ticks.actors)) {
    const headings: Array<number | null> = [];
    let travelling: number | null = null;
    let moved = false;
    for (let at = 0; at < times.length; at += 1) {
      const speed = track.speedMps[at];
      const heading = track.headingRad[at];
      if (speed === undefined || heading === undefined) {
        headings.push(null);
      } else if (speed > RESTING_SPEED_MPS) {
        travelling = heading;
        moved = true;
        headings.push(null);
      } else {
        headings.push(moved ? travelling : track.headingRad[0] ?? null);
      }
    }
    if (moved) held.set(actorId, headings);
  }

  return {
    headingAt(actorId, timeS) {
      const headings = held.get(actorId);
      if (!headings || times.length === 0) return null;
      const upper = bracketIndex(times, timeS);
      return headings[upper - 1] ?? headings[upper] ?? null;
    },
  };
}

function bracketIndex(times: readonly number[], timeS: number): number {
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle]! < timeS) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

/** Substitute one actor's held presentation heading when needed. */
export function applyRestingHeading<T extends Pick<ActorView, 'id' | 'headingRad' | 'animationTimeS'>>(
  actor: T,
  resting: RestingHeading,
): T {
  const heading = resting.headingAt(actor.id, actor.animationTimeS ?? 0);
  return heading === null || heading === actor.headingRad
    ? actor
    : { ...actor, headingRad: heading };
}

/** Wrap only the playback renderer layer with resting-heading presentation. */
export function withRestingHeading(
  renderer: ActorRenderer,
  resting: RestingHeading,
): ActorRenderer {
  return new Proxy(renderer, {
    get(target, property) {
      if (property === 'syncLayer') {
        return (layer: string, actors: readonly ActorView[]) => {
          target.syncLayer(
            layer,
            layer === 'playback' ? actors.map((actor) => applyRestingHeading(actor, resting)) : actors,
          );
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
