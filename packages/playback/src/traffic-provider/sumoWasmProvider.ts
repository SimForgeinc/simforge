import type {
  SumoWorkerRequest,
  SumoWorkerResponse,
  TrafficNetworkPayload,
  TrafficProvider,
  TrafficProviderInitialization,
  TrafficStepRequest,
  TrafficStepResult,
} from './protocol';

interface PendingRequest {
  readonly resolve: (value: SumoWorkerResponse) => void;
  readonly reject: (reason: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

const SUMO_WORKER_TIMEOUT_MS = 30_000;
/** Lazy, opt-in provider. Constructing it does not download SUMO. */
export class SumoWasmTrafficProvider implements TrafficProvider {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly moduleUrl = '/vendor/sumo/sumo.mjs',
    private readonly workerFactory?: () => Worker,
  ) {}

  async initialize(payload: TrafficNetworkPayload): Promise<TrafficProviderInitialization> {
    const network = payload.network.slice(0);
    const routes = payload.routes.slice(0);
    // A structured-cloned WebAssembly.Module needs neither a second binary
    // copy nor a second worker-side compile. Retain the byte path as the
    // compatibility fallback for callers that did not preload a module.
    const wasmBinary = payload.wasmModule ? undefined : payload.wasmBinary?.slice(0);
    const response = await this.send(
      { kind: 'init', id: this.nextId++, moduleUrl: this.moduleUrl, payload: { ...payload, network, routes, wasmBinary } },
      wasmBinary ? [network, routes, wasmBinary] : [network, routes],
    );
    if (response.kind !== 'ready') throw new Error(`Unexpected SUMO response: ${response.kind}`);
    return { initMilliseconds: response.initMilliseconds, heapBytes: response.heapBytes };
  }

  async step(request: TrafficStepRequest): Promise<TrafficStepResult> {
    const response = await this.send({ kind: 'step', id: this.nextId++, request });
    if (response.kind !== 'state') throw new Error(`Unexpected SUMO response: ${response.kind}`);
    return response;
  }

  async reset(request: TrafficStepRequest): Promise<TrafficStepResult> {
    const response = await this.send({ kind: 'reset', id: this.nextId++, request });
    if (response.kind !== 'state') throw new Error(`Unexpected SUMO response: ${response.kind}`);
    return response;
  }

  async reconfigure(payload: TrafficNetworkPayload, request: TrafficStepRequest): Promise<TrafficStepResult> {
    const network = payload.network.slice(0);
    const routes = payload.routes.slice(0);
    const response = await this.send(
      { kind: 'reconfigure', id: this.nextId++, payload: { ...payload, network, routes, wasmBinary: undefined, wasmModule: undefined }, request },
      [network, routes],
    );
    if (response.kind !== 'state') throw new Error(`Unexpected SUMO response: ${response.kind}`);
    return response;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const worker = this.worker;
    if (!worker) return this.closePromise = Promise.resolve();
    const id = this.nextId++;
    this.closePromise = this.sendTo(worker, { kind: 'close', id })
      // Worker termination is authoritative; shutdown errors must not leak from
      // an obsolete map session into the newly opened scenario.
      .then(() => undefined, () => undefined)
      .finally(() => {
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout);
          pending.reject(new Error('SUMO worker closed'));
        }
        this.pending.clear();
      });
    return this.closePromise;
  }

  private send(message: SumoWorkerRequest, transfer: Transferable[] = []): Promise<SumoWorkerResponse> {
    if (this.closed) return Promise.reject(new Error('SUMO provider is closed'));
    const worker = this.ensureWorker();
    return this.sendTo(worker, message, transfer);
  }

  private sendTo(worker: Worker, message: SumoWorkerRequest, transfer: Transferable[] = []): Promise<SumoWorkerResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error(`SUMO worker ${message.kind} exceeded ${SUMO_WORKER_TIMEOUT_MS / 1_000} seconds`);
        this.failWorker(worker, error);
      }, SUMO_WORKER_TIMEOUT_MS);
      this.pending.set(message.id, { resolve, reject, timeout });
      worker.postMessage(message, transfer);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    // Keep both URLs directly at the creation site so webpack can bundle the
    // TypeScript worker in workspace development while packed JavaScript keeps
    // loading the compiled worker artifact.
    const worker = this.workerFactory
      ? this.workerFactory()
      : process.env.NODE_ENV === 'development'
        ? new Worker(new URL('./sumoWasmWorker.ts', import.meta.url), { type: 'module' })
        : new Worker(new URL('./traffic-provider/sumoWasmWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<SumoWorkerResponse>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      clearTimeout(pending.timeout);
      if (event.data.kind === 'error') pending.reject(new Error(event.data.message));
      else pending.resolve(event.data);
    };
    worker.onerror = (event) => {
      this.failWorker(worker, new Error(event.message || 'SUMO worker failed'));
    };
    worker.onmessageerror = () => {
      this.failWorker(worker, new Error('SUMO worker returned an unreadable message'));
    };
    this.worker = worker;
    return worker;
  }

  private failWorker(worker: Worker, error: Error): void {
    worker.terminate();
    if (this.worker === worker) this.worker = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
