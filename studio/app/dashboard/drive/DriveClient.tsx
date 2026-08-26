"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Camera, LayoutGrid, LogIn, LogOut, RotateCcw, Video } from "lucide-react";
import type {
  EditorController,
  EditorDocument,
  EditorState,
  ScenarioMapEntry,
} from "@simforge/editor";
import type { CityViewerOptions } from "@simforge/viewer";
import { CityViewer } from "@simforge/viewer";
import { CityView } from "@simforge/viewer/react";
import { toast } from "sonner";
import { contentHash } from "@simforge/engine";

import { TopBarActionsPortal, TopBarTrailingPortal } from "@/app/components/TopBarSlot";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import { AUTHORING_QUALITY, defaultAuthoringQuality } from "@/app/dashboard/scenario/editor/authoring-quality";
import { EditorConfigurationBlockProvider } from "@/app/dashboard/scenario/editor/inspector/EditorDetailsPanel";
import { EditorOverlayHost } from "@/app/dashboard/scenario/editor/inspector/EditorOverlayHost";
import {
  EditorOverlayProvider,
  useEditorOverlay,
} from "@/app/dashboard/scenario/editor/inspector/editor-overlay-selection";
import { ActorLibraryRail } from "@/app/dashboard/scenario/editor/regions/ActorLibraryRail";
import type { ViewportTool } from "@/app/dashboard/scenario/editor/regions/actor-catalog";
import { EditorHeader } from "@/app/dashboard/scenario/editor/regions/EditorHeader";
import { EditorModeBanner } from "@/app/dashboard/scenario/editor/regions/EditorModeBanner";
import { PlacementCursorHint } from "@/app/dashboard/scenario/editor/regions/PlacementCursorHint";
import { ScenarioTimelineDock } from "@/app/dashboard/scenario/editor/ScenarioTimelineDock";
import {
  timelineActorLabels,
  type V1TimelineBrowserPlayback,
} from "@/app/dashboard/scenario/editor/timeline/V1TimelineRail";
import { ScenarioEditorReadout, ScenarioEditorShell } from "@/app/dashboard/scenario/editor/shell";
import { createMultiplexedCameraFeeds, type CameraFeeds } from "@/app/lib/live-world/camera-feeds";
import {
  createAuthoredWorldSource,
  type AuthoredWorldSource,
} from "@/app/lib/live-world/authored-world-source";
import { createRemoteWorldSource } from "@/app/lib/live-world/remote-world-source";
import { createTruthViewerBridge, type TruthViewerBridge } from "@/app/lib/live-world/truth-viewer-bridge";
import type { WorldSource, WorldSourceStatus } from "@/app/lib/live-world/types";
import { useWorldSource } from "@/app/lib/live-world/use-world-source";
import type { ScenarioAuthoringQuality } from "@/app/lib/scenario/contracts";
import { listScenarioMaps } from "@/app/lib/scenario/editor/api";
import { useEditorRuntime } from "@/app/lib/scenario/editor/use-editor-runtime";
import { EditorSceneEnvironmentBridge } from "@/app/dashboard/scenario/editor/EditorSceneEnvironmentBridge";
import { PoleCameraGrid } from "./cameras/PoleCameraGrid";
import { usePoleCameras } from "./pole-cameras";
import { actorSpeedKph, formatClipTime } from "./drive-telemetry";

type DriveView = "world" | "cameras";
type FollowMode = "chase" | "dash";

const CONTROLLED_KEY_CODES: Record<string, true> = {
  ArrowUp: true,
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
  KeyW: true,
  KeyA: true,
  KeyS: true,
  KeyD: true,
  KeyR: true,
  Space: true,
};

export function DriveClient() {
  const [map, setMap] = useState<ScenarioMapEntry | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(window.location.search);
    const manifestOverride = params.get("manifest") ?? process.env.NEXT_PUBLIC_DRIVE_MAP_MANIFEST_URL ?? null;
    const lanesOverride = params.get("lanes") ?? process.env.NEXT_PUBLIC_DRIVE_MAP_LANES_URL ?? null;
    if (manifestOverride) {
      try {
        setMap(directMapEntry({
          manifestUrl: manifestOverride,
          topologyUrl: lanesOverride,
          label: params.get("label") ?? "Direct bundle",
        }));
        setMapError(null);
      } catch (error) {
        const message = errorMessage(error);
        setMapError(message);
        toast.error("Drive could not use the direct map bundle", { description: message });
      }
      return () => controller.abort();
    }
    void listScenarioMaps(controller.signal)
      .then((maps) => {
        if (maps.length === 0) throw new Error("No published maps are available for Drive");
        setMap(maps.find((candidate) => /richmond/i.test(candidate.label)) ?? maps[0]!);
        setMapError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = errorMessage(error);
        setMapError(message);
        toast.error("Drive could not load the map catalog", { description: message });
      });
    return () => controller.abort();
  }, []);

  if (!map) {
    return (
      <div className="grid h-full min-h-0 place-items-center bg-background text-sm text-muted-foreground" role={mapError ? "alert" : "status"}>
        {mapError ?? "Loading Drive map…"}
      </div>
    );
  }
  return <DriveSurface map={map} />;
}

function DriveSurface({ map }: { map: ScenarioMapEntry }) {
  const [source, setSource] = useState<WorldSource | null>(null);
  const [authoredSource, setAuthoredSource] = useState<AuthoredWorldSource | null>(null);
  const [sourceCreationError, setSourceCreationError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<CityViewer | null>(null);
  const [bridge, setBridge] = useState<TruthViewerBridge | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [quality, setQuality] = useState<ScenarioAuthoringQuality>("high");
  const [view, setView] = useState<DriveView>("world");
  const [cameraFeeds, setCameraFeeds] = useState<CameraFeeds | null>(null);
  const [clock, setClock] = useState<{ mode: "live" | "replay"; timeIso: string | null; speed: number } | null>(null);
  const [followMode, setFollowMode] = useState<FollowMode>("chase");
  const [egoActorId, setEgoActorId] = useState<string | null>(null);
  const [egoActorLabel, setEgoActorLabel] = useState<string | null>(null);
  const [cameraNotice, setCameraNotice] = useState<string | null>(null);
  const [driving, setDriving] = useState(false);
  const [enteringDrive, setEnteringDrive] = useState(false);
  const [expandedTool, setExpandedTool] = useState<ViewportTool | null>(null);
  const [transportRevision, setTransportRevision] = useState(0);
  const [documentRevision, setDocumentRevision] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const preparedDocumentHashRef = useRef<string | null>(null);
  const remoteWorld = useMemo(() => resolveRemoteWorld(), []);
  const world = useWorldSource(source);
  const transport = authoredSource?.transport ?? null;
  const poleCameras = usePoleCameras(map.browserManifestUrl);
  const onDocumentChange = useCallback((document: EditorDocument) => {
    const nextHash = contentHash(document.data);
    if (preparedDocumentHashRef.current === nextHash) return;
    preparedDocumentHashRef.current = nextHash;
    setDocumentRevision((revision) => revision + 1);
  }, []);

  useEffect(() => setQuality(defaultAuthoringQuality()), []);


  const runtime = useEditorRuntime({
    record: null,
    map,
    viewer,
    runtimeReady: mapLoaded,
    hostRef,
    onDocumentChange,
  });
  const { controller, editorDocument, state } = runtime;
  const selectedActor = state?.actors.find((actor) => state.selection.includes(actor.id)) ?? null;
  const selectedVehicleRole = selectedActor
    ? editorDocument?.data.roles.find((role) => role.id === selectedActor.id && isVehicleRole(role)) ?? null
    : null;
  const availableEgoActorId = authoredSource?.selectEgo(selectedVehicleRole?.id) ?? null;


  useEffect(() => {
    if (!remoteWorld && !editorDocument) return;
    let disposed = false;
    let live: WorldSource | null = null;
    preparedDocumentHashRef.current = editorDocument ? contentHash(editorDocument.data) : null;
    setSourceCreationError(null);
    setSource(null);
    setAuthoredSource(null);
    const open = async () => remoteWorld
      ? createRemoteWorldSource({ truthUrl: `${remoteWorld}/twin`, commandUrl: `${remoteWorld}/drive` })
      : createAuthoredWorldSource({ document: editorDocument!, map, tickHz: 20 });
    void open()
      .then((nextSource) => {
        if (disposed) return nextSource.close();
        live = nextSource;
        setSource(nextSource);
        setAuthoredSource(remoteWorld ? null : nextSource as AuthoredWorldSource);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const message = errorMessage(error);
        setSourceCreationError(message);
        toast.error("Drive world could not start", { description: message });
      });
    return () => {
      disposed = true;
      setSource(null);
      setAuthoredSource(null);
      live?.close();
    };
  }, [documentRevision, editorDocument, map, remoteWorld]);

  useEffect(() => {
    if (!authoredSource) return;
    setTransportRevision((revision) => revision + 1);
    return authoredSource.subscribeTransport(() => setTransportRevision((revision) => revision + 1));
  }, [authoredSource]);

  useEffect(() => {
    if (!source?.subscribeWarnings) return;
    return source.subscribeWarnings((message) => {
      toast.warning("Drive world notice", { description: message, duration: 12000 });
    });
  }, [source]);

  useEffect(() => {
    if (!source?.subscribeClock) {
      setClock(null);
      return;
    }
    return source.subscribeClock(setClock);
  }, [source]);

  useEffect(() => {
    if (!remoteWorld) {
      setCameraFeeds(null);
      return;
    }
    const feeds = createMultiplexedCameraFeeds({ url: `${remoteWorld}/camera-feeds` });
    setCameraFeeds(feeds);
    return () => {
      setCameraFeeds(null);
      feeds.close();
    };
  }, [remoteWorld]);

  useEffect(() => {
    if (!bridge || !source) return;
    return source.subscribeFrames((frame) => bridge.apply(frame));
  }, [bridge, source]);
  useEffect(() => {
    if (!bridge) return;
    bridge.setFollow(driving && !transport?.completed ? egoActorId : null, followMode);
  }, [bridge, driving, egoActorId, followMode, transport, transportRevision]);
  useEffect(() => () => bridge?.dispose(), [bridge]);

  useDriveControls(source, driving ? egoActorId : null);

  const onViewerReady = useCallback((readyViewer: CityViewer) => {
    setViewer(readyViewer);
    setBridge(createTruthViewerBridge(readyViewer, { layer: "drive-live", groundLift: true }));
    setViewerError(null);
  }, []);

  useEffect(() => {
    if (!driving || !authoredSource || !egoActorId) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => authoredSource.transport.play());
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [authoredSource, driving, egoActorId]);

  const selectActor = useCallback((actorId: string | null) => {
    setExpandedTool(null);
    controller?.setSelection(actorId ? [actorId] : []);
  }, [controller]);
  const selectLibraryTool = useCallback((tool: ViewportTool | null) => {
    setExpandedTool(tool);
    if (tool) controller?.setSelection([]);
  }, [controller]);

  const enterDrive = useCallback(() => {
    if (!authoredSource || !viewer || !editorDocument || enteringDrive) return;
    setEnteringDrive(true);
    try {
      const selectedRole = selectedVehicleRole;
      const actorId = availableEgoActorId;
      if (!actorId) throw new Error("Place an authored vehicle before entering drive");
      authoredSource.setEgo(actorId);
      setEgoActorId(actorId);
      const roleId = authoredSource.roleIdForActor(actorId);
      const role = editorDocument.data.roles.find((candidate) => candidate.id === roleId)
        ?? (selectedRole && isVehicleRole(selectedRole) ? selectedRole : null)
        ?? editorDocument.data.roles.find(isVehicleRole)
        ?? null;
      const timelineLabel = role
        ? timelineActorLabels(editorDocument.data.roles).get(role.id)
        : null;
      setEgoActorLabel(timelineLabel ?? role?.label ?? actorId);
      bridge?.setFollow(actorId, followMode);
      setExpandedTool(null);
      setDriving(true);
    } catch (error) {
      toast.error("Drive mode could not start", { description: errorMessage(error) });
    } finally {
      setEnteringDrive(false);
    }
  }, [
    authoredSource,
    availableEgoActorId,
    bridge,
    editorDocument,
    enteringDrive,
    followMode,
    selectedVehicleRole,
    viewer,
  ]);

  const exitDrive = useCallback(() => {
    bridge?.setFollow(null);
    if (source && egoActorId) {
      source.control({ actorId: egoActorId, steer: 0, throttle: 0, brake: 0 });
    }
    authoredSource?.setEgo(null);
    setDriving(false);
    setEgoActorId(null);
    setEgoActorLabel(null);
    setCameraNotice(null);
  }, [authoredSource, bridge, egoActorId, source]);
  const switchView = useCallback((next: DriveView) => {
    if (next === "cameras" && driving) exitDrive();
    setView(next);
  }, [driving, exitDrive]);


  const driveSpeedKph = actorSpeedKph(world.latestFrame, driving ? egoActorId : null);
  const driveClipTime = transport ? formatClipTime(transport.time, transport.duration) : null;
  useEffect(() => {
    if (!driving || !bridge || !egoActorId || !world.latestFrame || transport?.completed) return;
    const followedActorIsPresent = world.latestFrame.scene.actors.some(
      (actor) => actor.id === egoActorId && actor.kind !== "despawn",
    );
    if (followedActorIsPresent || cameraNotice) return;
    bridge.setFollow(null);
    setCameraNotice(`Driving view released because ${egoActorLabel ?? "the ego vehicle"} is unavailable.`);
  }, [
    bridge,
    cameraNotice,
    driving,
    egoActorId,
    egoActorLabel,
    transport?.completed,
    world.latestFrame,
  ]);
  const timelinePlayback = useMemo<V1TimelineBrowserPlayback | null>(() => {
    if (!transport) return null;
    return {
      sessionId: transport.sessionId,
      playing: transport.playing,
      inspecting: transport.inspecting || transport.playing || driving,
      time: transport.time,
      onPlay: () => transport.play(),
      onStop: () => transport.stop(),
      onReset: () => transport.reset(),
      onPlayPause: () => transport.playPause(),
      onSeek: (seconds) => transport.seek(seconds),
      onExitInspection: () => transport.exitInspection(),
    };
  }, [driving, transport, transportRevision]);

  const effectiveStatus: WorldSourceStatus = sourceCreationError || runtime.error
    ? "error"
    : world.status;
  const effectiveError = sourceCreationError ?? runtime.error ?? world.error;
  const driveUnavailableReason = authoredSource && !availableEgoActorId
    ? "Place an authored vehicle and wait for it to finish preparing before entering drive."
    : null;

  return (
    <EditorConfigurationBlockProvider blocked={driving}>
      <EditorOverlayProvider
        documentKey={editorDocument}
        selectedActorId={selectedActor?.id ?? null}
        suppressActorDetails={driving || state?.mode === "drawingRoute"}
        onSelectActor={selectActor}
      >
        <EditorHeader
          document={editorDocument}
          quality={quality}
          onQualityChange={setQuality}
          viewer={viewer}
          experience="advanced"
        />
        <TopBarActionsPortal>
          <div className="flex items-center gap-1" aria-label="Drive view">
            <Button type="button" size="sm" variant={view === "world" ? "secondary" : "ghost"} onClick={() => switchView("world")} aria-pressed={view === "world"}>
              <LayoutGrid /> World
            </Button>
            <Button type="button" size="sm" variant={view === "cameras" ? "secondary" : "ghost"} onClick={() => switchView("cameras")} aria-pressed={view === "cameras"}>
              <Video /> Cameras
            </Button>
          </div>
        </TopBarActionsPortal>
        <TopBarTrailingPortal>
          {view === "world" ? (
            <div className="flex items-center gap-1">
              {driving ? (
                <>
                  <Button type="button" size="sm" variant="outline" onClick={() => setFollowMode((mode) => mode === "chase" ? "dash" : "chase")}>
                    <Camera /> {followMode === "chase" ? "Chase" : "Dash"}
                  </Button>
                  <Button type="button" size="sm" variant="secondary" onClick={exitDrive}>
                    <LogOut /> Exit drive
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={!authoredSource || !viewer || world.status !== "running" || !availableEgoActorId || enteringDrive}
                  title={driveUnavailableReason ?? undefined}
                  onClick={enterDrive}
                >
                  <LogIn /> {enteringDrive ? "Entering…" : "Enter drive"}
                </Button>
              )}
            </div>
          ) : null}
        </TopBarTrailingPortal>
        {/* The authored document owns weather and time of day. Drive previously
            applied its own fixed-daylight environment here, which silently
            overwrote every change made in the Weather panel: the document
            updated, then the override repainted the scene. */}
        <EditorSceneEnvironmentBridge
          active={mapLoaded}
          document={editorDocument}
          quality={quality}
          viewer={viewer}
        />
        <ScenarioEditorShell
          className="h-full min-h-0 bg-background text-foreground"
          data-testid="drive-surface"
          canvasMode="interactive"
          header={null}
          leftSidebar={view === "world" && !driving ? (slotProps) => (
            <div {...slotProps} className={cn(slotProps.className, "flex h-full")}>
              <ActorLibraryRail
                controller={controller}
                state={state}
                hostRef={hostRef}
                canvas={viewer?.renderer.domElement ?? null}
                activeTool={expandedTool}
                onExpandedToolChange={selectLibraryTool}
                document={editorDocument}
                sumoAvailable={Boolean(map.sumoNetworkSha256)}
              />
            </div>
          ) : null}
          canvas={(slotProps) => (
            <div {...slotProps} className={cn(slotProps.className, "relative bg-background")}>
              <div ref={hostRef} className={cn("absolute inset-0", view === "world" ? "visible" : "invisible pointer-events-none")}>
                {map ? (
                  <CityView
                    key={quality}
                    manifestUrl={map.browserManifestUrl}
                    options={viewerOptions(quality)}
                    onReady={onViewerReady}
                    onMapLoaded={() => {
                      setMapLoaded(true);
                      setViewerError(null);
                    }}
                    onError={(reason) => {
                      const message = errorMessage(reason);
                      setMapLoaded(false);
                      setViewerError(message);
                      toast.error("Drive map could not load", { description: message });
                    }}
                    className="h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    ariaLabel={`${map.label} authored driving scenario`}
                    role="application"
                    tabIndex={0}
                  />
                ) : null}
              </div>
              {view === "cameras" ? (
                <div className="absolute inset-0 overflow-auto bg-background p-4">
                  <PoleCameraGrid rigs={poleCameras.rigs} features={poleCameras.features} feeds={cameraFeeds} viewer={viewer} />
                </div>
              ) : null}
            </div>
          )}
          statusOverlay={(slotProps) => (
            <div {...slotProps}>
              {view === "world" && state?.mode === "placing" ? (
                <PlacementCursorHint state={state} hostRef={hostRef} canvas={viewer?.renderer.domElement ?? null} />
              ) : view === "world" && state?.mode && state.mode !== "idle" ? (
                <div className="pointer-events-auto"><EditorModeBanner state={state} controller={controller} /></div>
              ) : null}
              {view === "world" && driving && driveClipTime ? (
                <ScenarioEditorReadout
                  className="absolute left-4 top-4 flex items-baseline gap-3"
                  role="status"
                  aria-label={`Driving ${egoActorLabel ?? "vehicle"}, speed ${driveSpeedKph.toFixed(1)} kilometers per hour, clip time ${driveClipTime}${transport?.playing ? "" : ", paused"}`}
                >
                  <span className="text-editor-text">{egoActorLabel ? `Driving ${egoActorLabel}` : "Driving"}</span>
                  <span className="text-editor-text tabular-nums">{driveSpeedKph.toFixed(1)} km/h</span>
                  <span className="tabular-nums">{driveClipTime}</span>
                  {!transport?.playing && !transport?.completed ? <span>Paused</span> : null}
                </ScenarioEditorReadout>
              ) : null}
              {view === "world" && cameraNotice ? (
                <ScenarioEditorReadout className="absolute left-4 top-14" role="status">
                  <span className="text-editor-text">{cameraNotice}</span>
                </ScenarioEditorReadout>
              ) : null}
              {view === "world" && transport?.completed ? (
                <ScenarioEditorReadout className="pointer-events-auto absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-3" role="status">
                  <span className="text-editor-text">Scenario complete · {formatClipTime(transport.time, transport.duration)} · Free camera restored</span>
                  <Button type="button" size="sm" variant="secondary" onClick={() => transport.play()}>
                    <RotateCcw /> Replay
                  </Button>
                </ScenarioEditorReadout>
              ) : effectiveStatus !== "running" || viewerError || driveUnavailableReason ? (
                <div className="absolute left-1/2 top-4 -translate-x-1/2" role={effectiveStatus === "error" || viewerError ? "alert" : "status"}>
                  <div className={cn("rounded-md border bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur", effectiveStatus === "error" || viewerError ? "border-destructive/50 text-destructive" : "border-border text-muted-foreground")}>
                    <WorldStatus status={effectiveStatus} error={effectiveError ?? viewerError ?? driveUnavailableReason} mapLoaded={mapLoaded} />
                  </div>
                </div>
              ) : null}
            </div>
          )}
          floatingOverlay={view === "world" && editorDocument ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-auto max-h-[min(65vh,520px)] justify-center px-4" data-testid="floating-timeline-layer">
              <div className="pointer-events-auto relative h-auto max-h-[min(65vh,520px)] w-full max-w-[920px] min-w-0">
                <DriveTimelineDock
                  controller={controller}
                  document={editorDocument}
                  state={state}
                  playback={timelinePlayback}
                  readOnly={driving}
                />
              </div>
            </div>
          ) : null}
        />
        <EditorOverlayHost controller={controller} document={editorDocument} showActorMotionControls />
      </EditorOverlayProvider>
    </EditorConfigurationBlockProvider>
  );
}

function DriveTimelineDock({ controller, document, state, playback, readOnly }: {
  controller: EditorController | null;
  document: EditorDocument;
  state: EditorState | null;
  playback: V1TimelineBrowserPlayback | null;
  readOnly: boolean;
}) {
  const { selection, actions } = useEditorOverlay();
  return (
    <ScenarioTimelineDock
      document={document}
      state={state ?? undefined}
      playback={playback}
      selectedInteractionId={selection.kind === "interaction" ? selection.interactionId : null}
      onFocusActor={actions.selectActor}
      onSelectActor={actions.selectActor}
      onSelectInteraction={actions.selectInteraction}
      onClearSelection={actions.clear}
      readOnly={readOnly}
      experience="advanced"
    />
  );
}

function WorldStatus({ status, error, mapLoaded }: { status: WorldSourceStatus; error: string | null; mapLoaded: boolean }) {
  if (error) return <>{error}</>;
  if (status === "running") return <>{mapLoaded ? "World running" : "World running · loading map"}</>;
  if (status === "connecting") return <>Connecting authored world…</>;
  if (status === "closed") return <>World closed</>;
  return <>Preparing authored world…</>;
}

const TWIN_DEFAULT_PORT = "8765";
function resolveRemoteWorld(): string | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("twin")
    ?? process.env.NEXT_PUBLIC_DRIVE_TWIN_URL
    ?? null;
  if (!raw) return null;
  if (/^wss?:\/\//.test(raw)) return raw.replace(/\/+$/, "");
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const port = raw === "1" || raw === "true" ? TWIN_DEFAULT_PORT : raw;
  return `${scheme}://${window.location.hostname}:${port}`;
}

function directMapEntry({ manifestUrl, topologyUrl, label }: { manifestUrl: string; topologyUrl: string | null; label: string }): ScenarioMapEntry {
  const suffix = "/3d/manifest.json";
  if (!manifestUrl.endsWith(suffix)) throw new Error(`Direct manifest must end in ${suffix}`);
  const root = manifestUrl.slice(0, -suffix.length);
  const id = `direct:${manifestUrl}`;
  const emptyDigest = "0".repeat(64);
  return {
    id,
    versionId: id,
    mapVersionId: id,
    sourceMapId: id,
    label,
    locality: "",
    browserAssetRootUrl: root,
    browserManifestUrl: manifestUrl,
    browserClosureSha256: emptyDigest,
    artifacts: {
      xodrSha256: emptyDigest,
      topologySha256: emptyDigest,
      derivedTopologySha256: emptyDigest,
      locationsSha256: emptyDigest,
      signalsSha256: emptyDigest,
      lanePolygonsSha256: emptyDigest,
    },
    sumoNetworkSha256: null,
    manifestUrl,
    topologyUrl: topologyUrl ?? `${root}/topology-index.json.gz`,
  };
}


type ScenarioRole = EditorDocument["data"]["roles"][number];
function isVehicleRole(role: ScenarioRole): boolean {
  return !role.actor.static && role.actor.class !== "pedestrian" && role.actor.class !== "static_object";
}

function viewerOptions(quality: ScenarioAuthoringQuality): CityViewerOptions {
  const preset = AUTHORING_QUALITY[quality];
  return {
    maxPixelRatio: preset.maxPixelRatio,
    antialias: preset.antialias,
    cinematicLighting: preset.cinematicLighting,
  };
}

function useDriveControls(source: WorldSource | null, actorId: string | null) {
  useEffect(() => {
    if (!source || !actorId) return;
    const pressed = new Set<string>();
    const editableTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      return element?.isContentEditable || element?.tagName === "INPUT" || element?.tagName === "TEXTAREA";
    };
    const keyDown = (event: KeyboardEvent) => {
      if (!CONTROLLED_KEY_CODES[event.code] || editableTarget(event.target)) return;
      event.preventDefault();
      pressed.add(event.code);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (!CONTROLLED_KEY_CODES[event.code]) return;
      event.preventDefault();
      pressed.delete(event.code);
    };
    const transmit = () => {
      const throttle = pressed.has("KeyW") || pressed.has("ArrowUp") ? 1 : 0;
      const brake = pressed.has("Space") || pressed.has("KeyS") || pressed.has("ArrowDown") ? 1 : 0;
      const steerLeft = pressed.has("KeyA") || pressed.has("ArrowLeft");
      const steerRight = pressed.has("KeyD") || pressed.has("ArrowRight");
      source.control({
        actorId,
        throttle,
        brake,
        steer: steerLeft === steerRight ? 0 : steerLeft ? -1 : 1,
        reverse: pressed.has("KeyR"),
      });
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    const interval = window.setInterval(transmit, 50);
    transmit();
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.clearInterval(interval);
    };
  }, [actorId, source]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
