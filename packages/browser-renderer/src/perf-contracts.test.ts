import { afterEach, describe, expect, it } from 'vitest';

import { resolveRgbFrameFormat } from './capture.js';
import { sensorFramePath } from './artifacts.js';
import { BridgeArtifactSink, type HeadlessArtifactBridge } from './headless.js';
import type { RenderSpecV3 } from '@uniscenarios/scenario-model';

function renderSpecOf(input: { fidelity: 'review' | 'dataset'; videoQuality?: 'draft' | 'standard' | 'high' | 'lossless' }): RenderSpecV3 {
  return {
    schema: 'uniscenario.render-spec/v3',
    sources: [],
    clip: { startSeconds: 0, endSeconds: 1 },
    video: input.videoQuality
      ? { width: 320, height: 180, fps: 24, container: 'mp4', codec: 'h264', quality: input.videoQuality }
      : null,
    artifacts: ['manifest', 'video'],
    capabilityIntent: { required: [], preferred: [], fidelity: input.fidelity },
    authoredEnvironment: {
      weather: 'clear',
      timeOfDay: 'noon',
      sunAzimuthDeg: 180,
      sunElevationDeg: 60,
      surfacePatches: [],
    },
  } as unknown as RenderSpecV3;
}

describe('rgb frame format policy', () => {
  const originalOffscreenCanvas = (globalThis as Record<string, unknown>)['OffscreenCanvas'];
  afterEach(() => {
    if (originalOffscreenCanvas === undefined) delete (globalThis as Record<string, unknown>)['OffscreenCanvas'];
    else (globalThis as Record<string, unknown>)['OffscreenCanvas'] = originalOffscreenCanvas;
  });

  it('uses JPEG for review fidelity when OffscreenCanvas exists', () => {
    (globalThis as Record<string, unknown>)['OffscreenCanvas'] = class {};
    expect(resolveRgbFrameFormat(renderSpecOf({ fidelity: 'review', videoQuality: 'draft' }))).toBe('jpg');
    expect(resolveRgbFrameFormat(renderSpecOf({ fidelity: 'review' }))).toBe('jpg');
  });

  it('keeps lossless PNG for dataset fidelity and lossless video', () => {
    (globalThis as Record<string, unknown>)['OffscreenCanvas'] = class {};
    expect(resolveRgbFrameFormat(renderSpecOf({ fidelity: 'dataset', videoQuality: 'draft' }))).toBe('png');
    expect(resolveRgbFrameFormat(renderSpecOf({ fidelity: 'review', videoQuality: 'lossless' }))).toBe('png');
  });

  it('falls back to PNG when OffscreenCanvas is unavailable', () => {
    delete (globalThis as Record<string, unknown>)['OffscreenCanvas'];
    expect(resolveRgbFrameFormat(renderSpecOf({ fidelity: 'review', videoQuality: 'draft' }))).toBe('png');
  });
});

describe('sensor frame paths', () => {
  it('lays out png, jpg, ply, and csv frames identically', () => {
    expect(sensorFramePath('cam-0', 7, 'jpg')).toBe('cam-0/00000007.jpg');
    expect(sensorFramePath('cam-0', 7, 'png')).toBe('cam-0/00000007.png');
    expect(sensorFramePath('lidar-0', 7, 'ply')).toBe('lidar-0/00000007.ply');
  });
});

type BridgeEvent =
  | { kind: 'write'; bytes: Uint8Array }
  | { kind: 'close' }
  | { kind: 'abort'; message: string };

function recordingBridge(events: BridgeEvent[]): HeadlessArtifactBridge {
  return {
    open: async () => 'handle-0',
    write: async (_handle, base64) => {
      events.push({ kind: 'write', bytes: Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)) });
    },
    close: async () => { events.push({ kind: 'close' }); },
    abort: async (_handle, message) => { events.push({ kind: 'abort', message }); },
    progress: () => undefined,
  };
}

describe('bridge artifact sink batching', () => {
  it('coalesces small writes into one message flushed on close', async () => {
    const events: BridgeEvent[] = [];
    const sink = new BridgeArtifactSink(recordingBridge(events), 'handle-0');
    const chunks = [Uint8Array.of(1, 2, 3), Uint8Array.of(4), Uint8Array.of(5, 6)];
    for (const chunk of chunks) await sink.write(chunk);
    expect(events).toEqual([]);
    await sink.close();
    expect(events).toEqual([
      { kind: 'write', bytes: Uint8Array.of(1, 2, 3, 4, 5, 6) },
      { kind: 'close' },
    ]);
  });

  it('reassembles multi-megabyte writes byte-for-byte in order', async () => {
    const events: BridgeEvent[] = [];
    const sink = new BridgeArtifactSink(recordingBridge(events), 'handle-0');
    const payload = new Uint8Array(2_500_000);
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 31 + 7) & 0xff;
    await sink.write(payload.subarray(0, 1_700_000));
    await sink.write(payload.subarray(1_700_000));
    await sink.close();
    const writes = events.filter((event) => event.kind === 'write');
    expect(events.at(-1)).toEqual({ kind: 'close' });
    expect(writes.length).toBe(3);
    const reassembled = new Uint8Array(payload.length);
    let offset = 0;
    for (const write of writes) {
      if (write.kind !== 'write') continue;
      reassembled.set(write.bytes, offset);
      offset += write.bytes.byteLength;
    }
    expect(offset).toBe(payload.length);
    expect(Buffer.from(reassembled).equals(Buffer.from(payload))).toBe(true);
  });

  it('drops buffered bytes on abort and refuses further writes', async () => {
    const events: BridgeEvent[] = [];
    const sink = new BridgeArtifactSink(recordingBridge(events), 'handle-0');
    await sink.write(Uint8Array.of(9, 9, 9));
    await sink.abort(new Error('cancelled'));
    expect(events).toEqual([{ kind: 'abort', message: 'cancelled' }]);
    await expect(sink.write(Uint8Array.of(1))).rejects.toThrow('closed');
  });
});
