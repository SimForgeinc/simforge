import "server-only";

import {
  createHash } from "node:crypto";
import {
  bindRuntimeTopology,
} from "@simforge-oss/maps/topology";
import {
  buildMapTopologyIndex,
  type RuntimeBoundMapTopologyIndex,
  type RuntimeTopologyFamily,
  type RuntimeTopologyProvenance,
} from "@simforge-oss/maps/topology";
import {
  getRuntimeMapArtifactVersion,
  headRuntimeMapArtifactManifest,
} from "@/app/lib/editor-map/runtime-map-artifacts";
import {
  evictRuntimeTopologyBundleCache,
  readRuntimeTopologyBundleInput,
  readRuntimeTopologyBundleManifest,
  RuntimeTopologyBundleError,
} from "@/app/lib/editor-map/runtime-topology-bundle";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import {
  crawlWaypointsByRsl,
  polylineFollowsTravel,
} from "./lane-travel-direction";
import type { RuntimeMapResponse } from "@/app/lib/runtime/runtime-types";
import {
  getRuntimeCatalogVersion,
  readCarlaRuntimeCatalogFromS3,
} from "@/app/lib/scenario-editor/runtime-catalog";
import {
  readAcceptedSemanticGraphPublication,
  SemanticGraphPublicationError,
} from "./semantic-graph-publication-store";

/**
 * v3 on 2026-07-30: `buildRuntimeTopologyParity` now binds link-attested lanes,
 * so `boundLaneRsls`, `boundGateIds` and the new `linkAttestedLaneRsls` all
 * differ from a v2 index over the same bundle.
 */
export const RUNTIME_BOUND_TOPOLOGY_COMPILER_VERSION =
  "simforge.runtime-bound-topology.v3";

/** Bump when `polylineFollowsTravel` changes, to invalidate cached answers. */
const LANE_TRAVEL_DIRECTION_VERSION = "simforge.lane-travel-direction.v1";

export type TopologyUnavailableCode =
  | "runtime_unresolved"
  | "map_asset_missing"
  | "runtime_map_unbound"
  | "runtime_catalog_unconfigured"
  | "runtime_catalog_missing"
  | "runtime_catalog_mismatch"
  | "runtime_bundle_missing"
  | "runtime_bundle_identity_mismatch"
  | "runtime_bundle_incomplete"
  | "runtime_bundle_integrity_failure"
  | "runtime_xodr_hash_mismatch"
  | "runtime_topology_partial"
  | "runtime_topology_incompatible";

export class TopologyUnavailableError extends Error {
  constructor(
    readonly code: TopologyUnavailableCode,
    readonly mapAssetId: string,
    reason: string,
    readonly details: Record<string, unknown> = {},
    /**
     * The underlying fault, when this wraps one.
     *
     * Carried so a route can tell "this map has no runtime bundle" from "S3 was
     * unreachable for a second" — both arrive here as `runtime_bundle_missing`,
     * and one of them deserves a 503 with `Retry-After` rather than a flat 422.
     */
    cause?: unknown,
  ) {
    super(`topology unavailable for ${mapAssetId}: ${reason}`);
    this.name = "TopologyUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * A compiled index, plus the travel directions resolved alongside it.
 *
 * On the compile path the directions are already stamped onto
 * `index.laneTravelIncreasesS`; this mirrors them so the published path, whose
 * index predates the field, has somewhere to put its lazily-read answer.
 */
export type RuntimeBoundMapTopology = {
  index: RuntimeBoundMapTopologyIndex;
  /**
   * Per-lane travel direction, resolved from the crawl while it was still in
   * hand — see `getRuntimeLaneTravelDirections`.
   *
   * Null when the index came from an accepted semantic-graph publication,
   * which stores the compiled index but not the crawl it was compiled from;
   * that case re-reads the bundle lazily instead.
   *
   * Deliberately the DERIVED answer rather than the crawl itself: the crawl is
   * the largest object in this module by far, and holding one per cached map
   * would undo the release that `evictTopologyCache` exists to perform.
   */
  laneTravelFollowsPolyline: ReadonlyMap<string, boolean> | null;
};

type CacheEntry = {
  key: string;
  value: RuntimeBoundMapTopology;
};

const MAX_ENTRIES = 8;
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<RuntimeBoundMapTopology>>();

function remember(cacheKey: string, value: RuntimeBoundMapTopology): void {
  cache.delete(cacheKey);
  cache.set(cacheKey, { key: cacheKey, value });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeMapName(value: string | null | undefined): string {
  const leaf = String(value ?? "").replace(/\\/g, "/").split("/").at(-1) ?? "";
  return leaf.toLowerCase().endsWith(".xodr") ? leaf.slice(0, -5) : leaf;
}

function exactRuntimeFamily(value: string): RuntimeTopologyFamily | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "carla_ue5") return normalized;
  return null;
}

function runtimeMapNameForAsset(
  asset: Awaited<ReturnType<typeof getMapAssetByIdFromDb>>,
  runtime: RuntimeTopologyFamily,
): string | null {
  const value = runtime === "carla_ue5" ? asset?.ue5_carla_map_name : null;
  return value?.trim() || null;
}

function projectionIdentity(runtimeMap: RuntimeMapResponse): string {
  return JSON.stringify({
    coordinates: runtimeMap.schema?.coordinates ?? null,
    georeference: runtimeMap.map_info?.georeference ?? null,
    geoprojection: runtimeMap.map_info?.geoprojection ?? null,
  });
}

/**
 * This map's compiled-index cache key, answered from the bundle MANIFEST — a
 * couple of kilobytes — instead of from the bundle.
 *
 * ## Why this is worth a function
 *
 * The key is a content identity, and the lookup used to sit AFTER the catalog
 * read, the manifest HEAD, the full multi-megabyte bundle read, a `JSON.parse`
 * of tens of megabytes and three sha256 passes. So a cache HIT paid almost
 * everything a MISS pays and saved only `buildMapTopologyIndex`. On Munich that
 * is 44 MB of raw sections read and hashed to answer a question about 400 bytes
 * of hex.
 *
 * Every part of the key is either configuration or a section digest the
 * manifest already declares:
 *   - `xodrSha256` is `sections.xodr.sha256` — `readVerifiedSection` refuses
 *     any section whose bytes do not hash to it, so the two cannot differ.
 *   - `runtimeRoadGraphSha256` is `sha256(runtime_segments)`, i.e.
 *     `sections.runtime_segments.sha256`, for the same reason.
 *   - the image digest is `base.source.image_digest`.
 *
 * `projectionIdentitySha256` is the exception: it hashes three fields read out
 * of the runtime_meta section, which the manifest does not carry. The cache is
 * therefore keyed on `sections.runtime_meta.sha256` in its place. That is
 * STRICTLY FINER, never coarser — identical runtime_meta bytes cannot produce a
 * different projection identity — so it can cost an extra compile but can never
 * hand back an index compiled against a different projection. The provenance
 * the index carries still records the real `projectionIdentitySha256`.
 *
 * Returns null when the manifest cannot settle the question. Every such case
 * (missing section, digest absent, identity drift) is one the full read path
 * below turns into a `TopologyUnavailableError` anyway, so null means "take the
 * slow path", not "skip a check".
 */
async function compiledIndexCacheKey(input: {
  mapAssetId: string;
  runtime: RuntimeTopologyFamily;
  runtimeMapName: string;
  runtimeCatalogVersion: string;
  bundleVersion: string;
  catalogImageDigest: string;
}): Promise<string | null> {
  let manifest;
  try {
    manifest = await readRuntimeTopologyBundleManifest(
      input.runtimeMapName,
      input.bundleVersion,
    );
  } catch {
    return null;
  }
  if (!manifest?.sections || !manifest.base?.source) return null;

  const imageDigest = manifest.base.source.image_digest?.trim() || "";
  const xodrSha256 = manifest.sections.xodr?.sha256?.toLowerCase() || "";
  const runtimeRoadGraphSha256 =
    manifest.sections.runtime_segments?.sha256?.toLowerCase() || "";
  const runtimeMetaSha256 = manifest.sections.runtime_meta?.sha256?.toLowerCase() || "";
  if (!imageDigest || !xodrSha256 || !runtimeRoadGraphSha256 || !runtimeMetaSha256) {
    return null;
  }
  // The same identity gate the bundle path applies, asked of the manifest. A
  // cached index may only be returned for a bundle that would have passed it.
  if (manifest.bundle_version !== input.bundleVersion) return null;
  if (
    normalizeMapName(manifest.normalized_map_name) !==
    normalizeMapName(input.runtimeMapName)
  ) {
    return null;
  }
  if ((manifest.base.source.map_asset_id ?? null) !== input.mapAssetId) return null;
  if (!input.catalogImageDigest || imageDigest !== input.catalogImageDigest) return null;

  return [
    input.mapAssetId,
    input.runtime,
    input.runtimeCatalogVersion,
    input.bundleVersion,
    imageDigest,
    xodrSha256,
    runtimeRoadGraphSha256,
    runtimeMetaSha256,
    RUNTIME_BOUND_TOPOLOGY_COMPILER_VERSION,
  ].join(":");
}

/**
 * Would the live bundle still compile to this publication?
 *
 * Compares the identity the publication recorded against the identity the bundle
 * manifest declares now. Both digests are section hashes the manifest already
 * carries, so this costs one small JSON read and no bundle bytes — the same read
 * `compiledIndexCacheKey` makes a few lines below.
 *
 * TRUE when the manifest cannot answer, which is deliberate and is what keeps
 * accepted publications authoritative after their source sections age out. This
 * only demotes a publication on a POSITIVE mismatch: the bundle is still there
 * and it is a different one.
 */
async function publicationMatchesLiveBundle(
  provenance: RuntimeTopologyProvenance,
): Promise<boolean> {
  let manifest;
  try {
    manifest = await readRuntimeTopologyBundleManifest(
      provenance.runtimeMapName,
      provenance.bundleVersion,
    );
  } catch {
    return true;
  }
  if (!manifest?.sections || !manifest.base?.source) return true;
  const xodrSha256 = manifest.sections.xodr?.sha256?.toLowerCase() || "";
  const runtimeRoadGraphSha256 =
    manifest.sections.runtime_segments?.sha256?.toLowerCase() || "";
  const imageDigest = manifest.base.source.image_digest?.trim() || "";
  if (!xodrSha256 || !runtimeRoadGraphSha256 || !imageDigest) return true;
  return (
    xodrSha256 === provenance.xodrSha256.toLowerCase() &&
    runtimeRoadGraphSha256 === provenance.runtimeRoadGraphSha256.toLowerCase() &&
    imageDigest === provenance.imageDigest
  );
}

async function compileRuntimeBoundMapTopologyIndex(input: {
  mapAssetId: string;
  runtime: string;
}): Promise<RuntimeBoundMapTopology> {
  const mapAssetId = input.mapAssetId.trim();
  const runtime = exactRuntimeFamily(input.runtime);
  if (!runtime) {
    throw new TopologyUnavailableError(
      "runtime_unresolved",
      mapAssetId,
      `unsupported or missing CARLA runtime ${JSON.stringify(input.runtime)}`,
    );
  }

  const asset = await getMapAssetByIdFromDb(mapAssetId);
  if (!asset) {
    throw new TopologyUnavailableError(
      "map_asset_missing",
      mapAssetId,
      "map asset does not exist",
    );
  }
  const runtimeMapName = runtimeMapNameForAsset(asset, runtime);
  if (!runtimeMapName) {
    throw new TopologyUnavailableError(
      "runtime_map_unbound",
      mapAssetId,
      `map asset is not bound to ${runtime}`,
      { runtime },
    );
  }

  // Accepted semantic publications are immutable, content-addressed execution
  // artifacts. They remain authoritative even after their source extraction
  // sections age out; normal topology reads must not depend on live runtime
  // artifact storage.
  let published = null;
  try {
    published = await readAcceptedSemanticGraphPublication({
      mapAssetId,
      runtime,
    });
  } catch (error) {
    // A schema-stale publication is a cache MISS, not an outage. Both codes
    // mean "the stored publication predates the schema this code requires":
    // `artifact_payload_invalid` for the artifact payloads, `manifest_invalid`
    // for the manifest itself (e.g. manifests published before
    // `roadwayConsistency` became required fail today's manifest schema).
    // Either way the live-compile path below is the answer — a routine,
    // expected event when map data or schemas move, and one that must degrade
    // rather than take every emit down (the 2026-07-31 v4-compiler republish
    // was a zero-scene overnight for exactly this reason). Checksum, size,
    // and identity failures still fail closed.
    if (
      !(error instanceof SemanticGraphPublicationError) ||
      (error.code !== "artifact_payload_invalid" && error.code !== "manifest_invalid")
    ) {
      throw error;
    }
  }
  // A publication compiled by a different topology compiler is a cache MISS, not
  // an answer. Until this checked, the only thing keeping a stale index out was
  // that the semantic map shares the publication and pins its own compiler
  // version as a zod literal — so topology freshness was protected by accident,
  // through a field in a sibling artifact. `RuntimeTopologyProvenance
  // .compilerVersion` is a plain string, so nothing here would have noticed.
  //
  // ...and neither is a publication compiled from a bundle that has since been
  // rebuilt. The compiler version only moves when the COMPILER changes; a new
  // crawl of the same maps leaves it alone, so without the bundle-identity check
  // an accepted publication is self-perpetuating. `compileAndPublishSemanticGraph`
  // reads its topology through here, so re-publishing a map returned the existing
  // publication and wrote it straight back out: regenerating all nine dev bundles
  // on 2026-07-31 changed nothing anywhere until this was fixed.
  if (
    published?.manifest.runtimeMapName === runtimeMapName &&
    published.topology.runtimeProvenance.compilerVersion
      === RUNTIME_BOUND_TOPOLOGY_COMPILER_VERSION &&
    (await publicationMatchesLiveBundle(published.topology.runtimeProvenance))
  ) {
    return { index: published.topology, laneTravelFollowsPolyline: null };
  }

  const runtimeCatalogVersion = getRuntimeCatalogVersion(runtime);
  if (!runtimeCatalogVersion) {
    throw new TopologyUnavailableError(
      "runtime_catalog_unconfigured",
      mapAssetId,
      `${runtime} runtime catalog version is not configured`,
      { runtime },
    );
  }
  const catalog = await readCarlaRuntimeCatalogFromS3(runtimeCatalogVersion);
  if (!catalog) {
    throw new TopologyUnavailableError(
      "runtime_catalog_missing",
      mapAssetId,
      `runtime catalog ${runtimeCatalogVersion} is unavailable`,
      { runtime, runtimeCatalogVersion },
    );
  }

  const bundleVersion = getRuntimeMapArtifactVersion();
  if (catalog.bundle_version !== bundleVersion) {
    throw new TopologyUnavailableError(
      "runtime_catalog_mismatch",
      mapAssetId,
      "runtime catalog and configured bundle versions differ",
      {
        runtime,
        runtimeCatalogVersion,
        catalogBundleVersion: catalog.bundle_version,
        configuredBundleVersion: bundleVersion,
      },
    );
  }
  const liveBundle = await headRuntimeMapArtifactManifest(
    runtimeMapName,
    bundleVersion,
  );
  if (!liveBundle.exists || !liveBundle.complete || liveBundle.source !== "manifest") {
    throw new TopologyUnavailableError(
      "runtime_bundle_missing",
      mapAssetId,
      "runtime map manifest is not currently published and complete",
      {
        runtime,
        runtimeCatalogVersion,
        runtimeMapName,
        bundleVersion,
        liveBundle,
      },
    );
  }

  const catalogImageDigest = catalog.source.image_digest?.trim() || "";

  // Ask whether we already hold this index BEFORE reading the bundle it would
  // be compiled from. See `compiledIndexCacheKey`.
  const cacheKey = await compiledIndexCacheKey({
    mapAssetId,
    runtime,
    runtimeMapName,
    runtimeCatalogVersion,
    bundleVersion,
    catalogImageDigest,
  });
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit) {
      cache.delete(cacheKey);
      cache.set(cacheKey, hit);
      return hit.value;
    }
  }

  let bundle;
  try {
    bundle = await readRuntimeTopologyBundleInput(runtimeMapName, bundleVersion);
  } catch (error) {
    if (error instanceof RuntimeTopologyBundleError) {
      throw new TopologyUnavailableError(
        error.code === "manifest_missing"
          ? "runtime_bundle_missing"
          : "runtime_bundle_integrity_failure",
        mapAssetId,
        error.message,
        { bundleErrorCode: error.code, ...(error.details ?? {}) },
        // Keep whatever S3 threw: `manifest_missing` is also what a timeout
        // looks like from here, and only the cause distinguishes them.
        error.cause,
      );
    }
    throw error;
  }
  const bundleImageDigest = bundle.imageDigest?.trim() || "";
  if (
    bundle.bundleVersion !== bundleVersion ||
    normalizeMapName(bundle.normalizedMapName) !== normalizeMapName(runtimeMapName) ||
    bundle.mapAssetId !== mapAssetId ||
    !bundleImageDigest ||
    !catalogImageDigest ||
    bundleImageDigest !== catalogImageDigest
  ) {
    throw new TopologyUnavailableError(
      "runtime_bundle_identity_mismatch",
      mapAssetId,
      "runtime bundle provenance does not match the runtime catalog binding",
      {
        runtime,
        runtimeMapName,
        bundleVersion,
        bundleMapAssetId: bundle.mapAssetId,
        bundleImageDigest: bundleImageDigest || null,
        catalogImageDigest: catalogImageDigest || null,
      },
    );
  }

  const xodr = bundle.xodr.trim() ? bundle.xodr : null;
  const runtimeMap = bundle.runtime;
  const runtimeSegments = runtimeMap.road_segments;
  if (!xodr || !Array.isArray(runtimeSegments)) {
    throw new TopologyUnavailableError(
      "runtime_bundle_incomplete",
      mapAssetId,
      "runtime bundle lacks XODR, runtime road segments, or live-map OpenDRIVE identity",
    );
  }
  const xodrSha256 = sha256(xodr);
  if (xodrSha256 !== bundle.xodrSha256) {
    throw new TopologyUnavailableError(
      "runtime_xodr_hash_mismatch",
      mapAssetId,
      "bundle XODR does not match the live-map hash captured with the runtime crawl",
      { xodrSha256, verifiedBundleXodrSha256: bundle.xodrSha256 },
    );
  }

  const runtimeRoadGraphSha256 = bundle.runtimeRoadGraphSha256;
  const projectionIdentitySha256 = sha256(projectionIdentity(runtimeMap));

  const topology = buildMapTopologyIndex({
    mapName: mapAssetId,
    xodr,
    xodrSha256,
  });
  // Stamped onto the index rather than kept beside it, so every consumer of a
  // bound topology can read the direction CARLA resolved instead of inferring
  // one from the lane-id sign.
  const bound = bindRuntimeTopology({
    topology,
    runtimeSegments,
    laneTravelIncreasesS: laneTravelDirections(topology, runtimeMap),
    provenance: {
      mapAssetId,
      runtimeFamily: runtime,
      runtimeMapName,
      runtimeCatalogVersion,
      bundleVersion,
      imageDigest: bundleImageDigest,
      xodrSha256,
      runtimeRoadGraphSha256,
      projectionIdentitySha256,
      compilerVersion: RUNTIME_BOUND_TOPOLOGY_COMPILER_VERSION,
    },
  });
  if (bound.runtimeParity.status === "incompatible") {
    throw new TopologyUnavailableError(
      "runtime_topology_incompatible",
      mapAssetId,
      "OpenDRIVE topology has ambiguous runtime lane identities",
      { parity: bound.runtimeParity },
    );
  }

  const value: RuntimeBoundMapTopology = {
    index: bound,
    laneTravelFollowsPolyline: new Map(
      Object.entries(bound.laneTravelIncreasesS ?? {}),
    ),
  };
  // No key means the manifest could not name this bundle's content identity,
  // and an entry we cannot look up again is only a memory leak.
  if (cacheKey) remember(cacheKey, value);
  return value;
}

/**
 * The compiled index together with the CARLA waypoint crawl behind it.
 *
 * Use this over `getRuntimeBoundMapTopologyIndex` when the answer depends on
 * runtime geometry the OpenDRIVE index does not carry — above all a lane's
 * direction of travel, which is CARLA's per-waypoint yaw and nothing else.
 */
export async function getRuntimeBoundMapTopology(input: {
  mapAssetId: string;
  runtime: string;
}): Promise<RuntimeBoundMapTopology> {
  const requestKey = `${input.mapAssetId.trim()}:${input.runtime.trim().toLowerCase()}`;
  const existing = inFlight.get(requestKey);
  if (existing) return existing;
  const pending = compileRuntimeBoundMapTopologyIndex(input);
  inFlight.set(requestKey, pending);
  try {
    return await pending;
  } finally {
    if (inFlight.get(requestKey) === pending) inFlight.delete(requestKey);
  }
}

export async function getRuntimeBoundMapTopologyIndex(input: {
  mapAssetId: string;
  runtime: string;
}): Promise<RuntimeBoundMapTopologyIndex> {
  return (await getRuntimeBoundMapTopology(input)).index;
}

/**
 * Per-lane travel direction: does the s-increasing polyline run the way the
 * lane is DRIVEN? Keyed by RSL; a lane is absent when the crawl gives no
 * usable answer, and the caller should fall back rather than assume.
 *
 * Separate from the index because the answer lives in the CARLA crawl, not in
 * the OpenDRIVE — see `lane-travel-direction.ts` for why the lane-id sign
 * convention is not good enough. Cached on the crawl's own hash so a published
 * index (which ships without its crawl) pays the bundle read once per process.
 */
const travelCache = new Map<string, ReadonlyMap<string, boolean>>();
const travelInFlight = new Map<string, Promise<ReadonlyMap<string, boolean>>>();

function laneTravelDirections(
  index: Pick<RuntimeBoundMapTopologyIndex, "lanes">,
  runtimeMap: RuntimeMapResponse,
): ReadonlyMap<string, boolean> {
  const waypoints = crawlWaypointsByRsl(runtimeMap);
  const directions = new Map<string, boolean>();
  for (const lane of Object.values(index.lanes)) {
    const follows = polylineFollowsTravel(
      waypoints.get(lane.rsl) ?? [],
      lane.polyline,
    );
    if (follows !== null) directions.set(lane.rsl, follows);
  }
  return directions;
}

async function compileLaneTravelDirections(
  bound: RuntimeBoundMapTopology,
): Promise<ReadonlyMap<string, boolean>> {
  const provenance = bound.index.runtimeProvenance;
  // A published index carries provenance but not the crawl, so read the same
  // bundle the compiler would have.
  //
  // Fails SOFT, on any error at all. Direction is an enhancement over the lane
  // sign convention, not a precondition for drawing the map — and this read did
  // not happen on the published path before, so letting an S3 blip escape here
  // would newly turn a transient fault into a blank editor.
  try {
    const bundle = await readRuntimeTopologyBundleInput(
      provenance.runtimeMapName,
      provenance.bundleVersion,
    );
    return laneTravelDirections(bound.index, bundle.runtime);
  } catch {
    return new Map();
  }
}

export async function getRuntimeLaneTravelDirections(
  bound: RuntimeBoundMapTopology,
): Promise<ReadonlyMap<string, boolean>> {
  if (bound.laneTravelFollowsPolyline) return bound.laneTravelFollowsPolyline;
  const provenance = bound.index.runtimeProvenance;
  const cacheKey = [
    provenance.mapAssetId,
    provenance.runtimeFamily,
    provenance.runtimeRoadGraphSha256,
    provenance.xodrSha256,
    LANE_TRAVEL_DIRECTION_VERSION,
  ].join(":");
  const hit = travelCache.get(cacheKey);
  if (hit) return hit;
  const existing = travelInFlight.get(cacheKey);
  if (existing) return existing;

  const pending = compileLaneTravelDirections(bound);
  travelInFlight.set(cacheKey, pending);
  try {
    const directions = await pending;
    travelCache.delete(cacheKey);
    travelCache.set(cacheKey, directions);
    while (travelCache.size > MAX_ENTRIES) {
      const oldest = travelCache.keys().next().value;
      if (oldest === undefined) break;
      travelCache.delete(oldest);
    }
    return directions;
  } finally {
    if (travelInFlight.get(cacheKey) === pending) travelInFlight.delete(cacheKey);
  }
}

export async function getMapTopologyIndex(
  mapAssetId: string,
  runtime: RuntimeTopologyFamily,
): Promise<RuntimeBoundMapTopologyIndex> {
  return getRuntimeBoundMapTopologyIndex({ mapAssetId, runtime });
}

export function __clearTopologyCache(): void {
  evictTopologyCache();
  inFlight.clear();
  travelInFlight.clear();
}

/** Release completed topology objects after request-scoped bulk compilation. */
export function evictTopologyCache(): void {
  cache.clear();
  travelCache.clear();
  // The bundle cache holds the crawls these indexes were compiled from, which
  // are larger than the indexes themselves. Leaving it behind would defeat the
  // release this function exists to perform.
  evictRuntimeTopologyBundleCache();
}
