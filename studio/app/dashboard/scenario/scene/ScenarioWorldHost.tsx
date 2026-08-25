"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CityViewer } from "@simforge/viewer";
import { ActorRenderer } from "@simforge/viewer";
import { CityView } from "@simforge/viewer/react";
import { cn } from "@/app/lib/utils";
import { readRenderingPreference,
RENDERING_PREFERENCE_CHANGE_EVENT,
type RenderingPreference, } from "@/app/components/rendering-preference"
import { useRegisterRenderingBenchmarkTarget } from "@/app/components/rendering-benchmark-target"
import { AUTHORING_QUALITY } from "../editor/authoring-quality";
import {
  animateMapCamera,
  MAP_ZOOM_IN_MS,
  MAP_ZOOM_OUT_MS,
  pulledBackMapView,
  waitForMapModelsFullyLoaded,
} from "./map-camera-transition";
import {
  failedSceneLoadProgress,
  initialSceneLoadProgress,
  sceneLoadProgressFromSnapshot,
  type SceneLoadProgress,
  type SceneLoadProgressTracker,
} from "./map-load-progress";
import { SceneLoadingTransition } from "./SceneLoadingTransition";
import { authoringRuntimeReady } from "@simforge/editor";

/**
 * GPU upload pacing while the loading overlay is up.
 *
 * The per-preset `uploadBudgetMs` / `uploadPixelsPerFrame` exist to keep the
 * frame rate smooth while tiles stream in mid-session — a real concern once
 * someone is panning around the map. During the initial load they protect the
 * smoothness of a scene nobody can see: `SceneLoadingTransition` is an opaque
 * cover until the transition reaches `idle`.
 *
 * Measured on Belmont at the `minimal` preset (0.5 ms / 256k pixels per frame),
 * a warm reload finished downloading and decoding every tile 4.5 s in, then sat
 * on "1 uploading" for a further 16 s feeding one asset to the GPU. Half a
 * millisecond is less than a single large `texImage2D`, so the budget was spent
 * on roughly one texture per frame regardless of the pixel allowance.
 *
 * These are the ceilings `setLiveQuality` clamps to, deliberately: while the
 * cover is up there is no frame rate worth protecting, and the pacer's own
 * adaptive gate (`dt <= max(14, median * 2)`) still keeps a pathological frame
 * from starving the next one. Restored to the preset's values the moment the
 * cover lifts, which is also the moment smoothness starts to matter.
 */
const BOOT_UPLOAD_BUDGET = { uploadBudgetMs: 20, uploadPixelsPerFrame: 168e5 } as const;

export type ScenarioWorldTarget = {
  mapVersionId: string;
  manifestUrl: string;
  label: string;
  locality?: string | null;
};

export type ScenarioWorldState = {
  target: ScenarioWorldTarget | null;
  loadedMapVersionId: string | null;
  streaming: boolean;
  error: unknown | null;
  /** Camera/loading choreography currently owning the shared viewer. */
  transitionPhase?: MapTransitionPhase;
};

export type MapTransitionPhase =
  | "idle"
  | "zooming-out"
  | "loading"
  | "zooming-in"
  | "error";

/**
 * The one canvas and CityViewer owned by the integrated datasets workspace.
 *
 * Mode surfaces are siblings layered above this host. Changing a manifest calls
 * `CityViewer.loadMap` through `CityView`; changing list/editor/render mode does
 * not change this component's identity and therefore cannot replace its WebGL
 * context. The last target is retained while the next mode resolves its data so
 * a transient `null` never tears down a usable world.
 */
export function ScenarioWorldHost({
  target,
  pendingTarget = false,
  interactive = true,
  onViewerChange,
  onActorRendererChange,
  onStateChange,
  className,
}: {
  target: ScenarioWorldTarget | null;
  /** Keep the first paint covered while the async map catalog resolves. */
  pendingTarget?: boolean;
  /** Whether the user may directly steer the persistent world camera. */
  interactive?: boolean;
  onViewerChange: (viewer: CityViewer | null) => void;
  onActorRendererChange: (renderer: ActorRenderer | null) => void;
  onStateChange: (state: ScenarioWorldState) => void;
  className?: string;
}) {
  const [retainedTarget, setRetainedTarget] = useState(target);
  const [loadedMapVersionId, setLoadedMapVersionId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<unknown | null>(null);
  const [transitionPhase, setTransitionPhase] =
    useState<MapTransitionPhase>(target || pendingTarget ? "loading" : "idle");
  const [loadProgress, setLoadProgress] = useState<SceneLoadProgress>(() =>
    initialSceneLoadProgress(target?.label ?? "scene"),
  );
  const [retryNonce, setRetryNonce] = useState(0);
  const [preference, setPreference] = useState<RenderingPreference>(
    () => readRenderingPreference() ?? "high",
  );
  const quality = AUTHORING_QUALITY[preference];
  const uploadBudget = transitionPhase === "idle" ? null : BOOT_UPLOAD_BUDGET;
  const reactId = useId();
  const instanceIdRef = useRef(`world-${reactId}`);
  const targetRef = useRef(target);
  const retainedTargetRef = useRef(retainedTarget);
  const loadedMapVersionIdRef = useRef(loadedMapVersionId);
  const viewerRef = useRef<CityViewer | null>(null);
  const interactiveRef = useRef(interactive);
  const transitionPhaseRef = useRef<MapTransitionPhase>(
    target || pendingTarget ? "loading" : "idle",
  );
  const progressTrackerRef = useRef<SceneLoadProgressTracker>({
    peakOutstanding: 0,
    percent: 8,
  });
  const appliedPreferenceRef = useRef(preference);
  const transitionGenerationRef = useRef(0);
  const cancelCameraAnimationRef = useRef<(() => void) | null>(null);
  const cancelModelSettleRef = useRef<(() => void) | null>(null);
  const actorRendererRef = useRef<ActorRenderer | null>(null);
  const onViewerChangeRef = useRef(onViewerChange);
  const onActorRendererChangeRef = useRef(onActorRendererChange);
  // A map version is immutable. Preview and editor endpoints may return
  // different URL forms for it, but changing modes must not make CityView
  // reload the same world or invalidate an in-flight completion callback.
  const stableTarget =
    target && retainedTarget?.mapVersionId === target.mapVersionId
      ? retainedTarget
      : target;
  targetRef.current = stableTarget;
  retainedTargetRef.current = retainedTarget;
  loadedMapVersionIdRef.current = loadedMapVersionId;
  interactiveRef.current = interactive;
  onViewerChangeRef.current = onViewerChange;
  onActorRendererChangeRef.current = onActorRendererChange;

  useEffect(() => {
    const updatePreference = (event: Event) => {
      setPreference((event as CustomEvent<RenderingPreference>).detail);
    };
    window.addEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, updatePreference);
    return () =>
      window.removeEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, updatePreference);
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!supportsMapCameraTransition(viewer) || transitionPhaseRef.current !== "idle") return;
    viewer.setCameraPoseConstraintsEnabled(true);
    viewer.controls.setEnabled(interactive);
  }, [interactive]);

  const updateTransitionPhase = (phase: MapTransitionPhase) => {
    transitionPhaseRef.current = phase;
    setTransitionPhase(phase);
  };

  const updateLoadProgress = (progress: SceneLoadProgress) => {
    setLoadProgress((current) => {
      if (progress.phase === "error" || progress.percent == null) return progress;
      if (progress.percentExact) return progress;
      const percent = Math.max(current.percent ?? 0, progress.percent);
      return { ...progress, percent };
    });
  };

  const finishCameraTransition = (viewer: CityViewer | null) => {
    cancelCameraAnimationRef.current?.();
    cancelCameraAnimationRef.current = null;
    cancelModelSettleRef.current?.();
    cancelModelSettleRef.current = null;
    if (supportsMapCameraTransition(viewer)) {
      viewer.setCameraPoseConstraintsEnabled(true);
      viewer.controls.setEnabled(interactiveRef.current);
    }
    updateTransitionPhase("idle");
  };

  // Hand the GPU uploader its boot budget while the cover is up and the
  // preset's own pacing back the moment it lifts. See BOOT_UPLOAD_BUDGET.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.setLiveQuality({ ...quality.live, ...(uploadBudget ?? {}) });
  }, [quality, uploadBudget]);

  useEffect(() => {
    if (stableTarget || retainedTargetRef.current) return;
    if (pendingTarget) {
      if (transitionPhaseRef.current === "idle") {
        setLoadProgress({
          phase: "resolving",
          percent: 5,
          message: "Preparing map workspace",
          detail: "Resolving the map and its local assets…",
        });
        updateTransitionPhase("loading");
      }
      return;
    }
    if (transitionPhaseRef.current === "loading") {
      finishCameraTransition(viewerRef.current);
    }
    // This bridges async target resolution into the imperative world state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTarget, stableTarget]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const changed = appliedPreferenceRef.current !== preference;
    appliedPreferenceRef.current = preference;
    viewer.setLiveQuality(quality.live);
    viewer.setAuthoringFidelity({
      ultraLow: quality.ultraLow,
      roadsOnly: quality.roadsOnly,
      cinematicLighting: quality.cinematicLighting,
    });
    viewer.setLayerVisible("vegetation", quality.vegetation);
    // A preset switch turns the real shadow map on or off, so the painted
    // stand-in blobs have to change with it.
    if (supportsRealtimeShadowQuery(viewer) && actorRendererRef.current) {
      actorRendererRef.current.setContactShadows(!viewer.castsRealtimeShadows());
    }
    const current = targetRef.current ?? retainedTargetRef.current;
    if (
      !changed ||
      !current ||
      loadedMapVersionIdRef.current !== current.mapVersionId ||
      transitionPhaseRef.current !== "idle" ||
      !supportsMapModelReadiness(viewer)
    ) {
      return;
    }

    const generation = ++transitionGenerationRef.current;
    setLoadedMapVersionId(null);
    setError(null);
    progressTrackerRef.current = { peakOutstanding: 0, percent: 55 };
    setLoadProgress({
      phase: "assets",
      percent: 55,
      message: `Applying ${renderingPreferenceLabel(preference)}`,
      detail: `Preparing ${current.label} for the selected rendering profile…`,
    });
    updateTransitionPhase("loading");
    viewer.controls.setEnabled(false);
    cancelModelSettleRef.current?.();
    cancelModelSettleRef.current = waitForMapModelsFullyLoaded(
      () => {
        const stats = viewer.getStats();
        return {
          roadReady: viewer.roadReady,
          roadVisible: stats.roadVisible,
          sceneAssetsReady:
            (quality.roadsOnly || stats.residentTiles > 0) &&
            authoringRuntimeReady(current.mapVersionId),
          loading: stats.loading,
          queued: stats.queued,
          uploading: stats.uploading,
          downloads: stats.downloads,
          streamingError: stats.streamingError,
        };
      },
      () => {
        if (
          generation !== transitionGenerationRef.current ||
          targetRef.current?.mapVersionId !== current.mapVersionId
        ) {
          return;
        }
        waitForPaintFrames(() => {
          if (generation !== transitionGenerationRef.current) return;
          setLoadedMapVersionId(current.mapVersionId);
          updateLoadProgress({
            phase: "ready",
            percent: 100,
            message: `${current.label} is ready`,
            detail: "The new rendering profile is fully prepared.",
          });
          finishCameraTransition(viewer);
        });
      },
      (reason) => {
        if (generation !== transitionGenerationRef.current) return;
        setError(reason);
        updateLoadProgress(failedSceneLoadProgress(current.label, reason));
        updateTransitionPhase("error");
      },
      {
        onSnapshot: (snapshot) => {
          if (generation !== transitionGenerationRef.current) return;
          const next = sceneLoadProgressFromSnapshot(
            current.label,
            snapshot,
            progressTrackerRef.current,
          );
          progressTrackerRef.current = next.tracker;
          updateLoadProgress(next.progress);
        },
      },
    );
    // This effect owns the imperative renderer response to a saved profile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preference, quality]);

  useEffect(() => {
    if (!stableTarget) return;
    const retained = retainedTargetRef.current;
    if (retained?.mapVersionId === stableTarget.mapVersionId) {
      return;
    }

    const generation = ++transitionGenerationRef.current;
    setError(null);
    setLoadedMapVersionId(null);
    progressTrackerRef.current = { peakOutstanding: 0, percent: 8 };
    setLoadProgress({
      phase: "covering",
      percent: 5,
      message: `Switching to ${stableTarget.label}`,
      detail: "Keeping the current scene covered while the next map is prepared…",
    });
    cancelCameraAnimationRef.current?.();
    cancelModelSettleRef.current?.();
    cancelModelSettleRef.current = null;

    const showTarget = () => {
      if (generation !== transitionGenerationRef.current) return;
      retainedTargetRef.current = stableTarget;
      setRetainedTarget(stableTarget);
      setLoadProgress(initialSceneLoadProgress(stableTarget.label));
      updateTransitionPhase("loading");
    };
    const viewer = viewerRef.current;
    const canAnimate = Boolean(
      supportsMapCameraTransition(viewer) &&
        retained &&
        loadedMapVersionIdRef.current === retained.mapVersionId &&
        !prefersReducedMotion(),
    );
    if (!supportsMapCameraTransition(viewer) || !canAnimate) {
      showTarget();
      return;
    }

    viewer.controls.setEnabled(false);
    viewer.setCameraPoseConstraintsEnabled(false);
    updateTransitionPhase("zooming-out");
    const currentView = viewer.controls.getView();
    cancelCameraAnimationRef.current = animateMapCamera(
      (view) => viewer.controls.applyView(view),
      currentView,
      pulledBackMapView(currentView),
      MAP_ZOOM_OUT_MS,
      showTarget,
    );
  }, [stableTarget]);

  useEffect(
    () => () => {
      actorRendererRef.current?.dispose();
      cancelCameraAnimationRef.current?.();
      cancelModelSettleRef.current?.();
      actorRendererRef.current = null;
      onActorRendererChangeRef.current(null);
      onViewerChangeRef.current(null);
    },
    [],
  );

  const effectiveTarget = stableTarget ?? retainedTarget;
  const benchmarkTarget = useMemo(
    () =>
    effectiveTarget
      ? { manifestUrl: effectiveTarget.manifestUrl, label: effectiveTarget.label }
      : null,
    [effectiveTarget],
  );
  useRegisterRenderingBenchmarkTarget(benchmarkTarget);
  const streaming = Boolean(
    effectiveTarget && loadedMapVersionId !== effectiveTarget.mapVersionId,
  );
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => {
    onStateChangeRef.current({
      target: effectiveTarget,
      loadedMapVersionId,
      streaming,
      error,
      transitionPhase,
    });
  }, [effectiveTarget, error, loadedMapVersionId, streaming, transitionPhase]);

  return (
    <div
      className={cn("relative overflow-hidden bg-background", className)}
      data-testid="scenario-world-host"
      data-world-instance-id={instanceIdRef.current}
      data-world-map-version-id={effectiveTarget?.mapVersionId ?? ""}
      data-world-manifest-url={effectiveTarget?.manifestUrl ?? ""}
      data-world-loaded-map-version-id={loadedMapVersionId ?? ""}
      data-world-transition={transitionPhase}
      data-world-interactive={String(interactive)}
    >
      {retainedTarget ? (
        <CityView
          key={`world-viewer:${retryNonce}`}
          manifestUrl={retainedTarget.manifestUrl}
          options={{
            maxPixelRatio: quality.maxPixelRatio,
            antialias: quality.antialias,
            ultraLowFidelity: quality.ultraLow,
            roadsOnlyFidelity: quality.roadsOnly,
            cinematicLighting: quality.cinematicLighting,
            vegetationMaxDistance: quality.live.vegetationMaxDistance,
            byteBudget: quality.live.byteBudget,
          }}
          onReady={(viewer) => {
            viewerRef.current = viewer;
            updateLoadProgress({
              phase: "resolving",
              percent: 20,
              message: `Preparing ${retainedTarget.label}`,
              detail: "Starting the renderer and loading map metadata…",
            });
            viewer.setLiveQuality({ ...quality.live, ...BOOT_UPLOAD_BUDGET });
            viewer.setAuthoringFidelity({
              ultraLow: quality.ultraLow,
              roadsOnly: quality.roadsOnly,
              cinematicLighting: quality.cinematicLighting,
            });
            viewer.setLayerVisible("vegetation", quality.vegetation);
            if (supportsMapCameraTransition(viewer)) {
              viewer.controls.setEnabled(
                transitionPhaseRef.current === "idle" && interactiveRef.current,
              );
            }
            actorRendererRef.current?.dispose();
            const actorRenderer = new ActorRenderer();
            actorRenderer.group.name = "scenario-world-actors";
            viewer.scene.add(actorRenderer.group);
            actorRendererRef.current = actorRenderer;
            onViewerChange(viewer);
            onActorRendererChange(actorRenderer);
          }}
          onMapLoaded={(manifestUrl) => {
            const current = targetRef.current ?? retainedTarget;
            if (manifestUrl !== current.manifestUrl) return;
            const viewer = viewerRef.current;
            // The renderer casts a real sun shadow once a map is loaded, so the
            // painted blobs under each actor would be a second, wrongly-angled
            // shadow. Actors still cast into the real map either way.
            if (supportsRealtimeShadowQuery(viewer) && actorRendererRef.current) {
              actorRendererRef.current.setContactShadows(!viewer.castsRealtimeShadows());
            }
            setError(null);
            updateLoadProgress({
              phase: "assets",
              percent: 55,
              message: `Loading ${current.label} assets`,
              detail: "Loading roads, buildings, and map objects…",
            });
            const destinationView =
              supportsMapCameraTransition(viewer) && !prefersReducedMotion()
                ? viewer.controls.getView()
                : null;
            const pulledBackDestination = destinationView
              ? pulledBackMapView(destinationView)
              : null;
            const publishReady = () => {
              const latest = targetRef.current ?? retainedTargetRef.current;
              if (
                !latest ||
                latest.mapVersionId !== current.mapVersionId ||
                latest.manifestUrl !== manifestUrl
              ) {
                return;
              }
              cancelModelSettleRef.current = null;
              setLoadedMapVersionId(current.mapVersionId);
              setError(null);
              updateLoadProgress({
                phase: "ready",
                percent: 100,
                message: `${current.label} is ready`,
                detail: "Scene assets are loaded and ready to use.",
              });
              finishCameraTransition(viewer);
            };
            const completeMapLoad = () => {
              const latest = targetRef.current ?? retainedTargetRef.current;
              if (
                !latest ||
                latest.mapVersionId !== current.mapVersionId ||
                latest.manifestUrl !== manifestUrl
              ) {
                return;
              }
              cancelModelSettleRef.current = null;
              if (
                supportsMapCameraTransition(viewer) &&
                destinationView &&
                pulledBackDestination &&
                transitionPhaseRef.current === "loading" &&
                !prefersReducedMotion()
              ) {
                viewer.setCameraPoseConstraintsEnabled(false);
                viewer.controls.setEnabled(false);
                updateTransitionPhase("zooming-in");
                cancelCameraAnimationRef.current = animateMapCamera(
                  (view) => viewer.controls.applyView(view),
                  pulledBackDestination,
                  destinationView,
                  MAP_ZOOM_IN_MS,
                  () => waitForPaintFrames(publishReady),
                );
              } else {
                waitForPaintFrames(publishReady);
              }
            };

            if (supportsMapModelReadiness(viewer)) {
              if (pulledBackDestination) {
                viewer.setCameraPoseConstraintsEnabled(false);
                viewer.controls.setEnabled(false);
                viewer.controls.applyView(pulledBackDestination);
              }
              updateTransitionPhase("loading");
              cancelModelSettleRef.current?.();
              cancelModelSettleRef.current = waitForMapModelsFullyLoaded(
                () => {
                  const stats = viewer.getStats();
                  return {
                    roadReady: viewer.roadReady,
                    roadVisible: stats.roadVisible,
                    sceneAssetsReady:
            (quality.roadsOnly || stats.residentTiles > 0) &&
            authoringRuntimeReady(current.mapVersionId),
                    loading: stats.loading,
                    queued: stats.queued,
                    uploading: stats.uploading,
                    downloads: stats.downloads,
                    streamingError: stats.streamingError,
                  };
                },
                completeMapLoad,
                (reason) => {
                  const latest = targetRef.current ?? retainedTargetRef.current;
                  if (latest?.mapVersionId !== current.mapVersionId) return;
                  setError(reason);
                  updateLoadProgress(failedSceneLoadProgress(current.label, reason));
                  updateTransitionPhase("error");
                  if (supportsMapCameraTransition(viewer)) {
                    viewer.controls.setEnabled(false);
                  }
                },
                {
                  onSnapshot: (snapshot) => {
                    const next = sceneLoadProgressFromSnapshot(
                      current.label,
                      snapshot,
                      progressTrackerRef.current,
                    );
                    progressTrackerRef.current = next.tracker;
                    updateLoadProgress(next.progress);
                  },
                },
              );
            } else {
              completeMapLoad();
            }
          }}
          onError={(reason, manifestUrl) => {
            const current = targetRef.current ?? retainedTarget;
            if (current.manifestUrl !== manifestUrl) return;
            setError(reason);
            updateLoadProgress(failedSceneLoadProgress(current.label, reason));
            updateTransitionPhase("error");
            if (supportsMapCameraTransition(viewerRef.current)) {
              viewerRef.current.controls.setEnabled(false);
            }
          }}
          className={cn(
            "h-full w-full transition-[opacity,filter] duration-500 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none",
            !interactive && "pointer-events-none",
            transitionPhase === "loading" || transitionPhase === "error"
              ? "opacity-0"
              : transitionPhase === "zooming-out"
                ? "opacity-80 saturate-75"
                : "opacity-100 saturate-100 blur-0",
          )}
          ariaLabel={`${effectiveTarget?.label ?? retainedTarget.label} 3D world`}
          role={interactive ? "application" : "img"}
          tabIndex={interactive ? 0 : -1}
        />
      ) : null}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_42%,rgba(0,0,0,0.48)_100%)] transition-opacity duration-500 motion-reduce:hidden",
          transitionPhase === "idle" ? "opacity-0" : "opacity-100",
        )}
      />
      <SceneLoadingTransition
        visible={transitionPhase !== "idle"}
        progress={loadProgress}
        onRetry={transitionPhase === "error" ? () => {
          const current = targetRef.current ?? retainedTargetRef.current;
          if (!current) return;
          transitionGenerationRef.current += 1;
          setError(null);
          setLoadedMapVersionId(null);
          progressTrackerRef.current = { peakOutstanding: 0, percent: 8 };
          setLoadProgress(initialSceneLoadProgress(current.label));
          updateTransitionPhase("loading");
          setRetryNonce((value) => value + 1);
        } : null}
      />
    </div>
  );
}

function waitForPaintFrames(onComplete: () => void): void {
  if (typeof requestAnimationFrame !== "function") {
    onComplete();
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(onComplete));
}

function renderingPreferenceLabel(preference: RenderingPreference): string {
  switch (preference) {
    case "roads-only": return "Roads Only";
    case "ultra-low-3d": return "Low";
    case "minimal": return "Balanced";
    case "high": return "High";
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function supportsMapCameraTransition(
  viewer: CityViewer | null,
): viewer is CityViewer {
  if (!viewer) return false;
  const candidate = viewer as CityViewer & {
    controls?: Partial<CityViewer["controls"]>;
    setCameraPoseConstraintsEnabled?: unknown;
  };
  return Boolean(
    candidate.controls &&
      typeof candidate.controls.getView === "function" &&
      typeof candidate.controls.applyView === "function" &&
      typeof candidate.controls.setEnabled === "function" &&
      typeof candidate.setCameraPoseConstraintsEnabled === "function",
  );
}

function supportsRealtimeShadowQuery(
  viewer: CityViewer | null,
): viewer is CityViewer {
  if (!viewer) return false;
  const candidate = viewer as CityViewer & { castsRealtimeShadows?: unknown };
  return typeof candidate.castsRealtimeShadows === "function";
}

function supportsMapModelReadiness(
  viewer: CityViewer | null,
): viewer is CityViewer {
  return Boolean(
    supportsMapCameraTransition(viewer) &&
      typeof (viewer as CityViewer & { getStats?: unknown }).getStats === "function",
  );
}
