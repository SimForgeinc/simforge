import * as THREE from 'three/webgpu';
import { CityRenderer } from './renderer/renderer';
import { CameraController } from './camera/camera-controller';
import { TileManager, type StreamingPipeline } from './streaming/tile-manager';
import { setMaxTextureSize, loadTileGLB, disposeTileGroup, setDownscaleObserver, resetTileLoader, configureKtx2Support } from './streaming/tile-loader';
import { parseCityAssetVariants, type CityAssetVariants } from './asset-variants';
import { parseManifest } from './manifest-parser';
import {
  parseStaticSemantics,
  STATIC_SEMANTICS_CAPABILITY,
  type StaticSemantics,
} from './static-semantics';
import { sha256Hex } from '@/app/lib/maps/frontend/map-asset-cache';
import { clearVegetationInstanceCache } from './streaming/vegetation-loader';
import { detectQuality, type QualitySettings } from './quality';
import { MemoryProfiler, type MemoryMetrics, recordHeapBaseline, computeMemoryGuardLimits } from './memory-profiler';
import { createLocationMarker, disposeMarkerGroup } from './location-marker';
import { createSearchPin, disposeSearchPinGroup } from './search-pin';
import { createProximityArrow, disposeProximityArrow } from './proximity-arrow';
import { createTrajectoryLine, disposeTrajectoryLine } from './actor-trajectory';
import {
  createDrawingPath,
  disposeDrawingPath,
  type DrawingPathPoint,
} from './drawing-path';
import {
  collectUniqueMaterialSamples,
  pickPrewarmSampleTileFiles,
  prewarmShaders,
  DEFAULT_BOOT_PREWARM_BUDGET_MS,
} from './shader-prewarm';
import { computeAutoFitCamera } from './camera-fit';
import { AuditAggregator } from './audit-aggregator';
import { IS_DEV_HUD_BUILD } from './dev-hud-build';
import { applyLayerMaterials } from './layer-material-applier';
import { loadVisualConfig, subscribeVisualConfig, type VisualConfig } from './visual-config';
import { applyLiveConfig, applySunCommit } from './live-applier';
import {
  StreamingMetricsCollector,
  type StreamingMetrics,
} from './streaming/streaming-metrics';
import {
  setTextureRegistrationCallback,
  setTextureUnregistrationCallback,
  setTexturePoolFrozen,
  clearTexturePool,
} from './streaming/texture-pool';
import {
  installLeakInstrumentation,
  type InstalledLeakInstr,
} from './streaming/leak-instrumentation';
import type { Manifest, Vec3 } from './types';
import {
  buildStreamingPipeline,
  buildBudgetLedger,
} from './viewer-streaming-factory';
import { getDebugFlags } from './streaming/debug-flags';
import {
  buildCollisionMarkerGroup,
  disposeCollisionMarkerGroup,
  buildSpawnMesh,
  disposeActorSpawnsGroup,
  type SpawnDescriptor,
} from './actor-overlays';

/**
 * Caller-supplied camera override. When present, takes precedence over
 * auto-fit (mirrors `MapEntry.defaultCamera` semantics).
 */
export interface DefaultCameraPose {
  position: Vec3;
  target: Vec3;
}

export type { MemoryMetrics, StreamingMetrics };

export interface ViewerStats {
  fps: number;
  triangles: number;
  drawCalls: number;
  tilesLoaded: number;
  tilesTotal: number;
  /** Tile cache tracked bytes */
  tileCacheMB: number;
  /** Chrome JS heap usage (0 if unavailable) */
  jsHeapMB: number;
  /** Deep memory profiling metrics */
  memory: MemoryMetrics;
  /**
   * Streaming-pacing metrics snapshot. Always populated; values stay
   * zero/nominal until the orchestration layer (#08) wires the source
   * modules into the collector. Co-resident with `memory` — both are
   * observe-only diagnostic feeds.
   */
  streaming: StreamingMetrics;
}

/**
 * Core viewer controller — a React-friendly adaptation of the city-digital-twin App class.
 * Accepts explicit canvas/URL args instead of reading from DOM/URL params.
 * Call start() to initialize, dispose() to tear down.
 */
export class CityViewerCore {
  private renderer!: CityRenderer;
  private cameraCtrl!: CameraController;
  private tileManager!: TileManager;
  private profiler = new MemoryProfiler();
  private frustum = new THREE.Frustum();
  private projScreenMatrix = new THREE.Matrix4();
  private rafHandle = 0;
  private fpsInterval = 0;      // ms between frames (0 = uncapped)
  private lastFrameTime = 0;
  private statsFrameCount = 0;
  private statsFpsAccum = 0;
  private statsDisplayFps = 0;
  private _onStats: ((stats: ViewerStats) => void) | null = null;
  private _onLoadingHint: ((hint: string | null) => void) | null = null;
  private _onLoadingProgress: ((progress: number | null) => void) | null = null;
  private _capabilities: readonly string[] = [];
  private _groundY = 0;
  private markerGroup: THREE.Group | null = null;
  private searchPinsGroup: THREE.Group | null = null;
  private proximityArrowsGroup: THREE.Group | null = null;
  private actorTrajectoriesGroup: THREE.Group | null = null;
  /** Single red-X group marking the AI-derived collision point (closest
   *  approach between two actor trajectories). One per scene; null when
   *  no draft is proposed or no pair came within the diagnostic threshold. */
  private collisionMarkerGroup: THREE.Group | null = null;
  /** Per-actor 3D spawn markers — a colored box per vehicle, a capsule
   *  per walker, etc. Companion to `actorTrajectoriesGroup`; together
   *  they answer "where does each actor start + where does it go" for a
   *  highlighted AI-proposed draft. */
  private actorSpawnsGroup: THREE.Group | null = null;
  /** The path being drawn right now, if any. Null whenever drawing is disarmed. */
  private drawingPathGroup: THREE.Group | null = null;
  private _raycaster = new THREE.Raycaster();
  private _downDir = new THREE.Vector3(0, -1, 0);
  private _audit: AuditAggregator | null = null;
  private _lastCacheStatsPollMs = 0;
  private _unsubVisualConfig: (() => void) | null = null;
  private _liveApplyHandle: number | null = null;
  private _lastVegetationDensity = 1;
  private _disposed = false;
  private _streamingMetrics = new StreamingMetricsCollector();
  private _streamingFrameCount = 0;
  // Streaming pipeline (issue #08) — constructed in start() for non-low-tier
  // quality, injected into the tile manager so its update() routes through
  // prefetch queue → activation gate → degradation controller. Held here so
  // dispose() can break references and the per-frame loop can pump live
  // metrics into the streaming-metrics collector.
  private _streamingPipeline: StreamingPipeline | null = null;
  private _leakInstr: InstalledLeakInstr | null = null;
  // Eviction-counter delta — feeds `recordEviction()` once per new eviction
  // the tile cache reports. Without this the streaming HUD's evicted counter
  // stays pinned at 0 even while the breaker is firing.
  private _lastEvictionCount = 0;
  qualitySettings: QualitySettings | null = null;

  /** Has dispose() been invoked? Used by start() to bail mid-allocation. */
  get isDisposed(): boolean { return this._disposed; }

  async start(
    canvas: HTMLCanvasElement,
    manifestUrl: string,
    baseAssetsUrl: string,
    defaultCamera?: DefaultCameraPose,
  ): Promise<void> {
    // Bail-on-disposed checkpoints below. Without them, the React StrictMode
    // mount → cleanup → mount sequence races: viewer A's start() may still
    // be awaiting `detectQuality` / `renderer.init` after dispose has run,
    // and would happily allocate a WebGPU device on a canvas that's about
    // to be removed — exactly the doubled-allocation pattern surfaced by
    // the leak hunt.
    if (this._disposed) return;
    this._capabilities = [];

    const hint = (msg: string | null) => this._onLoadingHint?.(msg);

    recordHeapBaseline();

    // Leak instrumentation (ABH-41) — patches THREE constructors, gated by
    // `?debug=1&leaktest=1`; no-op in prod.
    if (typeof window !== 'undefined') {
      this._leakInstr = installLeakInstrumentation({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        THREE: THREE as any,
        windowRef: window as unknown as Record<string, unknown>,
      });
    }

    // Detect GPU capabilities and pick quality tier
    hint('Detecting GPU capabilities…');
    const quality = await detectQuality();
    if (this._disposed) return;
    this.qualitySettings = quality;
    setMaxTextureSize(quality.maxTextureSize);

    // Audit aggregator (#07) — dev-only metrics sink.
    if (IS_DEV_HUD_BUILD) {
      this._audit = new AuditAggregator();
      this._audit.recordQualityTier(quality.tier, quality.gpuInfo.reason);
      setDownscaleObserver((event) => {
        this._audit?.recordTextureDownscale(event);
      });
    }

    if (quality.fpsLimit > 0) {
      this.fpsInterval = 1000 / quality.fpsLimit;
    }

    hint('Initializing renderer…');
    this.renderer = new CityRenderer();
    await this.renderer.init(canvas, quality);
    if (this._disposed) {
      // We allocated a renderer (and possibly a WebGPU device) — release it
      // before returning so the bailed-out attempt doesn't leak.
      safeCall(() => this.renderer.dispose());
      return;
    }

    this.renderer.initPostProcessing();

    // Visual-config live tuning (#03 + #04): coalesced to one rAF tick.
    // Gated to dev/staging so these modules tree-shake from production.
    if (IS_DEV_HUD_BUILD) {
      this._lastVegetationDensity = loadVisualConfig().layers.vegetation.density;
      this._unsubVisualConfig = subscribeVisualConfig((cfg) => {
        if (this._liveApplyHandle !== null) return;
        this._liveApplyHandle = requestAnimationFrame(() => {
          this._liveApplyHandle = null;
          if (!this.renderer) return;
          applyLiveConfig(this.renderer.getLiveHandles(), cfg);
          this.applyVisualConfig(cfg);
        });
      });
    }

    this.cameraCtrl = new CameraController(this.renderer.camera, canvas);

    hint('Loading scene data…');
    let rawManifest: unknown = null;
    let assetVersion: string | undefined;
    let variants: CityAssetVariants | null = null;
    // Kicked in parallel with the main manifest; resolved before the tile
    // manager needs it. Token-less on purpose: for the browser-assets base
    // the gateway caches it by URL, and for the 3d-asset base the version
    // token doesn't exist until the main manifest bytes arrive.
    const variantsPromise: Promise<CityAssetVariants | null> = fetch(
      `${baseAssetsUrl}/variants/manifest.json`,
    )
      .then(async (res) => (res.ok ? parseCityAssetVariants(await res.json()) : null))
      .catch(() => null);
    try {
      const res = await fetch(manifestUrl);
      if (this._disposed) {
        safeCall(() => this.cameraCtrl.dispose());
        safeCall(() => this.renderer.dispose());
        return;
      }
      if (res.ok) {
        const bytes = await res.arrayBuffer();
        // Version-token the asset URLs ONLY for the mutable 3d-asset base.
        // Those paths are rebuilt in place, so the manifest-bytes hash is
        // what lets the map-asset-cache gateway serve tiles from Cache
        // Storage without ever serving a stale build: rebuild → new manifest
        // bytes → new token → every asset URL misses and refetches.
        // Uniscenario browser-assets bases are content-versioned by
        // mapVersionId and MUST stay token-less: the "Cache all maps"
        // prepare flow warms the gateway under the bare URLs, and adding a
        // token here would turn every prepared asset into a URL-index miss
        // (a full re-download of what was just cached).
        if (/\/api\/map-assets\/[^/]+\/3d-asset\//.test(manifestUrl)) {
          assetVersion = (await sha256Hex(bytes))?.slice(0, 16) ?? undefined;
        }
        rawManifest = JSON.parse(new TextDecoder().decode(bytes));
      }
      if (this._disposed) {
        safeCall(() => this.cameraCtrl.dispose());
        safeCall(() => this.renderer.dispose());
        return;
      }
    } catch {
      console.warn('[CityViewer] Failed to load manifest from', manifestUrl);
    }

    let staticSemantics: StaticSemantics | null = null;
    if (rawManifest !== null) {
      try {
        const parsedManifest = parseManifest(rawManifest);
        if (parsedManifest.staticSemantics) {
          const suffix = assetVersion ? `?v=${encodeURIComponent(assetVersion)}` : '';
          const response = await fetch(
            `${baseAssetsUrl}/${parsedManifest.staticSemantics.file}${suffix}`,
          );
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          staticSemantics = parseStaticSemantics(await response.json());
          this._capabilities = [STATIC_SEMANTICS_CAPABILITY];
        }
      } catch (error) {
        console.warn('[CityViewer] Static semantics unavailable:', error);
      }
    }

    // Load environment map asynchronously — non-blocking
    hint('Loading environment…');
    this.renderer.loadEnvironment(baseAssetsUrl, assetVersion);

    // Pass null renderer to TileManager when skipping compileAsync
    const memoryGuardLimits = computeMemoryGuardLimits(quality.memoryBudgetBytes);

    this.tileManager = new TileManager(
      this.renderer.scene,
      this.renderer.camera,
      quality.skipCompileAsync ? undefined : this.renderer.renderer,
      memoryGuardLimits,
    );
    this.tileManager.applyQuality(quality);
    this.tileManager.setStaticSemantics(staticSemantics);
    if (IS_DEV_HUD_BUILD && this._audit) {
      this.tileManager.setAuditAggregator(this._audit);
    }

    // Wire streaming pipeline for non-low tiers; low tier uses budget ledger only.
    if (quality.tier !== 'low') {
      this._streamingPipeline = buildStreamingPipeline({
        quality,
        renderer: this.renderer,
        tileManager: this.tileManager,
        profiler: this.profiler,
        streamingMetrics: this._streamingMetrics,
        isDisposed: () => this._disposed,
      });
      this.tileManager.setStreamingPipeline(this._streamingPipeline);
    } else {
      const debugFlags = getDebugFlags();
      const lowTierLedger = buildBudgetLedger({ quality, renderer: this.renderer, debugFlags });
      this.renderer.setBudgetLedger(lowTierLedger);
      this.tileManager.setBudgetLedger(lowTierLedger);
    }

    // Pipeline variants (KTX2 GLBs + merged vegetation instances) must be
    // registered BEFORE loadManifest — loadManifest kicks the static-layer
    // fetch immediately, and the road GLB is the single biggest asset the
    // KTX2 substitution can shrink. Maps without a variants manifest keep
    // the authored-asset path.
    variants = await variantsPromise;
    if (this._disposed) return;
    let useKtx2 = false;
    if (variants?.ktx2TranscoderPath && !quality.forceWebGL) {
      // Verify the transcoder assets are actually reachable before letting
      // any tile resolve to a KTX2 variant — a missing transcoder would
      // fail every parse instead of degrading quality.
      const checks = await Promise.all(
        variants.ktx2RuntimeAssets.map((file) =>
          fetch(`${baseAssetsUrl}/${file}`)
            .then((r) => r.ok)
            .catch(() => false),
        ),
      );
      if (this._disposed) return;
      if (checks.length > 0 && checks.every(Boolean)) {
        useKtx2 = configureKtx2Support(
          this.renderer.renderer,
          `${baseAssetsUrl}/${variants.ktx2TranscoderPath}`,
        );
      }
    }
    this.tileManager.setVariants(variants, useKtx2);
    if (variants) {
      console.log(
        `[CityViewer] Variants: ktx2=${useKtx2 ? variants.ktx2Files.size : 0} files, mergedVegInstances=${variants.vegetationInstancesFile ? 'yes' : 'no'}`,
      );
    }

    let manifest: Manifest | null = null;
    if (rawManifest !== null) {
      try {
        this.tileManager.loadManifest(rawManifest, baseAssetsUrl, assetVersion);
        manifest = this.tileManager.getManifest();
      } catch (err) {
        console.error('[CityViewer] Manifest validation failed:', err);
      }
    }

    if (manifest) {

      // Position camera. `defaultCamera` (mirrors `MapEntry.defaultCamera`)
      // takes precedence when supplied; otherwise auto-fit to scene.bounds.
      const b = manifest.scene.bounds;
      const extent = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]);
      // Ground level is at the scene origin Y (typically 0), not b.min[1]
      // which is the bottom of the bounding box and may be underground.
      const groundY = manifest.scene.origin?.[1] ?? 0;
      this._groundY = groundY;

      const pose = defaultCamera ?? computeAutoFitCamera(b, groundY, {
        fovDegrees: this.renderer.camera.fov,
        aspectRatio: this.renderer.camera.aspect,
      });

      this.renderer.camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
      this.renderer.camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);

      const lookAt = new THREE.Vector3(pose.target[0], pose.target[1], pose.target[2]);
      this.cameraCtrl.setSceneBounds(groundY, extent);
      this.cameraCtrl.resetToCamera(lookAt);
      this.renderer.enableShadows(manifest.scene.bounds);

      if (quality.shadows) {
        this.tileManager.onReady(() => {
          // Walk the scene, but skip vegetation subtrees so the vegetation
          // loader's per-tile `castShadow` write (which honors the saved
          // `vegetation.castShadows` RELOAD knob from #05) isn't clobbered
          // back to `true` here. Asset + road meshes still get the
          // unconditional broadcast.
          const walk = (obj: THREE.Object3D): void => {
            if (obj.userData?.['layerKind'] === 'vegetation') return;
            if ((obj as THREE.Mesh).isMesh) (obj as THREE.Mesh).castShadow = true;
            for (const child of obj.children) walk(child);
          };
          walk(this.renderer.scene);
          this.renderer.sun.shadow.needsUpdate = true;
          console.log('[CityViewer] Shadow map bake triggered');
        });
      }

      // Phase 1: Load roads first — full bandwidth, no competing downloads
      hint('Loading roads…');
      this._onLoadingProgress?.(null);
      this.tileManager.onStaticProgress((loaded, total) => {
        this._onLoadingProgress?.(total > 0 ? loaded / total : null);
      });
      await this.tileManager.preloadStaticLayers();
      if (this._disposed) return;

      // Apply any saved per-layer multipliers to the road static layer now that
      // it's in-scene. New tiles streamed in after `preloadTiles()` get a
      // second pass below; mid-session LOD swaps rely on the user's next
      // slider tweak to refresh — acceptable for #04 since multipliers are a
      // dev-only tuning surface.
      if (IS_DEV_HUD_BUILD) {
        this.applyVisualConfig(loadVisualConfig());
      }

      // Pre-warm GPU PSOs: static layers + sampled building/vegetation tiles.
      // See ADR-0003. Skipped when skipCompileAsync is set.
      if (!quality.skipCompileAsync) {
        const staticFiles = new Set(manifest.staticLayers.map((l) => l.file));
        const extraFiles = pickPrewarmSampleTileFiles(manifest).filter(
          (f) => !staticFiles.has(f),
        );

        const sampledGroups: THREE.Group[] = [];
        const samplerCtrl = new AbortController();
        const settled = await Promise.allSettled(
          extraFiles.map((file) =>
            loadTileGLB(
              // Resolve through the tile-manager so the sample fetch shares
              // a cache entry (same variant substitution + `?v=` token) with
              // the streaming fetch of the same file — and prewarm compiles
              // against the texture format the scene will actually use.
              this.tileManager.resolveAssetUrl(file),
              samplerCtrl.signal,
            ),
          ),
        );
        for (const r of settled) {
          if (r.status === 'fulfilled') sampledGroups.push(r.value.group);
        }

        const staticContainer = this.tileManager.getStaticContainer();
        const samples = collectUniqueMaterialSamples([staticContainer, ...sampledGroups]);
        if (samples.length > 0) {
          await prewarmShaders(this.renderer.renderer, samples, {
            budgetMs: DEFAULT_BOOT_PREWARM_BUDGET_MS,
          });
        }

        // Sampled tile groups were never added to a scene; release their
        // geometry/textures so they don't sit on the GPU until tile-manager
        // re-fetches them through its normal LRU-cached path.
        for (const group of sampledGroups) {
          disposeTileGroup(group);
        }
      }
      if (this._disposed) return;

      // Roads are ready — start rendering immediately so the user sees them
      this.renderer.clock.start();
      this.lastFrameTime = performance.now();
      this.loop();

      // Phase 2: Load building + vegetation tiles in the background
      hint(`Loading tiles… 0/${this.tileManager.totalCount}`);
      this._onLoadingProgress?.(this.tileManager.totalCount > 0 ? 0 : null);
      this.tileManager.onProgress((loaded, total) => {
        hint(`Loading tiles… ${loaded}/${total}`);
        this._onLoadingProgress?.(total > 0 ? loaded / total : 1);
      });
      this.tileManager.preloadTiles().then(() => {
        hint(null);
        this._onLoadingProgress?.(null);
        if (IS_DEV_HUD_BUILD) {
          this.applyVisualConfig(loadVisualConfig());
        }
      });
    } else {
      console.warn('[CityViewer] No manifest loaded — viewer will render empty scene');
      hint(null);
      this.renderer.clock.start();
      this.lastFrameTime = performance.now();
      this.loop();
    }
  }

  private loop = (): void => {
    this.rafHandle = requestAnimationFrame(this.loop);

    // ABH-111: advance deferred-disposal before FPS throttle so the queue
    // drains even on skipped frames (items are safe after swap-chain present).
    this.tileManager.advancePendingDisposals();

    // FPS throttle: skip frame if not enough time has elapsed
    if (this.fpsInterval > 0) {
      const now = performance.now();
      if (now - this.lastFrameTime < this.fpsInterval) return;
      this.lastFrameTime = now;
    }

    const dt = Math.min(this.renderer.clock.getDelta(), 0.05);

    this.cameraCtrl.update(dt);

    this.renderer.camera.updateMatrixWorld();
    this.projScreenMatrix.multiplyMatrices(
      this.renderer.camera.projectionMatrix,
      this.renderer.camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    this.tileManager.update(this.renderer.camera, this.frustum);

    this.renderer.info.reset();
    this.renderer.render();

    // Collect memory profiling (internally throttled) and feed GPU estimate to tile manager
    const memMetrics = this.profiler.collect(this.renderer.renderer, this.renderer.scene, {
      shadows: this.qualitySettings?.shadows ?? false,
      shadowResolution: this.qualitySettings?.shadowResolution ?? 0,
      postProcessing: this.qualitySettings?.postProcessing ?? false,
    });
    this.tileManager.updateGpuEstimate(memMetrics.gpuTotalMB);

    // Audit (#07) — observe-only feed; cache stats polled at ~4 Hz.
    if (IS_DEV_HUD_BUILD && this._audit) {
      const info = this.renderer.info;
      this._audit.recordFrame({
        frameTimeMs: dt * 1000,
        drawCalls: info.render?.calls ?? 0,
        gpuTotalMB: memMetrics.gpuTotalMB,
        vegetationInstances: this.tileManager.countVegetationInstances(),
      });
      const nowMs = performance.now();
      if (nowMs - this._lastCacheStatsPollMs >= 250) {
        this._lastCacheStatsPollMs = nowMs;
        this._audit.recordCacheStats(this.tileManager.getCacheStats(), nowMs);
      }
    }

    // Streaming-pacing metrics (#10) — emit rolling fps window every 3 s.
    this._streamingFrameCount++;
    this._streamingMetrics.recordFrameDelta(dt * 1000);

    const pipeline = this._streamingPipeline;
    if (pipeline) {
      // ABH-114: latch non-tile freeze before publishing ledger state.
      pipeline.budgetLedger.tickNonTileFreeze();
      setTexturePoolFrozen(pipeline.budgetLedger.isNonTileFrozen);

      this._streamingMetrics.setBudget(
        pipeline.budgetLedger.effectiveBudget,
        pipeline.budgetLedger.currentBytes,
      );
      this._streamingMetrics.setBytesByCategory(
        pipeline.budgetLedger.bytesByCategory(),
      );
      this._streamingMetrics.setQueueDepth(pipeline.prefetchQueue.size);
      this._streamingMetrics.setDegradationState(
        pipeline.degradationController.state,
      );
      const stats = this.tileManager.getCacheStats();
      while (this._lastEvictionCount < stats.evictionCount) {
        this._streamingMetrics.recordEviction();
        this._lastEvictionCount++;
      }
    }

    this._streamingMetrics.maybeEmit(this._streamingFrameCount);

    // Emit stats to React
    if (this._onStats) {
      this.statsFrameCount++;
      this.statsFpsAccum += 1 / Math.max(dt, 0.001);
      if (this.statsFrameCount >= 10) {
        this.statsDisplayFps = Math.round(this.statsFpsAccum / this.statsFrameCount);
        this.statsFrameCount = 0;
        this.statsFpsAccum = 0;
      }
      const info = this.renderer.info;
      this._onStats({
        fps: this.statsDisplayFps,
        triangles: info.render?.triangles ?? 0,
        drawCalls: info.render?.calls ?? 0,
        tilesLoaded: this.tileManager.loadedCount,
        tilesTotal: this.tileManager.totalCount,
        tileCacheMB: this.tileManager.memoryUsageMB,
        jsHeapMB: memMetrics.jsHeapUsedMB,
        memory: memMetrics,
        streaming: this._streamingMetrics.snapshot(this._streamingFrameCount),
      });
    }
  };

  onStats(cb: (stats: ViewerStats) => void): void {
    this._onStats = cb;
  }

  getCapabilities(): readonly string[] {
    return this._capabilities;
  }

  /**
   * Returns the streaming-metrics collector so the orchestration layer (#08)
   * can wire the budget ledger, degradation controller, prefetch queue, and
   * reconciliation poller into the live-value setters.
   */
  getStreamingMetricsCollector(): StreamingMetricsCollector {
    return this._streamingMetrics;
  }

  onLoadingHint(cb: (hint: string | null) => void): void {
    this._onLoadingHint = cb;
  }

  onLoadingProgress(cb: (progress: number | null) => void): void {
    this._onLoadingProgress = cb;
  }

  resetCamera(): void {
    this.cameraCtrl?.resetView();
  }

  getCameraPose(): { position: [number, number, number]; target: [number, number, number] } | null {
    if (!this.renderer?.camera || !this.cameraCtrl) return null;
    const p = this.renderer.camera.position;
    const t = this.cameraCtrl.getTarget();
    return {
      position: [p.x, p.y, p.z],
      target: [t.x, t.y, t.z],
    };
  }

  setCameraPose(pose: { position: [number, number, number]; target: [number, number, number] }): void {
    if (!this.renderer?.camera || !this.cameraCtrl) return;
    this.renderer.camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
    const target = new THREE.Vector3(pose.target[0], pose.target[1], pose.target[2]);
    this.renderer.camera.lookAt(target);
    this.cameraCtrl.resetToCamera(target);
  }

  /** Adjust vegetation density at runtime (0–1). Instant, no re-loading. */
  setVegetationDensity(scale: number): void {
    this.tileManager?.setVegetationDensity(scale);
    this._lastVegetationDensity = scale;
  }

  /**
   * Apply the LIVE knobs from a `VisualConfig` snapshot. Per-layer PBR
   * multipliers go through `applyLayerMaterials`; vegetation density is
   * reconciled against the last-applied value to avoid retraversing the
   * vegetation tile cache on no-op patches.
   *
   * Called from the rAF-coalesced subscription above and from the
   * post-tile-load hooks. Tree-shaken from prod via callers that gate on
   * `IS_DEV_HUD_BUILD`.
   */
  private applyVisualConfig(cfg: VisualConfig): void {
    if (!this.renderer) return;
    applyLayerMaterials(this.renderer.scene, cfg.layers);
    const density = cfg.layers.vegetation.density;
    if (density !== this._lastVegetationDensity) {
      this._lastVegetationDensity = density;
      this.tileManager?.setVegetationDensity(density);
    }
  }

  resize(width: number, height: number): void {
    if (!this.renderer?.camera) return;
    this.renderer.onResize(width, height);
  }

  get groundY(): number {
    return this._groundY;
  }

  /**
   * True when this hit is on one of OUR overlay groups rather than on the city
   * itself. Markers, pins and the path being drawn all sit slightly above the
   * surface, so a ray that strikes one of them would otherwise report the
   * overlay's height as the ground — and, for pointer picking, would let a path
   * point land on top of the previous path point.
   */
  private isOverlayHit(object: THREE.Object3D): boolean {
    let obj: THREE.Object3D | null = object;
    while (obj) {
      if (
        obj === this.markerGroup ||
        obj === this.searchPinsGroup ||
        obj === this.proximityArrowsGroup ||
        obj === this.actorTrajectoriesGroup ||
        obj === this.collisionMarkerGroup ||
        obj === this.actorSpawnsGroup ||
        obj === this.drawingPathGroup
      ) {
        return true;
      }
      obj = obj.parent;
    }
    return false;
  }

  /** Raycast downward to find the ground/road surface height at an XZ position. */
  private sampleGroundY(x: number, z: number): number {
    // Cast from well above the scene straight down
    this._raycaster.set(new THREE.Vector3(x, 500, z), this._downDir);
    this._raycaster.far = 1000;
    const hits = this._raycaster.intersectObject(this.renderer.scene, true);
    for (const hit of hits) {
      if (!this.isOverlayHit(hit.object)) return hit.point.y;
    }
    return this._groundY;
  }

  /**
   * Where a pointer at normalised device coordinates strikes the city.
   *
   * The mirror of `sampleGroundY`: same scene, same overlay filter, but the ray
   * comes FROM the camera through a pixel instead of straight down from above.
   * That is the whole of what 3D authoring needs that the viewer did not
   * already have — every consumer downstream of this point takes a world
   * position and has never cared which surface produced it.
   *
   * Returns scene coordinates (metres, x = east, y = up, −z = north). `null`
   * when the ray misses the city entirely, which is the common case when the
   * author clicks the sky — a miss must not be silently clamped to the ground
   * plane, or points would materialise on the horizon.
   */
  pickGround(ndcX: number, ndcY: number): { x: number; y: number; z: number } | null {
    if (!this.renderer?.camera || !this.renderer.scene) return null;
    this._raycaster.setFromCamera(
      new THREE.Vector2(ndcX, ndcY),
      this.renderer.camera,
    );
    // The downward probe caps at 1 km because it starts 500 m up. A camera ray
    // crosses far more scene than that at a shallow angle, so restore the
    // raycaster's default reach rather than inheriting the probe's.
    this._raycaster.far = Infinity;
    const hits = this._raycaster.intersectObject(this.renderer.scene, true);
    for (const hit of hits) {
      if (!this.isOverlayHit(hit.object)) {
        return { x: hit.point.x, y: hit.point.y, z: hit.point.z };
      }
    }
    return null;
  }

  /** Focus camera on a location and show a visual marker. */
  focusOnLocation(position: THREE.Vector3, radius: number): void {
    // Project the marker onto the actual ground/road surface
    const groundHitY = this.sampleGroundY(position.x, position.z);
    const snapped = new THREE.Vector3(position.x, groundHitY + 1, position.z);

    this.cameraCtrl?.flyTo(snapped, radius);
    this.clearLocationFocus();
    this.markerGroup = createLocationMarker(snapped, radius);
    this.renderer?.scene.add(this.markerGroup);
  }

  /** Remove the location focus marker from the scene. */
  clearLocationFocus(): void {
    if (this.markerGroup) {
      this.renderer?.scene.remove(this.markerGroup);
      disposeMarkerGroup(this.markerGroup);
      this.markerGroup = null;
    }
  }

  /**
   * Replace the search-result pin layer with a fresh set of pins.
   * Called whenever the list of search results or the hovered id changes.
   *
   * Pin Y is snapped to the actual ground/road surface via `sampleGroundY`;
   * the `scenePosition.y` we receive is derived from `resolvePlaceHighlight`
   * with a flat `groundY=0`, so without snapping the pins would float above
   * or sink below elevated terrain and bridges.
   */
  setSearchPins(
    pins: Array<{ id: string; position: { x: number; y: number; z: number } }>,
    hoveredId: string | null,
  ): void {
    this.clearSearchPins();
    if (!pins.length || !this.renderer) return;

    const group = new THREE.Group();
    group.name = 'search-pins';
    for (const pin of pins) {
      const groundY = this.sampleGroundY(pin.position.x, pin.position.z);
      const pos = new THREE.Vector3(pin.position.x, groundY + 1, pin.position.z);
      const hovered = pin.id === hoveredId;
      const mesh = createSearchPin(pos, hovered);
      mesh.userData.id = pin.id;
      group.add(mesh);
    }
    this.searchPinsGroup = group;
    this.renderer.scene.add(group);
  }

  /** Remove all search-result pins from the scene. */
  clearSearchPins(): void {
    if (!this.searchPinsGroup) return;
    this.renderer?.scene.remove(this.searchPinsGroup);
    this.searchPinsGroup.children.forEach((child) => {
      if ((child as THREE.Group).isGroup) {
        disposeSearchPinGroup(child as THREE.Group);
      }
    });
    this.searchPinsGroup = null;
  }

  /**
   * Replace the proximity-arrow layer. One arrow per (subject → neighbor)
   * pair, rendered as a thin faded-blue cylinder + cone so the focused
   * spatial-search result's relation is visible in 3D the same way the
   * 2D map draws it. Positions are snapped to the surface via
   * `sampleGroundY` so arrows hug elevated terrain / bridges.
   */
  setProximityArrows(
    arrows: Array<{
      id: string;
      points: Array<{ x: number; y: number; z: number }>;
      highlight?: boolean;
    }>,
  ): void {
    this.clearProximityArrows();
    if (!arrows.length || !this.renderer) return;

    const group = new THREE.Group();
    group.name = 'proximity-arrows';
    for (const a of arrows) {
      if (!a.points || a.points.length < 2) continue;
      const snapped = a.points.map((p) => {
        const groundY = this.sampleGroundY(p.x, p.z);
        return new THREE.Vector3(p.x, groundY + 1, p.z);
      });
      const arrow = createProximityArrow(snapped, a.highlight === true);
      if (!arrow) continue;
      arrow.userData.id = a.id;
      group.add(arrow);
    }
    this.proximityArrowsGroup = group;
    this.renderer.scene.add(group);
  }

  /** Remove all proximity arrows from the scene. */
  clearProximityArrows(): void {
    if (!this.proximityArrowsGroup) return;
    this.renderer?.scene.remove(this.proximityArrowsGroup);
    this.proximityArrowsGroup.children.forEach((child) => {
      if ((child as THREE.Group).isGroup) {
        disposeProximityArrow(child as THREE.Group);
      }
    });
    this.proximityArrowsGroup = null;
  }

  /**
   * Replace the in-progress drawing path.
   *
   * PLACED points arrive with a placeholder `y` and are snapped here, the same
   * way spawn markers and trajectories are: a waypoint is stored as a ground
   * position (x, y in the runtime frame) and has no height to hand us.
   *
   * The CURSOR is not snapped, because it already carries a real height — it
   * came straight from `pickGround`, which returns an actual surface hit. Re-
   * probing it downward would answer a question already answered, and the two
   * disagree under an overpass: the downward probe finds the deck above, the
   * camera ray finds the road the author is actually pointing at.
   *
   * `null` clears. An empty point list still installs a group, so arming is one
   * call and the first click has something to fill.
   */
  setDrawingPath(
    path: {
      points: readonly DrawingPathPoint[];
      cursor: { x: number; y: number; z: number } | null;
    } | null,
  ): void {
    this.clearDrawingPath();
    if (!path || !this.renderer) return;
    const snapped = path.points.map((point) => ({
      ...point,
      y: this.sampleGroundY(point.x, point.z),
    }));
    const group = createDrawingPath(snapped, path.cursor);
    this.drawingPathGroup = group;
    this.renderer.scene.add(group);
  }

  clearDrawingPath(): void {
    if (!this.drawingPathGroup) return;
    this.renderer?.scene.remove(this.drawingPathGroup);
    disposeDrawingPath(this.drawingPathGroup);
    this.drawingPathGroup = null;
  }

  /**
   * Replace the planned-actor-trajectory layer. One polyline per actor from
   * an AI-proposed scenario draft, snapped to the surface via
   * `sampleGroundY` (same as proximity arrows) so paths hug terrain.
   */
  setActorTrajectories(
    trajectories: Array<{
      id: string;
      color: string;
      points: Array<{ x: number; y: number; z: number }>;
    }>,
  ): void {
    this.clearActorTrajectories();
    if (!trajectories.length || !this.renderer) return;

    const group = new THREE.Group();
    group.name = 'actor-trajectories';
    for (const t of trajectories) {
      if (!t.points || t.points.length < 2) continue;
      const snapped = t.points.map((p) => {
        const groundY = this.sampleGroundY(p.x, p.z);
        return new THREE.Vector3(p.x, groundY + 1, p.z);
      });
      const line = createTrajectoryLine(snapped, t.color);
      if (!line) continue;
      line.userData.id = t.id;
      group.add(line);
    }
    this.actorTrajectoriesGroup = group;
    this.renderer.scene.add(group);
  }

  /** Remove all planned-actor trajectories from the scene. */
  clearActorTrajectories(): void {
    if (!this.actorTrajectoriesGroup) return;
    this.renderer?.scene.remove(this.actorTrajectoriesGroup);
    this.actorTrajectoriesGroup.children.forEach((child) => {
      if ((child as THREE.Group).isGroup) {
        disposeTrajectoryLine(child as THREE.Group);
      }
    });
    this.actorTrajectoriesGroup = null;
  }

  /**
   * Replace the diagnostic collision-point marker. The shape mirrors the
   * POI highlight (`location-marker.ts`): flat ground ring + center disc
   * + tall vertical beacon line so the spot is glanceable at any zoom.
   * On top of those, the red X bars are retained so the marker still
   * reads semantically as "collision here", not just a generic POI.
   *
   * Pass `null` to clear the marker.
   */
  setCollisionMarker(point: { x: number; y: number; z: number } | null): void {
    this.clearCollisionMarker();
    if (!point || !this.renderer) return;

    const groundY = this.sampleGroundY(point.x, point.z);
    const group = buildCollisionMarkerGroup(groundY, point);
    this.collisionMarkerGroup = group;
    this.renderer.scene.add(group);
  }

  /** Remove the collision-point marker from the scene. */
  clearCollisionMarker(): void {
    if (!this.collisionMarkerGroup) return;
    this.renderer?.scene.remove(this.collisionMarkerGroup);
    disposeCollisionMarkerGroup(this.collisionMarkerGroup);
    this.collisionMarkerGroup = null;
  }

  /**
   * Replace the per-actor spawn markers. Vehicles render as a colored
   * 4 m × 2 m × 1.5 m box oriented to spawn yaw; walkers render as a
   * capsule sized to a standing pedestrian. Each primitive sits on the
   * ground via `sampleGroundY`, mirroring the trajectory + collision-X
   * height anchoring so all three diagnostic layers agree on the
   * surface.
   *
   * Pass `[]` (or `null`) to clear all markers.
   */
  setActorSpawnMarkers(
    spawns: Array<SpawnDescriptor> | null,
  ): void {
    this.clearActorSpawnMarkers();
    if (!spawns || spawns.length === 0 || !this.renderer) return;

    const group = new THREE.Group();
    group.name = "actor-spawns";

    for (const spawn of spawns) {
      const groundY = this.sampleGroundY(spawn.point.x, spawn.point.z);
      const mesh = buildSpawnMesh(spawn, groundY);
      if (!mesh) continue;
      group.add(mesh);
    }

    this.actorSpawnsGroup = group;
    this.renderer.scene.add(group);
  }

  /** Remove all actor-spawn markers from the scene. */
  clearActorSpawnMarkers(): void {
    if (!this.actorSpawnsGroup) return;
    this.renderer?.scene.remove(this.actorSpawnsGroup);
    disposeActorSpawnsGroup(this.actorSpawnsGroup);
    this.actorSpawnsGroup = null;
  }

  /** Dump detailed memory breakdown to the browser console. */
  dumpMemory(): void {
    this.profiler.dumpToConsole();
  }

  /** Audit aggregator handle for the dev HUD (#07); null in production. */
  getAuditAggregator(): AuditAggregator | null {
    return this._audit;
  }

  /**
   * One-shot shadow rebake. Wired to the visual-config HUD's sun-direction
   * and shadow-bias slider `onMouseUp` handlers (issue #03) so dragging stays
   * smooth (autoUpdate=false) and the shadow updates once the user commits.
   */
  commitSunShadow(): void {
    if (!IS_DEV_HUD_BUILD) return;
    if (!this.renderer) return;
    applySunCommit(this.renderer.getLiveHandles());
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    safeCall(() => cancelAnimationFrame(this.rafHandle));
    this.rafHandle = 0;
    if (this._liveApplyHandle !== null) {
      safeCall(() => cancelAnimationFrame(this._liveApplyHandle!));
      this._liveApplyHandle = null;
    }
    this._unsubVisualConfig?.();
    this._unsubVisualConfig = null;
    safeCall(() => this.clearLocationFocus());
    safeCall(() => this.clearSearchPins());
    safeCall(() => this.clearProximityArrows());
    safeCall(() => this.clearActorTrajectories());
    safeCall(() => this.clearDrawingPath());
    safeCall(() => this.profiler?.dispose());
    // Stop reconciliation poller before tile-manager dispose (both paths idempotent).
    if (this._streamingPipeline) {
      safeCall(() =>
        this._streamingPipeline?.reconciliationPoller.stop(),
      );
      safeCall(() => this.tileManager?.setStreamingPipeline(null));
      this._streamingPipeline = null;
    }
    // Texture-pool callbacks hold a ledger reference — clear them so a late
    // dedupe doesn't register against a detached ledger (ABH-112/ABH-114).
    safeCall(() => setTextureRegistrationCallback(null));
    safeCall(() => setTextureUnregistrationCallback(null));
    safeCall(() => setTexturePoolFrozen(false));
    safeCall(() => this.tileManager?.dispose());
    safeCall(() => this.cameraCtrl?.dispose());
    safeCall(() => this.renderer?.dispose());
    // Leak instrumentation must un-patch the THREE constructors before the
    // next viewer constructs anything — otherwise the next mount's
    // allocations get counted against the old counters.
    if (this._leakInstr) {
      safeCall(() => this._leakInstr?.uninstall());
      this._leakInstr = null;
    }
    if (IS_DEV_HUD_BUILD) {
      setDownscaleObserver(null);
    }

    // ABH-106: clear module-level caches that survive viewer unmount.
    safeCall(() => clearTexturePool());
    safeCall(() => resetTileLoader());
    safeCall(() => clearVegetationInstanceCache());

    // Null React callback closures (ABH-106).
    this._onStats = null;
    this._onLoadingHint = null;
    this._onLoadingProgress = null;

    // Null overlay group refs defensively (ABH-106).
    this.markerGroup = null;
    this.searchPinsGroup = null;
    this.proximityArrowsGroup = null;
    this.actorTrajectoriesGroup = null;

    // Null subsystem references so a retained viewer doesn't pin the
    // disposed scene graph or LRU cache state (ABH-106).
    const refs = this as unknown as {
      renderer: CityRenderer | null;
      cameraCtrl: CameraController | null;
      tileManager: TileManager | null;
      profiler: MemoryProfiler | null;
      _streamingMetrics: StreamingMetricsCollector | null;
      _raycaster: THREE.Raycaster | null;
      _downDir: THREE.Vector3 | null;
      frustum: THREE.Frustum | null;
      projScreenMatrix: THREE.Matrix4 | null;
    };
    refs.renderer = null;
    refs.cameraCtrl = null;
    refs.tileManager = null;
    refs.profiler = null;
    refs._streamingMetrics = null;
    refs._raycaster = null;
    refs._downDir = null;
    refs.frustum = null;
    refs.projScreenMatrix = null;

    this._audit = null;
    this.qualitySettings = null;

    warnOnOutstandingLeaks();
  }
}

/** Swallow a teardown step's exception so one failure doesn't strand the rest. */
function safeCall(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn('[CityViewer] dispose step threw — continuing teardown:', err);
  }
}

/** Warn if leak-instrumentation counters show outstanding allocations at end-of-dispose. */
function warnOnOutstandingLeaks(): void {
  if (typeof window === 'undefined') return;
  const instr = (window as { __leakInstr?: { dump?: () => Array<{ category: string; key: string; outstanding: number }> } }).__leakInstr;
  if (!instr || typeof instr.dump !== 'function') return;
  let rows: Array<{ category: string; key: string; outstanding: number }>;
  try {
    rows = instr.dump();
  } catch {
    return;
  }
  const leaked = rows.filter((r) => r.outstanding > 0);
  if (leaked.length === 0) return;
  const summary = leaked.map((r) => `${r.category}:${r.key}=${r.outstanding}`).join(', ');
  console.warn(`[CityViewer] dispose() found outstanding leaks: ${summary}`);
}
