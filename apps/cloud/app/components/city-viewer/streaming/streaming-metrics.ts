/**
 * Streaming-pacing metrics collector — gathers live values from the budget
 * ledger, degradation controller, prefetch queue, activation gate, and
 * reconciliation poller, and emits them as a structured JSON line every
 * `STREAMING_METRICS_EMIT_INTERVAL_MS` for the audit HUD and offline
 * benchmarking. See `.scratch/streaming-budget-pacing/issues/10-audit-hud-structured-logging.md`.
 *
 * The collector is observe-only and self-contained — it owns the state
 * union locally so the module compiles even before the orchestration layer
 * (#08) wires the source modules in. Co-resident with the existing
 * `AuditAggregator`; both are dev-only diagnostics on disjoint signals.
 */

const BYTES_PER_MB = 1024 * 1024;

/**
 * Default emit interval. Aligned with the reconciliation poller (#07) so the
 * drift value in each emitted line corresponds to a fresh measurement rather
 * than an arbitrarily-stale one.
 */
export const STREAMING_METRICS_EMIT_INTERVAL_MS = 3_000;

const ACTIVATION_RATE_WINDOW_MS = 1_000;
const FPS_WINDOW_SAMPLES = 240; // ~4 s at 60 fps; enough for a 5th-percentile floor.

/**
 * Local mirror of the degradation controller's state union. Defined here so
 * the metrics module compiles independently of the controller landing on the
 * branch — when wired by #08, callers convert their imported state to the
 * matching string. See `.scratch/streaming-budget-pacing/issues/06-degradation-controller.md`.
 */
export type DegradationState =
  | "nominal"
  | "vegetationThinning"
  | "lodDowngrading"
  | "circuitBreaker";

export type StreamingStateLabel =
  | "nominal"
  | "veg-thinning"
  | "lod-downgrading"
  | "circuit-breaker";

/**
 * Per-source bytes (in MB, rounded) exposed in each emitted line so the
 * Belmont stress sweep can pinpoint which loader grows during the held-
 * camera window. Wired by the orchestrator from
 * `BudgetLedger.bytesByCategory()`. See ABH-114.
 */
export interface StreamingMetricsByCategory {
  tiles: number;
  vegetation: number;
  coarsePin: number;
  staticLayer: number;
  texturePool: number;
}

const ZERO_BY_CATEGORY: StreamingMetricsByCategory = {
  tiles: 0,
  vegetation: 0,
  coarsePin: 0,
  staticLayer: 0,
  texturePool: 0,
};

/**
 * Schema of the JSON line emitted via `console.debug` every
 * {@link STREAMING_METRICS_EMIT_INTERVAL_MS}. Field names are deliberately
 * terse so the line stays compact and is easy to grep / parse from the
 * Playwright benchmark script (#12).
 */
export interface StreamingMetrics {
  /** Wall-clock timestamp from the injected `now()` clock. */
  t: number;
  /** Caller-supplied frame counter. */
  frame: number;
  /** Degradation controller state (label form). */
  state: StreamingStateLabel;
  /** Effective budget in MB (rounded). */
  budgetMB: number;
  /** Currently-tracked tile bytes in MB (rounded). */
  usedMB: number;
  /** Utilization 0..1 = used / budget. */
  util: number;
  /** Rolling 1-second average of bytes activated, expressed as MB/s. */
  activationRateMBps: number;
  /** Prefetch queue depth (latest reported value). */
  queueDepth: number;
  /** Cumulative tiles evicted this session. */
  evicted: number;
  /** Cumulative tiles LOD-downgraded this session. */
  downgraded: number;
  /** Last reconciliation drift in MB (signed, latest reported value). */
  driftMB: number;
  /** Median frame fps from the rolling sample window. */
  fpsP50: number;
  /** 5th-percentile fps from the rolling sample window — captures hitches. */
  fpsP5: number;
  /**
   * Per-source bytes (rounded MB) — `tiles`, `vegetation`, `coarsePin`,
   * `staticLayer`, `texturePool`. Sum ≈ `usedMB` (modulo per-bucket
   * rounding). See ABH-114.
   */
  byCategory: StreamingMetricsByCategory;
}

interface ActivationSample {
  time: number;
  bytes: number;
}

const DEGRADATION_STATE_LABELS: Record<DegradationState, StreamingStateLabel> = {
  nominal: "nominal",
  vegetationThinning: "veg-thinning",
  lodDowngrading: "lod-downgrading",
  circuitBreaker: "circuit-breaker",
};

export function degradationStateLabel(state: DegradationState): StreamingStateLabel {
  return DEGRADATION_STATE_LABELS[state];
}

export interface StreamingMetricsCollectorOptions {
  /** Injected clock — defaults to `performance.now`. */
  now?: () => number;
  /** Override the JSON emit cadence (defaults to {@link STREAMING_METRICS_EMIT_INTERVAL_MS}). */
  emitIntervalMs?: number;
}

export class StreamingMetricsCollector {
  private readonly now: () => number;
  private readonly emitIntervalMs: number;

  private budgetBytes = 0;
  private usedBytes = 0;
  private queueDepth = 0;
  private driftMB = 0;
  private state: DegradationState = "nominal";
  private bytesByCategoryBytes: StreamingMetricsByCategory = { ...ZERO_BY_CATEGORY };

  private evicted = 0;
  private downgraded = 0;

  private readonly activations: ActivationSample[] = [];
  private readonly frameDeltas: number[] = [];

  private lastEmitTime: number | null = null;

  constructor(opts: StreamingMetricsCollectorOptions = {}) {
    this.now = opts.now ?? (() => performance.now());
    this.emitIntervalMs = opts.emitIntervalMs ?? STREAMING_METRICS_EMIT_INTERVAL_MS;
  }

  /* ---- Live-value setters ------------------------------------------------ */

  setBudget(budgetBytes: number, usedBytes: number): void {
    this.budgetBytes = Math.max(0, budgetBytes);
    this.usedBytes = Math.max(0, usedBytes);
  }

  setQueueDepth(n: number): void {
    this.queueDepth = Math.max(0, Math.floor(n));
  }

  setDriftMB(driftMB: number): void {
    this.driftMB = driftMB;
  }

  setDegradationState(state: DegradationState): void {
    this.state = state;
  }

  /**
   * Push the latest per-source bytes from the budget ledger (ABH-114). The
   * orchestrator calls this once per render frame with
   * `pipeline.budgetLedger.bytesByCategory()` so the JSON line reflects
   * the live per-loader breakdown that /test-ralph reads to identify a
   * held-camera growth source.
   */
  setBytesByCategory(bytes: StreamingMetricsByCategory): void {
    this.bytesByCategoryBytes = {
      tiles: Math.max(0, bytes.tiles),
      vegetation: Math.max(0, bytes.vegetation),
      coarsePin: Math.max(0, bytes.coarsePin),
      staticLayer: Math.max(0, bytes.staticLayer),
      texturePool: Math.max(0, bytes.texturePool),
    };
  }

  /* ---- Event recorders --------------------------------------------------- */

  recordEviction(): void {
    this.evicted++;
  }

  recordLodDowngrade(): void {
    this.downgraded++;
  }

  recordActivation(bytes: number): void {
    if (bytes <= 0) return;
    this.activations.push({ time: this.now(), bytes });
    this.pruneActivations();
  }

  recordFrameDelta(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    this.frameDeltas.push(deltaMs);
    if (this.frameDeltas.length > FPS_WINDOW_SAMPLES) {
      this.frameDeltas.shift();
    }
  }

  /* ---- Snapshot + emit --------------------------------------------------- */

  snapshot(frame: number): StreamingMetrics {
    const t = this.now();
    this.pruneActivations(t);

    const budgetMB = Math.round(this.budgetBytes / BYTES_PER_MB);
    const usedMB = Math.round(this.usedBytes / BYTES_PER_MB);
    const util =
      this.budgetBytes > 0 ? roundTo(this.usedBytes / this.budgetBytes, 4) : 0;
    const activationRateMBps = this.computeActivationRate();
    const { p50, p5 } = this.computeFpsPercentiles();

    return {
      t,
      frame,
      state: DEGRADATION_STATE_LABELS[this.state],
      budgetMB,
      usedMB,
      util,
      activationRateMBps,
      queueDepth: this.queueDepth,
      evicted: this.evicted,
      downgraded: this.downgraded,
      driftMB: roundTo(this.driftMB, 2),
      fpsP50: p50,
      fpsP5: p5,
      byCategory: {
        tiles: Math.round(this.bytesByCategoryBytes.tiles / BYTES_PER_MB),
        vegetation: Math.round(this.bytesByCategoryBytes.vegetation / BYTES_PER_MB),
        coarsePin: Math.round(this.bytesByCategoryBytes.coarsePin / BYTES_PER_MB),
        staticLayer: Math.round(this.bytesByCategoryBytes.staticLayer / BYTES_PER_MB),
        texturePool: Math.round(this.bytesByCategoryBytes.texturePool / BYTES_PER_MB),
      },
    };
  }

  /**
   * Emit a snapshot to `console.debug` if the configured interval has
   * elapsed since the last emit. Returns the snapshot when it fires, or
   * null when throttled.
   */
  maybeEmit(frame: number): StreamingMetrics | null {
    const t = this.now();
    if (
      this.lastEmitTime !== null &&
      t - this.lastEmitTime < this.emitIntervalMs
    ) {
      return null;
    }
    this.lastEmitTime = t;
    const snap = this.snapshot(frame);
    console.debug(JSON.stringify(snap));
    return snap;
  }

  /* ---- Internals --------------------------------------------------------- */

  private pruneActivations(now: number = this.now()): void {
    const cutoff = now - ACTIVATION_RATE_WINDOW_MS;
    while (this.activations.length > 0 && this.activations[0]!.time < cutoff) {
      this.activations.shift();
    }
  }

  private computeActivationRate(): number {
    if (this.activations.length === 0) return 0;
    let totalBytes = 0;
    for (const a of this.activations) totalBytes += a.bytes;
    // Window is 1 second — bytes-in-window is bytes-per-second.
    return Math.round(totalBytes / BYTES_PER_MB);
  }

  private computeFpsPercentiles(): { p50: number; p5: number } {
    const n = this.frameDeltas.length;
    if (n === 0) return { p50: 0, p5: 0 };

    // Sort frame deltas ascending. p50 fps comes from the median delta;
    // p5 fps comes from the 95th-percentile delta (worst 5% of frames).
    const sorted = [...this.frameDeltas].sort((a, b) => a - b);
    const medianDelta = sorted[Math.floor(n / 2)] ?? 0;
    const worstIdx = Math.min(n - 1, Math.floor(n * 0.95));
    const worstDelta = sorted[worstIdx] ?? medianDelta;

    return {
      p50: medianDelta > 0 ? Math.round(1_000 / medianDelta) : 0,
      p5: worstDelta > 0 ? Math.round(1_000 / worstDelta) : 0,
    };
  }
}

function roundTo(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}
