/**
 * Streaming-pipeline factory for CityViewerCore.
 *
 * Constructs the BudgetLedger, PrefetchQueue, ActivationGate,
 * DegradationController, ReconciliationPoller, and LeakResponder that make
 * up the issue-#08 streaming pipeline, then returns the assembled
 * `StreamingPipeline` object ready to be injected into the TileManager.
 *
 * Extracted from city-viewer-core.ts to keep that file under 1,000 lines;
 * `CityViewerCore.start()` delegates to `buildStreamingPipeline()` for the
 * non-low quality path and to `buildLowTierBudgetLedger()` for the low path.
 */

import * as THREE from 'three/webgpu';
import { type StreamingPipeline } from './streaming/tile-manager';
import {
  BudgetLedger,
  estimateRenderTargetBytes,
  resolveBudgetBytes,
} from './streaming/budget-ledger';
import { PrefetchQueue } from './streaming/prefetch-queue';
import { ActivationGate } from './streaming/activation-gate';
import { DegradationController } from './streaming/degradation-controller';
import {
  ReconciliationPoller,
  measureSceneGraphBytes,
} from './streaming/reconciliation-poller';
import { LeakResponder } from './streaming/leak-responder';
import { getDebugFlags, type DebugFlags } from './streaming/debug-flags';
import {
  setTextureRegistrationCallback,
  setTextureUnregistrationCallback,
} from './streaming/texture-pool';
import type { TileManager } from './streaming/tile-manager';
import type { MemoryProfiler } from './memory-profiler';
import type { StreamingMetricsCollector } from './streaming/streaming-metrics';
import type { QualitySettings } from './quality';
import type { CityRenderer } from './renderer/renderer';

export type { StreamingPipeline };

/** Parameters common to both budget-ledger construction paths. */
export interface BudgetLedgerParams {
  quality: QualitySettings;
  renderer: CityRenderer;
  debugFlags: DebugFlags;
}

/**
 * Build a `BudgetLedger` sized to the given quality tier and renderer.
 * Shared by the full streaming path (non-low) and the low-tier path.
 */
export function buildBudgetLedger({
  quality,
  renderer,
  debugFlags,
}: BudgetLedgerParams): BudgetLedger {
  const drawingSize = new THREE.Vector2();
  renderer.renderer.getSize(drawingSize);
  const renderTargetOverheadBytes = estimateRenderTargetBytes({
    width: drawingSize.x,
    height: drawingSize.y,
    shadows: quality.shadows,
    shadowResolution: quality.shadowResolution,
    postProcessing: quality.postProcessing,
  });
  return new BudgetLedger({
    totalBudgetBytes: resolveBudgetBytes(quality.memoryBudgetBytes, debugFlags),
    renderTargetOverheadBytes,
  });
}

/** All mutable viewer state the factory needs to close over. */
export interface StreamingPipelineContext {
  quality: QualitySettings;
  renderer: CityRenderer;
  tileManager: TileManager;
  profiler: MemoryProfiler;
  streamingMetrics: StreamingMetricsCollector;
  /** Returns true once the viewer has been disposed (bail-safe for poller). */
  isDisposed: () => boolean;
}

/**
 * Build the full streaming pipeline for non-low quality tiers and wire the
 * texture-pool registration callbacks against the returned ledger.
 *
 * The returned `StreamingPipeline` should be passed to
 * `tileManager.setStreamingPipeline()` by the caller.
 */
export function buildStreamingPipeline(
  ctx: StreamingPipelineContext,
): StreamingPipeline {
  const debugFlags = getDebugFlags();
  const budgetLedger = buildBudgetLedger({
    quality: ctx.quality,
    renderer: ctx.renderer,
    debugFlags,
  });
  ctx.renderer.setBudgetLedger(budgetLedger);

  const prefetchQueue = new PrefetchQueue();
  // The controller is constructed first so the gate can hold a closure
  // over its `state` accessor (ABH-113). The dependency is read-only and
  // one-directional: the gate consults the controller's current state
  // on every tick; the controller never reaches back into the gate.
  const degradationController = new DegradationController({
    ledger: budgetLedger,
    actions: ctx.tileManager.buildDegradationActions(),
    flags: debugFlags,
  });
  const activationGate = new ActivationGate({
    prefetchQueue,
    budgetLedger,
    flags: debugFlags,
    // ABH-113 defensive throttle. Freezes new admissions once
    // utilization crosses 95% while the controller sits in
    // circuitBreaker; drains the prefetch queue on the freeze edge so
    // pre-decoded payloads do not burst into the ledger when the
    // freeze releases. Resumes only after dropping below 75%. Additive
    // to the controller's `pauseActivation` — handles the transient
    // window between `resumeFromCircuitBreaker` (90% dip) and the next
    // reconciliation poll that may bounce utilization back up.
    isCircuitBreakerOpen: () =>
      degradationController.state === 'circuitBreaker',
  });
  const reconciliationPoller = new ReconciliationPoller({
    ledger: budgetLedger,
    measure: () => {
      // Bail-safe: viewer may have torn down between poller ticks.
      if (ctx.isDisposed() || !ctx.renderer) return budgetLedger.currentBytes;
      return measureSceneGraphBytes({
        renderer: ctx.renderer.renderer,
        // `SceneLike` is structurally narrower than `THREE.Scene` — the
        // `image.source.data` field is `unknown` on Three's type, vs
        // `ImageLikeSource | undefined` on the poller's. Cast through
        // `unknown` so we accept the runtime shape; the poller traverses
        // defensively.
        scene: ctx.renderer.scene as unknown as Parameters<
          typeof measureSceneGraphBytes
        >[0]['scene'],
        quality: {
          shadows: ctx.quality.shadows,
          shadowResolution: ctx.quality.shadowResolution,
          postProcessing: ctx.quality.postProcessing,
        },
      });
    },
    onDrift: (deltaMB) => {
      ctx.streamingMetrics.setDriftMB(deltaMB);
    },
  });

  // Texture-pool callback (issue #46): when the loader's dedupe step
  // adopts a previously-unseen texture into the cross-tile pool, that
  // canonical instance's bytes are session-persistent. Register them
  // against the static-allocation book so the ledger reflects the real
  // GPU residence — without this the dedupe path silently grows GPU
  // bytes that the reconciliation poller flags as drift on every tick.
  setTextureRegistrationCallback((key, bytes) => {
    if (bytes <= 0) return;
    budgetLedger.registerStaticAllocation(`tex:${key}`, bytes, 'static');
  });
  // ABH-112: paired unregistration — when the texture pool's per-texture
  // refcount transitions 1 → 0 (last referencing tile evicted), the pool
  // calls this callback so the ledger's static-allocation book debits in
  // real time. Without this seam the pool's registrations accumulated as
  // referencing tiles cycled through the cache, producing the negative
  // drift symptom (tracked > actual by the un-debited pool footprint)
  // that the reconciliation poller was forced to correct on every tick.
  setTextureUnregistrationCallback((key) => {
    budgetLedger.unregisterStaticAllocation(`tex:${key}`);
  });

  // LeakResponder (#09) — self-healing GC-assist that force-disposes
  // the 3 oldest non-pinned cached tiles when the memory profiler flags
  // sustained leak AND the scene has been stable for 5s. Defaults
  // (5s window, 30s cooldown, 3 tiles/cycle) come from the issue body's
  // acceptance criteria.
  const leakResponder = new LeakResponder({
    actions: ctx.tileManager.buildLeakResponderActions(),
    isLeakSuspected: () => ctx.profiler.getMetrics().leakSuspected,
    getLastLedgerActivityMs: () => ctx.tileManager.getLastLedgerActivityMs(),
    getLastCameraActivityMs: () => ctx.tileManager.getLastCameraActivityMs(),
  });

  return {
    prefetchQueue,
    activationGate,
    budgetLedger,
    degradationController,
    reconciliationPoller,
    leakResponder,
    // Fed by the tile-manager whenever the gate stages a fresh tile.
    // Feeds the streaming-metrics rolling window so the audit HUD's
    // "Activate N MB/s" reflects real gate activity. Without this hook
    // `recordActivation` is never called from production and the
    // rate stays pinned at 0 even while the gate drains the queue
    // (ABH-107 wiring regression).
    onActivation: (bytes: number) => {
      ctx.streamingMetrics.recordActivation(bytes);
    },
  };
}
