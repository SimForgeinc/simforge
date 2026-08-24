/**
 * Leak responder — self-healing GC-assist that bounds leak damage when the
 * memory profiler flags sustained growth.
 *
 * The {@link import("../memory-profiler").MemoryProfiler} sets `leakSuspected`
 * when GPU memory has grown by more than 15 MB/min over 70% of recent
 * sampling intervals. Without intervention growth continues unbounded —
 * Three.js's per-resource `dispose()` may miss native references that the
 * tile pipeline can't reach by name. This responder periodically force-
 * disposes the oldest non-pinned cached tiles, allowing the JS GC and
 * driver-side cleanup to claw bytes back. The disposed tiles re-stream on
 * demand if the camera revisits them.
 *
 * This is a band-aid — it does not identify the leak source (issue #11).
 *
 * Triggering requires ALL of:
 *   1. `isLeakSuspected()` returns true
 *   2. No ledger activity (activate/evict) for `stabilityWindowMs`
 *   3. No LOD-selection / camera change for `stabilityWindowMs`
 *   4. At least `cooldownMs` has elapsed since the previous cycle
 *
 * See `.scratch/streaming-budget-pacing/issues/09-leak-responder.md`.
 */

const DEFAULT_STABILITY_WINDOW_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_DISPOSAL_COUNT = 3;
const BYTES_PER_MB = 1024 * 1024;

export interface LeakResponderActions {
  /**
   * Return up to `count` cache keys ordered oldest-first, excluding tiles
   * that are currently frustum-pinned (visible). The tile-manager owns the
   * pin policy; the responder just consumes the resulting list.
   */
  oldestDisposalCandidates(count: number): string[];

  /**
   * Force-dispose a tile from cache and the scene graph. Returns the bytes
   * freed so the responder can report `freedMB` in its structured event.
   * Wired by the tile-manager to `cache.delete(key)` + ledger debit + scene
   * detach (cache.delete() intentionally skips the LRU onEvict hook, so the
   * action drives those side-effects itself).
   */
  disposeTile(key: string): number;
}

export interface LeakResponderOptions {
  actions: LeakResponderActions;
  /** Reads the memory profiler's `leakSuspected` flag. */
  isLeakSuspected: () => boolean;
  /**
   * Returns the timestamp (in `now()` units) of the most recent ledger
   * activate/evict. Used to detect a stable tile count.
   */
  getLastLedgerActivityMs: () => number;
  /**
   * Returns the timestamp (in `now()` units) of the most recent LOD
   * selection change. Used to detect a stationary camera.
   */
  getLastCameraActivityMs: () => number;
  /** Wall clock; defaults to `performance.now`. Injected for deterministic tests. */
  now?: () => number;
  /** Stable-state window in ms. Defaults to 5000. */
  stabilityWindowMs?: number;
  /** Time between successive cycles in ms. Defaults to 30000. */
  cooldownMs?: number;
  /** Number of tiles disposed per cycle. Defaults to 3. */
  disposalCount?: number;
}

export class LeakResponder {
  private readonly actions: LeakResponderActions;
  private readonly isLeakSuspected: () => boolean;
  private readonly getLastLedgerActivityMs: () => number;
  private readonly getLastCameraActivityMs: () => number;
  private readonly now: () => number;
  private readonly stabilityWindowMs: number;
  private readonly cooldownMs: number;
  private readonly disposalCount: number;

  // -Infinity so the first eligible tick fires immediately. Only updated
  // when a cycle actually disposes >=1 tile — an empty-candidate tick must
  // not arm the cooldown (otherwise a pinned-only scene would silently lock
  // out the responder for 30 s after it first checks).
  private lastCycleMs = -Infinity;

  constructor(opts: LeakResponderOptions) {
    this.actions = opts.actions;
    this.isLeakSuspected = opts.isLeakSuspected;
    this.getLastLedgerActivityMs = opts.getLastLedgerActivityMs;
    this.getLastCameraActivityMs = opts.getLastCameraActivityMs;
    this.now = opts.now ?? (() => performance.now());
    this.stabilityWindowMs = opts.stabilityWindowMs ?? DEFAULT_STABILITY_WINDOW_MS;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.disposalCount = opts.disposalCount ?? DEFAULT_DISPOSAL_COUNT;
  }

  /**
   * Cheap per-frame poll. Returns immediately when any trigger condition
   * fails; performs the GC-assist cycle when all four conditions hold.
   */
  tick(): void {
    if (!this.isLeakSuspected()) return;

    const t = this.now();
    if (t - this.lastCycleMs < this.cooldownMs) return;
    if (t - this.getLastLedgerActivityMs() < this.stabilityWindowMs) return;
    if (t - this.getLastCameraActivityMs() < this.stabilityWindowMs) return;

    const candidates = this.actions.oldestDisposalCandidates(this.disposalCount);
    if (candidates.length === 0) return;

    let freedBytes = 0;
    for (const key of candidates) {
      freedBytes += this.actions.disposeTile(key);
    }

    this.lastCycleMs = t;
    const freedMB = Math.round((freedBytes / BYTES_PER_MB) * 10) / 10;
    console.log(
      `[LeakResponder] GC-assist cycle: disposed ${candidates.length} tiles, freed ~${freedMB} MB`,
      {
        event: "gc-assist",
        disposed: candidates.length,
        freedMB,
      },
    );
  }
}
