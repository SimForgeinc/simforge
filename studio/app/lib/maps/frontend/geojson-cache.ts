/**
 * Two-tier cache for map-asset GeoJSON files:
 *   1. In-memory Map (instant, survives re-renders within the same session)
 *   2. Browser Cache API (persists across page reloads / sessions)
 *
 * The S3 GeoJSON is treated as immutable post-ingest, but operator-driven
 * re-uploads or future migrations could still change the underlying bytes.
 * To make the cache resilient to that, the key includes the artifact's
 * SHA-256: when the bytes change the recorded sha256 changes, the cache key
 * changes, the next fetch is a guaranteed miss, and the orphaned entry gets
 * GC'd by the browser. Callers without a sha256 (legacy code paths, tests)
 * fall back to a mapAssetId-only key — same behavior as before this change.
 */

const CACHE_NAME = "simcloud-geojson-v1";

/** In-memory cache — avoids re-parsing JSON on re-select within the same session. */
const memoryCache = new Map<string, object>();

/**
 * Cache API requires URL-shaped keys. When `geojsonSha256` is present we
 * append it as a path segment so a content change orphans the prior entry
 * automatically. The sha256 is normalized (trimmed, lowercased) so callers
 * passing the raw artifact field don't accidentally produce two cache entries
 * for the same content.
 */
function cacheUrl(
  mapAssetId: string,
  geojsonSha256?: string | null,
  kind?: string,
): string {
  const fingerprint = (geojsonSha256 ?? "").trim().toLowerCase();
  const base = kind
    ? `/_geojson-cache/${kind}/${mapAssetId}`
    : `/_geojson-cache/${mapAssetId}`;
  return fingerprint ? `${base}/${fingerprint}` : base;
}

/** Memory-cache key uses the same composite so a content change misses memory too. */
function memoryKey(
  mapAssetId: string,
  geojsonSha256?: string | null,
  kind?: string,
): string {
  const fingerprint = (geojsonSha256 ?? "").trim().toLowerCase();
  const base = kind ? `${kind}:${mapAssetId}` : mapAssetId;
  return fingerprint ? `${base}@${fingerprint}` : base;
}

/**
 * Fetch GeoJSON for a map asset, checking memory → Cache API → network in order.
 * Returns the raw parsed GeoJSON object (caller should normalise with feature IDs).
 *
 * Pass `geojsonSha256` from `MapAsset.artifacts[…].sha256` so cache entries
 * invalidate when the underlying S3 bytes ever change.
 */
export async function fetchGeoJSONWithCache(
  mapAssetId: string,
  geojsonSha256?: string | null,
  signal?: AbortSignal,
  directUrl?: string | null,
): Promise<object> {
  return fetchGeoJSONArtifactWithCache(mapAssetId, {
    geojsonSha256,
    signal,
    directUrl,
  });
}

/**
 * Same two-tier caching for sidecar GeoJSON artifacts (lane polygons, signal
 * overlays). `kind` namespaces the cache entry; `endpoint` overrides the
 * fetched URL (defaults to the primary geojson redirect route). Without this,
 * every scenario switch re-pays the 302 presign round-trip even though the
 * underlying S3 object is immutable.
 */
/**
 * Requests already on the wire, keyed by what they actually fetch.
 *
 * Both cache tiers key on the artifact sha, which is correct for storage and
 * wrong for de-duplication: the sha arrives asynchronously, so the first call
 * runs with it undefined and a later one runs with it set. Two keys, one URL,
 * and the browser downloads a multi-megabyte sidecar twice on every cold
 * editor open (measured: 2 x 529 KB for lane-polygons).
 *
 * Keyed on the fetch target rather than the sha, because the target is what
 * determines the bytes. Callers still store under their own cache keys.
 */
const requestsInFlight = new Map<string, Promise<object>>();

/**
 * Cache API writes that have been started but not yet settled.
 *
 * Persisting an artifact used to sit on the critical path: the fetch resolved,
 * the data was re-serialised with `JSON.stringify`, `cache.put` was awaited,
 * and only then did the caller get its GeoJSON. For the Munich road network
 * that put was measured at 11–134 ms in a production build (Cache API writes
 * hit disk, so the tail is long and unpredictable) on top of a ~7 ms
 * re-serialisation of a payload we had already downloaded. None of it is work
 * the map needs before it can draw.
 *
 * The write now runs detached. This set only exists so tests can await the
 * writes deterministically instead of racing them.
 */
const pendingCacheWrites = new Set<Promise<void>>();

/**
 * Store the exact bytes that came off the wire, without blocking the caller.
 *
 * `source` is a clone of the network response taken before it was parsed, so
 * the persisted entry is byte-identical to what S3 served — no re-serialising
 * a multi-megabyte object, and no risk of persisting a shape a consumer
 * mutated after we handed it over.
 */
function persistToDiskCache(diskCache: Cache, url: string, source: Response): void {
  const write = (async () => {
    try {
      await diskCache.put(
        url,
        new Response(source.body ?? (await source.arrayBuffer()), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    } catch {
      // Cache storage full or unavailable — not critical
    }
  })();
  pendingCacheWrites.add(write);
  void write.then(() => {
    pendingCacheWrites.delete(write);
  });
}

export async function fetchGeoJSONArtifactWithCache(
  mapAssetId: string,
  options?: {
    geojsonSha256?: string | null;
    signal?: AbortSignal;
    directUrl?: string | null;
    kind?: string;
    endpoint?: string;
  },
): Promise<object> {
  const { geojsonSha256, signal, directUrl, kind, endpoint } = options ?? {};
  const memKey = memoryKey(mapAssetId, geojsonSha256, kind);
  const url = cacheUrl(mapAssetId, geojsonSha256, kind);

  // ── Tier 1: in-memory ──
  const mem = memoryCache.get(memKey);
  if (mem) return mem;

  // ── Tier 2: Cache API ──
  const diskCache = await openCache();
  if (diskCache) {
    try {
      const cached = await diskCache.match(url);
      if (cached) {
        const data = (await cached.json()) as object;
        memoryCache.set(memKey, data);
        return data;
      }
    } catch {
      // Cache read failed — fall through to network
    }
  }

  // ── Tier 3: network ──
  const target = directUrl || endpoint || `/api/map-assets/${mapAssetId}/geojson`;

  // Only share when the caller wants no abort control. A shared request cannot
  // honour one caller's abort without breaking the other's, and preserving
  // today's abort semantics matters more than de-duplicating that case.
  const shareable = signal === undefined;
  const alreadyRunning = shareable ? requestsInFlight.get(target) : undefined;
  if (alreadyRunning) {
    const shared = await alreadyRunning;
    memoryCache.set(memKey, shared);
    return shared;
  }

  // Cloned before parsing so the Cache API can be fed the original bytes.
  // Only the caller that actually owns the fetch persists it; a caller that
  // joined an in-flight request stores in memory under its own key and
  // returns, exactly as before.
  let cacheSource: Response | null = null;
  const request = (async () => {
    const response = await fetch(target, { signal });
    if (!response.ok) throw new Error(`GeoJSON fetch failed: ${response.status}`);
    if (diskCache) {
      try {
        cacheSource = response.clone();
      } catch {
        // Body already disturbed / clone unsupported — skip the disk tier.
      }
    }
    return (await response.json()) as object;
  })();
  if (shareable) requestsInFlight.set(target, request);
  let data: object;
  try {
    data = await request;
  } finally {
    if (shareable) requestsInFlight.delete(target);
  }

  // Store in both caches. The disk write is detached: the map does not need
  // it, and awaiting it delayed every cold editor open by the length of a
  // Cache API disk write.
  memoryCache.set(memKey, data);
  if (diskCache && cacheSource) persistToDiskCache(diskCache, url, cacheSource);

  return data;
}

async function openCache(): Promise<Cache | null> {
  try {
    if (typeof caches === "undefined") return null;
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/**
 * Test-only: clear in-memory cache state. Cache API state is reset by
 * stubbing `globalThis.caches` in the test harness.
 */
export function __resetGeoJSONMemoryCacheForTesting(): void {
  memoryCache.clear();
}

/**
 * Test-only: settle the detached Cache API writes.
 *
 * Production callers deliberately do not wait for these — that is the point of
 * the change — so tests that assert on persisted entries have to join them
 * explicitly. Loops because a write can be scheduled while an earlier one is
 * still settling.
 */
export async function __flushGeoJSONCacheWritesForTesting(): Promise<void> {
  while (pendingCacheWrites.size > 0) {
    await Promise.all([...pendingCacheWrites]);
  }
}
