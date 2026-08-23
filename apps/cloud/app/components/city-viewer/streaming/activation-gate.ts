/**
 * Activation gate — per-frame rate-limiter on GPU-costly tile activation.
 *
 * Decoupled from network fetch and GLB parse (which happen upstream in the
 * `prefetch-queue`), this gate gives the render loop a single hook
 * (`tick()`) that decides what *gets to enter the scene* this frame. It
 * enforces three independent limits, each individually overridable by debug
 * flags: at most one tile dequeued per frame, at most ~30 MB of tile bytes
 * per frame, and at most 5 meshes revealed per frame within a tile.
 *
 * The gate does not own the scene graph — the caller (tile-manager, issue
 * #08) attaches the tile's `Group` to the scene on the first batch and uses
 * the returned mesh list to know which children just became visible. The
 * gate flips `mesh.visible` directly on staggered children so an early
 * scene-attach does not surface meshes that have not yet been activated.
 *
 * See `.scratch/streaming-budget-pacing/issues/04-activation-gate-mesh-stagger.md`.
 */

import * as THREE from "three/webgpu";

import type { BudgetCategory, BudgetLedger } from "./budget-ledger";
import type { DebugFlags } from "./debug-flags";
import type { PrefetchPayload, PrefetchQueue } from "./prefetch-queue";

/**
 * Belmont's vegetation tile keys are prefixed `veg_` by the manifest
 * builder; non-vegetation tiles use building-id prefixes like `b_`. Surface
 * the split in the budget ledger so /test-ralph can identify which tile
 * category dominates the held-camera growth window (ABH-114).
 */
function categoryForKey(key: string): BudgetCategory {
  return key.startsWith("veg_") ? "vegetation" : "tiles";
}

const BYTES_PER_MB = 1024 * 1024;

export const DEFAULT_PER_FRAME_BYTE_CAP = 30 * BYTES_PER_MB;
export const DEFAULT_MESHES_PER_FRAME = 5;

/**
 * Hysteresis thresholds (utilization %) for the ABH-113 defensive throttle.
 * Symmetric to the cascade's disposal-side bands: freeze fires at the same
 * level the controller fires `circuitBreaker`, and recovery lines up with
 * the cascade's `recovery` dead-band so the gate and controller exit
 * pressure together rather than ricocheting around 95%.
 */
export const DEFAULT_THROTTLE_FREEZE_UTILIZATION_PERCENT = 95;
export const DEFAULT_THROTTLE_RESUME_UTILIZATION_PERCENT = 75;

export interface ActivationBatch {
  /** Tile key (matches the upstream prefetch payload). */
  key: string;
  /**
   * The tile's root `Group`. The same instance is returned on every batch
   * for the tile, so the caller can attach it on `isFirstBatch` and rely on
   * Three.js to render the meshes the gate has revealed.
   */
  group: THREE.Group;
  /** Meshes whose `visible` flag was flipped to true on this batch. */
  meshes: THREE.Mesh[];
  /** True only on the first batch of a tile. */
  isFirstBatch: boolean;
  /** True on the batch that finishes a tile (single-batch tiles set both). */
  isComplete: boolean;
  /** Total tile byte size as reported by the prefetch payload. */
  byteSize: number;
}

export interface ActivationGateOptions {
  prefetchQueue: PrefetchQueue;
  budgetLedger: BudgetLedger;
  flags: DebugFlags;
  /** Override the 30 MB per-frame cap (test-only). */
  defaultPerFrameByteCap?: number;
  /** Override the 5 meshes-per-frame cap (test-only). */
  defaultMeshesPerFrame?: number;
  /**
   * Returns true while the DegradationController sits in `circuitBreaker`.
   * Enables the ABH-113 defensive hysteresis throttle: when this returns
   * true AND `ledger.utilizationPercent` is over the freeze threshold (95%),
   * the gate hard-freezes new admissions and drains the prefetch queue.
   * Admissions resume only after utilization drops below the resume
   * threshold (75%) — a 20-point dead band that mirrors the cascade's
   * recovery hysteresis, so the gate and controller exit pressure together
   * instead of ricocheting around 95%.
   *
   * Additive to (not a replacement for) the controller-side `pauseActivation`
   * mechanism. The controller still pauses on circuitBreaker entry; this
   * throttle is the failsafe for transient windows where the pause is not
   * propagated (e.g. the controller exits the breaker on a 90% dip but the
   * ledger immediately reconciles upward to 95%+ from cached but
   * not-yet-evicted GPU bytes — without the throttle the gate would happily
   * burst new admissions during that window).
   */
  isCircuitBreakerOpen?: () => boolean;
  /** Override the 95% freeze threshold (test-only). */
  throttleFreezeUtilizationPercent?: number;
  /** Override the 75% resume threshold (test-only). */
  throttleResumeUtilizationPercent?: number;
}

interface InProgressTile {
  payload: PrefetchPayload;
  remaining: THREE.Mesh[];
  firstBatchEmitted: boolean;
}

export class ActivationGate {
  private readonly prefetchQueue: PrefetchQueue;
  private readonly budgetLedger: BudgetLedger;
  private readonly flags: DebugFlags;
  private readonly defaultPerFrameByteCap: number;
  private readonly defaultMeshesPerFrame: number;
  private readonly isCircuitBreakerOpen?: () => boolean;
  private readonly throttleFreezeUtilizationPercent: number;
  private readonly throttleResumeUtilizationPercent: number;

  private pending: PrefetchPayload | null = null;
  private inProgress: InProgressTile | null = null;
  // Last key surfaced in a `ledger refused` console.debug so we don't flood
  // the console at 60 fps while the same head is stuck. Cleared on admit so a
  // future stuck head re-logs.
  private lastLedgerRefusedKey: string | null = null;
  // Set of keys we've already announced as "admitting oversize" so the
  // one-line per-tile diagnostic isn't repeated across stagger frames.
  private readonly oversizeAnnouncedKeys = new Set<string>();
  // ABH-113 throttle state. `true` while the gate is hard-freezing new
  // admissions; transitions on the 95%/75% hysteresis band.
  private throttleFrozen = false;

  constructor(opts: ActivationGateOptions) {
    this.prefetchQueue = opts.prefetchQueue;
    this.budgetLedger = opts.budgetLedger;
    this.flags = opts.flags;
    this.defaultPerFrameByteCap =
      opts.defaultPerFrameByteCap ?? DEFAULT_PER_FRAME_BYTE_CAP;
    this.defaultMeshesPerFrame =
      opts.defaultMeshesPerFrame ?? DEFAULT_MESHES_PER_FRAME;
    this.isCircuitBreakerOpen = opts.isCircuitBreakerOpen;
    this.throttleFreezeUtilizationPercent =
      opts.throttleFreezeUtilizationPercent ??
      DEFAULT_THROTTLE_FREEZE_UTILIZATION_PERCENT;
    this.throttleResumeUtilizationPercent =
      opts.throttleResumeUtilizationPercent ??
      DEFAULT_THROTTLE_RESUME_UTILIZATION_PERCENT;
  }

  /** Diagnostic — true while ABH-113's hysteresis throttle is freezing admissions. */
  get isThrottleFrozen(): boolean {
    return this.throttleFrozen;
  }

  tick(): ActivationBatch[] {
    if (this.flags.nogate) {
      return this.drainAll();
    }

    this.updateThrottleState();

    // In-progress tiles always advance even while frozen — their bytes are
    // already credited to the ledger, and cutting off mid-stagger would
    // leave visibly-hidden meshes that the caller already attached.
    if (this.inProgress) {
      const batch = this.advanceInProgress(this.meshesPerFrame());
      return batch ? [batch] : [];
    }

    if (this.throttleFrozen) {
      return [];
    }

    const candidate = this.takeCandidate();
    if (!candidate) return [];

    if (!this.budgetLedger.canActivate(candidate.byteSize)) {
      this.pending = candidate;
      this.logLedgerRefusal(candidate);
      return [];
    }
    // Per-frame byte cap. Pre-ABH-109 the gate parked any tile bigger than
    // the cap in `pending` permanently — Belmont's finer-LOD tiles are
    // routinely 30–200 MB, so the queue would never drain in production
    // (Activate=0 MB/s, Queue=10, budget headroom present). The cap is only
    // honored when the user explicitly opted in via `?debug=1&fillrate=N`;
    // under the default cap the gate admits the tile and lets mesh stagger
    // pace the per-frame GPU upload (the only real per-frame pressure).
    if (candidate.byteSize > this.perFrameByteCap()) {
      if (this.fillrateIsExplicit()) {
        this.pending = candidate;
        return [];
      }
      this.logOversizeAdmit(candidate);
    }

    this.lastLedgerRefusedKey = null;
    this.budgetLedger.activate(
      candidate.key,
      candidate.byteSize,
      categoryForKey(candidate.key),
    );
    this.inProgress = {
      payload: candidate,
      remaining: collectMeshes(candidate.group),
      firstBatchEmitted: false,
    };
    hideMeshes(this.inProgress.remaining);
    const batch = this.advanceInProgress(this.meshesPerFrame());
    return batch ? [batch] : [];
  }

  private fillrateIsExplicit(): boolean {
    return this.flags.fillrate !== undefined && this.flags.fillrate > 0;
  }

  /**
   * ABH-113 hysteresis throttle. Freeze new admissions once utilization
   * crosses `throttleFreezeUtilizationPercent` while the controller reports
   * circuitBreaker; resume only after utilization drops below
   * `throttleResumeUtilizationPercent`. Resume is independent of the
   * controller's state — once the breaker has freed enough memory to fall
   * below the 75% line, the gate trusts that recovery is real.
   *
   * On the false → true edge the gate also drops any tile parked in
   * `pending` and drains the prefetch queue. The triage of attempt-1 showed
   * that without the drain, ~10 pre-decoded payloads × ~30 MB each would
   * burst into the ledger when the freeze released — defeating the purpose
   * of the freeze. Dropped payloads can be re-prefetched if the camera
   * still needs them once pressure subsides.
   */
  private updateThrottleState(): void {
    if (!this.isCircuitBreakerOpen) return;
    const util = this.budgetLedger.utilizationPercent;
    if (this.throttleFrozen) {
      if (util < this.throttleResumeUtilizationPercent) {
        this.throttleFrozen = false;
        console.debug(
          `[ActivationGate] throttle resumed at ${util.toFixed(1)}% util (< ${this.throttleResumeUtilizationPercent}% recovery threshold)`,
        );
      }
      return;
    }
    if (
      util > this.throttleFreezeUtilizationPercent &&
      this.isCircuitBreakerOpen()
    ) {
      this.throttleFrozen = true;
      const dropped = this.prefetchQueue.clear();
      const hadPending = this.pending !== null;
      this.pending = null;
      console.debug(
        `[ActivationGate] throttle frozen at ${util.toFixed(1)}% util (> ${this.throttleFreezeUtilizationPercent}% breaker-open threshold); dropped ${dropped} queued + ${hadPending ? 1 : 0} pending payload(s)`,
      );
    }
  }

  private logLedgerRefusal(candidate: PrefetchPayload): void {
    if (this.lastLedgerRefusedKey === candidate.key) return;
    this.lastLedgerRefusedKey = candidate.key;
    const currentMB = (this.budgetLedger.currentBytes / BYTES_PER_MB).toFixed(1);
    const budgetMB = (this.budgetLedger.effectiveBudget / BYTES_PER_MB).toFixed(1);
    const wantMB = (candidate.byteSize / BYTES_PER_MB).toFixed(1);
    console.debug(
      `[ActivationGate] queue head ${candidate.key} waits — ledger refused (currentBytes ${currentMB} MB + ${wantMB} MB > ${budgetMB} MB budget)`,
    );
  }

  private logOversizeAdmit(candidate: PrefetchPayload): void {
    if (this.oversizeAnnouncedKeys.has(candidate.key)) return;
    this.oversizeAnnouncedKeys.add(candidate.key);
    const sizeMB = (candidate.byteSize / BYTES_PER_MB).toFixed(1);
    const capMB = (this.perFrameByteCap() / BYTES_PER_MB).toFixed(1);
    console.debug(
      `[ActivationGate] admitting oversize tile ${candidate.key} (${sizeMB} MB > ${capMB} MB default cap) — mesh stagger paces GPU upload`,
    );
  }

  private takeCandidate(): PrefetchPayload | null {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      return p;
    }
    return this.prefetchQueue.dequeue();
  }

  private advanceInProgress(meshLimit: number): ActivationBatch | null {
    const tile = this.inProgress;
    if (!tile) return null;

    const reveal = tile.remaining.splice(0, meshLimit);
    for (const mesh of reveal) {
      mesh.visible = true;
    }
    const isFirst = !tile.firstBatchEmitted;
    tile.firstBatchEmitted = true;
    const isComplete = tile.remaining.length === 0;
    if (isComplete) {
      this.inProgress = null;
    }
    return {
      key: tile.payload.key,
      group: tile.payload.group,
      meshes: reveal,
      isFirstBatch: isFirst,
      isComplete,
      byteSize: tile.payload.byteSize,
    };
  }

  private drainAll(): ActivationBatch[] {
    const batches: ActivationBatch[] = [];
    if (this.inProgress) {
      const remaining = this.advanceInProgress(this.inProgress.remaining.length);
      if (remaining) batches.push(remaining);
    }
    let candidate = this.takeCandidate();
    while (candidate) {
      this.budgetLedger.activate(
        candidate.key,
        candidate.byteSize,
        categoryForKey(candidate.key),
      );
      const meshes = collectMeshes(candidate.group);
      // No stagger: every mesh is revealed in one batch. Three.js leaves
      // children visible by default, but we still flip explicitly to keep
      // the contract identical to the staggered path.
      for (const mesh of meshes) mesh.visible = true;
      batches.push({
        key: candidate.key,
        group: candidate.group,
        meshes,
        isFirstBatch: true,
        isComplete: true,
        byteSize: candidate.byteSize,
      });
      candidate = this.takeCandidate();
    }
    return batches;
  }

  private perFrameByteCap(): number {
    const override = this.flags.fillrate;
    if (override !== undefined && override > 0) {
      return override * BYTES_PER_MB;
    }
    return this.defaultPerFrameByteCap;
  }

  private meshesPerFrame(): number {
    const override = this.flags.meshstagger;
    if (override !== undefined && override > 0) {
      return override;
    }
    return this.defaultMeshesPerFrame;
  }
}

function collectMeshes(group: THREE.Group): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) out.push(child);
  });
  return out;
}

function hideMeshes(meshes: THREE.Mesh[]): void {
  for (const mesh of meshes) {
    mesh.visible = false;
  }
}
