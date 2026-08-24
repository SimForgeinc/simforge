"use client";

import { useEffect, useMemo, useState } from "react";

import {
  buildEditorSignalIndex,
  type EditorSignalControlProjection,
  type EditorSignalIndex,
} from "@/app/lib/scenario/signals";

/**
 * The projection for one map version, fetched inside the panel.
 *
 * ## Why this does not come through the slot
 *
 * The editor surface's signal props are shell state: the document, the interaction
 * state and the controller. The projection is none of those — it is a per-map-
 * version **server read** over three S3 artifacts, it changes only when the map
 * changes, and no other surface in the shell wants it. Widening the slot for it
 * would put a network read into the shell's contract and make every other slot's
 * host carry it.
 *
 * ## Why it is shared client-side
 *
 * The route is `private, no-store` — the body is workspace-scoped content. The
 * expensive part (parsing an XODR) is cached on the server keyed on
 * `(workspaceId, mapVersionId)`, where the immutability of a published artifact
 * set makes it safe; see `signals/projection-store.server.ts`. The browser also
 * shares one promise/result per immutable map version. React development
 * remounts and multiple consumers therefore cannot stampede the route, while a
 * failed request is evicted so a transient failure remains retryable.
 */

export type SignalProjectionState = {
  readonly index: EditorSignalIndex | null;
  readonly loading: boolean;
  /**
   * Set when the map version publishes no signal closure — a normal state for a
   * map with no traffic signals, and rendered as such rather than as a failure.
   */
  readonly unavailable: boolean;
  readonly error: string | null;
};

const IDLE: SignalProjectionState = {
  index: null,
  loading: false,
  unavailable: false,
  error: null,
};

const projectionReads = new Map<string, Promise<EditorSignalControlProjection | null>>();

function readSignalProjection(mapVersionId: string) {
  const existing = projectionReads.get(mapVersionId);
  if (existing) return existing;
  const pending = (async () => {
    const response = await fetch(
      `/api/uniscenario/maps/${encodeURIComponent(mapVersionId)}/signal-control`,
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Signal data request failed (${response.status})`);
    }
    return response.json() as Promise<EditorSignalControlProjection>;
  })().catch((error) => {
    if (projectionReads.get(mapVersionId) === pending) projectionReads.delete(mapVersionId);
    throw error;
  });
  projectionReads.set(mapVersionId, pending);
  return pending;
}

/** Test seam for the immutable, per-map browser projection cache. */
export function resetSignalProjectionCacheForTests() {
  projectionReads.clear();
}

export function useSignalProjection(mapVersionId: string | null): SignalProjectionState {
  const [projection, setProjection] = useState<EditorSignalControlProjection | null>(null);
  const [status, setStatus] = useState<Omit<SignalProjectionState, "index">>(IDLE);

  useEffect(() => {
    if (!mapVersionId) {
      setProjection(null);
      setStatus(IDLE);
      return;
    }
    // An `AbortController` rather than a bare fetch: switching maps twice
    // quickly would otherwise let the first response land after the second and
    // leave the panel authoring against the previous map's control digest,
    // which `checkPlanBinding` would then report as a stale binding on a plan
    // that is not stale.
    const abort = new AbortController();
    setStatus({ loading: true, unavailable: false, error: null });
    void (async () => {
      try {
        const next = await readSignalProjection(mapVersionId);
        if (abort.signal.aborted) return;
        if (!next) {
          setProjection(null);
          setStatus({ loading: false, unavailable: true, error: null });
          return;
        }
        setProjection(next);
        setStatus({ loading: false, unavailable: false, error: null });
      } catch (error) {
        if (abort.signal.aborted) return;
        setProjection(null);
        setStatus({
          loading: false,
          unavailable: false,
          error: error instanceof Error ? error.message : "Could not read this map's signal data.",
        });
      }
    })();
    return () => abort.abort();
  }, [mapVersionId]);

  // Memoized on the projection object, so the four id maps are built once per
  // map version rather than on every click of a head.
  const index = useMemo(
    () => (projection ? buildEditorSignalIndex(projection) : null),
    [projection],
  );

  return { index, ...status };
}
