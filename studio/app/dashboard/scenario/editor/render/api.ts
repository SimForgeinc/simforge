/**
 * Browser calls for the render, details and artifact tabs.
 *
 * Kept beside the components rather than in `app/lib/scenario/editor/api.ts` because that module
 * is shared with every other port lane and none of them need these seven endpoints. Same reason
 * `lib/scenario/render/contracts.ts` is its own file.
 *
 * Every read here is uncached by construction: the routes send `private, no-store`, and each call
 * passes an `AbortSignal` so a panel that closes or a document that changes cancels its own in-flight
 * request instead of resolving into an unmounted tree.
 */

import type {
  ScenarioGalleryItemDto,
  ScenarioPostprocessInput,
  ScenarioPresignedArtifactDto,
  ScenarioRenderArtifactDto,
  ScenarioRenderJobDetailDto,
  ScenarioRenderJobMode,
  ScenarioExportInspectionDto,
} from "@/app/lib/scenario/render/contracts";
import type {
  ScenarioExportDto,
  ScenarioRenderJobDto,
} from "@/app/lib/scenario/contracts";
import type { SubmitScenarioRenderIntent } from "@/app/lib/scenario/render-wire-contracts";

/**
 * An artifact from `[jobId]/downloads` — the one route that signs.
 *
 * `url` is present only for `available`; every other state returns `url: null`. **Branch on
 * `artifactState`, never on url presence**: a state added later would also arrive `url: null` and must
 * read as "not ready", not as an error.
 */
export type PresignedArtifact =
  | ScenarioPresignedArtifactDto
  | (ScenarioRenderArtifactDto & { url: null });

/**
 * An artifact from `artifact-index` or `[jobId]/detail` — metadata only, no URL, by design.
 *
 * Those routes never presign, because signing a whole workspace or re-signing on every detail poll
 * mints 3600-second credentials nobody uses. A URL is obtained per job, on demand, from `downloads`.
 */
export type ArtifactMetadata = ScenarioRenderArtifactDto & {
  url?: undefined;
  renderJobId?: string | null;
};

export type WorkspaceArtifact = ScenarioRenderArtifactDto & { renderJobId: string | null };

/** Either shape. Components that only display metadata accept both. */
export type DisplayArtifact = PresignedArtifact | ArtifactMetadata | WorkspaceArtifact;

const BASE = "/api/uniscenario/render-jobs";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new RenderRequestError(body?.error ?? `render_request_failed_${response.status}`, response.status);
  }
  return response.json() as Promise<T>;
}

/**
 * Carries the route's error code, not just a message.
 *
 * The postprocess form needs to tell `parent_not_succeeded` (wait) from `source_artifact_unavailable`
 * (pick another file) from a 403 (you cannot write here), and a stringified message cannot be
 * branched on without matching prose.
 */
export class RenderRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "RenderRequestError";
  }
}

export function fetchRenderGallery(
  options: {
    revisionId?: string | null;
    documentId?: string | null;
    jobMode?: ScenarioRenderJobMode | null;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<{ items: ScenarioGalleryItemDto[]; hiddenCount: number }> {
  const params = new URLSearchParams();
  if (options.revisionId) params.set("revisionId", options.revisionId);
  if (options.documentId) params.set("documentId", options.documentId);
  if (options.jobMode) params.set("jobMode", options.jobMode);
  if (options.limit != null) params.set("limit", String(options.limit));
  const query = params.toString();
  return request(`${BASE}/gallery${query ? `?${query}` : ""}`, { signal });
}

export function fetchRenderJobDetail(
  jobId: string,
  signal?: AbortSignal,
): Promise<ScenarioRenderJobDetailDto> {
  return request(`${BASE}/${encodeURIComponent(jobId)}/detail`, { signal });
}

/** `[jobId]/downloads` — the only route that mints URLs, scoped to one job. */
export async function fetchRenderJobDownloads(
  jobId: string,
  signal?: AbortSignal,
): Promise<PresignedArtifact[]> {
  const body = await request<{ items: PresignedArtifact[] }>(
    `${BASE}/${encodeURIComponent(jobId)}/downloads`,
    { signal },
  );
  return body.items;
}

export async function fetchPostprocessChildren(
  parentRenderJobId: string,
  signal?: AbortSignal,
): Promise<ScenarioGalleryItemDto[]> {
  const body = await request<{ items: ScenarioGalleryItemDto[] }>(
    `${BASE}/${encodeURIComponent(parentRenderJobId)}/postprocess`,
    { signal },
  );
  return body.items;
}

/** `artifact-index` — workspace browse, metadata only. Pair with `fetchRenderJobDownloads` to open one. */
export async function fetchArtifactIndex(
  options: { artifactKind?: string | null; limit?: number },
  signal?: AbortSignal,
): Promise<WorkspaceArtifact[]> {
  const params = new URLSearchParams();
  if (options.artifactKind) params.set("artifactKind", options.artifactKind);
  if (options.limit != null) params.set("limit", String(options.limit));
  const query = params.toString();
  const body = await request<{ items: WorkspaceArtifact[] }>(
    `${BASE}/artifact-index${query ? `?${query}` : ""}`,
    { signal },
  );
  return body.items;
}

/**
 * Resolve one browse-index artifact to a signed URL, at the moment the author asks to open it.
 *
 * The index carries no URL, so opening a file means signing its whole job and picking the one row out.
 * That is deliberately not memoised across calls: a signature lives 3600s and a cached one handed back
 * later could already be dead, which would present as a broken player rather than as a retry. Signing
 * again is one round-trip and always correct.
 */
export async function resolveArtifactUrl(
  renderJobId: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<PresignedArtifact | null> {
  const items = await fetchRenderJobDownloads(renderJobId, signal);
  return items.find((item) => item.id === artifactId) ?? null;
}

export function setRenderJobHidden(
  jobId: string,
  hidden: boolean,
): Promise<{ id: string; hiddenAt: string | null; hiddenByUserId: string | null }> {
  return request(`${BASE}/${encodeURIComponent(jobId)}/hidden`, {
    method: "PATCH",
    body: JSON.stringify({ hidden }),
  });
}

/**
 * Queue a postprocess run.
 *
 * The parent goes in the path and is stripped from the body: the route takes it from the path so it
 * cannot differ from the id it authorized, and sending it twice would imply the body's copy matters.
 */
export function createPostprocessJob(
  input: ScenarioPostprocessInput,
): Promise<{ id: string; created: boolean }> {
  const { parentRenderJobId, ...body } = input;
  return request(`${BASE}/${encodeURIComponent(parentRenderJobId)}/postprocess`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function cancelRenderJob(jobId: string): Promise<unknown> {
  return request(`${BASE}/${encodeURIComponent(jobId)}`, { method: "DELETE" });
}

export function prepareOpenScenarioExport(
  revisionId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ScenarioExportDto> {
  return request("/api/uniscenario/exports", {
    method: "POST",
    body: JSON.stringify({ revisionId, idempotencyKey }),
    signal,
  });
}

export async function listOpenScenarioExports(
  revisionId: string,
  signal?: AbortSignal,
): Promise<ScenarioExportDto[]> {
  const result = await request<{ exports: ScenarioExportDto[] }>(
    `/api/uniscenario/exports?revisionId=${encodeURIComponent(revisionId)}`,
    { signal },
  );
  return result.exports;
}

export function fetchOpenScenarioExport(
  exportId: string,
  signal?: AbortSignal,
): Promise<ScenarioExportDto> {
  return request(`/api/uniscenario/exports/${encodeURIComponent(exportId)}`, { signal });
}

export function inspectOpenScenarioExport(
  exportId: string,
  signal?: AbortSignal,
): Promise<ScenarioExportInspectionDto> {
  return request(`/api/uniscenario/exports/${encodeURIComponent(exportId)}/inspection`, { signal });
}

/** One `uniscenario.validation_runs` row, as returned by `/api/uniscenario/validation-runs`. */
export type ScenarioValidationRunDto = {
  id: string;
  revision_id: string;
  validator_kind: string;
  validator_version: string;
  validation_state: string;
  report_artifact_id: string | null;
  trace_artifact_id: string | null;
  summary: Record<string, unknown> | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export async function listValidationRuns(
  revisionId: string,
  signal?: AbortSignal,
): Promise<ScenarioValidationRunDto[]> {
  const body = await request<{ validationRuns: ScenarioValidationRunDto[] }>(
    `/api/uniscenario/validation-runs?revisionId=${encodeURIComponent(revisionId)}`,
    { signal },
  );
  return body.validationRuns;
}

export function createValidationRun(
  input: {
    revisionId: string;
    validatorKind: string;
    validatorVersion: string;
    idempotencyKey: string;
  },
  signal?: AbortSignal,
): Promise<ScenarioValidationRunDto> {
  return request("/api/uniscenario/validation-runs", {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
}

export function submitRenderIntent(
  input: SubmitScenarioRenderIntent,
  signal?: AbortSignal,
): Promise<ScenarioRenderJobDto> {
  return request(BASE, {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
}

/**
 * Download a presigned artifact.
 *
 * The signature is minted per request by the route and never persisted, so this takes a URL that was
 * just handed over rather than an id it would have to re-sign. Opening it in a new tab rather than
 * assigning `location` keeps the editor mounted — the WebGL context does not survive a navigation.
 */
export function openArtifactUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
