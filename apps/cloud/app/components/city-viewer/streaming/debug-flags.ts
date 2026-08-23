/**
 * Streaming pipeline debug flags, gated behind `?debug=1`.
 *
 * Other streaming modules import these flags at decision points to opt out of
 * pacing or override budgets. When `?debug=1` is absent, every flag returns
 * its default — no other URL param has any effect. See
 * `.scratch/streaming-budget-pacing/issues/01-debug-flags-infrastructure.md`.
 */

export type DebugFlags = Readonly<{
  nogate: boolean;
  nodegradation: boolean;
  nobreaker: boolean;
  leaktest: boolean;
  budget: number | undefined;
  fillrate: number | undefined;
  meshstagger: number | undefined;
}>;

export const DEBUG_FLAG_DEFAULTS: DebugFlags = Object.freeze({
  nogate: false,
  nodegradation: false,
  nobreaker: false,
  leaktest: false,
  budget: undefined,
  fillrate: undefined,
  meshstagger: undefined,
});

/**
 * Pure parser. Used directly by tests and by the singleton accessor below.
 * The leading `?` is optional.
 */
export function parseDebugFlags(search: string): DebugFlags {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );

  if (params.get("debug") !== "1") {
    return DEBUG_FLAG_DEFAULTS;
  }

  return Object.freeze({
    nogate: parseBoolFlag(params.get("nogate")),
    nodegradation: parseBoolFlag(params.get("nodegradation")),
    nobreaker: parseBoolFlag(params.get("nobreaker")),
    leaktest: parseBoolFlag(params.get("leaktest")),
    budget: parseNumericFlag(params.get("budget")),
    fillrate: parseNumericFlag(params.get("fillrate")),
    meshstagger: parseNumericFlag(params.get("meshstagger")),
  });
}

function parseBoolFlag(raw: string | null): boolean {
  return raw === "1";
}

/**
 * Numeric flags accept positive finite numbers; everything else (NaN, negative,
 * non-numeric strings, missing) collapses to undefined so callers can fall
 * through to their tier defaults. Zero is intentionally rejected — a budget or
 * fill-rate of zero would deadlock the activation pipeline, and it is more
 * useful to treat it as "flag not set" than to honor it.
 */
function parseNumericFlag(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

let cached: DebugFlags | undefined;

/**
 * Singleton accessor. Parses `window.location.search` on first call, caches
 * the result for the rest of the session. Safe to call before/after the
 * viewer mounts; falls back to defaults when `window` is unavailable (SSR).
 */
export function getDebugFlags(): DebugFlags {
  if (cached) return cached;
  if (typeof window === "undefined") {
    cached = DEBUG_FLAG_DEFAULTS;
    return cached;
  }
  cached = parseDebugFlags(window.location.search);
  return cached;
}

/**
 * Test-only: clear the cached singleton so the next `getDebugFlags()` call
 * re-reads `window.location.search`. Not exported through any production
 * surface.
 */
export function __resetDebugFlagsCacheForTesting(): void {
  cached = undefined;
}
