/**
 * Frame-deferred disposal queue (ABH-111).
 *
 * Runtime tile eviction (DegradationController circuit-breaker sweep,
 * TileCache LRU eviction, in-place LOD swap) and cross-tile texture
 * dedupe used to call `.dispose()` synchronously inside the render-loop
 * tick. WebGPU's `queue.submit()` returns immediately while the GPU is
 * still consuming the buffer, so a synchronous dispose races the in-flight
 * submit and trips `THREE.Destroyed texture ... used in a submit`
 * validation errors that eventually freeze the WebGPU device.
 *
 * The queue is a ring of per-frame buckets. Callers `enqueue()` whatever
 * disposable they would have released synchronously, and the host calls
 * `advanceFrame()` at the START of every render-loop iteration — AFTER
 * `requestAnimationFrame` has fired (so the prior frame's `queue.submit()`
 * has been consumed) and BEFORE any new draws or disposes. The default
 * 2-frame depth means an item enqueued during frame N is released at the
 * start of frame N+2, after two `advanceFrame` calls.
 *
 * Teardown is not routed through here — call `flushAll()` from `dispose()`
 * paths because the renderer is unwiring in the same tick and the queue
 * would otherwise leak handles.
 */

export interface Disposable {
  dispose(): void;
}

export class DeferredDisposalQueue {
  /**
   * Newest-first ring of per-frame buckets. `buckets[0]` collects everything
   * the current frame enqueues; `advanceFrame()` rotates: the oldest bucket
   * is drained, a fresh empty bucket is pushed to the front, every other
   * bucket ages by one frame.
   *
   * Length equals `framesUntilDispose` so an item must survive that many
   * `advanceFrame()` calls before its `.dispose()` runs.
   */
  private buckets: Disposable[][];

  constructor(framesUntilDispose: number = 2) {
    const n = Math.max(1, Math.floor(framesUntilDispose));
    this.buckets = Array.from({ length: n }, () => []);
  }

  /**
   * Schedule a disposable for release after `framesUntilDispose` frames.
   * Silently ignores null / undefined / non-`.dispose()` targets so callers
   * can hand the queue whatever their Three.js traversal yielded without
   * pre-filtering.
   */
  enqueue(target: { dispose?: () => void } | null | undefined): void {
    if (!target || typeof target.dispose !== "function") return;
    this.buckets[0]!.push(target as Disposable);
  }

  /**
   * Advance one frame. Called at the START of each render-loop iteration,
   * after `requestAnimationFrame` has fired (so the prior frame's submit
   * has been consumed by the GPU) and BEFORE the new frame issues draws.
   *
   * Drains the oldest bucket and rotates so the queue stays in lockstep
   * with the renderer's frame counter.
   */
  advanceFrame(): void {
    const expired = this.buckets.pop();
    if (expired && expired.length > 0) this.releaseAll(expired);
    this.buckets.unshift([]);
  }

  /**
   * Synchronously release every pending bucket. Use ONLY from teardown
   * paths (CityViewerCore.dispose / TileCache.disposeAll) where the
   * renderer is unwiring in the same tick — there is no future frame to
   * corrupt and skipping the release would leak handles.
   */
  flushAll(): void {
    for (const bucket of this.buckets) {
      if (bucket.length > 0) this.releaseAll(bucket);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      this.buckets[i] = [];
    }
  }

  /** Total pending entries across every bucket. Diagnostics-only. */
  get size(): number {
    let total = 0;
    for (const b of this.buckets) total += b.length;
    return total;
  }

  private releaseAll(bucket: Disposable[]): void {
    for (const d of bucket) {
      try {
        d.dispose();
      } catch (err) {
        console.warn(
          "[DeferredDisposalQueue] dispose() threw — continuing:",
          err,
        );
      }
    }
  }
}
