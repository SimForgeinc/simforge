const warnedLegacyNames = new Set<string>();

/**
 * Reads the canonical SIMFORGE_* variable first and accepts the matching
 * UNISCENARIO_* name only as a deprecated transition fallback.
 */
export function simforgeEnv(name: string): string | undefined {
  const canonicalName = `SIMFORGE_${name}`;
  const canonicalValue = process.env[canonicalName];
  if (canonicalValue !== undefined) return canonicalValue;

  const legacyName = `UNISCENARIO_${name}`;
  const legacyValue = process.env[legacyName];
  if (legacyValue !== undefined && !warnedLegacyNames.has(legacyName)) {
    warnedLegacyNames.add(legacyName);
    process.emitWarning(
      `${legacyName} is deprecated; set ${canonicalName} instead.`,
      { code: "SIMFORGE_LEGACY_ENV" },
    );
  }
  return legacyValue;
}
