import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Raycaster, Vector2 } from 'three';
import { CityView } from '@uniscenarios/city-renderer/react';
import type { BenchResult, CityViewer, CityViewerOptions } from '@uniscenarios/city-renderer';
import { SettingsPanel } from './LayerPanel';
import { loadMapOverlays, type MapOverlayHandle } from './mapOverlays';
import { MAPS, initialMapId, mapById, rememberMapId, type MapEntry } from './maps';
import { useEditor } from './editor/useEditor';
import type { EditorController } from './editor/controller';
import { MapPicker } from './editor/ui';
import { WorkspaceHeader } from './editor/EditorChrome';
import { EditorToolRail, shouldShowEditorToolRail, type CatalogPlacementAdapter, type ViewportTool } from './editor/EditorToolRail';
import { EditorExperienceChooser, type EditorExperience } from '@uniscenarios/editor-ui';
import { WorkspaceShell } from './workspace/WorkspaceShell';
import { WorkspaceTimelineDock, signalLanesFromPlans } from './workspace/TimelineDock';
import { RailHost } from './workspace/RailHost';
import { InspectorHost } from './workspace/InspectorHost';
import { actorRecordForRole } from './workspace/ActorDetails';
import { PlaybackPanel } from './playback/PlaybackPanel';
import type { PlaybackCameraOption } from './playback/PlaybackPanel';
import { PlaybackLoadError, canonicalPreviewIdentity, evaluatePlaybackSignalHeadStates, samplePlaybackActors, type PlaybackBundle } from '@uniscenarios/playback';
import { galleryCameraChoice } from '@uniscenarios/playback';
import {
  physicsForActor,
  physicsSummaryForAuthoredActors,
  physicsSummaryForTrace,
  type ActorPhysicsDisplay,
} from '@uniscenarios/playback';
import { usePlayback } from './playback/usePlayback';
import { useStudioSession } from './session/useStudioSession';
import { throwIfPreparationAborted } from './session/preparationGate';
import { defaultSpeedKph } from './timeline/actions';
import { evaluateAuthoredAmbientRobustness, ScenarioWorkerClient, type LivePlaybackRun } from './playback/scenarioWorkerClient';
import type { AmbientRobustnessSummary } from './playback/scenario-worker';
import { CameraPanel, EMPTY_CAMERA_PRESENTATION, useCameras, type CameraPresentation } from './cameras';
import {
  inspectQualityPreference,
  loadQualityPreference,
  selectAndSaveQualityPreset,
  shouldDeferWorldLoading,
  type QualityPreference,
  type QualityPresetId,
} from './performance/quality';
import { FirstRunGraphicsChooser } from './performance/FirstRunGraphicsChooser';
import { VariationsPanel } from './variations';
import {
  ACCELERATED_SIGNAL_CYCLES_EXTENSION_KEY,
  AMBIENT_TRAFFIC_EXTENSION_KEY,
  ambientSignalCycleSettingsFromExtensions,
  ambientTrafficProfileFromExtensions,
  canReuseVerifiedEvidenceForAmbient,
  defaultAmbientTrafficProfile,
} from './ambient/model';
import { AmbientTrafficPopover } from './ambient/AmbientTrafficPanel';
import {
  AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY,
  ambientTrafficProviderFromExtensions,
  sumoOwnsPhysicalSignalStates,
  type AmbientTrafficProviderId,
} from './ambient/provider';
import { useSumoTraffic, type SumoExternalActorView } from './ambient/useSumoTraffic';
import { useAmbientTrafficPreview } from './ambient/useAmbientTrafficPreview';
import {
  ambientCandidatePoolRequestKey,
  ambientPreviewKey,
  AmbientPreviewCache,
  previewForRevision,
  type RevisionOwnedPreview,
} from './ambient/candidatePool';
import type { ResolvedAmbientTrafficProfile } from '@uniscenarios/sim-engine';
import { contentHash, resolveAmbientTrafficProfile } from '@uniscenarios/sim-engine';
import {
  dashCameras,
  defaultDashCamera,
  supportsDashCamera,
  type DashCameraSensor,
  type RoleBinding,
  type ScenarioTemplateV2,
} from '@uniscenarios/scenario-model';
import {
  CampaignDrawer,
  canApplyCampaignOpen,
  isCampaignReady,
  loadVerifiedCampaignEntry,
  type CampaignEvidenceRequest,
  type CampaignOpenRequest,
} from './campaign';
import { GENERATED_CAMPAIGN_ENTRIES } from './campaign/generated';
import { sameRoleIdentity, simulationSourceHash } from './campaign/recovery';
import { VerifiedReplayBar, verifiedReplayKeyboardAction } from './campaign/VerifiedReplayBar';
import {
  cloneDefaults,
  loadStudioViewSettings,
  saveStudioViewSettings,
  type StudioViewSettings,
} from './settings/model';
import { OpenScenarioWorkspace } from './openscenario/OpenScenarioWorkspace';
import type { OpenScenarioWorkspaceState } from './openscenario/model';
import { openScenarioLocationIntent } from './openscenario/navigation';
import { MapWorkspace } from './map-workspace';
import { copyScenarioDiagnosticText, createScenarioDiagnostic } from './diagnostics/scenarioDiagnostic';
import { compiledWorldMatchesRevision, simulationClassFor, type ActorRecord } from './editor/document';
import {
  authoringRoutes,
  routeExecutionParity,
  routesFromSimulation,
  VehicleRouteOverlayRenderer,
} from './editor/routeOverlay';
import { StudioSignalSelectionModel } from './signalSelection';
import type { SignalReferenceSelection } from '@uniscenarios/scenario-materializer';
import { WorldLoadingOverlay } from './WorldLoadingOverlay';
import { GenerationsWorkspace, ScenarioCopilotPanel, draftCompatibility, hasMaterialAuthoredContent, parseSavedGenerationDraft, type CandidateValidation, type CopilotCandidate, type CopilotGenerationHistoryEntry } from './copilot';
import { groundEditableActors } from './copilot/grounding';

/** Dev knobs: ?debugShadow=1&sse=300&budgetMB=1500&exposure=1.1&assetVariant=original&map=yale-street */
function optionsFromUrl(quality: QualityPreference): CityViewerOptions {
  const params = new URLSearchParams(window.location.search);
  const num = (key: string): number | undefined => {
    const raw = params.get(key);
    return raw === null || raw === '' ? undefined : Number(raw);
  };
  const budgetMB = num('budgetMB');
  const requestedVariant = params.get('assetVariant');
  const assetVariant = requestedVariant === 'original' || requestedVariant === 'geometry-only' || requestedVariant === 'ktx2'
    ? requestedVariant
    : 'auto';
  return {
    ...quality.live,
    antialias: quality.recreate.antialias,
    debugShadowProjection: params.get('debugShadow') === '1',
    maxScreenSpaceError: num('sse') ?? quality.live.maxScreenSpaceError,
    exposure: num('exposure') ?? quality.live.exposure,
    sunIntensity: num('sun'),
    byteBudget: budgetMB === undefined ? quality.live.byteBudget : budgetMB * 1024 * 1024,
    maxPixelRatio: num('dpr') ?? quality.live.maxPixelRatio,
    assetVariant,
    ultraLowFidelity: quality.runtime.ultraLow3d,
    roadsOnlyFidelity: quality.runtime.roadsOnly,
  };
}

const EDITOR_EXPERIENCE_STORAGE_KEY = 'uniscenarios.studio.editor-experience.v1';

function loadEditorExperience(): EditorExperience | null {
  try {
    const raw = window.localStorage.getItem(EDITOR_EXPERIENCE_STORAGE_KEY);
    return raw === 'simple' || raw === 'advanced' ? raw : null;
  } catch {
    return null;
  }
}

function saveEditorExperience(experience: EditorExperience): void {
  try {
    window.localStorage.setItem(EDITOR_EXPERIENCE_STORAGE_KEY, experience);
  } catch {
    // Storage can be unavailable in hardened browsers; the choice stays session-local.
  }
}

declare global {
  interface Window {
    __viewer?: CityViewer;
    __bench?: (durationMs?: number) => Promise<BenchResult>;
    /** Map overlays, once they have loaded. Used by the verification harness. */
    __overlays?: MapOverlayHandle;
    /** Switch maps from the harness; resolves when the new map is on screen. */
    __setMap?: (mapId: string) => void;
    /** Which map is mounted right now. */
    __mapId?: string;
    /** Live-play instrumentation for browser performance and underrun checks. */
    __studioPlaybackMetrics?: () => {
      transport: ReturnType<NonNullable<ReturnType<typeof useStudioSession>['transportCounters']>>;
      worker: ReturnType<LivePlaybackRun['counters']> | null;
    };
  }
}

export function App(): JSX.Element {
  const initial = useRef<ReturnType<typeof inspectQualityPreference> | null>(null);
  if (!initial.current) initial.current = inspectQualityPreference();
  const [quality, setQuality] = useState<QualityPreference | null>(
    shouldDeferWorldLoading(initial.current.state) ? null : initial.current.preference,
  );

  const chooseQuality = useCallback((preset: Exclude<QualityPresetId, 'custom'>) => {
    setQuality(selectAndSaveQualityPreset(preset));
  }, []);

  if (!quality) return <FirstRunGraphicsChooser onChoose={chooseQuality} />;
  return <StudioApp initialQuality={quality} />;
}

function StudioApp({ initialQuality }: { initialQuality: QualityPreference }): JSX.Element {
  const [mapId, setMapId] = useState(initialMapId);
  const map = mapById(mapId) ?? (MAPS[0] as MapEntry);

  /**
   * The viewer, tagged with the map it was built for.
   *
   * `CityView` is keyed on the map, so a switch unmounts it (disposing the old
   * viewer) and mounts a fresh one. Between those two moments the `viewer` state
   * still points at the disposed instance, and every effect downstream — overlay
   * load, ground index, editor — would happily attach to it. Tagging and
   * comparing makes `viewer` *derived* rather than a second source of truth: it
   * is `null` for exactly the duration of the swap, with no reset effect that
   * could race the child's `onReady`.
   */
  const [session, setSession] = useState<{ viewer: CityViewer; mapId: string } | null>(null);
  const [overlays, setOverlays] = useState<MapOverlayHandle | null>(null);
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [worldRenderError, setWorldRenderError] = useState<string | null>(null);
  const [benchRunning, setBenchRunning] = useState(false);
  const [playbackBundle, setPlaybackBundle] = useState<PlaybackBundle | null>(null);
  const [campaignPlaybackTitle, setCampaignPlaybackTitle] = useState<string | null>(null);
  const [campaignCameras, setCampaignCameras] = useState<CameraPresentation>(EMPTY_CAMERA_PRESENTATION);
  const [authoredPlayback, setAuthoredPlayback] = useState<PlaybackBundle | null>(null);
  const livePlayback = useRef<LivePlaybackRun | null>(null);
  const [campaignSource, setCampaignSource] = useState<{
    templateHash: string;
    evidence: PlaybackBundle;
  } | null>(null);
  const campaignRecovery = useRef('');
  const [pendingCampaignOpen, setPendingCampaignOpen] = useState<CampaignOpenRequest | null>(null);
  const [ambientTrafficProfile, setAmbientTrafficProfile] = useState<ResolvedAmbientTrafficProfile>(() => defaultAmbientTrafficProfile());
  const [ambientTrafficProvider, setAmbientTrafficProvider] = useState<AmbientTrafficProviderId>('sumo');
  const [acceleratedSignalCycles, setAcceleratedSignalCycles] = useState(false);
  const [sumoFallbackReason, setSumoFallbackReason] = useState<string | null>(null);
  const [ambientPreviewState, setAmbientPreviewState] = useState<RevisionOwnedPreview<PlaybackBundle> | null>(null);
  const [selectedDashCameraId, setSelectedDashCameraId] = useState<string | null>(null);
  const [cameraPlaybackRequested, setCameraPlaybackRequested] = useState(false);
  const [ambientPreviewBusy, setAmbientPreviewBusy] = useState(false);
  const [ambientTrafficError, setAmbientTrafficError] = useState<string | null>(null);
  const [ambientRobustnessReport, setAmbientRobustnessReport] = useState<AmbientRobustnessSummary | null>(null);
  const [ambientRobustnessBusy, setAmbientRobustnessBusy] = useState(false);
  const [leftPanelOpen, setLeftPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openScenarioOpen, setOpenScenarioOpen] = useState(() => openScenarioLocationIntent(window.location).open);
  const [mapWorkspaceOpen, setMapWorkspaceOpen] = useState(false);
  const [generationsOpen, setGenerationsOpen] = useState(() => window.location.hash === '#generations');
  const [experience, setExperience] = useState<EditorExperience | null>(loadEditorExperience);
  const [openScenarioState, setOpenScenarioState] = useState<OpenScenarioWorkspaceState>({ status: 'empty', reason: 'Place at least one actor before generating an interchange artifact.' });
  const [signalAuthoringCatalog, setSignalAuthoringCatalog] = useState<Awaited<ReturnType<ScenarioWorkerClient['inspectSignals']>> | null>(null);
  const [selectedSignalHeadId, setSelectedSignalHeadId] = useState<string | null>(null);
  const [selectedSignalReference, setSelectedSignalReference] = useState<SignalReferenceSelection | null>(null);
  const [viewSettings, setViewSettings] = useState<StudioViewSettings>(() => loadStudioViewSettings());
  const viewSettingsRef = useRef(viewSettings);
  viewSettingsRef.current = viewSettings;
  const runtimeWorker = useRef<ScenarioWorkerClient | null>(null);
  if (!runtimeWorker.current) runtimeWorker.current = new ScenarioWorkerClient();
  const ambientPreviewCache = useRef(new AmbientPreviewCache<PlaybackBundle>());
  const ambientPreparation = useRef<{ previewKey: string; revision: number; promise: Promise<PlaybackBundle> } | null>(null);
  const [auxiliaryTool, setAuxiliaryTool] = useState<Exclude<ViewportTool, 'select' | 'move' | 'rotate' | 'add'> | null>(null);
  const routeOverlayRenderer = useRef<VehicleRouteOverlayRenderer | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const overlaysRef = useRef<MapOverlayHandle | null>(null);
  overlaysRef.current = overlays;
  const optionsRef = useRef<CityViewerOptions>(optionsFromUrl(initialQuality));
  const pendingMapId = useRef(mapId);
  const hasNavigatedMaps = useRef(false);
  pendingMapId.current = mapId;

  const viewer = session && session.mapId === mapId ? session.viewer : null;

  useEffect(() => {
    const intent = openScenarioLocationIntent(window.location);
    if (!intent.open || intent.canonicalSearch === null) return;
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${intent.canonicalSearch}${intent.canonicalHash ?? window.location.hash}`,
    );
  }, []);

  useEffect(() => {
    const sync = (): void => setGenerationsOpen(window.location.hash === '#generations');
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => { window.removeEventListener('hashchange', sync); window.removeEventListener('popstate', sync); };
  }, []);

  const navigateGenerations = useCallback((open: boolean): void => {
    const next = open ? '#generations' : '';
    if (window.location.hash !== next) window.history.pushState(window.history.state, '', `${window.location.pathname}${window.location.search}${next}`);
    setGenerationsOpen(open);
    if (open) { setOpenScenarioOpen(false); setMapWorkspaceOpen(false); setAuxiliaryTool(null); setSettingsOpen(false); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSignalAuthoringCatalog(null);
    setSelectedSignalHeadId(null);
    setSelectedSignalReference(null);
    void runtimeWorker.current!.inspectSignals(map).then((catalog) => {
      if (!cancelled) setSignalAuthoringCatalog(catalog);
    }).catch((reason: unknown) => {
      if (!cancelled) console.warn('[signals] authoring catalog unavailable', reason);
    });
    return () => { cancelled = true; };
  }, [map]);

  const signalSelectionModel = useMemo(
    () => signalAuthoringCatalog
      ? new StudioSignalSelectionModel(signalAuthoringCatalog.signalControlIndex)
      : null,
    [signalAuthoringCatalog],
  );

  useEffect(() => {
    if (!signalSelectionModel) return;
    setSelectedSignalReference(signalSelectionModel.snapshot);
    return signalSelectionModel.subscribe(setSelectedSignalReference);
  }, [signalSelectionModel]);


  const onReady = useCallback((next: CityViewer) => {
    setWorldRenderError(null);
    setSession({ viewer: next, mapId: pendingMapId.current });
  }, []);

  const selectMap = useCallback(
    (next: MapEntry) => {
      if (next.id === pendingMapId.current) return;
      hasNavigatedMaps.current = true;
      rememberMapId(next.id);
      setOverlayError(null);
      setWorldRenderError(null);
      setMapId(next.id);
    },
    [],
  );

  useEffect(() => {
    window.__mapId = map.id;
    window.__setMap = (id: string) => {
      const entry = mapById(id);
      if (entry) selectMap(entry);
    };
    return () => {
      delete window.__setMap;
    };
  }, [map.id, selectMap]);

  useEffect(() => {
    if (!viewer) return;
    window.__viewer = viewer;
    window.__bench = (durationMs?: number) => {
      setBenchRunning(true);
      return viewer.runBenchmark(durationMs).finally(() => setBenchRunning(false));
    };
    return () => {
      delete window.__viewer;
      delete window.__bench;
    };
  }, [viewer]);

  // Map overlays load themselves once the map has settled; see ./mapOverlays.
  // Nothing here runs before the city is on screen.
  useEffect(() => {
    if (!viewer) return;
    const controller = new AbortController();
    let handle: MapOverlayHandle | null = null;
    loadMapOverlays(
      viewer,
      { xodr: map.xodr, manifest: map.manifest, lanePolygons: map.lanePolygons, signals: map.signals },
      {
        signal: controller.signal,
        initialVisibility: viewSettingsRef.current.overlays,
        initialSignalOrbs: {
          visible: viewSettingsRef.current.signalOrbs.visible,
          depthMode: viewSettingsRef.current.signalOrbs.xray ? 'xray' : 'scene',
        },
      },
    )
      .then((next) => {
        if (controller.signal.aborted) {
          next.dispose();
          return;
        }
        handle = next;
        window.__overlays = next;
        setOverlays(next);
        console.info('[overlays] ready', next.stats);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || (err as { name?: string } | null)?.name === 'AbortError') {
          return;
        }
        console.error('[overlays] failed', err);
        setOverlayError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      controller.abort();
      handle?.dispose();
      if (window.__overlays === handle) delete window.__overlays;
      setOverlays(null);
    };
  }, [viewer, map]);

  useEffect(() => {
    saveStudioViewSettings(viewSettings);
    if (viewer) {
      for (const [layer, visible] of Object.entries(viewSettings.layers)) {
        viewer.setLayerVisible(layer as keyof StudioViewSettings['layers'], visible);
      }
      viewer.setCameraControlPreferences(viewSettings.controls);
    }
    overlays?.setVisible('lanes', viewSettings.overlays.lanes);
    overlays?.setVisible('signals', viewSettings.overlays.signals);
    overlays?.setSignalOrbsVisible(viewSettings.signalOrbs.visible);
    overlays?.setSignalOrbDepthMode(viewSettings.signalOrbs.xray ? 'xray' : 'scene');
  }, [overlays, viewer, viewSettings]);

  /**
   * The editor's ground lookup.
   *
   * The overlay load already bakes a `GroundIndex` over the road layer (~30 ms,
   * ~0.2 µs a query), so placement reuses it rather than paying for a second
   * copy. If the overlays failed outright, fall back to the viewer's live
   * raycast — 9.5 ms a call, which is visibly slower under a moving ghost but
   * beats refusing to place anything.
   */
  const sampleHeight = useMemo(() => {
    if (!viewer) return null;
    return (x: number, z: number): number | null =>
      overlaysRef.current?.sampleHeight(x, z) ?? viewer.sampleGroundHeight(x, z);
  }, [viewer]);

  const { controller: editorController, state, laneStats, error: editorError } = useEditor({
    viewer,
    map,
    sampleHeight,
    hostRef,
    // A browser load always begins from a clean authored scenario. Explicit
    // map navigation within this mounted Studio session retains the existing
    // per-map resume behavior.
    startBlank: !hasNavigatedMaps.current,
  });
  // Ambient actors may remain visible while their next revision materializes;
  // authored signal colors are gated separately below.
  const ambientPreview = ambientPreviewState?.value ?? null;

  // Route guides are a viewport-owned scene layer. Prefer the immutable input
  // that the simulator will execute; the template fallback keeps newly placed
  // authored vehicles informative while materialization is in flight.
  useEffect(() => {
    if (!viewer) return;
    const renderer = new VehicleRouteOverlayRenderer(overlays?.sampleHeight);
    viewer.scene.add(renderer.group);
    routeOverlayRenderer.current = renderer;
    return () => {
      if (routeOverlayRenderer.current === renderer) routeOverlayRenderer.current = null;
      renderer.dispose();
    };
  }, [overlays, viewer]);

  // Older portable Gallery saves intentionally contain no scene-absolute
  // poses. Recover their immutable checked-in evidence by catalog identity and
  // stable role ids so reload has the same t=0 population and Play path as first open.
  useEffect(() => {
    if (!editorController || editorController.doc.actors.length > 0 || campaignSource) return;
    const template = editorController.doc.data;
    const sourceHash = simulationSourceHash(template);
    const recoveryKey = `${map.id}:${sourceHash}`;
    if (campaignRecovery.current === recoveryKey) return;
    campaignRecovery.current = recoveryKey;
    const normalizedName = template.meta.name.replace(/^\d+\s*[·.:~-]\s*/, '').trim();
    const entry = GENERATED_CAMPAIGN_ENTRIES.find((candidate) => candidate.mapId === map.id
      && candidate.title.replace(/^\d+\s*[·.:~-]\s*/, '').trim() === normalizedName
      && isCampaignReady(candidate));
    if (!entry) return;
    let cancelled = false;
    void loadVerifiedCampaignEntry(entry).then(({ template: portable, evidence }) => {
      if (cancelled || !sameRoleIdentity(template, portable)) return;
      setCampaignSource({ templateHash: sourceHash, evidence });
    }).catch((reason: unknown) => console.warn('[campaign] verified evidence recovery failed', reason));
    return () => { cancelled = true; };
  }, [campaignSource, editorController, map.id]);
  const hasAuthoredMapSignals = (editorController?.doc.data.mapSignalPlans.length ?? 0) > 0;
  const sumoOwnsSignalStates = sumoOwnsPhysicalSignalStates(
    ambientTrafficProvider,
    Boolean(sumoFallbackReason),
    hasAuthoredMapSignals,
    playbackBundle !== null,
  );
  const materializedAmbientProfile = useMemo(
    () => ambientTrafficProvider === 'off' || sumoOwnsSignalStates
      ? resolveAmbientTrafficProfile({ version: 1, preset: 'off', seed: ambientTrafficProfile.seed })
      : ambientTrafficProfile,
    [ambientTrafficProfile, ambientTrafficProvider, sumoOwnsSignalStates],
  );
  const prepareAuthoredPlayback = useCallback(async (signal: AbortSignal) => {
    throwIfPreparationAborted(signal);
    if (!editorController) throw new Error('The editor is not ready');
    const candidatePoolRequestKey = ambientCandidatePoolRequestKey(map.id, materializedAmbientProfile);
    const previewKey = ambientPreviewKey(candidatePoolRequestKey, simulationSourceHash(editorController.doc.data));
    const pending = ambientPreparation.current;
    if (pending?.previewKey === previewKey && pending.revision === editorController.doc.revision) await pending.promise;
    throwIfPreparationAborted(signal);
    let bundle = ambientPreviewCache.current.playback(editorController.doc.revision);
    if (!bundle && ambientTrafficProvider === 'off') {
      const revision = editorController.doc.revision;
      const prepared = await runtimeWorker.current!.prepare(
        editorController.doc.data,
        map,
        materializedAmbientProfile,
        undefined,
        { staticCollisionMode: 'skip', timeoutMs: 30_000, materializeOnly: true },
      );
      throwIfPreparationAborted(signal);
      if (!compiledWorldMatchesRevision(editorController.doc, revision)) {
        throw new Error('Scenario changed while preparing playback. Press Play again.');
      }
      const token = ambientPreviewCache.current.begin();
      ambientPreviewCache.current.commit(token, { candidatePoolRequestKey, previewKey, revision, value: prepared });
      bundle = prepared;
    }
    if (!bundle) throw new Error('Traffic is still loading. Press Play again when the map population is visible.');
    const routeParity = routeExecutionParity(editorController.doc.data, bundle.instance.input);
    if (!routeParity.ok) {
      throw new Error(`Playback route plan does not match the projected route for: ${routeParity.mismatches.join(', ')}. Rebuild the preview before Play.`);
    }
    const previewIdentity = canonicalPreviewIdentity(bundle);
    if (previewIdentity.complete && previewIdentity.hashBound) {
      // The full canonical authoring preview is the immutable playback result;
      // Play never invokes a second resolver/simulation for this revision.
      livePlayback.current = null;
      setAuthoredPlayback(bundle);
      return;
    }
    throw new Error(previewIdentity.hashBound
      ? 'The native scenario preview is still updating. Press Play when its full trajectory is ready.'
      : 'The scenario changed after its native preview was compiled. Wait for the updated preview before Play.');
  }, [ambientTrafficProvider, editorController, map, materializedAmbientProfile]);
  const cancelAuthoredPlayback = useCallback(() => {
    runtimeWorker.current?.cancel();
    livePlayback.current = null;
    setAuthoredPlayback(null);
    setCameraPlaybackRequested(false);
  }, []);
  const sessionOptions = useMemo(() => ({
    prepare: prepareAuthoredPlayback,
    cancel: cancelAuthoredPlayback,
    seekLimit: () => livePlayback.current?.recordedUntil()
      ?? editorController?.doc.data.choreography.clipSeconds
      ?? 20,
    keyboardEnabled: playbackBundle === null,
  }), [prepareAuthoredPlayback, cancelAuthoredPlayback, playbackBundle]);
  const studioSession = useStudioSession(
    editorController,
    editorController?.doc.data.choreography.clipSeconds ?? 20,
    sessionOptions,
  );
  useEffect(() => {
    window.__studioPlaybackMetrics = () => ({
      transport: studioSession.transportCounters?.() ?? {
        frames: 0, uiPublishes: 0, starts: 0, cancelledFrames: 0, underruns: 0, underrunFrames: 0,
      },
      worker: livePlayback.current?.counters() ?? null,
    });
    return () => { delete window.__studioPlaybackMetrics; };
  }, [studioSession.transportCounters]);
  useEffect(() => {
    const renderer = routeOverlayRenderer.current;
    if (!renderer || !editorController || !state) return;
    const currentAuthoringPreview = ambientPreviewState?.revision === editorController.doc.revision ? ambientPreview : null;
    const concrete = playbackBundle ?? authoredPlayback ?? currentAuthoringPreview;
    const authoredColors = new Map(state.actors.map((actor) => [actor.id, actor.bodyColor]));
    const playback = playbackBundle !== null || studioSession.state.mode !== 'authoring';
    const routes = playbackBundle !== null && concrete
      ? routesFromSimulation(concrete.instance.input, editorController.laneIndex, concrete.trace, authoredColors)
      : authoringRoutes(editorController.authoringPreviewData, editorController.laneIndex, concrete?.instance.input, concrete?.trace);
    const hiddenForCameraPlayback = playback && cameraPlaybackRequested;
    renderer.group.visible = viewSettings.routes.visible
      && !mapWorkspaceOpen
      && !hiddenForCameraPlayback
      && (!playback || viewSettings.routes.duringPlayback);
    renderer.sync(routes, {
      showAmbient: viewSettings.routes.ambient,
      showActual: viewSettings.routes.actual,
      selectedActorIds: new Set(state.selection),
      primarySelectedActorId: state.selection[0] ?? null,
    });
  }, [ambientPreview, ambientPreviewState, authoredPlayback, cameraPlaybackRequested, editorController, mapWorkspaceOpen,
    playbackBundle, state, studioSession.state.mode, viewSettings.routes]);
  const authoringEnabled = playbackBundle === null && studioSession.state.mode === 'authoring' && !mapWorkspaceOpen;
  const previewUpdating = authoringEnabled && Boolean(editorController) && (ambientPreviewBusy || ambientPreviewState?.revision !== editorController?.doc.revision);
  const signalPickingEnabled = authoringEnabled && state?.mode === 'idle';

  useEffect(() => {
    if (!overlays) return;
    overlays.setSignalHighlight(selectedSignalReference ?? (
      selectedSignalHeadId ? { selectedHeadId: selectedSignalHeadId } : null
    ));
    return () => { overlays.setSignalHighlight(null); };
  }, [overlays, selectedSignalHeadId, selectedSignalReference]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !viewer || !overlays || !signalSelectionModel || !signalPickingEnabled) return;
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    let press: { pointerId: number; x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || !event.composedPath().includes(viewer.renderer.domElement)) return;
      press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: PointerEvent): void => {
      const start = press;
      press = null;
      if (!start || start.pointerId !== event.pointerId || event.button !== 0) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
      const canvas = viewer.renderer.domElement;
      if (!event.composedPath().includes(canvas)) return;
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, viewer.camera);
      const headId = overlays.pickSignalOrb(raycaster);
      setSelectedSignalHeadId(headId);
      if (headId) signalSelectionModel.selectHead(headId);
      else signalSelectionModel.clear();
    };
    host.addEventListener('pointerdown', onPointerDown, { capture: true });
    host.addEventListener('pointerup', onPointerUp, { capture: true });
    return () => {
      host.removeEventListener('pointerdown', onPointerDown, { capture: true });
      host.removeEventListener('pointerup', onPointerUp, { capture: true });
    };
  }, [overlays, signalPickingEnabled, signalSelectionModel, viewer]);

  const changeAmbientTraffic = useCallback((profile: ResolvedAmbientTrafficProfile) => {
    setAmbientTrafficProfile(profile);
    setSumoFallbackReason(null);
    editorController?.doc.setPresentationExtension(AMBIENT_TRAFFIC_EXTENSION_KEY, profile);
  }, [editorController]);
  const changeAmbientTrafficProvider = useCallback((provider: AmbientTrafficProviderId) => {
    overlays?.clearSignalStates();
    setAmbientTrafficProvider(provider);
    setSumoFallbackReason(null);
    editorController?.doc.setAmbientTrafficExtension(AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY, provider);
    if (provider === 'off') {
      runtimeWorker.current?.cancel();
      ambientPreviewCache.current.begin();
      ambientPreparation.current = null;
      setAmbientPreviewState(null);
      setAmbientPreviewBusy(false);
      setAmbientTrafficError(null);
      editorController?.renderer.clearLayer('ambient-preview');
      editorController?.renderer.clearLayer('sumo-traffic');
    }
  }, [editorController, overlays]);
  const changeAcceleratedSignalCycles = useCallback((enabled: boolean) => {
    // Do not leave the old program's last colors visible while SUMO resets.
    overlays?.clearSignalStates();
    setAcceleratedSignalCycles(enabled);
    setSumoFallbackReason(null);
    // False is the canonical default; omitting it keeps legacy and new files byte-semantically aligned.
    editorController?.doc.setAmbientTrafficExtension(
      ACCELERATED_SIGNAL_CYCLES_EXTENSION_KEY,
      enabled ? true : undefined,
    );
  }, [editorController, overlays]);

  // Scenario navigation/import is authoritative. Never leak a traffic choice from
  // the previously open map or saved scenario into the next document.
  const authoredAmbientValue = editorController?.doc.data.extensions?.[AMBIENT_TRAFFIC_EXTENSION_KEY];
  const authoredAmbientHash = contentHash(authoredAmbientValue ?? null);
  const authoredAmbientProvider = ambientTrafficProviderFromExtensions(editorController?.doc.data.extensions);
  const authoredAmbientProviderHash = contentHash(authoredAmbientProvider);
  const ambientTrafficProviderHydrated = ambientTrafficProvider === authoredAmbientProvider;
  const authoredAcceleratedSignalCyclesValue = editorController?.doc.data.extensions?.[ACCELERATED_SIGNAL_CYCLES_EXTENSION_KEY];
  const authoredAcceleratedSignalCyclesHash = contentHash(authoredAcceleratedSignalCyclesValue ?? null);
  // Camera/sensor/presentation edits do not change the physical traffic world.
  // Key expensive generation only to the simulation-bearing authored source;
  // the profile remains its own dependency below.
  const ambientPreviewSourceHash = editorController ? simulationSourceHash(editorController.doc.data) : null;
  const currentAmbientPreviewKey = editorController
    ? ambientPreviewKey(
      ambientCandidatePoolRequestKey(map.id, materializedAmbientProfile),
      ambientPreviewSourceHash ?? 'empty',
    )
    : null;
  const authoredSignalPreview = previewForRevision(
    ambientPreviewState,
    currentAmbientPreviewKey,
    editorController?.doc.revision,
  );
  useEffect(() => {
    const next = ambientTrafficProfileFromExtensions(editorController?.doc.data.extensions);
    setAmbientTrafficProfile((current) => contentHash(current) === contentHash(next) ? current : next);
  }, [editorController, authoredAmbientHash]);
  useEffect(() => {
    setAmbientTrafficProvider(authoredAmbientProvider);
    setSumoFallbackReason(null);
  }, [authoredAmbientProvider, authoredAmbientProviderHash, editorController]);
  useEffect(() => {
    const next = ambientSignalCycleSettingsFromExtensions(editorController?.doc.data.extensions).acceleratedSignalCycles;
    if (acceleratedSignalCycles !== next) overlays?.clearSignalStates();
    setAcceleratedSignalCycles(next);
    setSumoFallbackReason(null);
  }, [acceleratedSignalCycles, editorController, authoredAcceleratedSignalCyclesHash, overlays]);

  // One persistent concrete world owns both the authoring preview and playback.
  // Authored edits rematerialize against the existing generated actors; only a
  // map/profile/mix/seed change creates a new traffic population.
  useEffect(() => {
    if (!editorController || playbackBundle || !ambientTrafficProviderHydrated || ambientTrafficProvider === 'off') {
      if (ambientTrafficProvider === 'off') {
        runtimeWorker.current?.cancel();
        ambientPreviewCache.current.begin();
        ambientPreparation.current = null;
        setAmbientPreviewState(null);
        setAmbientTrafficError(null);
        editorController?.renderer.clearLayer('ambient-preview');
      }
      setAmbientPreviewBusy(false);
      return;
    }
    const candidatePoolRequestKey = ambientCandidatePoolRequestKey(map.id, materializedAmbientProfile);
    const previewKey = ambientPreviewKey(candidatePoolRequestKey, ambientPreviewSourceHash ?? 'empty');
    const current = ambientPreviewCache.current.current;
    if (current?.previewKey === previewKey && current.revision === editorController.doc.revision) {
      setAmbientPreviewState({ previewKey, revision: current.revision, value: current.value });
      setAmbientPreviewBusy(false);
      return;
    }
    const token = ambientPreviewCache.current.begin();
    const revision = editorController.doc.revision;
    runtimeWorker.current?.cancel();
    // Keep the persistent actor population on same-map edits. The revision-keyed
    // signal source above becomes null immediately, clearing authored lamp colors.
    if (current && current.value.instance.input.mapId !== map.id) setAmbientPreviewState(null);
    const verifiedFallback = editorController && campaignSource
      && simulationSourceHash(editorController.doc.data) === campaignSource.templateHash
      ? campaignSource.evidence
      : null;
    if (verifiedFallback && canReuseVerifiedEvidenceForAmbient(materializedAmbientProfile, verifiedFallback.ambientTraffic)) {
      if (!compiledWorldMatchesRevision(editorController.doc, revision)
        || !ambientPreviewCache.current.commit(token, { candidatePoolRequestKey, previewKey, revision, value: verifiedFallback })) {
        setAmbientPreviewBusy(false);
        return;
      }
      setAmbientPreviewState({ previewKey, revision, value: verifiedFallback });
      setAmbientPreviewBusy(false);
      return;
    }
    setAmbientPreviewBusy(true);
    setAmbientTrafficError(null);
    const promise = runtimeWorker.current!.prepare(
      editorController.doc.data,
      map,
      materializedAmbientProfile,
      verifiedFallback?.instance,
      // Build only the warmed t=0 world in the background. Static map collider
      // extraction is intentionally not on this interactive path; dynamic
      // actor collision handling remains enabled and identical.
      { staticCollisionMode: 'skip', timeoutMs: 30_000, materializeOnly: true },
    );
    ambientPreparation.current = { previewKey, revision, promise };
    void promise.then(
      (bundle) => {
        if (!compiledWorldMatchesRevision(editorController.doc, revision)) return;
        if (!ambientPreviewCache.current.commit(token, { candidatePoolRequestKey, previewKey, revision, value: bundle })) return;
        setAmbientPreviewState({ previewKey, revision, value: bundle });
        setAmbientPreviewBusy(false);
        setAmbientTrafficError(null);
      },
      (reason: unknown) => {
        if (!ambientPreviewCache.current.fail(token)) return;
        setAmbientPreviewBusy(false);
        if ((reason as { name?: string } | null)?.name === 'AbortError') return;
        setAmbientTrafficError(`Traffic preparation: ${reason instanceof Error ? reason.message : String(reason)}`);
      },
    ).finally(() => {
      if (ambientPreparation.current?.promise === promise) ambientPreparation.current = null;
    });
  }, [ambientPreviewSourceHash, ambientTrafficProvider, ambientTrafficProviderHydrated, campaignSource, editorController, map, materializedAmbientProfile, playbackBundle, state?.revision]);

  useEffect(() => () => runtimeWorker.current?.dispose(), []);
  const runAmbientRobustness = useCallback(() => {
    if (!editorController || ambientRobustnessBusy) return;
    setAmbientRobustnessBusy(true);
    setAmbientRobustnessReport(null);
    setAmbientTrafficError(null);
    const template = editorController.doc.data;
    const filters = {
      negativeControl: template.meta.negativeControl,
      requiredTriggers: template.choreography.interactions.map((interaction) => interaction.id),
    };
    void evaluateAuthoredAmbientRobustness(template, map, filters).then(
      setAmbientRobustnessReport,
      (reason: unknown) => setAmbientTrafficError(reason instanceof Error ? reason.message : String(reason)),
    ).finally(() => setAmbientRobustnessBusy(false));
  }, [ambientRobustnessBusy, editorController, map]);
  const { registry: cameraRegistry, state: cameraState } = useCameras({
    viewer,
    store: editorController?.doc ?? null,
  });
  useEffect(() => {
    if (cameraRegistry) cameraRegistry.helpers.group.visible = viewSettings.debugGraphics;
  }, [cameraRegistry, viewSettings.debugGraphics]);
  const selectedPlayback = playbackBundle ?? authoredPlayback;
  const authoredPhysicsSummary = useMemo(() => physicsSummaryForAuthoredActors((state?.actors ?? []).map((actor) => {
    const role = editorController?.doc.data.roles.find((item) => item.id === actor.id);
    return {
      id: actor.id,
      label: actor.label,
      simulationKind: actor.source === 'prop' ? 'static_object' : role?.actor.class ?? simulationClassFor(actor.catalogId),
      static: actor.source === 'prop' || role?.actor.static === true,
      reverse: role?.extensions?.['motionSemantics'] === 'reverse',
    };
  })), [editorController, state?.actors]);
  const activePhysicsSummary = selectedPlayback
    ? physicsSummaryForTrace(selectedPlayback.trace)
    : authoredPhysicsSummary;
  const playbackPresentation = playbackBundle ? campaignCameras : cameraState;
  const galleryCamera = useMemo(
    () => playbackBundle ? galleryCameraChoice(playbackBundle) : null,
    [playbackBundle],
  );
  const playbackCameraOptions = useMemo<readonly PlaybackCameraOption[]>(() => {
    const galleryDefault: PlaybackCameraOption[] = galleryCamera?.policy === 'subject-chase'
      ? [{ id: galleryCamera.selectionId, label: galleryCamera.label, policy: 'subject-chase' }]
      : [];
    return [
      ...galleryDefault,
      { id: 'all-actors', label: 'All actors overview', policy: 'all-actors' },
      { id: 'auto-incident', label: 'Incident overview', policy: 'auto-incident' },
      ...playbackPresentation.cameras.map((camera) => ({
        id: `authored:${camera.id}`,
        label: camera.name,
        policy: 'authored' as const,
        view: { position: camera.position, target: camera.target, fov: camera.fov },
      })),
      { id: 'free', label: 'Free camera', policy: 'free' },
    ];
  }, [galleryCamera, playbackPresentation]);

  const authoredDashCameras = useMemo(() => (editorController?.doc.data.roles ?? []).flatMap((role) =>
    dashCameras(role.actor).map((sensor) => ({
      id: `${role.id}:${sensor.id}`,
      actorId: role.id,
      sensor,
      label: `${role.label || role.actor.catalogId || role.id} · ${sensor.label || 'Dash camera'}`,
    })),
  ).sort((a, b) => a.id.localeCompare(b.id)), [editorController, state?.actors]);
  const resolveActorRecord = useCallback((actorId: string | null): ActorRecord | null => {
    if (!actorId || !editorController) return null;
    const editable = state?.actors.find((item) => item.id === actorId);
    if (editable) return editable;
    const role = editorController.doc.data.roles.find((item) => item.id === actorId);
    if (!role) return null;
    const materialized = ambientPreview ?? authoredPlayback ?? campaignSource?.evidence ?? null;
    const sampled = materialized
      ? samplePlaybackActors(materialized, materialized.startTime).find((item) => item.id === actorId && item.present)
      : undefined;
    return actorRecordForRole(role, sampled);
  }, [ambientPreview, authoredPlayback, campaignSource, editorController, state?.actors]);
  const selectedAuthoredDashCamera = useMemo(() => {
    const selected = authoredDashCameras.find((camera) => camera.id === selectedDashCameraId);
    if (selected) return selected;
    const selectedActor = state?.selection[0];
    return authoredDashCameras.find((camera) => camera.actorId === selectedActor) ?? authoredDashCameras[0] ?? null;
  }, [authoredDashCameras, selectedDashCameraId, state?.selection]);

  const defaultPlaybackCamera = useMemo<PlaybackCameraOption | null>(() => {
    if (!selectedPlayback) return null;
    // Space playback is camera-neutral: preserve the author's exact position,
    // target, FOV, mode and orbit pivot. Read-only Gallery replay retains its
    // separate overview presentation.
    if (!playbackBundle) return cameraPlaybackRequested && selectedAuthoredDashCamera
      ? { id: selectedAuthoredDashCamera.id, label: selectedAuthoredDashCamera.label, policy: 'dash-camera' }
      : playbackCameraOptions.find((option) => option.policy === 'free') ?? null;
    if (galleryCamera) {
      return playbackCameraOptions.find((option) => option.id === galleryCamera.selectionId) ?? null;
    }
    return playbackCameraOptions[0] ?? null;
  }, [cameraPlaybackRequested, galleryCamera, playbackBundle, playbackCameraOptions, selectedAuthoredDashCamera, selectedPlayback]);

  useEffect(() => {
    if (!authoringEnabled) setAuxiliaryTool(null);
  }, [authoringEnabled]);

  const requestAuxiliaryTool = useCallback((tool: Exclude<ViewportTool, 'select' | 'move' | 'rotate' | 'add'> | null) => {
    setAuxiliaryTool(tool);
    if (tool) setLeftPanelOpen(false);
  }, []);
  const closeAuxiliaryTool = useCallback(() => setAuxiliaryTool(null), []);

  const activePlayback = selectedPlayback?.instance.input.mapId === map.id ? selectedPlayback : null;
  const { controller: playbackController, state: playbackState, error: playbackCameraError } = usePlayback({
    viewer,
    bundle: activePlayback,
    sampleHeight,
    // In SUMO mode one authority must govern both vehicle right-of-way and the
    // visible lamps. Prevent authored playback samples from racing SUMO's live
    // controller/link snapshot; fallback restores the native authority.
    overlays: sumoOwnsSignalStates ? null : overlays,
    cameraPolicy: defaultPlaybackCamera?.policy,
    cameraView: defaultPlaybackCamera?.view,
    dashCamera: !playbackBundle && cameraPlaybackRequested && selectedAuthoredDashCamera
      ? { actorId: selectedAuthoredDashCamera.actorId, sensor: selectedAuthoredDashCamera.sensor }
      : null,
    restoreCameraOnDispose: true,
    renderer: editorController?.renderer,
    externalClock: !playbackBundle,
  });
  const sumoExternalActors = useMemo<readonly SumoExternalActorView[]>(() => {
    if (authoredPlayback) {
      const metadata = new Map(authoredPlayback.actors.map((actor) => [actor.id, actor] as const));
      // Sample the canonical trace at the exact editor clock. The renderer's
      // cached `currentActors` can legitimately advance in a larger chunk
      // after a stalled frame and must not be paired with a smaller SUMO tick.
      const actors = samplePlaybackActors(authoredPlayback, studioSession.state.time).flatMap((actor) => {
        const detail = metadata.get(actor.id);
        if (!detail || !actor.present || actor.id.startsWith('ambient')) return [];
        return [{
          id: actor.id,
          kind: detail.kind,
          x: actor.x,
          z: actor.z,
          headingRad: actor.headingRad,
          speedMps: sampledTraceSpeed(authoredPlayback, actor.id, studioSession.state.time),
          lengthM: actor.dims.l,
          widthM: actor.dims.w,
          static: actor.static,
          present: actor.present,
        } satisfies SumoExternalActorView];
      });
      const props = authoredPlayback.props.map((prop) => ({
        id: `prop:${prop.id}`,
        kind: 'static_object' as const,
        x: prop.pose.x,
        z: prop.pose.z,
        headingRad: prop.pose.headingRad,
        speedMps: 0,
        lengthM: prop.dims.l * prop.scale,
        widthM: prop.dims.w * prop.scale,
        static: true,
        present: true,
      } satisfies SumoExternalActorView));
      return [...actors, ...props];
    }
    return (state?.actors ?? []).map((actor) => ({
      id: actor.id,
      kind: simulationClassFor(actor.catalogId),
      x: actor.x,
      z: actor.z,
      headingRad: actor.headingRad,
      speedMps: actor.source === 'prop' ? 0 : (actor.initialSpeedKph ?? 0) / 3.6,
      lengthM: actor.dims.l,
      widthM: actor.dims.w,
      static: actor.source === 'prop',
      present: true,
    }));
  }, [authoredPlayback, state?.actors, studioSession.state.time]);
  const fallbackToNativeTraffic = useCallback((reason: string) => setSumoFallbackReason(reason), []);
  const sumoDemandFocus = useMemo(() => {
    if (state?.actors.length) {
      return {
        x: state.actors.reduce((sum, actor) => sum + actor.x, 0) / state.actors.length,
        z: state.actors.reduce((sum, actor) => sum + actor.z, 0) / state.actors.length,
      };
    }
    const target = viewer?.captureView().target;
    return target ? { x: target[0], z: target[2] } : null;
  }, [state?.actors, viewer]);
  const sumoStatus = useSumoTraffic({
    // An authored controller plan is authoritative. Until the WASM bridge can
    // accept live tlLogic overrides, native ambient traffic owns that world so
    // SUMO cannot render or obey a contradictory independent signal cycle.
    enabled: ambientTrafficProviderHydrated && sumoOwnsSignalStates,
    map,
    profile: ambientTrafficProfile,
    renderer: editorController?.renderer,
    sampleHeight,
    mode: studioSession.state.mode,
    time: studioSession.state.time,
    externalActors: sumoExternalActors,
    focus: sumoDemandFocus,
    onFallback: fallbackToNativeTraffic,
    acceleratedSignalCycles,
  });
  useEffect(() => {
    if (!sumoOwnsSignalStates || !sumoStatus.signalStates) return;
    overlays?.setSignalStates(sumoStatus.signalStates);
  }, [overlays, sumoOwnsSignalStates, sumoStatus.signalStates]);
  useEffect(() => {
    if (!sumoOwnsSignalStates) return;
    return () => overlays?.clearSignalStates();
  }, [map.id, overlays, sumoOwnsSignalStates]);
  useEffect(() => {
    if (!overlays || !hasAuthoredMapSignals || studioSession.state.mode !== 'authoring') return;
    if (!authoredSignalPreview) return;
    const headStates = evaluatePlaybackSignalHeadStates(authoredSignalPreview, studioSession.state.time);
    if (Object.keys(headStates).length > 0) {
      overlays.setSignalStates(headStates, studioSession.state.time);
    }
    return () => overlays.clearSignalStates();
  }, [authoredSignalPreview, hasAuthoredMapSignals, overlays, studioSession.state.mode, studioSession.state.time]);
  const editorActorIds = useMemo(() => state?.actors.map((actor) => actor.id) ?? [], [state?.actors]);
  // Keep t=0 visible through the preparing frame. The playback renderer takes
  // ownership only after the exact same bundle has been installed.
  useAmbientTrafficPreview(
    viewer,
    ambientPreview,
    sampleHeight,
    playbackBundle === null && authoredPlayback === null && !mapWorkspaceOpen,
    editorActorIds,
    editorController?.renderer,
  );

  useEffect(() => {
    if (!authoredPlayback || !playbackController) return;
    studioSession.setFrameDriver?.((time) => {
      playbackController.renderAt(time);
    });
    playbackController.renderAt(studioSession.state.time);
    return () => studioSession.setFrameDriver?.(null);
  }, [authoredPlayback, playbackController, studioSession.setFrameDriver]);

  useEffect(() => {
    if (!authoredPlayback || !playbackController) return;
    const playing = studioSession.state.mode === 'playing';
    livePlayback.current?.setPlaying(playing, studioSession.state.time);
    if (playing) playbackController.play();
    else playbackController.pause();
  }, [authoredPlayback, playbackController, studioSession.state.mode]);

  // A seek is authoritative for worker lookahead too. This message is tiny and
  // follows the already-throttled 20 Hz UI publication; physics remains fixed-step.
  useEffect(() => {
    if (studioSession.state.mode !== 'playing') return;
    livePlayback.current?.setPlaying(true, studioSession.state.time);
  }, [studioSession.state.mode, studioSession.state.time]);

  // Playback is a viewport mode, not an editor mutation. Keep the autosave
  // document intact but hide its actors until the imported evidence is closed.
  useEffect(() => {
    if (!editorController) return;
    const selection = editorController.state.selection;
    editorController.renderer.setLayerVisible('editor', selectedPlayback === null);
    return () => {
      editorController.renderer.setLayerVisible('editor', true);
      editorController.setSelection(selection);
    };
  }, [editorController, selectedPlayback]);

  const importPlayback = useCallback(
    (bundle: PlaybackBundle) => {
      const targetMap = mapById(bundle.instance.input.mapId);
      if (!targetMap) {
        throw new PlaybackLoadError('Scenario import failed', [
          `No Studio map assets are registered for input.mapId ${JSON.stringify(bundle.instance.input.mapId)}.`,
        ]);
      }
      setPlaybackBundle(bundle);
      selectMap(targetMap);
    },
    [selectMap],
  );

  const playCampaignEvidence = useCallback((request: CampaignEvidenceRequest) => {
    if (request.evidence.instance.input.mapId !== request.entry.mapId) {
      throw new PlaybackLoadError('Campaign playback failed', [
        `Card ${request.entry.ordinal} targets ${String(request.entry.mapId)} but its evidence targets ${request.evidence.instance.input.mapId}.`,
      ]);
    }
    // This is an exact concrete replay. Do not rematch the portable editable
    // source; rematerialization belongs only to authored Space playback.
    setCampaignPlaybackTitle(request.entry.title.replace(/^\d+\s*[·.:~-]\s*/, ''));
    setCampaignCameras(request.cameraPresentation);
    importPlayback(request.evidence);
  }, [importPlayback]);

  const returnToGallery = useCallback(() => {
    setPlaybackBundle(null);
    setCampaignPlaybackTitle(null);
    setCampaignCameras(EMPTY_CAMERA_PRESENTATION);
    setLeftPanelOpen(false);
    setAuxiliaryTool('saved');
  }, []);

  const applyEditableCampaign = useCallback((request: CampaignOpenRequest) => {
    if (!editorController || editorController.doc.map.id !== request.entry.mapId) return false;
    const grounded = groundEditableActors(request.template, sampleHeight);
    editorController.doc.importTemplate(grounded, { saveName: request.savedName });
    setCampaignSource(request.reuseVerifiedEvidence
      ? { templateHash: simulationSourceHash(grounded), evidence: request.evidence }
      : null);
    frameEditableActors(viewer, grounded);
    return true;
  }, [editorController, sampleHeight, viewer]);

  const openCampaign = useCallback((request: CampaignOpenRequest) => {
    const targetMap = mapById(request.entry.mapId);
    if (!targetMap) throw new Error(`Campaign map ${String(request.entry.mapId)} is not installed in Studio`);
    setAuxiliaryTool(null);
    if (targetMap.id === map.id && applyEditableCampaign(request)) return;
    setPendingCampaignOpen(request);
    selectMap(targetMap);
  }, [applyEditableCampaign, map.id, selectMap]);

  useEffect(() => {
    if (!pendingCampaignOpen || !editorController || !canApplyCampaignOpen(
      pendingCampaignOpen.entry.mapId,
      map.id,
      editorController.doc.map.id,
    )) return;
    if (!applyEditableCampaign(pendingCampaignOpen)) return;
    setPendingCampaignOpen(null);
  }, [applyEditableCampaign, editorController, map.id, pendingCampaignOpen]);

  // 1-5 switch maps. Deliberately global (not scoped to the picker) and
  // deliberately not swallowed when a modal edit is running — switching maps is
  // a navigation, and the editor parks its work on the way out.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
      const index = Number(event.key) - 1;
      const next = MAPS[index];
      if (!Number.isInteger(index) || !next) return;
      event.preventDefault();
      selectMap(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectMap]);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeSettings = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setSettingsOpen(false);
    };
    window.addEventListener('keydown', closeSettings, { capture: true });
    return () => window.removeEventListener('keydown', closeSettings, { capture: true });
  }, [settingsOpen]);

  useEffect(() => {
    if (!playbackBundle || !playbackController) return;
    const onSpace = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const action = verifiedReplayKeyboardAction({
        code: event.code,
        key: event.key,
        repeat: event.repeat,
        modified: event.metaKey || event.ctrlKey || event.altKey,
        editable: tag === 'input' || tag === 'textarea' || tag === 'select' || !!target?.isContentEditable,
      });
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === 'stop') returnToGallery();
      else playbackController.toggle();
    };
    window.addEventListener('keydown', onSpace, { capture: true });
    return () => window.removeEventListener('keydown', onSpace, { capture: true });
  }, [playbackBundle, playbackController, returnToGallery]);

  // A Gallery action labelled "Play" starts immediately once the exact trace
  // has mounted on its target map. The controller still owns clamping at the
  // verified envelope and leaves the final 20.00 s frame visible on completion.
  useEffect(() => {
    if (!campaignPlaybackTitle || !playbackController) return;
    playbackController.play();
  }, [campaignPlaybackTitle, playbackController]);

  const catalogPlacement = useMemo<CatalogPlacementAdapter>(() => ({
    enabled: authoringEnabled && editorController !== null,
    placing: state?.placing ?? null,
    arm: (id) => editorController?.togglePlacement(id),
    armKind: (kind) => editorController?.togglePlacementKind(kind),
    cancel: () => {
      if (state?.mode === 'placing') editorController?.cancel();
    },
  }), [authoringEnabled, editorController, state?.mode, state?.placing]);

  const chooseExperience = useCallback((mode: EditorExperience) => {
    setExperience(mode);
    saveEditorExperience(mode);
  }, []);

  const focusTimelineActor = useCallback((actorId: string) => {
    if (!editorController) return;
    editorController.setSelection([actorId]);
    const sampledPreviewActor = ambientPreview
      ? samplePlaybackActors(ambientPreview, ambientPreview.startTime).find((actor) => actor.id === actorId && actor.present)
      : undefined;
    const previewActor = sampledPreviewActor ? {
      ...sampledPreviewActor,
      y: sampleHeight?.(sampledPreviewActor.x, sampledPreviewActor.z) ?? 0,
    } : undefined;
    editorController.frameActor(actorId, previewActor);
  }, [ambientPreview, editorController, sampleHeight]);

  const signalLanes = useMemo(() => signalLanesFromPlans(
    editorController?.doc.data.mapSignalPlans ?? [],
    map.id,
    selectedSignalHeadId,
    (planId) => editorController?.doc.removeMapSignalPlan(planId),
  ), [editorController, map.id, selectedSignalHeadId]);

  const loading = state === null;

  const openScenarioSourceHash = useMemo(
    () => editorController ? contentHash(editorController.doc.data) : '',
    [editorController, state],
  );
  const regenerateOpenScenario = useCallback(() => {
    if (!editorController) {
      setOpenScenarioState({ status: 'empty', reason: 'The editor is still loading.' });
      return;
    }
    if (editorController.doc.data.roles.length === 0 && editorController.doc.data.props.length === 0) {
      setOpenScenarioState({ status: 'empty', reason: 'Place at least one actor before generating an interchange artifact.' });
      return;
    }
    const sourceHash = contentHash(editorController.doc.data);
    setOpenScenarioState({ status: 'loading', sourceHash });
    void runtimeWorker.current!.prepare(editorController.doc.data, map, materializedAmbientProfile).then(
      (bundle) => {
        if (!bundle.openScenario || bundle.openScenario.source.templateHash !== sourceHash) {
          setOpenScenarioState({ status: 'error', sourceHash, message: 'The export worker returned a snapshot for a different document revision.' });
          return;
        }
        setOpenScenarioState({ status: 'ready', sourceHash, snapshot: bundle.openScenario });
      },
      (reason: unknown) => setOpenScenarioState({ status: 'error', sourceHash, message: reason instanceof Error ? reason.message : String(reason) }),
    );
  }, [editorController, map, materializedAmbientProfile]);

  useEffect(() => {
    if (!openScenarioOpen) return;
    if (openScenarioState.status !== 'empty' && openScenarioState.sourceHash === openScenarioSourceHash) return;
    regenerateOpenScenario();
  }, [openScenarioOpen, openScenarioSourceHash, openScenarioState, regenerateOpenScenario]);

  const presentedOpenScenarioState: OpenScenarioWorkspaceState = useMemo(() => {
    if (openScenarioState.status === 'empty' || openScenarioState.sourceHash === openScenarioSourceHash) return openScenarioState;
    return { status: 'loading', sourceHash: openScenarioSourceHash };
  }, [openScenarioSourceHash, openScenarioState]);

  const copyCurrentScenario = useCallback(async (): Promise<number> => {
    if (!editorController) throw new Error('The scenario is still loading.');
    // Capture one committed revision synchronously. Preview/playback traces are
    // deliberately excluded, so an in-flight simulation cannot make this stale.
    const scenario = editorController.doc.data;
    const revision = editorController.doc.revision;
    const diagnostic = createScenarioDiagnostic({
      scenario,
      revision,
      map,
      currentXodrSha256: editorController.laneIndex.stats.xodrSha256,
      validation: editorController.doc.validation,
      graphicsPreset: loadQualityPreference().preset,
      cameraControls: viewSettings.controls,
      buildCommit: import.meta.env.VITE_GIT_COMMIT ?? import.meta.env.VITE_COMMIT_SHA,
    });
    await copyScenarioDiagnosticText(diagnostic.text);
    return diagnostic.bytes;
  }, [editorController, map, viewSettings.controls]);

  const validateCopilotCandidate = useCallback(async (candidate: CopilotCandidate): Promise<CandidateValidation> => {
    const bundle = await runtimeWorker.current!.prepare(candidate.scenarioDoc, map, materializedAmbientProfile);
    const times = bundle.trace.ticks.t;
    const durationS = times.length > 1 ? (times[times.length - 1] ?? 0) - (times[0] ?? 0) : 0;
    const actorCount = Object.keys(bundle.trace.ticks.actors).length;
    if (actorCount < candidate.scenarioDoc.roles.filter((role) => role.essentiality !== 'cosmetic').length) {
      return { valid: false, message: `Canonical simulation returned ${actorCount} actors for ${candidate.scenarioDoc.roles.length} authored roles.`, actorCount, durationS };
    }
    return { valid: true, message: `Canonical simulation passed · ${actorCount} actors · ${durationS.toFixed(1)} s`, actorCount, durationS };
  }, [map, materializedAmbientProfile]);

  const applyCopilotCandidate = useCallback((candidate: CopilotCandidate): void => {
    if (!editorController) return;
    const grounded = groundEditableActors(candidate.scenarioDoc, sampleHeight);
    editorController.doc.importTemplate(grounded, { saveName: candidate.title });
    editorController.setSelection(grounded.roles.map((role) => role.id));
    setAuxiliaryTool(null);
  }, [editorController, sampleHeight]);
  const openSavedGeneration = useCallback((entry: CopilotGenerationHistoryEntry): void => {
    if (!editorController || !entry.candidate) return;
    const compatibility = draftCompatibility(entry, map.id, editorController.laneIndex.stats.xodrSha256);
    if (!compatibility.compatible) return;
    // Parse before asking to replace the current scenario so malformed or stale
    // stored data can never disturb the author's working document.
    let exact: ScenarioTemplateV2;
    try { exact = parseSavedGenerationDraft(entry); }
    catch (reason) { window.alert(`This saved draft cannot be opened: ${reason instanceof Error ? reason.message : String(reason)}`); return; }
    const current = editorController.doc.data;
    const hasAuthoredWork = hasMaterialAuthoredContent(current);
    if (hasAuthoredWork && !window.confirm(`Open “${entry.caseTitle}” in Author? Your current scenario is already autosaved, and this will replace the open canvas. You can return to the saved scenario from the gallery.`)) return;
    const grounded = groundEditableActors(exact, sampleHeight);
    editorController.doc.importTemplate(grounded, { saveName: entry.candidate.title });
    editorController.setSelection(grounded.roles.map((role) => role.id));
    setPlaybackBundle(null); setCampaignPlaybackTitle(null); setCampaignSource(null);
    setOpenScenarioOpen(false); setMapWorkspaceOpen(false); setAuxiliaryTool(null); setSettingsOpen(false);
    navigateGenerations(false);
    frameEditableActors(viewer, grounded);
  }, [editorController, map.id, navigateGenerations, sampleHeight, viewer]);
  const switchToGenerationMap = useCallback((entry: CopilotGenerationHistoryEntry): void => {
    const target = mapById(entry.mapId);
    if (!target) { window.alert(`The map ${entry.mapId} is not installed in Studio.`); return; }
    selectMap(target);
  }, [selectMap]);

  const showAuthoringChrome = !playbackBundle && !mapWorkspaceOpen;

  return (
    <div style={styles.root}>
      <WorkspaceShell
        header={<WorkspaceHeader
          state={state}
          map={map}
          playback={playbackBundle !== null || studioSession.state.mode !== 'authoring'}
          openScenario={openScenarioOpen}
          mapWorkspace={mapWorkspaceOpen}
          generationsOpen={generationsOpen}
          settingsOpen={settingsOpen}
          onSettings={() => setSettingsOpen((open) => !open)}
          onCopyScenario={editorController ? copyCurrentScenario : undefined}
          onOpenScenario={() => {
            navigateGenerations(false);
            setMapWorkspaceOpen(false);
            setOpenScenarioOpen((open) => !open);
          }}
          onMapWorkspace={() => {
            navigateGenerations(false);
            setOpenScenarioOpen(false);
            setSettingsOpen(false);
            setMapWorkspaceOpen(true);
          }}
          onGenerations={() => navigateGenerations(!generationsOpen)}
          onAuthorWorkspace={() => {
            navigateGenerations(false);
            setOpenScenarioOpen(false);
            setMapWorkspaceOpen(false);
          }}
          physicsSummary={activePhysicsSummary}
        />}
        rail={showAuthoringChrome && authoringEnabled ? (
          <RailHost
            controller={editorController}
            state={state}
            document={editorController?.doc ?? null}
            hostRef={hostRef}
          />
        ) : null}
        canvas={(slotProps) => (
          <div {...slotProps} ref={hostRef} data-testid="map-pane" style={styles.mapPane}>
            <CityView
              key={map.id}
              manifestUrl={map.manifest}
              options={optionsRef.current}
              onReady={onReady}
              onError={(error) => setWorldRenderError(error instanceof Error ? error.message : String(error))}
              style={styles.canvas}
            />
            {!mapWorkspaceOpen ? <WorldLoadingOverlay
              viewer={viewer}
              mapLabel={map.label}
              editorReady={state !== null}
              error={worldRenderError ?? editorError}
            /> : null}
            {previewUpdating ? <div role="status" aria-live="polite" data-testid="canonical-preview-updating" style={{ position: 'absolute', top: 14, left: '50%', zIndex: 24, transform: 'translateX(-50%)', padding: '7px 11px', border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 999, background: 'linear-gradient(180deg, var(--ueui-glass-high, rgba(19, 24, 32, 0.92)), var(--ueui-glass-low, rgba(8, 11, 16, 0.94)))', color: 'var(--ueui-text, #f2f2f2)', fontSize: 11, pointerEvents: 'none' }}>Updating preview…</div> : null}
          </div>
        )}
        floatingOverlay={
          <>
            {showAuthoringChrome && editorController ? (
              <WorkspaceTimelineDock
                controller={editorController}
                editorState={state}
                session={studioSession}
                playbackController={playbackController}
                authoredPlayback={authoredPlayback}
                experience={experience ?? 'simple'}
                signalLanes={signalLanes}
                onSelectActor={(actorId) => editorController.setSelection([actorId])}
                onFocusActor={focusTimelineActor}
                onSelectInteraction={(_, actorId) => editorController.setSelection([actorId])}
                onClearSelection={() => editorController.setSelection([])}
                onSelectSignal={(headId) => {
                  setSelectedSignalHeadId(headId);
                  signalSelectionModel?.selectHead(headId);
                }}
                dashCameras={authoredDashCameras}
                selectedDashCameraId={selectedAuthoredDashCamera?.id ?? null}
                onDashCameraChange={setSelectedDashCameraId}
                onCameraPlay={() => {
                  if (!selectedAuthoredDashCamera) return;
                  setSelectedDashCameraId(selectedAuthoredDashCamera.id);
                  setCameraPlaybackRequested(true);
                  studioSession.playPause();
                }}
              />
            ) : null}
            {shouldShowEditorToolRail(authoringEnabled, mapWorkspaceOpen) ? <EditorToolRail
              controller={editorController}
              state={state}
              placement={catalogPlacement}
              authoringEnabled={authoringEnabled}
              auxiliaryTool={auxiliaryTool}
              onToolRequest={requestAuxiliaryTool}
            /> : null}

            {mapWorkspaceOpen ? (
              <MapWorkspace viewer={viewer} map={map} overlays={overlays} editor={editorController} editorState={state} />
            ) : null}

            {openScenarioOpen ? <OpenScenarioWorkspace
              state={presentedOpenScenarioState}
              onRetry={regenerateOpenScenario}
              onClose={() => setOpenScenarioOpen(false)}
              templateValidation={editorController?.doc.validation ?? null}
              physicsSummary={activePhysicsSummary}
              initialSection={openScenarioLocationIntent(window.location).section}
              onLocateSource={(sourceId) => {
                editorController?.setSelection([sourceId]);
                setOpenScenarioOpen(false);
              }}
            /> : null}

            {!mapWorkspaceOpen && auxiliaryTool === 'ambient' && authoringEnabled ? (
              <AmbientTrafficPopover
                profile={ambientTrafficProfile}
                provenance={ambientTrafficProvider === 'off' ? null : ambientPreview?.ambientTraffic ?? authoredPlayback?.ambientTraffic ?? null}
                provider={ambientTrafficProvider}
                onProviderChange={changeAmbientTrafficProvider}
                acceleratedSignalCycles={acceleratedSignalCycles}
                onAcceleratedSignalCyclesChange={changeAcceleratedSignalCycles}
                sumoStatus={sumoFallbackReason ? { phase: 'fallback', actorCount: 0, reason: sumoFallbackReason } : sumoStatus}
                busy={ambientPreviewBusy || sumoStatus.phase === 'loading'}
                error={ambientTrafficError}
                onChange={changeAmbientTraffic}
                robustnessReport={ambientRobustnessReport}
                robustnessBusy={ambientRobustnessBusy}
                onRunRobustness={ambientTrafficProvider === 'native' ? runAmbientRobustness : undefined}
                onClose={closeAuxiliaryTool}
              />
            ) : null}

            {!mapWorkspaceOpen && auxiliaryTool && auxiliaryTool !== 'ambient' && authoringEnabled ? (
              <div
                style={auxiliaryTool === 'saved' ? { ...styles.toolDrawer, ...styles.galleryDrawer } : styles.toolDrawer}
                data-testid={`${auxiliaryTool}-tool-drawer`}
              >
                {auxiliaryTool === 'camera' && cameraRegistry ? (
                  <CameraPanel registry={cameraRegistry} state={cameraState} />
                ) : auxiliaryTool === 'saved' ? (
                  <CampaignDrawer
                    authoringEnabled={authoringEnabled}
                    onOpen={openCampaign}
                    onPlayEvidence={playCampaignEvidence}
                    onClose={() => setAuxiliaryTool(null)}
                  />
                ) : auxiliaryTool === 'variations' && editorController ? (
                  <VariationsPanel
                    controller={editorController}
                    viewer={viewer}
                    map={map}
                    authoringEnabled={authoringEnabled}
                    onOpenProject={(targetMap) => {
                      setAuxiliaryTool(null);
                      selectMap(targetMap);
                    }}
                    onClose={() => setAuxiliaryTool(null)}
                  />
                ) : auxiliaryTool === 'copilot' && editorController ? (
                  <ScenarioCopilotPanel
                    controller={editorController}
                    map={map}
                    sampleHeight={sampleHeight}
                    onValidate={validateCopilotCandidate}
                    onApply={applyCopilotCandidate}
                    onOpenGenerations={() => navigateGenerations(true)}
                    onClose={() => setAuxiliaryTool(null)}
                  />
                ) : auxiliaryTool === 'measure' ? (
                  <div style={styles.measurePanel}>
                    <div style={styles.drawerHeading}>Viewport performance</div>
                    <div style={styles.drawerHint}>
                      Rendering quality and live fidelity controls are in the Viewport panel on the right.
                    </div>
                    <button
                      type="button"
                      style={styles.measureAction}
                      disabled={!viewer || benchRunning}
                      onClick={() => void window.__bench?.()}
                    >
                      {benchRunning ? 'Measuring frame pacing…' : 'Measure frame pacing'}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {generationsOpen ? <GenerationsWorkspace
              currentMapId={map.id}
              currentMapHash={editorController?.laneIndex.stats.xodrSha256 ?? null}
              onOpenDraft={openSavedGeneration}
              onSwitchMap={switchToGenerationMap}
              onClose={() => navigateGenerations(false)}
            /> : null}

            {playbackBundle && campaignPlaybackTitle ? (
              <VerifiedReplayBar
                title={campaignPlaybackTitle}
                state={playbackState}
                startTime={playbackBundle.startTime}
                endTime={playbackBundle.endTime}
                onToggle={() => playbackController?.toggle()}
                onStop={returnToGallery}
                cameraOptions={playbackCameraOptions}
                onCameraChange={(option) => playbackController?.selectCamera(option.id, option.policy, option.view)}
              />
            ) : null}

            {selectedPlayback && playbackCameraError ? (
              <div role="alert" style={styles.playbackCameraError} data-testid="playback-camera-error">
                <strong>Playback camera unavailable</strong>
                <span>{playbackCameraError}</span>
              </div>
            ) : null}

            {!mapWorkspaceOpen && (authoringEnabled || playbackBundle) ? (
              <button
                type="button"
                style={{ ...styles.panelToggle, left: leftPanelOpen ? 300 : 64 }}
                aria-label={leftPanelOpen ? 'Hide map and playback panel' : 'Show map and playback panel'}
                aria-pressed={leftPanelOpen}
                onClick={() => setLeftPanelOpen((open) => !open)}
              >
                {leftPanelOpen ? '‹' : 'Map & import'}
              </button>
            ) : null}

            {!mapWorkspaceOpen && (authoringEnabled || playbackBundle) && leftPanelOpen ? (
              <div style={styles.leftRail}>
                <MapPicker current={map} loading={loading} onSelect={selectMap} />
                <PlaybackPanel
                  bundle={playbackBundle}
                  controller={playbackController}
                  state={playbackState}
                  cameraOptions={playbackCameraOptions}
                  cameraError={playbackCameraError}
                  onImport={importPlayback}
                  onClear={() => {
                    setPlaybackBundle(null);
                    setCampaignPlaybackTitle(null);
                    setCampaignCameras(EMPTY_CAMERA_PRESENTATION);
                  }}
                />
              </div>
            ) : null}

            {!mapWorkspaceOpen && settingsOpen ? <div id="studio-settings" style={styles.settingsDrawer}>
              <SettingsPanel
                viewer={viewer}
                overlays={overlays}
                overlayError={overlayError ?? editorError}
                settings={viewSettings}
                onSettingsChange={setViewSettings}
                onResetDefaults={() => setViewSettings(cloneDefaults())}
                onClose={() => setSettingsOpen(false)}
                benchRunning={benchRunning}
                onBench={() => void window.__bench?.()}
                actorCount={playbackState?.actorCount ?? playbackBundle?.actors.length ?? authoredPlayback?.actors.length ?? ambientPreview?.actors.length ?? state?.actors.length ?? 0}
                laneCount={laneStats?.lanes ?? null}
              />
            </div> : null}
            {!mapWorkspaceOpen && authoringEnabled && state?.message ? (
              <div role="status" style={styles.editorNotice} data-testid="editor-notice">{state.message}</div>
            ) : null}
            {showAuthoringChrome && experience === null && state ? (
              <div className="studio-chooser-overlay">
                <EditorExperienceChooser onChoose={chooseExperience} />
              </div>
            ) : null}
          </>
        }
      />
      {editorController ? <InspectorHost
        controller={editorController}
        document={editorController.doc}
        state={state}
        resolveActor={resolveActorRecord}
        physicsFor={(actorId) => physicsForActor(activePhysicsSummary, actorId)}
        suppress={state?.mode === 'drawingRoute'}
        onSelectActor={(actorId) => editorController.setSelection(actorId === null ? [] : [actorId])}
      /> : null}
    </div>
  );
}


function sampledTraceSpeed(bundle: PlaybackBundle, actorId: string, time: number): number {
  const track = bundle.trace.ticks.actors[actorId];
  const times = bundle.trace.ticks.t;
  if (!track || times.length === 0) return 0;
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (times[middle]! <= time) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, track.speedMps[low] ?? 0);
}


function frameEditableActors(viewer: CityViewer | null, template: ScenarioTemplateV2): void {
  if (!viewer) return;
  const poses = template.roles.flatMap((role) => role.kind === 'scene_absolute' ? [role.pose.position] : []);
  if (!poses.length) return;
  const minX = Math.min(...poses.map((pose) => pose.x));
  const maxX = Math.max(...poses.map((pose) => pose.x));
  const minZ = Math.min(...poses.map((pose) => pose.z));
  const maxZ = Math.max(...poses.map((pose) => pose.z));
  const groundY = Math.max(...poses.map((pose) => pose.y));
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const distance = Math.min(240, Math.max(28, Math.hypot(maxX - minX, maxZ - minZ) * 1.15));
  viewer.controls.applyView({
    target: [centerX, groundY + 1.5, centerZ],
    position: [centerX + distance * 0.72, groundY + distance * 0.62, centerZ + distance * 0.72],
    fov: 50,
  });
}

const styles: Record<string, CSSProperties> = {
  root: {
    position: 'fixed',
    inset: 0,
    background: 'var(--ueui-glass-low, rgba(8, 11, 16, 0.94))',
    color: 'var(--ueui-text, #f2f2f2)',
    font: "13px/1.45 'Inter', 'SF Pro Text', system-ui, -apple-system, sans-serif",
  },
  mapPane: {
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
    background: 'var(--ueui-glass-low, rgba(8, 11, 16, 0.94))',
  },
  actorConnector: { position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 27, pointerEvents: 'none', overflow: 'visible' },
  actorDetails: { position: 'absolute', zIndex: 28, width: 304, maxHeight: 'min(620px, calc(100% - 24px))', overflowY: 'auto', boxSizing: 'border-box', padding: 12, border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 'var(--ueui-radius, 10px)', background: 'linear-gradient(180deg, var(--ueui-glass-high, rgba(19, 24, 32, 0.92)), var(--ueui-glass-low, rgba(8, 11, 16, 0.94)))', backdropFilter: 'blur(72px) saturate(185%)', WebkitBackdropFilter: 'blur(72px) saturate(185%)', boxShadow: 'var(--ueui-shadow, 0 18px 48px rgba(0,0,0,.55))', color: 'var(--ueui-text, #f2f2f2)' },
  actorDetailsHeader: { display: 'flex', alignItems: 'flex-start', marginBottom: 12, gap: 8 },
  actorTabs: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3, padding: 3, marginBottom: 12, borderRadius: 7, background: 'rgba(8, 11, 16, 0.55)' },
  actorTab: { padding: '6px 7px', border: 0, borderRadius: 5, background: 'transparent', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10, cursor: 'pointer' },
  actorTabActive: { padding: '6px 7px', border: '1px solid rgba(232,224,68,.5)', borderRadius: 5, background: 'var(--ueui-accent-soft, rgba(232,224,68,.16))', color: 'var(--ueui-text, #f2f2f2)', fontSize: 10, cursor: 'pointer' },
  actorField: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 11, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10 },
  actorPhysics: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '3px 8px', marginBottom: 12, padding: 9, border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 7, background: 'rgba(255,255,255,.03)', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10 },
  colorControl: { display: 'flex', alignItems: 'center', gap: 9, color: 'rgba(242,242,242,.82)' },
  missingAsset: { marginBottom: 9, padding: 7, borderRadius: 6, background: 'rgba(240,161,60,.12)', color: 'var(--ueui-warn, #f0a13c)', fontSize: 9 },
  actorIdentity: { paddingTop: 8, borderTop: '1px solid var(--ueui-line, rgba(255,255,255,.08))', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 9, lineHeight: 1.35 },
  sensorIntro: { marginBottom: 10, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10, lineHeight: 1.4 },
  sensorUnsupported: { marginBottom: 10, padding: 9, border: '1px solid rgba(240,161,60,.3)', borderRadius: 7, background: 'rgba(240,161,60,.08)', color: 'var(--ueui-warn, #f0a13c)', fontSize: 10, lineHeight: 1.4 },
  sensorEmpty: { marginTop: 8, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 9, textAlign: 'center' },
  sensorAdd: { width: '100%', padding: '8px 10px', border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 7, background: 'rgba(255,255,255,.05)', color: 'var(--ueui-text, #f2f2f2)', fontSize: 10, cursor: 'pointer' },
  sensorCard: { marginBottom: 10, padding: 9, border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 7, background: 'rgba(255,255,255,.03)' },
  sensorHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 9, fontSize: 10 },
  sensorEnabled: { display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ueui-text, #f2f2f2)' },
  sensorRemove: { padding: '3px 6px', border: '1px solid rgba(255,107,94,.4)', borderRadius: 5, background: 'rgba(255,107,94,.1)', color: 'var(--ueui-danger, #ff6b5e)', fontSize: 9, cursor: 'pointer' },
  sensorUnit: { display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 6 },
  sensorAdvanced: { color: 'rgba(242,242,242,.78)', fontSize: 10 },
  sensorSectionLabel: { marginTop: 9, marginBottom: 5, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 8, textTransform: 'uppercase', letterSpacing: '.06em' },
  sensorGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6, marginBottom: 7 },
  canvas: { position: 'absolute', inset: 0 },
  toolDrawer: {
    position: 'absolute',
    zIndex: 21,
    top: 12,
    right: 63,
    bottom: 12,
    width: 372,
    overflow: 'hidden',
  },
  galleryDrawer: {
    right: 16,
    width: 'auto',
    maxWidth: 1120,
    bottom: 16,
  },
  measurePanel: {
    width: '100%',
    boxSizing: 'border-box',
    padding: 14,
    borderRadius: 'var(--ueui-radius, 10px)',
    background: 'linear-gradient(180deg, var(--ueui-glass-high, rgba(19, 24, 32, 0.92)), var(--ueui-glass-low, rgba(8, 11, 16, 0.94)))',
    backdropFilter: 'blur(72px) saturate(185%)',
    WebkitBackdropFilter: 'blur(72px) saturate(185%)',
    border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))',
    boxShadow: 'var(--ueui-shadow, 0 18px 48px rgba(0,0,0,.55))',
  },
  drawerHeading: { color: 'var(--ueui-text, #f2f2f2)', fontSize: 15, fontWeight: 650 },
  drawerHint: { marginTop: 3, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10 },
  measureAction: { width: '100%', marginTop: 12, padding: '7px 9px', borderRadius: 8, border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', background: 'rgba(255,255,255,.05)', color: 'var(--ueui-text, #f2f2f2)', font: 'inherit', cursor: 'pointer' },
  playbackCameraError: { position: 'absolute', zIndex: 30, top: 54, left: '50%', transform: 'translateX(-50%)', width: 'min(560px, calc(100vw - 40px))', display: 'flex', flexDirection: 'column', gap: 3, padding: '10px 12px', border: '1px solid rgba(255,107,94,.4)', borderRadius: 'var(--ueui-radius, 10px)', background: 'linear-gradient(180deg, var(--ueui-glass-high, rgba(19, 24, 32, 0.92)), var(--ueui-glass-low, rgba(8, 11, 16, 0.94)))', color: 'var(--ueui-danger, #ff6b5e)', boxShadow: 'var(--ueui-shadow, 0 18px 48px rgba(0,0,0,.55))', fontSize: 11 },
  playbackCameraNotice: { position: 'absolute', zIndex: 24, top: 54, left: '50%', transform: 'translateX(-50%)', width: 'min(560px, calc(100vw - 40px))', display: 'flex', flexDirection: 'column', gap: 3, padding: '8px 11px', border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 'var(--ueui-radius, 10px)', background: 'linear-gradient(180deg, var(--ueui-glass-high, rgba(19, 24, 32, 0.92)), var(--ueui-glass-low, rgba(8, 11, 16, 0.94)))', color: 'var(--ueui-text, #f2f2f2)', boxShadow: 'var(--ueui-shadow, 0 18px 48px rgba(0,0,0,.55))', fontSize: 10 },
  authoredPlaybackCamera: { position: 'absolute', zIndex: 22, top: 12, right: 16, display: 'flex', alignItems: 'center', gap: 7, padding: '7px 9px', border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 8, background: 'linear-gradient(180deg, var(--ueui-glass-high, rgba(19, 24, 32, 0.92)), var(--ueui-glass-low, rgba(8, 11, 16, 0.94)))', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10 },
  panelToggle: {
    position: 'absolute', zIndex: 20, top: 12, minWidth: 34, height: 28,
    padding: '0 8px', border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 8,
    background: 'linear-gradient(180deg, var(--ueui-glass-high, rgba(19, 24, 32, 0.92)), var(--ueui-glass-low, rgba(8, 11, 16, 0.94)))', color: 'var(--ueui-text-muted, #9a9a9a)', font: 'inherit', fontSize: 10,
    boxShadow: '0 4px 14px rgba(0,0,0,.28)', cursor: 'pointer',
  },
  leftRail: {
    position: 'absolute',
    top: 12,
    left: 64,
    bottom: 12,
    width: 228,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  settingsDrawer: {
    position: 'absolute',
    top: 12,
    right: 64,
    bottom: 12,
    width: 'min(336px, calc(100vw - 84px))',
    zIndex: 25,
    overflow: 'hidden',
    filter: 'drop-shadow(0 18px 42px rgba(0,0,0,.5))',
  },
  editorNotice: { position: 'absolute', zIndex: 32, left: '50%', bottom: 14, transform: 'translateX(-50%)', maxWidth: 'min(520px, calc(100% - 32px))', padding: '7px 10px', border: '1px solid rgba(240,161,60,.35)', borderRadius: 8, background: 'linear-gradient(180deg, var(--ueui-glass-high, rgba(19, 24, 32, 0.92)), var(--ueui-glass-low, rgba(8, 11, 16, 0.94)))', color: 'var(--ueui-warn, #f0a13c)', boxShadow: '0 8px 22px rgba(0,0,0,.34)', fontSize: 10, pointerEvents: 'none' },
};
