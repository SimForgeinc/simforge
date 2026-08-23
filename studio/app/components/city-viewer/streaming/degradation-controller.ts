/**
 * Degradation controller — four-state machine that responds to memory pressure
 * with progressive quality reduction and recovers with hysteresis once the
 * ledger reports the budget has eased.
 *
 * Cascade: nominal → vegetationThinning (>= 85%) → lodDowngrading (>= 90%)
 * → circuitBreaker (>= 95%). Recovery fires only once utilization drops below
 * 75% (10% dead band so a 86% → 84% bounce never triggers recovery). See
 * `.scratch/streaming-budget-pacing/issues/06-degradation-controller.md`.
 */

import type { DebugFlags } from "./debug-flags";

export type DegradationState =
  | "nominal"
  | "vegetationThinning"
  | "lodDowngrading"
  | "circuitBreaker";

export interface DegradationLedger {
  readonly utilizationPercent: number;
}

export interface DegradationActions {
  /** Apply a global vegetation density multiplier (1.0 nominal, 0.5 thinned). */
  setVegetationDensity(scale: number): void;
  /** Set the coarse-pin budget ratio (0.30 nominal, 0.15 contracted). */
  setCoarsePinBudgetRatio(ratio: number): void;
  /**
   * Coarse-pinned tile keys eligible for in-place LOD downgrade, ordered
   * oldest-first. Should exclude entries already at the coarsest LOD.
   */
  getDowngradeCandidates(): string[];
  /** Every loaded tile key — used by the circuit breaker to downgrade everything. */
  getAllDowngradeCandidates(): string[];
  /** Coarsest LOD level — tiles already at this level need no further downgrade. */
  getCoarsestLodLevel(): number;
  /** Swap a tile's geometry to `targetLod` in place. */
  downgradeToLod(key: string, targetLod: number): void;
  /** Restore a previously-downgraded tile to a finer LOD. */
  upgradeToLod(key: string, targetLod: number): void;
  /** Drop every coarse pin (circuit breaker). */
  dropAllCoarsePins(): void;
  /** Halt the activation gate (circuit breaker). */
  pauseActivation(): void;
  /** Resume the activation gate (circuit breaker resume). */
  resumeActivation(): void;
  /**
   * Synchronously evict oldest non-pinned, non-active cached tiles until
   * `ledger.utilizationPercent <= targetPct` or no eligible entries remain.
   * Returns the count and total bytes freed so the controller can surface
   * the result in its breaker-entry log line. Implementation lives in the
   * host (TileManager owns the cache); the controller is the policy.
   */
  evictOldestTilesUntilUnderThreshold(targetPct: number): {
    tilesEvicted: number;
    bytesFreed: number;
  };
}

export interface DegradationThresholds {
  /** Lower bound for vegetationThinning entry (default 85%). */
  vegThinning: number;
  /** Lower bound for lodDowngrading entry (default 90%). */
  lodDowngrade: number;
  /** Lower bound for circuitBreaker entry (default 95%). */
  circuitBreaker: number;
  /** Upper bound for recovery (default 75%). */
  recovery: number;
  /** Upper bound for circuitBreaker → lodDowngrading resume (default 90%). */
  breakerResume: number;
}

export interface CoarsePinBudgets {
  nominal: number;
  contracted: number;
}

export interface DegradationControllerOptions {
  ledger: DegradationLedger;
  actions: DegradationActions;
  flags?: Pick<DebugFlags, "nodegradation" | "nobreaker">;
  thresholds?: Partial<DegradationThresholds>;
  coarsePinBudgets?: CoarsePinBudgets;
}

const DEFAULT_THRESHOLDS: DegradationThresholds = {
  vegThinning: 85,
  lodDowngrade: 90,
  circuitBreaker: 95,
  recovery: 75,
  breakerResume: 90,
};

const DEFAULT_COARSE_PIN_BUDGETS: CoarsePinBudgets = {
  nominal: 0.3,
  contracted: 0.15,
};

type RecoveryStep = "none" | "veg" | "lod" | "pin";

/**
 * Tracks every controller-issued downgrade so recovery can restore the tile
 * to its original LOD even after the cache re-keys the entry from
 * `${tileId}:${originalLod}` to `${tileId}:${currentLod}`.
 */
interface DowngradeRecord {
  originalLod: number;
  currentLod: number;
}

export class DegradationController {
  private readonly ledger: DegradationLedger;
  private readonly actions: DegradationActions;
  private readonly flags: Pick<DebugFlags, "nodegradation" | "nobreaker">;
  private readonly thresholds: DegradationThresholds;
  private readonly coarsePinBudgets: CoarsePinBudgets;

  private _state: DegradationState = "nominal";
  private readonly downgrades = new Map<string, DowngradeRecord>();
  private recoveryStep: RecoveryStep = "none";

  constructor(opts: DegradationControllerOptions) {
    this.ledger = opts.ledger;
    this.actions = opts.actions;
    this.flags = opts.flags ?? { nodegradation: false, nobreaker: false };
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
    this.coarsePinBudgets = opts.coarsePinBudgets ?? DEFAULT_COARSE_PIN_BUDGETS;
  }

  get state(): DegradationState {
    return this._state;
  }

  tick(): void {
    if (this.flags.nodegradation) return;
    const util = this.ledger.utilizationPercent;

    if (util < this.thresholds.recovery && this._state !== "nominal") {
      this.tickRecovery();
      return;
    }

    // Re-pressurised before recovery completed — abandon the in-flight
    // sequence so the next dip below `recovery` restarts from `veg`.
    if (this.recoveryStep !== "none") {
      this.recoveryStep = "none";
    }

    if (
      util >= this.thresholds.circuitBreaker &&
      !this.flags.nobreaker &&
      this._state !== "circuitBreaker"
    ) {
      this.enterCircuitBreaker();
      return;
    }

    if (
      this._state === "circuitBreaker" &&
      util < this.thresholds.breakerResume
    ) {
      this.resumeFromCircuitBreaker();
      return;
    }

    if (
      util >= this.thresholds.lodDowngrade &&
      this._state !== "lodDowngrading" &&
      this._state !== "circuitBreaker"
    ) {
      this.enterLodDowngrading();
      return;
    }

    if (util >= this.thresholds.vegThinning && this._state === "nominal") {
      this.applyPressureBaseline();
      this._state = "vegetationThinning";
    }
  }

  private enterLodDowngrading(): void {
    this.applyPressureBaseline();
    this._state = "lodDowngrading";
    const target = this.actions.getCoarsestLodLevel();
    for (const key of this.actions.getDowngradeCandidates()) {
      this.recordDowngrade(key, target);
      this.actions.downgradeToLod(key, target);
    }
  }

  private enterCircuitBreaker(): void {
    this.applyPressureBaseline();
    this._state = "circuitBreaker";
    this.actions.pauseActivation();
    this.actions.dropAllCoarsePins();
    const target = this.actions.getCoarsestLodLevel();
    for (const key of this.actions.getAllDowngradeCandidates()) {
      this.recordDowngrade(key, target);
      this.actions.downgradeToLod(key, target);
    }
    // Proactively dispose oldest non-pinned, non-active tiles down to the
    // vegetation-thinning band so the breaker is one-shot recovery instead
    // of "stuck at high memory until organic LRU eviction catches up". Run
    // 20260506T1757 of /test-ralph showed `pauseActivation` starves the
    // eviction path that `cache.put` triggers, so without this sweep the
    // tracked bytes stay above the breaker threshold indefinitely.
    const stats = this.actions.evictOldestTilesUntilUnderThreshold(
      this.thresholds.vegThinning,
    );
    const freedMB = stats.bytesFreed / (1024 * 1024);
    console.log(
      `[DegradationController] circuit-breaker evicted ${stats.tilesEvicted} tiles, freed ${freedMB.toFixed(1)} MB`,
    );
  }

  private resumeFromCircuitBreaker(): void {
    this.actions.resumeActivation();
    this._state = "lodDowngrading";
  }

  private applyPressureBaseline(): void {
    if (this._state !== "nominal") return;
    this.actions.setVegetationDensity(0.5);
    this.actions.setCoarsePinBudgetRatio(this.coarsePinBudgets.contracted);
  }

  private tickRecovery(): void {
    // Exiting the breaker is itself the first recovery action — resume the
    // gate, drop into lodDowngrading, and let the next tick run the regular
    // veg/lod/pin sequence.
    if (this._state === "circuitBreaker") {
      this.resumeFromCircuitBreaker();
      return;
    }

    if (this.recoveryStep === "none") {
      this.recoveryStep = "veg";
    }

    if (this.recoveryStep === "veg") {
      this.actions.setVegetationDensity(1.0);
      this.recoveryStep = this.downgrades.size > 0 ? "lod" : "pin";
      return;
    }

    if (this.recoveryStep === "lod") {
      const next = this.downgrades.entries().next();
      if (!next.done) {
        const [tileId, record] = next.value;
        const currentKey = `${tileId}:${record.currentLod}`;
        this.actions.upgradeToLod(currentKey, record.originalLod);
        this.downgrades.delete(tileId);
        if (this.downgrades.size === 0) {
          this.recoveryStep = "pin";
        }
        return;
      }
      this.recoveryStep = "pin";
    }

    if (this.recoveryStep === "pin") {
      this.actions.setCoarsePinBudgetRatio(this.coarsePinBudgets.nominal);
      this.recoveryStep = "none";
      this._state = "nominal";
    }
  }

  private recordDowngrade(key: string, targetLod: number): void {
    const colon = key.lastIndexOf(":");
    if (colon < 0) return;
    const tileId = key.slice(0, colon);
    const currentLod = parseInt(key.slice(colon + 1), 10);
    if (Number.isNaN(currentLod) || currentLod === targetLod) return;

    const existing = this.downgrades.get(tileId);
    if (existing) {
      // First-seen original LOD wins; only the current LOD position advances.
      existing.currentLod = targetLod;
    } else {
      this.downgrades.set(tileId, {
        originalLod: currentLod,
        currentLod: targetLod,
      });
    }
  }
}
