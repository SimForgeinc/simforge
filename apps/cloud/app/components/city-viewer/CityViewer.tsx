'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/app/components/ui/tooltip';
import * as THREE from 'three/webgpu';
import { CityViewerCore, type ViewerStats, type DefaultCameraPose } from './city-viewer-core';
import { attachBenchmarkApi } from './benchmark-api';
import type { AuditAggregator } from './audit-aggregator';
import { IS_DEV_HUD_BUILD } from './dev-hud-build';
import type { GpuInfo } from './quality';
import {
  createViewerRuntimeWatchdog,
  logViewerMountDiagnostics,
  logViewerStartError,
  logViewerStartSuccess,
  logViewerStartTimeout,
  type ViewerRuntimeWatchdog,
} from './viewer-diagnostics';
import type { FocusTarget } from './geo-utils';
import type { SearchResultMarker } from '@/app/components/map-assets-map/layers/SearchResultMarkersLayer';
import { cleanupLegacyHudStorage } from './legacy-hud-storage-cleanup';
import type { DrawingPathPoint } from './drawing-path';
import { isTap, toNdc, type PointerSample } from './pointer-pick';

const VIEWER_START_WATCHDOG_MS = 15000;

// Build-time-folded dynamic imports of the dev HUDs. Wrapping each `import()`
// in a literal `process.env.NEXT_PUBLIC_ENV !== 'prod'` ternary lets Next.js's
// webpack DefinePlugin constant-fold the branch — production bundles never
// reach these modules and tree-shake them entirely. (`NEXT_PUBLIC_ENV` is
// inlined per-environment from `env-matrix.yml`.)
const ViewerAuditHud =
  process.env.NEXT_PUBLIC_ENV !== 'prod'
    ? dynamic(() => import('./ViewerAuditHud').then((m) => m.ViewerAuditHud), {
        ssr: false,
      })
    : null;
const StatsPanel =
  process.env.NEXT_PUBLIC_ENV !== 'prod'
    ? dynamic(() => import('./StatsPanel').then((m) => m.StatsPanel), {
        ssr: false,
      })
    : null;
const VisualConfigHud =
  process.env.NEXT_PUBLIC_ENV !== 'prod'
    ? dynamic(() => import('./VisualConfigHud').then((m) => m.VisualConfigHud), {
        ssr: false,
      })
    : null;
const ViewerAccordion =
  process.env.NEXT_PUBLIC_ENV !== 'prod'
    ? dynamic(() => import('./ViewerAccordion').then((m) => m.ViewerAccordion), {
        ssr: false,
      })
    : null;
const TwinDetailModePanel =
  process.env.NEXT_PUBLIC_ENV !== 'prod'
    ? dynamic(
        () => import('./TwinDetailModePanel').then((m) => m.TwinDetailModePanel),
        { ssr: false },
      )
    : null;
const ViewerAccordionSection =
  process.env.NEXT_PUBLIC_ENV !== 'prod'
    ? dynamic(
        () => import('./ViewerAccordion').then((m) => m.ViewerAccordionSection),
        { ssr: false },
      )
    : null;

export interface ProximityArrow3D {
  id: string;
  /**
   * Ordered scene-space points the arrow traces. `[from, to]` for spatial
   * relations (single subject→neighbor segment); the full subject + path
   * step sequence for topology relations (`leads_to` and friends), so the
   * 3D viewer can draw the actual route instead of a straight cut-through.
   * Y values are placeholders — `setProximityArrows` snaps each point to
   * the surface via `sampleGroundY`.
   */
  points: Array<{ x: number; y: number; z: number }>;
  /**
   * When true the arrow renders in its emphasized variant (thicker shaft,
   * brighter shade). Driven by the same pin-to-highlight state as the 2D
   * map, so the focused element pops in both views.
   */
  highlight?: boolean;
}

interface Props {
  manifestUrl: string;
  baseAssetsUrl: string;
  /** Hide the development viewer accordion on presentation-only surfaces. */
  showControls?: boolean;
  /** Lift the bottom-right GPU warning above a host surface's primary action. */
  reserveBottomRightActionSpace?: boolean;
  /**
   * Optional override pose. When supplied, it takes precedence over the
   * auto-fit framing computed from `manifest.scene.bounds`. Mirrors the
   * `MapEntry.defaultCamera` field so a map index entry can pin a specific
   * starting view.
   */
  defaultCamera?: DefaultCameraPose;
  focusTarget?: FocusTarget | null;
  resetViewNonce?: number;
  searchResultMarkers?: SearchResultMarker[];
  hoveredSearchResultId?: string | null;
  /**
   * Subject → neighbor arrow data for the currently-focused spatial-search
   * result. Endpoints are already in scene coordinates (meters, lon/lat
   * local) so the viewer doesn't need to know about the map projection.
   */
  proximityArrows?: ProximityArrow3D[];
  /**
   * Planned per-actor trajectories for an AI-proposed scenario draft.
   * Points are already in scene coordinates (meters, lon/lat local); Y is a
   * placeholder snapped to ground by `setActorTrajectories`.
   */
  actorTrajectories?: ActorTrajectory3D[];
  /**
   * Diagnostic collision-point marker — a single red X at the closest-
   * approach point between two actor trajectories. Already in scene
   * coordinates (meters, lon/lat local); Y is a placeholder snapped to
   * ground by `setCollisionMarker`. `null` clears any prior marker.
   */
  collisionMarker?: { x: number; y: number; z: number } | null;
  /**
   * Per-actor spawn-pose markers for the highlighted AI-proposed
   * scenario. Already in scene coordinates; the viewer renders a
   * colored box per vehicle and a capsule per walker, oriented to
   * `yawRad`. `null`/empty clears all markers.
   */
  actorSpawns?: ActorSpawn3D[] | null;
  /**
   * The path being drawn right now, in scene coordinates with real surface
   * heights (they came from `pickGround`). `null` when nothing is being drawn.
   */
  drawingPath?: DrawingPath3D | null;
  /**
   * Called when the author taps the city while drawing is armed, with the scene
   * point the ray struck. Absent means the canvas is display-only, which is
   * every caller that is not the scenario editor.
   *
   * `altKey` rides along because the 2D surface has always used it as the
   * "ignore lane snapping" override, and the two surfaces must not disagree
   * about a modifier.
   */
  onGroundPick?: (
    point: { x: number; y: number; z: number },
    modifiers: { altKey: boolean },
  ) => void;
  /**
   * Live cursor feedback while drawing. Fires on pointer move with the scene
   * point under the pointer, or `null` when the ray misses the city.
   */
  onGroundHover?: (point: { x: number; y: number; z: number } | null) => void;
  /** Reports capabilities backed by metadata that loaded and validated. */
  onCapabilitiesChange?: (capabilities: readonly string[]) => void;
}

export interface DrawingPath3D {
  points: DrawingPathPoint[];
  cursor: { x: number; y: number; z: number } | null;
}

export interface ActorSpawn3D {
  id: string;
  kind: "vehicle" | "walker" | "prop";
  color: string;
  yawRad: number | null;
  point: { x: number; y: number; z: number };
}

export interface ActorTrajectory3D {
  id: string;
  color: string;
  points: Array<{ x: number; y: number; z: number }>;
}

/**
 * Module-level promise that resolves once the previous mount's viewer has
 * finished disposing. The next mount awaits this before constructing a new
 * `CityViewerCore`, which is what prevents the React StrictMode race where
 * two viewers' `start()` chains run in parallel and double-allocate WebGPU
 * resources on the way to OOM.
 */
let lastViewerDispose: Promise<void> = Promise.resolve();


export function CityViewer({
  manifestUrl,
  baseAssetsUrl,
  showControls = true,
  reserveBottomRightActionSpace = false,
  defaultCamera,
  focusTarget,
  resetViewNonce,
  searchResultMarkers,
  hoveredSearchResultId,
  proximityArrows,
  actorTrajectories,
  collisionMarker,
  actorSpawns,
  drawingPath,
  onGroundPick,
  onGroundHover,
  onCapabilitiesChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<CityViewerCore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const [loadingHint, setLoadingHint] = useState<string | null>(null);
  const [loadingProgress, setLoadingProgress] = useState<number | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const [auditAggregator, setAuditAggregator] = useState<AuditAggregator | null>(null);

  useEffect(() => {
    cleanupLegacyHudStorage();
  }, []);

  useEffect(() => {
    onCapabilitiesChange?.([]);
    if (!navigator.gpu && typeof WebGLRenderingContext === 'undefined') {
      setError('Your browser does not support WebGPU or WebGL. Please use a modern browser.');
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    // Create a fresh canvas each mount — avoids stale WebGL context from previous viewer
    const canvas = document.createElement('canvas');
    canvas.className = 'block w-full h-full';
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);

    logViewerMountDiagnostics({
      containerRect: container.getBoundingClientRect(),
      manifestUrl,
      baseAssetsUrl,
    });

    let disposed = false;
    let startSettled = false;
    let runtimeWatchdog: ViewerRuntimeWatchdog | null = null;
    let viewer: CityViewerCore | null = null;
    let detachBenchmark: (() => void) | null = null;
    const startWatchdog = window.setTimeout(() => {
      if (!startSettled && !disposed) logViewerStartTimeout();
    }, VIEWER_START_WATCHDOG_MS);

    // Wait for any previous mount's dispose to finish before allocating.
    // In React StrictMode (dev), the mount → cleanup → mount sequence used
    // to race: viewer #1's async `start()` was still allocating when
    // viewer #2 began allocating, doubling GPU memory.
    const pendingPrevious = lastViewerDispose;

    pendingPrevious
      .catch(() => {})
      .then(() => {
        if (disposed) return;

        viewer = new CityViewerCore();
        viewerRef.current = viewer;

        // Throttle stats updates to ~4Hz to avoid React re-render overhead.
        // The runtime watchdog reuses this same stream — no separate timer.
        let lastStatsTime = 0;
        viewer.onStats((s) => {
          runtimeWatchdog?.observeStats(s);
          const now = performance.now();
          if (now - lastStatsTime > 250) {
            lastStatsTime = now;
            if (!disposed) setStats(s);
          }
        });

        viewer.onLoadingHint((hint) => {
          if (!disposed) setLoadingHint(hint);
        });

        viewer.onLoadingProgress((progress) => {
          if (!disposed) setLoadingProgress(progress);
        });

        return viewer.start(canvas, manifestUrl, baseAssetsUrl, defaultCamera)
          .then(() => {
            startSettled = true;
            window.clearTimeout(startWatchdog);
            if (disposed) return;
            const qs = viewer?.qualitySettings;
            logViewerStartSuccess(
              canvas,
              qs?.gpuInfo ?? null,
              qs?.forceWebGL ? 'forced-webgl' : null,
            );
            if (qs) {
              runtimeWatchdog = createViewerRuntimeWatchdog({
                canvas,
                memoryBudgetBytes: qs.memoryBudgetBytes,
              });
              setGpuInfo(qs.gpuInfo);
            }
            setViewerReady(true);
            onCapabilitiesChange?.(viewer?.getCapabilities() ?? []);
            setAuditAggregator(viewer?.getAuditAggregator() ?? null);
            if (viewer) detachBenchmark = attachBenchmarkApi(viewer);
          })
          .catch((err) => {
            startSettled = true;
            window.clearTimeout(startWatchdog);
            logViewerStartError(err);
            if (disposed) return;
            console.error('[CityViewer] Failed to start:', err);
            setError(`Failed to initialize 3D viewer: ${err instanceof Error ? err.message : String(err)}`);
          });
      });

    // Keyboard shortcut: M for memory dump
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'm' || e.key === 'M') {
        // Don't trigger if typing in an input
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        viewerRef.current?.dumpMemory();
      }
    };
    window.addEventListener('keydown', handleKey);

    // Expose dump function on window for console access
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__cityViewerDump = () => viewerRef.current?.dumpMemory();

    // Listen for vegetation density changes from the Layers Panel
    const handleVegDensity = (e: Event) => {
      const scale = (e as CustomEvent<number>).detail;
      viewerRef.current?.setVegetationDensity(scale);
    };
    window.addEventListener('city-viewer:vegetation-density', handleVegDensity);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      viewerRef.current?.resize(width, height);
    });
    observer.observe(container);

    return () => {
      disposed = true;
      window.clearTimeout(startWatchdog);
      runtimeWatchdog?.dispose();
      runtimeWatchdog = null;
      setViewerReady(false);
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('city-viewer:vegetation-density', handleVegDensity);
      detachBenchmark?.();
      detachBenchmark = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).__cityViewerDump;
      observer.disconnect();
      const v = viewerRef.current;
      if (v) {
        v.dispose();
        // Publish this mount's dispose so the next mount can wait for it.
        // dispose() is sync today, so this resolves immediately — but
        // chaining off `pendingPrevious` keeps the queue serialized in
        // case dispose ever needs an async finalization step.
        lastViewerDispose = pendingPrevious.catch(() => {}).then(() => {});
      }
      viewerRef.current = null;
      canvas.remove();
    };
    // `defaultCamera` is intentionally read once on mount: changing the
    // override mid-session should not snap the camera back to the initial pose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifestUrl, baseAssetsUrl]);

  // Apply focus target when viewer is ready and target changes
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewerReady || !viewer) return;

    if (focusTarget) {
      const pos = new THREE.Vector3(
        focusTarget.position.x,
        focusTarget.position.y,
        focusTarget.position.z,
      );
      viewer.focusOnLocation(pos, focusTarget.radius);
    } else {
      viewer.clearLocationFocus();
    }
  }, [focusTarget, viewerReady]);

  // External reset-view trigger from the parent canvas controls. Skip the
  // initial render so we don't reset the camera before the viewer's natural
  // entry-animation completes.
  const prevResetNonceRef = useRef<number | undefined>(resetViewNonce);
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewerReady || !viewer) return;
    if (resetViewNonce === undefined) return;
    if (resetViewNonce === prevResetNonceRef.current) return;
    prevResetNonceRef.current = resetViewNonce;
    viewer.resetCamera();
  }, [resetViewNonce, viewerReady]);

  // Push search-result pins into the viewer whenever they change.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewerReady || !viewer) return;
    const pins = (searchResultMarkers ?? [])
      .filter((m) => m.scenePosition != null)
      .map((m) => ({ id: m.id, position: m.scenePosition! }));
    viewer.setSearchPins(pins, hoveredSearchResultId ?? null);
  }, [searchResultMarkers, hoveredSearchResultId, viewerReady]);

  // Push proximity arrows into the viewer whenever they change.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewerReady || !viewer) return;
    viewer.setProximityArrows(proximityArrows ?? []);
  }, [proximityArrows, viewerReady]);

  // Push planned actor trajectories into the viewer whenever they change.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewerReady || !viewer) return;
    viewer.setActorTrajectories(actorTrajectories ?? []);
  }, [actorTrajectories, viewerReady]);

  // Diagnostic collision-point marker (closest-approach between two actor
  // trajectories). Cleared by `setCollisionMarker(null)` when no
  // qualifying pair exists.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewerReady || !viewer) return;
    viewer.setCollisionMarker(collisionMarker ?? null);
  }, [collisionMarker, viewerReady]);

  // Per-actor spawn-pose markers for the highlighted AI-proposed
  // scenario. Cleared on null/empty.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewerReady || !viewer) return;
    viewer.setActorSpawnMarkers(actorSpawns ?? null);
  }, [actorSpawns, viewerReady]);

  // The path being drawn. Rebuilt whole on every change, matching every other
  // overlay here: these are tens of meshes, not thousands, and a diffing
  // scheme would be the only stateful thing in the file.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewerReady || !viewer) return;
    viewer.setDrawingPath(drawingPath ?? null);
  }, [drawingPath, viewerReady]);

  // Pointer picking. Attached only while a pick handler exists, so the viewer
  // costs nothing on the read-only surfaces that make up every other caller.
  //
  // The listeners go on the CONTAINER rather than the canvas: the camera
  // controller owns the canvas and calls `setPointerCapture` on drag, which
  // would swallow the release we need to measure.
  useEffect(() => {
    const container = containerRef.current;
    if (!viewerReady || !container || !onGroundPick) return;

    let down: PointerSample | null = null;

    const sceneHitAt = (clientX: number, clientY: number) => {
      const viewer = viewerRef.current;
      if (!viewer) return null;
      const ndc = toNdc(container.getBoundingClientRect(), clientX, clientY);
      if (!ndc) return null;
      return viewer.pickGround(ndc.ndcX, ndc.ndcY);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      down = {
        clientX: event.clientX,
        clientY: event.clientY,
        timeStamp: event.timeStamp,
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!onGroundHover) return;
      onGroundHover(sceneHitAt(event.clientX, event.clientY));
    };

    const onPointerUp = (event: PointerEvent) => {
      const pressed = down;
      down = null;
      if (event.button !== 0 || !pressed) return;
      const released = {
        clientX: event.clientX,
        clientY: event.clientY,
        timeStamp: event.timeStamp,
      };
      if (!isTap(pressed, released)) return;
      const hit = sceneHitAt(event.clientX, event.clientY);
      // A miss is the author clicking the sky. Placing nothing is the honest
      // response; clamping to the ground plane would drop a point on the
      // horizon at a distance they never chose.
      if (hit) onGroundPick(hit, { altKey: event.altKey });
    };

    const onPointerLeave = () => {
      down = null;
      onGroundHover?.(null);
    };

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointerleave', onPointerLeave);
    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [onGroundHover, onGroundPick, viewerReady]);

  if (error) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-background/50">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10 border border-destructive/20">
          <AlertTriangle className="size-8 text-destructive" />
        </div>
        <div className="text-center max-w-md">
          <p className="text-sm font-semibold text-foreground">3D Viewer Unavailable</p>
          <p className="mt-1 text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  const showGpuWarning = gpuInfo && gpuInfo.tier !== 'high';

  return (
    <div ref={containerRef} className="absolute inset-0">
      {showGpuWarning && (
        <TooltipProvider delayDuration={200}>
          {bannerDismissed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setBannerDismissed(false)}
                  className={`absolute z-10 flex size-8 items-center justify-center rounded-full border border-yellow-500/30 bg-background/80 text-yellow-500 shadow-md backdrop-blur-sm transition-colors hover:bg-background/95 ${reserveBottomRightActionSpace ? 'bottom-24 right-8' : 'bottom-3 right-3'}`}
                >
                  <AlertTriangle className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs text-xs">
                Some visual effects and data layers are not shown. Click to learn more.
              </TooltipContent>
            </Tooltip>
          ) : (
            <div className={`absolute z-10 flex justify-end pointer-events-none ${reserveBottomRightActionSpace ? 'bottom-24 right-8' : 'bottom-3 right-3'}`}>
              <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-yellow-500/30 bg-background/90 backdrop-blur-sm px-3 py-1.5 shadow-md">
                <AlertTriangle className="size-3.5 shrink-0 text-yellow-500" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <p className="text-xs text-muted-foreground cursor-default">
                      Some visual effects and data layers are not displayed for your GPU
                    </p>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs text-xs">
                    Your GPU does not support full-quality rendering. Vegetation density, post-processing, and shadows have been reduced to keep the viewer running smoothly.
                  </TooltipContent>
                </Tooltip>
                <button
                  onClick={() => setBannerDismissed(true)}
                  className="shrink-0 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          )}
        </TooltipProvider>
      )}
      {showControls && ViewerAccordion ? (
        <ViewerAccordion>
          {VisualConfigHud ? (
            <VisualConfigHud onSunCommit={() => viewerRef.current?.commitSunShadow()} />
          ) : null}
          {IS_DEV_HUD_BUILD &&
          stats &&
          StatsPanel &&
          ViewerAccordionSection ? (
            <ViewerAccordionSection id="stats" title="Stats" kind="dev">
              <StatsPanel
                stats={stats}
                onDump={() => viewerRef.current?.dumpMemory()}
              />
            </ViewerAccordionSection>
          ) : null}
          {IS_DEV_HUD_BUILD && TwinDetailModePanel && ViewerAccordionSection ? (
            <ViewerAccordionSection id="detail-mode" title="Detail mode" kind="dev">
              <TwinDetailModePanel />
            </ViewerAccordionSection>
          ) : null}
          {IS_DEV_HUD_BUILD && ViewerAuditHud && auditAggregator ? (
            <ViewerAuditHud aggregator={auditAggregator} />
          ) : null}
        </ViewerAccordion>
      ) : null}
      {loadingHint && (
        <div
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex flex-col rounded-lg border border-border bg-background/80 backdrop-blur-sm shadow-md overflow-hidden"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-2 px-3 py-2">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground whitespace-nowrap">{loadingHint}</span>
          </div>
          <div
            className="h-1 w-full bg-muted/50"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={loadingProgress === null ? undefined : Math.round(loadingProgress * 100)}
            aria-valuetext={loadingProgress === null ? loadingHint ?? undefined : `${loadingHint} ${Math.round(loadingProgress * 100)}%`}
          >
            {loadingProgress === null ? (
              <div className="h-full w-1/3 bg-primary/60 rounded-full animate-shimmer" />
            ) : (
              <div
                className="h-full bg-primary/80 transition-all duration-300 ease-out"
                style={{ width: `${Math.round(loadingProgress * 100)}%` }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
