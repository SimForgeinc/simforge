import type { ScenarioTemplateV2 } from "@simforge/scenario";
import type { MaterializedTrafficArtifactEnvelope, SceneTrace } from "@simforge/engine";
import {
  consumeMaterializedTrafficSceneTraceEvidence,
  type BrowserMaterializedTrafficSceneTraceEvidence,
} from "@simforge/playback/traffic";
import type { ScenarioMapEntry } from "@simforge/editor";
import { fetchContentAddressedArtifact } from "@/app/lib/scenario/artifact-cache";
import {
  SCENARIO_SCHEMA_VERSION,
  type CreateScenarioRevisionResultDto,
  type ScenarioConflictDto,
  type ScenarioDocumentDto,
  type ScenarioExportDto,
  type ScenarioMapDescriptorDto,
  type ScenarioArtifactDto,
  type ScenarioRenderSpec,
  type ScenarioAuthoringQuality,
  type ScenarioRenderJobDto,
  type ScenarioJobProvenanceDto,
  type ScenarioAmbientProvenance,
  type ScenarioMaterializedTrafficReference,
  type ScenarioRevisionDto,
} from "@/app/lib/scenario/contracts";

export type ScenarioDocumentRecord = ScenarioDocumentDto;
export type ScenarioExportRecord = ScenarioExportDto;

export class ScenarioVersionConflict extends Error {
  constructor(readonly currentVersion: number | null) {
    super("This Scenario changed in another session. Reload before saving again.");
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (response.status === 409) {
    const conflict = await response.json().catch(() => null) as ScenarioConflictDto | null;
    throw new ScenarioVersionConflict(conflict?.currentDraftVersion ?? null);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `Scenario request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function unwrapList<T>(value: T[] | { items?: T[]; documents?: T[]; maps?: T[]; exports?: T[] }): T[] {
  if (Array.isArray(value)) return value;
  return value.items ?? value.documents ?? value.maps ?? value.exports ?? [];
}

export async function listScenarioMaps(signal?: AbortSignal): Promise<ScenarioMapEntry[]> {
  const response = await request<ScenarioMapDescriptorDto[] | { maps?: ScenarioMapDescriptorDto[] }>(
    "/api/uniscenario/maps",
    { signal },
  );
  return unwrapList(response).map((map) => ({
    id: map.mapVersionId,
    versionId: map.mapVersionId,
    mapVersionId: map.mapVersionId,
    sourceMapId: map.sourceMapId,
    label: map.label,
    locality: map.locality ?? "",
    browserAssetRootUrl: map.browserAssetRootUrl,
    browserManifestUrl: map.browserManifestUrl,
    browserClosureSha256: map.browserClosureSha256,
    artifacts: map.artifacts,
    sumoNetworkSha256: map.sumoNetworkSha256,
    manifestUrl: map.browserManifestUrl,
    topologyUrl: map.topologyArtifactUrl,
    derivedTopologyUrl: map.derivedTopologyUrl,
    locationsUrl: map.locationsUrl,
    signalsUrl: map.signalsArtifactUrl,
    sumoNetworkUrl: map.sumoNetworkUrl,
    xodrArtifactId: map.xodr.artifactId,
    coordinateSystemId: map.coordinateSystem.id,
  }));
}

export async function listScenarioDocuments(datasetId: string, signal?: AbortSignal): Promise<ScenarioDocumentRecord[]> {
  const response = await request<ScenarioDocumentRecord[] | { items?: ScenarioDocumentRecord[]; documents?: ScenarioDocumentRecord[] }>(
    `/api/uniscenario/documents?datasetId=${encodeURIComponent(datasetId)}`,
    { signal },
  );
  return unwrapList(response);
}

export function createScenarioDocument(
  input: {
    title: string;
    schemaVersion: string;
    mapVersionId: string;
    datasetId: string;
    authoringQualityId: ScenarioAuthoringQuality;
    content: ScenarioTemplateV2;
  },
  /** See `saveScenarioDocument` — the first save of a new document can also
   * be the one racing an unload. */
  options: { keepalive?: boolean } = {},
): Promise<ScenarioDocumentRecord> {
  return request("/api/uniscenario/documents", {
    method: "POST",
    body: JSON.stringify(input),
    keepalive: options.keepalive,
  });
}

export function saveScenarioDocument(
  document: ScenarioDocumentRecord,
  content: ScenarioTemplateV2,
  title = document.title,
  authoringQualityId: ScenarioAuthoringQuality = document.authoringQualityId,
  /**
   * `keepalive` lets the request outlive the document that started it, which is
   * the only way an autosave flush on `beforeunload` or `visibilitychange` can
   * reach the server. `sendBeacon` cannot be used here: it is POST-only and
   * cannot set `content-type: application/json`, which the mutation-origin
   * guard and the route body parser both require.
   */
  options: { keepalive?: boolean } = {},
): Promise<ScenarioDocumentRecord> {
  return request(`/api/uniscenario/documents/${encodeURIComponent(document.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedVersion: document.draftVersion, title, content, authoringQualityId }),
    keepalive: options.keepalive,
  });
}

export function createScenarioRevision(
  document: ScenarioDocumentRecord,
  idempotencyKey = crypto.randomUUID(),
  evidence?: {
    ambient: ScenarioAmbientProvenance;
    materializedTraffic: ScenarioMaterializedTrafficReference;
  },
): Promise<CreateScenarioRevisionResultDto> {
  if (!evidence) {
    return Promise.reject(new Error("This explicit export requires traffic evidence prepared for the current saved draft; ordinary preview playback does not persist evidence."));
  }
  return request(`/api/uniscenario/documents/${encodeURIComponent(document.id)}/revisions`, {
    method: "POST",
    body: JSON.stringify({
      expectedVersion: document.draftVersion,
      idempotencyKey,
      ...evidence,
    }),
  });
}

interface MaterializedTrafficReservation {
  artifactId: string;
  uploadRequired: boolean;
  uploadUrl: string | null;
  headers: Record<string, string>;
}

/** Reserve, upload exact canonical bytes, and complete one immutable browser traffic artifact. */
export async function uploadScenarioMaterializedTraffic(
  document: Pick<ScenarioDocumentRecord, "id" | "draftVersion">,
  envelope: MaterializedTrafficArtifactEnvelope,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ScenarioMaterializedTrafficReference> {
  const identity = {
    sha256: envelope.sha256,
    sizeBytes: envelope.sizeBytes,
    sourceInputDigest: envelope.artifact.sourceInputDigest,
    mapAssetId: envelope.artifact.map.assetId,
    mapVersionId: envelope.artifact.map.versionId,
  };
  const reservation = await request<MaterializedTrafficReservation>(
    `/api/uniscenario/documents/${encodeURIComponent(document.id)}/materialized-traffic/reserve`,
    { method: "POST", body: JSON.stringify({ expectedVersion: document.draftVersion, ...identity }), signal: options.signal },
  );
  if (reservation.uploadRequired) {
    if (!reservation.uploadUrl) throw new Error("Materialized traffic upload reservation has no upload URL");
    const uploaded = await fetch(reservation.uploadUrl, {
      method: "PUT",
      headers: reservation.headers,
      body: envelope.bytes.buffer.slice(
        envelope.bytes.byteOffset,
        envelope.bytes.byteOffset + envelope.bytes.byteLength,
      ) as ArrayBuffer,
      signal: options.signal,
    });
    if (!uploaded.ok) throw new Error(`Materialized traffic upload failed (${uploaded.status})`);
  }
  return request<ScenarioMaterializedTrafficReference>(
    `/api/uniscenario/documents/${encodeURIComponent(document.id)}/materialized-traffic/complete`,
    { method: "POST", body: JSON.stringify({ artifactId: reservation.artifactId, ...identity }), signal: options.signal },
  );
}

/**
 * Upload, refetch, decode, and bind the immutable bytes before the browser is
 * allowed to retain revision evidence or replay provider output.
 */
export async function uploadAndConsumeScenarioMaterializedTraffic(
  document: Pick<ScenarioDocumentRecord, "id" | "draftVersion">,
  envelope: MaterializedTrafficArtifactEnvelope,
  trace: SceneTrace,
  replaceActorIds: ReadonlySet<string> = new Set(),
  options: { readonly signal?: AbortSignal } = {},
): Promise<{
  readonly reference: ScenarioMaterializedTrafficReference;
  readonly evidence: BrowserMaterializedTrafficSceneTraceEvidence;
}> {
  const reference = await uploadScenarioMaterializedTraffic(document, envelope, options);
  const descriptor = await request<ScenarioArtifactDto>(
    `/api/uniscenario/artifacts/${encodeURIComponent(reference.artifactId)}?download=1`,
    { signal: options.signal },
  );
  if (descriptor.id !== reference.artifactId || descriptor.sha256 !== reference.sha256
      || descriptor.sizeBytes !== reference.sizeBytes) {
    throw new Error("Materialized traffic download descriptor does not match the completed artifact");
  }
  // Digest-addressed, so the cache can serve this without a staleness window;
  // the size and checksum checks moved into the cache and cover reads too.
  const bytes = await fetchContentAddressedArtifact(
    descriptor.downloadUrl,
    { sha256: reference.sha256, sizeBytes: reference.sizeBytes },
    { signal: options.signal, label: "Materialized traffic" },
  );
  return {
    reference,
    evidence: consumeMaterializedTrafficSceneTraceEvidence(trace, bytes, {
      sourceInputDigest: reference.sourceInputDigest,
      mapAssetId: reference.mapAssetId,
      mapVersionId: reference.mapVersionId,
      durationSeconds: envelope.artifact.durationSeconds,
      sha256: reference.sha256,
    }, { replaceActorIds }),
  };
}

function revisionResult(revision: ScenarioRevisionDto): CreateScenarioRevisionResultDto {
  return {
    revisionId: revision.id,
    exportId: revision.export.id,
    exportStatus: revision.export.status,
    revision,
  };
}

/**
 * Resolve the immutable revision for one saved draft before entering export/render state.
 *
 * Both list-side and editor-side render entry call this operation. The read-before-write closes an
 * ambiguous prior POST by finding the revision created for the exact draft version, while the stable
 * key lets the server close a retry that races that read. Failed exports deliberately use their
 * export id in a new stable key so the server can attach a retry export to the same revision.
 */
export async function ensureScenarioRevision(input: {
  documentId: string;
  expectedDraftVersion?: number | null;
  signal?: AbortSignal;
  ambient?: ScenarioAmbientProvenance;
  materializedTraffic?: ScenarioMaterializedTrafficReference;
}): Promise<CreateScenarioRevisionResultDto> {
  const document = input.expectedDraftVersion == null
    ? await request<ScenarioDocumentRecord>(
        `/api/uniscenario/documents/${encodeURIComponent(input.documentId)}`,
        { signal: input.signal },
      )
    : null;
  const expectedDraftVersion = input.expectedDraftVersion ?? document?.draftVersion;
  if (expectedDraftVersion == null) {
    throw new Error("The saved draft version could not be resolved.");
  }

  const response = await request<{ revisions: ScenarioRevisionDto[] }>(
    `/api/uniscenario/documents/${encodeURIComponent(input.documentId)}/revisions`,
    { signal: input.signal },
  );
  const existing = response.revisions.find(
    (revision) => revision.sourceDraftVersion === expectedDraftVersion,
  );
  if (existing && !["failed", "cancelled"].includes(existing.export.status)) {
    return revisionResult(existing);
  }

  const boundEvidence = input.ambient && input.materializedTraffic
    ? { ambient: input.ambient, materializedTraffic: input.materializedTraffic }
    : null;
  if (!boundEvidence) {
    throw new Error("Preparing a new revision requires explicit traffic evidence for this saved draft; opening render history and ordinary playback never create it.");
  }
  const retrySuffix = existing ? `:retry:${existing.export.id}` : "";
  return request(`/api/uniscenario/documents/${encodeURIComponent(input.documentId)}/revisions`, {
    method: "POST",
    body: JSON.stringify({
      expectedVersion: expectedDraftVersion,
      idempotencyKey: `ensure-revision:${input.documentId}:${expectedDraftVersion}${retrySuffix}`,
      ...boundEvidence,
    }),
    signal: input.signal,
  });
}

export async function waitForRevisionExport(
  revisionId: string,
  exportId: string,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<ScenarioExportRecord> {
  const attempts = options.attempts ?? 120;
  const intervalMs = options.intervalMs ?? 1_000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await request<ScenarioExportDto[] | { exports?: ScenarioExportDto[] }>(
      `/api/uniscenario/exports?revisionId=${encodeURIComponent(revisionId)}`,
    );
    const result = unwrapList(response).find((item) => item.id === exportId);
    if (!result) throw new Error("The revision export is no longer available");
    if (result.executionPackageId) return result;
    if (result.status === "succeeded")
      throw new Error("Export finished without an immutable execution package");
    if (result.status === "failed" || result.status === "cancelled")
      throw new Error(result.errorCode ?? "OpenSCENARIO export failed");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("OpenSCENARIO export did not finish in time");
}

export async function downloadExportArtifact(artifactId: string): Promise<void> {
  const artifact = await request<ScenarioArtifactDto>(
    `/api/uniscenario/artifacts/${encodeURIComponent(artifactId)}?download=1`,
  );
  const anchor = window.document.createElement("a");
  anchor.href = artifact.downloadUrl;
  anchor.download = artifact.kind === "compiled-xosc" ? "uniscenario.xosc" : artifact.id;
  anchor.click();
}

export async function openScenarioArtifact(artifactId: string): Promise<void> {
  const artifact = await request<ScenarioArtifactDto>(
    `/api/uniscenario/artifacts/${encodeURIComponent(artifactId)}`,
  );
  const anchor = window.document.createElement("a");
  anchor.href = artifact.downloadUrl;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.click();
}

export function submitRevisionJob(
  revisionId: string,
  executionPackageId: string,
  mode: "interaction_2d" | "full_render",
  renderSpec?: ScenarioRenderSpec,
): Promise<ScenarioRenderJobDto> {
  if (mode === "full_render" && !renderSpec) {
    throw new Error("Full renders require an explicit sensor specification.");
  }
  return request("/api/uniscenario/render-jobs", {
    method: "POST",
    body: JSON.stringify({
      revisionId,
      executionPackageId,
      mode,
      ...(mode === "full_render" ? { renderSpec } : {}),
      idempotencyKey: crypto.randomUUID(),
    }),
  });
}

/** Full-render convenience for callers with an explicit, authored sensor specification. */
export function renderRevision(revisionId: string, executionPackageId: string, renderSpec: ScenarioRenderSpec) {
  return submitRevisionJob(revisionId, executionPackageId, "full_render", renderSpec);
}

export async function listScenarioRenderJobs(): Promise<ScenarioRenderJobDto[]> {
  const result = await request<{ renderJobs: ScenarioRenderJobDto[] }>("/api/uniscenario/render-jobs");
  return result.renderJobs;
}

export async function cancelScenarioRenderJob(id: string): Promise<ScenarioRenderJobDto> {
  return request(`/api/uniscenario/render-jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getScenarioJobProvenance(id: string): Promise<ScenarioJobProvenanceDto> {
  return request(`/api/uniscenario/render-jobs/${encodeURIComponent(id)}/provenance`);
}

export { SCENARIO_SCHEMA_VERSION };
