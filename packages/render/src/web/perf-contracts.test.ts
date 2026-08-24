import { describe, expect, it } from 'vitest';

import { sensorFramePath } from './artifacts.js';
import { BridgeArtifactSink, type HeadlessArtifactBridge } from './headless.js';
import { depthMetersToRgba } from './video.js';


describe('sensor frame paths', () => {
  it('lays out only lidar/radar measurement frames', () => {
    expect(sensorFramePath('lidar-0', 7, 'ply')).toBe('lidar-0/00000007.ply');
    expect(sensorFramePath('radar-0', 12, 'csv')).toBe('radar-0/00000012.csv');
  });
});

describe('depth video visualization', () => {
  it('maps near depth bright and clamps beyond the far plane', () => {
    const depth = new Float32Array([0, 10, 100, Number.POSITIVE_INFINITY]);
    const rgba = new Uint8Array(depth.length * 4);
    depthMetersToRgba(depth, 100, rgba);
    expect(rgba[3]).toBe(255);
    expect(rgba[0]).toBe(255);
    expect(rgba[4]).toBeLessThan(255);
    expect(rgba[4]).toBeGreaterThan(rgba[8]!);
    expect(rgba[12]).toBe(0);
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
