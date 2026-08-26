import type { Environment } from "@simforge-oss/scenario";
import { z } from "zod";

/**
 * Manual lighting overrides.
 *
 * The weather and time-of-day presets stay the base description of the scene —
 * they are what the friction model, the sensor model and the renderer all agree
 * on. These are the per-scenario numbers an author reaches for when the preset
 * is close but not the shot they want: every field is optional, and an absent
 * field means "whatever the preset resolved to".
 *
 * They live in `environment.extensions`, which the scenario schema documents as
 * "renderer/sensor-specific knobs, nothing in this package interprets these" —
 * the same place the scene clock and the wind/snow appearance already live. So
 * they travel with the document, survive a round-trip, and reach every adapter
 * through `authoredEnvironment` without widening the execution schema.
 */
export const LIGHTING_EXTENSION_KEY = "org.simforge.lighting.v1" as const;

/** Canonical authored visibility for every fresh scenario. */
export const DEFAULT_VISIBILITY_M = 200;

/** Inclusive bounds every override is clamped to, and the neutral value. */
export const LIGHTING_RANGES = {
  ambient: { min: 0, max: 4, neutral: 1, step: 0.05 },
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

/**
 * One override as stored.
 *
 * Out-of-range but finite values are clamped, because a document written by an
 * older range, a generator or a hand edit is still expressing an intent. A
 * non-finite value is dropped instead: `NaN` is a broken write, not a request
 * for the minimum, and turning it into 0 ambient would black the scene out with
 * nothing to point at.
 */
function overrideSchema(field: LightingField) {
  const { min, max } = LIGHTING_RANGES[field];
  return z
    .number()
    .finite()
    .transform((value) => Math.min(max, Math.max(min, value)))
    .optional()
    .catch(undefined);
}

const LightingBlockSchema = z
  .object({
    ambient: overrideSchema("ambient"),
    sun: overrideSchema("sun"),
    sunWarmth: overrideSchema("sunWarmth"),
    exposure: overrideSchema("exposure"),
    sky: overrideSchema("sky"),
    visibilityM: overrideSchema("visibilityM"),
    haze: overrideSchema("haze"),
  })
  // A block from a newer editor may carry fields this build has never heard of;
  // reading it must not fail, and writing must not drop them.
  .passthrough()
  .catch({});

export type EditorLightingOverrides = Readonly<{
  [Field in LightingField]?: number;
}>;

/** Authored lighting overrides, with unusable and legacy values dropped. */
export function resolveEditorLightingOverrides(
  environment: Environment,
): EditorLightingOverrides {
  const parsed = LightingBlockSchema.safeParse(
    environment.extensions?.[LIGHTING_EXTENSION_KEY],
  );
  if (!parsed.success) return {};
  const resolved: Record<string, number> = {};
  for (const field of LIGHTING_FIELDS) {
    const value = parsed.data[field];
    if (typeof value === "number") resolved[field] = value;
  }
  return resolved;
}

/**
 * Writes lighting overrides, retaining every execution field and unrelated
 * extension. Passing `undefined` for a field clears it back to the preset.
 */
export function withEditorLightingOverrides(
  environment: Environment,
  patch: Readonly<Partial<Record<LightingField, number | undefined>>>,
): Environment {
  const next: Record<string, number> = {
    ...resolveEditorLightingOverrides(environment),
  };
  for (const field of LIGHTING_FIELDS) {
    if (!(field in patch)) continue;
    const requested = patch[field];
    if (requested === undefined) {
      delete next[field];
      continue;
    }
    const { min, max } = LIGHTING_RANGES[field];
    if (!Number.isFinite(requested)) continue;
    next[field] = Math.min(max, Math.max(min, requested));
  }

  const priorExtensions = environment.extensions ?? {};
  if (Object.keys(next).length === 0) {
    // An empty block would persist as noise in every exported document, so a
    // scenario back at its preset carries no lighting extension at all.
    const { [LIGHTING_EXTENSION_KEY]: _dropped, ...rest } = priorExtensions;
    return Object.keys(rest).length === 0
      ? { ...environment, extensions: undefined }
      : { ...environment, extensions: rest };
  }

  return {
    ...environment,
    extensions: { ...priorExtensions, [LIGHTING_EXTENSION_KEY]: next },
  };
}

/** True when the scenario carries no manual lighting at all. */
export function usesPresetLighting(environment: Environment): boolean {
  return Object.keys(resolveEditorLightingOverrides(environment)).length === 0;
}

/** A stable, compact dependency key for consumers of the lighting overrides. */
export function editorLightingSignature(environment: Environment): string {
  const overrides = resolveEditorLightingOverrides(environment);
  return LIGHTING_FIELDS
    .map((field) => {
      const value = overrides[field];
      return value === undefined ? "" : value.toFixed(4);
    })
    .join(":");
}
