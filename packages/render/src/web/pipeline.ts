import { throwIfAborted } from './artifacts.js';

export type PipelineTimings = Readonly<{
  queuedMs: number;
  executionMs: number;
}>;

/**
 * Bounded asynchronous CPU stage. Producers backpressure at maxPending instead
 * of retaining an entire clip. Supplying Web Worker executors moves the work
 * off the render thread; the scheduling contract is identical for local stages.
 */
export class BoundedCpuPipeline {
  private pending = 0;
  private running = 0;
  private readonly capacityWaiters: (() => void)[] = [];
  private readonly slotWaiters: (() => void)[] = [];
  private readonly idle: (() => void)[] = [];
  private cancelled: unknown = null;

  constructor(
    readonly concurrency = Math.max(1, Math.min(4, globalThis.navigator?.hardwareConcurrency || 2)),
    readonly maxPending = concurrency * 2,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Pipeline concurrency must be a positive integer.');
    if (!Number.isSafeInteger(maxPending) || maxPending < concurrency) throw new Error('Pipeline capacity must cover every worker.');
  }

  async run<T>(operation: () => Promise<T> | T, signal?: AbortSignal): Promise<Readonly<{ value: T; timings: PipelineTimings }>> {
    const queuedAt = performance.now();
    while (this.pending >= this.maxPending) {
      throwIfAborted(signal);
      if (this.cancelled !== null) throw this.cancelled;
      await new Promise<void>((resolve) => this.capacityWaiters.push(resolve));
    }
    this.pending += 1;
    while (this.running >= this.concurrency) {
      throwIfAborted(signal);
      if (this.cancelled !== null) throw this.cancelled;
      await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    }
    this.running += 1;
    const startedAt = performance.now();
    try {
      throwIfAborted(signal);
      if (this.cancelled !== null) throw this.cancelled;
      const value = await operation();
      throwIfAborted(signal);
      return { value, timings: { queuedMs: startedAt - queuedAt, executionMs: performance.now() - startedAt } };
    } finally {
      this.running -= 1;
      this.pending -= 1;
      this.slotWaiters.shift()?.();
      this.capacityWaiters.shift()?.();
      if (this.pending === 0) for (const resolve of this.idle.splice(0)) resolve();
    }
  }

  async drain(): Promise<void> {
    if (this.pending === 0) return;
    await new Promise<void>((resolve) => this.idle.push(resolve));
  }

  cancel(reason: unknown = new DOMException('Pipeline cancelled', 'AbortError')): void {
    this.cancelled = reason;
    for (const resolve of this.capacityWaiters.splice(0)) resolve();
    for (const resolve of this.slotWaiters.splice(0)) resolve();
  }
}

export type WorkerRequest = Readonly<{ id: number; payload: unknown }>;
export type WorkerResponse = Readonly<{ id: number; value?: unknown; error?: string }>;

/** Small request/response executor suitable for serializer or visualization workers. */
export class ModuleWorkerExecutor {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly worker: Worker) {
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      this.pending.delete(event.data.id);
      if (event.data.error !== undefined) request.reject(new Error(event.data.error));
      else request.resolve(event.data.value);
    });
    worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'CPU worker failed.');
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
  }

  execute<T>(payload: unknown, transfer: Transferable[] = [], signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        reject(signal?.reason ?? new DOMException('Worker operation cancelled', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', abort);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
      });
      this.worker.postMessage({ id, payload } satisfies WorkerRequest, transfer);
    });
  }

  close(reason = new Error('CPU worker closed.')): void {
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(reason);
    this.pending.clear();
  }
}
