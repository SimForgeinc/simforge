"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActorRenderer } from "@simforge/viewer";
import type { CameraView, CityViewer } from "@simforge/viewer";
import { indexedWorldHeightSampler } from "@simforge/viewer";
import {
  ambientSignalCycleSettingsFromExtensions,
  ambientTrafficProfileFromExtensions,
} from "@simforge/playback/traffic";
import {
  ambientTrafficProviderFromExtensions,
  BrowserMaterializedTrafficCapture,
  sumoOwnsPhysicalSignalStates,
} from "@simforge/playback/traffic";
import type { MaterializedTrafficArtifactEnvelope } from "@simforge/engine";
import { useSumoTraffic } from "@/app/lib/uniscenario/ambient/useSumoTraffic";
import { parkedCarsFromExtensions } from "@/app/lib/uniscenario/parking/extension";
import {
  parkedCarOccupancySources,
  useParkedCars,
} from "@/app/lib/uniscenario/parking/useParkedCars";
import { allSumoSignalsGreenFromExtensions } from "@simforge/playback/traffic";
import type { UniScenarioDocumentDto } from "@/app/lib/uniscenario/contracts";
import { playbackMapEntry, type MapEntry } from "@/app/lib/uniscenario/maps";
import type { PlaybackBundle } from "@simforge/playback";
import { firstEnabledDashCamera } from "@simforge/scenario";
import { usePlaybackControllerState } from "@/app/lib/uniscenario/playback/usePlayback";
import {
  applyRestingHeading,
  createRestingHeading,
} from "@simforge/playback";
import { cn } from "@/app/lib/utils";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import { renderableMaps } from "./mapCatalog";
import { mapSupportsScenarioPreview } from "./previewPolicy";
import { useIdleStreetTour } from "./useIdleStreetTour";
import { animateMapCamera } from "./map-camera-transition";
import type { UniScenarioSession } from "./useUniScenarioSession";
import type {
  UniScenarioWorldState,
  UniScenarioWorldTarget,
} from "./UniScenarioWorldHost";
import { ScenarioPreviewTimeline } from "./ScenarioPreviewTimeline";
import { useCinematicPreview } from "./useCinematicPreview";
import { rememberCinematicPreviewEnabled } from "../list/uniScenarioViewState";
import { uniScenarioListCache } from "../list/uniScenarioListCache";

export { mapSupportsScenarioPreview, previewAmbientTrafficProfile } from "./previewPolicy";

const MAP_ERROR_GRACE_MS = 8_000;
const AUTHORED_ACTOR_FRAME_MS = 900;

/** Sensor mounts define the recording subject, while the authored trace remains a fallback for older scenarios. */
export function scenarioPreviewFocusActorId(
  document: UniScenarioDocumentDto,
  bundle: PlaybackBundle,
): string | null {
  const authoredActorIds = new Set(document.content.roles.map((role) => role.id));
  if (authoredActorIds.size === 0) return null;
  const sensorSubject = document.content.roles.find(
    (role) => role.actor.sensors.length > 0,
  );
  if (sensorSubject) return sensorSubject.id;
  const metricSubject = bundle.trace.header.metricSubject;
  if (metricSubject && authoredActorIds.has(metricSubject)) return metricSubject;
  return document.content.roles[0]?.id ?? null;
}

/** A close, slightly elevated trailing view of one actor at its first visible pose. */
export function scenarioPreviewActorCameraView(
  bundle: PlaybackBundle,
  actorId: string,
  ground: number,
): CameraView | null {
  const actor = bundle.actors.find((candidate) => candidate.id === actorId);
  const track = bundle.trace.ticks.actors[actorId];
  if (!actor || !track) return null;
  const index = track.present.findIndex(Boolean);
  if (index < 0) return null;
  const x = track.x[index];
  const z = track.z[index];
  if (typeof x !== "number" || typeof z !== "number" || !Number.isFinite(x) || !Number.isFinite(z)) return null;
  const heading = track.headingRad?.[index] ?? actor.initial.headingRad ?? 0;
  const size = Math.max(actor.dims.l, actor.dims.w);
  const distance = Math.max(11, Math.min(18, size * 2.2));
  const height = Math.max(6.5, Math.min(10, size * 1.3));
  const forwardX = Math.cos(heading);
  const forwardZ = Math.sin(heading);
  const rightX = -forwardZ;
  const rightZ = forwardX;
  return {
    position: [
      x - forwardX * distance + rightX * distance * 0.42,
      ground + height,
      z - forwardZ * distance + rightZ * distance * 0.42,
    ],
    target: [x + forwardX * 1.5, ground + 1.4, z + forwardZ * 1.5],
    fov: 48,
  };
}

/** List-side presentation for the workspace-owned simulation session. */
export function UniScenarioIdleScene({
  className,
  documentId,
  active = true,
  lockedTour = false,
  viewer,
  actorRenderer,
  worldState,
  onWorldTargetChange,
  session,
}: {
  className?: string;
  documentId?: string;
  active?: boolean;
  /** Keep the idle camera animation running instead of pausing for user input. */
  lockedTour?: boolean;
  viewer: CityViewer | null;
  actorRenderer: ActorRenderer | null;
  worldState: UniScenarioWorldState;
  onWorldTargetChange: (target: UniScenarioWorldTarget) => void;
  session: UniScenarioSession;
}) {
  const { maps, map, document, bundle, playback } = session;

  useEffect(() => {
    if (!active || !map?.browserManifestUrl) return;
    onWorldTargetChange({
      mapVersionId: map.mapVersionId,
      manifestUrl: map.browserManifestUrl,
      label: map.label,
      locality: map.locality,
    });
  }, [active, map, onWorldTargetChange]);

  useIdleStreetTour({
    enabled: active && !documentId,
    interruptible: !lockedTour,
    map,
    viewer,
    loadedMapVersionId: worldState.loadedMapVersionId,
  });

  const sampleHeight = useMemo(
    () => viewer && worldState.loadedMapVersionId === map?.mapVersionId
      ? indexedWorldHeightSampler(viewer)
      : null,
    [map?.mapVersionId, viewer, worldState.loadedMapVersionId],
  );

  /**
   * The in-car beat's sensor mount.
   *
   * Physical sensor ownership is the same signal `scenarioPreviewFocusActorId`
   * prefers for the subject, so a scenario authored with a dash camera gets both
   * the trailing subject and the in-car angle from one decision.
   */
  const dashMount = useMemo(() => {
    if (!document) return null;
    for (const role of document.content.roles) {
      const sensor = firstEnabledDashCamera(role.actor);
      if (sensor) return { actorId: role.id, sensor };
    }
    return null;
  }, [document]);
  const cinematicSubjectActorId = useMemo(
    () => (document && bundle ? scenarioPreviewFocusActorId(document, bundle) : null),
    [bundle, document],
  );
  /**
   * The persisted preference is adopted after mount, never during the first
   * render.
   *
   * `uniScenarioListCache` is hydrated from `localStorage` by the list client,
   * so reading it in a `useState` initializer makes the server HTML and the
   * first client render disagree whenever the user has turned the cuts off —
   * a hydration mismatch that discards the whole tree, boot gate included.
   */
  const [cinematicEnabled, setCinematicEnabled] = useState(true);
  useEffect(() => {
    setCinematicEnabled(uniScenarioListCache.cinematicPreviewEnabled);
  }, []);
  const toggleCinematic = useCallback(() => {
    setCinematicEnabled((previous) => {
      const next = !previous;
      rememberCinematicPreviewEnabled(next);
      return next;
    });
  }, []);
  const mapResident = Boolean(
    map
    && worldState.loadedMapVersionId === map.mapVersionId
    && (worldState.transitionPhase ?? "idle") === "idle",
  );
  const cinematic = useCinematicPreview({
    enabled: Boolean(active && documentId && cinematicEnabled && mapResident),
    viewer,
    bundle,
    controller: playback.controller,
    subjectActorId: cinematicSubjectActorId,
    dashMount,
  });
  // Interior boundaries only: the clip's own start and end are not cuts.
  const cinematicCutTimes = useMemo(
    () => (cinematic.shotList?.shots ?? []).slice(1).map((shot) => shot.startT),
    [cinematic.shotList],
  );
  const framedScenarioKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !active
      || !documentId
      || !document
      || !bundle
      || !viewer
      || !map
      || worldState.loadedMapVersionId !== map.mapVersionId
      || (worldState.transitionPhase ?? "idle") !== "idle"
      // The director owns the camera outright while engaged. Running the
      // single-actor framing transition underneath it is the two-writer bug
      // this whole surface is careful about.
      || cinematic.engaged
    ) return;

    const focusActorId = scenarioPreviewFocusActorId(document, bundle);
    if (!focusActorId) return;
    const track = bundle.trace.ticks.actors[focusActorId];
    const firstVisibleIndex = track?.present.findIndex(Boolean) ?? -1;
    if (!track || firstVisibleIndex < 0) return;
    const focusX = track.x[firstVisibleIndex];
    const focusZ = track.z[firstVisibleIndex];
    if (
      typeof focusX !== "number"
      || typeof focusZ !== "number"
      || !Number.isFinite(focusX)
      || !Number.isFinite(focusZ)
    ) return;

    const frameKey = `${document.id}:${bundle.instance.manifest.inputHash}:${map.mapVersionId}:${focusActorId}`;
    if (framedScenarioKeyRef.current === frameKey) return;
    framedScenarioKeyRef.current = frameKey;

    const destination = scenarioPreviewActorCameraView(
      bundle,
      focusActorId,
      sampleHeight?.(focusX, focusZ) ?? 0,
    );
    if (!destination) return;
    let completed = false;
    const cancel = animateMapCamera(
      (view) => viewer.applyView(view),
      viewer.captureView(),
      destination,
      AUTHORED_ACTOR_FRAME_MS,
      () => {
        completed = true;
      },
    );
    return () => {
      cancel();
      if (!completed && framedScenarioKeyRef.current === frameKey) {
        framedScenarioKeyRef.current = null;
      }
    };
  }, [
    active,
    bundle,
    cinematic.engaged,
    document,
    documentId,
    map,
    sampleHeight,
    viewer,
    worldState.loadedMapVersionId,
    worldState.transitionPhase,
  ]);
  const playbackMap = useMemo(
    () => map && mapSupportsScenarioPreview(map) ? playbackMapEntry(map) : null,
    [map],
  );
  const handleSumoFallback = useCallback(() => undefined, []);
  const playbackState = usePlaybackControllerState(playback.controller);
  const showPreviewTimeline = Boolean(document && hasAuthoredTimelineData(document.content));
  const sceneError = Boolean(
    worldState.error
    && worldState.target?.mapVersionId === map?.mapVersionId
    && worldState.loadedMapVersionId !== map?.mapVersionId,
  );
  const streaming = Boolean(map && worldState.loadedMapVersionId !== map.mapVersionId);
  const [showSceneError, setShowSceneError] = useState(false);
  useEffect(() => {
    setShowSceneError(false);
    if (!sceneError) return;
    const timer = window.setTimeout(() => setShowSceneError(true), MAP_ERROR_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [map?.mapVersionId, sceneError]);
  const empty = maps !== null && renderableMaps(maps).length === 0;
  const sceneLoading = !session.failed
    && !empty
    && !(sceneError && showSceneError)
    && (map === null || streaming);
  const message = session.failed
    ? "Could not load the map catalog."
    : empty
      ? "No maps available to preview."
      : sceneError && showSceneError
        ? "This map could not be displayed."
        : map === null || streaming
          ? "Loading…"
          : session.message
          ? session.message
          : playback.error ? `Preview unavailable: ${playback.error}` : null;

  return (
    <div
      className={cn("pointer-events-none relative min-w-0 flex-1 overflow-hidden", className)}
      data-testid="uniscenario-idle-scene"
      data-preview-document-id={documentId}
      data-active={String(active)}
      data-tour-locked={String(lockedTour)}
    >
      {message && active ? (
        sceneLoading ? (
          <CloudActivityIndicator
            className="pointer-events-none absolute right-4 top-4 z-10 text-xs text-white/70"
            label={message}
            testId="uniscenario-idle-status"
          />
        ) : (
          <div
            className="pointer-events-none absolute right-4 top-4 z-10 max-w-sm"
            data-testid="uniscenario-idle-status"
            role={session.failed || showSceneError || message.startsWith("Preview unavailable") ? "alert" : "status"}
          >
            <span className="inline-flex rounded-md border border-black/10 bg-white/90 px-3 py-2 text-xs font-medium text-black/65 shadow-sm backdrop-blur-md">
              {message}
            </span>
          </div>
        )
      ) : null}

      {active && showPreviewTimeline ? (
        <div
          className="pointer-events-auto absolute bottom-4 right-4 z-10 w-[min(760px,calc(100%_-_2rem))]"
          data-testid="uniscenario-preview-timeline-anchor"
        >
          <ScenarioPreviewTimeline
            playback={{
              playing: playbackState?.playing ?? false,
              time: playbackState?.time ?? bundle?.startTime ?? 0,
              startTime: bundle?.startTime ?? 0,
              endTime: bundle?.endTime ?? document?.content.choreography.clipSeconds ?? 0,
              disabled: !bundle || !playback.controller,
              onPlayPause: () => playback.controller?.toggle(),
              onSeek: (time) => playback.controller?.seek(time),
            }}
            cinematic={{
              available: Boolean(documentId && cinematic.shotList),
              enabled: cinematicEnabled,
              shotLabel: cinematic.activeShot?.label ?? null,
              cutTimes: cinematicCutTimes,
              onToggle: toggleCinematic,
            }}
          />
        </div>
      ) : null}

      {!active && playbackMap && document && bundle ? (
        <SumoPreviewTraffic
          map={playbackMap}
          document={document}
          bundle={bundle}
          actorRenderer={actorRenderer}
          sampleHeight={sampleHeight}
          playback={playback}
          evidenceRequest={session.evidenceRequest}
          onEvidenceComplete={session.completeRevisionEvidence}
          onEvidenceFailure={session.failRevisionEvidence}
          onFallback={handleSumoFallback}
        />
      ) : null}
    </div>
  );
}

function hasAuthoredTimelineData(content: UniScenarioDocumentDto["content"]): boolean {
  return content.roles.length > 0
    || content.choreography.interactions.length > 0
    || (content.mapSignalPlans?.length ?? 0) > 0
    || (content.reasoningTrace?.length ?? 0) > 0;
}

/** Live browser traffic is presentation-only here: it never uploads or retains evidence. */
export function SumoPreviewTraffic({
  map,
  document,
  bundle,
  actorRenderer,
  sampleHeight,
  playback,
  evidenceRequest,
  onEvidenceComplete,
  onEvidenceFailure,
  onFallback,
}: {
  map: MapEntry;
  document: UniScenarioDocumentDto;
  bundle: PlaybackBundle;
  actorRenderer: ActorRenderer | null;
  sampleHeight: ((x: number, z: number) => number | null) | null;
  playback: UniScenarioSession["playback"];
  evidenceRequest: UniScenarioSession["evidenceRequest"];
  onEvidenceComplete: (requestKey: string, artifact: MaterializedTrafficArtifactEnvelope) => void;
  onEvidenceFailure: (requestKey: string, reason: unknown) => void;
  onFallback: (reason: string) => void;
}) {
  const playbackState = usePlaybackControllerState(playback.controller);
  const extensions = document.content.extensions;
  const profile = useMemo(() => ambientTrafficProfileFromExtensions(extensions), [extensions]);
  const provider = ambientTrafficProviderFromExtensions(extensions);
  const hasAuthoredMapSignals = (document.content.mapSignalPlans?.length ?? 0) > 0;
  const acceleratedSignalCycles = ambientSignalCycleSettingsFromExtensions(extensions).acceleratedSignalCycles;
  const allSignalsGreen = allSumoSignalsGreenFromExtensions(extensions);
  const materializedTrafficCapture = useMemo(() => evidenceRequest && provider === "sumo"
    ? new BrowserMaterializedTrafficCapture({
        sourceInputDigest: bundle.instance.manifest.inputHash,
        mapAssetId: map.sourceMapId,
        mapVersionId: map.mapVersionId,
        provider: { id: "sumo", version: "1.27.1", seed: String(profile.seed) },
        fixedStepSeconds: bundle.trace.header.dt,
        durationSeconds: bundle.endTime - bundle.startTime,
      })
    : undefined, [bundle, evidenceRequest, map.mapVersionId, map.sourceMapId, profile.seed, provider]);
  const metadata = useMemo(() => new Map(bundle.actors.map((actor) => [actor.id, actor])), [bundle]);
  const restingHeading = useMemo(() => createRestingHeading(bundle), [bundle]);
  const externalActors = (playback.controller?.currentActors ?? []).map((sampled) => {
    // Same repair as the editor's playback renderer: a dwell in a timed route
    // is recorded facing due east. See `restingHeading` in `@simforge/playback`.
    const actor = applyRestingHeading(
      { ...sampled, animationTimeS: playback.controller?.state.time ?? 0 },
      restingHeading,
    );
    return {
      id: actor.id,
      kind: metadata.get(actor.id)?.kind ?? "vehicle",
      x: actor.x,
      z: actor.z,
      headingRad: actor.headingRad,
      speedMps: actor.speedMps,
      lengthM: actor.dims.l,
      widthM: actor.dims.w,
      static: actor.static,
      present: actor.present,
      render: {
        ...actor,
        y: sampleHeight?.(actor.x, actor.z) ?? 0,
      },
    };
  });
  // Memoised: the reader allocates a fresh `baked` array per call, and that
  // identity drives the occupancy memo below. Parked cars never move, so the
  // occupancy list should be built once, not once per frame.
  const parkedCarsSettings = useMemo(() => parkedCarsFromExtensions(extensions), [extensions]);
  /**
   * Parked cars are reported to SUMO as stationary occupancy so ambient traffic
   * does not drive through one. `buildSumoAuthoredOccupancies` keeps only shapes
   * whose footprint touches a driveable lane, so curb stalls block traffic while
   * off-street lot cars are correctly ignored.
   *
   * Exclusions come from the actors resolved here rather than from the editor's
   * own list. The two agree at t=0; where they briefly differ, the only effect is
   * that one stall's occupancy is reported (or not) beside an authored car that
   * SUMO already sees, so nothing observable changes.
   *
   * A parked car needs no resting-heading repair: its heading comes from the
   * stall, not from a recorded dwell.
   */
  const parkedExclusions = useMemo(
    () =>
      (playback.controller?.currentActors ?? []).map((actor) => ({
        x: actor.x,
        z: actor.z,
        radiusM: Math.max(1.5, Math.hypot(actor.dims.l, actor.dims.w) / 2),
      })),
    [playback.controller],
  );
  const parkedCars = useParkedCars({
    mapAssetId: map.sourceMapId,
    settings: parkedCarsSettings,
    exclusions: parkedExclusions,
  });
  const occupancyActors = useMemo(
    () => parkedCarOccupancySources(parkedCars.cars),
    [parkedCars.cars],
  );
  const focusActor = playback.controller?.currentActors.find((candidate) => candidate.present);
  const focus = focusActor ? { x: focusActor.x, z: focusActor.z } : null;
  const demandFocuses = useMemo(
    () =>
      (playback.controller?.currentActors ?? [])
        .filter((actor) => actor.present)
        .map((actor) => ({ x: actor.x, z: actor.z })),
    [playback.controller],
  );
  const status = useSumoTraffic({
    // The browser bridge cannot inject an authored MapSignalPlan into SUMO's
    // tlLogic yet. Letting both run would show one colour while SUMO vehicles
    // obey another, so an authored controller plan takes exclusive ownership.
    enabled: provider === "sumo" && map.sumoNetworkSha256 !== null && !hasAuthoredMapSignals,
    map,
    profile,
    renderer: actorRenderer,
    sampleHeight,
    mode: playbackState?.playing
      ? "playing"
      : playback.inspecting
        ? "paused"
        : "authoring",
    time: playbackState?.time ?? 0,
    externalActors: [...externalActors, ...occupancyActors],
    collisionActorOverrides: playback.collisionActorOverrides,
    focus,
    demandFocuses,
    onFallback: (reason) => {
      if (evidenceRequest) onEvidenceFailure(evidenceRequest.key, reason);
      onFallback(reason);
    },
    acceleratedSignalCycles,
    allSignalsGreen,
    materializedTrafficCapture,
    onMaterializedTrafficComplete: evidenceRequest
      ? (artifact) => onEvidenceComplete(evidenceRequest.key, artifact)
      : undefined,
  });
  const resumeWhenSumoIsReady = useRef(false);
  useEffect(() => {
    if (playbackState?.playing && status.phase === "loading") {
      resumeWhenSumoIsReady.current = true;
      playback.controller?.pause();
      return;
    }
    if (
      resumeWhenSumoIsReady.current &&
      !playbackState?.playing &&
      (status.phase === "ready" || status.phase === "running")
    ) {
      resumeWhenSumoIsReady.current = false;
      playback.controller?.play();
    }
    if (status.phase === "fallback") resumeWhenSumoIsReady.current = false;
  }, [playback.controller, playbackState?.playing, status.phase]);
  const { setSumoStatus } = playback;
  const sumoOwnsSignalStates = sumoOwnsPhysicalSignalStates(
    provider,
    status.phase === "fallback",
    hasAuthoredMapSignals,
    false,
  );
  useEffect(() => {
    if (!sumoOwnsSignalStates || !status.signalStates) return;
    playback.overlays?.setSignalStates(status.signalStates);
  }, [playback.overlays, status.signalStates, sumoOwnsSignalStates]);
  useEffect(() => {
    if (!sumoOwnsSignalStates) return;
    return () => {
      playback.overlays?.clearSignalStates();
      playback.controller?.refreshSignalPresentation();
    };
  }, [playback.controller, playback.overlays, sumoOwnsSignalStates]);
  useEffect(() => {
    setSumoStatus(status);
  }, [setSumoStatus, status]);
  useEffect(() => () => setSumoStatus({ phase: "disabled", actorCount: 0 }), [setSumoStatus]);
  const startedEvidenceKey = useRef<string | null>(null);
  useEffect(() => {
    if (!evidenceRequest || provider !== "sumo") {
      startedEvidenceKey.current = null;
      return;
    }
    if (!map.sumoNetworkSha256) {
      onEvidenceFailure(evidenceRequest.key, new Error("This map has no immutable SUMO network for revision evidence."));
      return;
    }
    if (!playback.controller || (status.phase !== "ready" && status.phase !== "running")) return;
    if (startedEvidenceKey.current === evidenceRequest.key) return;
    startedEvidenceKey.current = evidenceRequest.key;
    playback.controller.pause();
    playback.controller.seek(bundle.startTime);
    playback.setInspecting(true);
    playback.controller.play();
  }, [bundle.startTime, evidenceRequest, map.sumoNetworkSha256, onEvidenceFailure, playback, provider, status.phase]);
  return null;
}
