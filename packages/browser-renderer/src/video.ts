import type { FixedStepCaptureFrame } from '@uniscenarios/playback';
import type { BrowserRenderPass, ResolvedFrameSchedule } from '@uniscenarios/scenario-model';
import { throwIfAborted, type HashedArtifactSink } from './artifacts.js';
import type { RadarDetection } from './sensors/csv.js';
import type { LidarPoint } from './sensors/ply.js';

export type ActiveSensorPass = Extract<BrowserRenderPass, { modality: 'lidar' | 'radar' }>;
export type BrowserVideoConfig = Readonly<{ width: number; height: number; fps: number; quality: 'draft' | 'standard' | 'high' }>;
const BITRATE = { draft: 3_000_000, standard: 7_000_000, high: 14_000_000 } as const;

/** Streams VP9 clusters as WebCodecs emits them; clip payloads never accumulate in memory. */
export class StreamingSensorVideoEncoder {
  private writes = Promise.resolve();
  private failure: Error | null = null;
  private frames = 0;
  private closed = false;

  private constructor(
    readonly pass: ActiveSensorPass,
    readonly schedule: Readonly<ResolvedFrameSchedule>,
    readonly config: BrowserVideoConfig,
    private readonly sink: HashedArtifactSink,
    private readonly canvas: OffscreenCanvas | HTMLCanvasElement,
    private readonly context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
    private readonly encoder: VideoEncoder,
  ) {}

  static async create(input: { pass: ActiveSensorPass; schedule: Readonly<ResolvedFrameSchedule>; config: BrowserVideoConfig; sink: HashedArtifactSink; signal?: AbortSignal }): Promise<StreamingSensorVideoEncoder> {
    throwIfAborted(input.signal);
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') throw new Error('Headless Chromium does not provide WebCodecs VP9 encoding.');
    const pixels = Math.max(1, input.config.width * input.config.height);
    const encoderConfig: VideoEncoderConfig = {
      codec: 'vp09.00.10.08', width: input.config.width, height: input.config.height, framerate: input.config.fps,
      bitrate: Math.round(BITRATE[input.config.quality] * Math.max(0.45, Math.min(2.4, pixels / (1280 * 720)))), latencyMode: 'quality',
    };
    if (!(await VideoEncoder.isConfigSupported(encoderConfig)).supported) throw new Error('Headless Chromium cannot encode the required VP9 WebM profile.');
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(input.config.width, input.config.height)
      : Object.assign(document.createElement('canvas'), { width: input.config.width, height: input.config.height });
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('A 2D canvas is required for active-sensor video.');
    let instance: StreamingSensorVideoEncoder;
    const encoder = new VideoEncoder({
      error: (reason) => { instance.failure = reason instanceof Error ? reason : new Error(String(reason)); },
      output: (chunk) => instance.enqueue(chunk),
    });
    instance = new StreamingSensorVideoEncoder(input.pass, input.schedule, input.config, input.sink, canvas, context, encoder);
    await input.sink.write(webmHeader(input.config, input.schedule), input.signal);
    encoder.configure(encoderConfig);
    return instance;
  }

  async encode(timing: FixedStepCaptureFrame, structured: readonly LidarPoint[] | readonly RadarDetection[], signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.closed || timing.index !== this.frames) throw new Error(`Sensor video expected frame ${this.frames}, received ${timing.index}.`);
    if (this.pass.modality === 'lidar') drawLidar(this.context, this.pass, structured as readonly LidarPoint[], timing);
    else drawRadar(this.context, this.pass, structured as readonly RadarDetection[], timing);
    const frame = new VideoFrame(this.canvas, { timestamp: timing.timestampUs, duration: timing.durationUs });
    try { this.encoder.encode(frame, { keyFrame: timing.index % Math.max(1, this.config.fps * 2) === 0 }); } finally { frame.close(); }
    this.frames += 1;
    if (this.encoder.encodeQueueSize > 3) {
      await this.encoder.flush(); await this.writes;
      if (this.failure) throw this.failure;
    }
  }

  async close(signal?: AbortSignal) {
    throwIfAborted(signal);
    if (this.closed) throw new Error('Sensor video was closed more than once.');
    this.closed = true;
    try {
      await this.encoder.flush(); await this.writes;
      if (this.failure) throw this.failure;
      if (this.frames !== this.schedule.frameCount) throw new Error(`Sensor video encoded ${this.frames} of ${this.schedule.frameCount} frames.`);
      return await this.sink.close(signal);
    } finally { if (this.encoder.state !== 'closed') this.encoder.close(); }
  }

  async abort(reason: unknown): Promise<void> {
    this.closed = true;
    if (this.encoder.state !== 'closed') this.encoder.close();
    await this.sink.abort(reason);
  }

  private enqueue(chunk: EncodedVideoChunk): void {
    const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
    const bytes = element(0x1f43b675, concat(element(0xe7, uint(chunk.timestamp)), element(0xa3, concat(new Uint8Array([0x81, 0, 0, chunk.type === 'key' ? 0x80 : 0]), data))));
    this.writes = this.writes.then(() => this.sink.write(bytes)).catch((reason) => { this.failure = reason instanceof Error ? reason : new Error(String(reason)); });
  }
}

/** Encodes renderer-owned RGBA frames as the primary presentation video. */
export class StreamingRgbaVideoEncoder {
  private writes = Promise.resolve();
  private failure: Error | null = null;
  private frames = 0;
  private closed = false;

  private constructor(
    readonly schedule: Readonly<ResolvedFrameSchedule>,
    readonly config: BrowserVideoConfig,
    private readonly sink: HashedArtifactSink,
    private readonly context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
    private readonly encoder: VideoEncoder,
  ) {}

  static async create(input: { schedule: Readonly<ResolvedFrameSchedule>; config: BrowserVideoConfig; sink: HashedArtifactSink; signal?: AbortSignal }): Promise<StreamingRgbaVideoEncoder> {
    throwIfAborted(input.signal);
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') throw new Error('Headless Chromium does not provide WebCodecs VP9 encoding.');
    const pixels = Math.max(1, input.config.width * input.config.height);
    const encoderConfig: VideoEncoderConfig = {
      codec: 'vp09.00.10.08', width: input.config.width, height: input.config.height, framerate: input.config.fps,
      bitrate: Math.round(BITRATE[input.config.quality] * Math.max(0.45, Math.min(2.4, pixels / (1280 * 720)))), latencyMode: 'quality',
    };
    if (!(await VideoEncoder.isConfigSupported(encoderConfig)).supported) throw new Error('Headless Chromium cannot encode the required VP9 WebM profile.');
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(input.config.width, input.config.height)
      : Object.assign(document.createElement('canvas'), { width: input.config.width, height: input.config.height });
    const context = canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) throw new Error('A 2D canvas is required for presentation video.');
    let instance: StreamingRgbaVideoEncoder;
    const encoder = new VideoEncoder({
      error: (reason) => { instance.failure = reason instanceof Error ? reason : new Error(String(reason)); },
      output: (chunk) => instance.enqueue(chunk),
    });
    instance = new StreamingRgbaVideoEncoder(input.schedule, input.config, input.sink, context, encoder);
    await input.sink.write(webmHeader(input.config, input.schedule), input.signal);
    encoder.configure(encoderConfig);
    return instance;
  }

  async encode(timing: FixedStepCaptureFrame, pixels: Uint8Array, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.closed || timing.index !== this.frames) throw new Error(`Presentation video expected frame ${this.frames}, received ${timing.index}.`);
    if (pixels.byteLength !== this.config.width * this.config.height * 4) throw new Error(`Presentation video received ${pixels.byteLength} RGBA bytes.`);
    const rgba = new Uint8ClampedArray(pixels.byteLength);
    rgba.set(pixels);
    this.context.putImageData(new ImageData(rgba, this.config.width, this.config.height), 0, 0);
    const frame = new VideoFrame(this.context.canvas, { timestamp: timing.timestampUs, duration: timing.durationUs });
    try { this.encoder.encode(frame, { keyFrame: timing.index % Math.max(1, this.config.fps * 2) === 0 }); } finally { frame.close(); }
    this.frames += 1;
    if (this.encoder.encodeQueueSize > 3) {
      await this.encoder.flush(); await this.writes;
      if (this.failure) throw this.failure;
    }
  }

  async close(signal?: AbortSignal) {
    throwIfAborted(signal);
    if (this.closed) throw new Error('Presentation video was closed more than once.');
    this.closed = true;
    try {
      await this.encoder.flush(); await this.writes;
      if (this.failure) throw this.failure;
      if (this.frames !== this.schedule.frameCount) throw new Error(`Presentation video encoded ${this.frames} of ${this.schedule.frameCount} frames.`);
      return await this.sink.close(signal);
    } finally { if (this.encoder.state !== 'closed') this.encoder.close(); }
  }

  async abort(reason: unknown): Promise<void> {
    this.closed = true;
    if (this.encoder.state !== 'closed') this.encoder.close();
    await this.sink.abort(reason);
  }

  private enqueue(chunk: EncodedVideoChunk): void {
    const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
    const bytes = element(0x1f43b675, concat(element(0xe7, uint(chunk.timestamp)), element(0xa3, concat(new Uint8Array([0x81, 0, 0, chunk.type === 'key' ? 0x80 : 0]), data))));
    this.writes = this.writes.then(() => this.sink.write(bytes)).catch((reason) => { this.failure = reason instanceof Error ? reason : new Error(String(reason)); });
  }
}

function drawLidar(context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, pass: Extract<ActiveSensorPass, { modality: 'lidar' }>, points: readonly LidarPoint[], timing: FixedStepCaptureFrame): void {
  const width = context.canvas.width; const height = context.canvas.height; const range = Math.min(pass.rangeM, 80);
  background(context, width, height); const scale = Math.min(width / (range * 2.35), height / (range * 0.82));
  for (const point of points) {
    const distance = Math.hypot(point.x, point.y, point.z); if (point.x < 0 || distance > range) continue;
    const perspective = 1 / (1 + point.x / Math.max(1, range * 1.4)); const x = width / 2 - point.z * scale * perspective; const y = height * 0.82 - point.x * scale * 0.58 - point.y * scale;
    context.fillStyle = `hsla(${190 - 145 * Math.min(1, distance / range)},92%,62%,${0.45 + point.intensity * 0.5})`; context.fillRect(x - 1, y - 1, 2, 2);
  }
  header(context, 'LiDAR · 3D POINT CLOUD', pass.sensorId, timing, `${points.length} points · ${range.toFixed(0)} m view`);
}

function drawRadar(context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, pass: Extract<ActiveSensorPass, { modality: 'radar' }>, detections: readonly RadarDetection[], timing: FixedStepCaptureFrame): void {
  const width = context.canvas.width; const height = context.canvas.height; const scale = Math.min(width * 0.43, height * 0.78) / pass.rangeM; background(context, width, height);
  for (const detection of detections) {
    const x = width / 2 + Math.sin(detection.azimuth) * detection.depth * scale; const y = height * 0.9 - Math.cos(detection.azimuth) * detection.depth * scale; const speed = Math.min(1, Math.abs(detection.velocity) / 20);
    context.fillStyle = detection.velocity < 0 ? `rgba(63,196,255,${0.55 + speed * 0.4})` : `rgba(255,101,72,${0.55 + speed * 0.4})`; context.beginPath(); context.arc(x, y, 3 + speed * 3, 0, Math.PI * 2); context.fill();
  }
  header(context, 'RADAR · RANGE / AZIMUTH', pass.sensorId, timing, `${detections.length} detections · ${pass.rangeM.toFixed(0)} m range`);
}

function background(context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, width: number, height: number): void {
  context.fillStyle = '#03070b'; context.fillRect(0, 0, width, height); const gradient = context.createLinearGradient(0, 0, 0, height); gradient.addColorStop(0, 'rgba(9,34,43,0.42)'); gradient.addColorStop(1, 'rgba(2,5,8,0)'); context.fillStyle = gradient; context.fillRect(0, 0, width, height);
}

function header(context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, title: string, sensorId: string, timing: FixedStepCaptureFrame, metrics: string): void {
  const width = context.canvas.width; const margin = Math.max(20, width * 0.025); context.fillStyle = 'rgba(226,246,248,0.92)'; context.font = `700 ${Math.max(16, width * 0.018)}px monospace`; context.fillText(title, margin, margin + 20); context.fillStyle = 'rgba(187,218,222,0.64)'; context.font = `500 ${Math.max(11, width * 0.011)}px monospace`; context.fillText(sensorId, margin, margin + 44); context.textAlign = 'right'; context.fillText(`t=${timing.sourceTimeSeconds.toFixed(3)}s · frame ${timing.index.toString().padStart(5, '0')}`, width - margin, margin + 20); context.fillText(metrics, width - margin, margin + 44); context.textAlign = 'left';
}

function webmHeader(config: BrowserVideoConfig, schedule: Readonly<ResolvedFrameSchedule>): Uint8Array {
  const ebml = element(0x1a45dfa3, concat(element(0x4286, uint(1)), element(0x42f7, uint(1)), element(0x42f2, uint(4)), element(0x42f3, uint(8)), element(0x4282, text('webm')), element(0x4287, uint(4)), element(0x4285, uint(2))));
  const info = element(0x1549a966, concat(element(0x2ad7b1, uint(1_000)), element(0x4489, float64(schedule.endTimestampUs)), element(0x4d80, text('UniScenarios browser renderer')), element(0x5741, text('UniScenarios browser renderer'))));
  const video = element(0xe0, concat(element(0xb0, uint(config.width)), element(0xba, uint(config.height))));
  const track = element(0xae, concat(element(0xd7, uint(1)), element(0x73c5, uint(1)), element(0x83, uint(1)), element(0x86, text('V_VP9')), element(0x23e383, uint(Math.round(1_000_000_000 / config.fps))), video));
  return concat(ebml, idBytes(0x18538067), new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), info, element(0x1654ae6b, track));
}
function element(id: number, payload: Uint8Array): Uint8Array { return concat(idBytes(id), vint(payload.byteLength), payload); }
function idBytes(value: number): Uint8Array { const bytes: number[] = []; for (let remaining = value; remaining > 0; remaining = Math.floor(remaining / 256)) bytes.unshift(remaining & 0xff); return new Uint8Array(bytes); }
function vint(value: number): Uint8Array { for (let length = 1; length <= 8; length += 1) { if (value > 2 ** (7 * length) - 2) continue; const bytes = new Uint8Array(length); let remaining = value; for (let index = length - 1; index >= 0; index -= 1) { bytes[index] = remaining & 0xff; remaining = Math.floor(remaining / 256); } bytes[0] = bytes[0]! | (1 << (8 - length)); return bytes; } throw new Error('WebM element is too large.'); }
function uint(value: number): Uint8Array { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid EBML integer.'); const bytes: number[] = []; for (let remaining = value; remaining > 0; remaining = Math.floor(remaining / 256)) bytes.unshift(remaining & 0xff); return new Uint8Array(bytes.length ? bytes : [0]); }
function float64(value: number): Uint8Array { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, value); return bytes; }
function text(value: string): Uint8Array { return new TextEncoder().encode(value); }
function concat(...parts: readonly Uint8Array[]): Uint8Array { const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0)); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; } return bytes; }
