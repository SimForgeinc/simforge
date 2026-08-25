"use client";

import { useEffect, useRef, useState } from "react";
import type { ScenarioArtifactDto } from "@/app/lib/scenario/contracts";

/**
 * Resolve a gallery tile's preview URL, but only once the tile is near the viewport.
 *
 * `ScenarioGalleryItemDto` carries `previewArtifactId` and not a URL, deliberately: a presigned URL
 * cannot be cached and must be minted per request (parity plan §2.5.3), so shipping fifty of them with
 * a gallery list would mean fifty signing round-trips on every poll for tiles the author may never
 * scroll to. Signing lazily, per visible tile, is what keeps that bounded.
 *
 * The observer is the same trick as v1's `useNearViewport`, with a 640px margin so a tile is signed
 * slightly before it is seen. Where `IntersectionObserver` is unavailable (jsdom, old runtimes) it
 * degrades to "visible immediately" rather than to a permanently blank tile.
 */
export function useNearViewport<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    if (nearViewport) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNearViewport(true);
      },
      { rootMargin: "640px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [nearViewport]);

  return [ref, nearViewport] as const;
}

/**
 * The preview media URL for one artifact id, or null.
 *
 * Resolves through `/api/simforge/artifacts/[artifactId]`, which already signs one artifact per
 * request under the workspace predicate and sets `private, no-store`. Returning null on any failure
 * is deliberate: a tile whose preview cannot be signed must fall back to its placeholder, not surface
 * an error — the render itself is fine, and the author has a details tab for real problems.
 */
export function useArtifactPreviewUrl(artifactId: string | null, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !artifactId) {
      setUrl(null);
      return;
    }
    const controller = new AbortController();
    void fetch(`/api/simforge/artifacts/${encodeURIComponent(artifactId)}`, {
      signal: controller.signal,
    })
      .then((response) => (response.ok ? (response.json() as Promise<ScenarioArtifactDto>) : null))
      .then((artifact) => {
        if (!controller.signal.aborted) setUrl(artifact?.downloadUrl ?? null);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [artifactId, enabled]);

  return url;
}
