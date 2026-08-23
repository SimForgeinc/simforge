/**
 * Budget ledger — accounting-based GPU memory tracker.
 *
 * Maintains a running byte counter incremented on tile activation and
 * decremented on eviction. Replaces the polling-based memory guard with
 * O(1) `canActivate(byteSize)` checks against an effective budget that
 * subtracts measured render-target overhead from the configured tier
 * budget. See `.scratch/streaming-budget-pacing/issues/02-budget-ledger.md`.
 *
 * The ledger keeps two books that are summed into `currentBytes`:
 *   - the **tile-activation book** — bytes that come and go via `activate` /
 *     `evict` / `reconcile` as tiles stream in and out, and
 *   - the **static-allocation book** — bytes that persist for the session,
 *     covering the static layer (`road.glb`), the shadow render target,
 *     the IBL cubemap, and the post-processing render targets. These bypass
 *     `activate` entirely and are tracked through `registerStaticAllocation`.
 * The split is what lets the reconciliation poller correct silent tile-side
 * drift without zeroing out the static footprint, which would otherwise be
 * re-detected as drift on the very next poll.
 *
 * See `.scratch/streaming-budget-pacing/issues/14-ledger-account-static-shadow-ibl.md`
 * for the static-allocation extension.
 */

import type { DebugFlags } from "./debug-flags";

const BYTES_PER_MB = 1024 * 1024;

/**
 * Resolve the active tile budget, honoring `?debug=1&budget=N` (interpreted
 * as megabytes) when present. Non-positive overrides fall through to the
 * quality-tier default — the debug-flags parser already filters those, but
 * the resolver is defensive against direct callers.
 */
export function resolveBudgetBytes(
  qualityBudgetBytes: number,
  flags: DebugFlags,
): number {
  if (flags.budget !== undefined && flags.budget > 0) {
    return flags.budget * BYTES_PER_MB;
  }
  return qualityBudgetBytes;
}

export interface RenderTargetEstimateInput {
  /** Viewport width in pixels (after pixel-ratio scaling). */
  width: number;
  /** Viewport height in pixels (after pixel-ratio scaling). */
  height: number;
  shadows: boolean;
  /** Side length of the square shadow map. Zero disables shadow contribution. */
  shadowResolution: number;
  postProcessing: boolean;
}

/**
 * Estimate the bytes the renderer keeps in render targets at the configured
 * viewport size. Mirrors the per-frame estimate in `memory-profiler` so the
 * ledger and profiler stay in agreement. The value is fixed for the session
 * once the viewport is known — it is measured once at viewer init and treated
 * as overhead subtracted from the tile budget.
 */
export function estimateRenderTargetBytes(
  opts: RenderTargetEstimateInput,
): number {
  let bytes = 0;
  if (opts.shadows && opts.shadowResolution > 0) {
    bytes += opts.shadowResolution * opts.shadowResolution * 4;
  }
  if (opts.postProcessing) {
    const px = opts.width * opts.height;
    // Scene colour (RGBA16F=8) + scene depth (4) + GTAO half-res (1)
    // + denoise (4) + SMAA (4) ≈ 21 bytes/pixel at full resolution.
    bytes += px * 21;
  }
  return bytes;
}

/**
 * Sources for a static allocation, used both for telemetry and to keep
 * registration site-specific (so the same key from a different source path
 * is treated as an authoring error rather than a silent merge).
 */
export type StaticAllocationSource = "static" | "shadow" | "ibl" | "rt";

/**
 * Per-source bytes bucket exposed by `bytesByCategory()` so /test-ralph can
 * identify which loader is responsible for the held-camera growth window
 * (see ABH-114). Five categories are tracked:
 *   - `tiles`        — ActivationGate non-vegetation tile activations
 *   - `vegetation`   — ActivationGate vegetation tile activations
 *   - `coarsePin`    — CoarsePinPacer boot-time / re-entry activations
 *   - `staticLayer`  — road GLB, shadow map, IBL cubemap, post-processing RTs
 *   - `texturePool`  — cross-tile dedupe pool canonical instances (`tex:*`)
 */
export type BudgetCategory =
  | "tiles"
  | "vegetation"
  | "coarsePin"
  | "staticLayer"
  | "texturePool";

const ZERO_BY_CATEGORY: Record<BudgetCategory, number> = {
  tiles: 0,
  vegetation: 0,
  coarsePin: 0,
  staticLayer: 0,
  texturePool: 0,
};

interface TileEntry {
  bytes: number;
  category: BudgetCategory;
}

interface StaticEntry {
  bytes: number;
  source: StaticAllocationSource;
  category: BudgetCategory;
}

/**
 * Hysteresis thresholds (in percent of `effectiveBudget`) for the non-tile
 * freeze gate. Mirrors ABH-113's activation freeze: enter the freeze at the
 * circuit-breaker line (95%), do not exit until the recovery line (75%) so
 * the freeze cannot oscillate within the breakerResume dead band.
 */
export interface NonTileFreezeThresholds {
  enterPercent?: number;
  exitPercent?: number;
}

const DEFAULT_NON_TILE_FREEZE: Required<NonTileFreezeThresholds> = {
  enterPercent: 95,
  exitPercent: 75,
};

export interface BudgetLedgerOptions {
  /** Total tile budget in bytes (e.g. 4096 MB for high tier). */
  totalBudgetBytes: number;
  /** Render-target overhead measured at viewer init. Subtracted from total. */
  renderTargetOverheadBytes?: number;
}

export class BudgetLedger {
  private readonly totalBudgetBytes: number;
  private readonly renderTargetOverheadBytes: number;
  private readonly tileEntries = new Map<string, TileEntry>();
  private readonly staticEntries = new Map<string, StaticEntry>();
  private _tileBytes = 0;
  private _staticBytes = 0;
  // ABH-114: per-category bytes sum. Kept in lockstep with `tileEntries` and
  // `staticEntries` so `bytesByCategory()` is an O(1) snapshot.
  private readonly _categoryBytes: Record<BudgetCategory, number> = {
    ...ZERO_BY_CATEGORY,
  };
  // ABH-114: latched freeze state for non-tile loaders (texture pool /
  // vegetation parses). Updated by `tickNonTileFreeze()` each render frame.
  private _nonTileFrozen = false;

  constructor(opts: BudgetLedgerOptions) {
    this.totalBudgetBytes = opts.totalBudgetBytes;
    this.renderTargetOverheadBytes = opts.renderTargetOverheadBytes ?? 0;
  }

  activate(
    key: string,
    byteSize: number,
    category: BudgetCategory = "tiles",
  ): void {
    const existing = this.tileEntries.get(key);
    if (existing !== undefined) {
      this._tileBytes -= existing.bytes;
      this._categoryBytes[existing.category] -= existing.bytes;
    }
    this.tileEntries.set(key, { bytes: byteSize, category });
    this._tileBytes += byteSize;
    this._categoryBytes[category] += byteSize;
  }

  evict(key: string): void {
    const existing = this.tileEntries.get(key);
    if (existing === undefined) return;
    this.tileEntries.delete(key);
    this._tileBytes -= existing.bytes;
    this._categoryBytes[existing.category] -= existing.bytes;
  }

  /**
   * Register a session-persistent allocation against the static-allocation
   * book. Re-registering the same key replaces (not duplicates) — handy for
   * post-processing render targets that are re-created on resize. Pass
   * `byteSize: 0` to remove the entry (post-processing destroy path).
   */
  registerStaticAllocation(
    key: string,
    byteSize: number,
    source: StaticAllocationSource,
  ): void {
    if (byteSize < 0) {
      throw new Error(
        `BudgetLedger.registerStaticAllocation: byteSize must be non-negative (got ${byteSize}). ` +
          `To remove an allocation, pass 0 or call unregisterStaticAllocation.`,
      );
    }
    const existing = this.staticEntries.get(key);
    if (existing !== undefined) {
      this._staticBytes -= existing.bytes;
      this._categoryBytes[existing.category] -= existing.bytes;
    }
    if (byteSize === 0) {
      this.staticEntries.delete(key);
      return;
    }
    const category = categoryForStaticAllocation(key, source);
    this.staticEntries.set(key, { bytes: byteSize, source, category });
    this._staticBytes += byteSize;
    this._categoryBytes[category] += byteSize;
  }

  /**
   * Remove a previously-registered static allocation. No-op if the key is
   * unknown, mirroring `evict` semantics.
   */
  unregisterStaticAllocation(key: string): void {
    const existing = this.staticEntries.get(key);
    if (existing === undefined) return;
    this.staticEntries.delete(key);
    this._staticBytes -= existing.bytes;
    this._categoryBytes[existing.category] -= existing.bytes;
  }

  /**
   * Absorb measured drift from the reconciliation poller (#07). The static-
   * allocation book is preserved as a permanent floor — only the tile book is
   * adjusted so that `currentBytes ≈ actualTotalBytes`. This avoids the
   * pathology where the poller zeros silent tile-side drift but also wipes
   * the shadow / static-layer / IBL accounting, which would re-emerge as the
   * same drift on the very next 3-second poll.
   */
  reconcile(actualTotalBytes: number): void {
    this._tileBytes = Math.max(0, actualTotalBytes - this._staticBytes);
  }

  canActivate(byteSize: number): boolean {
    return this.currentBytes + byteSize <= this.effectiveBudget;
  }

  get currentBytes(): number {
    return this._tileBytes + this._staticBytes;
  }

  get tileBytes(): number {
    return this._tileBytes;
  }

  get staticBytes(): number {
    return this._staticBytes;
  }

  get effectiveBudget(): number {
    return this.totalBudgetBytes - this.renderTargetOverheadBytes;
  }

  get utilizationPercent(): number {
    const denom = this.effectiveBudget;
    if (denom <= 0) return 0;
    return (this.currentBytes / denom) * 100;
  }

  /**
   * Snapshot of per-source bytes (ABH-114). Returned as a fresh object so
   * callers can JSON.stringify it without retaining a live reference to the
   * ledger's internal state. The sum equals `currentBytes` exactly outside
   * of an in-flight `reconcile()` adjustment.
   */
  bytesByCategory(): Record<BudgetCategory, number> {
    return { ...this._categoryBytes };
  }

  /**
   * Update the non-tile freeze latch from the current `utilizationPercent`
   * (ABH-114). Once latched, `isNonTileFrozen` stays true until util drops
   * below `exitPercent` (default 75%). Callers (texture-pool dedupe, the
   * vegetation parse path) consult `isNonTileFrozen` to hard-pause work
   * that would otherwise grow GPU bytes outside the ActivationGate pipeline
   * — mirrors ABH-113's activation-gate freeze pattern.
   */
  tickNonTileFreeze(thresholds: NonTileFreezeThresholds = {}): void {
    const enter = thresholds.enterPercent ?? DEFAULT_NON_TILE_FREEZE.enterPercent;
    const exit = thresholds.exitPercent ?? DEFAULT_NON_TILE_FREEZE.exitPercent;
    const util = this.utilizationPercent;
    if (this._nonTileFrozen) {
      if (util < exit) this._nonTileFrozen = false;
    } else {
      if (util >= enter) this._nonTileFrozen = true;
    }
  }

  /** True while the non-tile freeze latch is engaged. */
  get isNonTileFrozen(): boolean {
    return this._nonTileFrozen;
  }
}

/**
 * Classify a `registerStaticAllocation` call as either a `texturePool`
 * registration (cross-tile dedupe canonical, keyed by `tex:*`) or a
 * `staticLayer` registration (road GLB / shadow / IBL / RT). The split is
 * what lets the ABH-114 benchmark identify the texture-pool growth that
 * sneaks past the ActivationGate freeze when a held camera continues to
 * parse new vegetation tiles in flight.
 */
function categoryForStaticAllocation(
  key: string,
  _source: StaticAllocationSource,
): BudgetCategory {
  if (key.startsWith("tex:")) return "texturePool";
  return "staticLayer";
}
