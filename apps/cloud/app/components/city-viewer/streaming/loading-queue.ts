import { MAX_CONCURRENT_FETCHES } from '../constants';

interface QueueItem {
  key: string;
  url: string;
  priority: number;
  abort: AbortController;
}

export class LoadingQueue {
  private queue: QueueItem[] = [];
  private active = new Map<string, QueueItem>();
  private maxConcurrent: number;

  constructor(maxConcurrent = MAX_CONCURRENT_FETCHES) {
    this.maxConcurrent = maxConcurrent;
  }

  /** Add or update priority of a tile load request */
  enqueue(key: string, url: string, priority: number): void {
    // Already loading
    if (this.active.has(key)) return;

    const existing = this.queue.find((q) => q.key === key);
    if (existing) {
      existing.priority = priority;
      return;
    }

    this.queue.push({ key, url, priority, abort: new AbortController() });
  }

  /** Cancel a queued or active request */
  cancel(key: string): void {
    const idx = this.queue.findIndex((q) => q.key === key);
    if (idx >= 0) this.queue.splice(idx, 1);

    const act = this.active.get(key);
    if (act) {
      act.abort.abort();
      this.active.delete(key);
    }
  }

  /**
   * Process up to N items from the queue.
   * Returns items that should start loading.
   */
  processNext(): { key: string; url: string; signal: AbortSignal }[] {
    // Sort by priority descending
    this.queue.sort((a, b) => b.priority - a.priority);

    const toStart: { key: string; url: string; signal: AbortSignal }[] = [];
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.active.set(item.key, item);
      toStart.push({ key: item.key, url: item.url, signal: item.abort.signal });
    }
    return toStart;
  }

  /** Mark a load as complete */
  complete(key: string): void {
    this.active.delete(key);
  }

  get activeCount(): number {
    return this.active.size;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /** Cancel all items not in the desired set */
  pruneExcept(desiredKeys: Set<string>): void {
    // Cancel queued items not desired
    this.queue = this.queue.filter((q) => {
      if (!desiredKeys.has(q.key)) {
        return false; // remove from queue
      }
      return true;
    });

    // Cancel active fetches not desired
    for (const [key, item] of this.active) {
      if (!desiredKeys.has(key)) {
        item.abort.abort();
        this.active.delete(key);
      }
    }
  }
}
