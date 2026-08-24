'use client';

/**
 * One-time cleanup for the floating dev-HUD localStorage entries left behind
 * after StatsPanel / ViewerAuditHud / VisualConfigHud moved into the
 * `ViewerAccordion` shell. The old `useDraggableHud` hook persisted
 * `{x, y, collapsed}` under one key per HUD; the accordion sections don't
 * persist anything, so those entries are dead.
 *
 * Idempotent. Silently no-ops if localStorage is unavailable (SSR or
 * privacy mode). Designed to be called from a `useEffect` on mount; it
 * removes at most three keys and returns, so the cost on subsequent mounts
 * is the same as a hit-and-miss `removeItem` triple.
 */
const LEGACY_KEYS = [
  'city-viewer:hud:stats',
  'city-viewer:hud:audit',
  'city-viewer:hud:visual-config',
] as const;

export function cleanupLegacyHudStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    for (const key of LEGACY_KEYS) {
      window.localStorage.removeItem(key);
    }
  } catch {
    /* localStorage disabled (privacy mode) — nothing to clean */
  }
}

export const __LEGACY_HUD_STORAGE_KEYS = LEGACY_KEYS;
