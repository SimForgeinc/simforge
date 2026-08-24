import type {
  UniScenarioDatasetDto,
  UniScenarioDatasetReadinessDto,
  UniScenarioDocumentDto,
  UniScenarioDocumentSummaryDto,
  UniScenarioDocumentSummaryPageDto,
  UniScenarioRatingAggregateDto,
  UniScenarioSimulationPreviewDto,
  UniScenarioTagDto,
} from "@/app/lib/uniscenario/contracts";
import type { UniScenarioMapOption } from "./document-map-groups";

/**
 * Typed client for the list surfaces.
 *
 * `lib/uniscenario/editor/api.ts` is the editor's client and covers documents-with-content,
 * revisions, exports and render jobs. This one covers the list's own routes — datasets, the summary
 * projection, tags, ratings, readiness — and deliberately does not import it: the editor client's
 * `listUniScenarioDocuments` parses a full `ScenarioTemplateV2` per row, which is exactly what the
 * summary projection exists to avoid.
 */

/** A typed 409 from a route that reports a name collision (`datasets`, `tags`). */
export class UniScenarioNameConflict extends Error {
  constructor(
    readonly field: string,
    message = "That name is already taken in this workspace.",
  ) {
    super(message);
    this.name = "UniScenarioNameConflict";
  }
}

/**
 * A typed 409 from `PATCH /documents/[id]`.
 *
 * Carries the server's current document so a caller can rebase rather than re-fetch the page: the
 * body is `UniScenarioConflictDto`, and `refetch: true` is the server's instruction, not a hint.
 */
export class UniScenarioVersionConflict extends Error {
  constructor(
    readonly currentDraftVersion: number,
    readonly current: UniScenarioDocumentDto,
  ) {
    super("This scenario changed in another tab or session.");
    this.name = "UniScenarioVersionConflict";
  }
}

type ErrorBody = {
  error?: string;
  field?: string;
  refetch?: boolean;
  currentDraftVersion?: number;
  current?: UniScenarioDocumentDto;
};

const ERROR_MESSAGES: Record<string, string> = {
  dataset_name_taken:
    "A dataset with that name already exists in this workspace.",
  tag_label_taken: "A tag with that name already exists in this workspace.",
  dataset_action_denied: "You do not have permission to change this dataset.",
  dataset_not_found: "That dataset no longer exists.",
  document_not_found: "That scenario no longer exists.",
  tag_not_found: "That tag no longer exists.",
};

type SharedReadEntry = {
  readonly expiresAt: number;
  readonly promise: Promise<unknown>;
};

const sharedReads = new Map<string, SharedReadEntry>();
const DATASET_READ_KEY = "datasets";
const TAG_READ_KEY = "tags";
const MAP_READ_KEY = "maps";

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

function withCallerAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(abortError());
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function sharedRead<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const current = sharedReads.get(key);
  if (current && current.expiresAt > Date.now()) {
    return withCallerAbort(current.promise as Promise<T>, signal);
  }
  const promise = load().then(
    (value) => {
      if (sharedReads.get(key)?.promise === promise) {
        if (ttlMs > 0) sharedReads.set(key, { expiresAt: Date.now() + ttlMs, promise });
        else sharedReads.delete(key);
      }
      return value;
    },
    (error) => {
      if (sharedReads.get(key)?.promise === promise) sharedReads.delete(key);
      throw error;
    },
  );
  // An in-flight request never expires. The finite TTL begins only after it
  // resolves, so a slow request cannot be replaced by a second request.
  sharedReads.set(key, { expiresAt: Number.POSITIVE_INFINITY, promise });
  return withCallerAbort(promise, signal);
}

function invalidateSharedRead(key: string) {
  sharedReads.delete(key);
}

function invalidateAfter<T>(key: string, mutation: Promise<T>): Promise<T> {
  return mutation.then((value) => {
    invalidateSharedRead(key);
    return value;
  });
}

/** Test seam for module-scoped request/result sharing. */
export function resetUniScenarioReadCacheForTests() {
  sharedReads.clear();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: init?.body
      ? { "content-type": "application/json", ...init?.headers }
      : { ...init?.headers },
  });
  if (response.ok) {
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
  const body = (await response.json().catch(() => null)) as ErrorBody | null;
  if (
    response.status === 409 &&
    body?.error === "draft_version_conflict" &&
    body.current
  ) {
    throw new UniScenarioVersionConflict(
      body.currentDraftVersion ?? 0,
      body.current,
    );
  }
  if (
    response.status === 409 &&
    (body?.error === "dataset_name_taken" || body?.error === "tag_label_taken")
  ) {
    throw new UniScenarioNameConflict(
      body.field ?? "name",
      ERROR_MESSAGES[body.error],
    );
  }
  throw new Error(
    (body?.error ? ERROR_MESSAGES[body.error] : null) ??
      body?.error ??
      `Request failed (${response.status}).`,
  );
}

// ── Datasets ────────────────────────────────────────────────────────────────

export async function listDatasets(signal?: AbortSignal) {
  const body = await sharedRead(
    DATASET_READ_KEY,
    0,
    () => request<{ datasets: UniScenarioDatasetDto[] }>("/api/uniscenario/datasets"),
    signal,
  );
  return body.datasets;
}

export function createDataset(input: {
  name: string;
  description?: string | null;
}) {
  return invalidateAfter(
    DATASET_READ_KEY,
    request<UniScenarioDatasetDto>("/api/uniscenario/datasets", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export function updateDataset(
  datasetId: string,
  input: { name?: string; description?: string | null },
) {
  return invalidateAfter(
    DATASET_READ_KEY,
    request<UniScenarioDatasetDto>(
      `/api/uniscenario/datasets/${encodeURIComponent(datasetId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  );
}

export function deleteDataset(datasetId: string) {
  return invalidateAfter(
    DATASET_READ_KEY,
    request<{ ok: true; deletedDocumentCount: number }>(
      `/api/uniscenario/datasets/${encodeURIComponent(datasetId)}`,
      { method: "DELETE" },
    ),
  );
}

export function getDatasetReadiness(datasetId: string, signal?: AbortSignal) {
  return request<UniScenarioDatasetReadinessDto>(
    `/api/uniscenario/datasets/${encodeURIComponent(datasetId)}/readiness`,
    { signal },
  );
}

// ── Documents ───────────────────────────────────────────────────────────────

export function listDocumentSummaries(
  input: { datasetId: string; limit?: number; cursor?: string | null },
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({
    datasetId: input.datasetId,
    limit: String(input.limit ?? 50),
  });
  if (input.cursor) query.set("cursor", input.cursor);
  return request<UniScenarioDocumentSummaryPageDto>(
    `/api/uniscenario/documents/summaries?${query}`,
    { signal },
  );
}

export function getDocument(documentId: string, signal?: AbortSignal) {
  return request<UniScenarioDocumentDto>(
    `/api/uniscenario/documents/${encodeURIComponent(documentId)}`,
    { signal },
  );
}

export async function getSimulationPreview(documentId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/uniscenario/documents/${encodeURIComponent(documentId)}/simulation-preview`, { cache: "no-store", signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Saved simulation lookup failed (${response.status}).`);
  return response.json() as Promise<UniScenarioSimulationPreviewDto>;
}
type SimulationPreviewReservation = { artifactId: string; uploadRequired: boolean; uploadUrl: string | null; headers: Record<string, string> };
export async function saveSimulationPreview(document: Pick<UniScenarioDocumentDto, "id" | "draftVersion">, bytes: Uint8Array, sha256: string, signal?: AbortSignal) {
  const identity = { expectedVersion: document.draftVersion, sha256, sizeBytes: bytes.byteLength };
  const reservation = await request<SimulationPreviewReservation>(`/api/uniscenario/documents/${encodeURIComponent(document.id)}/simulation-preview`, { method: "POST", body: JSON.stringify(identity), signal });
  if (reservation.uploadRequired) { if (!reservation.uploadUrl) throw new Error("Saved simulation reservation has no upload URL"); const uploaded = await fetch(reservation.uploadUrl, { method: "PUT", headers: reservation.headers, body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, signal }); if (!uploaded.ok) throw new Error(`Saved simulation upload failed (${uploaded.status})`); }
  await request<{ ok: true }>(`/api/uniscenario/documents/${encodeURIComponent(document.id)}/simulation-preview/complete`, { method: "POST", body: JSON.stringify({ ...identity, artifactId: reservation.artifactId }), signal });
}

export function createDocument(input: {
  title: string;
  description?: string;
  schemaVersion: string;
  content: unknown;
  mapVersionId: string | null;
  datasetId: string;
  authoringQualityId: string;
}) {
  return request<UniScenarioDocumentDto>("/api/uniscenario/documents", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Patch a document's metadata.
 *
 * `expectedVersion` is mandatory in `UpdateUniScenarioDocumentSchema` and is what makes a rename
 * safe without a lock: if the draft moved underneath, the route 409s and the caller gets a
 * `UniScenarioVersionConflict` carrying the current document instead of silently overwriting an edit
 * made in another tab (§6.7.2).
 */
export function updateDocument(
  documentId: string,
  input: { expectedVersion: number; title?: string; description?: string },
) {
  return request<UniScenarioDocumentDto>(
    `/api/uniscenario/documents/${encodeURIComponent(documentId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

export function duplicateDocument(
  documentId: string,
  input: { title?: string; datasetId?: string } = {},
) {
  return request<UniScenarioDocumentDto>(
    `/api/uniscenario/documents/${encodeURIComponent(documentId)}/duplicate`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function deleteDocument(documentId: string) {
  return request<{ ok: true }>(
    `/api/uniscenario/documents/${encodeURIComponent(documentId)}`,
    {
      method: "DELETE",
    },
  );
}

// ── Tags ────────────────────────────────────────────────────────────────────

export async function listTags(signal?: AbortSignal) {
  const body = await sharedRead(
    TAG_READ_KEY,
    0,
    () => request<{ tags: UniScenarioTagDto[] }>("/api/uniscenario/tags"),
    signal,
  );
  return body.tags;
}

export function createTag(input: { label: string; color?: string | null }) {
  return invalidateAfter(
    TAG_READ_KEY,
    request<UniScenarioTagDto>("/api/uniscenario/tags", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export function updateTag(
  tagId: string,
  input: { label?: string; color?: string | null },
) {
  return invalidateAfter(
    TAG_READ_KEY,
    request<UniScenarioTagDto>(
      `/api/uniscenario/tags/${encodeURIComponent(tagId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ),
  );
}

export function deleteTag(tagId: string) {
  return invalidateAfter(
    TAG_READ_KEY,
    request<{ ok: true }>(
      `/api/uniscenario/tags/${encodeURIComponent(tagId)}`,
      {
        method: "DELETE",
      },
    ),
  );
}

export async function setDocumentTags(documentId: string, tagIds: string[]) {
  const body = await request<{ tags: UniScenarioTagDto[] }>(
    `/api/uniscenario/documents/${encodeURIComponent(documentId)}/tags`,
    { method: "PUT", body: JSON.stringify({ tagIds }) },
  );
  return body.tags;
}

// ── Ratings ─────────────────────────────────────────────────────────────────

export async function listRatingAggregates(
  documentIds: string[],
  signal?: AbortSignal,
) {
  const body = await request<{ aggregates: UniScenarioRatingAggregateDto[] }>(
    "/api/uniscenario/documents/ratings/batch",
    { method: "POST", body: JSON.stringify({ documentIds }), signal },
  );
  return body.aggregates;
}

export async function setDocumentRating(
  documentId: string,
  input: {
    score: number;
    revisionId?: string | null;
    reviewedVia?: "queue" | "browser";
  },
) {
  const body = await request<{
    aggregate: UniScenarioRatingAggregateDto | null;
  }>(`/api/uniscenario/documents/${encodeURIComponent(documentId)}/rating`, {
    method: "PUT",
    body: JSON.stringify({ reviewedVia: "browser", ...input }),
  });
  return body.aggregate;
}

export async function clearDocumentRating(documentId: string) {
  const body = await request<{
    aggregate: UniScenarioRatingAggregateDto | null;
  }>(`/api/uniscenario/documents/${encodeURIComponent(documentId)}/rating`, {
    method: "DELETE",
  });
  return body.aggregate;
}

// ── Maps ────────────────────────────────────────────────────────────────────

/**
 * The map catalog, narrowed to what the list needs.
 *
 * The route's descriptors carry presigned manifest and topology URLs that only the editor's renderer
 * uses; narrowing here keeps those out of list state, where they would sit past their 1h expiry
 * (§2.5.3).
 *
 * `browserManifestUrl` is deliberately kept, and it is the one exception rather than a hole in that
 * rule: it is a path on our own proxy, not a presigned S3 URL, so there is no expiry for list state to
 * outlive. The datasets-page scene needs it to mount a map at all.
 */
export async function listMapOptions(
  signal?: AbortSignal,
): Promise<UniScenarioMapOption[]> {
  return sharedRead(MAP_READ_KEY, 5 * 60_000, async () => {
    const body = await request<{
      maps: Array<{
        mapVersionId: string;
        sourceMapId: string;
        label: string;
        locality: string | null;
        browserAssetRootUrl: string;
        thumbnailUrl: string | null;
        browserManifestUrl: string;
        browserClosureSha256: string;
        artifacts: {
          xodrSha256: string;
          topologySha256: string;
          derivedTopologySha256: string;
          locationsSha256: string;
          signalsSha256: string;
          lanePolygonsSha256: string;
        };
        sumoNetworkSha256: string | null;
        topologyArtifactUrl: string;
        signalsArtifactUrl: string | null;
        derivedTopologyUrl: string | null;
        locationsUrl: string | null;
        sumoNetworkUrl: string | null;
      }>;
    }>("/api/uniscenario/maps");
    return body.maps.map((entry) => ({
      id: entry.mapVersionId,
      versionId: entry.mapVersionId,
      mapVersionId: entry.mapVersionId,
      sourceMapId: entry.sourceMapId,
      label: entry.label,
      locality: entry.locality ?? "",
      browserAssetRootUrl: entry.browserAssetRootUrl,
      thumbnailUrl: entry.thumbnailUrl,
      browserManifestUrl: entry.browserManifestUrl,
      browserClosureSha256: entry.browserClosureSha256,
      artifacts: entry.artifacts,
      sumoNetworkSha256: entry.sumoNetworkSha256,
      manifestUrl: entry.browserManifestUrl,
      topologyUrl: entry.topologyArtifactUrl,
      signalsUrl: entry.signalsArtifactUrl,
      derivedTopologyUrl: entry.derivedTopologyUrl,
      locationsUrl: entry.locationsUrl,
      sumoNetworkUrl: entry.sumoNetworkUrl,
    }));
  }, signal);
}

export type UniScenarioDocumentSummary = UniScenarioDocumentSummaryDto;
