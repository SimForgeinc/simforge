import { z } from "zod";
import type { Environment } from "../schema/v2/environment.js";

export const SCENE_TIME_EXTENSION_KEY = "org.simforge.sceneTime.v1" as const;
export const LIGHTING_EXTENSION_KEY = "org.simforge.lighting.v1" as const;

/** Canonical clock time for every newly-authored scenario: 6:25 AM. */
export const FRESH_SCENARIO_MINUTES = 6 * 60 + 25;
/** Canonical authored visibility for every newly-authored scenario. */
export const DEFAULT_VISIBILITY_M = 200;

/**
 * Revision 2 makes the calibrated direct-sun and sky-fill levels the 100% point.
 * Revision 1 (and unversioned blocks) stored raw renderer multipliers instead.
 */
export const LIGHTING_SCALE_REVISION = 2 as const;
export const DEFAULT_SUN_RENDER_SCALE = 3;
export const DEFAULT_AMBIENT_RENDER_SCALE = 0.8;

export const LIGHTING_RANGES = {
  ambient: { min: 0, max: 5, neutral: 1, step: 0.05 },
  sun: { min: 0, max: 4, neutral: 1, step: 0.05 },
  sunWarmth: { min: -1, max: 1, neutral: 0, step: 0.02 },
  exposure: { min: 0.1, max: 3, neutral: 1, step: 0.02 },
  sky: { min: 0, max: 3, neutral: 1, step: 0.05 },
  visibilityM: { min: 20, max: 500, neutral: DEFAULT_VISIBILITY_M, step: 20 },
  haze: { min: 0, max: 1, neutral: 0, step: 0.02 },
} as const;

export type LightingField = keyof typeof LIGHTING_RANGES;

export const LIGHTING_FIELDS = [
  "ambient",
  "sun",
  "sunWarmth",
  "exposure",
  "sky",
  "visibilityM",
  "haze",
] as const satisfies readonly LightingField[];

const LegacyLightingBlockSchema = z
  .object({
    ambient: z.number().finite().optional().catch(undefined),
    sun: z.number().finite().optional().catch(undefined),
    sunWarmth: z.number().finite().optional().catch(undefined),
    exposure: z.number().finite().optional().catch(undefined),
    sky: z.number().finite().optional().catch(undefined),
    visibilityM: z.number().finite().optional().catch(undefined),
    haze: z.number().finite().optional().catch(undefined),
    scaleRevision: z.number().int().optional().catch(undefined),
  })
  .passthrough()
  .catch({});

export type EditorLightingOverrides = Readonly<{
  [Field in LightingField]?: number;
}>;

function clampField(field: LightingField, value: number): number {
  const { min, max } = LIGHTING_RANGES[field];
  return Math.min(max, Math.max(min, value));
}

/**
 * Read authored lighting in the current normalized scale.
 *
 * Compatibility reader: unversioned/pre-v2 documents stored raw renderer
 * multipliers, where sun=3 and ambient=0.8 produced today's calibrated 100%.
 * Translate those two stored values before the editor or renderer consumes
 * them so old scenarios retain byte-for-byte-equivalent engine multipliers.
 */
export function resolveEditorLightingOverrides(
  environment: Environment,
): EditorLightingOverrides {
  const parsed = LegacyLightingBlockSchema.safeParse(
    environment.extensions?.[LIGHTING_EXTENSION_KEY],
  );
  if (!parsed.success) return {};
  const currentScale = parsed.data.scaleRevision === LIGHTING_SCALE_REVISION;
  const resolved: Partial<Record<LightingField, number>> = {};
  for (const field of LIGHTING_FIELDS) {
    const stored = parsed.data[field];
    if (typeof stored !== "number") continue;
    const normalized = !currentScale && field === "sun"
      ? stored / DEFAULT_SUN_RENDER_SCALE
      : !currentScale && field === "ambient"
        ? stored / DEFAULT_AMBIENT_RENDER_SCALE
        : stored;
    resolved[field] = clampField(field, normalized);
  }
  return resolved;
}

export type EditorLightingRenderScales = EditorLightingOverrides & Readonly<{
  ambient: number;
  sun: number;
  visibilityM: number;
}>;

/** Resolve normalized authoring values into the renderer's calibrated scale. */
export function resolveEditorLightingRenderScales(
  environment: Environment,
): EditorLightingRenderScales {
  const overrides = resolveEditorLightingOverrides(environment);
  return {
    ...overrides,
    ambient: (overrides.ambient ?? 1) * DEFAULT_AMBIENT_RENDER_SCALE,
    sun: (overrides.sun ?? 1) * DEFAULT_SUN_RENDER_SCALE,
    // The visible slider default is physical state, not a lazy UI placeholder.
    // Applying it here ensures the initial mount and later slider changes agree.
    visibilityM: overrides.visibilityM ?? DEFAULT_VISIBILITY_M,
  };
}

/**
 * Write current-scale lighting while retaining unrelated extension data.
 * Touching a legacy block rewrites every known field in normalized v2 units.
 */
export function withEditorLightingOverrides(
  environment: Environment,
  patch: Readonly<Partial<Record<LightingField, number | undefined>>>,
): Environment {
  const next: Partial<Record<LightingField, number>> = {
    ...resolveEditorLightingOverrides(environment),
  };
  for (const field of LIGHTING_FIELDS) {
    if (!(field in patch)) continue;
    const requested = patch[field];
    if (requested === undefined) {
      delete next[field];
      continue;
    }
    if (!Number.isFinite(requested)) continue;
    next[field] = clampField(field, requested);
  }

  const priorExtensions = environment.extensions ?? {};
  if (Object.keys(next).length === 0) {
    const { [LIGHTING_EXTENSION_KEY]: _dropped, ...rest } = priorExtensions;
    return Object.keys(rest).length === 0
      ? { ...environment, extensions: undefined }
      : { ...environment, extensions: rest };
  }

  return {
    ...environment,
    extensions: {
      ...priorExtensions,
      [LIGHTING_EXTENSION_KEY]: {
        ...next,
        scaleRevision: LIGHTING_SCALE_REVISION,
      },
    },
  };
}

export function usesPresetLighting(environment: Environment): boolean {
  return Object.keys(resolveEditorLightingOverrides(environment)).length === 0;
}

export function editorLightingSignature(environment: Environment): string {
  const overrides = resolveEditorLightingOverrides(environment);
  return LIGHTING_FIELDS
    .map((field) => {
      const value = overrides[field];
      return value === undefined ? "" : value.toFixed(4);
    })
    .join(":");
}

/** Canonical normalized lighting block for every newly-authored scenario. */
export function withFreshEditorEnvironmentDefaults(environment: Environment): Environment {
  return withEditorLightingOverrides(environment, {
    ambient: 1,
    sun: 1,
    visibilityM: DEFAULT_VISIBILITY_M,
  });
}
