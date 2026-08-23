"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SemanticMapOverlaySchema,
  type SemanticMapOverlay,
} from "@simcloud/shared";
import {
  constrainSemanticOverlayViewport,
  type SemanticOverlayViewport,
} from "./semantic-overlay";

// Client hook for the compact semantic map overlay. Every payload is Zod-
// validated against the shared overlay schema before it reaches editor state;
// an invalid or partial payload is a typed error, never partially-applied
// data. Responses are cached by exact (map, runtime, bounded viewport) key.

export type SemanticOverlayRuntime = "carla_ue4" | "carla_ue5";

export type SemanticOverlayErrorCode =
  | "unauthorized"
  | "map_not_found"
  | "invalid_request"
  | "semantic_overlay_too_large"
  | "semantic_graph_unavailable"
  | "invalid_overlay_payload"
  | "network_error";

export type SemanticOverlayError = {
  code: SemanticOverlayErrorCode;
  message: string;
};

export type UseSemanticMapOverlayArgs = {
  mapAssetId: string | null;
  runtime: SemanticOverlayRuntime | null;
  /** Bounded local-map viewport in runtime meters; null disables the fetch. */
  viewport: SemanticOverlayViewport | null;
  enabled?: boolean;
  /** Retry dense, already viewport-constrained requests at smaller spans. */
  adaptiveOnTooLarge?: boolean;
};

export type UseSemanticMapOverlayResult = {
  overlay: SemanticMapOverlay | null;
  loading: boolean;
  error: SemanticOverlayError | null;
  /** Drop the cache entry for the current key and refetch. */
  refresh: () => void;
};

const MAX_CACHED_OVERLAYS = 8;
const overlayCache = new Map<string, SemanticMapOverlay>();

function cacheKey(
  mapAssetId: string,
  runtime: SemanticOverlayRuntime,
  viewport: SemanticOverlayViewport,
) {
  // Quantize to 0.1 m so float jitter in derived viewports still cache-hits.
  const bounds = [
    viewport.minX,
    viewport.minY,
    viewport.maxX,
    viewport.maxY,
  ]
    .map((value) => value.toFixed(1))
    .join(",");
  return `${mapAssetId}:${runtime}:${bounds}`;
}

function rememberOverlay(key: string, overlay: SemanticMapOverlay) {
  overlayCache.delete(key);
  overlayCache.set(key, overlay);
  while (overlayCache.size > MAX_CACHED_OVERLAYS) {
    const oldest = overlayCache.keys().next().value;
    if (oldest === undefined) break;
    overlayCache.delete(oldest);
  }
}

function overlayRequestUrl(
  mapAssetId: string,
  runtime: SemanticOverlayRuntime,
  viewport: SemanticOverlayViewport,
) {
  const params = new URLSearchParams({
    runtime,
    minX: String(viewport.minX),
    minY: String(viewport.minY),
    maxX: String(viewport.maxX),
    maxY: String(viewport.maxY),
  });
  return `/api/map-assets/${mapAssetId}/semantic-overlay?${params.toString()}`;
}

function errorFromResponse(status: number, body: unknown): SemanticOverlayError {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message =
    typeof record.error === "string" && record.error.trim()
      ? record.error
      : `Semantic overlay request failed (HTTP ${status}).`;
  if (status === 401) return { code: "unauthorized", message };
  if (status === 404) return { code: "map_not_found", message };
  if (status === 400) return { code: "invalid_request", message };
  if (status === 413) return { code: "semantic_overlay_too_large", message };
  return { code: "semantic_graph_unavailable", message };
}

/** Fetch and validate the compact semantic overlay for one map/runtime. */
export function useSemanticMapOverlay({
  mapAssetId,
  runtime,
  viewport,
  enabled = true,
  adaptiveOnTooLarge = false,
}: UseSemanticMapOverlayArgs): UseSemanticMapOverlayResult {
  const [overlay, setOverlay] = useState<SemanticMapOverlay | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<SemanticOverlayError | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const key = useMemo(
    () =>
      enabled && mapAssetId && runtime && viewport
        ? cacheKey(mapAssetId, runtime, viewport)
        : null,
    [enabled, mapAssetId, runtime, viewport],
  );
  // The effect keys off the quantized cache key (not viewport identity) so a
  // re-derived-but-equal viewport object never triggers a refetch loop.
  const argsRef = useRef({ mapAssetId, runtime, viewport, adaptiveOnTooLarge });
  argsRef.current = { mapAssetId, runtime, viewport, adaptiveOnTooLarge };
  const keyRef = useRef(key);
  keyRef.current = key;

  const refresh = useCallback(() => {
    if (keyRef.current) overlayCache.delete(keyRef.current);
    setRefreshNonce((nonce) => nonce + 1);
  }, []);

  useEffect(() => {
    const { mapAssetId, runtime, viewport, adaptiveOnTooLarge } = argsRef.current;
    if (!key || !mapAssetId || !runtime || !viewport) {
      setOverlay(null);
      setLoading(false);
      setError(null);
      return;
    }

    const cached = overlayCache.get(key);
    if (cached) {
      setOverlay(cached);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      let response: Response | null = null;
      let payload: unknown = null;
      let attemptViewport = viewport;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          response = await fetch(
            overlayRequestUrl(mapAssetId, runtime, attemptViewport),
            { signal: controller.signal },
          );
          payload = await response.json().catch(() => null);
        } catch {
          if (cancelled || controller.signal.aborted) return;
          setOverlay(null);
          setLoading(false);
          setError({
            code: "network_error",
            message: "The semantic overlay request failed to reach the server.",
          });
          return;
        }
        if (
          response.status !== 413 ||
          !adaptiveOnTooLarge ||
          attempt === 3
        ) {
          break;
        }
        const currentSpan = Math.max(
          attemptViewport.maxX - attemptViewport.minX,
          attemptViewport.maxY - attemptViewport.minY,
        );
        attemptViewport = constrainSemanticOverlayViewport(
          attemptViewport,
          currentSpan / 2,
        );
      }
      if (cancelled) return;
      if (!response) return;
      if (!response.ok) {
        setOverlay(null);
        setLoading(false);
        setError(errorFromResponse(response.status, payload));
        return;
      }
      const parsed = SemanticMapOverlaySchema.safeParse(payload);
      if (!parsed.success) {
        setOverlay(null);
        setLoading(false);
        setError({
          code: "invalid_overlay_payload",
          message: "The semantic overlay response failed schema validation.",
        });
        return;
      }
      rememberOverlay(key, parsed.data);
      setOverlay(parsed.data);
      setLoading(false);
      setError(null);
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [adaptiveOnTooLarge, key, refreshNonce]);

  return { overlay, loading, error, refresh };
}

/** Test-only: reset the module-level overlay cache between cases. */
export function __clearSemanticOverlayCacheForTests() {
  overlayCache.clear();
}
