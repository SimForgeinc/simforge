"use client";

import { useEffect, useRef, useState } from "react";
import type { ParsedMapSearch } from "@/app/lib/maps/search/map-search";

/**
 * Client hook that runs map search against the server endpoint
 * `POST /api/map-assets/:id/search`. The server builds (or reuses a cached
 * corpus from) the sidecar `search_index.json`, so every object in the map
 * — candidate-backed or not — participates in ranking.
 *
 * Behaviour:
 *   - Debounces `query` changes so typing doesn't fan out a request per
 *     keystroke.
 *   - Aborts the in-flight request when `query` or `mapAssetId` changes.
 *   - Keeps the previous `data` visible while a new request is in flight
 *     (prevents result-list flicker during typing).
 *   - `isLoading` is true only for the first load or while in-flight after
 *     the debounce fires.
 *   - Re-runs the active query when `refreshKey` changes. Callers pass the
 *     detail-data hook's `enrichmentVersion` so that when async enrichment
 *     finishes and the `search_index.json` sidecar is rebuilt, displayed
 *     results refresh in place instead of requiring a manual page reload.
 *     (The server corpus cache is keyed on the sidecar's revision signature,
 *     so a re-issued request returns results from the new index.)
 */
const EMPTY_RESULT: ParsedMapSearch = {
  query: "",
  chips: [],
  results: [],
  freeText: [],
};

const DEBOUNCE_MS = 200;
const DEFAULT_LIMIT = 50;

export interface UseMapSearchServerResult {
  data: ParsedMapSearch;
  isLoading: boolean;
  error: string | null;
}

export function useMapSearchServer(
  mapAssetId: string,
  query: string,
  /**
   * Bump to force the active query to re-run (e.g. the detail-data hook's
   * `enrichmentVersion`, so search refreshes when the index is rebuilt).
   */
  refreshKey: number = 0,
  limit: number = DEFAULT_LIMIT,
): UseMapSearchServerResult {
  const [data, setData] = useState<ParsedMapSearch>(EMPTY_RESULT);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!mapAssetId) {
      setData(EMPTY_RESULT);
      setIsLoading(false);
      setError(null);
      return;
    }

    // Immediate result for an empty query — skip the round-trip so the list
    // clears as soon as the input is cleared.
    if (query.trim() === "") {
      abortRef.current?.abort();
      setData(EMPTY_RESULT);
      setIsLoading(false);
      setError(null);
      return;
    }

    const handle = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsLoading(true);
      setError(null);

      fetch(`/api/map-assets/${encodeURIComponent(mapAssetId)}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit }),
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(
              `map search failed (${res.status})${text ? `: ${text}` : ""}`,
            );
          }
          return (await res.json()) as ParsedMapSearch;
        })
        .then((parsed) => {
          if (controller.signal.aborted) return;
          setData(parsed);
          setIsLoading(false);
        })
        .catch((err: unknown) => {
          if ((err as { name?: string })?.name === "AbortError") return;
          setError(err instanceof Error ? err.message : String(err));
          setIsLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(handle);
    };
  }, [mapAssetId, query, limit, refreshKey]);

  // Abort any in-flight request on unmount.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  return { data, isLoading, error };
}
