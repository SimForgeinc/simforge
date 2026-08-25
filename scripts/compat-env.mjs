const warnedLegacyNames = new Set();

/** Read SIMFORGE_* first and accept the old variable with one warning per process. */
export function simforgeEnv(name) {
  const canonicalName = `SIMFORGE_${name}`;
  if (process.env[canonicalName] !== undefined) return process.env[canonicalName];
  const legacyName = `UNISCENARIO_${name}`;
  const value = process.env[legacyName];
  if (value !== undefined && !warnedLegacyNames.has(legacyName)) {
    warnedLegacyNames.add(legacyName);
    process.emitWarning(`${legacyName} is deprecated; set ${canonicalName} instead.`, {
      code: 'SIMFORGE_LEGACY_ENV',
    });
  }
  return value;
}
