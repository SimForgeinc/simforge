/**
 * Routes coarse-pin pre-load activations through the same activation gate
 * and budget ledger that the on-demand streaming path uses.
 *
 * Wired by the tile-manager orchestration step (#08): until both gate and
 * ledger have been injected via setGate / setLedger, isWired stays false
 * and the pacer is a transparent no-op (TileManager.preloadTiles falls back
 * to its existing memory-guard path).
 *
 * When wired:
 *   - tryAcquire(key, estimatedBytes, payload) consults the ledger; if the
 *     budget refuses the activation it pushes the request onto a pending
 *     queue and returns 'budget-refused'. The streaming path drains the
 *     queue via takePending() when capacity frees up.
 *   - When the budget accepts, the gate is awaited (paces 1 tile/frame and
 *     30 MB/frame in the streaming-path implementation).
 *   - registerActivated(key, actualBytes) bumps the ledger using post-parse
 *     bytes — the upstream estimate uses LOD file size which differs from
 *     the in-scene byteSize.
 */

export interface StreamingGate {
  /**
   * Wait until the gate has capacity for `byteSize`, then consume the slot.
   * The streaming-path implementation paces 1 tile per frame with a 30 MB
   * per-frame cap.
   */
  acquire(byteSize: number): Promise<void>;
}

export interface StreamingBudgetLedger {
  /** Return true if the ledger has room for `byteSize` worth of activations. */
  canActivate(byteSize: number): boolean;

  /**
   * Register an activation against the ledger's running total. The optional
   * `category` argument tags the bytes for /test-ralph's per-source
   * accounting (ABH-114); the coarse-pin pacer passes `"coarsePin"` so
   * boot-time pre-loads can be distinguished from runtime gate
   * activations in the emitted metric line.
   */
  activate(key: string, byteSize: number, category?: string): void;
}

export interface PendingCoarseTile<T> {
  key: string;
  estimatedBytes: number;
  payload: T;
}

export type AcquireDecision = "accepted" | "budget-refused";

export class CoarsePinPacer<T = unknown> {
  private gate: StreamingGate | null = null;
  private ledger: StreamingBudgetLedger | null = null;
  private pending: PendingCoarseTile<T>[] = [];

  setGate(gate: StreamingGate | null): void {
    this.gate = gate;
  }

  setLedger(ledger: StreamingBudgetLedger | null): void {
    this.ledger = ledger;
  }

  get isWired(): boolean {
    return this.gate !== null && this.ledger !== null;
  }

  /**
   * Decide whether `key` may activate now.
   *
   *   - 'budget-refused': ledger said no. The request is held in the pending
   *     queue; the streaming path will drain it via takePending() when budget
   *     frees up. The caller must NOT add the tile to the scene.
   *   - 'accepted': the gate has been awaited. The caller may proceed to
   *     fetch / parse / addTileToScene, then call registerActivated() with
   *     the post-parse byteSize.
   *
   * When the pacer is un-wired, returns 'accepted' immediately so legacy
   * (non-streaming) callers behave as before.
   */
  async tryAcquire(
    key: string,
    estimatedBytes: number,
    payload: T,
  ): Promise<AcquireDecision> {
    if (this.ledger && !this.ledger.canActivate(estimatedBytes)) {
      this.pending.push({ key, estimatedBytes, payload });
      return "budget-refused";
    }
    if (this.gate) await this.gate.acquire(estimatedBytes);
    return "accepted";
  }

  /**
   * Register an activation against the ledger using actual (post-parse)
   * bytes. Called by the caller after addTileToScene succeeds. The bytes
   * are tagged with category `"coarsePin"` so /test-ralph's per-source
   * accounting (ABH-114) can distinguish boot pre-load and re-entry
   * traffic from runtime ActivationGate traffic.
   */
  registerActivated(key: string, actualBytes: number): void {
    if (this.ledger) this.ledger.activate(key, actualBytes, "coarsePin");
  }

  pendingTiles(): readonly PendingCoarseTile<T>[] {
    return this.pending;
  }

  pendingSize(): number {
    return this.pending.length;
  }

  /**
   * Take pending tiles whose budget now fits, in FIFO order, up to
   * `maxTiles`. The caller is responsible for actually loading and
   * scene-adding each returned tile, then calling registerActivated().
   *
   * If no ledger is wired, every pending tile is returned (drain-all).
   */
  takePending(maxTiles = Number.POSITIVE_INFINITY): PendingCoarseTile<T>[] {
    if (!this.ledger) {
      const all = this.pending;
      this.pending = [];
      return all.slice(0, Math.max(0, Math.floor(maxTiles)));
    }
    const taken: PendingCoarseTile<T>[] = [];
    const remaining: PendingCoarseTile<T>[] = [];
    for (const p of this.pending) {
      if (taken.length < maxTiles && this.ledger.canActivate(p.estimatedBytes)) {
        taken.push(p);
      } else {
        remaining.push(p);
      }
    }
    this.pending = remaining;
    return taken;
  }

  clearPending(): void {
    this.pending = [];
  }
}
