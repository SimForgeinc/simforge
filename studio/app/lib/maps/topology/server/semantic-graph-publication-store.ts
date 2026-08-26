import "server-only";

import { createHash } from "node:crypto";
import {
  SEMANTIC_GRAPH_PUBLICATION_SCHEMA_VERSION,
  SemanticFeatureGraphSchema,
  SemanticGraphPublicationManifestSchema,
  SemanticMapGraphSchema,
  SemanticExecutionIndexSchema,
  buildSemanticExecutionIndex,
  RuntimeBoundMapTopologyIndexSchema,
  type RuntimeBoundMapTopologyIndex,
  type RuntimeTopologyFamily,
  type SemanticFeatureGraph,
  type SemanticGraphArtifactDescriptor,
  type SemanticGraphPublicationManifest,
  type SemanticMapGraph,
  type SemanticExecutionIndex,
  type SemanticExecutionRuntimeControls,
  type RoadwayConsistencyReport,
} from "@simforge-oss/studio-shared";
import { getRuntimeMapArtifactBucket } from "@/app/lib/editor-map/runtime-map-artifacts";
import { getS3ObjectUtf8, getS3ObjectUtf8Bounded, headS3ObjectInfo } from "@/app/lib/s3/s3-get-object";
import { putS3ObjectUtf8, putS3ObjectUtf8Gzipped } from "@/app/lib/s3/s3-put-object";
import {
  ROADWAY_CONSISTENCY_ATTESTATION_SCHEMA_VERSION,
  blockingRoadwayConsistencyIssues,
  parseRoadwayConsistencyReport,
  roadwayConsistencyVerdict,
} from "./roadway-consistency";

const MAX_PUBLICATION_RAW_BYTES = 128 * 1024 * 1024;
const MAX_PUBLICATION_STORED_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 4;

export type SemanticGraphPublication = {
  manifest: SemanticGraphPublicationManifest;
  topology: RuntimeBoundMapTopologyIndex;
  semanticMap: SemanticMapGraph;
  semanticFeatureGraph: SemanticFeatureGraph;
  semanticExecutionIndex: SemanticExecutionIndex;
  roadwayConsistency: RoadwayConsistencyReport;
};

export type SemanticGraphPublicationErrorCode =
  | "manifest_invalid"
  | "identity_mismatch"
  | "publication_not_authoring_ready"
  | "roadway_consistency_failed"
  | "artifact_key_invalid"
  | "artifact_too_large"
  | "artifact_size_mismatch"
  | "artifact_checksum_mismatch"
  | "artifact_payload_invalid";

export class SemanticGraphPublicationError extends Error {
  constructor(
    readonly code: SemanticGraphPublicationErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SemanticGraphPublicationError";
  }
}

const cache = new Map<string, Promise<SemanticGraphPublication | null>>();

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]/g, "_");
}

function publicationPrefix(input: {
  mapAssetId: string;
  runtime: RuntimeTopologyFamily;
}): string {
  return `semantic-graphs/${safeSegment(input.runtime)}/${safeSegment(input.mapAssetId)}`;
}

export function acceptedSemanticGraphPublicationKey(input: {
  mapAssetId: string;
  runtime: RuntimeTopologyFamily;
}): string {
  return `${publicationPrefix(input)}/accepted.v2.json`;
}

function isMissingObject(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return candidate?.name === "NoSuchKey" || candidate?.Code === "NoSuchKey" ||
    candidate?.name === "NotFound" || candidate?.$metadata?.httpStatusCode === 404;
}

function remember(key: string, value: Promise<SemanticGraphPublication | null>) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function readPublicationManifest(input: {
  mapAssetId: string;
  runtime: RuntimeTopologyFamily;
}): Promise<SemanticGraphPublicationManifest | null> {
  const bucket = getRuntimeMapArtifactBucket();
  let rawManifest: string;
  try {
    rawManifest = await getS3ObjectUtf8(
      bucket,
      acceptedSemanticGraphPublicationKey(input),
    );
  } catch (error) {
    if (isMissingObject(error)) return null;
    throw error;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawManifest);
  } catch {
    throw new SemanticGraphPublicationError(
      "manifest_invalid",
      "Accepted semantic graph publication manifest is not valid JSON.",
    );
  }
  const parsed = SemanticGraphPublicationManifestSchema.safeParse(payload);
  if (!parsed.success) {
    throw new SemanticGraphPublicationError(
      "manifest_invalid",
      "Accepted semantic graph publication manifest failed schema validation.",
      {
        issues: parsed.error.issues.map(({ code, path, message }) => ({
          code,
          path,
          message,
        })),
      },
    );
  }
  if (
    parsed.data.mapAssetId !== input.mapAssetId ||
    parsed.data.runtime !== input.runtime
  ) {
    throw new SemanticGraphPublicationError(
      "identity_mismatch",
      "Accepted semantic graph publication belongs to another map or runtime.",
      {
        requested: input,
        published: {
          mapAssetId: parsed.data.mapAssetId,
          runtime: parsed.data.runtime,
        },
      },
    );
  }
  return parsed.data;
}

/** Read only the small accepted pointer. Editor boot uses this instead of
 * downloading topology/runtime artifacts; artifact integrity remains enforced
 * by the overlay and server-side compile endpoints that consume them. */
/**
 * The accepted manifest, served from the short-lived cache.
 *
 * Routed through the cache rather than straight to S3 because the publication
 * read below needs the manifest too — so a cold publication load was fetching
 * the same small object twice, once to compute the cache key and once to find
 * the artifacts. Callers that need to bypass the cache should invalidate it
 * (publishing already does).
 */
export async function readAcceptedSemanticGraphPublicationManifest(input: {
  mapAssetId: string;
  runtime: RuntimeTopologyFamily;
}): Promise<SemanticGraphPublicationManifest | null> {
  return readAcceptedManifestCached(input, Date.now());
}

function assertArtifactKey(
  prefix: string,
  descriptor: SemanticGraphArtifactDescriptor,
  label: string,
) {
  if (!descriptor.key.startsWith(`${prefix}/revisions/`) || descriptor.key.includes("..")) {
    throw new SemanticGraphPublicationError(
      "artifact_key_invalid",
      `Semantic ${label} artifact is outside its publication prefix.`,
      { label },
    );
  }
  if (descriptor.sizeBytesRaw > MAX_PUBLICATION_RAW_BYTES) {
    throw new SemanticGraphPublicationError(
      "artifact_too_large",
      `Semantic ${label} artifact exceeds the raw size budget.`,
      { label, sizeBytesRaw: descriptor.sizeBytesRaw },
    );
  }
}

async function readArtifact(
  bucket: string,
  prefix: string,
  descriptor: SemanticGraphArtifactDescriptor,
  label: string,
): Promise<unknown> {
  assertArtifactKey(prefix, descriptor, label);
  if (descriptor.sizeBytesStored > MAX_PUBLICATION_STORED_BYTES) {
    throw new SemanticGraphPublicationError(
      "artifact_too_large",
      `Semantic ${label} artifact exceeds the stored size budget.`,
      { label, sizeBytesStored: descriptor.sizeBytesStored },
    );
  }
  let raw: string;
  try {
    raw = await getS3ObjectUtf8Bounded(bucket, descriptor.key, {
      maximumStoredBytes: MAX_PUBLICATION_STORED_BYTES,
      maximumRawBytes: MAX_PUBLICATION_RAW_BYTES,
    });
  } catch (error) {
    throw new SemanticGraphPublicationError(
      "artifact_too_large",
      `Semantic ${label} artifact exceeded a decompression budget.`,
      { label, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const sizeBytesRaw = Buffer.byteLength(raw, "utf8");
  if (sizeBytesRaw !== descriptor.sizeBytesRaw) {
    throw new SemanticGraphPublicationError(
      "artifact_size_mismatch",
      `Semantic ${label} artifact size does not match its accepted manifest.`,
      { label, expected: descriptor.sizeBytesRaw, actual: sizeBytesRaw },
    );
  }
  const checksum = sha256(raw);
  if (checksum !== descriptor.sha256) {
    throw new SemanticGraphPublicationError(
      "artifact_checksum_mismatch",
      `Semantic ${label} artifact checksum does not match its accepted manifest.`,
      { label, expected: descriptor.sha256, actual: checksum },
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new SemanticGraphPublicationError(
      "artifact_payload_invalid",
      `Semantic ${label} artifact is not valid JSON.`,
      { label },
    );
  }
}

async function readPublication(input: {
  mapAssetId: string;
  runtime: RuntimeTopologyFamily;
}): Promise<SemanticGraphPublication | null> {
  const bucket = getRuntimeMapArtifactBucket();
  const prefix = publicationPrefix(input);
  const manifest = await readAcceptedSemanticGraphPublicationManifest(input);
  if (!manifest) return null;
  const [topologyPayload, semanticMapPayload, semanticFeaturePayload, semanticExecutionPayload, roadwayConsistencyPayload] = await Promise.all([
    readArtifact(bucket, prefix, manifest.artifacts.topology, "topology"),
    readArtifact(bucket, prefix, manifest.artifacts.semanticMap, "map"),
    readArtifact(bucket, prefix, manifest.artifacts.semanticFeatureGraph, "feature graph"),
    readArtifact(bucket, prefix, manifest.artifacts.semanticExecutionIndex, "execution index"),
    readArtifact(bucket, prefix, manifest.artifacts.roadwayConsistency, "roadway consistency"),
  ]);
  const topology = RuntimeBoundMapTopologyIndexSchema.safeParse(topologyPayload);
  const semanticMap = SemanticMapGraphSchema.safeParse(semanticMapPayload);
  const semanticFeatureGraph = SemanticFeatureGraphSchema.safeParse(semanticFeaturePayload);
  const semanticExecutionIndex = SemanticExecutionIndexSchema.safeParse(semanticExecutionPayload);
  if (!topology.success || !semanticMap.success || !semanticFeatureGraph.success || !semanticExecutionIndex.success) {
    throw new SemanticGraphPublicationError(
      "artifact_payload_invalid",
      "Accepted semantic graph publication contains a schema-invalid artifact.",
      {
        topology: topology.success ? null : topology.error.issues,
        semanticMap: semanticMap.success ? null : semanticMap.error.issues,
        semanticFeatureGraph: semanticFeatureGraph.success ? null : semanticFeatureGraph.error.issues,
        semanticExecutionIndex: semanticExecutionIndex.success ? null : semanticExecutionIndex.error.issues,
      },
    );
  }
  let roadwayConsistency: RoadwayConsistencyReport;
  try {
    roadwayConsistency = parseRoadwayConsistencyReport(roadwayConsistencyPayload, {
      topologyMapName: topology.data.mapName,
      xodrSha256: topology.data.runtimeProvenance.xodrSha256,
    });
  } catch (error) {
    throw new SemanticGraphPublicationError(
      "artifact_payload_invalid",
      "Accepted roadway consistency artifact failed schema or identity validation.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const roadwayVerdict = roadwayConsistencyVerdict(roadwayConsistency);
  if (
    roadwayVerdict !== manifest.roadwayConsistency.verdict ||
    roadwayConsistency.issues.length !== manifest.roadwayConsistency.issueCount ||
    JSON.stringify(roadwayConsistency.stats) !== JSON.stringify(manifest.roadwayConsistency.stats)
  ) {
    throw new SemanticGraphPublicationError(
      "identity_mismatch",
      "Accepted roadway consistency artifact does not match its manifest attestation.",
    );
  }
  if (blockingRoadwayConsistencyIssues(roadwayConsistency).length > 0) {
    throw new SemanticGraphPublicationError(
      "roadway_consistency_failed",
      "Accepted publication contains a blocking roadway consistency error.",
    );
  }
  const provenance = topology.data.runtimeProvenance;
  if (
    provenance.mapAssetId !== manifest.mapAssetId ||
    provenance.runtimeFamily !== manifest.runtime ||
    provenance.runtimeMapName !== manifest.runtimeMapName ||
    provenance.runtimeCatalogVersion !== manifest.runtimeCatalogVersion ||
    provenance.bundleVersion !== manifest.bundleVersion ||
    provenance.imageDigest !== manifest.imageDigest ||
    provenance.xodrSha256 !== manifest.xodrSha256 ||
    provenance.runtimeRoadGraphSha256 !== manifest.runtimeRoadGraphSha256 ||
    provenance.projectionIdentitySha256 !== manifest.projectionIdentitySha256 ||
    semanticMap.data.graphRevision !== manifest.semanticMapGraphRevision ||
    semanticFeatureGraph.data.graphRevision !== manifest.semanticFeatureGraphRevision
    || semanticExecutionIndex.data.semanticMapGraphRevision !== manifest.semanticMapGraphRevision
    || semanticExecutionIndex.data.indexRevision !== manifest.semanticExecutionIndexRevision
    || semanticExecutionIndex.data.runtimeProvenance.runtimeRoadGraphSha256 !== manifest.runtimeRoadGraphSha256
  ) {
    throw new SemanticGraphPublicationError(
      "identity_mismatch",
      "Accepted semantic graph artifacts do not match their publication provenance.",
    );
  }
  return {
    manifest,
    topology: topology.data,
    semanticMap: semanticMap.data,
    semanticFeatureGraph: semanticFeatureGraph.data,
    semanticExecutionIndex: semanticExecutionIndex.data,
    roadwayConsistency,
  };
}

/**
 * How long an already-read accepted manifest is trusted before re-reading it.
 *
 * The manifest is the only thing that names the current publication revision,
 * so it has to be read to know whether a cached publication is still the
 * accepted one. Re-reading it on every call costs a measured 103-275 ms of S3;
 * never re-reading it is what let a superseded publication serve indefinitely.
 * A short window bounds the staleness after a republish to seconds instead of
 * "until this serverless instance is recycled".
 */
const ACCEPTED_MANIFEST_TTL_MS = 15_000;
const manifestCache = new Map<
  string,
  { readAtMs: number; manifest: SemanticGraphPublicationManifest | null }
>();

/**
 * Manifest reads already on the wire, so a burst shares one.
 *
 * Without this, introducing the manifest read AHEAD of the publication cache
 * key opened a coalescing gap: the key used to be known synchronously, so
 * concurrent callers all saw the first caller's pending publication promise.
 * Once they had to await a manifest first, every caller in a burst got past
 * the cache check before any of them had populated it — and the editor opens
 * by firing four topology-backed routes at once. Measured as `topology;dur`
 * over 1.4 s WARM for the first caller in a burst, against 90 ms for the next.
 */
const manifestPending = new Map<
  string,
  Promise<SemanticGraphPublicationManifest | null>
>();

/**
 * Read the accepted manifest, at most once per TTL per map, and at most once
 * concurrently.
 *
 * `nowMs` is injected so the TTL is testable without a fake clock.
 */
async function readAcceptedManifestCached(
  input: { mapAssetId: string; runtime: RuntimeTopologyFamily },
  nowMs: number,
): Promise<SemanticGraphPublicationManifest | null> {
  const key = `${input.runtime}:${input.mapAssetId}`;
  const entry = manifestCache.get(key);
  if (entry && nowMs - entry.readAtMs < ACCEPTED_MANIFEST_TTL_MS) return entry.manifest;
  const inFlight = manifestPending.get(key);
  if (inFlight) return inFlight;
  const request = readAcceptedManifestUncached(input, nowMs, key);
  manifestPending.set(key, request);
  try {
    return await request;
  } finally {
    manifestPending.delete(key);
  }
}

async function readAcceptedManifestUncached(
  input: { mapAssetId: string; runtime: RuntimeTopologyFamily },
  nowMs: number,
  key: string,
): Promise<SemanticGraphPublicationManifest | null> {
  const manifest = await readPublicationManifest(input);
  // A missing manifest is NOT cached. Publishing a map has to be visible
  // immediately, and "no publication yet" is the state a first publish leaves;
  // remembering it for even a few seconds would hide the thing that was just
  // written. Re-reading a 404 is cheap.
  if (manifest) manifestCache.set(key, { readAtMs: nowMs, manifest });
  else manifestCache.delete(key);
  void input;
  while (manifestCache.size > MAX_CACHE_ENTRIES * 4) {
    const oldest = manifestCache.keys().next().value;
    if (oldest === undefined) break;
    manifestCache.delete(oldest);
  }
  return manifest;
}

export async function readAcceptedSemanticGraphPublication(input: {
  mapAssetId: string;
  runtime: RuntimeTopologyFamily;
}): Promise<SemanticGraphPublication | null> {
  // The publication revision belongs IN the key.
  //
  // Keying on `runtime:mapAssetId` alone made a republish invisible: the only
  // invalidation was a `cache.delete` inside the publish path, which helps
  // exactly one process. On serverless every other warm instance kept serving
  // the superseded publication — and because the topology service returns
  // straight out of this cache for every published map, one stale entry
  // poisoned runtime geometry, signal junctions and corridors together.
  const manifest = await readAcceptedManifestCached(input, Date.now());
  if (!manifest) return null;
  const key = `${input.runtime}:${input.mapAssetId}:${manifest.publicationRevision}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = readPublication(input);
  remember(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (cache.get(key) === pending) cache.delete(key);
    throw error;
  }
}

/** Compiler-only read: a previous compiler's schema-stale semantic map is a
 * cache miss. So is a schema-stale MANIFEST (`manifest_invalid`) — e.g. one
 * published before `roadwayConsistency` became a required manifest field: the
 * caller's live-rebuild fallback is the answer there too, not an outage (the
 * 2026-07-31 v4-compiler republish took every emit to zero scenes for exactly
 * this class of failure). Checksum, size, key, and identity failures still
 * fail closed. */
export async function readCompatibleSemanticGraphPublication(input: {
  mapAssetId: string;
  runtime: RuntimeTopologyFamily;
}): Promise<SemanticGraphPublication | null> {
  try {
    return await readAcceptedSemanticGraphPublication(input);
  } catch (error) {
    if (
      error instanceof SemanticGraphPublicationError &&
      (error.code === "artifact_payload_invalid" || error.code === "manifest_invalid")
    ) return null;
    throw error;
  }
}

async function writeArtifact(input: {
  bucket: string;
  key: string;
  payload: unknown;
}): Promise<SemanticGraphArtifactDescriptor> {
  const raw = JSON.stringify(input.payload);
  const sizeBytesRaw = Buffer.byteLength(raw, "utf8");
  if (sizeBytesRaw > MAX_PUBLICATION_RAW_BYTES) {
    throw new SemanticGraphPublicationError(
      "artifact_too_large",
      "Semantic graph publication artifact exceeds the raw size budget.",
      { key: input.key, sizeBytesRaw },
    );
  }
  await putS3ObjectUtf8Gzipped(input.bucket, input.key, raw);
  const head = await headS3ObjectInfo(input.bucket, input.key);
  if (!head.exists || head.sizeBytes == null) {
    throw new SemanticGraphPublicationError(
      "artifact_payload_invalid",
      "Semantic graph publication artifact was not readable after upload.",
      { key: input.key },
    );
  }
  return {
    key: input.key,
    sha256: sha256(raw),
    sizeBytesRaw,
    sizeBytesStored: head.sizeBytes,
    encoding: "gzip-json",
  };
}

export async function publishSemanticGraphPublication(input: {
  topology: RuntimeBoundMapTopologyIndex;
  semanticMap: SemanticMapGraph;
  semanticFeatureGraph: SemanticFeatureGraph;
  roadwayConsistency: RoadwayConsistencyReport;
  runtimeControls?: SemanticExecutionRuntimeControls;
  publishedAt?: string;
}): Promise<SemanticGraphPublicationManifest> {
  const topology = RuntimeBoundMapTopologyIndexSchema.parse(input.topology);
  const semanticMap = SemanticMapGraphSchema.parse(input.semanticMap);
  const semanticFeatureGraph = SemanticFeatureGraphSchema.parse(input.semanticFeatureGraph);
  const semanticExecutionIndex = buildSemanticExecutionIndex(
    semanticMap,
    input.runtimeControls,
  );
  const provenance = topology.runtimeProvenance;
  let roadwayConsistency: RoadwayConsistencyReport;
  try {
    roadwayConsistency = parseRoadwayConsistencyReport(input.roadwayConsistency, {
      topologyMapName: topology.mapName,
      xodrSha256: provenance.xodrSha256,
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new SemanticGraphPublicationError(
      "identity_mismatch",
      `Roadway consistency attestation does not match the publication runtime: ${cause}`,
      { cause },
    );
  }
  const blockingRoadwayIssues = blockingRoadwayConsistencyIssues(roadwayConsistency);
  if (blockingRoadwayIssues.length > 0) {
    throw new SemanticGraphPublicationError(
      "roadway_consistency_failed",
      "High-confidence roadway consistency errors block semantic graph publication.",
      {
        confidenceThreshold: 0.9,
        issueCount: blockingRoadwayIssues.length,
        issues: blockingRoadwayIssues,
      },
    );
  }
  if (
    semanticMap.authority !== "runtime_verified" ||
    !semanticMap.authoringReady
  ) {
    throw new SemanticGraphPublicationError(
      "publication_not_authoring_ready",
      "A semantic graph must be runtime-verified and authoring-ready before it can be accepted.",
      {
        authority: semanticMap.authority,
        authoringReady: semanticMap.authoringReady,
      },
    );
  }
  if (
    semanticMap.source.runtimeProvenance.mapAssetId !== provenance.mapAssetId ||
    semanticMap.source.runtimeProvenance.runtimeFamily !== provenance.runtimeFamily ||
    semanticFeatureGraph.mapAssetId !== provenance.mapAssetId ||
    semanticFeatureGraph.runtimeProvenance.runtimeFamily !== provenance.runtimeFamily
  ) {
    throw new SemanticGraphPublicationError(
      "identity_mismatch",
      "Semantic graph publication inputs do not share one runtime identity.",
    );
  }
  const revisionInput = {
    mapAssetId: provenance.mapAssetId,
    runtime: provenance.runtimeFamily,
    bundleVersion: provenance.bundleVersion,
    imageDigest: provenance.imageDigest,
    xodrSha256: provenance.xodrSha256,
    runtimeRoadGraphSha256: provenance.runtimeRoadGraphSha256,
    topologyCompilerVersion: provenance.compilerVersion,
    semanticMapGraphRevision: semanticMap.graphRevision,
    semanticFeatureGraphRevision: semanticFeatureGraph.graphRevision,
    semanticExecutionIndexRevision: semanticExecutionIndex.indexRevision,
    roadwayConsistencySha256: sha256(JSON.stringify(roadwayConsistency)),
  };
  const publicationRevision = `sha256:${sha256(JSON.stringify(revisionInput))}`;
  const prefix = publicationPrefix({
    mapAssetId: provenance.mapAssetId,
    runtime: provenance.runtimeFamily,
  });
  const revisionSegment = publicationRevision.slice("sha256:".length);
  const artifactPrefix = `${prefix}/revisions/${revisionSegment}`;
  const bucket = getRuntimeMapArtifactBucket();
  const [topologyArtifact, semanticMapArtifact, semanticFeatureArtifact, semanticExecutionArtifact, roadwayConsistencyArtifact] = await Promise.all([
    writeArtifact({ bucket, key: `${artifactPrefix}/topology.json.gz`, payload: topology }),
    writeArtifact({ bucket, key: `${artifactPrefix}/semantic-map.json.gz`, payload: semanticMap }),
    writeArtifact({ bucket, key: `${artifactPrefix}/semantic-feature-graph.json.gz`, payload: semanticFeatureGraph }),
    writeArtifact({ bucket, key: `${artifactPrefix}/semantic-execution-index.json.gz`, payload: semanticExecutionIndex }),
    writeArtifact({ bucket, key: `${artifactPrefix}/roadway-consistency.json.gz`, payload: roadwayConsistency }),
  ]);
  const manifest = SemanticGraphPublicationManifestSchema.parse({
    schemaVersion: SEMANTIC_GRAPH_PUBLICATION_SCHEMA_VERSION,
    status: "accepted",
    publicationRevision,
    publishedAt: input.publishedAt ?? new Date().toISOString(),
    mapAssetId: provenance.mapAssetId,
    runtime: provenance.runtimeFamily,
    runtimeMapName: provenance.runtimeMapName,
    runtimeCatalogVersion: provenance.runtimeCatalogVersion,
    bundleVersion: provenance.bundleVersion,
    imageDigest: provenance.imageDigest,
    xodrSha256: provenance.xodrSha256,
    runtimeRoadGraphSha256: provenance.runtimeRoadGraphSha256,
    projectionIdentitySha256: provenance.projectionIdentitySha256,
    topologyCompilerVersion: provenance.compilerVersion,
    semanticMapCompilerVersion: semanticMap.compilerVersion,
    semanticFeatureCompilerVersion: semanticFeatureGraph.compilerVersion,
    semanticExecutionIndexCompilerVersion: semanticExecutionIndex.compilerVersion,
    semanticMapGraphRevision: semanticMap.graphRevision,
    semanticFeatureGraphRevision: semanticFeatureGraph.graphRevision,
    semanticExecutionIndexRevision: semanticExecutionIndex.indexRevision,
    artifacts: {
      topology: topologyArtifact,
      semanticMap: semanticMapArtifact,
      semanticFeatureGraph: semanticFeatureArtifact,
      semanticExecutionIndex: semanticExecutionArtifact,
      roadwayConsistency: roadwayConsistencyArtifact,
    },
    roadwayConsistency: {
      schemaVersion: ROADWAY_CONSISTENCY_ATTESTATION_SCHEMA_VERSION,
      verdict: roadwayConsistencyVerdict(roadwayConsistency),
      stats: roadwayConsistency.stats,
      issueCount: roadwayConsistency.issues.length,
    },
  });
  await putS3ObjectUtf8(
    bucket,
    acceptedSemanticGraphPublicationKey({
      mapAssetId: provenance.mapAssetId,
      runtime: provenance.runtimeFamily,
    }),
    JSON.stringify(manifest),
  );
  // Both layers: the publication entries for this map, and the manifest that
  // names which revision is accepted. Leaving the manifest behind would keep
  // this process pointed at the superseded revision for the whole TTL.
  const cacheKeyPrefix = `${provenance.runtimeFamily}:${provenance.mapAssetId}`;
  for (const existingKey of [...cache.keys()]) {
    if (existingKey === cacheKeyPrefix || existingKey.startsWith(`${cacheKeyPrefix}:`)) {
      cache.delete(existingKey);
    }
  }
  manifestCache.delete(cacheKeyPrefix);
  manifestPending.delete(cacheKeyPrefix);
  return manifest;
}

export function __clearSemanticGraphPublicationCacheForTests() {
  cache.clear();
}
