import type { RenderingPreference } from "@/app/components/rendering-preference"
import type { ScenarioMapOption } from "@/app/dashboard/scenario/list/document-map-groups";
import {
  isCityAssetVariantManifest,
  estimateLodBytes,
  normalizeLods,
  resolveUrl,
  selectAssetVariant,
  type CityAssetVariantManifest,
  type CityManifest,
} from "@simforge-oss/viewer";
import { AUTHORING_QUALITY } from "@/app/dashboard/scenario/editor/authoring-quality";
import {
  availableStorageBytes,
  fetchMapAsset,
  flushMapAssetCacheIndex,
  hasCachedMapAsset,
  prepareMapAssetCache,
} from "@/app/lib/maps/frontend/map-asset-cache";
import {
  SUMO_RUNTIME_MANIFEST_URL,
  SUMO_RUNTIME_MODULE_URL,
  SUMO_RUNTIME_WASM_URL,
} from "@/app/lib/scenario/sumo-runtime";

const PROFILE_MAP_PLAN_CACHE = "simforge-profile-map-plans-v3";
const PROFILE_MAP_PLAN_SCHEMA = 4;
const MAX_DISCOVERY_CONCURRENCY = 3;
const MIN_DOWNLOAD_CONCURRENCY = 8;
const MAX_DOWNLOAD_CONCURRENCY = 12;
const DOWNLOAD_URL_BATCH_SIZE = 96;
const MAX_CACHE_LOOKUP_CONCURRENCY = 24;
const MAX_ASSET_DOWNLOAD_ATTEMPTS = 2;
/** A broken response or Cache Storage write must not hold bulk preparation open forever. */
export const PROFILE_MAP_ASSET_ATTEMPT_TIMEOUT_MS = 90_000;

export type ProfileMapAsset = {
  url: string;
  bytes: number | null;
  mapVersionId: string;
  /** Content identity enables one cached response to serve duplicate map paths. */
  sha256?: string;
};

export type ProfileMapPlan = {
  releaseKey: string;
  profile: RenderingPreference;
  mapCount: number;
  assets: ProfileMapAsset[];
  /** Assets that were not already present when this plan was calculated. */
  pendingAssets?: ProfileMapAsset[];
  totalBytes: number;
  remainingBytes: number;
  remainingAssets: number;
  unknownSizeAssets: number;
};

type CacheInventory = {
  releaseKey: string;
  maps: Array<{
    mapVersionId: string;
    assets: Array<{ relativePath: string; sha256: string; byteLength: number }>;
  }>;
};

export type ProfileMapCacheProgress = {
  completedAssets: number;
  totalAssets: number;
  completedBytes: number;
  totalBytes: number;
  currentMapVersionId: string | null;
};

export type ProfileMapCacheResult = {
  failedAssets: number;
};

type CachedProfileMapAssets = {
  schemaVersion: typeof PROFILE_MAP_PLAN_SCHEMA;
  profile: RenderingPreference;
  mapVersionId: string;
  browserClosureSha256: string | null;
  assets: ProfileMapAsset[];
};

function canUseCacheStorage(): boolean {
  return typeof window !== "undefined" && "caches" in window;
}

function cacheRequest(url: string): Request {
  return new Request(url, { credentials: "same-origin" });
}

function planCacheRequest(map: ScenarioMapOption, profile: RenderingPreference): Request {
  const closure = map.browserClosureSha256 ?? map.mapVersionId;
  const key = [PROFILE_MAP_PLAN_SCHEMA, profile, map.mapVersionId, closure]
    .map((part) => encodeURIComponent(String(part)))
    .join("/");
  return cacheRequest(`${window.location.origin}/api/simforge/profile-map-plan-cache/${key}`);
}

function isCachedProfileMapAssets(
  value: unknown,
  map: ScenarioMapOption,
  profile: RenderingPreference,
): value is CachedProfileMapAssets {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CachedProfileMapAssets>;
  return candidate.schemaVersion === PROFILE_MAP_PLAN_SCHEMA
    && candidate.profile === profile
    && candidate.mapVersionId === map.mapVersionId
    && candidate.browserClosureSha256 === (map.browserClosureSha256 ?? null)
    && Array.isArray(candidate.assets)
    && candidate.assets.every((asset) => asset
      && typeof asset.url === "string"
      && (asset.bytes === null || (Number.isSafeInteger(asset.bytes) && asset.bytes >= 0))
      && (asset.sha256 === undefined || /^[a-f0-9]{64}$/.test(asset.sha256))
      && asset.mapVersionId === map.mapVersionId);
}

async function readCachedMapAssets(
  map: ScenarioMapOption,
  profile: RenderingPreference,
): Promise<ProfileMapAsset[] | null> {
  if (!canUseCacheStorage()) return null;
  const cache = await caches.open(PROFILE_MAP_PLAN_CACHE);
  const response = await cache.match(planCacheRequest(map, profile));
  if (!response) return null;
  try {
    const value: unknown = await response.json();
    return isCachedProfileMapAssets(value, map, profile) ? value.assets : null;
  } catch {
    return null;
  }
}

async function writeCachedMapAssets(
  map: ScenarioMapOption,
  profile: RenderingPreference,
  assets: ProfileMapAsset[],
): Promise<void> {
  if (!canUseCacheStorage()) return;
  const cache = await caches.open(PROFILE_MAP_PLAN_CACHE);
  const value: CachedProfileMapAssets = {
    schemaVersion: PROFILE_MAP_PLAN_SCHEMA,
    profile,
    mapVersionId: map.mapVersionId,
    browserClosureSha256: map.browserClosureSha256 ?? null,
    assets,
  };
  await cache.put(planCacheRequest(map, profile), new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  })).catch(() => undefined);
}

/** Fetch a stable first-party map URL from persistent storage before the network. */
export async function fetchProfileMapAsset(
  url: string,
  init: RequestInit = {},
  contentSha256?: string,
): Promise<Response> {
  return fetchMapAsset(url, init, contentSha256);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        const value = values[index];
        if (value !== undefined) output[index] = await worker(value, index);
      }
    }),
  );
  return output;
}

export function profileMapDownloadConcurrency(): number {
  if (typeof navigator === "undefined") return MIN_DOWNLOAD_CONCURRENCY;
  const connection = (navigator as Navigator & {
    connection?: { effectiveType?: string; saveData?: boolean };
  }).connection;
  if (connection?.saveData || connection?.effectiveType === "2g") {
    return MIN_DOWNLOAD_CONCURRENCY;
  }
  const cores = navigator.hardwareConcurrency || 4;
  if (connection?.effectiveType === "4g" && cores >= 8) {
    return MAX_DOWNLOAD_CONCURRENCY;
  }
  return cores >= 8 ? 10 : MIN_DOWNLOAD_CONCURRENCY;
}

function batchDownloadRequest(asset: ProfileMapAsset) {
  const url = new URL(asset.url, window.location.origin);
  const match = /^\/api\/scenario\/maps\/([^/]+)\/browser-assets\/(.+)$/.exec(
    url.pathname,
  );
  if (!match?.[1] || !match[2]) return null;
  return {
    mapVersionId: decodeURIComponent(match[1]),
    relativePath: decodeURIComponent(match[2]),
  };
}

async function resolveBatchDownloadUrls(
  assets: ProfileMapAsset[],
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const requested = assets.flatMap((asset) => {
    const parsed = batchDownloadRequest(asset);
    return parsed ? [{ assetUrl: asset.url, ...parsed }] : [];
  });
  if (requested.length === 0) return new Map();
  try {
    const response = await fetch("/api/simforge/maps/cache-download-urls", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assets: requested.map(({ mapVersionId, relativePath }) => ({
          mapVersionId,
          relativePath,
        })),
      }),
      signal,
    });
    if (!response.ok) return new Map();
    const payload = await response.json() as {
      assets?: Array<{ mapVersionId: string; relativePath: string; url: string }>;
    };
    const canonicalByKey = new Map(
      requested.map(({ assetUrl, mapVersionId, relativePath }) => [
        `${mapVersionId}\n${relativePath}`,
        assetUrl,
      ]),
    );
    return new Map((payload.assets ?? []).flatMap((asset) => {
      const canonical = canonicalByKey.get(
        `${asset.mapVersionId}\n${asset.relativePath}`,
      );
      return canonical && typeof asset.url === "string"
        ? [[canonical, asset.url] as const]
        : [];
    }));
  } catch {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return new Map();
  }
}

async function withAssetAttemptDeadline<T>(
  signal: AbortSignal,
  worker: (attemptSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutError = new DOMException("Asset download timed out", "TimeoutError");
  let rejectDeadline: (reason: DOMException) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
    timeoutId = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, PROFILE_MAP_ASSET_ATTEMPT_TIMEOUT_MS);
  });
  const abortFromParent = () => {
    const abortError = new DOMException("Aborted", "AbortError");
    controller.abort(signal.reason ?? abortError);
    rejectDeadline(abortError);
  };
  signal.addEventListener("abort", abortFromParent, { once: true });
  try {
    return await Promise.race([worker(controller.signal), deadline]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    signal.removeEventListener("abort", abortFromParent);
  }
}

function selectedFile(
  sourceFile: string,
  profile: RenderingPreference,
  variants: CityAssetVariantManifest | null,
): { file: string; bytes: number | null; sha256?: string } {
  const roadsOnly = profile === "roads-only";
  const ultraLow = profile === "ultra-low-3d" || roadsOnly;
  const selected = selectAssetVariant(variants, sourceFile, "auto", {
    ultraLow,
    roadsOnly,
    ktx2Ready: Boolean(variants?.variants.ktx2?.runtime?.ktx2TranscoderPath),
  });
  const bytes = selected.variant === "original"
    ? null
    : variants?.variants[selected.variant]?.files[sourceFile]?.bytes ?? null;
  return { file: selected.file, bytes, sha256: selected.sha256 };
}

function uniqueAssets(assets: ProfileMapAsset[]): ProfileMapAsset[] {
  const unique = new Map<string, ProfileMapAsset>();
  for (const asset of assets) {
    const key = asset.sha256 && /^[a-f0-9]{64}$/.test(asset.sha256)
      ? `sha256:${asset.sha256}`
      : asset.url;
    const previous = unique.get(key);
    if (!previous || (previous.bytes === null && asset.bytes !== null)) unique.set(key, asset);
  }
  return [...unique.values()];
}

/**
 * Match the renderer's admission rule exactly: index 0 is the pinned coarse
 * fallback, while finer assets larger than 45% of the profile byte budget can
 * never be selected. Keeping them in an offline plan only wastes disk.
 */
function reachableLods(
  lods: Parameters<typeof normalizeLods>[0],
  profile: RenderingPreference,
) {
  const normalized = normalizeLods(lods);
  const maximumAssetBytes = AUTHORING_QUALITY[profile].live.byteBudget * 0.45;
  return normalized.filter((lod, index) => index === 0 || estimateLodBytes(lod) <= maximumAssetBytes);
}

async function jsonAsset<T>(url: string, signal: AbortSignal): Promise<{ value: T; bytes: number | null }> {
  const response = await fetchProfileMapAsset(url, { signal });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const contentLength = Number(response.headers.get("content-length"));
  return {
    value: (await response.json()) as T,
    bytes: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
  };
}

async function discoverMapAssets(
  map: ScenarioMapOption,
  profile: RenderingPreference,
  signal: AbortSignal,
): Promise<ProfileMapAsset[]> {
  if (!map.browserManifestUrl) return [];
  const cached = await readCachedMapAssets(map, profile);
  if (cached) return cached;
  const manifestUrl = map.browserManifestUrl;
  const assetBase = manifestUrl.replace(/[^/]*$/, "");
  const variantUrl = resolveUrl(assetBase, "variants/manifest.json");
  const manifestResult = await jsonAsset<CityManifest>(manifestUrl, signal);
  const variantResult = await jsonAsset<unknown>(variantUrl, signal).catch(() => null);
  const variants = variantResult && isCityAssetVariantManifest(variantResult.value)
    ? variantResult.value
    : null;
  const manifest = manifestResult.value;
  const assets: ProfileMapAsset[] = [
    { url: manifestUrl, bytes: manifestResult.bytes, mapVersionId: map.mapVersionId },
  ];
  for (const url of [map.topologyUrl, map.derivedTopologyUrl, map.locationsUrl, map.signalsUrl]) {
    if (url) assets.push({ url, bytes: null, mapVersionId: map.mapVersionId });
  }
  if (variantResult) {
    assets.push({ url: variantUrl, bytes: variantResult.bytes, mapVersionId: map.mapVersionId });
  }

  const sourceFiles: Array<{ file: string; bytes: number }> = [];
  const road = manifest.staticLayers?.find((layer) => layer.id === "road");
  if (road) sourceFiles.push({ file: road.file, bytes: road.fileSize });
  if (profile !== "roads-only") {
    for (const tile of manifest.tiles) {
      for (const lod of reachableLods(tile.lods, profile)) {
        sourceFiles.push({ file: lod.file, bytes: lod.fileSize });
      }
    }
  }
  if (profile === "high") {
    // Prefer the pipeline's merged instance sidecar (one file) and fall back
    // to warming every per-tile sidecar for releases that predate it.
    // Newer pipeline product not yet in the packaged manifest type union.
    const mergedInstances = (
      variants?.variants as
        | Record<string, { file?: string; bytes?: number } | undefined>
        | undefined
    )?.["vegetation-instances"];
    const hasMergedInstances =
      typeof mergedInstances?.file === "string" && mergedInstances.file.length > 0;
    if (hasMergedInstances && (manifest.vegetationTiles?.length ?? 0) > 0) {
      assets.push({
        url: resolveUrl(assetBase, mergedInstances.file!),
        bytes: mergedInstances.bytes ?? null,
        mapVersionId: map.mapVersionId,
      });
    }
    for (const tile of manifest.vegetationTiles ?? []) {
      for (const lod of reachableLods(tile.lods, profile)) {
        sourceFiles.push({ file: lod.file, bytes: lod.fileSize });
      }
      if (!hasMergedInstances && typeof tile.instanceFile === "string" && tile.instanceFile.length > 0) {
        assets.push({
          url: resolveUrl(assetBase, tile.instanceFile),
          bytes: null,
          mapVersionId: map.mapVersionId,
        });
      }
    }
  }
  if (road && profile !== "roads-only" && variants?.variants["geometry-only"]?.files[road.file]) {
    const bootstrap = selectAssetVariant(variants, road.file, "geometry-only", {
      ultraLow: false,
      roadsOnly: false,
      ktx2Ready: false,
    });
    assets.push({
      url: resolveUrl(assetBase, bootstrap.file),
      bytes: variants.variants["geometry-only"].files[road.file]?.bytes ?? null,
      mapVersionId: map.mapVersionId,
      sha256: bootstrap.sha256,
    });
  }
  for (const source of sourceFiles) {
    const selected = selectedFile(source.file, profile, variants);
    assets.push({
      url: resolveUrl(assetBase, selected.file),
      bytes: selected.bytes ?? source.bytes,
      mapVersionId: map.mapVersionId,
      sha256: selected.sha256,
    });
  }

  if (profile === "minimal" || profile === "high") {
    // No `env/sky.hdr`: the renderer generates its atmosphere and derives the
    // image-based light from it, so there is no environment asset to prefetch.
    // Uploaded maps never shipped one anyway — that request 404'd.
    for (const tile of manifest.tiles) {
      for (const shadow of tile.shadowLightmaps ?? []) {
        if (shadow.file) assets.push({
          url: resolveUrl(assetBase, shadow.file),
          bytes: null,
          mapVersionId: map.mapVersionId,
        });
      }
    }
    for (const runtimeAsset of variants?.variants.ktx2?.runtime?.assets ?? []) {
      assets.push({
        url: resolveUrl(assetBase, runtimeAsset.file),
        bytes: null,
        mapVersionId: map.mapVersionId,
        sha256: runtimeAsset.sha256,
      });
    }
  }
  const discovered = uniqueAssets(assets);
  await writeCachedMapAssets(map, profile, discovered);
  return discovered;
}

export async function createProfileMapPlan(
  maps: readonly ScenarioMapOption[],
  profile: RenderingPreference,
  signal: AbortSignal,
): Promise<ProfileMapPlan> {
  const inventoryResponse = await fetch("/api/simforge/maps/cache-plan", { signal });
  if (!inventoryResponse.ok) {
    throw new Error(`Map cache inventory could not be loaded (${inventoryResponse.status}).`);
  }
  const inventory = await inventoryResponse.json() as CacheInventory;
  const verified = new Map<string, { sha256: string; byteLength: number }>();
  const mapById = new Map(inventory.maps.map((entry) => [entry.mapVersionId, entry]));
  for (const map of inventory.maps) {
    for (const asset of map.assets) {
      verified.set(
        new URL(
          `/api/simforge/maps/${encodeURIComponent(map.mapVersionId)}/browser-assets/${asset.relativePath}`,
          window.location.origin,
        ).href,
        { sha256: asset.sha256, byteLength: asset.byteLength },
      );
    }
  }
  const discovered = (
    await mapWithConcurrency(maps, MAX_DISCOVERY_CONCURRENCY, (map) =>
      discoverMapAssets(map, profile, signal),
    )
  ).flat();
  const verifiedDiscovered: ProfileMapAsset[] = discovered.map((asset) => {
    const identity = verified.get(new URL(asset.url, window.location.origin).href);
    if (!identity) {
      throw new Error(`Active browser bundle does not contain ${asset.url}`);
    }
    return { ...asset, bytes: identity.byteLength, sha256: identity.sha256 };
  });
  let requiresSumoRuntime = false;
  for (const map of maps) {
    const inventoryMap = mapById.get(map.mapVersionId);
    for (const asset of inventoryMap?.assets ?? []) {
      if (!asset.relativePath.startsWith("derived/sumo/")) continue;
      requiresSumoRuntime = true;
      verifiedDiscovered.push({
        url: `/api/simforge/maps/${encodeURIComponent(map.mapVersionId)}/browser-assets/${asset.relativePath}`,
        bytes: asset.byteLength,
        sha256: asset.sha256,
        mapVersionId: map.mapVersionId,
      });
    }
  }
  if (requiresSumoRuntime) {
    const runtimeAssets = await Promise.all(
      [SUMO_RUNTIME_MANIFEST_URL, SUMO_RUNTIME_MODULE_URL, SUMO_RUNTIME_WASM_URL]
        .map(async (url): Promise<ProfileMapAsset> => {
          const head = await fetch(url, { method: "HEAD", signal });
          if (!head.ok) throw new Error(`SUMO runtime cache asset is unavailable (${head.status}).`);
          let bytes = Number(head.headers.get("content-length"));
          // Dynamic hosting layers may legitimately strip Content-Length from a
          // HEAD response even though the backing S3 object has a verified size.
          // A one-byte range preserves the object's total length in
          // Content-Range without downloading the runtime (notably sumo.wasm).
          if (!Number.isSafeInteger(bytes) || bytes <= 0) {
            const range = await fetch(url, {
              headers: { Range: "bytes=0-0" },
              signal,
            });
            if (!range.ok) {
              throw new Error(`SUMO runtime cache asset is unavailable (${range.status}).`);
            }
            const total = /\/(\d+)$/.exec(range.headers.get("content-range") ?? "")?.[1];
            bytes = Number(total ?? (range.status === 200 ? range.headers.get("content-length") : null));
            await range.body?.cancel().catch(() => undefined);
          }
          if (!Number.isSafeInteger(bytes) || bytes <= 0) {
            throw new Error(`SUMO runtime cache asset has no verified size: ${url}`);
          }
          return { url, bytes, mapVersionId: "sumo-runtime" };
        }),
    );
    verifiedDiscovered.push(...runtimeAssets);
  }
  const assets = uniqueAssets(verifiedDiscovered);
  let remainingBytes = 0;
  let remainingAssets = 0;
  const cachedAssets = await mapWithConcurrency(
    assets,
    MAX_CACHE_LOOKUP_CONCURRENCY,
    (asset) => hasCachedMapAsset(asset.url, asset.sha256),
  );
  const pendingAssets: ProfileMapAsset[] = [];
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index];
    if (asset && !cachedAssets[index]) {
      pendingAssets.push(asset);
      remainingAssets++;
      remainingBytes += asset.bytes ?? 0;
    }
  }
  return {
    releaseKey: inventory.releaseKey,
    profile,
    mapCount: maps.filter((map) => Boolean(map.browserManifestUrl)).length,
    assets,
    pendingAssets,
    totalBytes: assets.reduce((total, asset) => total + (asset.bytes ?? 0), 0),
    remainingBytes,
    remainingAssets,
    unknownSizeAssets: assets.filter((asset) => asset.bytes === null).length,
  };
}

export async function cacheProfileMapPlan(
  plan: ProfileMapPlan,
  signal: AbortSignal,
  onProgress: (progress: ProfileMapCacheProgress) => void,
): Promise<ProfileMapCacheResult> {
  await prepareMapAssetCache();
  const available = await availableStorageBytes();
  if (available !== null && plan.remainingBytes > available * 0.9) {
    throw new Error(
      `Caching requires ${Math.ceil(plan.remainingBytes / (1024 * 1024))} MB, but this browser has only ${Math.floor(available / (1024 * 1024))} MB available.`,
    );
  }
  let completedAssets = 0;
  let completedBytes = 0;
  let failedAssets = 0;
  const assetsToCache = plan.pendingAssets ?? plan.assets;
  const report = (mapVersionId: string | null) => onProgress({
    completedAssets,
    totalAssets: assetsToCache.length,
    completedBytes,
    totalBytes: plan.remainingBytes,
    currentMapVersionId: mapVersionId,
  });
  report(null);
  try {
    for (let offset = 0; offset < assetsToCache.length; offset += DOWNLOAD_URL_BATCH_SIZE) {
      const batch = assetsToCache.slice(offset, offset + DOWNLOAD_URL_BATCH_SIZE);
      const downloadUrls = await resolveBatchDownloadUrls(batch, signal);
      await mapWithConcurrency(batch, profileMapDownloadConcurrency(), async (asset) => {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        let stored = false;
        for (let attempt = 0; attempt < MAX_ASSET_DOWNLOAD_ATTEMPTS && !stored; attempt += 1) {
          try {
            await withAssetAttemptDeadline(signal, async (attemptSignal) => {
              const response = await fetchMapAsset(
                asset.url,
                { credentials: "same-origin", signal: attemptSignal },
                asset.sha256,
                downloadUrls.get(asset.url),
                true,
              );
              if (!response.ok) throw new Error(`${response.status} ${asset.url}`);
            });
            stored = true;
          } catch {
            if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            if (attempt + 1 === MAX_ASSET_DOWNLOAD_ATTEMPTS) failedAssets += 1;
          }
        }
        completedAssets++;
        completedBytes += asset.bytes ?? 0;
        report(asset.mapVersionId);
      });
    }
  } finally {
    flushMapAssetCacheIndex();
  }
  report(null);
  return { failedAssets };
}
