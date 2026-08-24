/**
 * Circuit-breaker eviction sweep — synchronous LRU walk that disposes oldest
 * non-pinned, non-active cached tiles until the ledger drops to a target
 * utilization or no eligible tiles remain.
 *
 * Used by the degradation controller's circuit-breaker entry path to convert
 * a "stop the bleeding" pause into "stop the bleeding *and* recover the
 * overshoot in one step." See
 * `.scratch/streaming-budget-pacing/issues/16-breaker-disposes-on-trip.md`.
 *
 * The host (TileManager) owns the cache and pinning state and adapts them to
 * the small interfaces declared here, so this module stays testable with a
 * synthetic scene fixture (no Three.js required).
 */

export interface BreakerEvictableTile {
  key: string;
  byteSize: number;
}

export interface BreakerEvictableCache {
  /** Yield every cached tile in LRU order, oldest first. */
  oldestFirst(): Iterable<BreakerEvictableTile>;
  /**
   * Synchronously dispose and remove a tile from the cache. Implementations
   * should cascade to any side-effects (scene-graph removal, ledger debit,
   * onEvict notifications) so the next read of `ledger.utilizationPercent`
   * reflects the freed bytes.
   */
  delete(key: string): boolean;
}

export interface BreakerEvictPredicates {
  /** Tile is in the pinned set (e.g. coarse pins) — sweep must respect it. */
  isPinned(key: string): boolean;
  /**
   * Tile is currently being viewed — sweep must respect it so the camera
   * never sees an empty hole. Typically the MRU entry of the cache.
   */
  isActive(key: string): boolean;
}

export interface BreakerEvictLedger {
  readonly utilizationPercent: number;
}

export interface BreakerEvictionResult {
  tilesEvicted: number;
  bytesFreed: number;
}

/**
 * Iterate `cache` oldest-first and dispose tiles that are neither pinned nor
 * active until `ledger.utilizationPercent <= targetPct` or there is nothing
 * left to evict. The candidate list is materialised before any deletes so the
 * cache iterator is not mutated mid-walk; deletes still happen synchronously
 * (and re-check the ledger between each one) so the sweep never overshoots.
 */
export function evictOldestUntilUnderUtilization(
  cache: BreakerEvictableCache,
  ledger: BreakerEvictLedger,
  predicates: BreakerEvictPredicates,
  targetPct: number,
): BreakerEvictionResult {
  if (ledger.utilizationPercent <= targetPct) {
    return { tilesEvicted: 0, bytesFreed: 0 };
  }

  const candidates: BreakerEvictableTile[] = [];
  for (const tile of cache.oldestFirst()) {
    if (predicates.isPinned(tile.key)) continue;
    if (predicates.isActive(tile.key)) continue;
    candidates.push(tile);
  }

  let tilesEvicted = 0;
  let bytesFreed = 0;
  for (const tile of candidates) {
    if (ledger.utilizationPercent <= targetPct) break;
    if (cache.delete(tile.key)) {
      tilesEvicted++;
      bytesFreed += tile.byteSize;
    }
  }

  return { tilesEvicted, bytesFreed };
}
