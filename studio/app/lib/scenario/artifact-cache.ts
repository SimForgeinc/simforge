"use client";

import { availableStorageBytes } from "@/app/lib/maps/frontend/map-asset-cache";

/**
 * Browser cache for scenario artifacts that are addressed by their own digest.
 *
 * ## Why these are safe to cache and scenario documents are not
 *
 * A materialized-traffic blob or a saved simulation is named by the SHA-256 of
 * its bytes, and the caller already holds that digest before it asks for them —
 * it arrives in the artifact descriptor and is verified after download. Storing
 * the bytes under that digest makes the key and the content the same fact, so a
 * hit cannot be stale: the entry either hashes to the key or it is not the
 * entry. That is the whole reason this tier needs no invalidation, no TTL and
 * no revalidation round trip, while a document head needs all three.
 *
 * It is also why this stays tenant-safe in a shared browser profile. A digest
 * is only reachable by a caller that was already handed it by an authorized
 * descriptor, and two tenants holding the same digest hold the same bytes by
 * definition. The tenancy hazard lives in URL-keyed caches of mutable,
 * workspace-scoped responses — deliberately not what this module does.
 *
 * ## Separate from the map asset cache on purpose
 *
 * Map assets can fill Cache Storage on their own. Sharing a cache name would
 * let scenario entries evict map tiles the viewer is mid-stream on, so this
 * keeps its own name and refuses to write when storage is tight rather than
 * competing for the same quota.
 */

const CACHE_NAME = "simforge-scenario-artifacts-v1";
/** Synthetic origin path; never fetched, it only names the entry by digest. */
const CONTENT_PREFIX = "/api/uniscenario/artifact-cache/sha256/";
const SHA256 = /^[a-f0-9]{64}$/;
/** Below this, leave the remaining quota to the map assets the viewer needs. */
const MIN_FREE_BYTES_TO_CACHE = 64 * 1024 * 1024;

export type ContentAddressedDescriptor = {
  readonly sha256: string;
  readonly sizeBytes: number;
};

export type ArtifactCacheOutcome = "hit" | "miss" | "uncacheable";

/** Last outcome per digest, for tests and the cache-hit metric. */
const lastOutcome = new Map<string, ArtifactCacheOutcome>();

/** Outcome of the most recent fetch for `sha256`, or null if never fetched. */
export function lastArtifactCacheOutcome(sha256: string): ArtifactCacheOutcome | null {
  return lastOutcome.get(sha256) ?? null;
}

function cacheStorage(): CacheStorage | null {
  try {
    return typeof caches === "undefined" ? null : caches;
  } catch {
    return null;
  }
}

function contentRequest(sha256: string): Request {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new Request(`${origin}${CONTENT_PREFIX}${sha256}`);
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * A cached entry is only trusted when it still hashes to the key it is filed
 * under. Cache Storage can be evicted or truncated by the browser between
 * sessions, and a short read that merely matched the expected length would
 * hand back a corrupt scenario rather than re-fetching a good one.
 */
async function readVerified(
  storage: CacheStorage,
  descriptor: ContentAddressedDescriptor,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const cache = await storage.open(CACHE_NAME);
    const hit = await cache.match(contentRequest(descriptor.sha256));
    if (!hit) return null;
    const bytes = new Uint8Array(await hit.arrayBuffer());
    if (bytes.byteLength !== descriptor.sizeBytes) {
      await cache.delete(contentRequest(descriptor.sha256));
      return null;
    }
    if (await digestHex(bytes) !== descriptor.sha256) {
      await cache.delete(contentRequest(descriptor.sha256));
      return null;
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Persist verified bytes. A write failure is never fatal — the caller has them. */
async function persist(
  storage: CacheStorage,
  descriptor: ContentAddressedDescriptor,
  bytes: Uint8Array,
): Promise<void> {
  try {
    const free = await availableStorageBytes();
    if (free !== null && free < MIN_FREE_BYTES_TO_CACHE) return;
    const cache = await storage.open(CACHE_NAME);
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await cache.put(contentRequest(descriptor.sha256), new Response(body));
  } catch {
    // Quota, private-mode restrictions, a racing eviction: all mean "not cached".
  }
}

/**
 * Fetch an artifact by URL, serving verified bytes from cache when present.
 *
 * Always returns bytes that match `descriptor` on both length and digest, so
 * callers keep exactly the guarantee they had when they verified the download
 * themselves — the check simply moved in here and now also covers cache reads.
 */
export async function fetchContentAddressedArtifact(
  url: string,
  descriptor: ContentAddressedDescriptor,
  options: { readonly signal?: AbortSignal; readonly label?: string } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const label = options.label ?? "Artifact";
  const storage = SHA256.test(descriptor.sha256) ? cacheStorage() : null;

  if (storage) {
    const cached = await readVerified(storage, descriptor);
    if (cached) {
      lastOutcome.set(descriptor.sha256, "hit");
      return cached;
    }
  }

  const response = await fetch(url, { cache: "no-store", signal: options.signal });
  if (!response.ok) throw new Error(`${label} download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== descriptor.sizeBytes) throw new Error(`${label} download is incomplete`);
  if (await digestHex(bytes) !== descriptor.sha256) throw new Error(`${label} checksum does not match`);

  if (storage) {
    await persist(storage, descriptor, bytes);
    lastOutcome.set(descriptor.sha256, "miss");
  } else {
    lastOutcome.set(descriptor.sha256, "uncacheable");
  }
  return bytes;
}

/** Drop every cached scenario artifact. Exposed for settings and tests. */
export async function clearArtifactCache(): Promise<void> {
  const storage = cacheStorage();
  if (!storage) return;
  try {
    await storage.delete(CACHE_NAME);
  } catch {
    // Nothing to do; the cache is best-effort by construction.
  }
  lastOutcome.clear();
}
