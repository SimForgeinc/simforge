"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Raycaster, Vector2, Vector3 } from "three";
import type { CityViewer } from "@simforge/viewer";
import type { ActorRenderer } from "@simforge/viewer";
import type {
  EditorDocument,
  EditorState,
  UniScenarioMapEntry,
} from "@simforge/editor";
import type { UniScenarioDocumentRecord } from "@/app/lib/uniscenario/editor/api";
import type {
  UniScenarioAuthoringQuality,
} from "@/app/lib/uniscenario/contracts";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import {
  indexedEditorHeightSampler,
  useEditorRuntime,
} from "@/app/lib/uniscenario/editor/use-editor-runtime";
import {
  PARKED_CARS_EXTENSION_KEY,
  parkedCarsFromExtensions,
  type ParkedCarsSettings,
} from "@/app/lib/uniscenario/parking/extension";
import {
  useParkedCarLayer,
  useParkedCars,
} from "@/app/lib/uniscenario/parking/useParkedCars";
import { useStallOverlay } from "@/app/lib/uniscenario/parking/useStallOverlay";
import { cn } from "@/app/lib/utils";
import {
  loadCarlaCompatibility,
  type CarlaCompatibilityTable,
} from "@/app/lib/uniscenario/carla-compatibility";
import {
  actorFrameDistance,
  flyCameraTo,
  followActorCamera,
  resolveActorFrameTarget,
  shouldReleaseFollowedActor,
  type FrameableActor,
} from "./camera-framing";
import { AUTHORING_QUALITY } from "./authoring-quality";
import { EditorOverlayHost } from "./inspector/EditorOverlayHost";
import { EditorConfigurationBlockProvider } from "./inspector/EditorDetailsPanel";
import { TrafficLightDetailsPanel } from "./inspector/TrafficLightDetailsPanel";
import {
  EditorOverlayProvider,
  useEditorOverlay,
} from "./inspector/editor-overlay-selection";
import { ActorLibraryRail } from "./regions/ActorLibraryRail";
import type { ViewportTool } from "./regions/actor-catalog";
import { AmbientEditor } from "./authoring/AmbientEditor";
import { EditorCanvasRegion } from "./regions/EditorCanvasRegion";
import {
  waitForMapModelsFullyLoaded,
} from "../scene/map-camera-transition";
import {
  failedSceneLoadProgress,
  initialSceneLoadProgress,
  sceneLoadProgressFromSnapshot,
  type SceneLoadProgressTracker,
} from "../scene/map-load-progress";
import { SceneLoadingTransition } from "../scene/SceneLoadingTransition";
import { EditorHeader } from "./regions/EditorHeader";
import { EditorModeBanner } from "./regions/EditorModeBanner";
import { PlacementCursorHint } from "./regions/PlacementCursorHint";
import {
  AssistantChatSlot,
  NotificationDockSlot,
  TutorialOverlaySlot,
} from "./regions/slots";
import { UniScenarioEditorShell } from "./shell";
import { UniScenarioTimelineDock } from "./UniScenarioTimelineDock";
import {
  timelineActorLabels,
  type V1TimelineBrowserPlayback,
  type V1TimelineSignalAuthoring,
  type V1TimelineSignalLane,
} from "./timeline/V1TimelineRail";
import { useSignalProjection } from "./signals/use-signal-projection";
import { selectedHeadHighlight } from "./signals/orb-layer";
import {
  buildDefaultMapSignalPlanForHead,
  buildMapSignalPlan,
  buildReferenceSignalTimelineRow,
  checkPlanBinding,
  clampReferenceTiming,
  compileReferenceCycle,
  crossingStageCount,
  decompilePlanToCycle,
  editorSignalStatesAt,
  layOutCycle,
  planForJunction,
  readReferenceTiming,
  selectSignalHead,
  type EditorSignalIndex,
} from "@/app/lib/uniscenario/signals";
import type { UniScenarioSharedPlayback } from "../scene/useUniScenarioSession";
import { usePlaybackControllerState } from "@/app/lib/uniscenario/playback/usePlayback";
import { useMapSignalOverlays } from "@/app/lib/uniscenario/useMapSignalOverlays";
import { useUniScenarioNotification } from "./status";
import { configureCustomRouteAtClipStart } from "./custom-route-configuration";
import { EditorSceneEnvironmentBridge } from "./EditorSceneEnvironmentBridge";
import {
  collectSimulationIssues,
  type SimulationIssue,
} from "./simulation-issues";
import { buildEditorDebugInformation } from "./debug-information";
import { EditorExperienceChooser } from "./EditorExperienceChooser";
import {
  convertDocumentToSimpleTimedRoutes,
  hasAdvancedMotion,
  isCustomTimedRoute,
  needsSimpleRouteConversion,
  readEditorExperience,
  writeEditorExperience,
  type EditorExperience,
} from "./simple-timed-routes";
import { isUnconfiguredSimpleTimedRoute } from "./simple-route-status";
import {
  shouldFinishActorPlacement,
  type PlacementSnapshot,
} from "./simple-placement-completion";
import { hideStalePlacementGhost } from "./placement-ghost";
import { SimpleRouteTutorialPanel } from "./tutorial/SimpleRouteTutorialPanel";
import {
  markSimpleRouteTutorialSeen,
  shouldShowSimpleRouteTutorial,
  simpleRouteTutorialStorage,
} from "./tutorial/simple-route-tutorial";
import {
  routePointWarningMessage,
  routePointMayBeTooFast,
  shouldShowRoutePointWarning,
} from "./route-authoring-warnings";

export function stopAndResetTimelinePlayback(input: {
  controller: { pause: () => void; seek: (time: number) => void } | null;
  startTime: number;
  setInspecting: (inspecting: boolean) => void;
}) {
  input.controller?.pause();
  input.controller?.seek(input.startTime);
  input.setInspecting(false);
}

/**
 * V1's compact editor chrome around the existing V2 runtime.
 *
 * The shell is presentation-only. `useEditorRuntime` remains the sole document,
 * controller and input authority, and `EditorCanvasRegion` remains mounted while
 * the timeline resizes or the editor/list view transitions run.
 */
export function UniScenarioEditorSurface({
  map,
  record,
  datasetId = null,
  onChanged,
  quality,
  onQualityChange,
  onExitToList,
  injectedViewer,
  loadedMapVersionId,
  sharedPlayback,
  sharedActorRenderer,
  active = true,
}: {
  map: UniScenarioMapEntry;
  record: UniScenarioDocumentRecord | null;
  datasetId?: string | null;
  onChanged: (document: EditorDocument) => void;
  quality: UniScenarioAuthoringQuality;
  /** Data-layer hook retained for quality updates initiated outside editor chrome. */
  onQualityChange: (quality: UniScenarioAuthoringQuality) => void;
  onExitToList?: () => void;
  injectedViewer?: CityViewer | null;
  loadedMapVersionId?: string | null;
  sharedPlayback?: UniScenarioSharedPlayback;
  sharedActorRenderer?: ActorRenderer | null;
  /** Presentation changes never unmount the editor runtime. */
  active?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [localViewer, setLocalViewer] = useState<CityViewer | null>(null);
  const [localMapLoadedUrl, setLocalMapLoadedUrl] = useState<string | null>(null);
  const [localMapLoadError, setLocalMapLoadError] = useState<unknown | null>(null);
  const [localLoadProgress, setLocalLoadProgress] = useState(() =>
    initialSceneLoadProgress(map.label),
  );
  const localProgressTrackerRef = useRef<SceneLoadProgressTracker>({
    peakOutstanding: 0,
    percent: 8,
  });
  const cancelLocalModelSettleRef = useRef<(() => void) | null>(null);
  const [expandedTool, setExpandedTool] = useState<ViewportTool | null>(null);
  const placementSnapshotRef = useRef<PlacementSnapshot | null>(null);
  const routePointCountRef = useRef<number | null>(null);
  const cancelCameraFlightRef = useRef<(() => void) | null>(null);
  /** The actor the camera is currently following, if the camera work is a follow at all. */
  const followedActorRef = useRef<string | null>(null);
  const routeLastPointRef = useRef<{ x: number; z: number } | null>(null);
  const routePointerQueueRef = useRef<Array<{
    screen: { x: number; y: number };
    world: { x: number; z: number };
  }>>([]);
  const [routeSpeedWarnings, setRouteSpeedWarnings] = useState<Array<{
    readonly id: string;
    readonly point: { readonly x: number; readonly z: number };
    readonly message: string;
  }>>([]);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [experience, setExperience] = useState<EditorExperience | null>(null);
  const [experienceReady, setExperienceReady] = useState(false);
  const [carlaCompatibilityTable, setCarlaCompatibilityTable] =
    useState<CarlaCompatibilityTable | null>(null);

  useEffect(() => {
    let active = true;
    void loadCarlaCompatibility()
      .then((table) => {
        if (active) setCarlaCompatibilityTable(table);
      })
      .catch(() => {
        // Compatibility metadata is advisory and must never break the editor.
      });
    return () => {
      active = false;
    };
  }, []);


  useEffect(() => {
    setExperience(readEditorExperience(window.localStorage));
    setExperienceReady(true);
  }, []);

  const externalWorld = injectedViewer !== undefined;
  const viewer = externalWorld ? injectedViewer : localViewer;
  const worldReady = !externalWorld || loadedMapVersionId === map.versionId;
  const environmentSceneReady = externalWorld
    ? worldReady
    : localMapLoadedUrl === map.manifestUrl;
  const localSignalOverlays = useMapSignalOverlays({
    viewer,
    map,
    ready: worldReady,
    enabled: sharedPlayback === undefined,
  });
  const signalOverlays = sharedPlayback?.overlays ?? localSignalOverlays;
  const signalProjection = useSignalProjection(map.versionId);
  const [selectedSignalHeadId, setSelectedSignalHeadId] = useState<string | null>(null);

  /** Stop whatever is driving the camera, and stop calling it a follow. */
  const releaseCamera = useCallback(() => {
    cancelCameraFlightRef.current?.();
    cancelCameraFlightRef.current = null;
    followedActorRef.current = null;
  }, []);

  /** One flight at a time: a later frame request cancels the one in the air. */
  const startCameraFlight = useCallback((
    target: Vector3,
    distance: number,
  ) => {
    if (!viewer) return;
    releaseCamera();
    cancelCameraFlightRef.current = flyCameraTo(viewer, target, distance);
  }, [releaseCamera, viewer]);

  /**
   * Track a moving actor. Shares `cancelCameraFlightRef` with the one-shot
   * flights so picking a second actor, framing a signal, or leaving the surface
   * all stop the previous camera work — there is only ever one thing driving the
   * camera.
   */
  const startCameraFollow = useCallback((
    actorId: string,
    resolveTarget: () => FrameableActor | null,
  ) => {
    if (!viewer) return;
    releaseCamera();
    cancelCameraFlightRef.current = followActorCamera(viewer, resolveTarget);
    followedActorRef.current = actorId;
  }, [releaseCamera, viewer]);

  const frameSignalHead = useCallback((headId: string) => {
    const center = signalOverlays?.signalPosition(headId);
    if (!center) return;
    startCameraFlight(new Vector3(...center), 14);
  }, [signalOverlays, startCameraFlight]);

  useEffect(() => () => cancelCameraFlightRef.current?.(), []);

  const onViewerReady = useCallback((next: CityViewer) => {
    setLocalViewer(next);
    setLocalMapLoadedUrl(null);
    setLocalMapLoadError(null);
    setLocalLoadProgress(initialSceneLoadProgress(map.label));
  }, [map.label]);
  const onMapLoaded = useCallback((manifestUrl: string) => {
    const activeViewer = localViewer;
    if (!activeViewer || typeof activeViewer.getStats !== "function") {
      setLocalMapLoadedUrl(manifestUrl);
      return;
    }
    localProgressTrackerRef.current = { peakOutstanding: 0, percent: 55 };
    cancelLocalModelSettleRef.current?.();
    cancelLocalModelSettleRef.current = waitForMapModelsFullyLoaded(
      () => {
        const stats = activeViewer.getStats();
        return {
          roadReady: activeViewer.roadReady,
          roadVisible: stats.roadVisible,
          sceneAssetsReady: stats.roadsOnlyFidelity || stats.residentTiles > 0,
          loading: stats.loading,
          queued: stats.queued,
          uploading: stats.uploading,
          downloads: stats.downloads,
          streamingError: stats.streamingError,
        };
      },
      () => {
        cancelLocalModelSettleRef.current = null;
        setLocalMapLoadedUrl(manifestUrl);
        setLocalMapLoadError(null);
        setLocalLoadProgress({
          phase: "ready",
          percent: 100,
          message: `${map.label} is ready`,
          detail: "Scene assets are loaded and ready to use.",
        });
      },
      (reason) => {
        cancelLocalModelSettleRef.current = null;
        setLocalMapLoadError(reason);
        setLocalLoadProgress(failedSceneLoadProgress(map.label, reason));
      },
      {
        onSnapshot: (snapshot) => {
          const next = sceneLoadProgressFromSnapshot(
            map.label,
            snapshot,
            localProgressTrackerRef.current,
          );
          localProgressTrackerRef.current = next.tracker;
          setLocalLoadProgress(next.progress);
        },
      },
    );
  }, [localViewer, map.label]);

  useEffect(() => () => cancelLocalModelSettleRef.current?.(), []);

  useEffect(() => {
    // The integrated datasets workspace owns one persistent viewer. Its world
    // host also owns renderer fidelity, so changing UI modes must not rewrite
    // quality, vegetation, or suspension state on that shared instance.
    if (!viewer || externalWorld) return;
    const preset = AUTHORING_QUALITY[quality];
    viewer.setLiveQuality(preset.live);
    viewer.setRenderingSuspended(false);
    viewer.setAuthoringFidelity({
      ultraLow: preset.ultraLow,
      roadsOnly: preset.roadsOnly,
      cinematicLighting: preset.cinematicLighting,
    });
    viewer.setLayerVisible("vegetation", preset.vegetation);
  }, [externalWorld, quality, viewer]);

  const { controller, editorDocument, state, error } = useEditorRuntime({
    record,
    map,
    viewer,
    // An integrated editor must never fall back to a second actor renderer
    // while the persistent WorldHost is still publishing its renderer.
    // `null` is the integrated WorldHost's explicit "renderer not published yet"
    // state. `undefined` keeps standalone/injected editor callers on their
    // locally-owned renderer path.
    runtimeReady: worldReady && sharedActorRenderer !== null,
    hostRef,
    hostElement: externalWorld
      ? (viewer?.renderer.domElement.parentElement ?? null)
      : null,
    actorRenderer: sharedActorRenderer,
    simulationPreview: sharedPlayback?.bundle ?? null,
    onDocumentChange: onChanged,
  });
  const tutorialPlaybackState = usePlaybackControllerState(sharedPlayback?.controller ?? null);
  const selected =
    state?.actors.find((actor) => state.selection.includes(actor.id)) ?? null;
  const sceneReady = Boolean(worldReady && state && editorDocument);

  const heightSampler = useMemo(
    () => (viewer ? indexedEditorHeightSampler(viewer) : () => null),
    [viewer],
  );

  /**
   * Memoised on the extension bag, not recomputed per render.
   *
   * `parkedCarsFromExtensions` allocates a fresh `baked` array every call, and
   * that array's identity is what drives the renderer sync and the stall
   * overlay. Recomputing it each render rebuilt 120 instance matrices and a few
   * thousand overlay line segments on every mouse move — parked cars never
   * move, so none of that should ever run twice.
   */
  const parkedCarsSettings = useMemo(
    () => parkedCarsFromExtensions(editorDocument?.data.extensions),
    [editorDocument?.data.extensions],
  );
  const parkedCarsOnChange = useCallback(
    (next: ParkedCarsSettings) =>
      editorDocument?.setAmbientTrafficExtension(PARKED_CARS_EXTENSION_KEY, next),
    [editorDocument],
  );
  /**
   * An author who parked their own car in a stall must not get a generated one
   * inside it. Half the actor's diagonal is the radius at which a stall centre
   * is genuinely covered rather than merely nearby.
   */
  const parkedCarExclusions = useMemo(
    () =>
      (state?.actors ?? []).map((actor) => ({
        x: actor.x,
        z: actor.z,
        radiusM: Math.max(1.5, Math.hypot(actor.dims.l, actor.dims.w) / 2),
      })),
    [state?.actors],
  );
  const parkedCars = useParkedCars({
    mapAssetId: map.sourceMapId,
    settings: parkedCarsSettings,
    exclusions: parkedCarExclusions,
  });
  useParkedCarLayer(
    viewer,
    sharedActorRenderer,
    parkedCars.cars,
    heightSampler,
    // Baked cars belong to the document, so they stay drawn even if the
    // generator is switched off afterwards.
    parkedCarsSettings.enabled || parkedCars.isBaked,
  );
  // The stalls themselves, so an empty bay is legible as a choice rather than a
  // bug. Only while the generator is open: once baked, the cars are the answer.
  useStallOverlay(
    viewer,
    parkedCars.stalls,
    parkedCars.cars,
    heightSampler,
    parkedCarsSettings.enabled,
  );
  /**
   * Frame the pose the author is actually looking at. While playback presents
   * the scene that is the trace sample at the playhead, not the authored spawn
   * placement `EditorController.frameActor` resolves from the document.
   *
   * A car that is moving gets followed rather than framed once. Flying to its
   * position at the instant of the click left it driving out of shot before the
   * flight even settled, which read as the camera going to the wrong place. The
   * follow keeps the author's orbit: it moves what the camera looks at, never how
   * far away or from what angle it looks.
   */
  const frameActorAtPlayhead = useCallback((actorId: string) => {
    const resolve = () => resolveActorFrameTarget({
      actorId,
      inspecting: Boolean(sharedPlayback?.inspecting),
      sampledActors: sharedPlayback?.controller?.currentActors,
      authored: editorDocument?.actor(actorId) ?? null,
      sampleHeight: heightSampler,
    });
    const target = resolve();
    if (!target) return;
    // `currentActors` is a live getter on the controller, so re-resolving each
    // frame reports where the car is now. Only worth following while playback
    // owns the scene; a parked authored pose has nothing to track.
    if (sharedPlayback?.inspecting && sharedPlayback.controller) {
      startCameraFollow(actorId, resolve);
      return;
    }
    startCameraFlight(
      new Vector3(target.x, target.y + target.dims.h * 0.5, target.z),
      actorFrameDistance(target.dims),
    );
  }, [
    editorDocument,
    heightSampler,
    sharedPlayback?.controller,
    sharedPlayback?.inspecting,
    startCameraFlight,
    startCameraFollow,
  ]);
  // Hand the camera back when the follow ends: the actor stops being selected, or playback stops
  // owning the scene. See `shouldReleaseFollowedActor` for why both are needed.
  useEffect(() => {
    if (!shouldReleaseFollowedActor({
      followedActorId: followedActorRef.current,
      selection: state?.selection,
      presenting: Boolean(sharedPlayback?.inspecting),
    })) return;
    releaseCamera();
  }, [releaseCamera, sharedPlayback?.inspecting, state?.selection]);

  useEffect(() => {
    const canvas = viewer?.renderer.domElement;
    if (!canvas || state?.mode !== "drawingRoute" || state.customRouteTool !== "add") return;
    const rememberRouteClick = (event: PointerEvent) => {
      if (event.button !== 0 || event.target !== canvas) return;
      const world = routeGroundPoint(viewer, event.clientX, event.clientY);
      if (!world) return;
      const previous = routePointerQueueRef.current.at(-1)?.world ?? routeLastPointRef.current;
      if (previous && Math.hypot(previous.x - world.x, previous.z - world.z) < 0.1) return;
      routePointerQueueRef.current.push({
        screen: { x: event.clientX, y: event.clientY },
        world,
      });
    };
    // The route controller commits on pointerdown. Window capture runs first,
    // so the screen anchor is ready before the live point-count update arrives.
    window.addEventListener("pointerdown", rememberRouteClick, true);
    return () => window.removeEventListener("pointerdown", rememberRouteClick, true);
  }, [state?.customRouteTool, state?.mode, viewer]);
  useEffect(() => {
    if (!state || state.mode !== "drawingRoute") {
      routePointCountRef.current = null;
      routeLastPointRef.current = null;
      routePointerQueueRef.current = [];
      setRouteSpeedWarnings([]);
      return;
    }
    if (state.customRouteTool !== "add") {
      if (
        routePointCountRef.current != null
        && state.customRoutePointCount < routePointCountRef.current
      ) {
        setRouteSpeedWarnings([]);
      }
      routePointCountRef.current = state.customRoutePointCount;
      return;
    }
    const previousPointCount = routePointCountRef.current;
    routePointCountRef.current = state.customRoutePointCount;
    const actor = state.actors.find((candidate) => state.selection.includes(candidate.id));
    if (previousPointCount == null) {
      const authoredRoute = editorDocument?.data.choreography.interactions.find(
        (interaction) => interaction.actor === actor?.id
          && isCustomTimedRoute(interaction),
      );
      const authoredLast = authoredRoute && isCustomTimedRoute(authoredRoute)
        ? authoredRoute.target.points.at(-1)
        : null;
      routeLastPointRef.current = authoredLast
        ? { x: authoredLast.x, z: authoredLast.z }
        : actor ? { x: actor.x, z: actor.z } : null;
    }
    if (!shouldShowRoutePointWarning({
      previousPointCount,
      pointCount: state.customRoutePointCount,
      mode: state.mode,
      tool: state.customRouteTool,
    })) return;
    const addedPointCount = state.customRoutePointCount - previousPointCount!;
    const newWarnings: Array<{
      id: string;
      point: { x: number; z: number };
      message: string;
    }> = [];
    for (let offset = 1; offset <= addedPointCount; offset += 1) {
      const pointer = routePointerQueueRef.current.shift();
      if (!pointer) break;
      const tooFast = routePointMayBeTooFast({
        actorKind: actor?.kind,
        from: routeLastPointRef.current,
        to: pointer.world,
      });
      routeLastPointRef.current = pointer.world;
      if (!tooFast) continue;
      newWarnings.push({
        id: `${actor?.id ?? "actor"}:${previousPointCount! + offset}`,
        point: pointer.world,
        message: routePointWarningMessage(actor?.label ?? actor?.kind),
      });
    }
    if (newWarnings.length > 0) {
      setRouteSpeedWarnings((current) => [
        ...current.filter((item) => !newWarnings.some((warning) => warning.id === item.id)),
        ...newWarnings,
      ]);
    }
  }, [editorDocument, state]);
  useEffect(() => {
    if (experience !== "simple" || !editorDocument || !needsSimpleRouteConversion(editorDocument)) return;
    if (hasAdvancedMotion(editorDocument) && !sharedPlayback?.bundle?.trace) return;
    convertDocumentToSimpleTimedRoutes(editorDocument, sharedPlayback?.bundle?.trace);
  }, [editorDocument, experience, sharedPlayback?.bundle?.trace, state?.revision]);

  const chooseExperience = useCallback((next: EditorExperience) => {
    setExperience(next);
    writeEditorExperience(window.localStorage, next);
  }, []);
  const toggleExperience = useCallback(() => {
    if (!experience) return;
    chooseExperience(experience === "advanced" ? "simple" : "advanced");
  }, [chooseExperience, experience]);
  const selectActor = useCallback(
    (actorId: string | null) => {
      setExpandedTool(null);
      if (actorId) setSelectedSignalHeadId(null);
      controller?.setSelection(actorId ? [actorId] : []);
    },
    [controller],
  );

  const selectLibraryTool = useCallback((tool: ViewportTool | null) => {
    setExpandedTool(tool);
    if (!tool) return;
    controller?.setSelection([]);
    setSelectedSignalHeadId(null);
  }, [controller]);

  useEffect(() => {
    const current = state
      ? { mode: state.mode, actorCount: state.actors.length }
      : null;
    const previous = placementSnapshotRef.current;
    placementSnapshotRef.current = current;
    if (!shouldFinishActorPlacement({
      experience,
      activeTool: expandedTool,
      previous,
      current,
    })) return;
    controller?.cancel();
    setExpandedTool(null);
  }, [controller, experience, expandedTool, state]);

  useEffect(() => {
    setSelectedSignalHeadId(null);
  }, [map.versionId]);

  useEffect(() => {
    const overlays = signalOverlays;
    const index = signalProjection.index;
    if (!overlays || !index) return;
    const selection = selectedSignalHeadId
      ? selectSignalHead(index, selectedSignalHeadId)
      : null;
    overlays.setSignalHighlight(selectedHeadHighlight(selection));
    return () => {
      overlays.setSignalHighlight(null);
    };
  }, [selectedSignalHeadId, signalOverlays, signalProjection.index]);

  useEffect(() => {
    const overlays = signalOverlays;
    const index = signalProjection.index;
    if (!active || !overlays || !index || !editorDocument) return;
    const plans = editorDocument.data.mapSignalPlans.filter(
      (plan) => plan.binding.mapId === index.projection.mapId,
    );
    overlays.setAuthoringSignalStates(
      editorSignalStatesAt({
        index,
        plans,
        timeS: tutorialPlaybackState?.time ?? 0,
        clipSeconds: editorDocument.data.choreography.clipSeconds,
        warmupSeconds: editorDocument.data.choreography.warmupSeconds,
      }),
      tutorialPlaybackState?.time ?? 0,
    );
  }, [
    active,
    editorDocument,
    sharedPlayback?.bundle,
    signalOverlays,
    signalProjection.index,
    state?.revision,
    tutorialPlaybackState?.time,
  ]);

  useEffect(() => {
    const overlays = signalOverlays;
    const playbackController = sharedPlayback?.controller;
    if (!overlays) return;
    return () => {
      overlays.clearAuthoringSignalStates();
      playbackController?.refreshSignalPresentation();
    };
  }, [sharedPlayback?.controller, signalOverlays]);

  useEffect(() => {
    const overlays = signalOverlays;
    const index = signalProjection.index;
    const sceneViewer = viewer;
    const canvas = sceneViewer?.renderer.domElement ?? null;
    if (!active || !overlays || !index || !sceneViewer || !canvas || state?.mode !== "idle") return;
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    let press: { pointerId: number; x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: PointerEvent) => {
      const start = press;
      press = null;
      if (!start || start.pointerId !== event.pointerId || event.button !== 0) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, sceneViewer.camera);
      const headId = overlays.pickSignalOrb(raycaster);
      if (!headId) {
        setSelectedSignalHeadId(null);
        return;
      }
      const selectedSignal = selectSignalHead(index, headId);
      if (!selectedSignal) return;
      controller?.setSelection([]);
      setExpandedTool(null);
      if (editorDocument) {
        const currentPlan = editorDocument.data.mapSignalPlans.find(
          (plan) =>
            plan.binding.mapId === index.projection.mapId &&
            plan.binding.junctionId === selectedSignal.junctionId,
        );
        if (!currentPlan) {
          const plan = buildDefaultMapSignalPlanForHead({
            index,
            headId,
            clipSeconds: editorDocument.data.choreography.clipSeconds,
          });
          if (plan) editorDocument.addMapSignalPlan(plan);
        }
      }
      setSelectedSignalHeadId(headId);
    };
    canvas.addEventListener("pointerdown", onPointerDown, { capture: true });
    canvas.addEventListener("pointerup", onPointerUp, { capture: true });
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown, { capture: true });
      canvas.removeEventListener("pointerup", onPointerUp, { capture: true });
    };
  }, [active, controller, editorDocument, signalOverlays, signalProjection.index, state?.mode, viewer]);
  useEffect(() => {
    if (!controller) return;
    controller.setPresentationActive(active && !sharedPlayback?.inspecting);
    return () => controller.setPresentationActive(false);
  }, [active, controller, sharedPlayback?.inspecting]);
  // Playback presents the physics trace, so the authoring tools are not just
  // useless but harmful: an armed placement tool would drop an actor into the
  // scene mid-run. Disarm on entry and take the rail away, rather than leaving
  // a disabled-looking bar the author can still aim with. `expandedTool` is the
  // one piece of rail state the surface owns, and clearing it also settles
  // `data-left-panel-open` for the floating timeline.
  useEffect(() => {
    if (!sharedPlayback?.inspecting) return;
    controller?.cancel();
    setExpandedTool(null);
  }, [controller, sharedPlayback?.inspecting]);
  // Runs after the toggle above, and again on every controller notification, so
  // a ghost that toggle re-showed outside placement mode never reaches a frame.
  useEffect(() => {
    if (!viewer) return;
    hideStalePlacementGhost(viewer.scene, state?.mode);
  }, [active, sharedPlayback?.inspecting, state, viewer]);

  const displayNamesByActorId = useMemo(
    () => timelineActorLabels(editorDocument?.data.roles ?? []),
    [editorDocument?.data.roles],
  );

  const simulationIssues = useMemo(
    () =>
      collectSimulationIssues({
        experience,
        actorNames: Object.fromEntries(
          (editorDocument?.data.roles ?? []).map((role) => [
            role.id,
            state?.actors.find((actor) => actor.id === role.id)?.label
              ?? role.label
              ?? role.actor.class,
          ]),
        ),
        carlaCompatibilityTable,
        // Readiness text has to name actors the way the timeline and viewport
        // label them ("Fire truck 1"), not by catalog id: an author matching a
        // warning to a row cannot resolve `gallery.<uuid>.v1` to anything.
        placedActors: (state?.actors ?? []).map((actor) => ({
          id: actor.id,
          label: displayNamesByActorId.get(actor.id) ?? actor.label ?? actor.catalogId,
          catalogId: actor.catalogId,
        })),
        preparationMessage: sharedPlayback?.preparationMessage,
        playbackError: sharedPlayback?.error,
        bundle: sharedPlayback?.bundle,
        materializationNotes: sharedPlayback?.bundle?.instance.manifest["notes"],
        engineIssues: sharedPlayback?.bundle?.instance.manifest["issues"],
        transportError,
      }),
    [
      carlaCompatibilityTable,
      displayNamesByActorId,
      sharedPlayback?.bundle,
      sharedPlayback?.error,
      sharedPlayback?.preparationMessage,
      editorDocument,
      experience,
      state?.actors,
      transportError,
    ],
  );

  const getDebugInformation = useCallback(
    () =>
      buildEditorDebugInformation({
        datasetId,
        record,
        map,
        quality,
        scenarioConfiguration: editorDocument?.data ?? record?.content ?? null,
        selectedActor: selected,
        state,
        simulationIssues,
        documentRevision: editorDocument?.revision ?? null,
        saveError: editorDocument?.saveError ?? null,
        validation: editorDocument?.validation ?? null,
        preview: sharedPlayback?.bundle ?? null,
      }),
    [datasetId, editorDocument, map, quality, record, selected, sharedPlayback?.bundle, simulationIssues, state],
  );

  const configureCustomRoute = useCallback((interactionId: string) => {
    const playbackController = sharedPlayback?.controller;
    if (!controller || !editorDocument || !playbackController || !sharedPlayback) {
      setTransportError("Simulation preview is not ready yet. Try Configure again in a moment.");
      return;
    }
    const result = configureCustomRouteAtClipStart({
      document: editorDocument,
      controller,
      playback: playbackController,
      setInspecting: sharedPlayback.setInspecting,
      interactionId,
    });
    // This path leaves playback inspection directly, so it repairs the ghost
    // itself rather than waiting for the next controller notification.
    if (viewer) hideStalePlacementGhost(viewer.scene, controller.state.mode);
    setTransportError(result.configured ? null : "Custom route could not be configured at this timestamp.");
  }, [controller, editorDocument, sharedPlayback, setTransportError, viewer]);

  return (
    <EditorConfigurationBlockProvider blocked={Boolean(sharedPlayback?.inspecting)}>
      <EditorOverlayProvider
        documentKey={editorDocument}
        selectedActorId={selected?.id ?? null}
        suppressActorDetails={state?.mode === "drawingRoute"}
        onSelectActor={selectActor}
      >
      <SimulationIssueNotifications
        issues={simulationIssues.filter((issue) => issue.severity === "error")}
      />
      <EditorSceneEnvironmentBridge
        active={active && environmentSceneReady}
        document={editorDocument}
        quality={quality}
        viewer={viewer}
      />
      {active ? (
        <EditorHeader
          document={editorDocument}
          getDebugInformation={getDebugInformation}
          onExit={onExitToList}
          quality={quality}
          onQualityChange={onQualityChange}
          viewer={viewer}
          simulationIssues={simulationIssues}
          experience={experience}
          onExperienceToggle={toggleExperience}
        />
      ) : null}
      <UniScenarioEditorShell
        className={cn(
          "h-full min-h-editor-shell text-foreground",
          externalWorld ? "pointer-events-none" : "pointer-events-auto",
          externalWorld ? "bg-transparent" : "bg-background",
        )}
        canvasMode={externalWorld ? "passthrough" : "interactive"}
        data-external-world={String(externalWorld)}
        data-testid="uniscenario-editor-surface"
        header={null}
        leftSidebar={sharedPlayback?.inspecting ? null : (slotProps) => (
          <div {...slotProps} className={cn(slotProps.className, "flex h-full")}>
            <ActorLibraryRail
              controller={controller}
              state={state}
              hostRef={hostRef}
              canvas={externalWorld ? (viewer?.renderer.domElement ?? null) : null}
              activeTool={expandedTool}
              onExpandedToolChange={selectLibraryTool}
              document={editorDocument}
              sumoAvailable={Boolean(map.sumoNetworkSha256)}
              sumoStatus={sharedPlayback?.sumoStatus}
              parkedCars={{
                settings: parkedCarsSettings,
                onChange: parkedCarsOnChange,
                plan: parkedCars.plan,
                stallCount: parkedCars.stalls.length,
                status: parkedCars.status,
                bakedCount: parkedCarsSettings.baked.length,
                reason: parkedCars.reason,
              }}
              trafficDetails={editorDocument ? (
                <AmbientEditor
                  document={editorDocument}
                  sumoStatus={sharedPlayback?.sumoStatus}
                  provenance={sharedPlayback?.bundle?.ambientTraffic ?? null}
                  sumoAvailable={Boolean(map.sumoNetworkSha256)}
                />
              ) : (
                <div className="grid h-32 place-items-center text-xs text-muted-foreground">
                  <CloudActivityIndicator label="Loading traffic configuration…" />
                </div>
              )}
            />
          </div>
        )}
        canvas={(slotProps) => {
          const {
            "data-testid": _legacyCanvasTestId,
            "data-tutorial": _legacyCanvasTutorial,
            ...canvasSlotProps
          } = slotProps;
          return (
            <div
              {...canvasSlotProps}
              className={cn(canvasSlotProps.className, "flex")}
              data-external-world={String(externalWorld)}
            >
              <EditorCanvasRegion
              hostRef={hostRef}
              map={map}
              quality={quality}
              onViewerReady={onViewerReady}
              onMapLoaded={onMapLoaded}
              state={state}
              error={error}
              externalWorld={externalWorld}
            >
            </EditorCanvasRegion>
            </div>
          );
        }}
        statusOverlay={
          state?.mode === "placing" ? (
            <PlacementCursorHint
              state={state}
              hostRef={hostRef}
              canvas={externalWorld ? (viewer?.renderer.domElement ?? null) : null}
            />
          ) : state?.mode && state.mode !== "idle" ? (
            <div className="pointer-events-auto">
              <EditorModeBanner state={state} controller={controller} />
            </div>
          ) : null
        }
        floatingOverlay={environmentSceneReady && editorDocument ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 flex h-auto max-h-[min(65vh,520px)] justify-center px-4"
            data-left-panel-open={String(expandedTool !== null)}
            data-testid="floating-timeline-layer"
          >
            {/* 920px is the previous 736px widened by a quarter: the clips need the
                horizontal room more than the viewport needs the margin, and the
                name column can now be traded against the track by dragging. */}
            <div className="pointer-events-auto relative h-auto max-h-[min(65vh,520px)] w-full max-w-[920px] min-w-0">
              {/* Absolutely positioned rather than stacked above the card: the
                  timeline's height is constrained and user-draggable, and a
                  flow sibling would take height from the track. Escape is bound
                  only while playback is inspecting (V1TimelineRail), so the hint
                  appears exactly when the key does something. */}
              {sharedPlayback?.inspecting ? (
                <p className="pointer-events-none absolute inset-x-0 -top-6 text-center text-xs text-white">
                  Press Escape to exit simulation
                </p>
              ) : null}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-10 -bottom-5 h-16 rounded-full bg-black/45 blur-2xl"
              />
              <EditorTimelineOverlayBridge
                document={editorDocument}
                state={state}
                experience={experience ?? "simple"}
                signalIndex={signalProjection.index}
                selectedSignalHeadId={selectedSignalHeadId}
                onClearSignalSelection={() => setSelectedSignalHeadId(null)}
                onSelectSignal={setSelectedSignalHeadId}
                playback={sharedPlayback}
                onTransportError={setTransportError}
                onFrameActor={frameActorAtPlayhead}
                onFrameSignal={frameSignalHead}
                onConfigureCustomRoute={configureCustomRoute}
              />
            </div>
          </div>
        ) : null}
      />
      {!externalWorld ? (
        <SceneLoadingTransition
          visible={!sceneReady || localMapLoadError !== null}
          progress={localMapLoadError
            ? failedSceneLoadProgress(map.label, localMapLoadError)
            : localLoadProgress}
        />
      ) : null}

      <EditorOverlayHost
        controller={controller}
        document={editorDocument}
        onConfigureCustomRoute={configureCustomRoute}
        showActorMotionControls={experience === "advanced"}
      />
      <AssistantChatSlot controller={controller} document={editorDocument} />
      <NotificationDockSlot documentId={record?.id ?? null} datasetId={datasetId} />
      <RoutePointSpeedWarningOverlay viewer={viewer} warnings={routeSpeedWarnings} />
      <TutorialOverlaySlot
        actorCount={state?.actors.length ?? 0}
        configuredRouteCount={editorDocument?.data.choreography.interactions.filter(
          (interaction) => interaction.verb === "route"
            && interaction.target.mode === "customTimedRoute"
            && !isUnconfiguredSimpleTimedRoute(interaction),
        ).length ?? 0}
        customRouteTool={state?.mode === "drawingRoute" ? state.customRouteTool : null}
        editorMode={state?.mode ?? "idle"}
        experience={experience}
        interactionCount={editorDocument?.data.choreography.interactions.length ?? 0}
        playbackInspecting={Boolean(sharedPlayback?.inspecting)}
        playbackPlaying={Boolean(tutorialPlaybackState?.playing)}
        ready={sceneReady}
        scenarioKey={record?.id ?? null}
      />
      {active && experienceReady && experience === null ? (
        <EditorExperienceChooser onChoose={chooseExperience} />
      ) : null}
      </EditorOverlayProvider>
    </EditorConfigurationBlockProvider>
  );
}

function RoutePointSpeedWarningOverlay({
  viewer,
  warnings,
}: {
  viewer: CityViewer | null;
  warnings: ReadonlyArray<{
    readonly id: string;
    readonly point: { readonly x: number; readonly z: number };
    readonly message: string;
  }>;
}) {
  const [positions, setPositions] = useState<Readonly<Record<string, {
    x: number;
    y: number;
    visible: boolean;
  }>>>({});

  useEffect(() => {
    if (!viewer || warnings.length === 0) {
      setPositions({});
      return;
    }
    let frame = 0;
    const projected = new Vector3();
    const update = () => {
      const bounds = viewer.renderer.domElement.getBoundingClientRect();
      const next: Record<string, { x: number; y: number; visible: boolean }> = {};
      for (const warning of warnings) {
        const groundY = viewer.sampleGroundHeight(warning.point.x, warning.point.z) ?? 0;
        projected.set(warning.point.x, groundY + 2.35, warning.point.z).project(viewer.camera);
        next[warning.id] = {
          x: Math.round(bounds.left + (projected.x + 1) * bounds.width / 2),
          y: Math.round(bounds.top + (1 - projected.y) * bounds.height / 2),
          visible: projected.z >= -1 && projected.z <= 1,
        };
      }
      setPositions((current) => {
        const keys = Object.keys(next);
        if (
          keys.length === Object.keys(current).length
          && keys.every((key) => current[key]?.x === next[key]?.x
            && current[key]?.y === next[key]?.y
            && current[key]?.visible === next[key]?.visible)
        ) return current;
        return next;
      });
      frame = window.requestAnimationFrame(update);
    };
    update();
    return () => window.cancelAnimationFrame(frame);
  }, [viewer, warnings]);

  if (!viewer || warnings.length === 0) return null;
  return createPortal(
    <>
      {warnings.map((warning) => {
        const position = positions[warning.id];
        if (!position?.visible) return null;
        return (
          <div
            aria-live="polite"
            className="pointer-events-none fixed z-[90] max-w-56 -translate-x-1/2 -translate-y-full pb-3"
            data-point-warning-id={warning.id}
            data-testid="route-point-speed-warning"
            key={warning.id}
            role="status"
            style={{ left: position.x, top: position.y }}
          >
            <div className="relative border border-amber-300/80 bg-black/90 px-3 py-2 text-center text-[11px] font-medium leading-snug text-amber-100 shadow-lg backdrop-blur-md">
              {warning.message}
              <span
                aria-hidden="true"
                className="absolute left-1/2 top-full size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-amber-300/80 bg-black"
              />
            </div>
          </div>
        );
      })}
    </>,
    document.body,
  );
}

function routeGroundPoint(
  viewer: CityViewer,
  clientX: number,
  clientY: number,
): { x: number; z: number } | null {
  const bounds = viewer.renderer.domElement.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const raycaster = new Raycaster();
  raycaster.setFromCamera(new Vector2(
    (clientX - bounds.left) / bounds.width * 2 - 1,
    -((clientY - bounds.top) / bounds.height) * 2 + 1,
  ), viewer.camera);
  if (raycaster.ray.direction.y >= -1e-6) return null;

  const point = new Vector3();
  let groundY = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    const distance = (groundY - raycaster.ray.origin.y) / raycaster.ray.direction.y;
    if (!(distance > 0) || distance > 100_000) return null;
    point.copy(raycaster.ray.direction).multiplyScalar(distance).add(raycaster.ray.origin);
    const sampled = viewer.sampleGroundHeight(point.x, point.z);
    if (sampled == null || Math.abs(sampled - groundY) < 0.01) break;
    groundY = sampled;
  }
  return { x: point.x, z: point.z };
}

function SimulationIssueNotifications({
  issues,
}: {
  issues: readonly SimulationIssue[];
}) {
  return (
    <>
      {issues.map((issue) => (
        <SimulationIssueNotification issue={issue} key={issue.id} />
      ))}
    </>
  );
}

function SimulationIssueNotification({ issue }: { issue: SimulationIssue }) {
  useUniScenarioNotification(`uniscenario-simulation-${issue.id}`, {
    severity: issue.severity,
    source: "simulation",
    message: issue.title,
    detail: issue.detail,
  });
  return null;
}

function EditorTimelineOverlayBridge({
  document,
  state,
  experience,
  signalIndex,
  selectedSignalHeadId,
  onClearSignalSelection,
  onSelectSignal,
  playback,
  onTransportError,
  onFrameActor,
  onFrameSignal,
  onConfigureCustomRoute,
}: {
  document: EditorDocument;
  state: EditorState | null;
  experience: EditorExperience;
  signalIndex: EditorSignalIndex | null;
  selectedSignalHeadId: string | null;
  onClearSignalSelection: () => void;
  onSelectSignal: (headId: string) => void;
  playback?: UniScenarioSharedPlayback;
  onTransportError: (message: string | null) => void;
  onFrameActor: (actorId: string) => void;
  onFrameSignal: (headId: string) => void;
  onConfigureCustomRoute: (interactionId: string) => void;
}) {
  const { selection, actions } = useEditorOverlay();
  const [tutorialRouteInteractionId, setTutorialRouteInteractionId] = useState<string | null>(null);
  const playbackState = usePlaybackControllerState(playback?.controller ?? null);
  const selectedSignal = signalIndex && selectedSignalHeadId
    ? selectSignalHead(signalIndex, selectedSignalHeadId)
    : null;
  const currentPlans = signalIndex
    ? document.data.mapSignalPlans.filter((plan) => plan.binding.mapId === signalIndex.projection.mapId)
    : [];
  const signalLanes: readonly V1TimelineSignalLane[] = signalIndex
    ? currentPlans.flatMap((plan) => {
        const row = buildReferenceSignalTimelineRow({
          index: signalIndex,
          plans: currentPlans,
          plan,
          clipSeconds: document.data.choreography.clipSeconds,
          warmupSeconds: document.data.choreography.warmupSeconds,
        });
        if (!row) return [];
        return [{
          junctionId: row.junctionId,
          controllerId: row.controllerId,
          headIds: row.headIds,
          bands: row.bands,
          referenceHeadId: row.referenceHeadId,
          onRemoveControl: () => {
            document.removeMapSignalPlan(plan.id);
            if (selectedSignal?.junctionId === row.junctionId) onClearSignalSelection();
          },
        }];
      })
    : [];

  const takeSignalControl = (headId: string) => {
    if (!signalIndex) return;
    const selected = selectSignalHead(signalIndex, headId);
    if (!selected) return;
    const currentPlan = document.data.mapSignalPlans.find(
      (candidate) =>
        candidate.binding.mapId === signalIndex.projection.mapId
        && candidate.binding.junctionId === selected.junctionId,
    );
    if (!currentPlan) {
      const nextPlan = buildDefaultMapSignalPlanForHead({
        index: signalIndex,
        headId,
        clipSeconds: document.data.choreography.clipSeconds,
      });
      if (nextPlan) document.addMapSignalPlan(nextPlan);
    }
    onSelectSignal(headId);
  };

  let signalAuthoring: V1TimelineSignalAuthoring | null = null;
  if (signalIndex && selectedSignal) {
    const plan = planForJunction(currentPlans, selectedSignal.junctionId);
    const binding = plan ? checkPlanBinding(signalIndex, plan) : null;
    const cycle = plan && binding?.ok ? decompilePlanToCycle(signalIndex, plan) : [];
    const reference = readReferenceTiming({
      index: signalIndex,
      junctionId: selectedSignal.junctionId,
      referenceHeadId: selectedSignal.selectedHeadId,
      cycle,
    });
    const movement = signalIndex.movementById.get(selectedSignal.referenceMovementId);
    const commitCycle = (
      timing: typeof reference.timing,
      phaseOrder: typeof reference.phaseOrder,
    ) => {
      const nextCycle = compileReferenceCycle({
        index: signalIndex,
        junctionId: selectedSignal.junctionId,
        referenceHeadId: selectedSignal.selectedHeadId,
        timing,
        phaseOrder,
      });
      const layout = layOutCycle({
        cycle: nextCycle,
        clipSeconds: document.data.choreography.clipSeconds,
        coverage: "clip",
        junctionId: selectedSignal.junctionId,
      });
      const nextPlan = buildMapSignalPlan({
        projection: signalIndex.projection,
        junctionId: selectedSignal.junctionId,
        clips: layout.clips,
      });
      if (plan) document.replaceMapSignalPlan(plan.id, nextPlan);
      else document.addMapSignalPlan(nextPlan);
    };
    signalAuthoring = {
      junctionId: selectedSignal.junctionId,
      headId: selectedSignal.selectedHeadId,
      label: movement?.label ?? `Head ${selectedSignal.selectedHeadId}`,
      timing: reference.timing,
      phaseOrder: reference.phaseOrder,
      generated: plan ? reference.generated : true,
      crossingStageCount: crossingStageCount(signalIndex, selectedSignal.junctionId),
      hasPlan: Boolean(plan),
      warning: binding && !binding.ok ? binding.message : null,
      onTimingChange: (next) => {
        const timing = clampReferenceTiming({ ...reference.timing, ...next });
        commitCycle(timing, reference.phaseOrder);
      },
      onPhaseOrderChange: (phaseOrder) => {
        commitCycle(reference.timing, phaseOrder);
      },
      onReset: (snapshot) => {
        commitCycle(snapshot.timing, snapshot.phaseOrder);
      },
      onRemoveControl: plan ? () => {
        document.removeMapSignalPlan(plan.id);
        onClearSignalSelection();
      } : undefined,
    };
  }

  useEffect(() => {
    if (!signalAuthoring || selection.kind === null) return;
    actions.clear();
  }, [actions, selection.kind, signalAuthoring]);

  const browserPlayback: V1TimelineBrowserPlayback | null =
    playback?.bundle && playback.controller && playbackState
      ? {
          sessionId: playback.bundle.instance.manifest.inputHash,
          playing: playbackState.playing,
          inspecting: playback.inspecting,
          time: playbackState.time,
          crashes: playback.bundle.trace.events
            .filter((event) => event.kind === "collision")
            .map((event) => ({
              timeS: event.t,
              actorLabels: [event.a, event.b].map((actorId) =>
                state?.actors.find((actor) => actor.id === actorId)?.label
                  ?? document.data.roles.find((role) => role.id === actorId)?.label
                  ?? actorId,
              ),
            })),
          onPlay: () => {
            try {
              onTransportError(null);
              if (!playback.inspecting) playback.setInspecting(true);
              playback.controller?.play();
            } catch (reason) {
              playback.setInspecting(false);
              onTransportError(reason instanceof Error ? reason.message : String(reason));
            }
          },
          onStop: () => {
            try {
              onTransportError(null);
              playback.controller?.pause();
            } catch (reason) {
              onTransportError(reason instanceof Error ? reason.message : String(reason));
            }
          },
          onReset: () => {
            onTransportError(null);
            stopAndResetTimelinePlayback({
              controller: playback.controller,
              startTime: playback.bundle?.startTime ?? 0,
              setInspecting: playback.setInspecting,
            });
          },
          onPlayPause: () => {
            try {
              onTransportError(null);
              if (!playback.inspecting) {
                playback.setInspecting(true);
                playback.controller?.play();
                return;
              }
              playback.controller?.toggle();
            } catch (reason) {
              playback.setInspecting(false);
              onTransportError(reason instanceof Error ? reason.message : String(reason));
            }
          },
          onSeek: (time) => playback.controller?.seek(time),
          onExitInspection: () => {
            onTransportError(null);
            stopAndResetTimelinePlayback({
              controller: playback.controller,
              startTime: playback.bundle?.startTime ?? 0,
              setInspecting: playback.setInspecting,
            });
          },
        }
      : null;

  return (
    <>
      {tutorialRouteInteractionId ? (
        <SimpleRouteTutorialPanel
          onClose={() => {
            markSimpleRouteTutorialSeen(simpleRouteTutorialStorage());
            setTutorialRouteInteractionId(null);
          }}
          onStart={() => {
            markSimpleRouteTutorialSeen(simpleRouteTutorialStorage());
            const interactionId = tutorialRouteInteractionId;
            setTutorialRouteInteractionId(null);
            onConfigureCustomRoute(interactionId);
          }}
        />
      ) : null}
      {signalAuthoring ? (
        <TrafficLightDetailsPanel
          key={`${signalAuthoring.junctionId}:${signalAuthoring.headId}`}
          authoring={signalAuthoring}
          onClose={onClearSignalSelection}
        />
      ) : null}
      <UniScenarioTimelineDock
      document={document}
      experience={experience}
      state={state}
      signalLanes={signalLanes}
      signalAuthoring={signalAuthoring}
      playback={browserPlayback}
      selectedInteractionId={
        selection.kind === "interaction" ? selection.interactionId : null
      }
      onFocusActor={(actorId) => {
        onClearSignalSelection();
        actions.selectActor(actorId);
        onFrameActor(actorId);
      }}
      onFocusSignal={(headId) => {
        takeSignalControl(headId);
        onFrameSignal(headId);
      }}
      onSelectActor={(actorId) => {
        onClearSignalSelection();
        actions.selectActor(actorId);
      }}
      onSelectInteraction={(interactionId, actorId) => {
        onClearSignalSelection();
        const interaction = document.data.choreography.interactions.find(
          (candidate) => candidate.id === interactionId,
        );
        if (
          experience === "simple"
          && interaction?.verb === "route"
          && interaction.target.mode === "customTimedRoute"
        ) {
          actions.clear();
          const storage = simpleRouteTutorialStorage();
          if (shouldShowSimpleRouteTutorial(storage)) {
            setTutorialRouteInteractionId(interactionId);
            return;
          }
          onConfigureCustomRoute(interactionId);
          return;
        }
        actions.selectInteraction(interactionId, actorId);
      }}
      onClearSelection={actions.clear}
      onSelectSignal={takeSignalControl}
      readOnly={false}
      />
    </>
  );
}
