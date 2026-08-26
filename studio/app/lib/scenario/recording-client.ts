import type {
  BrowserRecordingDetailDto,
  BrowserRecordingSummaryDto,
} from "./recording-contracts";
import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";

export type BrowserRecordingRevisionInput = {
  id: string;
  documentId: string;
  sourceDraftVersion: number;
  contentSha256: string;
  mapVersionId: string | null;
  content: ScenarioTemplateV2;
  createdAt: string;
};

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as
      | { error?: string }
      | null;
    throw new Error(payload?.error ?? `browser_recording_request_${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function listBrowserRecordingsClient(input: {
  revisionId?: string | null;
  documentId?: string | null;
  limit?: number;
  signal?: AbortSignal;
} = {}): Promise<BrowserRecordingSummaryDto[]> {
  const query = new URLSearchParams();
  if (input.revisionId) query.set("revisionId", input.revisionId);
  if (input.documentId) query.set("documentId", input.documentId);
  if (input.limit) query.set("limit", String(input.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await requestJson<{ recordings: BrowserRecordingSummaryDto[] }>(
    `/api/simforge/recordings${suffix}`,
    { signal: input.signal },
  );
  return response.recordings;
}


export function getBrowserRecordingClient(
  recordingId: string,
  signal?: AbortSignal,
) {
  return requestJson<BrowserRecordingDetailDto>(
    `/api/simforge/recordings/${encodeURIComponent(recordingId)}`,
    { signal },
  );
}

export function getBrowserRecordingRevisionInputClient(
  revisionId: string,
  signal?: AbortSignal,
) {
  return requestJson<BrowserRecordingRevisionInput>(
    `/api/simforge/revisions/${encodeURIComponent(revisionId)}/recording-input`,
    { signal },
  );
}
