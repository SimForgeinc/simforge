import {
  EnvironmentSchema,
  type Environment,
  type EnvironmentInput,
} from "../schema/v2/environment.js";

/** Canonical environment applied when authoring a new v2 document. */
export const NEW_DOCUMENT_ENVIRONMENT_DEFAULT: Readonly<Environment> =
  EnvironmentSchema.parse({});

/**
 * Compatibility fallback for stored documents created before environment
 * authoring existed. This is intentionally not the new-document default.
 */
export const LEGACY_ENVIRONMENT_FALLBACK: Readonly<Environment> =
  EnvironmentSchema.parse({ weather: "clear", timeOfDay: "noon" });

/** Resolve a new document (or partial authored input) using the v2 schema defaults. */
export function resolveNewDocumentEnvironment(
  input: EnvironmentInput = {},
): Environment {
  return EnvironmentSchema.parse(input);
}

/**
 * Resolve a legacy stored document. Only an absent environment receives the
 * historical clear/noon fallback; an existing partial block uses v2 field defaults.
 */
export function resolveLegacyEnvironmentFallback(
  input: EnvironmentInput | null | undefined,
): Environment {
  return EnvironmentSchema.parse(input ?? LEGACY_ENVIRONMENT_FALLBACK);
}
