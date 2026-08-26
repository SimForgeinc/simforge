"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  MemoryStorage,
  WebTemplateFileStore,
} from "@simforge-oss/scenario";
import { type ActorRenderer, type CityViewer } from "@simforge-oss/viewer";
import type { GroundIndex } from "@simforge-oss/viewer";
import type { PlaybackBundle } from "@simforge-oss/playback";
import {
  EditorController,
  EditorDocument,
  type EditorState,
  type ScenarioMapEntry,
  warmAuthoringRuntime,
  warmSimulationAssets,
} from "@simforge-oss/editor";
import type { ScenarioDocumentRecord } from "./api";

export interface EditorRuntime {
  controller: EditorController | null;
  editorDocument: EditorDocument | null;
  state: EditorState | null;
  error: string | null;
  laneCount: number | null;
}

/** Build one bounded sampler for every high-volume editor height query. */
export function indexedEditorHeightSampler(
  viewer: {
    getGroundIndex(): Pick<GroundIndex, "sampleNear"> | null;
  },
): (x: number, z: number) => number | null {
  let sampleNear: Pick<GroundIndex, "sampleNear">["sampleNear"] | null = null;

  return (x, z) => {
    // `loadMap()` resolves after it has created the streaming layers, but the
    // road geometry can still be in flight. A controller created in that gap
    // must keep trying: caching the initial null leaves every placement in the
    // session on its fallback Y (usually zero), below elevated roads.
    sampleNear ??= viewer.getGroundIndex()?.sampleNear ?? null;
    return sampleNear?.(x, z) ?? null;
  };
}

/** Wait until streamed road geometry can supply the editor's bounded sampler. */
export function waitForIndexedEditorHeightSampler(
  viewer: {
    getGroundIndex(): Pick<GroundIndex, "sampleNear"> | null;
  },
  signal: AbortSignal,
  retryDelayMs = 16,
): Promise<(x: number, z: number) => number | null> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      finish();
      reject(new DOMException("Editor ground-index wait aborted", "AbortError"));
    };
    const poll = () => {
      if (signal.aborted) return onAbort();
      const sampleNear = viewer.getGroundIndex()?.sampleNear;
      if (sampleNear) {
        finish();
        resolve(sampleNear);
        return;
      }
      timer = setTimeout(poll, retryDelayMs);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    poll();
  });
}

export function useEditorRuntime({
  record,
  map,
  viewer,
  runtimeReady = true,
  hostRef,
  hostElement,
  actorRenderer,
  simulationPreview,
  onDocumentChange,
}: {
  record: ScenarioDocumentRecord | null;
  map: ScenarioMapEntry;
  viewer: CityViewer | null;
  /** False while a shared viewer is still loading the document's target map. */
  runtimeReady?: boolean;
  hostRef: RefObject<HTMLElement | null>;
  /** Canvas supplied by the persistent integrated world host. */
  hostElement?: HTMLElement | null;
  /** Shared world renderer; omitted by the standalone editor. */
  actorRenderer?: ActorRenderer | null;
  /** Completed background run for the current document revision. */
  simulationPreview?: PlaybackBundle | null;
  onDocumentChange: (document: EditorDocument) => void;
}): EditorRuntime {
  const [editorDocument, setEditorDocument] = useState<EditorDocument | null>(
    null,
  );
  const [controller, setController] = useState<EditorController | null>(null);
  const [laneCount, setLaneCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recordRef = useRef(record);
  recordRef.current = record;

  useEffect(() => {
    let disposed = false;
    let live: EditorDocument | null = null;
    const store = new WebTemplateFileStore({ storage: new MemoryStorage() });
    void EditorDocument.openBlank(map, { store, autosaveMs: 60_000 })
      .then((document) => {
        const initialRecord = recordRef.current;
        if (initialRecord) document.importTemplate(initialRecord.content);
        if (disposed) return document.dispose();
        live = document;
        setEditorDocument(document);
      })
      .catch((reason: unknown) => {
        if (!disposed)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      disposed = true;
      setEditorDocument(null);
      live?.dispose();
    };
  }, [map, record?.id]);

  useEffect(() => {
    if (!editorDocument) return;
    return editorDocument.subscribe(() => onDocumentChange(editorDocument));
  }, [editorDocument, onDocumentChange]);

  // Deliberately depends on `map` alone, NOT on `runtimeReady`: the point is to
  // start the lane graph and the worker's map assets while the scene is still
  // streaming, rather than queueing them behind it. See the module header.
  useEffect(() => {
    void warmAuthoringRuntime(map).catch(() => undefined);
  }, [map]);

  useEffect(() => {
    if (!viewer || !editorDocument || !runtimeReady) return;
    let disposed = false;
    let live: EditorController | null = null;
    const abort = new AbortController();
    setError(null);
    void Promise.all([
      // Reuses the warmup started above rather than fetching the topology a
      // second time; by the time the scene is ready this is already resolved.
      warmAuthoringRuntime(map),
      waitForIndexedEditorHeightSampler(viewer, abort.signal),
    ])
      .then(([laneIndex, sampleHeight]) => {
        if (disposed) return;
        // The scene is up, so the connection pool is free: pull the worker's
        // map data now rather than on the first compile. See the module header
        // for why this must not run while tiles are still streaming.
        warmSimulationAssets(map);
        live = new EditorController({
          viewer,
          laneIndex,
          document: editorDocument,
          ...(actorRenderer ? { renderer: actorRenderer } : {}),
          // Route overlays can contain thousands of points. Waiting for the
          // index keeps every initial placement/overlay on real ground without
          // falling back to unbounded per-point scene raycasts.
          sampleHeight,
        });
        const inputHost = hostElement ?? hostRef.current;
        if (inputHost) live.attach(inputHost);
        setLaneCount(laneIndex.stats.lanes);
        setController(live);
      })
      .catch((reason: unknown) => {
        if (
          disposed ||
          (reason as { name?: string } | null)?.name === "AbortError"
        )
          return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      disposed = true;
      abort.abort();
      live?.dispose();
      setController(null);
      setLaneCount(null);
    };
  }, [
    actorRenderer,
    editorDocument,
    hostElement,
    hostRef,
    map,
    runtimeReady,
    viewer,
  ]);

  useEffect(() => {
    if (!controller) return;
    controller.setSimulationPreview(simulationPreview
      ? { input: simulationPreview.instance.input, trace: simulationPreview.trace }
      : null);
  }, [controller, simulationPreview]);

  const state = useSyncExternalStore(
    controller ? controller.subscribe : noopSubscribe,
    controller ? controller.getSnapshot : nullSnapshot,
    nullSnapshot,
  );
  return { controller, editorDocument, state, error, laneCount };
}

function noopSubscribe(): () => void {
  return () => undefined;
}
function nullSnapshot(): null {
  return null;
}
