export type CameraFeedState = 'live' | 'replay' | 'starting' | 'unavailable';

export interface CameraFeeds {
  readonly states: Readonly<Record<string, CameraFeedState>>;
  subscribeFrames(cameraId: string, onFrame: (frame: ImageBitmap) => void): () => void;
  subscribeStates(fn: (states: Readonly<Record<string, CameraFeedState>>) => void): () => void;
  close(): void;
}

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 8_000;
const STALE_FRAME_TIMEOUT_MS = 5_000;
const CAMERA_FEED_HEADER_BYTES = 8;
const CAMERA_FEED_MAGIC = [0x53, 0x46, 0x43, 0x46] as const;
const CHANNEL_BY_CODE: Readonly<Record<number, string>> = { 1: 'ch1', 2: 'ch2', 3: 'ch3', 4: 'ch4' };
const STATE_BY_CODE: Readonly<Record<number, CameraFeedState>> = { 0: 'starting', 1: 'live', 2: 'replay' };

export function createMultiplexedCameraFeeds(opts: { url: string }): CameraFeeds {
  return new MultiplexedCameraFeeds(resolveCameraFeedUrl(opts.url));
}

class MultiplexedCameraFeeds implements CameraFeeds {
  private readonly frameListeners = new Map<string, Set<(frame: ImageBitmap) => void>>();
  private readonly stateListeners = new Set<(states: Readonly<Record<string, CameraFeedState>>) => void>();
  private readonly frameSequences = new Map<string, number>();
  private readonly staleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private generation = 0;
  private closed = false;
  private currentStates: Readonly<Record<string, CameraFeedState>> = {};

  constructor(private readonly url: string) {
    this.connect();
  }

  get states(): Readonly<Record<string, CameraFeedState>> {
    return this.currentStates;
  }

  subscribeFrames(cameraId: string, onFrame: (frame: ImageBitmap) => void): () => void {
    let listeners = this.frameListeners.get(cameraId);
    if (!listeners) {
      listeners = new Set();
      this.frameListeners.set(cameraId, listeners);
    }
    listeners.add(onFrame);
    return () => {
      listeners.delete(onFrame);
      if (listeners.size === 0) this.frameListeners.delete(cameraId);
    };
  }

  subscribeStates(fn: (states: Readonly<Record<string, CameraFeedState>>) => void): () => void {
    this.stateListeners.add(fn);
    fn(this.currentStates);
    return () => this.stateListeners.delete(fn);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const timer of this.staleTimers.values()) clearTimeout(timer);
    this.staleTimers.clear();
    this.socket?.close();
    this.socket = null;
    this.frameListeners.clear();
    this.stateListeners.clear();
    this.frameSequences.clear();
  }

  private connect(): void {
    if (this.closed) return;
    const generation = ++this.generation;
    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      if (generation === this.generation) this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    };
    socket.onmessage = (event) => void this.onMessage(generation, event.data);
    socket.onerror = () => this.disconnect(generation);
    socket.onclose = () => this.disconnect(generation);
  }

  private async onMessage(generation: number, data: unknown): Promise<void> {
    if (generation !== this.generation || this.closed) return;
    if (typeof data === 'string') {
      this.onStateMessage(generation, data);
      return;
    }
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : data instanceof Blob
        ? new Uint8Array(await data.arrayBuffer())
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : null;
    if (!bytes || generation !== this.generation || this.closed) return;

    const parsed = parseCameraFeedFrame(bytes);
    if (!parsed) return;
    this.setChannelState(parsed.cameraId, parsed.state);
    this.armStaleTimer(parsed.cameraId, generation);

    const listeners = this.frameListeners.get(parsed.cameraId);
    if (!listeners?.size) return;
    const sequence = (this.frameSequences.get(parsed.cameraId) ?? 0) + 1;
    this.frameSequences.set(parsed.cameraId, sequence);

    let bitmap: ImageBitmap;
    try {
      const jpeg = parsed.jpeg.slice().buffer;
      bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
    } catch (error) {
      if (generation === this.generation) this.setChannelState(parsed.cameraId, 'unavailable');
      console.error(`[camera-feeds] failed to decode ${parsed.cameraId}`, error);
      return;
    }

    if (generation !== this.generation || this.closed || this.frameSequences.get(parsed.cameraId) !== sequence) {
      bitmap.close();
      return;
    }
    try {
      for (const listener of [...listeners]) {
        try {
          listener(bitmap);
        } catch (error) {
          console.error(`[camera-feeds] ${parsed.cameraId} subscriber failed`, error);
        }
      }
    } finally {
      bitmap.close();
    }
  }

  private onStateMessage(generation: number, raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isStateMessage(message) || generation !== this.generation) return;
    const next: Record<string, CameraFeedState> = {};
    for (const [cameraId, state] of Object.entries(message.states)) {
      if (!isCameraFeedState(state)) continue;
      next[cameraId] = state;
      if (state === 'live' || state === 'replay') this.armStaleTimer(cameraId, generation);
      else this.clearStaleTimer(cameraId);
    }
    this.setStates(next);
  }

  private armStaleTimer(cameraId: string, generation: number): void {
    this.clearStaleTimer(cameraId);
    this.staleTimers.set(cameraId, setTimeout(() => {
      this.staleTimers.delete(cameraId);
      if (generation === this.generation && !this.closed) this.setChannelState(cameraId, 'unavailable');
    }, STALE_FRAME_TIMEOUT_MS));
  }

  private clearStaleTimer(cameraId: string): void {
    const timer = this.staleTimers.get(cameraId);
    if (timer) clearTimeout(timer);
    this.staleTimers.delete(cameraId);
  }

  private disconnect(generation: number): void {
    if (generation !== this.generation || this.closed) return;
    this.generation += 1;
    this.socket?.close();
    this.socket = null;
    for (const timer of this.staleTimers.values()) clearTimeout(timer);
    this.staleTimers.clear();
    this.markKnownChannelsUnavailable();
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(MAX_RECONNECT_DELAY_MS, delay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private markKnownChannelsUnavailable(): void {
    const next: Record<string, CameraFeedState> = {};
    for (const cameraId of Object.keys(this.currentStates)) next[cameraId] = 'unavailable';
    this.setStates(next);
  }

  private setChannelState(cameraId: string, state: CameraFeedState): void {
    if (this.currentStates[cameraId] !== state) this.setStates({ ...this.currentStates, [cameraId]: state });
  }

  private setStates(states: Readonly<Record<string, CameraFeedState>>): void {
    if (sameStates(this.currentStates, states)) return;
    this.currentStates = Object.freeze({ ...states });
    for (const listener of this.stateListeners) listener(this.currentStates);
  }
}

function parseCameraFeedFrame(bytes: Uint8Array): { cameraId: string; state: CameraFeedState; jpeg: Uint8Array } | null {
  if (bytes.byteLength <= CAMERA_FEED_HEADER_BYTES) return null;
  for (let index = 0; index < CAMERA_FEED_MAGIC.length; index += 1) {
    if (bytes[index] !== CAMERA_FEED_MAGIC[index]) return null;
  }
  if (bytes[4] !== 1) return null;
  const cameraId = CHANNEL_BY_CODE[bytes[5]!];
  const state = STATE_BY_CODE[bytes[6]!];
  if (!cameraId || !state) return null;
  const jpeg = bytes.subarray(CAMERA_FEED_HEADER_BYTES);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) return null;
  return { cameraId, state, jpeg };
}

function isStateMessage(value: unknown): value is { type: 'camera_feed_states'; states: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === 'camera_feed_states' && !!record.states && typeof record.states === 'object' && !Array.isArray(record.states);
}

function isCameraFeedState(value: unknown): value is CameraFeedState {
  return value === 'live' || value === 'replay' || value === 'starting' || value === 'unavailable';
}

function sameStates(left: Readonly<Record<string, CameraFeedState>>, right: Readonly<Record<string, CameraFeedState>>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

/** Accepts Drive's twin values: ws(s) URL, `1`/`true`, or a port on the page host. */
function resolveCameraFeedUrl(raw: string): string {
  if (typeof window === 'undefined') return raw;
  const selected = raw || new URLSearchParams(window.location.search).get('twin') || process.env.NEXT_PUBLIC_DRIVE_TWIN_URL || '1';
  if (/^wss?:\/\//.test(selected)) {
    const url = new URL(selected);
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/camera-feeds';
    return url.toString();
  }
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const port = selected === '1' || selected === 'true' ? '8765' : selected;
  return `${scheme}://${window.location.hostname}:${port}/camera-feeds`;
}
