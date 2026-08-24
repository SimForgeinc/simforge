import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";

import type { RuntimeMapResponse } from "@/app/lib/runtime/runtime-types";
import {
  buildRuntimeMapArtifactManifestKey,
  getRuntimeMapArtifactBucket,
} from "@/app/lib/editor-map/runtime-map-artifacts";
import { getS3ObjectUtf8 } from "@/app/lib/s3/s3-get-object";

const ManifestSectionSchema = z.object({
  key: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  size_bytes_raw: z.number().int().nonnegative(),
  size_bytes_stored: z.number().int().nonnegative(),
  encoding: z.enum(["json", "text"]),
});

const RuntimeTopologyManifestSchema = z.object({
  contract: z.literal("simforge.map-bundle-manifest.v1"),
  bundle_version: z.string().min(1),
  map_name: z.string().min(1),
  normalized_map_name: z.string().min(1),
  created_at: z.string().min(1),
  base: z.object({
    schema_version: z.number().int().positive(),
    source: z.object({
      authority: z.literal("maintenance_materializer"),
      map_asset_id: z.string().nullable().optional(),
      carla_version: z.string().nullable().optional(),
      image: z.string().nullable().optional(),
      image_digest: z.string().nullable().optional(),
      actor_catalog_version: z.string().nullable().optional(),
      actor_catalog_hash: z.string().nullable().optional(),
    }).passthrough(),
  }),
  sections: z.record(ManifestSectionSchema),
});

export type RuntimeTopologyManifest = z.infer<typeof RuntimeTopologyManifestSchema>;

export type RuntimeTopologyBundleInput = {
  mapName: string;
  normalizedMapName: string;
  bundleVersion: string;
  mapAssetId: string | null;
  imageDigest: string | null;
  carlaVersion: string | null;
  xodr: string;
  xodrSha256: string;
  runtimeRoadGraphSha256: string;
  runtime: RuntimeMapResponse;
};

export type RuntimeTopologyBundleErrorCode =
  | "manifest_missing"
  | "manifest_invalid"
  | "bundle_identity_mismatch"
  | "required_section_missing"
  | "section_key_invalid"
  | "section_checksum_mismatch"
  | "section_size_mismatch"
  | "section_payload_invalid"
  | "xodr_runtime_mismatch";

export class RuntimeTopologyBundleError extends Error {
  constructor(
    readonly code: RuntimeTopologyBundleErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    /**
     * The fault underneath, when there was one.
     *
     * `manifest_missing` covers both "this map has never been cooked" and "S3
     * timed out reaching for its manifest", and callers answer those very
     * differently — 404 for the first, 503 with `Retry-After` for the second.
     * They can only tell them apart if the original error survives the wrap.
     */
    cause?: unknown,
  ) {
    super(message);
    this.name = "RuntimeTopologyBundleError";
    if (cause !== undefined) this.cause = cause;
  }
}
function normalizeMapName(value: string): string {
  const tail = value.replace(/\\/g, "/").split("/").pop() ?? value;
  return tail.endsWith(".xodr") ? tail.slice(0, -5) : tail;
}

function safeMapSegment(value: string): string {
  return normalizeMapName(value).replace(/[^A-Za-z0-9._-]/g, "_");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expectedSectionPrefix(mapName: string, bundleVersion: string): string {
  return `map-bundles/${bundleVersion}/${safeMapSegment(mapName)}/`;
}

async function readVerifiedSection(
  bucket: string,
  prefix: string,
  name: string,
  section: z.infer<typeof ManifestSectionSchema> | undefined,
): Promise<string> {
  if (!section) {
    throw new RuntimeTopologyBundleError(
      "required_section_missing",
      `Runtime map bundle is missing required section: ${name}.`,
      { section: name },
    );
  }
  if (!section.key.startsWith(prefix) || section.key.includes("..")) {
    throw new RuntimeTopologyBundleError(
      "section_key_invalid",
      `Runtime map bundle section ${name} is outside the bundle prefix.`,
      { section: name },
    );
  }

  const raw = await getS3ObjectUtf8(bucket, section.key);
  const actualSize = Buffer.byteLength(raw, "utf8");
  if (actualSize !== section.size_bytes_raw) {
    throw new RuntimeTopologyBundleError(
      "section_size_mismatch",
      `Runtime map bundle section ${name} has an unexpected size.`,
      { section: name, expected: section.size_bytes_raw, actual: actualSize },
    );
  }
  const actualSha = sha256(raw);
  if (actualSha !== section.sha256.toLowerCase()) {
    throw new RuntimeTopologyBundleError(
      "section_checksum_mismatch",
      `Runtime map bundle section ${name} failed checksum verification.`,
      { section: name, expected: section.sha256, actual: actualSha },
    );
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

/**
 * ## Why there is a cache here at all
 *
 * `readRuntimeTopologyBundleInput` had none, and ten call sites — six of them
 * on the scenario editor's load path (the runtime-bound topology index, lane
 * travel directions, the corridor context, the route-planner graph, the editor
 * traffic-light projection, and the XODR signal groups). Each of those kept a
 * private cache of ITS OWN projection of these bytes, so the projections were
 * cached and the multi-megabyte read that produced them was not: one editor
 * open downloaded, gunzipped, hashed and `JSON.parse`d the same bundle up to
 * six times. Measured cold 4.4–7.5 s against warm 0.46–0.65 s on the
 * topology-backed routes.
 *
 * ## Why it is not simply a map of every bundle ever read
 *
 * These bundles are enormous, and unevenly so. Raw section bytes on dev
 * (2026-07-27): Munich_Phase_1A 44 MB, Yale_St_Palo_Alto_CA 56 MB,
 * San_Ramon_Phase_1_P1 202 MB — and the parsed `road_segments` cost several
 * times their JSON length in heap. Retaining a fixed COUNT of entries would
 * mean the memory ceiling was set by whichever maps happened to be opened, and
 * two San Ramons would dwarf everything else this process holds. The sibling
 * `topology-index-service` went the other way for exactly this reason: it
 * deliberately drops the crawl and keeps only the derived answer.
 *
 * So retention is budgeted in BYTES, using the raw section sizes the manifest
 * already declares, and a bundle bigger than the whole budget is never retained
 * at all — it still gets in-flight coalescing, which is where most of a single
 * editor open's duplication lives, but it does not sit in memory afterwards.
 *
 * ## What this does not buy
 *
 * This app deploys to Vercel serverless. The cache is per instance and dies
 * with it, so a cold instance and the first request after a deploy pay full
 * price, and concurrent instances each keep their own copy. It makes a warm
 * instance's editor opens cheap; it is not a substitute for a shared cache.
 */
const BUNDLE_CACHE_TTL_MS = positiveEnvNumber("RUNTIME_BUNDLE_CACHE_TTL_MS", 60_000);
const BUNDLE_CACHE_MAX_BYTES = positiveEnvNumber(
  "RUNTIME_BUNDLE_CACHE_MAX_BYTES",
  64 * 1024 * 1024,
);
/** Manifests are kilobytes, and are read once per bundle read plus once by the
 * topology service's pre-read cache probe. Short TTL: this is the object that
 * tells us a republished bundle exists. */
const MANIFEST_CACHE_TTL_MS = positiveEnvNumber("RUNTIME_BUNDLE_MANIFEST_TTL_MS", 30_000);

function positiveEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

type CacheEntry<T> = { value: T; expiresAt: number; weightBytes: number };

const bundleCache = new Map<string, CacheEntry<RuntimeTopologyBundleInput>>();
const bundleInFlight = new Map<string, Promise<RuntimeTopologyBundleInput>>();
const manifestCache = new Map<string, CacheEntry<RuntimeTopologyManifest>>();
const manifestInFlight = new Map<string, Promise<RuntimeTopologyManifest>>();

let bundleCacheBytes = 0;

function cacheKey(mapName: string, bundleVersion: string): string {
  return `${bundleVersion} ${normalizeMapName(mapName)}`;
}

function readFresh<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    if (cache === bundleCache) bundleCacheBytes -= entry.weightBytes;
    return null;
  }
  // Refresh insertion order so the LRU end really is the least recent.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

/**
 * The raw bytes this bundle's retained sections came from.
 *
 * A proxy for heap cost, not a measurement of it — the parsed objects are
 * larger than their JSON, by a factor that varies with segment shape. It is the
 * only figure available before the read, and it ranks maps correctly, which is
 * all the budget needs it to do.
 */
function retainedWeightBytes(manifest: RuntimeTopologyManifest): number {
  let total = 0;
  for (const name of ["xodr", "runtime_meta", "runtime_segments"] as const) {
    total += manifest.sections[name]?.size_bytes_raw ?? 0;
  }
  return total;
}

function rememberBundle(
  key: string,
  value: RuntimeTopologyBundleInput,
  weightBytes: number,
): void {
  if (BUNDLE_CACHE_TTL_MS <= 0 || BUNDLE_CACHE_MAX_BYTES <= 0) return;
  // A bundle that cannot fit the whole budget is never retained: admitting it
  // would evict everything else to hold one map, which is worse than a miss.
  if (weightBytes > BUNDLE_CACHE_MAX_BYTES) return;

  const existing = bundleCache.get(key);
  if (existing) bundleCacheBytes -= existing.weightBytes;
  bundleCache.delete(key);
  bundleCache.set(key, { value, weightBytes, expiresAt: Date.now() + BUNDLE_CACHE_TTL_MS });
  bundleCacheBytes += weightBytes;

  while (bundleCacheBytes > BUNDLE_CACHE_MAX_BYTES) {
    const oldest = bundleCache.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    const evicted = bundleCache.get(oldest);
    bundleCache.delete(oldest);
    if (evicted) bundleCacheBytes -= evicted.weightBytes;
  }
}

/**
 * Drop everything retained here.
 *
 * Wired into `evictTopologyCache`, which callers use to release memory after
 * request-scoped bulk compilation; a bundle cache that survived that would
 * defeat the release it exists to perform.
 */
export function evictRuntimeTopologyBundleCache(): void {
  bundleCache.clear();
  manifestCache.clear();
  bundleCacheBytes = 0;
}

/** Test seam: drop caches AND any in-flight coalescing. */
export function __clearRuntimeTopologyBundleCacheForTests(): void {
  evictRuntimeTopologyBundleCache();
  bundleInFlight.clear();
  manifestInFlight.clear();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function fetchManifest(
  mapName: string,
  bundleVersion: string,
): Promise<RuntimeTopologyManifest> {
  const bucket = getRuntimeMapArtifactBucket();
  let manifestRaw: string;
  try {
    manifestRaw = await getS3ObjectUtf8(
      bucket,
      buildRuntimeMapArtifactManifestKey(mapName, bundleVersion),
    );
  } catch (error) {
    throw new RuntimeTopologyBundleError(
      "manifest_missing",
      `Runtime map bundle manifest is unavailable for ${mapName}.`,
      { cause: error instanceof Error ? error.message : String(error) },
      error,
    );
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch {
    throw new RuntimeTopologyBundleError(
      "manifest_invalid",
      `Runtime map bundle manifest for ${mapName} is not valid JSON.`,
    );
  }
  const parsed = RuntimeTopologyManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    throw new RuntimeTopologyBundleError(
      "manifest_invalid",
      `Runtime map bundle manifest for ${mapName} failed schema validation.`,
      { issues: parsed.error.issues.map(({ code, path, message }) => ({ code, path, message })) },
    );
  }
  const manifest = parsed.data;
  if (
    manifest.bundle_version !== bundleVersion ||
    normalizeMapName(manifest.normalized_map_name) !== normalizeMapName(mapName)
  ) {
    throw new RuntimeTopologyBundleError(
      "bundle_identity_mismatch",
      `Runtime map bundle manifest identity does not match the requested map/version.`,
      {
        requestedMapName: normalizeMapName(mapName),
        manifestMapName: normalizeMapName(manifest.normalized_map_name),
        requestedBundleVersion: bundleVersion,
        manifestBundleVersion: manifest.bundle_version,
      },
    );
  }
  return manifest;
}

/**
 * The bundle's manifest alone — identity, section keys, and each section's
 * sha256 and size.
 *
 * Kilobytes, where the bundle it describes is tens to hundreds of megabytes.
 * That gap is the point: a caller that only needs to know WHICH bytes a bundle
 * is made of (to key a cache, or to check provenance) can answer from this and
 * never read the sections. See `topology-index-service`, which uses it to
 * decide whether it already holds the compiled index.
 *
 * Failures are never cached.
 */
export async function readRuntimeTopologyBundleManifest(
  mapName: string,
  bundleVersion: string,
): Promise<RuntimeTopologyManifest> {
  const key = cacheKey(mapName, bundleVersion);
  const cached = readFresh(manifestCache, key);
  if (cached) return cached;
  const inFlight = manifestInFlight.get(key);
  if (inFlight) return inFlight;

  const pending = fetchManifest(mapName, bundleVersion);
  manifestInFlight.set(key, pending);
  try {
    const manifest = await pending;
    if (MANIFEST_CACHE_TTL_MS > 0) {
      manifestCache.set(key, {
        value: manifest,
        weightBytes: 0,
        expiresAt: Date.now() + MANIFEST_CACHE_TTL_MS,
      });
    }
    return manifest;
  } finally {
    if (manifestInFlight.get(key) === pending) manifestInFlight.delete(key);
  }
}

/**
 * One manifest-pinned section of a bundle, verified exactly the way the
 * topology inputs are: the key must sit under this map/version's prefix, and
 * the bytes must match the manifest's size AND sha256.
 *
 * Exists for the sections `readRuntimeTopologyBundleInput` deliberately does
 * not read — `environment_objects` (the cooked static-mesh inventory) is only
 * needed by callers that reason about props, and is megabytes.
 *
 * NOT cached: a caller that wants a section repeatedly should cache its own
 * kilobyte-sized projection of it, never the section itself (the pattern in
 * `scenario-editor/signals/editor-traffic-lights.server.ts`).
 */
export async function readVerifiedRuntimeBundleSection(
  mapName: string,
  bundleVersion: string,
  sectionName: string,
): Promise<string> {
  const manifest = await readRuntimeTopologyBundleManifest(mapName, bundleVersion);
  return readVerifiedSection(
    getRuntimeMapArtifactBucket(),
    expectedSectionPrefix(mapName, bundleVersion),
    sectionName,
    manifest.sections[sectionName],
  );
}

/**
 * Read only the exact, manifest-pinned inputs needed to build semantic/runtime
 * topology. There is deliberately no monolith or uploaded-map-XODR fallback.
 *
 * Cached and in-flight-coalesced; see the cache notes above. The value handed
 * back is SHARED between callers and must be treated as read-only. Every
 * current call site was audited for in-place mutation before this became
 * shared — the two seams that alias into it rather than copying are
 * `crawlWaypointsByRsl` and `runtimeRoadAnchors`, and both only read.
 */
export async function readRuntimeTopologyBundleInput(
  mapName: string,
  bundleVersion: string,
): Promise<RuntimeTopologyBundleInput> {
  const key = cacheKey(mapName, bundleVersion);
  const cached = readFresh(bundleCache, key);
  if (cached) return cached;
  const inFlight = bundleInFlight.get(key);
  if (inFlight) return inFlight;

  const pending = fetchBundleInput(mapName, bundleVersion);
  bundleInFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    // Only successes reach `rememberBundle` (inside `fetchBundleInput`), so a
    // failed read leaves nothing behind: a transient S3 fault must not pin a
    // negative answer to a long-lived web process.
    if (bundleInFlight.get(key) === pending) bundleInFlight.delete(key);
  }
}

async function fetchBundleInput(
  mapName: string,
  bundleVersion: string,
): Promise<RuntimeTopologyBundleInput> {
  const bucket = getRuntimeMapArtifactBucket();
  const manifest = await readRuntimeTopologyBundleManifest(mapName, bundleVersion);

  const prefix = expectedSectionPrefix(mapName, bundleVersion);
  const [xodr, runtimeMetaRaw, runtimeSegmentsRaw] = await Promise.all([
    readVerifiedSection(bucket, prefix, "xodr", manifest.sections.xodr),
    readVerifiedSection(bucket, prefix, "runtime_meta", manifest.sections.runtime_meta),
    readVerifiedSection(
      bucket,
      prefix,
      "runtime_segments",
      manifest.sections.runtime_segments,
    ),
  ]);

  let runtimeMeta: Record<string, unknown>;
  let roadSegments: unknown;
  try {
    runtimeMeta = JSON.parse(runtimeMetaRaw) as Record<string, unknown>;
    roadSegments = JSON.parse(runtimeSegmentsRaw);
  } catch {
    throw new RuntimeTopologyBundleError(
      "section_payload_invalid",
      `Runtime map bundle topology inputs are not valid JSON.`,
    );
  }
  if (!Array.isArray(roadSegments)) {
    throw new RuntimeTopologyBundleError(
      "section_payload_invalid",
      `Runtime map bundle road segments section is not an array.`,
    );
  }
  const runtime = {
    ...runtimeMeta,
    road_segments: roadSegments,
  } as RuntimeMapResponse;
  const xodrSha256 = sha256(xodr);
  const runtimeOpenDriveSha = runtime.map_info?.opendrive_sha256?.trim().toLowerCase();
  if (!runtimeOpenDriveSha || runtimeOpenDriveSha !== xodrSha256) {
    throw new RuntimeTopologyBundleError(
      "xodr_runtime_mismatch",
      `Runtime map bundle XODR does not match the runtime waypoint crawl.`,
      {
        bundleXodrSha256: xodrSha256,
        runtimeOpenDriveSha256: runtimeOpenDriveSha ?? null,
      },
    );
  }

  const input: RuntimeTopologyBundleInput = {
    mapName: manifest.map_name,
    normalizedMapName: manifest.normalized_map_name,
    bundleVersion: manifest.bundle_version,
    mapAssetId: manifest.base.source.map_asset_id ?? null,
    imageDigest: manifest.base.source.image_digest ?? null,
    carlaVersion: manifest.base.source.carla_version ?? null,
    xodr,
    xodrSha256,
    runtimeRoadGraphSha256: sha256(runtimeSegmentsRaw),
    runtime,
  };
  rememberBundle(
    cacheKey(mapName, bundleVersion),
    input,
    retainedWeightBytes(manifest),
  );
  return input;
}
