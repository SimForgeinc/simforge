"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashCameraSensor, ScenarioTemplateV2 } from "@uniscenarios/scenario-model";
import type { ActorRenderer } from "@uniscenarios/editor-core";
import type { CityViewer } from "@uniscenarios/city-renderer";
import { indexedWorldHeightSampler } from "@uniscenarios/city-renderer";
import {
  ambientTrafficProviderFromExtensions,
  DISABLED_SUMO_STATUS,
  type SumoTrafficStatus,
} from "@uniscenarios/ambient-traffic";
import { ambientTrafficProfileFromExtensions } from "@uniscenarios/ambient-traffic";
import type {
  UniScenarioAmbientProvenance,
  UniScenarioDocumentDto,
  UniScenarioMaterializedTrafficReference,
} from "@/app/lib/uniscenario/contracts";
import { contentHash, type MaterializedTrafficArtifactEnvelope } from "@uniscenarios/sim-engine";
import {
  CollisionActorOverrides,
  type PlaybackBundle,
  type PlaybackController,
} from "@uniscenarios/playback";
import { downloadSimulationPreview, encodeSimulationPreview } from "@/app/lib/uniscenario/playback/simulationPreview";
import { ScenarioWorkerClient } from "@/app/lib/uniscenario/playback/scenarioWorkerClient";
import { usePlayback } from "@/app/lib/uniscenario/playback/usePlayback";
import { playbackMapEntry } from "@/app/lib/uniscenario/maps";
import type { MapOverlayHandle } from "@/app/lib/uniscenario/mapOverlays";
import { useMapSignalOverlays } from "@/app/lib/uniscenario/useMapSignalOverlays";
import { uploadAndConsumeUniScenarioMaterializedTraffic } from "@/app/lib/uniscenario/editor/api";
import { loadSumoAssets } from "@/app/lib/uniscenario/ambient/sumoAssets";
import { normalizeAuthoringGraph } from "@uniscenarios/editor-core";
import * as api from "../list/api";
import type { UniScenarioMapOption } from "../list/document-map-groups";
import {
  mapSupportsScenarioPreview,
  previewAmbientTrafficProfile,
  previewExecutionTrafficProvider,
} from "./previewPolicy";
import { pickRandomMap, preloadMapManifests } from "./mapCatalog";
import {
  ambientProvenanceForRevisionTraffic,
  materializeBrowserRevisionTraffic,
} from "./revisionEvidence";

export type UniScenarioRevisionEvidence = {
  readonly ambient: UniScenarioAmbientProvenance;
  readonly materializedTraffic: UniScenarioMaterializedTrafficReference;
};

export type UniScenarioEvidenceRequest = {
  readonly key: string;
};

export type UniScenarioSharedPlayback = {
  readonly bundle: PlaybackBundle | null;
  /** Canonical authored-content identity that produced `bundle`; null fails browser capture closed. */
  readonly sourceContentIdentity: string | null;
  readonly controller: ReturnType<typeof usePlayback>["controller"];
  readonly state: ReturnType<typeof usePlayback>["state"];
  readonly error: string | null;
  /** Preparation failure text retained even when no playback controller exists. */
  readonly preparationMessage?: string | null;
  readonly inspecting: boolean;
  readonly setInspecting: (inspecting: boolean) => void;
  /** Status published by the one workspace-owned SUMO runtime. */
  readonly sumoStatus: SumoTrafficStatus;
  readonly setSumoStatus: (status: SumoTrafficStatus) => void;
  readonly collisionActorOverrides?: CollisionActorOverrides;
  /** World-owned traffic-signal furniture, state orbs, picking, and highlights. */
  readonly overlays: MapOverlayHandle | null;
  /**
   * Optional actor-mounted camera that temporarily owns the shared playback
   * view while the Render workspace is previewing or recording. The stable
   * actor/sensor ids remain the authored source of truth; this snapshot only
   * configures the current read-only controller.
   */
  readonly recordingCamera?: UniScenarioRecordingCamera | null;
  readonly setRecordingCamera?: (camera: UniScenarioRecordingCamera | null) => void;
};

export type UniScenarioRecordingCamera = {
  readonly actorId: string;
  readonly sensor: DashCameraSensor;
};

export interface UniScenarioSession {
  readonly maps: UniScenarioMapOption[] | null;
  readonly map: UniScenarioMapOption | null;
  readonly document: UniScenarioDocumentDto | null;
  readonly bundle: PlaybackBundle | null;
  readonly message: string | null;
  readonly failed: boolean;
  readonly playback: UniScenarioSharedPlayback;
  /** Narrow browser-capture host; it never owns or replaces the persistent world. */
  readonly capture?: {
    readonly viewer: CityViewer | null;
    readonly actorRenderer: ActorRenderer | null;
    readonly loadedMapVersionId: string | null;
  };
  /** Present only while an explicit action is materializing SUMO output. */
  readonly evidenceRequest: UniScenarioEvidenceRequest | null;
  prepareRevisionEvidence(documentId: string): Promise<UniScenarioRevisionEvidence>;
  completeRevisionEvidence(requestKey: string, artifact: MaterializedTrafficArtifactEnvelope): void;
  failRevisionEvidence(requestKey: string, reason: unknown): void;
  updateDocument(document: UniScenarioDocumentDto): void;
}

export class UniScenarioSessionResultFence {
  private generation = 0;
  private identity = "";

  begin(identity: string): number {
    this.identity = identity;
    return ++this.generation;
  }

  accepts(generation: number, identity: string): boolean {
    return generation === this.generation && identity === this.identity;
  }

  invalidate(): void {
    this.identity = "";
    this.generation += 1;
  }
}

export function applyScenarioPresentationVisibility(
  controller: Pick<PlaybackController, "setPresentationActive">,
  renderer: Pick<ActorRenderer, "setLayerVisible"> | null,
  playbackActive: boolean,
) {
  controller.setPresentationActive(playbackActive);
  // Browser SUMO owns an independent, warmed authoring frame. Playback may
  // hide its trace while the editor is active, but parked/queued SUMO traffic
  // should remain visible before Play and after Pause.
  if (typeof renderer?.setLayerVisible === "function") {
    renderer.setLayerVisible("sumo-traffic", true);
  }
}

/**
 * Canonical in-memory simulation session for the integrated datasets workspace.
 *
 * The worker and playback controller live for the workspace lifetime. A UI mode
 * change only changes presentation; document identity/content changes are the
 * only inputs that can fetch or compile a scenario.
 */
export function useUniScenarioSession({
  documentId,
  listPresentationActive,
  viewer,
  actorRenderer,
  loadedMapVersionId,
}: {
  documentId: string | null;
  listPresentationActive: boolean;
  viewer: CityViewer | null;
  actorRenderer: ActorRenderer | null;
  loadedMapVersionId: string | null;
}): UniScenarioSession {
  const [maps, setMaps] = useState<UniScenarioMapOption[] | null>(null);
  const [map, setMap] = useState<UniScenarioMapOption | null>(null);
  const [document, setDocument] = useState<UniScenarioDocumentDto | null>(null);
  const [bundle, setBundle] = useState<PlaybackBundle | null>(null);
  const collisionActorOverrides = useMemo(() => new CollisionActorOverrides(), []);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [inspecting, setInspectingState] = useState(false);
  const [recordingCamera, setRecordingCamera] = useState<UniScenarioRecordingCamera | null>(null);
  const [sumoStatus, setSumoStatus] = useState<SumoTrafficStatus>(DISABLED_SUMO_STATUS);
  const [evidenceRequest, setEvidenceRequest] = useState<UniScenarioEvidenceRequest | null>(null);
  const workerRef = useRef<ScenarioWorkerClient | null>(null);
  const previewSaveRef = useRef<AbortController | null>(null);
  const fetchGenerationRef = useRef(0);
  const prepareFenceRef = useRef(new UniScenarioSessionResultFence());
  const preparedKeyRef = useRef<string | null>(null);
  const pickedIdleMapRef = useRef(false);
  const evidenceCacheRef = useRef<{ key: string; evidence: UniScenarioRevisionEvidence } | null>(null);
  const bundleContentIdentityRef = useRef(new WeakMap<PlaybackBundle, string>());
  const persistedDocumentIdentityRef = useRef<{
    id: string;
    draftVersion: number;
    contentIdentity: string;
  } | null>(null);
  const evidencePendingRef = useRef<{
    key: string;
    promise: Promise<UniScenarioRevisionEvidence>;
    resolve: (evidence: UniScenarioRevisionEvidence) => void;
    reject: (reason: Error) => void;
    uploading: boolean;
    abort: AbortController;
  } | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    void api.listMapOptions(abort.signal).then(setMaps).catch((reason) => {
      if ((reason as { name?: string } | null)?.name !== "AbortError") setFailed(true);
    });
    return () => abort.abort();
  }, []);

  useEffect(() => {
    if (!maps) return;
    const generation = ++fetchGenerationRef.current;
    if (!documentId) {
      workerRef.current?.cancel();
      prepareFenceRef.current.invalidate();
      preparedKeyRef.current = null;
      persistedDocumentIdentityRef.current = null;
      setDocument(null);
      setBundle(null);
      setMessage(null);
      if (!pickedIdleMapRef.current) {
        pickedIdleMapRef.current = true;
        setMap(pickRandomMap(maps));
      }
      return;
    }
    if (document?.id === documentId) return;

    const abort = new AbortController();
    workerRef.current?.cancel();
    prepareFenceRef.current.invalidate();
    preparedKeyRef.current = null;
    persistedDocumentIdentityRef.current = null;
    setBundle(null);
    setMessage("Preparing scenario preview…");
    void api.getDocument(documentId, abort.signal).then((nextDocument) => {
      if (abort.signal.aborted || generation !== fetchGenerationRef.current) return;
      const canonical = withCanonicalEditorTimeline(nextDocument);
      persistedDocumentIdentityRef.current = {
        id: canonical.id,
        draftVersion: canonical.draftVersion,
        contentIdentity: contentHash(canonical.content),
      };
      setDocument(canonical);
    }).catch((reason) => {
      if (abort.signal.aborted || generation !== fetchGenerationRef.current) return;
      setMessage(reason instanceof Error
        ? `Preview unavailable: ${reason.message}`
        : "Preview unavailable for this scenario.");
    });
    return () => abort.abort();
  }, [document?.id, documentId, maps]);

  useEffect(() => {
    if (!maps || !document || document.id !== documentId) return;
    const nextMap = maps.find((candidate) => candidate.mapVersionId === document.mapVersionId) ?? null;
    setMap(nextMap);
    if (!nextMap || !mapSupportsScenarioPreview(nextMap)) {
      preparedKeyRef.current = null;
      setBundle(null);
      setMessage("Preview unavailable for this map.");
      return;
    }
    const simulationKey = contentHash({
      documentId: document.id,
      content: document.content,
      mapVersionId: nextMap.mapVersionId,
      sourceMapId: nextMap.sourceMapId,
    });
    const sourceContentIdentity = contentHash(document.content);
    const prepareKey = `${listPresentationActive ? "saved" : "editor"}:${simulationKey}:${document.draftVersion}`;
    if (preparedKeyRef.current === prepareKey) return;
    preparedKeyRef.current = prepareKey;
    const generation = prepareFenceRef.current.begin(prepareKey);
    const compileScenarioPreview = () => {
      const worker = workerRef.current ?? new ScenarioWorkerClient();
      workerRef.current = worker;
      worker.cancel();
      const provider = ambientTrafficProviderFromExtensions(document.content.extensions);
      setBundle(null);
      setMessage("Preparing scenario preview…");
      void worker.prepare(
        document.content as ScenarioTemplateV2,
        playbackMapEntry(nextMap),
        previewAmbientTrafficProfile(
          provider,
          document.content.extensions,
          document.content.mapSignalPlans.length > 0,
        ),
        undefined,
        { backgroundPreview: true },
      ).then((nextBundle) => {
        if (!prepareFenceRef.current.accepts(generation, prepareKey) || documentId !== document.id) return;
        bundleContentIdentityRef.current.set(nextBundle, sourceContentIdentity);
        setBundle(nextBundle);
        setMessage(null);
        previewSaveRef.current?.abort();
        const saveAbort = new AbortController(); previewSaveRef.current = saveAbort;
        void encodeSimulationPreview(nextBundle, document.draftVersion)
          .then(({ bytes, sha256 }) => api.saveSimulationPreview(document, bytes, sha256, saveAbort.signal))
          .catch(() => undefined);
      }).catch((reason) => {
        if (!prepareFenceRef.current.accepts(generation, prepareKey)
            || (reason as { name?: string } | null)?.name === "AbortError") return;
        setMessage(reason instanceof Error
          ? `Preview unavailable: ${reason.message}`
          : "Preview unavailable for this scenario.");
      });
    };
    if (listPresentationActive) {
      workerRef.current?.cancel();
      // Leaving the editor already has the exact trace in memory. Keep it on
      // screen while its immutable upload finishes instead of introducing a
      // download race or a blank frame. A fresh list visit always takes the
      // persisted path below.
      if (bundle) { setMessage(null); return; }
      setBundle(null);
      // Prefer the persisted trace for an instant selection preview. Older
      // scenarios may not have one yet, so compile it on demand rather than
      // leaving the selected row highlighted over an empty world.
      setMessage("Preparing scenario preview…");
      const abort = new AbortController();
      void api.getSimulationPreview(document.id, abort.signal).then(async (descriptor) => {
        if (!prepareFenceRef.current.accepts(generation, prepareKey)) return;
        if (!descriptor) { compileScenarioPreview(); return; }
        const saved = await downloadSimulationPreview(descriptor, abort.signal);
        if (!prepareFenceRef.current.accepts(generation, prepareKey)) return;
        bundleContentIdentityRef.current.set(saved, sourceContentIdentity);
        setBundle(saved); setMessage(null);
      }).catch((reason) => {
        if (!prepareFenceRef.current.accepts(generation, prepareKey) || (reason as { name?: string } | null)?.name === "AbortError") return;
        compileScenarioPreview();
      });
      return () => abort.abort();
    }
    if (bundle && bundleContentIdentityRef.current.get(bundle) === sourceContentIdentity) {
      setMessage(null);
      return;
    }

    setBundle(null);
    setMessage("Preparing scenario preview…");
    const persisted = persistedDocumentIdentityRef.current;
    const canReuseSavedPreview = persisted?.id === document.id
      && persisted.draftVersion === document.draftVersion
      && persisted.contentIdentity === sourceContentIdentity;
    if (!canReuseSavedPreview) {
      compileScenarioPreview();
      return;
    }

    const abort = new AbortController();
    void api.getSimulationPreview(document.id, abort.signal).then(async (descriptor) => {
      if (!prepareFenceRef.current.accepts(generation, prepareKey)) return;
      if (!descriptor || descriptor.draftVersion !== document.draftVersion) {
        compileScenarioPreview();
        return;
      }
      const saved = await downloadSimulationPreview(descriptor, abort.signal);
      if (!prepareFenceRef.current.accepts(generation, prepareKey)) return;
      bundleContentIdentityRef.current.set(saved, sourceContentIdentity);
      setBundle(saved);
      setMessage(null);
    }).catch((reason) => {
      if (!prepareFenceRef.current.accepts(generation, prepareKey)
          || (reason as { name?: string } | null)?.name === "AbortError") return;
      compileScenarioPreview();
    });
    return () => abort.abort();
  }, [bundle, document, documentId, listPresentationActive, maps]);

  useEffect(() => () => { previewSaveRef.current?.abort(); workerRef.current?.dispose(); }, []);

  useEffect(() => {
    if (!bundle) setSumoStatus(DISABLED_SUMO_STATUS);
  }, [bundle]);

  useEffect(() => {
    if (listPresentationActive || !document || !map) return;
    const requestedProvider = ambientTrafficProviderFromExtensions(document.content.extensions);
    const provider = previewExecutionTrafficProvider(
      requestedProvider,
      document.content.mapSignalPlans.length > 0,
    );
    if (provider !== "sumo") return;
    if (!mapSupportsScenarioPreview(map)) return;
    const abort = new AbortController();
    // Start immutable SUMO downloads and XML indexing alongside scenario
    // compilation. The viewport-owned runtime consumes the completed cache
    // once its renderer and height sampler are ready.
    void loadSumoAssets(
      playbackMapEntry(map),
      ambientTrafficProfileFromExtensions(document.content.extensions),
      fetch,
      [],
      false,
      abort.signal,
    ).catch((reason: unknown) => {
      if ((reason as { name?: string } | null)?.name !== "AbortError") {
        // The owning SUMO surface publishes the actionable failure. Preloading
        // is deliberately silent so it cannot create a duplicate notification.
      }
    });
    return () => abort.abort();
  }, [document, listPresentationActive, map]);

  useEffect(() => {
    if (!maps?.length || (documentId && !bundle)) return;
    const abort = new AbortController();
    const preload = () => {
      void preloadMapManifests(maps, { signal: abort.signal });
    };
    const idleHandle = window.requestIdleCallback?.(preload, { timeout: 5_000 });
    const timeoutHandle = idleHandle === undefined ? window.setTimeout(preload, 4_000) : undefined;
    return () => {
      if (idleHandle !== undefined) window.cancelIdleCallback?.(idleHandle);
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
      abort.abort();
    };
  }, [bundle, documentId, maps]);

  const sampleHeight = useMemo(
    () => viewer && loadedMapVersionId === map?.mapVersionId
      ? indexedWorldHeightSampler(viewer)
      : null,
    [loadedMapVersionId, map?.mapVersionId, viewer],
  );

  // The persistent world owns one overlay set for the immutable map version.
  // Switching list/editor/playback modes retains the same GPU resources.
  const overlays = useMapSignalOverlays({
    viewer,
    map: map && mapSupportsScenarioPreview(map) ? map : null,
    ready: Boolean(
      map && mapSupportsScenarioPreview(map) && loadedMapVersionId === map.mapVersionId
    ),
  });
  const cameraActorIds = useMemo(
    () => bundle?.actors
      .filter((actor) => !["pedestrian", "animal", "static_object"].includes(actor.kind))
      .map((actor) => actor.id)
      .sort(),
    [bundle],
  );
  const runtimePlayback = usePlayback({
    // The integrated workspace has one renderer owner. Waiting for it avoids a
    // transient, privately-owned playback renderer during WorldHost startup.
    viewer: actorRenderer ? viewer : null,
    bundle,
    sampleHeight,
    overlays,
    // Authoring owns the camera. Scenario recompilation happens after every
    // edit, including object placement, so constructing the background
    // playback controller with an auto-framing policy would move the camera
    // even while its playback layer is hidden.
    cameraPolicy: recordingCamera ? "dash-camera" : "free",
    dashCamera: recordingCamera,
    loop: false,
    cameraActorIds,
    renderer: actorRenderer,
    collisionActorOverrides,
    subscribeState: false,
  });
  const presentationActive = listPresentationActive || inspecting || recordingCamera !== null;
  useEffect(() => {
    const controller = runtimePlayback.controller;
    if (!controller) return;
    applyScenarioPresentationVisibility(
      controller,
      actorRenderer,
      presentationActive,
    );
    // The list scene owns its smooth single-actor focus transition. Keep the
    // controller free so it cannot briefly zoom out to the full scenario first.
    // Entering playback from the editor likewise retains the authored view.
    controller.setCameraPolicy(
      recordingCamera ? "dash-camera" : "free",
    );
  }, [actorRenderer, listPresentationActive, presentationActive, recordingCamera, runtimePlayback.controller]);

  const setInspecting = useCallback((next: boolean) => {
    setInspectingState(next);
    if (!next) runtimePlayback.controller?.pause();
  }, [runtimePlayback.controller]);
  const updateDocument = useCallback((nextDocument: UniScenarioDocumentDto) => {
    if (nextDocument.id !== documentId) return;
    const canonical = withCanonicalEditorTimeline(nextDocument);
    if (document && canonical.draftVersion > document.draftVersion) {
      persistedDocumentIdentityRef.current = {
        id: canonical.id,
        draftVersion: canonical.draftVersion,
        contentIdentity: contentHash(canonical.content),
      };
    }
    // Never expose a completed trace from the previous revision alongside new
    // authoring state. The preparation effect replaces it after the worker run.
    setBundle(null);
    setDocument(canonical);
  }, [document, documentId]);

  const evidenceIdentity = useMemo(() => document && map && bundle
    ? contentHash({
        documentId: document.id,
        draftVersion: document.draftVersion,
        mapVersionId: map.mapVersionId,
        sourceMapId: map.sourceMapId,
        inputHash: bundle.instance.manifest.inputHash,
      })
    : null, [bundle, document, map]);

  const failRevisionEvidence = useCallback((requestKey: string, reason: unknown) => {
    const pending = evidencePendingRef.current;
    if (!pending || pending.key !== requestKey) return;
    pending.abort.abort();
    evidencePendingRef.current = null;
    setEvidenceRequest(null);
    setInspectingState(false);
    runtimePlayback.controller?.pause();
    pending.reject(reason instanceof Error ? reason : new Error(String(reason)));
  }, [runtimePlayback.controller]);

  const completeRevisionEvidence = useCallback((requestKey: string, artifact: MaterializedTrafficArtifactEnvelope) => {
    const pending = evidencePendingRef.current;
    if (!pending || pending.key !== requestKey || pending.uploading
        || requestKey !== evidenceIdentity || !document || !map || !bundle) return;
    if (!mapSupportsScenarioPreview(map)) {
      failRevisionEvidence(requestKey, new Error("The active map is missing its immutable browser runtime closure."));
      return;
    }
    pending.uploading = true;
    const runtimeMap = playbackMapEntry(map);
    const profile = ambientTrafficProfileFromExtensions(document.content.extensions);
    const replaceActorIds = new Set(bundle.ambientTraffic?.actors.map((actor) => actor.id) ?? []);
    void uploadAndConsumeUniScenarioMaterializedTraffic(
      document,
      artifact,
      bundle.trace,
      replaceActorIds,
      { signal: pending.abort.signal },
    ).then(({ reference }) => {
      if (evidencePendingRef.current !== pending || requestKey !== evidenceIdentity) return;
      const evidence = {
        ambient: ambientProvenanceForRevisionTraffic(artifact, profile, runtimeMap),
        materializedTraffic: reference,
      } satisfies UniScenarioRevisionEvidence;
      evidenceCacheRef.current = { key: requestKey, evidence };
      evidencePendingRef.current = null;
      setEvidenceRequest(null);
      setInspectingState(false);
      runtimePlayback.controller?.pause();
      pending.resolve(evidence);
    }).catch((reason: unknown) => failRevisionEvidence(requestKey, reason));
  }, [bundle, document, evidenceIdentity, failRevisionEvidence, map, runtimePlayback.controller]);

  const prepareRevisionEvidence = useCallback((requestedDocumentId: string) => {
    if (!document || !map || !mapSupportsScenarioPreview(map) || !bundle
        || !evidenceIdentity || document.id !== requestedDocumentId) {
      return Promise.reject(new Error("Open this saved scenario in the canonical browser session before preparing revision evidence."));
    }
    const cached = evidenceCacheRef.current;
    if (cached?.key === evidenceIdentity) return Promise.resolve(cached.evidence);
    const existing = evidencePendingRef.current;
    if (existing?.key === evidenceIdentity) return existing.promise;
    if (existing) failRevisionEvidence(existing.key, new Error("Revision evidence preparation was superseded."));

    let resolve!: (evidence: UniScenarioRevisionEvidence) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<UniScenarioRevisionEvidence>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    const pending = {
      key: evidenceIdentity,
      promise,
      resolve,
      reject,
      uploading: false,
      abort: new AbortController(),
    };
    evidencePendingRef.current = pending;
    const requestedProvider = ambientTrafficProviderFromExtensions(document.content.extensions);
    const executionProvider = previewExecutionTrafficProvider(
      requestedProvider,
      document.content.mapSignalPlans.length > 0,
    );
    if (executionProvider === "sumo") {
      setEvidenceRequest({ key: evidenceIdentity });
    } else {
      try {
        const artifact = materializeBrowserRevisionTraffic(
          executionProvider,
          ambientTrafficProfileFromExtensions(document.content.extensions),
          playbackMapEntry(map),
          bundle,
        );
        completeRevisionEvidence(evidenceIdentity, artifact);
      } catch (reason) {
        failRevisionEvidence(evidenceIdentity, reason);
      }
    }
    return promise;
  }, [bundle, completeRevisionEvidence, document, evidenceIdentity, failRevisionEvidence, map]);

  useEffect(() => {
    const pending = evidencePendingRef.current;
    if (pending && pending.key !== evidenceIdentity) {
      failRevisionEvidence(pending.key, new Error("Revision evidence preparation was superseded by another scenario state."));
    }
    if (evidenceCacheRef.current?.key !== evidenceIdentity) evidenceCacheRef.current = null;
  }, [evidenceIdentity, failRevisionEvidence]);

  useEffect(() => () => {
    const pending = evidencePendingRef.current;
    if (!pending) return;
    pending.abort.abort();
    pending.reject(new Error("Revision evidence preparation was canceled."));
    evidencePendingRef.current = null;
  }, []);

  return {
    maps,
    map,
    document,
    bundle,
    message,
    failed,
    playback: {
      bundle,
      sourceContentIdentity: bundle
        ? (bundleContentIdentityRef.current.get(bundle) ?? null)
        : null,
      controller: runtimePlayback.controller,
      state: runtimePlayback.state,
      error: runtimePlayback.error,
      preparationMessage: message,
      inspecting,
      setInspecting,
      sumoStatus,
      setSumoStatus,
      collisionActorOverrides,
      overlays,
      recordingCamera,
      setRecordingCamera,
    },
    capture: { viewer, actorRenderer, loadedMapVersionId },
    evidenceRequest,
    prepareRevisionEvidence,
    completeRevisionEvidence,
    failRevisionEvidence,
    updateDocument,
  };
}

function withCanonicalEditorTimeline(document: UniScenarioDocumentDto): UniScenarioDocumentDto {
  const content = normalizeAuthoringGraph(document.content).template;
  return content === document.content ? document : { ...document, content };
}
