import { TruthStreamClient } from '@simforge/training-env/browser';

import type { ControlInput, SpawnActorRequest, WorldSource, WorldSourceStatus } from './types';

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 8_000;

type JsonRecord = Record<string, unknown>;
type PendingReply = {
  parse: (message: JsonRecord) => unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
} | null;

export function createRemoteWorldSource(opts: { truthUrl: string; commandUrl: string }): WorldSource {
  return new RemoteWorldSource(opts);
}

class RemoteWorldSource implements WorldSource {
  private readonly frameListeners = new Set<Parameters<WorldSource['subscribeFrames']>[0]>();
  private readonly statusListeners = new Set<Parameters<WorldSource['subscribeStatus']>[0]>();
  private readonly replies: PendingReply[] = [];
  private truthSocket: WebSocket | null = null;
  private commandSocket: WebSocket | null = null;
  private decoder = new TruthStreamClient();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private generation = 0;
  private currentStatus: WorldSourceStatus = 'idle';
  private currentError: string | null = null;
  private controlledActorId: string | null = null;
  private sessionActive = false;

  constructor(private readonly opts: { truthUrl: string; commandUrl: string }) {
    this.connect();
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

  async spawn(req: SpawnActorRequest): Promise<{ actorId: string }> {
    await this.ensureSession(req.controlled ? req.blueprint : undefined);
    if (req.controlled) {
      const requestId = `drive-${this.generation}-${Date.now().toString(36)}`;
      const response = await this.request({
        type: 'teleport',
        request_id: requestId,
        x: req.position.x,
        y: req.position.y,
        ...(req.position.z === undefined ? {} : { z: req.position.z }),
        ...(req.headingRad === undefined ? {} : { yaw: req.headingRad * 180 / Math.PI }),
      }, (message) => {
        if (message.type !== 'teleported' || message.success !== true || typeof message.vehicle_id !== 'string') {
          throw responseError(message, 'teleport');
        }
        return { actorId: message.vehicle_id };
      });
      this.controlledActorId = response.actorId;
      return response;
    }

    return this.request({
      type: 'spawn_dynamic_actor',
      blueprint: req.blueprint,
    }, (message) => {
      const actor = typeof message.actor === 'object' && message.actor !== null && !Array.isArray(message.actor)
        ? message.actor as JsonRecord
        : null;
      if (message.type !== 'dynamic_actor_spawned' || !actor || typeof actor.actor_id !== 'string') {
        throw responseError(message, 'spawn');
      }
      return { actorId: actor.actor_id };
    });
  }

  async despawn(actorId: string): Promise<void> {
    if (actorId === this.controlledActorId) {
      await this.request({ type: 'end_session' }, (message) => {
        if (message.type !== 'session_ended') throw responseError(message, 'despawn');
      });
      this.controlledActorId = null;
      this.sessionActive = false;
      return;
    }
    await this.request({ type: 'despawn_dynamic_actor', actor_id: actorId }, (message) => {
      if (message.type !== 'dynamic_actor_despawned') throw responseError(message, 'despawn');
    });
  }

  control(input: ControlInput): void {
    if (this.currentStatus !== 'running' || !isOpen(this.commandSocket)) return;
    this.replies.push(null);
    this.commandSocket.send(JSON.stringify({
      type: 'control',
      s: input.steer,
      t: input.throttle,
      b: input.brake,
      ...(input.reverse === undefined ? {} : { r: input.reverse }),
    }));
  }

  close(): void {
    if (this.currentStatus === 'closed') return;
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.truthSocket?.close();
    this.commandSocket?.close();
    this.truthSocket = null;
    this.commandSocket = null;
    this.rejectReplies('remote world source closed');
    this.setStatus('closed', null);
    this.frameListeners.clear();
    this.statusListeners.clear();
  }

  private connect(): void {
    if (this.currentStatus === 'closed') return;
    const generation = ++this.generation;
    this.decoder = new TruthStreamClient();
    this.setStatus('connecting', null);

    const truth = new WebSocket(this.opts.truthUrl);
    const command = new WebSocket(this.opts.commandUrl);
    truth.binaryType = 'arraybuffer';
    command.binaryType = 'arraybuffer';
    this.truthSocket = truth;
    this.commandSocket = command;

    truth.onopen = () => this.onOpen(generation);
    command.onopen = () => this.onOpen(generation);
    truth.onmessage = (event) => void this.onTruth(generation, event.data);
    command.onmessage = (event) => this.onCommand(generation, event.data);
    truth.onerror = () => this.disconnect(generation, 'truth socket failed');
    command.onerror = () => this.disconnect(generation, 'command socket failed');
    truth.onclose = () => this.disconnect(generation, 'truth socket closed');
    command.onclose = () => this.disconnect(generation, 'command socket closed');
  }

  private onOpen(generation: number): void {
    if (generation !== this.generation) return;
    if (!isOpen(this.truthSocket) || !isOpen(this.commandSocket)) return;
    this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    this.setStatus('running', null);
  }

  private async onTruth(generation: number, data: unknown): Promise<void> {
    if (generation !== this.generation || typeof data === 'string') return;
    try {
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data instanceof Blob
          ? new Uint8Array(await data.arrayBuffer())
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : null;
      if (!bytes || generation !== this.generation) return;
      for (const frame of this.decoder.push(bytes)) {
        for (const listener of this.frameListeners) listener(frame);
      }
    } catch (error) {
      this.disconnect(generation, error instanceof Error ? error.message : String(error));
    }
  }

  private onCommand(generation: number, data: unknown): void {
    if (generation !== this.generation || typeof data !== 'string') return;
    let message: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('command response is not an object');
      }
      message = parsed as JsonRecord;
    } catch (error) {
      this.disconnect(generation, error instanceof Error ? error.message : String(error));
      return;
    }

    const pending = this.replies.shift();
    if (!pending) return;
    if (message.type === 'error' || message.type === 'twin_error') {
      pending.reject(responseError(message, 'command'));
      return;
    }
    try {
      pending.resolve(pending.parse(message));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private disconnect(generation: number, reason: string): void {
    if (generation !== this.generation || this.currentStatus === 'closed') return;
    this.generation += 1;
    this.truthSocket?.close();
    this.commandSocket?.close();
    this.truthSocket = null;
    this.commandSocket = null;
    this.sessionActive = false;
    this.controlledActorId = null;
    this.rejectReplies(reason);
    this.setStatus('error', reason);

    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(MAX_RECONNECT_DELAY_MS, delay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async ensureSession(vehicle?: string): Promise<void> {
    if (this.sessionActive) return;
    const end = new Date();
    const start = new Date(end.getTime() - 60 * 60 * 1_000);
    const response = await this.request({
      type: 'start_session',
      start: start.toISOString(),
      end: end.toISOString(),
      ...(vehicle ? { vehicle } : {}),
    }, (message) => {
      if (message.type !== 'session_ready' || typeof message.vehicle_id !== 'string') {
        throw responseError(message, 'start session');
      }
      return { actorId: message.vehicle_id };
    });
    this.sessionActive = true;
    this.controlledActorId = response.actorId;
  }

  private request<T>(message: JsonRecord, parse: (message: JsonRecord) => T): Promise<T> {
    if (this.currentStatus === 'closed') return Promise.reject(new Error('remote world source is closed'));
    if (this.currentStatus !== 'running' || !isOpen(this.commandSocket)) {
      return Promise.reject(new Error('remote world command socket is not connected'));
    }
    return new Promise<T>((resolve, reject) => {
      this.replies.push({
        parse,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.commandSocket!.send(JSON.stringify(message));
    });
  }

  private rejectReplies(reason: string): void {
    const error = new Error(reason);
    for (const pending of this.replies.splice(0)) pending?.reject(error);
  }

  private setStatus(status: WorldSourceStatus, error: string | null): void {
    if (this.currentStatus === status && this.currentError === error) return;
    this.currentStatus = status;
    this.currentError = error;
    for (const listener of this.statusListeners) listener(status, error);
  }
}

function isOpen(socket: WebSocket | null): socket is WebSocket {
  return socket?.readyState === WebSocket.OPEN;
}


function responseError(message: JsonRecord, operation: string): Error {
  const detail = typeof message.message === 'string' ? message.message : `unexpected ${String(message.type)}`;
  return new Error(`${operation} failed: ${detail}`);
}
