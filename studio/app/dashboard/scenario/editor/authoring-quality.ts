import type { ScenarioAuthoringQuality } from "@/app/lib/scenario/contracts";
import { readRenderingPreference } from "@/app/components/rendering-preference"

const MB = 1024 * 1024;

export function defaultAuthoringQuality(): ScenarioAuthoringQuality {
  return readRenderingPreference() ?? "high";
}

/**
 * Streaming budgets per authoring-quality choice.
 *
 * These live outside the surface component because three regions read them: the
 * canvas host (pixel ratio and antialias, which are construction-time viewer
 * options), the `onReady` callback (live quality, fidelity and layer
 * visibility), and the header's quality selector.
 */
export const AUTHORING_QUALITY = {
  "roads-only": {
    maxPixelRatio: 0.5,
    antialias: false,
    ultraLow: true,
    roadsOnly: true,
    vegetation: false,
    cinematicLighting: false,
    live: {
      maxPixelRatio: 0.5,
      maxScreenSpaceError: 5000,
      vegetationScreenSpaceError: 10000,
      byteBudget: 512 * MB,
      uploadBudgetMs: 0.35,
      uploadPixelsPerFrame: 128e3,
      vegetationMaxDistance: 0,
      exposure: 1,
    },
  },
  "ultra-low-3d": {
    maxPixelRatio: 0.6,
    antialias: false,
    ultraLow: true,
    roadsOnly: false,
    vegetation: false,
    cinematicLighting: false,
    live: {
      maxPixelRatio: 0.6,
      maxScreenSpaceError: 2200,
      vegetationScreenSpaceError: 10000,
      byteBudget: 640 * MB,
      uploadBudgetMs: 0.5,
      uploadPixelsPerFrame: 256e3,
      vegetationMaxDistance: 0,
      exposure: 1,
    },
  },
  minimal: {
    maxPixelRatio: 0.75,
    antialias: false,
    ultraLow: false,
    roadsOnly: false,
    vegetation: false,
    cinematicLighting: true,
    live: {
      maxPixelRatio: 0.75,
      maxScreenSpaceError: 1400,
      vegetationScreenSpaceError: 10000,
      byteBudget: 640 * MB,
      uploadBudgetMs: 0.5,
      uploadPixelsPerFrame: 256e3,
      vegetationMaxDistance: 0,
      exposure: 1,
    },
  },
  high: {
    maxPixelRatio: 2,
    antialias: true,
    ultraLow: false,
    roadsOnly: false,
    vegetation: true,
    /**
     * Generated sky, its image-based light and the sun's real shadow map. High
     * only: the shadow pass and the scattering shader are exactly the cost the
     * reduced presets exist to avoid.
     */
    cinematicLighting: true,
    live: {
      maxPixelRatio: 2,
      maxScreenSpaceError: 210,
      vegetationScreenSpaceError: 1500,
      byteBudget: 1.5 * 1024 * MB,
      uploadBudgetMs: 5,
      uploadPixelsPerFrame: 4.2e6,
      vegetationMaxDistance: 340,
      exposure: 1,
    },
  },
} as const satisfies Record<ScenarioAuthoringQuality, unknown>;

/**
 * Corner points of every actor's bounding box, for `resetCamera` to fit.
 *
 * Two points per actor (min and max corner) rather than eight: the camera fit
 * only needs the extremes, and an eight-point expansion of a 100-actor scene is
 * 800 allocations per reset.
 */
export function actorFitPoints(
  actors: readonly {
    x: number;
    y: number;
    z: number;
    dims: { l: number; w: number; h: number };
  }[],
) {
  return actors.flatMap((actor) => {
    const halfL = actor.dims.l * 0.5;
    const halfW = actor.dims.w * 0.5;
    return [
      [actor.x - halfL, actor.y, actor.z - halfW] as const,
      [actor.x + halfL, actor.y + actor.dims.h, actor.z + halfW] as const,
    ];
  });
}
