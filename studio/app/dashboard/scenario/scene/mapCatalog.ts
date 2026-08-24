import type { ScenarioMapOption } from "../list/document-map-groups";

/**
 * Map-catalog helpers for the datasets-page scene.
 *
 * ## What "preloading the maps" can and cannot mean here
 *
 * A map is a streamed city bundle: one small `manifest.json` plus tiled geometry and textures, fetched
 * per LOD as the camera moves. Eagerly downloading every map in full would be hundreds of megabytes for
 * a page that shows one of them, so {@link preloadMapManifests} fetches **manifests only** and leaves
 * geometry to the renderer's existing streaming path.
 *
 * The manifest is also the part worth preloading: it is what `CityViewer.loadMap` must have in hand
 * before it can request a single tile, so having it already resolved is what removes the dead pause
 * between picking a map and seeing anything.
 *
 * ## Why this warms the HTTP cache instead of holding the parsed JSON
 *
 * `CityViewer.loadMap(url)` fetches the manifest itself and takes no injected value, so a parsed copy
 * kept in module state would be a cache with no reader. Warming the browser's HTTP cache is the form of
 * preload the renderer actually benefits from without touching it.
 *
 * The proxy serves `private, max-age=300`, so a warmed entry goes stale after five minutes. That is a
 * real limit and not worked around: past it the conditional request still carries the proxy's `ETag` and
 * comes back `304 Not Modified`, which is a header round-trip rather than a re-download. The set of
 * warmed URLs is tracked only so a second pass does not redo work the first already did.
 */

/** Map version ids whose manifest has been fetched at least once this page session. */
const warmed = new Set<string>();

/** Concurrent manifest fetches. Small on purpose: this runs behind a visible, interactive scene. */
const PRELOAD_CONCURRENCY = 3;

/** Maps that can actually be mounted — anything without a manifest URL has no renderer entry point. */
export function renderableMaps(
  maps: readonly ScenarioMapOption[],
): ScenarioMapOption[] {
  return maps.filter((map) => Boolean(map.browserManifestUrl));
}

/**
 * Pick a map to show when nothing is selected.
 *
 * Call this from an effect, never during render: `Math.random()` during a server render and again during
 * hydration produces two different maps and React discards the first as a mismatch.
 */
export function pickRandomMap(
  maps: readonly ScenarioMapOption[],
): ScenarioMapOption | null {
  const candidates = renderableMaps(maps);
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
}

/** Whether this map's manifest has already been fetched this session. */
export function isMapWarmed(mapVersionId: string): boolean {
  return warmed.has(mapVersionId);
}

/**
 * Fetch every map's manifest, a few at a time, so the first frame after a map switch is not a cold
 * fetch. Resolves with the number newly warmed.
 *
 * Never rejects. A preload is an optimization, and a map whose manifest 404s or whose fetch is aborted
 * must not surface an error on a page that is working — the renderer will report it properly if the user
 * actually opens that map.
 */
export async function preloadMapManifests(
  maps: readonly ScenarioMapOption[],
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  const pending = renderableMaps(maps).filter((map) => !warmed.has(map.mapVersionId));
  if (pending.length === 0) return 0;

  let warmedNow = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < pending.length) {
      if (options.signal?.aborted) return;
      const map = pending[cursor++];
      if (!map?.browserManifestUrl) continue;
      try {
        const response = await fetch(map.browserManifestUrl, {
          signal: options.signal,
          // The point is to populate the shared HTTP cache the renderer will read from, so this must be
          // an ordinary cacheable GET rather than `cache: "no-store"`.
          credentials: "same-origin",
        });
        // A failed status still resolves the promise. Only a real hit counts as warmed, or a transient
        // 503 would permanently mark the map done and suppress the retry.
        if (!response.ok) continue;
        // The body has to be drained for the response to land in the cache; discarding it is fine
        // because the renderer re-reads it from there.
        await response.arrayBuffer();
        warmed.add(map.mapVersionId);
        warmedNow += 1;
      } catch {
        // Aborted navigation or a network failure. Left un-warmed so a later pass can retry.
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PRELOAD_CONCURRENCY, pending.length) }, worker),
  );
  return warmedNow;
}

/** Test seam: drops the warmed set so each case starts cold. */
export function resetMapPreloadCacheForTests() {
  warmed.clear();
}
