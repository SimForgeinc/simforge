import type { ScenarioTemplateV2 } from "@uniscenarios/scenario-model";
import { registerExternalCatalogEntry } from "@uniscenarios/prop-catalog";
import {
  collectGalleryCatalogIds,
  galleryCatalogEntry,
} from "./catalog-entry";
import type { GalleryCatalogEntryDto } from "./contracts";

const RESOLUTION_MAX_AGE_MS = 50 * 60 * 1000;

const resolvedAt = new Map<string, number>();
const pending = new Map<string, Promise<boolean>>();

/**
 * Resolve gallery ids to short-lived model URLs and register them with the
 * synchronous prop catalog before editor-core sees them.
 *
 * Returns ids which the API could not resolve. Transport failures reject so an
 * interactive caller can surface the failure; document priming converts those
 * failures into its non-fatal unresolved-id result.
 */
export async function resolveGalleryCatalogIds(ids: string[]): Promise<string[]> {
  const uniqueIds = [...new Set(ids.filter(isGalleryCatalogId))];
  if (!uniqueIds.length) return [];

  const now = Date.now();
  const waiting = uniqueIds.filter((id) => {
    const cachedAt = resolvedAt.get(id);
    return cachedAt === undefined || now - cachedAt >= RESOLUTION_MAX_AGE_MS;
  });
  if (!waiting.length) return [];

  const unresolved = waiting.filter((id) => !pending.has(id));

  if (unresolved.length) {
    const request = resolveBatch(unresolved);
    for (const id of unresolved) {
      const result = request.then((missing) => !missing.has(id));
      pending.set(id, result);
      void result.then(
        () => pending.delete(id),
        () => pending.delete(id),
      );
    }
  }

  const outcomes = await Promise.all(
    waiting.map(async (id) => ({ id, resolved: await pending.get(id)! })),
  );
  return outcomes.filter(({ resolved }) => !resolved).map(({ id }) => id);
}

/**
 * Drop a cached signed URL and fetch/register a fresh one after a model request
 * reports that the URL was rejected. The stable catalog id remains the only
 * value persisted in the scenario document.
 */
export async function refreshGalleryCatalogId(catalogId: string): Promise<boolean> {
  if (!isGalleryCatalogId(catalogId)) return false;
  resolvedAt.delete(catalogId);
  return (await resolveGalleryCatalogIds([catalogId])).length === 0;
}

/** Resolve every gallery catalog reference before handing a document to editor-core. */
export async function primeGalleryEntriesForDocument(
  document: ScenarioTemplateV2,
): Promise<string[]> {
  const ids = collectGalleryCatalogIds(document);
  if (!ids.length) return [];
  try {
    return await resolveGalleryCatalogIds(ids);
  } catch {
    return ids;
  }
}

async function resolveBatch(ids: string[]): Promise<Set<string>> {
  const response = await fetch("/api/asset-gallery/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ catalogIds: ids }),
  });
  if (!response.ok) {
    throw new Error(`Could not resolve gallery assets (${response.status}).`);
  }

  const body = (await response.json()) as {
    entries: GalleryCatalogEntryDto[];
    missing: string[];
  };
  const returned = new Set<string>();
  const now = Date.now();
  for (const dto of body.entries) {
    registerExternalCatalogEntry(galleryCatalogEntry(dto));
    returned.add(dto.catalogId);
    resolvedAt.set(dto.catalogId, now);
  }

  const missing = new Set(body.missing);
  for (const id of ids) {
    if (!returned.has(id)) missing.add(id);
  }
  return missing;
}


function isGalleryCatalogId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("gallery.");
}
