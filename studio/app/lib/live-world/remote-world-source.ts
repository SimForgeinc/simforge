import { TruthStreamClient } from '@simforge/training-env/browser';

import type {
  ControlInput,
  SpawnActorRequest,
  TrajectoryPlaybackStatus,
  WorldClock,
  WorldSource,
  WorldSourceStatus,
} from './types';

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 8_000;
const TRAJECTORY_STATUS_INTERVAL_MS = 1_000;
export const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const REPLAY_MIN_SPEED = 0.25;
export const REPLAY_MAX_SPEED = 8;

type JsonRecord = Record<string, unknown>;
type PendingReply = {
  parse: (message: JsonRecord) => unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
} | null;
type PendingTwinReply = Exclude<PendingReply, null> & { speedHint: number };

export function clampReplaySpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.max(REPLAY_MIN_SPEED, Math.min(REPLAY_MAX_SPEED, speed));
}

export function normalizeReplayRequest(
  opts: { startIso: string; speed?: number },
  nowMs = Date.now(),
): { start: string; speed: number } {
  const startMs = Date.parse(opts.startIso);
  if (!Number.isFinite(startMs)) throw new Error("twin_replay requires ISO 'start'");
  if (startMs > nowMs || nowMs - startMs > REPLAY_WINDOW_MS) {
    throw new Error('Replay start must be within the past 24 hours');
  }
  return { start: new Date(startMs).toISOString(), speed: clampReplaySpeed(opts.speed ?? 1) };
}

export function parseTwinClockMessage(message: JsonRecord, speedHint = 1): WorldClock | null {
  if (message.type !== 'twin_clock' && message.type !== 'twin_mode') return null;
  if (message.mode !== 'live' && message.mode !== 'replay') return null;
  const replayClock = message.replay_clock;
  const timeIso = typeof replayClock === 'string' && Number.isFinite(Date.parse(replayClock))
    ? new Date(Date.parse(replayClock)).toISOString()
    : null;
  return {
    mode: message.mode,
    timeIso: message.mode === 'replay' ? timeIso : null,
    speed: message.mode === 'replay' ? clampReplaySpeed(speedHint) : 1,
  };
}

export function createRemoteWorldSource(opts: { truthUrl: string; commandUrl: string }): WorldSource {
  return new RemoteWorldSource(opts);
}

class RemoteWorldSource implements WorldSource {
  private readonly frameListeners = new Set<Parameters<WorldSource['subscribeFrames']>[0]>();
  private readonly statusListeners = new Set<Parameters<WorldSource['subscribeStatus']>[0]>();
  private readonly clockListeners = new Set<(clock: WorldClock) => void>();
  private readonly trajectoryListeners = new Set<(status: TrajectoryPlaybackStatus) => void>();
  private readonly replies: PendingReply[] = [];
  private readonly twinReplies: PendingTwinReply[] = [];
  private truthSocket: WebSocket | null = null;
  private commandSocket: WebSocket | null = null;
  private decoder = new TruthStreamClient();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private trajectoryTimer: ReturnType<typeof setInterval> | null = null;
  private trajectoryRequestInFlight = false;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private generation = 0;
  private currentStatus: WorldSourceStatus = 'idle';
  private currentError: string | null = null;
  private currentClock: WorldClock = { mode: 'live', timeIso: null, speed: 1 };
  private currentTrajectoryStatus: TrajectoryPlaybackStatus = { active: false };
  private lastReplayClockSample: { clockMs: number; receivedAtMs: number } | null = null;
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

  subscribeClock(fn: (clock: WorldClock) => void): () => void {
    this.clockListeners.add(fn);
    fn(this.currentClock);
    return () => this.clockListeners.delete(fn);
  }

  subscribeTrajectoryStatus(fn: (status: TrajectoryPlaybackStatus) => void): () => void {
    this.trajectoryListeners.add(fn);
    fn(this.currentTrajectoryStatus);
    this.syncTrajectoryPolling();
    return () => {
      this.trajectoryListeners.delete(fn);
      this.syncTrajectoryPolling();
    };
  }

  // Arrow properties, not prototype methods: `WorldSource` is consumed as a
  // plain object and callers legitimately pull members off it. A prototype
  // method loses `this` the moment that happens, failing at the call with
  // "cannot read properties of undefined".
  setReplay = async (opts: { startIso: string; speed?: number }): Promise<void> => {
    const replay = normalizeReplayRequest(opts);
    await this.requestTwin(
      { type: 'twin_replay', start: replay.start, speed: replay.speed },
      replay.speed,
      (message) => {
        if (message.type !== 'twin_mode' || message.mode !== 'replay') {
          throw responseError(message, 'replay');
        }
      },
    );
  };

  setLive = async (): Promise<void> => {
    await this.requestTwin({ type: 'twin_live' }, 1, (message) => {
      if (message.type !== 'twin_mode' || message.mode !== 'live') {
        throw responseError(message, 'return to live');
      }
    });
  };

  async listTrajectories(): Promise<ReadonlyArray<{ file: string; name?: string }>> {
    return this.request({ type: 'list_trajectories' }, (message) => {
      if (message.type !== 'trajectory_list' || !Array.isArray(message.trajectories)) {
        throw responseError(message, 'list trajectories');
      }
      const status = parseTrajectoryStatus(message.status);
      if (status) this.emitTrajectoryStatus(status);
      return message.trajectories.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || !('file' in entry) || typeof entry.file !== 'string') {
          return [];
        }
        return [{ file: entry.file, ...('name' in entry && typeof entry.name === 'string' ? { name: entry.name } : {}) }];
      });
    });
  }

  async startTrajectory(file: string): Promise<void> {
    await this.request({ type: 'start_trajectory', file }, (message) => {
      if (message.type !== 'trajectory_started') throw responseError(message, 'start trajectory');
      this.emitTrajectoryStatus({
        active: true,
        ...(typeof message.name === 'string' ? { name: message.name } : {}),
        ...(typeof message.duration === 'number' ? { duration: message.duration, elapsed: 0 } : {}),
        ...(typeof message.vehicle_id === 'string' ? { vehicleId: message.vehicle_id } : {}),
      });
    });
  }

  async stopTrajectory(): Promise<void> {
    await this.request({ type: 'stop_trajectory' }, (message) => {
      if (message.type !== 'trajectory_stopped') throw responseError(message, 'stop trajectory');
      this.emitTrajectoryStatus({ active: false });
    });
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
      const actor = message.actor;
      if (
        message.type !== 'dynamic_actor_spawned'
        || typeof actor !== 'object'
        || actor === null
        || Array.isArray(actor)
        || !('actor_id' in actor)
        || typeof actor.actor_id !== 'string'
      ) {
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
    this.stopTrajectoryPolling();
    this.truthSocket?.close();
    this.commandSocket?.close();
    this.truthSocket = null;
    this.commandSocket = null;
    this.rejectReplies('remote world source closed');
    this.setStatus('closed', null);
    this.frameListeners.clear();
    this.statusListeners.clear();
    this.clockListeners.clear();
    this.trajectoryListeners.clear();
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
    this.syncTrajectoryPolling();
  }

  private async onTruth(generation: number, data: unknown): Promise<void> {
    if (generation !== this.generation) return;
    if (typeof data === 'string') {
      this.onTwinMessage(generation, data);
      return;
    }
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

  private onTwinMessage(generation: number, data: string): void {
    const message = this.parseMessage(generation, data, 'twin');
    if (!message) return;
    const pending = this.twinReplies[0];
    if (message.type === 'twin_clock') {
      this.updateClock(message, pending?.speedHint);
      return;
    }
    if (message.type !== 'twin_mode' && message.type !== 'twin_error') return;

    if (message.type === 'twin_mode') this.updateClock(message, pending?.speedHint);
    const reply = this.twinReplies.shift();
    if (!reply) return;
    if (message.type === 'twin_error') {
      reply.reject(responseError(message, 'twin command'));
      return;
    }
    try {
      reply.resolve(reply.parse(message));
    } catch (error) {
      reply.reject(asError(error));
    }
  }

  private onCommand(generation: number, data: unknown): void {
    if (generation !== this.generation || typeof data !== 'string') return;
    const message = this.parseMessage(generation, data, 'command');
    if (!message) return;
    const pending = this.replies.shift();
    if (!pending) return;
    if (message.type === 'error' || message.type === 'twin_error') {
      pending.reject(responseError(message, 'command'));
      return;
    }
    try {
      pending.resolve(pending.parse(message));
    } catch (error) {
      pending.reject(asError(error));
    }
  }

  private parseMessage(generation: number, data: string, channel: string): JsonRecord | null {
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${channel} response is not an object`);
      }
      return parsed as JsonRecord;
    } catch (error) {
      this.disconnect(generation, asError(error).message);
      return null;
    }
  }

  private updateClock(message: JsonRecord, speedHint?: number): void {
    let speed = speedHint ?? this.currentClock.speed;
    const clockText = typeof message.replay_clock === 'string' ? message.replay_clock : null;
    const clockMs = clockText === null ? Number.NaN : Date.parse(clockText);
    const receivedAtMs = Date.now();
    if (speedHint === undefined && message.mode === 'replay' && Number.isFinite(clockMs) && this.lastReplayClockSample) {
      const wallDelta = receivedAtMs - this.lastReplayClockSample.receivedAtMs;
      const clockDelta = clockMs - this.lastReplayClockSample.clockMs;
      if (wallDelta > 0 && clockDelta >= 0) speed = clampReplaySpeed(clockDelta / wallDelta);
    }
    const parsed = parseTwinClockMessage(message, speed);
    if (!parsed) return;
    this.currentClock = parsed;
    this.lastReplayClockSample = parsed.mode === 'replay' && parsed.timeIso !== null
      ? { clockMs: Date.parse(parsed.timeIso), receivedAtMs }
      : null;
    for (const listener of this.clockListeners) listener(parsed);
  }

  private disconnect(generation: number, reason: string): void {
    if (generation !== this.generation || this.currentStatus === 'closed') return;
    this.generation += 1;
    this.truthSocket?.close();
    this.commandSocket?.close();
    this.truthSocket = null;
    this.commandSocket = null;
    this.stopTrajectoryPolling();
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
      this.replies.push({ parse, resolve: resolve as (value: unknown) => void, reject });
      this.commandSocket!.send(JSON.stringify(message));
    });
  }

  private requestTwin<T>(
    message: JsonRecord,
    speedHint: number,
    parse: (message: JsonRecord) => T,
  ): Promise<T> {
    if (this.currentStatus === 'closed') return Promise.reject(new Error('remote world source is closed'));
    if (this.currentStatus !== 'running' || !isOpen(this.truthSocket)) {
      return Promise.reject(new Error('remote world twin socket is not connected'));
    }
    return new Promise<T>((resolve, reject) => {
      this.twinReplies.push({
        parse,
        speedHint,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.truthSocket!.send(JSON.stringify(message));
    });
  }

  private syncTrajectoryPolling(): void {
    if (this.trajectoryListeners.size === 0 || this.currentStatus !== 'running') {
      this.stopTrajectoryPolling();
      return;
    }
    if (this.trajectoryTimer) return;
    void this.refreshTrajectoryStatus();
    this.trajectoryTimer = setInterval(() => void this.refreshTrajectoryStatus(), TRAJECTORY_STATUS_INTERVAL_MS);
  }

  private stopTrajectoryPolling(): void {
    if (this.trajectoryTimer) clearInterval(this.trajectoryTimer);
    this.trajectoryTimer = null;
    this.trajectoryRequestInFlight = false;
  }

  private async refreshTrajectoryStatus(): Promise<void> {
    if (this.trajectoryRequestInFlight || this.currentStatus !== 'running') return;
    this.trajectoryRequestInFlight = true;
    try {
      const status = await this.request({ type: 'trajectory_status' }, (message) => {
        if (message.type !== 'trajectory_status') throw responseError(message, 'trajectory status');
        const parsed = parseTrajectoryStatus(message);
        if (!parsed) throw new Error('trajectory status failed: invalid response');
        return parsed;
      });
      this.emitTrajectoryStatus(status);
    } catch (error) {
      this.emitTrajectoryStatus({ ...this.currentTrajectoryStatus, error: asError(error).message });
    } finally {
      this.trajectoryRequestInFlight = false;
    }
  }

  private emitTrajectoryStatus(status: TrajectoryPlaybackStatus): void {
    this.currentTrajectoryStatus = status;
    for (const listener of this.trajectoryListeners) listener(status);
  }

  private rejectReplies(reason: string): void {
    const error = new Error(reason);
    for (const pending of this.replies.splice(0)) pending?.reject(error);
    for (const pending of this.twinReplies.splice(0)) pending.reject(error);
  }

  private setStatus(status: WorldSourceStatus, error: string | null): void {
    if (this.currentStatus === status && this.currentError === error) return;
    this.currentStatus = status;
    this.currentError = error;
    for (const listener of this.statusListeners) listener(status, error);
  }
}

function parseTrajectoryStatus(value: unknown): TrajectoryPlaybackStatus | null {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || !('active' in value)
    || typeof value.active !== 'boolean'
  ) {
    return null;
  }
  return {
    active: value.active,
    ...('name' in value && typeof value.name === 'string' ? { name: value.name } : {}),
    ...('elapsed' in value && typeof value.elapsed === 'number' ? { elapsed: value.elapsed } : {}),
    ...('duration' in value && typeof value.duration === 'number' ? { duration: value.duration } : {}),
    ...('vehicle_id' in value && typeof value.vehicle_id === 'string' ? { vehicleId: value.vehicle_id } : {}),
    ...('finished' in value && typeof value.finished === 'boolean' ? { finished: value.finished } : {}),
  };
}

function isOpen(socket: WebSocket | null): socket is WebSocket {
  return socket?.readyState === WebSocket.OPEN;
}


function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function responseError(message: JsonRecord, operation: string): Error {
  const detail = typeof message.message === 'string' ? message.message : `unexpected ${String(message.type)}`;
  return new Error(`${operation} failed: ${detail}`);
}
