import * as THREE from 'three/webgpu';
import type { Manifest, TileDescriptor } from '../types';
import type { QualitySettings } from '../quality';
import { DEFAULT_MEMORY_BUDGET_BYTES } from '../constants';
import { parseManifest } from '../manifest-parser';
import { TileCache, type CacheEntry, type CacheStats } from './tile-cache';
import { LoadingQueue } from './loading-queue';
import { loadTileGLB } from './tile-loader';
import { loadStaticLayer as loadStaticLayerHelper, type StaticLayerContext } from './static-layer-loader';
import { loadVegetationTile, applyVegetationDensity, seedVegetationInstanceCache } from './vegetation-loader';
import { parseMergedVegetationInstances, type CityAssetVariants } from '../asset-variants';
import { shouldPauseLoading, type MemoryGuardLimits } from '../memory-profiler';
import { recordTileFailure } from '../viewer-diagnostics';
import { selectLod } from '../lod-selector';
import { FrustumCuller } from '../culling/frustum-culler';
import type { AuditAggregator } from '../audit-aggregator';
import { IS_DEV_HUD_BUILD } from '../dev-hud-build';
import { VEGETATION_LOD_GEOMETRIC_ERROR } from '../vegetation-simplify';
import { isHeavyTwinDetail } from '../twin-detail-mode';
import type { BudgetLedger } from './budget-ledger';
import type { StaticSemantics } from '../static-semantics';
import {
  CoarsePinPacer,
  type StreamingGate,
  type StreamingBudgetLedger,
} from './coarse-pin-pacer';
import type { PrefetchQueue } from './prefetch-queue';
import type { ActivationBatch, ActivationGate } from './activation-gate';
import type {
  DegradationActions,
  DegradationController,
} from './degradation-controller';
import type { ReconciliationPoller } from './reconciliation-poller';
import { evictOldestUntilUnderUtilization } from './breaker-eviction';
import { DeferredDisposalQueue } from './deferred-disposal';
import {
  isPooledTexture,
  releaseTileTextureReferences,
  setTextureDisposeQueue,
} from './texture-pool';
import type { LeakResponder, LeakResponderActions } from './leak-responder';

/**
 * Streaming-pipeline bundle injected by the orchestrator. When wired, routes
 * fetched tiles through prefetchQueue → activationGate → scene, and runs the
 * degradation controller and reconciliation poller each frame. When null, the
 * legacy direct-scene-add + memory-guard path is used (low-tier bypass).
 */
export interface StreamingPipeline {
  prefetchQueue: PrefetchQueue;
  activationGate: ActivationGate;
  budgetLedger: BudgetLedger;
  degradationController: DegradationController;
  reconciliationPoller: ReconciliationPoller;
  leakResponder: LeakResponder;
  /** Fired after a fresh tile is staged; wired to recordActivation (ABH-107). */
  onActivation?: (bytes: number) => void;
}

/** No-op gate for boot-time coarse pre-load (budget is enforced by the ledger). */
const COARSE_PIN_NO_OP_GATE: StreamingGate = {
  async acquire(_bytes: number): Promise<void> {},
};

const _tileCenter = new THREE.Vector3();

/** Camera displacement in one update, in metres, that counts as movement. */
const MOTION_EPSILON_M = 0.25;
/** Quiet period after the last movement before the camera counts as settled. */
const MOTION_SETTLE_MS = 250;
/** Minimum gap between admitting new finer-LOD tiles while the camera moves. */
const MOVING_UPGRADE_INTERVAL_MS = 150;

interface ActiveTile {
  key: string;
  tileId: string;
  lodLevel: number;
  group: THREE.Group;
}

interface CoarsePinPayload {
  tile: TileDescriptor;
  lodLevel: number;
}

/**
 * Budget-refused coarse tiles retried per update tick. Small on purpose: each
 * one decodes and uploads, and the backlog is retried every tick anyway.
 */
const COARSE_RETRY_PER_TICK = 2;

export class TileManager {
  private manifest: Manifest | null = null;
  private basePath = '';
  /** `?v=` cache-busting token appended to every resolved asset URL. */
  private _assetVersion = '';
  private _staticSemantics: StaticSemantics | null = null;
  /**
   * Authored-file → KTX2-variant-file substitution (see `asset-variants.ts`).
   * Populated by `setVariants` only when the viewer core successfully
   * configured Basis transcoding; empty map = serve authored GLBs.
   */
  private _variantFiles = new Map<string, string>();
  /**
   * Resolves when the merged vegetation-instance sidecar (if advertised) has
   * been fetched and seeded into the vegetation loader's cache. Vegetation
   * loads await this so the per-tile fallback fetch doesn't race the seed.
   */
  private _vegInstancesReady: Promise<void> = Promise.resolve();
  /** Merged-sidecar path from `setVariants`, consumed by loadManifest. */
  private _pendingVegInstancesFile: string | null = null;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGPURenderer | null = null;
  private quality: QualitySettings | null = null;
  /** Eviction handler: removes from scene + active map and debits ledger (#08). */
  private handleTileEvicted = (key: string): void => {
    const active = this.activeTiles.get(key);
    if (active) {
      this.tileContainer.remove(active.group);
      this.activeTiles.delete(key);
    }
    this.ledger?.evict(key);
    this.markLedgerActivity();
  };
  // LeakResponder (#09) stability timestamps — bumped on every activation/eviction and LOD change.
  private _lastLedgerActivityMs = 0;
  private _lastCameraActivityMs = 0;
  /** Camera position at the previous update, for motion detection. */
  private _prevCameraPos: { x: number; y: number; z: number } | null = null;
  /** Last time the camera moved further than MOTION_EPSILON_M in one update. */
  private _lastCameraMotionMs = 0;
  /** Last time a new finer-LOD tile was admitted while the camera was moving. */
  private _lastUpgradeAdmitMs = 0;
  /** Frame-deferred disposal queue (ABH-111). */
  private deferredDisposal = new DeferredDisposalQueue();
  private cache = new TileCache(DEFAULT_MEMORY_BUDGET_BYTES, this.handleTileEvicted, undefined, {
    deferredDisposal: this.deferredDisposal,
    isTexturePooled: isPooledTexture,
    onReleasePoolRefs: releaseTileTextureReferences,
  });
  private queue = new LoadingQueue();
  private frustumCuller = new FrustumCuller();
  /** Per-tile previous LOD selection — fed into `selectLod`'s hysteresis check each frame. */
  private _prevLodPerTile = new Map<string, number>();
  /** Per-tile cached `geometricError` array, populated at manifest load. */
  private _tileLodErrors = new Map<string, number[]>();
  private activeTiles = new Map<string, ActiveTile>();
  private tileContainer = new THREE.Group();
  private staticContainer = new THREE.Group();
  private _totalCount = 0;
  private _staticCount = 0;
  private _staticLoaded = 0;
  private _initialLoadDone = false;
  private _preloadDone = false;
  private _onProgress: ((loaded: number, total: number, staticDone: boolean) => void) | null = null;
  private _onStaticProgress: ((bytesLoaded: number, bytesTotal: number) => void) | null = null;
  private _onReady: (() => void) | null = null;
  private _staticDone = false;
  private _staticPromises: Promise<void>[] = [];
  private _staticBytesTotal = 0;
  private _staticBytesLoaded = 0;
  private _abortCtrl = new AbortController();
  private _memoryGuard: MemoryGuardLimits;
  private _memoryGuardTriggered = false;
  /** A coarse-retry drain is awaiting its tiles; do not stack another. */
  private _coarseRetryInFlight = false;
  private _latestGpuTotalMB = 0;
  private _vegetationDensity = 1.0;
  private _coarseLodLevel = 3;
  private _coarseLoadDone = false;
  private _audit: AuditAggregator | null = null;
  private ledger: BudgetLedger | null = null;   // wired by orchestrator (#08)
  private _disposed = false;                     // idempotency guard (#17)
  private _coarsePinPacer = new CoarsePinPacer<CoarsePinPayload>(); // boot pacer (#19)
  private streamingPipeline: StreamingPipeline | null = null;       // injected pipeline (#08)
  private _activationPaused = false;             // set by circuitBreaker action

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer?: THREE.WebGPURenderer, memoryGuard?: MemoryGuardLimits) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer ?? null;
    this._memoryGuard = memoryGuard ?? { heapGrowthMB: Infinity, gpuTotalMB: Infinity };
    this.staticContainer.name = 'static-layers';
    this.tileContainer.name = 'tiles';
    scene.add(this.staticContainer);
    scene.add(this.tileContainer);
    // ABH-111: route texture-pool dedupe disposals through the deferred queue.
    setTextureDisposeQueue(this.deferredDisposal);
  }

  /** Advance the deferred-disposal queue by one frame (ABH-111). */
  advancePendingDisposals(): void {
    this.deferredDisposal.advanceFrame();
  }

  setBudgetLedger(ledger: BudgetLedger | null): void {
    this.ledger = ledger;
  }

  /** Bumped by every tile activation or eviction; read by the LeakResponder. */
  private markLedgerActivity(): void {
    this._lastLedgerActivityMs = performance.now();
  }

  /** Bumped when scoreTiles selects a different LOD for any tile; read by the LeakResponder. */
  private markCameraActivity(): void {
    this._lastCameraActivityMs = performance.now();
  }

  private trackCameraMotion(camera: THREE.PerspectiveCamera): void {
    const prev = this._prevCameraPos;
    const p = camera.position;
    if (prev) {
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      const dz = p.z - prev.z;
      if (dx * dx + dy * dy + dz * dz > MOTION_EPSILON_M * MOTION_EPSILON_M) {
        this._lastCameraMotionMs = performance.now();
      }
    }
    this._prevCameraPos = { x: p.x, y: p.y, z: p.z };
  }

  /**
   * How many *new* finer-LOD tiles may start loading this update.
   *
   * Refining a tile is not free at the moment it lands: the GLB is parsed,
   * meshopt-decoded, instanced and uploaded, and that work happens on the main
   * thread. With `maxTilesInScene` unlimited on the high tier there was no cap
   * at all, so a moving camera scheduled every newly-eligible tile at once. An
   * orbit measured 65 long tasks totalling 5.3 s of a 12 s window — 44% of wall
   * time — with the loading queue empty, i.e. the cost was activation, not
   * fetching.
   *
   * So refinement is paced while the camera moves and opens up once it settles.
   * Tiles already on screen are never subject to this; the budget only governs
   * how fast new detail is admitted, so the view keeps improving during a slow
   * pan, just without bursting.
   */
  /** True while the camera has moved within the last MOTION_SETTLE_MS. */
  private isCameraMoving(): boolean {
    return performance.now() - this._lastCameraMotionMs < MOTION_SETTLE_MS;
  }

  private upgradeAdmissionBudget(): number {
    if (isHeavyTwinDetail()) return Number.POSITIVE_INFINITY;
    const now = performance.now();
    if (now - this._lastCameraMotionMs >= MOTION_SETTLE_MS) {
      // Settled: converge on full detail as fast as the gate allows.
      return Number.POSITIVE_INFINITY;
    }
    // Moving: pace by wall time, not by frame. A per-frame budget is no budget
    // at all — at 60 fps even "two per frame" admits 120 tiles a second, and
    // there are only 89 in the map.
    if (now - this._lastUpgradeAdmitMs < MOVING_UPGRADE_INTERVAL_MS) return 0;
    this._lastUpgradeAdmitMs = now;
    return 1;
  }

  /** Last timestamp at which a tile was activated or evicted. */
  getLastLedgerActivityMs(): number {
    return this._lastLedgerActivityMs;
  }

  /** Last timestamp at which `scoreTiles` picked a new LOD for any tile. */
  getLastCameraActivityMs(): number {
    return this._lastCameraActivityMs;
  }

  /** Build LeakResponderActions bound to this manager's cache and scene (#09). */
  buildLeakResponderActions(): LeakResponderActions {
    return {
      oldestDisposalCandidates: (count: number) => {
        const out: string[] = [];
        for (const entry of this.cache.entriesOldestFirst()) {
          if (out.length >= count) break;
          if (this.cache.isPinned(entry.key)) continue;
          out.push(entry.key);
        }
        return out;
      },
      disposeTile: (key: string) => {
        const removed = this.cache.delete(key);
        if (removed === undefined) return 0;
        const active = this.activeTiles.get(key);
        if (active) {
          this.tileContainer.remove(active.group);
          this.activeTiles.delete(key);
        }
        this.ledger?.evict(key);
        this.markLedgerActivity();
        return removed.byteSize;
      },
    };
  }

  /** Inject (or clear) the streaming pipeline; starts/stops reconciliation poller. */
  setStreamingPipeline(pipeline: StreamingPipeline | null): void {
    if (this.streamingPipeline === pipeline) return;
    const prev = this.streamingPipeline;
    if (prev) {
      prev.reconciliationPoller.stop();
      this.setCoarsePinGate(null);
      this.setCoarsePinBudgetLedger(null);
    }
    this.streamingPipeline = pipeline;
    if (pipeline) {
      this.ledger = pipeline.budgetLedger;
      this.setCoarsePinGate(COARSE_PIN_NO_OP_GATE);
      this.setCoarsePinBudgetLedger(pipeline.budgetLedger);
      pipeline.reconciliationPoller.start();
    } else {
      this.ledger = null;
    }
  }

  /** True when a streaming pipeline has been injected — controls update() routing. */
  get isStreamingPipelineWired(): boolean {
    return this.streamingPipeline !== null;
  }

  /** Build DegradationActions bound to this manager's tiles and cache (#08/#16). */
  buildDegradationActions(): DegradationActions {
    return {
      setVegetationDensity: (scale: number) => {
        this.setVegetationDensity(scale);
      },
      setCoarsePinBudgetRatio: (_ratio: number) => { /* deferred — pin budget is fixed at construction */ },
      getDowngradeCandidates: () => {
        const out: string[] = [];
        for (const [, active] of this.activeTiles) {
          if (active.lodLevel < this._coarseLodLevel) {
            out.push(active.key);
          }
        }
        return out;
      },
      getAllDowngradeCandidates: () => Array.from(this.activeTiles.keys()),
      getCoarsestLodLevel: () => this._coarseLodLevel,
      downgradeToLod: (key: string, targetLod: number) => { void this.cache.downgradeToLod(key, targetLod); },
      upgradeToLod: (key: string, targetLod: number) => {
        void this.cache.upgradeToLod(key, targetLod);
      },
      dropAllCoarsePins: () => {
        this.cache.unpinAllCoarse();
      },
      pauseActivation: () => {
        this._activationPaused = true;
      },
      resumeActivation: () => {
        this._activationPaused = false;
      },
      evictOldestTilesUntilUnderThreshold: (targetPct: number) => {
        const pipeline = this.streamingPipeline;
        if (!pipeline) return { tilesEvicted: 0, bytesFreed: 0 };
        return evictOldestUntilUnderUtilization(
          {
            oldestFirst: () => this.cache.entriesOldestFirst(),
            delete: (key: string) => {
              const removed = this.cache.delete(key);
              if (removed === undefined) return false;
              const active = this.activeTiles.get(key);
              if (active) {
                this.tileContainer.remove(active.group);
                this.activeTiles.delete(key);
              }
              pipeline.budgetLedger.evict(key);
              return true;
            },
          },
          pipeline.budgetLedger,
          {
            isPinned: (key: string) => this.cache.isPinned(key),
            isActive: (key: string) => this.activeTiles.has(key),
          },
          targetPct,
        );
      },
    };
  }

  applyQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.cache = new TileCache(quality.memoryBudgetBytes, this.handleTileEvicted, undefined, {
      deferredDisposal: this.deferredDisposal,
      isTexturePooled: isPooledTexture,
      onReleasePoolRefs: releaseTileTextureReferences,
    });
    this.queue = new LoadingQueue(quality.maxConcurrentFetches);
    this._vegetationDensity = quality.vegetationDensityScale;
    console.log(`[TileManager] Quality applied: ${quality.tier} (budget=${(quality.memoryBudgetBytes / 1024 / 1024).toFixed(0)}MB, fetches=${quality.maxConcurrentFetches}, sse=${quality.sseThreshold}, minLOD=${quality.minLodLevel}, maxTiles=${quality.maxTilesInScene || 'unlimited'})`);
  }

  setStaticSemantics(semantics: StaticSemantics | null): void {
    this._staticSemantics = semantics;
  }

  loadManifest(raw: unknown, basePath = '', assetVersion?: string): void {
    const manifest = parseManifest(raw);
    this.manifest = manifest;
    this.basePath = basePath;
    this._assetVersion = assetVersion ?? '';
    this.startVegInstanceSeed();
    this._totalCount = manifest.tiles.length + (manifest.vegetationTiles?.length ?? 0);

    this._prevLodPerTile.clear();
    this._tileLodErrors.clear();
    const allTiles = [
      ...manifest.tiles,
      ...(manifest.vegetationTiles ?? []),
    ];
    for (const tile of allTiles) {
      this._tileLodErrors.set(
        tile.id,
        tile.lods.map((lod) => lod.geometricError),
      );
    }

    const vegCount = manifest.vegetationTiles?.length ?? 0;
    if (vegCount > 0) {
      console.log(`[TileManager] Manifest contains ${vegCount} vegetation tiles (vegetation=${this.quality?.vegetation ? 'enabled' : 'disabled'})`);
    } else {
      console.warn('[TileManager] Manifest contains NO vegetation tiles — trees will not appear');
    }

    if (manifest.staticLayers?.length) {
      this._staticCount = manifest.staticLayers.length;
      for (const layer of manifest.staticLayers) {
        console.log(`Loading static layer: ${layer.id}`);
        this._staticPromises.push(
          this.loadStaticLayer(
            this.resolveUrl(layer.file),
            layer.fileSize,
          ),
        );
      }
    }
  }

  /**
   * Await all static layers (roads, etc.) that were kicked off by loadManifest().
   * Returns once every static layer is fetched, parsed, and added to the scene.
   */
  async preloadStaticLayers(): Promise<void> {
    await Promise.all(this._staticPromises);
  }

  /**
   * Fetch every building + vegetation tile at LOD3 (lowest detail).
   *
   * Throttles concurrent fetches to `maxConcurrentFetches` (quality setting).
   * Call after `preloadStaticLayers()` so tiles get full bandwidth.
   */
  async preloadTiles(): Promise<void> {
    if (!this.manifest) return;

    const loadVegetation = this.quality?.vegetation ?? true;
    const allTiles = [
      ...this.manifest.tiles,
      ...(loadVegetation ? (this.manifest.vegetationTiles ?? []) : []),
    ];
    const maxLod = this.manifest.tiles[0]?.lods.length;
    const lodLevel = maxLod != null ? maxLod - 1 : 3;
    this._coarseLodLevel = lodLevel;
    const totalItems = allTiles.length;
    const concurrency = this.quality?.maxConcurrentFetches ?? 2;

    let loaded = 0;
    const onComplete = () => {
      loaded++;
      if (this._onProgress) this._onProgress(loaded, totalItems, true);
    };

    const remaining = [...allTiles];
    const workers = Array.from({ length: concurrency }, async () => {
      while (remaining.length > 0) {
        const tile = remaining.shift();
        if (tile) {
          await this.loadCoarseTile(tile, lodLevel);
          onComplete();
        }
      }
    });

    await Promise.all(workers);

    this._coarseLoadDone = true;
    this._preloadDone = true;
    this._initialLoadDone = true;
    const pendingCount = this._coarsePinPacer.pendingSize();
    const pendingNote = pendingCount > 0
      ? ` (${pendingCount} held in coarse-pin pending queue — budget refused)`
      : '';
    console.log(`[TileManager] Coarse preload complete: ${this.activeTiles.size} tiles at LOD${lodLevel}${pendingNote}`);
    if (this._onReady) this._onReady();
  }

  /** Load a single coarse-LOD tile; routes through the coarse-pin pacer when wired. */
  private async loadCoarseTile(
    tile: TileDescriptor,
    lodLevel: number,
  ): Promise<'loaded' | 'pending' | 'skipped' | 'failed'> {
    const lod = tile.lods[lodLevel];
    if (!lod) return 'skipped';
    const key = `${tile.id}:${lodLevel}`;

    if (this._coarsePinPacer.isWired) {
      const decision = await this._coarsePinPacer.tryAcquire(
        key,
        lod.fileSize,
        { tile, lodLevel },
      );
      if (decision === 'budget-refused') {
        return 'pending';
      }
    } else {
        if (shouldPauseLoading(this._memoryGuard, this._latestGpuTotalMB)) {
        if (!this._memoryGuardTriggered) {
          this._memoryGuardTriggered = true;
          console.warn('[TileManager] Memory guard triggered during preload — skipping remaining tiles');
        }
        return 'skipped';
      }
    }

    try {
      const isVegetation = tile.id.startsWith('veg_');
      let result;
      if (isVegetation) {
        const vegTile = this.manifest!.vegetationTiles?.find(t => t.id === tile.id);
        const instanceUrl = vegTile?.instanceFile ? this.resolveUrl(vegTile.instanceFile) : '';
        await this._vegInstancesReady;
        result = await loadVegetationTile(this.resolveUrl(lod.file), instanceUrl, lodLevel, this._abortCtrl.signal, tile.id, this._staticSemantics);
      } else {
        result = await loadTileGLB(this.resolveUrl(lod.file), this._abortCtrl.signal, false, this._staticSemantics);
      }

      if (this.renderer) {
        try {
          await this.renderer.compileAsync(result.group, this.camera, this.scene);
        } catch { /* context lost — still add to scene */ }
      }

      const entry: CacheEntry = { key, group: result.group, byteSize: result.byteSize };
      this.cache.put(key, entry);
      this.cache.pinCoarse(key);
      this.addTileToScene(key, tile.id, lodLevel, entry);

      this._coarsePinPacer.registerActivated(key, result.byteSize);

      return 'loaded';
    } catch (err) {
      console.warn(`[Preload] Failed to load ${tile.id} LOD${lodLevel}:`, err);
      return 'failed';
    }
  }

  /**
   * Inject the streaming activation gate. Called by the orchestration step
   * (#08) after the gate is constructed; until both gate AND ledger are
   * injected, preloadTiles falls back to its memory-guard path.
   */
  setCoarsePinGate(gate: StreamingGate | null): void {
    this._coarsePinPacer.setGate(gate);
  }

  /**
   * Inject the streaming budget ledger so coarse-pin loads consult and
   * register against the same ledger as the on-demand streaming path.
   */
  setCoarsePinBudgetLedger(ledger: StreamingBudgetLedger | null): void {
    this._coarsePinPacer.setLedger(ledger);
  }

  /** True when both gate and ledger have been injected. */
  get coarsePinPacingEnabled(): boolean {
    return this._coarsePinPacer.isWired;
  }

  /**
   * Snapshot of coarse-load tiles that the budget refused. Held in the
   * pending queue until drained by the streaming path.
   */
  getPendingCoarseTiles(): readonly { key: string; tileId: string; lodLevel: number; estimatedBytes: number }[] {
    return this._coarsePinPacer.pendingTiles().map(p => ({
      key: p.key,
      tileId: p.payload.tile.id,
      lodLevel: p.payload.lodLevel,
      estimatedBytes: p.estimatedBytes,
    }));
  }

  /**
   * Drain coarse-pin tiles that the budget previously refused, up to
   * `maxTiles`. Each drained tile re-runs through the gate + scene-add
   * pipeline. Called by the streaming path (#08) when capacity frees up.
   * Returns the number of tiles successfully loaded.
   */
  async drainPendingCoarseTiles(maxTiles = Number.POSITIVE_INFINITY): Promise<number> {
    const taken = this._coarsePinPacer.takePending(maxTiles);
    let loadedCount = 0;
    for (const pending of taken) {
      const outcome = await this.loadCoarseTile(pending.payload.tile, pending.payload.lodLevel);
      if (outcome === 'loaded') loadedCount++;
    }
    return loadedCount;
  }

  /**
   * Give budget-refused coarse tiles another chance, a few at a time.
   *
   * The coarse pass pins one lowest-detail copy of every building tile so the
   * map has a complete silhouette before the camera streams anything finer.
   * Tiles the memory ledger refuses go to the pacer's pending queue, and until
   * something drains that queue those buildings are simply absent — the coarse
   * pass runs once, so nothing else ever asks for them. On a dense map that is
   * a permanently half-built skyline, and no amount of caching helps: the
   * refusal is a memory decision taken before the bytes are ever wanted.
   *
   * Draining here rather than in the coarse pass is deliberate. Capacity frees
   * as the camera moves and finer tiles are evicted, which is exactly what the
   * update loop tracks. The per-tick cap keeps a large backlog from turning
   * into one long frame; whatever is left is retried on the next tick.
   */
  private retryRefusedCoarseTiles(): void {
    if (this._coarseRetryInFlight || this._coarsePinPacer.pendingSize() === 0) return;
    if (shouldPauseLoading(this._memoryGuard, this._latestGpuTotalMB)) return;
    this._coarseRetryInFlight = true;
    void this.drainPendingCoarseTiles(COARSE_RETRY_PER_TICK)
      .catch(() => 0)
      .finally(() => { this._coarseRetryInFlight = false; });
  }

  /**
   * Backward-compatible wrapper: loads static layers, then tiles sequentially.
   */
  async preloadAllLOD3(): Promise<void> {
    await this.preloadStaticLayers();
    await this.preloadTiles();
  }

  /** Register callbacks for initial load progress tracking. */
  onProgress(cb: (loaded: number, total: number, staticDone: boolean) => void): void { this._onProgress = cb; }
  onStaticProgress(cb: (loaded: number, total: number) => void): void { this._onStaticProgress = cb; }
  onReady(cb: () => void): void { this._onReady = cb; }

  /** Feed the latest estimated GPU memory from the profiler so the guard can track texture pressure. */
  updateGpuEstimate(gpuTotalMB: number): void {
    this._latestGpuTotalMB = gpuTotalMB;
  }

  /**
   * Public URL resolution for callers outside the streaming loop (shader
   * prewarm). Applies the same variant substitution + version token as every
   * streamed tile, so a prewarm sample fetch and the later streaming fetch
   * of the same file share one cache entry — and prewarm compiles against
   * the texture format (KTX2 vs authored) the scene will actually use.
   */
  resolveAssetUrl(file: string): string {
    return this.resolveUrl(file);
  }

  private resolveUrl(file: string): string {
    // KTX2 variant substitution first — the variant path replaces the
    // authored file wholesale (`variants/ktx2-uastc-v1/sha256/<digest>.glb`).
    const resolved = this._variantFiles.get(file) ?? file;
    const url = this.basePath ? `${this.basePath}/${resolved}` : resolved;
    // Cache-busting token derived from the manifest bytes (see
    // `CityViewerCore.start`). The 3d-asset paths are rebuilt in place, so
    // this is what keys the map-asset-cache gateway to the current build.
    return this._assetVersion ? `${url}?v=${this._assetVersion}` : url;
  }

  /**
   * Adopt pipeline variants (see `asset-variants.ts`). `useKtx2` is decided
   * by the viewer core — true only when Basis transcoding was successfully
   * configured against the live renderer, so an unsupported device keeps
   * loading the authored GLBs. Call BEFORE `loadManifest`: the substitution
   * map must exist when loadManifest kicks the static-layer fetches, while
   * the merged-instance seed (which needs the base path) starts inside
   * loadManifest itself.
   */
  setVariants(variants: CityAssetVariants | null, useKtx2: boolean): void {
    this._variantFiles.clear();
    if (variants && useKtx2) {
      for (const [source, record] of variants.ktx2Files) {
        this._variantFiles.set(source, record.file);
      }
    }
    this._pendingVegInstancesFile = variants?.vegetationInstancesFile ?? null;
    this._vegInstancesReady = Promise.resolve();
  }

  /** Kick the merged vegetation-instance seed. Called by loadManifest. */
  private startVegInstanceSeed(): void {
    const file = this._pendingVegInstancesFile;
    if (!file || (this.manifest?.vegetationTiles?.length ?? 0) === 0) {
      this._vegInstancesReady = Promise.resolve();
      return;
    }
    const url = this.resolveUrl(file);
    this._vegInstancesReady = (async () => {
      try {
        const res = await fetch(url, { signal: this._abortCtrl.signal });
        if (!res.ok) return;
        const tiles = parseMergedVegetationInstances(await res.json());
        if (!tiles) return;
        const seeded = seedVegetationInstanceCache(tiles);
        console.log(`[TileManager] Seeded ${seeded} vegetation instance tiles from merged sidecar`);
      } catch {
        // Per-tile fallback still works; the sidecar is an optimization.
      }
    })();
  }

  /** Load a static layer (roads etc.) and add it to the scene. */
  private async loadStaticLayer(
    url: string,
    fileSize: number,
  ): Promise<void> {
    const ctx: StaticLayerContext = {
      signal: this._abortCtrl.signal,
      onBytesTotal: (bytes) => { this._staticBytesTotal += bytes; },
      onBytesChunk: (bytes) => { this._staticBytesLoaded += bytes; },
      onStaticProgress: this._onStaticProgress,
      getBytesLoaded: () => this._staticBytesLoaded,
      getBytesTotal: () => this._staticBytesTotal,
      renderer: this.renderer,
      camera: this.camera,
      scene: this.scene,
      staticContainer: this.staticContainer,
      ledger: this.ledger,
      semantics: this._staticSemantics,
      onLayerComplete: () => {
        this._staticLoaded++;
        this._staticDone = this._staticLoaded >= this._staticCount;
        this.reportProgress();
      },
    };
    await loadStaticLayerHelper(url, fileSize, ctx);
  }

  update(camera: THREE.PerspectiveCamera, frustum: THREE.Frustum): void {
    // Pipeline ticks first (#08): degradation → gate drain → leak responder.
    const pipeline = this.streamingPipeline;
    if (pipeline) {
      pipeline.degradationController.tick();
      if (!this._activationPaused) {
        const batches = pipeline.activationGate.tick();
        for (const batch of batches) {
          this.attachStagedBatch(batch);
        }
      }
      pipeline.leakResponder.tick();
    }

    if (!this.manifest || !this._preloadDone) return;

    this.retryRefusedCoarseTiles();

    this.trackCameraMotion(camera);

    // --- Phase 1: Score visible tiles with their ideal (finest feasible) LOD ---
    const visible = new Map<string, { tile: TileDescriptor; lodLevel: number; priority: number }>();
    this.scoreTiles(this.manifest.tiles, camera, frustum, visible);
    if (this.manifest.vegetationTiles && (this.quality?.vegetation ?? true)) {
      // Vegetation ignores the manifest's `geometricError` — see
      // VEGETATION_LOD_GEOMETRIC_ERROR for why those numbers cannot be used.
      // `heavy` mode puts them back, which is what pins every vegetation tile
      // to LOD0 however far the camera pulls away.
      this.scoreTiles(
        this.manifest.vegetationTiles,
        camera,
        frustum,
        visible,
        this.quality?.vegetationMinLod,
        isHeavyTwinDetail() ? undefined : VEGETATION_LOD_GEOMETRIC_ERROR,
      );
    }

    // Phase 2: build the desired set (coarse base + capped LOD upgrades).
    const desired = new Map<string, { tile: TileDescriptor; lodLevel: number; priority: number }>();
    const upgrades: [string, { tile: TileDescriptor; lodLevel: number; priority: number }][] = [];
    for (const [key, val] of visible) {
      if (val.lodLevel < this._coarseLodLevel) {
        upgrades.push([key, val]);
      } else {
        desired.set(key, val);
      }
    }

    const maxUpgrades = this.quality?.maxTilesInScene ?? 0;
    if (maxUpgrades > 0 && upgrades.length > maxUpgrades) {
      upgrades.sort((a, b) => b[1].priority - a[1].priority);
      for (const [key, val] of upgrades.slice(0, maxUpgrades)) {
        desired.set(key, val);
      }
    } else {
      // Anything already on screen stays, unconditionally — pacing must never
      // pull detail back out of a view the author is looking at. The budget
      // applies only to refinements that are not resident yet, so a moving
      // camera admits new detail steadily instead of in a burst.
      // `heavy` mode admits everything the instant it qualifies, which is what
      // the renderer did before pacing existed.
      const moving = !isHeavyTwinDetail() && this.isCameraMoving();
      const pending: typeof upgrades = [];
      for (const [key, val] of upgrades) {
        if (this.activeTiles.has(key)) {
          desired.set(key, val);
          continue;
        }
        // Refining one vegetation tile costs 100–200 ms of main thread — parse,
        // meshopt decode, instancing, upload — against roughly 0.5 M triangles
        // for every building and road tile in the map put together. While the
        // camera moves, that single activation is the hitch. Vegetation detail
        // therefore waits for the camera to settle; everything else keeps
        // refining, paced.
        if (moving && val.tile.id.startsWith('veg_')) continue;
        pending.push([key, val]);
      }
      const budget = this.upgradeAdmissionBudget();
      if (pending.length > budget) {
        pending.sort((a, b) => b[1].priority - a[1].priority);
      }
      for (const [key, val] of pending.slice(0, budget)) {
        desired.set(key, val);
      }
    }

    const desiredTileIds = new Set<string>();
    for (const [, { tile }] of desired) {
      desiredTileIds.add(tile.id);
    }

    // --- Phase 3: Remove tiles that should no longer be in the scene ---
    for (const [key, active] of this.activeTiles) {
      if (desired.has(key)) continue;

      // Never remove a coarse-LOD tile — it's the permanent base layer
      if (this._coarseLoadDone && active.lodLevel >= this._coarseLodLevel) continue;

      // Keep a finer LOD until its replacement (coarse or another LOD) is ready
      if (desiredTileIds.has(active.tileId)) {
        const newLodReady = [...desired.entries()].some(
          ([dk]) => dk.startsWith(active.tileId + ':') && this.activeTiles.has(dk),
        );
        if (!newLodReady) continue;
      }
      // Tile was upgraded but is now out of frustum — downgrade back to coarse
      // (the coarse version should be in cache from preload)
      if (this._coarseLoadDone) {
        const coarseKey = `${active.tileId}:${this._coarseLodLevel}`;
        const cached = this.cache.get(coarseKey);
        if (cached) {
          this.tileContainer.remove(active.group);
          this.activeTiles.delete(key);
          this.addTileToScene(coarseKey, active.tileId, this._coarseLodLevel, cached);
          continue;
        }
      }

      this.tileContainer.remove(active.group);
      this.activeTiles.delete(key);
    }

    // --- Phase 4: Load/add desired tiles that aren't active yet ---
    for (const [key, { tile, lodLevel, priority }] of desired) {
      if (this.activeTiles.has(key)) continue;
      const alreadyHasLod = [...this.activeTiles.values()].some(a => a.tileId === tile.id);

      const cached = this.cache.get(key);
      if (cached) {
        this.addTileToScene(key, tile.id, lodLevel, cached);
      } else {
        const lod = tile.lods[lodLevel];
        if (lod) {
          this.queue.enqueue(key, this.resolveUrl(lod.file), alreadyHasLod ? priority * 0.5 : priority);
        }
      }
    }

    this.queue.pruneExcept(new Set(desired.keys()));

    // Legacy memory guard — only active when streaming pipeline is unwired (#08).
    if (!this.streamingPipeline) {
      if (shouldPauseLoading(this._memoryGuard, this._latestGpuTotalMB)) {
        if (!this._memoryGuardTriggered) {
          this._memoryGuardTriggered = true;
          console.warn('[TileManager] Memory guard triggered — pausing tile loads');
        }
        return;
      }
      if (this._memoryGuardTriggered) {
        this._memoryGuardTriggered = false;
        console.log('[TileManager] Memory guard cleared — resuming tile loads');
      }
    }

    const items = this.queue.processNext();
    for (const item of items) {
      this.loadTile(item.key, item.url, item.signal);
    }
  }

  /** Attach first batch from the activation gate; mirrors addTileToScene. */
  private attachStagedBatch(batch: ActivationBatch): void {
    if (!batch.isFirstBatch) return;
    if (this.activeTiles.has(batch.key)) return;
    const colon = batch.key.lastIndexOf(':');
    if (colon < 0) return;
    const tileId = batch.key.slice(0, colon);
    const lodLevel = parseInt(batch.key.slice(colon + 1), 10);
    if (Number.isNaN(lodLevel)) return;

    for (const [k, active] of this.activeTiles) {
      if (active.tileId === tileId) {
        this.tileContainer.remove(active.group);
        this.activeTiles.delete(k);
      }
    }

    if (tileId.startsWith('veg_')) {
      applyVegetationDensity(batch.group, this._vegetationDensity);
    }

    this.tileContainer.add(batch.group);
    this.activeTiles.set(batch.key, { key: batch.key, tileId, lodLevel, group: batch.group });
    this.markLedgerActivity();
    this.reportProgress();
    this.streamingPipeline?.onActivation?.(batch.byteSize);
  }

  private scoreTiles(
    tiles: TileDescriptor[],
    camera: THREE.PerspectiveCamera,
    frustum: THREE.Frustum,
    desired: Map<string, { tile: TileDescriptor; lodLevel: number; priority: number }>,
    minLodOverride?: number,
    lodErrorOverride?: readonly number[],
  ): void {
    const ssePxThreshold = this.quality?.sseThreshold ?? 6;
    const minLodLevel = this.quality?.minLodLevel ?? 0;
    const screenHeightPx =
      typeof window !== 'undefined' ? window.innerHeight : 1080;
    const selectorCamera = {
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      fov: camera.fov,
      screenHeightPx,
    };

    for (const tile of tiles) {
      const inFrustum = this.frustumCuller.test(tile.bounds, frustum);
      if (!inFrustum) continue;

      const lodErrors =
        lodErrorOverride ??
        this._tileLodErrors.get(tile.id) ??
        tile.lods.map((lod) => lod.geometricError);
      const prevLod = this._prevLodPerTile.get(tile.id) ?? -1;
      const baseLod = selectLod(
        selectorCamera,
        tile.bounds,
        lodErrors,
        prevLod,
        ssePxThreshold,
        { minLodLevel },
      );
      if (baseLod !== prevLod) {
        this.markCameraActivity();
      }
      this._prevLodPerTile.set(tile.id, baseLod);
      const lodLevel = minLodOverride != null ? Math.max(baseLod, minLodOverride) : baseLod;

      // Audit (#07): record LOD floor clamp vs normal selector choice (ADR-0001/0002).
      if (IS_DEV_HUD_BUILD && this._audit) {
        const unflooredLod = selectLod(
          selectorCamera,
          tile.bounds,
          lodErrors,
          prevLod,
          ssePxThreshold,
          { minLodLevel: 0 },
        );
        const clampedByMinLod = unflooredLod < minLodLevel;
        const clampedByVegMin = minLodOverride != null && baseLod < minLodOverride;
        if (clampedByMinLod || clampedByVegMin) {
          this._audit.recordLodFloorClamp(tile.id);
        } else {
          this._audit.recordLodSelectorChoice(tile.id, lodLevel);
        }
      }

      const cx = (tile.bounds.min[0] + tile.bounds.max[0]) / 2;
      const cy = (tile.bounds.min[1] + tile.bounds.max[1]) / 2;
      const cz = (tile.bounds.min[2] + tile.bounds.max[2]) / 2;
      const dist = camera.position.distanceTo(_tileCenter.set(cx, cy, cz));
      const priority = 1 / (dist + 1);

      const key = `${tile.id}:${lodLevel}`;
      desired.set(key, { tile, lodLevel, priority });
    }
  }

  private async loadTile(key: string, url: string, signal: AbortSignal): Promise<void> {
    if (!this.streamingPipeline && shouldPauseLoading(this._memoryGuard, this._latestGpuTotalMB)) {
      this.queue.complete(key);
      return;
    }

    try {
      const [tileId, lodStr] = key.split(':') as [string, string];
      const isVegetation = tileId.startsWith('veg_');

      let loaded;
      if (isVegetation) {
        const vegTile = this.manifest!.vegetationTiles?.find(t => t.id === tileId);
        const instanceUrl = vegTile?.instanceFile ? this.resolveUrl(vegTile.instanceFile) : '';
        await this._vegInstancesReady;
        loaded = await loadVegetationTile(url, instanceUrl, parseInt(lodStr, 10), signal, tileId, this._staticSemantics);
      } else {
        loaded = await loadTileGLB(url, signal, false, this._staticSemantics);
      }
      this.queue.complete(key);

      if (this.renderer) {
        try {
          await this.renderer.compileAsync(loaded.group, this.camera, this.scene);
        } catch {
          // compileAsync may fail if context is lost; still add to scene
        }
      }

      const entry: CacheEntry = { key, group: loaded.group, byteSize: loaded.byteSize };
      this.cache.put(key, entry);

      const pipeline = this.streamingPipeline;
      if (pipeline) {
        await pipeline.prefetchQueue.enqueue({
          key,
          group: loaded.group,
          byteSize: loaded.byteSize,
        });
      } else {
        this.addTileToScene(key, tileId, parseInt(lodStr, 10), entry);
      }
    } catch (err: unknown) {
      this.queue.complete(key);
      if (err instanceof Error && err.name !== 'AbortError') {
        console.warn(`Failed to load tile ${key}:`, err);
        recordTileFailure(err);
      }
    }
  }

  private addTileToScene(key: string, tileId: string, lodLevel: number, entry: CacheEntry): void {
    if (this.activeTiles.has(key)) return;

    for (const [k, active] of this.activeTiles) {
      if (active.tileId === tileId) {
        this.tileContainer.remove(active.group);
        this.activeTiles.delete(k);
      }
    }

    if (tileId.startsWith('veg_')) {
      applyVegetationDensity(entry.group, this._vegetationDensity);
    }

    this.tileContainer.add(entry.group);
    this.activeTiles.set(key, { key, tileId, lodLevel, group: entry.group });
    this.markLedgerActivity();
    this.reportProgress();
  }

  private reportProgress(): void {
    if (this._initialLoadDone) return;
    const tileIds = new Set([...this.activeTiles.values()].map(a => a.tileId));
    const totalItems = this._totalCount + this._staticCount;
    const loaded = tileIds.size + this._staticLoaded;
    if (this._onProgress) this._onProgress(loaded, totalItems, this._staticDone);
  }

  get loadedCount(): number {
    return this.activeTiles.size;
  }

  get totalCount(): number {
    return this._totalCount;
  }

  get memoryUsageMB(): number {
    return this.cache.usageMB;
  }

  /** Polled cache snapshot for the audit aggregator (#07). */
  getCacheStats(): CacheStats {
    return this.cache.getStats();
  }

  /**
   * Wire an audit aggregator (#07). When set, `scoreTiles` records every
   * LOD selector choice and every tier-policy floor clamp through it. When
   * `IS_DEV_HUD_BUILD` is false (production), the recording sites are
   * dead-code-eliminated by webpack.
   */
  setAuditAggregator(aggregator: AuditAggregator | null): void {
    this._audit = aggregator;
  }

  /** Live total of vegetation instances across all loaded vegetation tiles (#07). */
  countVegetationInstances(): number {
    let total = 0;
    for (const [, active] of this.activeTiles) {
      if (!active.tileId.startsWith('veg_')) continue;
      active.group.traverse((obj) => {
        if (obj instanceof THREE.InstancedMesh) {
          total += obj.count;
        }
      });
    }
    return total;
  }

  /** Dynamically adjust vegetation instance density (0–1). Takes effect immediately. */
  setVegetationDensity(scale: number): void {
    this._vegetationDensity = scale;
    for (const [, active] of this.activeTiles) {
      if (active.tileId.startsWith('veg_')) {
        applyVegetationDensity(active.group, scale);
      }
    }
  }

  getTileStates(): Map<string, 'loaded' | 'loading' | 'unloaded'> {
    const states = new Map<string, 'loaded' | 'loading' | 'unloaded'>();
    if (!this.manifest) return states;

    const allTiles = [
      ...this.manifest.tiles,
      ...(this.manifest.vegetationTiles ?? []),
    ];

    for (const tile of allTiles) {
      const isActive = [...this.activeTiles.values()].some((a) => a.tileId === tile.id);
      states.set(tile.id, isActive ? 'loaded' : 'unloaded');
    }
    return states;
  }

  getManifest(): Manifest | null {
    return this.manifest;
  }

  /**
   * Container holding the loaded static-layer groups (roads etc.). Exposed
   * for shader pre-warm to enumerate material variants from already-parsed
   * GLBs without re-fetching.
   */
  getStaticContainer(): THREE.Group {
    return this.staticContainer;
  }

  /** Tear down all GPU resources and scene containers. Idempotent. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    if (this.streamingPipeline) {
      this.streamingPipeline.reconciliationPoller.stop();
    }
    this._coarsePinPacer.clearPending();

    this._abortCtrl.abort();

    // ABH-111: unhook seam before disposeAll() flushes the queue.
    setTextureDisposeQueue(null);

    this.cache.disposeAll();
    this.deferredDisposal.flushAll();
    this.activeTiles.clear();

    disposeGroupResources(this.staticContainer);

    this.scene.remove(this.tileContainer);
    this.scene.remove(this.staticContainer);
  }
}

/**
 * Walk a group's scene graph, calling `.dispose()` on every geometry,
 * material, and material-owned texture. Mirrors TileCache's per-entry
 * disposal but for groups the cache doesn't own (e.g. static layers).
 */
function disposeGroupResources(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry?.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m) continue;
        for (const value of Object.values(m)) {
          if (value instanceof THREE.Texture) value.dispose();
        }
        m.dispose();
      }
    }
  });
}
