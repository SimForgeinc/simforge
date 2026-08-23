import type { ActorRenderer, ActorView } from "@simforge/viewer";

export const SUMO_VISUAL_INTERPOLATION_SECONDS = 0.1;

interface AnimationClock {
  readonly now: () => number;
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly cancelFrame: (handle: number) => void;
}

const browserClock: AnimationClock = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
};

/**
 * Keeps SUMO's discrete, deterministic state while presenting its actor layer
 * at the browser's display cadence. The small snapshot delay absorbs normal
 * worker jitter and avoids extrapolating vehicles into invalid road positions.
 */
export class SumoMotionSmoother {
  private from: readonly ActorView[] = [];
  private target: readonly ActorView[] = [];
  private startedAt = 0;
  private durationMs = 0;
  private frame: number | null = null;
  private disposed = false;

  constructor(
    private readonly renderer: ActorRenderer,
    private readonly clock: AnimationClock = browserClock,
  ) {}

  snap(actors: readonly ActorView[]): void {
    this.cancelPendingFrame();
    this.from = actors;
    this.target = actors;
    this.durationMs = 0;
    if (!this.disposed) this.renderer.syncLayer("sumo-traffic", actors);
  }

  transition(
    actors: readonly ActorView[],
    durationSeconds = SUMO_VISUAL_INTERPOLATION_SECONDS,
  ): void {
    if (this.disposed) return;
    const now = this.clock.now();
    this.from = this.sample(now);
    this.target = actors;
    this.startedAt = now;
    this.durationMs = Math.max(1, durationSeconds * 1_000);
    this.cancelPendingFrame();
    this.render(now);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPendingFrame();
  }

  private sample(now: number): readonly ActorView[] {
    if (this.durationMs <= 0) return this.target;
    const alpha = Math.min(1, Math.max(0, (now - this.startedAt) / this.durationMs));
    return interpolateSumoActorViews(this.from, this.target, alpha);
  }

  private render = (now: number): void => {
    if (this.disposed) return;
    const actors = this.sample(now);
    this.renderer.syncLayer("sumo-traffic", actors);
    if (now - this.startedAt >= this.durationMs) {
      this.from = this.target;
      this.durationMs = 0;
      this.frame = null;
      return;
    }
    this.frame = this.clock.requestFrame(this.render);
  };

  private cancelPendingFrame(): void {
    if (this.frame === null) return;
    this.clock.cancelFrame(this.frame);
    this.frame = null;
  }
}

export function interpolateSumoActorViews(
  from: readonly ActorView[],
  target: readonly ActorView[],
  alpha: number,
): readonly ActorView[] {
  const boundedAlpha = Math.min(1, Math.max(0, alpha));
  const fromById = new Map(from.map((actor) => [actor.id, actor] as const));
  return target.map((actor) => {
    const previous = fromById.get(actor.id);
    if (!previous) return actor;
    return {
      ...actor,
      x: lerp(previous.x, actor.x, boundedAlpha),
      y: lerp(previous.y, actor.y, boundedAlpha),
      z: lerp(previous.z, actor.z, boundedAlpha),
      headingRad: interpolateRadians(
        previous.headingRad,
        actor.headingRad,
        boundedAlpha,
      ),
      speedMps:
        previous.speedMps === undefined || actor.speedMps === undefined
          ? actor.speedMps
          : lerp(previous.speedMps, actor.speedMps, boundedAlpha),
    };
  });
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

function interpolateRadians(from: number, to: number, alpha: number): number {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return Math.atan2(
    Math.sin(from + delta * alpha),
    Math.cos(from + delta * alpha),
  );
}
