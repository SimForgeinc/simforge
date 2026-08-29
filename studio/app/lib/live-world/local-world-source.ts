import { TruthStreamClient } from '@simforge-oss/training-env/browser';

import type { LiveWorldWorkerRequest, LiveWorldWorkerResponse } from './worker-protocol';
import type { ControlInput, SpawnActorRequest, WorldSource, WorldSourceStatus } from './types';

export function createLocalWorldSource(opts: {
  mapManifestUrl: string;
  laneGraphUrl?: string;
  tickHz?: number;
}): WorldSource {
  return new LocalWorldSource(opts);
}

class LocalWorldSource implements WorldSource {
  private readonly worker: Worker;
  private readonly decoder = new TruthStreamClient();
  private readonly frameListeners = new Set<Parameters<WorldSource['subscribeFrames']>[0]>();
  private readonly statusListeners = new Set<Parameters<WorldSource['subscribeStatus']>[0]>();
  private readonly warningListeners = new Set<(message: string) => void>();
  /**
   * Warnings are emitted while the worker initialises, which is before React
   * has had a chance to subscribe. Retain them and replay on subscribe, or the
   * only notice a world ever produces is silently dropped.
   */
  private readonly seenWarnings: string[] = [];
  private readonly pending = new Map<number, {
    resolve: (value: { actorId: string } | void) => void;
    reject: (error: Error) => void;
  }>();
  private nextRequestId = 1;
  private currentStatus: WorldSourceStatus = 'connecting';
  private currentError: string | null = null;

  constructor(opts: { mapManifestUrl: string; laneGraphUrl?: string; tickHz?: number }) {
    const tickHz = opts.tickHz ?? 20;
    this.worker = new Worker(new URL('../../../worker/live-world-worker.ts', import.meta.url), {
      type: 'module',
      name: 'simforge-live-world',
    });
    this.worker.onmessage = (event: MessageEvent<LiveWorldWorkerResponse>) => this.onMessage(event.data);
    this.worker.onerror = (event) => {
      this.setStatus('error', event.message || 'live world worker failed');
      this.rejectPending(this.currentError ?? 'live world worker failed');
    };
    this.worker.postMessage({
      type: 'init',
      mapManifestUrl: opts.mapManifestUrl,
      ...(opts.laneGraphUrl ? { laneGraphUrl: opts.laneGraphUrl } : {}),
      tickHz,
    } satisfies LiveWorldWorkerRequest);
  }

  get status(): WorldSourceStatus {
    return this.currentStatus;
  }

  get lastError(): string | null {
    return this.currentError;
  }

  subscribeFrames(fn: Parameters<WorldSource['subscribeFrames']>[0]): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  subscribeStatus(fn: Parameters<WorldSource['subscribeStatus']>[0]): () => void {
    this.statusListeners.add(fn);
    fn(this.currentStatus, this.currentError);
    return () => this.statusListeners.delete(fn);
  }

  subscribeWarnings(fn: (message: string) => void): () => void {
    this.warningListeners.add(fn);
    for (const message of this.seenWarnings) fn(message);
    return () => this.warningListeners.delete(fn);
  }

  spawn(req: SpawnActorRequest): Promise<{ actorId: string }> {
    return this.request<{ actorId: string }>({ type: 'spawn', request: req });
  }

  despawn(actorId: string): Promise<void> {
    return this.request<void>({ type: 'despawn', actorId });
  }

  control(input: ControlInput): void {
    if (this.currentStatus !== 'running') return;
    this.worker.postMessage({ type: 'control', input } satisfies LiveWorldWorkerRequest);
  }

  close(): void {
    if (this.currentStatus === 'closed') return;
    this.worker.postMessage({ type: 'close' } satisfies LiveWorldWorkerRequest);
    this.worker.terminate();
    this.rejectPending('live world source closed');
    this.setStatus('closed', null);
    this.frameListeners.clear();
    this.statusListeners.clear();
  }

  private request<T extends { actorId: string } | void>(
    message:
      | { type: 'spawn'; request: SpawnActorRequest }
      | { type: 'despawn'; actorId: string },
  ): Promise<T> {
    if (this.currentStatus === 'closed') return Promise.reject(new Error('live world source is closed'));
    const requestId = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: resolve as (value: { actorId: string } | void) => void,
        reject,
      });
      this.worker.postMessage({ ...message, requestId } as LiveWorldWorkerRequest);
    });
  }

  private onMessage(message: LiveWorldWorkerResponse): void {
    if (this.currentStatus === 'closed') return;
    if (message.type === 'ready') {
      this.setStatus('running', null);
      return;
    }
    if (message.type === 'frame') {
      try {
        for (const frame of this.decoder.push(new Uint8Array(message.bytes))) {
          for (const listener of this.frameListeners) listener(frame);
        }
      } catch (error) {
        this.setStatus('error', error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (message.type === 'result') {
      const request = this.pending.get(message.requestId);
      if (!request) return;
      this.pending.delete(message.requestId);
      request.resolve(message.actorId ? { actorId: message.actorId } : undefined);
      return;
    }
    if (message.type === 'warning') {
      // Non-fatal: the world is running and usable, but something about the
      // inputs will make it behave in a way the operator would misread.
      this.seenWarnings.push(message.message);
      for (const listener of this.warningListeners) listener(message.message);
      return;
    }
    // Handle the error variant explicitly rather than treating everything that
    // falls through as an error. New response variants get added to this union
    // by other work, and a fall-through would both mistype `requestId` and
    // silently report an unrelated message as a world failure.
    if (message.type !== 'error') return;
    if (message.requestId !== undefined) {
      const request = this.pending.get(message.requestId);
      if (request) {
        this.pending.delete(message.requestId);
        request.reject(new Error(message.message));
      }
      return;
    }
    this.setStatus('error', message.message);
  }

  private setStatus(status: WorldSourceStatus, error: string | null): void {
    if (this.currentStatus === status && this.currentError === error) return;
    this.currentStatus = status;
    this.currentError = error;
    for (const listener of this.statusListeners) listener(status, error);
  }

  private rejectPending(message: string): void {
    for (const request of this.pending.values()) request.reject(new Error(message));
    this.pending.clear();
  }
}
