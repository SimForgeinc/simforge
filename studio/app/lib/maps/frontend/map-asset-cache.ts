"use client";

const CACHE_NAME = "simforge-map-assets-v4";
const INDEX_KEY = "simforge-map-assets-index-v4";
const LEGACY_CACHES = ["simcloud-glb-v1", "simforge-profile-maps-v2", "simforge-map-assets-v3"];
const CONTENT_PREFIX = "/api/simforge/map-cache/sha256/";
const SHA256 = /^[a-f0-9]{64}$/;

type CacheIndex = {
  urls: Record<string, string>;
  content: Record<string, { bytes: number; lastUsed: number }>;
  receipts: Record<string, { completedAt: number; assets: number; bytes: number }>;
};

const EMPTY_INDEX: CacheIndex = { urls: {}, content: {}, receipts: {} };
const inFlight = new Map<string, Promise<Response>>();
const backgroundWarmups = new Map<string, Promise<void>>();
let pendingBulkIndex: CacheIndex | null = null;
let nativeFetch: typeof fetch | null = null;
let gatewayInstalled = false;

function readIndex(): CacheIndex {
  if (pendingBulkIndex) return pendingBulkIndex;
  try {
    const parsed = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "null") as Partial<CacheIndex> | null;
    return {
      urls: parsed?.urls && typeof parsed.urls === "object" ? parsed.urls : {},
      content: parsed?.content && typeof parsed.content === "object" ? parsed.content : {},
      receipts: parsed?.receipts && typeof parsed.receipts === "object" ? parsed.receipts : {},
    };
  } catch {
    return structuredClone(EMPTY_INDEX);
  }
}

function persistIndex(index: CacheIndex) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

function writeIndex(index: CacheIndex, defer = false) {
  if (defer) {
    pendingBulkIndex = index;
    return;
  }
  persistIndex(index);
}

export function flushMapAssetCacheIndex() {
  if (!pendingBulkIndex) return;
  persistIndex(pendingBulkIndex);
  pendingBulkIndex = null;
}

function absoluteUrl(url: string) {
  return new URL(url, window.location.origin).href;
}

function contentRequest(sha256: string) {
  return new Request(`${window.location.origin}${CONTENT_PREFIX}${sha256}`);
}

async function digest(bytes: ArrayBuffer) {
  const value = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  try {
    return await digest(bytes);
  } catch {
    return null;
  }
}

function networkFetch(input: RequestInfo | URL, init?: RequestInit) {
  return (nativeFetch ?? window.fetch)(input, init);
}

function responseFromBytes(bytes: ArrayBuffer, source: Response) {
  return new Response(bytes, {
    status: source.status,
    statusText: source.statusText,
    headers: source.headers,
  });
}

function requestedRange(init: RequestInit) {
  return new Headers(init.headers).get("range");
}

function withoutRange(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  headers.delete("range");
  return { ...init, headers, signal: undefined, credentials: "same-origin" };
}

function rangeResponse(bytes: ArrayBuffer, range: string, source: Response) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : bytes.byteLength - 1;
  const end = Math.min(bytes.byteLength - 1, requestedEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return null;
  const body = bytes.slice(start, end + 1);
  const headers = new Headers(source.headers);
  headers.set("content-length", String(body.byteLength));
  headers.set("content-range", `bytes ${start}-${end}/${bytes.byteLength}`);
  headers.set("accept-ranges", "bytes");
  return new Response(body, { status: 206, headers });
}

export async function hasCachedMapAsset(url: string, expectedSha256?: string) {
  if (!("caches" in window)) return false;
  const index = readIndex();
  const sha256 = expectedSha256 ?? index.urls[absoluteUrl(url)];
  if (!sha256 || !SHA256.test(sha256)) return false;
  return Boolean(await (await caches.open(CACHE_NAME)).match(contentRequest(sha256)));
}

/** Fetch, verify and persist one immutable map asset under its content hash. */
export async function fetchMapAsset(
  url: string,
  init: RequestInit = {},
  expectedSha256?: string,
  networkUrl?: string,
  deferIndexWrite = false,
): Promise<Response> {
  if (init.method && init.method !== "GET") return networkFetch(url, init);
  if (!("caches" in window)) return networkFetch(url, init);
  const canonicalUrl = absoluteUrl(url);
  const index = readIndex();
  const knownSha = expectedSha256 ?? index.urls[canonicalUrl];
  const cache = await caches.open(CACHE_NAME);
  if (knownSha && SHA256.test(knownSha)) {
    const cached = await cache.match(contentRequest(knownSha));
    if (cached) {
      const range = requestedRange(init);
      if (range) {
        const bytes = await cached.arrayBuffer();
        const partial = rangeResponse(bytes, range, cached);
        if (partial) return partial;
      }
      if (expectedSha256) {
        const bytes = await cached.arrayBuffer();
        if (await digest(bytes) !== expectedSha256) {
          await cache.delete(contentRequest(knownSha));
        } else {
          index.urls[canonicalUrl] = knownSha;
          index.content[knownSha] = { bytes: bytes.byteLength, lastUsed: Date.now() };
          writeIndex(index, deferIndexWrite);
          return responseFromBytes(bytes, cached);
        }
      } else {
        index.urls[canonicalUrl] = knownSha;
        const previous = index.content[knownSha];
        index.content[knownSha] = {
          bytes: previous?.bytes ?? Number(cached.headers.get("content-length") ?? 0),
          lastUsed: Date.now(),
        };
        writeIndex(index, deferIndexWrite);
        return cached;
      }
    }
  }

  const inFlightKey = knownSha && SHA256.test(knownSha) ? knownSha : canonicalUrl;
  const existing = inFlight.get(inFlightKey);
  if (existing) return (await existing).clone();
  const persist = async (response: Response) => {
    const bytes = await response.arrayBuffer();
    const actualSha = await digest(bytes);
    if (expectedSha256 && actualSha !== expectedSha256) {
      throw new Error(`Asset integrity check failed for ${canonicalUrl}`);
    }
    const stored = responseFromBytes(bytes.slice(0), response);
    await cache.put(contentRequest(actualSha), stored);
    const next = readIndex();
    next.urls[canonicalUrl] = actualSha;
    next.content[actualSha] = { bytes: bytes.byteLength, lastUsed: Date.now() };
    writeIndex(next, deferIndexWrite);
    return responseFromBytes(bytes, response);
  };
  const pending = (async () => {
    const transferUrl = networkUrl ?? url;
    const response = await networkFetch(transferUrl, {
      ...init,
      credentials: networkUrl ? "omit" : "same-origin",
    });
    if (!response.ok) return response;
    if (response.status === 206) {
      if (!backgroundWarmups.has(inFlightKey)) {
        const warmup = (async () => {
          const full = await networkFetch(transferUrl, {
            ...withoutRange(init),
            credentials: networkUrl ? "omit" : "same-origin",
          });
          if (full.ok && full.status === 200) await persist(full);
        })()
          .catch(() => undefined)
          .finally(() => backgroundWarmups.delete(inFlightKey));
        backgroundWarmups.set(inFlightKey, warmup);
      }
      return response;
    }
    // Persist only full 200 bodies — an `ok` 204 (e.g. an `optional=1`
    // existence probe against an absent object) must not become a cached
    // empty asset that keeps answering after the object appears.
    if (response.status !== 200) return response;
    return persist(response);
  })().finally(() => inFlight.delete(inFlightKey));
  inFlight.set(inFlightKey, pending);
  return (await pending).clone();
}

function isMapAssetRequest(input: RequestInfo | URL, init?: RequestInit) {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method !== "GET") return false;
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, window.location.origin);
  if (url.origin !== window.location.origin) return false;
  if (/^\/api\/scenario\/maps\/[^/]+\/browser-assets\//.test(url.pathname)
    || url.pathname.startsWith("/api/simforge/sumo-runtime/")) {
    return true;
  }
  // Digital-twin panel assets (map-assets detail page). Unlike the
  // scenario routes above, these URLs are NOT content-versioned — a map
  // rebuild overwrites `maps/<id>/3d/…` in place — so only fetches carrying
  // the explicit `?v=<manifest-hash>` token (appended by the city-viewer,
  // see `CityViewerCore.start`) are cacheable: rebuild → new manifest bytes
  // → new token → every asset URL misses and refetches. Token-less 3d-asset
  // fetches (the manifest itself, `optional=1` probes, mutable twin-eval
  // artifacts) always pass through to the network.
  return /^\/api\/map-assets\/[^/]+\/3d-asset\//.test(url.pathname)
    && url.searchParams.has("v");
}

/** Install once before a viewer mounts so third-party loaders share this cache. */
export function installMapAssetFetchGateway() {
  if (gatewayInstalled || typeof window === "undefined") return;
  nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!isMapAssetRequest(input, init)) return nativeFetch!(input, init);
    const url = input instanceof Request ? input.url : String(input);
    const requestInit = input instanceof Request
      ? { method: input.method, headers: input.headers, signal: input.signal, ...init }
      : init;
    return fetchMapAsset(url, requestInit);
  }) as typeof fetch;
  gatewayInstalled = true;
}

export async function prepareMapAssetCache() {
  if (typeof caches.delete === "function") {
    await Promise.all(LEGACY_CACHES.map((name) => caches.delete(name).catch(() => false)));
  }
  if (navigator.storage?.persist) {
    const alreadyPersistent = await navigator.storage.persisted?.().catch(() => false) ?? false;
    return alreadyPersistent || await navigator.storage.persist().catch(() => false);
  }
  return false;
}

export async function clearMapAssetCache() {
  pendingBulkIndex = null;
  await caches.delete(CACHE_NAME).catch(() => false);
  localStorage.removeItem(INDEX_KEY);
}

export async function availableStorageBytes() {
  const estimate = await navigator.storage?.estimate?.();
  if (!estimate?.quota) return null;
  return Math.max(0, estimate.quota - (estimate.usage ?? 0));
}

export function cacheReceiptKey(releaseKey: string, profile: string) {
  return `${releaseKey}::${profile}`;
}

export function writeCacheReceipt(key: string, assets: number, bytes: number) {
  flushMapAssetCacheIndex();
  const index = readIndex();
  index.receipts[key] = { completedAt: Date.now(), assets, bytes };
  writeIndex(index);
}

export function hasCacheReceipt(key: string) {
  return Boolean(readIndex().receipts[key]);
}
