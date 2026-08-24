import * as THREE from 'three/webgpu';

import type { DeferredDisposalQueue } from './deferred-disposal';

export interface CacheEntry {
  key: string;
  group: THREE.Group;
  byteSize: number;
}

/**
 * Polled snapshot of cache state for the audit aggregator (#07).
 * `pinnedCount` is the size of the union of frustum + coarse pins (no
 * double-counting). The frustum-pin set is empty in the current scope; the
 * union shape is preserved for forward-compat with `streaming-budget-pacing/06`.
 */
export interface CacheStats {
  evictionCount: number;
  bytesEvicted: number;
  pinnedCount: number;
  cachedCount: number;
  currentBytes: number;
}

export type LoadLodFn = (
  tileId: string,
  lodLevel: number,
) => Promise<{ group: THREE.Group; byteSize: number }>;

export interface TileCacheHooks {
  /** Loads the coarser/finer LOD variant when `downgradeToLod` / `upgradeToLod` swap a tile in place. */
  loadLod?: LoadLodFn;
  /** Notifies the budget ledger of bytes freed (negative delta) or consumed (positive delta) by an in-place LOD swap. */
  onBytesChanged?: (key: string, deltaBytes: number) => void;
  /** Diagnostic hook (issue #13): fires synchronously when an entry leaves the cache map. */
  onAfterDispose?: (
    disposed: CacheEntry,
    remaining: ReadonlyMap<string, CacheEntry>,
  ) => void;
  /**
   * Frame-deferred disposal queue (ABH-111). When set, runtime disposal
   * paths (`delete`, `evict`, `swapLod`) park geometry / material /
   * non-pooled-texture `.dispose()` calls on the queue rather than
   * firing them synchronously. The host advances the queue at the start
   * of every render frame so the in-flight WebGPU submit that may still
   * reference the handles has been consumed before disposal runs.
   * `disposeAll()` is teardown — it flushes the queue and disposes
   * synchronously because the renderer is unwiring in the same tick.
   */
  deferredDisposal?: DeferredDisposalQueue;
  /**
   * Returns true when a texture should NOT be disposed by tile eviction.
   * Used to teach `disposeEntry` that a texture lives in the cross-tile
   * texture-pool (ABH-46) and is shared by every other tile's material
   * slot — disposing it during a single tile's eviction would destroy the
   * canonical instance still referenced by other live tiles and trip a
   * destroyed-texture-in-submit error on the next render.
   *
   * Defaults to "always dispose" so tests and standalone callers that
   * never wire a pool keep the legacy behaviour. The tile-manager wires
   * `texture-pool.isPooledTexture` here in production.
   */
  isTexturePooled?: (tex: THREE.Texture) => boolean;
  /**
   * ABH-112 — fires synchronously at the start of `disposeSubtree`, BEFORE
   * the cache walks the subtree to release geometry / material / non-pooled
   * textures. The tile-manager wires this to
   * `texture-pool.releaseTileTextureReferences` so the pool's per-tile
   * refcount stays balanced as cache entries cycle through the LRU. The
   * pool itself decides whether the refcount transition to 0 retires the
   * canonical (and routes the GPU dispose through the wired
   * `DeferredDisposalQueue`) or leaves it alive for other referencing
   * tiles. Skipped from the teardown path (`disposeAll` →
   * `disposeSubtreeImmediate`) because `clearTexturePool` handles the
   * whole-pool reset in the same tick.
   */
  onReleasePoolRefs?: (root: THREE.Object3D) => void;
}

/** LRU cache with a memory budget for tile scene data */
export class TileCache {
  private entries = new Map<string, CacheEntry>();
  private currentBytes = 0;
  private pinned = new Set<string>();
  private coarsePinned = new Set<string>(); // insertion-ordered → LRU on the pinned set
  private coarsePinnedBytes = 0;
  private readonly coarsePinBudgetBytes: number;
  private surrenderWarned = false;
  private _evictionCount = 0;
  private _bytesEvicted = 0;
  private loadLod?: LoadLodFn;
  private onBytesChanged?: (key: string, deltaBytes: number) => void;
  private onAfterDispose?: (
    disposed: CacheEntry,
    remaining: ReadonlyMap<string, CacheEntry>,
  ) => void;
  private deferredDisposal?: DeferredDisposalQueue;
  private isTexturePooled?: (tex: THREE.Texture) => boolean;
  private onReleasePoolRefs?: (root: THREE.Object3D) => void;

  constructor(
    private maxBytes: number,
    private onEvict?: (key: string) => void,
    coarsePinBudgetBytes?: number,
    hooks: TileCacheHooks = {},
  ) {
    this.coarsePinBudgetBytes = coarsePinBudgetBytes ?? Math.floor(maxBytes * 0.3);
    this.loadLod = hooks.loadLod;
    this.onBytesChanged = hooks.onBytesChanged;
    this.onAfterDispose = hooks.onAfterDispose;
    this.deferredDisposal = hooks.deferredDisposal;
    this.isTexturePooled = hooks.isTexturePooled;
    this.onReleasePoolRefs = hooks.onReleasePoolRefs;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      // Move to end (most recently used)
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  put(key: string, entry: CacheEntry): void {
    if (this.entries.has(key)) {
      const old = this.entries.get(key)!;
      this.currentBytes -= old.byteSize;
      this.entries.delete(key);
    }
    this.currentBytes += entry.byteSize;
    this.entries.set(key, entry);
    this.evict();
  }

  /**
   * Drop an entry from the cache and release its GPU resources. Used by
   * explicit-eviction callers — the breaker sweep (issue #16), the
   * LeakResponder (#09), and tile-manager same-tile-different-LOD swaps.
   *
   * Byte accounting and the eviction counters (`evictionCount`,
   * `bytesEvicted`) update synchronously so the next read of
   * `cache.usageMB` / `cache.getStats()` reflects the freed bytes — the
   * cascade and the streaming-metrics `evicted` counter both depend on
   * this. Only the GPU `.dispose()` calls are deferred via the queue.
   */
  delete(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.currentBytes -= entry.byteSize;
      this._evictionCount++;
      this._bytesEvicted += entry.byteSize;
      this.entries.delete(key);
      this.pinned.delete(key);
      if (this.coarsePinned.delete(key)) {
        this.coarsePinnedBytes -= entry.byteSize;
      }
      this.disposeEntry(entry);
    }
    return entry;
  }

  /**
   * Pin or unpin a key; pinned entries are skipped during budget-driven
   * eviction. Used for in-frustum tiles — caller is responsible for
   * unpinning when the tile leaves the frustum. The key need not be
   * present in the cache at the time of pinning (idempotent and
   * order-independent with respect to `put`).
   */
  setPinned(key: string, pinned: boolean): void {
    if (pinned) {
      this.pinned.add(key);
    } else {
      this.pinned.delete(key);
    }
  }

  /**
   * Pin a coarse-LOD entry within the bounded `coarsePinBudgetBytes`
   * (default: 30% of `maxBytes`). When pinning a new entry would push
   * the coarse-pin set above the cap, the oldest coarse pin (LRU on
   * insertion order; `pinCoarse` on an already-pinned key refreshes
   * its position) is dropped first. Entries larger than the whole
   * coarse budget are refused. See ADR-0002.
   */
  pinCoarse(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (this.coarsePinned.has(key)) {
      // Already pinned — refresh LRU position to MRU
      this.coarsePinned.delete(key);
      this.coarsePinned.add(key);
      return;
    }
    while (
      this.coarsePinnedBytes + entry.byteSize > this.coarsePinBudgetBytes &&
      this.coarsePinned.size > 0
    ) {
      const oldest = this.coarsePinned.values().next().value;
      if (oldest === undefined) break;
      this.coarsePinned.delete(oldest);
      const oldestEntry = this.entries.get(oldest);
      if (oldestEntry) this.coarsePinnedBytes -= oldestEntry.byteSize;
    }
    if (this.coarsePinnedBytes + entry.byteSize > this.coarsePinBudgetBytes) {
      // Single entry larger than the whole coarse budget — refuse
      return;
    }
    this.coarsePinned.add(key);
    this.coarsePinnedBytes += entry.byteSize;
  }

  isPinned(key: string): boolean {
    return this.pinned.has(key) || this.coarsePinned.has(key);
  }

  /**
   * Drop every coarse-pin so the LRU eviction sweep (issue #16) is free to
   * reclaim the base layer when the circuit breaker trips. Used by the
   * degradation controller's `dropAllCoarsePins` action — see
   * `degradation-controller.ts` and ABH-53's wiring.
   */
  unpinAllCoarse(): void {
    if (this.coarsePinned.size === 0) return;
    this.coarsePinned.clear();
    this.coarsePinnedBytes = 0;
  }

  /**
   * Tear down: dispose every entry's GPU resources and empty the cache.
   * Skips `onEvict` because the caller is already unwiring (firing it
   * would cause double work on the active-tile detach path). The deferred-
   * disposal queue is flushed synchronously and remaining entries are
   * disposed immediately — by the time disposeAll() runs, the WebGPU
   * device itself is being torn down, so there is no future frame to
   * corrupt and any caller that drops the cache without draining would
   * otherwise leak handles.
   */
  disposeAll(): void {
    if (this.deferredDisposal) this.deferredDisposal.flushAll();
    for (const entry of this.entries.values()) {
      this.disposeEntryImmediate(entry);
    }
    this.entries.clear();
    this.currentBytes = 0;
    this.pinned.clear();
    this.coarsePinned.clear();
    this.coarsePinnedBytes = 0;
  }

  get usageMB(): number {
    return this.currentBytes / (1024 * 1024);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Polled snapshot of cache state for the audit aggregator (#07). Returns
   * a fresh object each call so callers can keep prior snapshots untouched.
   */
  getStats(): CacheStats {
    const pinnedKeys = new Set([...this.pinned, ...this.coarsePinned]);
    return {
      evictionCount: this._evictionCount,
      bytesEvicted: this._bytesEvicted,
      pinnedCount: pinnedKeys.size,
      cachedCount: this.entries.size,
      currentBytes: this.currentBytes,
    };
  }

  /**
   * Iterate cached entries in LRU order — oldest first, most-recently-used
   * last. Used by the circuit-breaker eviction sweep (issue #16) to walk
   * the cache without exposing the internal map. Iteration is read-only;
   * callers must use `delete(key)` to remove during iteration.
   */
  *entriesOldestFirst(): IterableIterator<CacheEntry> {
    for (const entry of this.entries.values()) {
      yield entry;
    }
  }

  /** Most-recently-used key, or undefined when the cache is empty. */
  get mruKey(): string | undefined {
    let last: string | undefined;
    for (const key of this.entries.keys()) last = key;
    return last;
  }

  /**
   * Swap a cached tile's geometry to a different LOD without removing the tile
   * from the scene graph.  The entry's `group` reference is preserved — only
   * the children inside are disposed and replaced — so the scene-graph parent
   * sees no flicker.  Used by the degradation controller to relieve memory
   * pressure (downgrade) and by recovery to restore quality (upgrade).
   *
   * The entry is re-keyed under `${tileId}:${targetLod}` so subsequent
   * lookups by LOD-suffixed key continue to work.  No-op when the entry is
   * already at `targetLod` or when the key is unknown.
   */
  async swapLod(key: string, targetLod: number): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;

    const colon = key.lastIndexOf(':');
    if (colon < 0) return;
    const tileId = key.slice(0, colon);
    const currentLod = parseInt(key.slice(colon + 1), 10);
    if (Number.isNaN(currentLod) || currentLod === targetLod) return;

    if (!this.loadLod) {
      throw new Error('TileCache.swapLod: loadLod hook not configured');
    }

    const loaded = await this.loadLod(tileId, targetLod);
    const newKey = `${tileId}:${targetLod}`;

    // Detach the existing children FIRST so the next render() walks no
    // soon-to-be-disposed meshes. The entry.group node itself stays
    // attached to the scene-graph so observers holding a reference keep
    // seeing it in the scene. GPU release for the detached subtree is
    // routed through the deferred-disposal queue when one is wired.
    const detached: THREE.Object3D[] = [];
    while (entry.group.children.length > 0) {
      const child = entry.group.children[0]!;
      entry.group.remove(child);
      detached.push(child);
    }
    for (const child of detached) {
      this.disposeSubtree(child);
    }

    // Re-parent the loaded LOD's meshes onto the existing entry group so
    // observers holding a reference to entry.group keep seeing it in the scene.
    while (loaded.group.children.length > 0) {
      entry.group.add(loaded.group.children[0]!);
    }

    const oldSize = entry.byteSize;
    const newSize = loaded.byteSize;
    this.entries.delete(key);
    entry.key = newKey;
    entry.byteSize = newSize;
    this.currentBytes += newSize - oldSize;
    this.entries.set(newKey, entry);

    // Migrate pin sets to the new key so the re-keyed entry stays protected.
    if (this.pinned.delete(key)) {
      this.pinned.add(newKey);
    }
    if (this.coarsePinned.delete(key)) {
      this.coarsePinned.add(newKey);
    }

    this.onBytesChanged?.(newKey, newSize - oldSize);

    // An upgrade can push the cache past `maxBytes`; let the LRU drop the
    // coldest entries so the cache contract still holds.  Downgrades always
    // free bytes so this is a no-op for them.
    if (this.currentBytes > this.maxBytes) {
      this.evict();
    }
  }

  /** Swap to a coarser LOD in place (frees bytes). */
  downgradeToLod(key: string, targetLod: number): Promise<void> {
    return this.swapLod(key, targetLod);
  }

  /** Swap back to a finer LOD in place (consumes bytes). */
  upgradeToLod(key: string, targetLod: number): Promise<void> {
    return this.swapLod(key, targetLod);
  }

  private evict(): void {
    if (this.currentBytes <= this.maxBytes) return;
    for (const [key, entry] of this.entries) {
      if (this.currentBytes <= this.maxBytes) return;
      if (this.entries.size <= 1) break;
      if (this.isPinned(key)) continue;
      this.currentBytes -= entry.byteSize;
      this._evictionCount++;
      this._bytesEvicted += entry.byteSize;
      this.entries.delete(key);
      // Defensive: evict() should never reach pinned entries, but if a key
      // is somehow in both sets we still keep the byte accounting honest.
      this.pinned.delete(key);
      if (this.coarsePinned.delete(key)) {
        this.coarsePinnedBytes -= entry.byteSize;
      }
      this.onEvict?.(key);
      this.disposeEntry(entry);
    }
    if (this.currentBytes > this.maxBytes && !this.surrenderWarned) {
      this.surrenderWarned = true;
      console.warn('[TileCache] eviction surrendered — pinned bytes ≥ budget');
    }
  }

  private disposeEntry(entry: CacheEntry): void {
    this.disposeSubtree(entry.group);
    this.onAfterDispose?.(entry, this.entries);
  }

  /**
   * Teardown variant — bypasses the deferred queue regardless of whether
   * one is wired. Used by `disposeAll()` so the renderer-unwire path does
   * not leak handles into a queue nobody will drain.
   */
  private disposeEntryImmediate(entry: CacheEntry): void {
    disposeSubtreeImmediate(entry.group, this.isTexturePooled);
    this.onAfterDispose?.(entry, this.entries);
  }

  /**
   * Walk a subtree and release its GPU resources via the deferred queue
   * when wired, otherwise synchronously. Textures the host marks as
   * pooled are skipped entirely — the texture-pool owns their lifetime
   * and disposing them here would destroy the canonical instance that
   * every other tile's material slot still references.
   */
  private disposeSubtree(root: THREE.Object3D): void {
    const queue = this.deferredDisposal;
    const isPooled = this.isTexturePooled;
    // The traverse walk runs FIRST so `isPooled` still answers truthfully
    // for every canonical the cross-tile pool currently owns — pooled
    // textures are skipped and survive to the `onReleasePoolRefs` step
    // below, which then decides via refcount whether to retire any of
    // them. If we ran `onReleasePoolRefs` first, a 1 → 0 retirement
    // would remove the canonical from `pooledInstances` AND enqueue its
    // dispose; this walk would then enqueue the same texture again
    // (because `isPooled` now returns false), producing a double-dispose
    // that races the ABH-111 destroyed-texture-in-submit gate.
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      releaseDisposable(obj.geometry, queue);
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m) continue;
        for (const value of Object.values(m)) {
          if (!(value instanceof THREE.Texture)) continue;
          if (isPooled?.(value)) continue;
          releaseDisposable(value, queue);
        }
        releaseDisposable(m, queue);
      }
    });
    // ABH-112: drop this tile's references in the cross-tile texture pool
    // AFTER the walk. The pool's `releaseTileTextureReferences` handles
    // the static-allocation debit and routes the retired canonical's
    // GPU `.dispose()` through the same deferred-disposal queue the walk
    // used. The caller's `ledger.evict()` lands after this whole method
    // returns, so order here doesn't change the cascade's ledger read —
    // we just need both halves of the debit (static-tex + tile-bytes) to
    // resolve before the next sweep iteration. Skipped on the teardown
    // path (`disposeSubtreeImmediate`) where `clearTexturePool` resets
    // the whole pool in the same tick.
    this.onReleasePoolRefs?.(root);
  }
}

function releaseDisposable(
  target: { dispose?: () => void } | null | undefined,
  queue: DeferredDisposalQueue | undefined,
): void {
  if (!target || typeof target.dispose !== 'function') return;
  if (queue) {
    queue.enqueue(target);
    return;
  }
  try {
    target.dispose();
  } catch (err) {
    console.warn('[TileCache] dispose() threw — continuing:', err);
  }
}

/**
 * Synchronous-only subtree disposal used by `disposeAll`. Mirrors
 * `disposeSubtree` but skips the deferred queue entirely (teardown is in
 * the same tick as renderer unwire). Pooled-texture skip is still
 * honoured so a shared texture that's about to be cleared by
 * `texture-pool.clearTexturePool()` is not double-disposed.
 */
function disposeSubtreeImmediate(
  root: THREE.Object3D,
  isTexturePooled?: (tex: THREE.Texture) => boolean,
): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.geometry?.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m) continue;
      for (const value of Object.values(m)) {
        if (!(value instanceof THREE.Texture)) continue;
        if (isTexturePooled?.(value)) continue;
        value.dispose();
      }
      m.dispose();
    }
  });
}
