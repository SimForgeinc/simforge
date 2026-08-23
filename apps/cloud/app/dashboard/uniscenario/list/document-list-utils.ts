import type { UniScenarioDocumentSummaryDto } from "@/app/lib/uniscenario/contracts";

export const UNISCENARIO_DOCUMENT_UPDATED_EVENT = "simforge:uniscenario-document-updated";
export const UNISCENARIO_DOCUMENTS_INVALIDATED_EVENT =
  "simforge:uniscenario-documents-invalidated";

export type UniScenarioDocumentsInvalidatedDetail = {
  datasetId?: string | null;
  documents?: UniScenarioDocumentSummaryDto[];
};

const SHORT_MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function documentName(document: UniScenarioDocumentSummaryDto) {
  const title = document.title?.trim();
  if (title) return title;
  const roles = document.roleCount ?? 0;
  return `Untitled Scenario (${roles} ${roles === 1 ? "Role" : "Roles"})`;
}

/** The map a document groups under. `mapLabel` is joined from `map_versions`; the id is the fallback. */
export function documentMapLabel(document: UniScenarioDocumentSummaryDto) {
  return document.mapLabel?.trim() || document.mapVersionId?.trim() || "No map";
}

export function documentEditedAtMs(document: UniScenarioDocumentSummaryDto) {
  const updatedAt = Date.parse(document.updatedAt ?? "");
  if (Number.isFinite(updatedAt)) return updatedAt;
  const createdAt = Date.parse(document.createdAt ?? "");
  return Number.isFinite(createdAt) ? createdAt : 0;
}

export function documentLastEditorName(document: UniScenarioDocumentSummaryDto) {
  return document.updatedByUserName?.trim() || document.createdByUserName?.trim() || null;
}

export function formatRelativeEditedAge(editedAtMs: number, nowMs = Date.now()) {
  const elapsedMs = Math.max(0, nowMs - editedAtMs);
  const elapsedMinutes = Math.max(1, Math.floor(elapsedMs / 60_000));
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} ${elapsedMinutes === 1 ? "minute" : "minutes"} ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  return `${elapsedHours} ${elapsedHours === 1 ? "hour" : "hours"} ago`;
}

export function documentEditedAtLabel(document: UniScenarioDocumentSummaryDto, nowMs = Date.now()) {
  const editedAtMs = documentEditedAtMs(document);
  if (!Number.isFinite(editedAtMs) || editedAtMs <= 0) return null;
  const date = new Date(editedAtMs);
  return `${SHORT_MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()} · ${formatRelativeEditedAge(editedAtMs, nowMs)}`;
}

export function formatDocumentCoverage(covered: number, total: number) {
  return `${covered.toLocaleString()} / ${total.toLocaleString()}`;
}

export function formatLastUpdated(value: string | null | undefined) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

/**
 * Splice one document into a list, inserting at the head when it is new.
 *
 * This is the optimistic-update primitive: every mutation applies its own result locally rather than
 * refetching, so the row the user just acted on never flickers back to its old value while a page
 * request is in flight.
 */
export function updateDocumentList(
  list: UniScenarioDocumentSummaryDto[] | undefined,
  next: UniScenarioDocumentSummaryDto,
) {
  const current = list ?? [];
  let found = false;
  const updated = current.map((item) => {
    if (item.id !== next.id) return item;
    found = true;
    return { ...item, ...next };
  });
  return found ? updated : [next, ...updated];
}

export function documentCreatorKey(document: UniScenarioDocumentSummaryDto) {
  return document.createdByUserName?.trim() || null;
}

/**
 * Project a freshly created or duplicated document — which comes back as a full
 * `UniScenarioDocumentDto` with `content` — onto the summary shape the list renders.
 *
 * The template-derived counts are read off `content` here rather than waiting for the STORED
 * GENERATED projection, so the new row shows its real role and prop counts immediately. They are
 * computed the same way the migration computes them, and the next page fetch replaces them with the
 * generated values.
 */
export function documentSummaryFromDocument(document: {
  id: string;
  workspaceId: string;
  title: string;
  datasetId: string;
  mapVersionId: string | null;
  latestRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
  content: {
    meta?: { description?: string | null; archetype?: string | null; author?: string | null; tags?: string[] };
    roles?: Array<{ actor?: { sensors?: unknown[] } }>;
    props?: unknown[];
    variants?: unknown[];
  };
}): UniScenarioDocumentSummaryDto {
  const meta = document.content?.meta ?? {};
  return {
    id: document.id,
    workspaceId: document.workspaceId,
    title: document.title,
    description: meta.description?.trim() || null,
    datasetId: document.datasetId,
    datasetSortOrder: 0,
    mapVersionId: document.mapVersionId,
    mapLabel: null,
    latestRevisionId: document.latestRevisionId,
    revisionCount: 0,
    archetype: meta.archetype ?? null,
    author: meta.author ?? null,
    contentTags: Array.isArray(meta.tags) ? meta.tags : [],
    tags: [],
    roleCount: document.content?.roles?.length ?? 0,
    hasSensorProfile:
      document.content?.roles?.some((role) => (role.actor?.sensors?.length ?? 0) > 0) ?? false,
    propCount: document.content?.props?.length ?? 0,
    variantCount: document.content?.variants?.length ?? 0,
    clipSeconds: null,
    negativeControl: false,
    derivationKind: null,
    derivedFromDocumentId: null,
    hasRender: false,
    createdByUserName: null,
    updatedByUserName: null,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}
