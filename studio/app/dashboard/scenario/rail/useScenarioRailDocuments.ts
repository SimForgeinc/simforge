"use client";

import { useCallback, useEffect, useState } from "react";
import type { ScenarioDocumentSummaryDto } from "@/app/lib/scenario/contracts";
import * as api from "../list/api";
import { updateDocumentList } from "../list/document-list-utils";
import { scenarioListCache } from "../list/scenarioListCache";

/**
 * The sibling documents the in-editor rail lists.
 *
 * Reads the same summary projection and the same module cache as the list, so opening the editor from
 * a row paints the rail from what the list already fetched instead of re-querying. That shared cache
 * is the whole reason this is a separate hook from `useScenarioDocumentList`: the rail wants one
 * page and no pagination controls, but it must not hold a second, divergent copy of the same rows.
 */
export function useScenarioRailDocuments(datasetId: string | null) {
  const [documents, setDocuments] = useState<ScenarioDocumentSummaryDto[]>(() =>
    datasetId ? (scenarioListCache.documentsByDataset[datasetId] ?? []) : [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publish = useCallback((id: string, next: ScenarioDocumentSummaryDto[]) => {
    scenarioListCache.documentsByDataset = {
      ...scenarioListCache.documentsByDataset,
      [id]: next,
    };
    setDocuments(next);
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!datasetId) return;
      setLoading(true);
      try {
        const page = await api.listDocumentSummaries({ datasetId, limit: 100 }, signal);
        if (signal?.aborted) return;
        scenarioListCache.loadedDatasetIds.add(datasetId);
        publish(datasetId, page.documents);
        setError(null);
      } catch (loadError) {
        if (signal?.aborted || (loadError as { name?: string } | null)?.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load scenarios.");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [datasetId, publish],
  );

  useEffect(() => {
    setDocuments(datasetId ? (scenarioListCache.documentsByDataset[datasetId] ?? []) : []);
    if (!datasetId) return;
    const abort = new AbortController();
    // Always refetch on mount even when the cache has rows: the editor is where documents change, so
    // the rail's copy is the one most likely to be stale. The cached rows are the first paint, not
    // the answer.
    void load(abort.signal);
    return () => abort.abort();
  }, [datasetId, load]);

  const spliceDocument = useCallback(
    (next: ScenarioDocumentSummaryDto) => {
      const id = next.datasetId || datasetId;
      if (!id) return;
      publish(id, updateDocumentList(scenarioListCache.documentsByDataset[id], next));
    },
    [datasetId, publish],
  );

  return { documents, loading, error, reload: load, spliceDocument };
}
