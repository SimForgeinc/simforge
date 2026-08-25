/**
 * F4 TS bundle-reader test against a ring recorded by the REAL Rust render
 * service (renderer/service/testdata/bundle-ring.shm.gz: yale fixture tile,
 * 2 cams 64x48 rgb, sim ticks 1..3, recorded via render_bundle RPC).
 */
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { crc32, ShmBundleReader, TornBundleError } from './shm-bundles.js';

const TESTDATA = fileURLToPath(new URL('../../../../renderer/service/testdata/', import.meta.url));

interface ManifestFrame {
  sensorId: string;
  pass: string;
  offset: number;
  len: number;
  width: number;
  height: number;
  format: string;
  digest: string;
}
interface Manifest {
  ticks: Array<{ simTick: number; bundleOffset: number; bundleLen: number; frames: ManifestFrame[] }>;
}

const manifest: Manifest = JSON.parse(readFileSync(path.join(TESTDATA, 'bundle-ring.manifest.json'), 'utf8'));

describe('ShmBundleReader', () => {
  let ringPath: string;
  let reader: ShmBundleReader | null = null;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sf-bundle-'));
    ringPath = path.join(dir, 'bundle-ring.shm');
    writeFileSync(ringPath, gunzipSync(readFileSync(path.join(TESTDATA, 'bundle-ring.shm.gz'))));
  });

  afterEach(() => {
    reader?.close();
    reader = null;
  });

  it('reads the latest recorded bundle and matches the manifest', () => {
    reader = new ShmBundleReader(ringPath);
    const bundle = reader.latest();
    const last = manifest.ticks.at(-1)!;
    expect(bundle).not.toBeNull();
    expect(bundle!.simTick).toBe(last.simTick);
    expect(bundle!.entries).toEqual(
      last.frames.map((frame) => ({
        cameraId: frame.sensorId,
        pass: frame.pass,
        byteOffset: frame.offset + 128,
        byteLength: frame.len,
        width: frame.width,
        height: frame.height,
        format: frame.format,
        digest: frame.digest,
      })),
    );
    // Copied payloads digest-match the table (crc32 mirrors zlib/crc32fast).
    for (const [k, entry] of bundle!.entries.entries()) {
      const payload = bundle!.payloads[k]!;
      expect(crc32(payload).toString(16).padStart(8, '0')).toBe(entry.digest);
      expect(payload.length).toBe(entry.byteLength);
      expect(bundle!.rowStride(entry)).toBe(256); // 64 px * 4 B -> 256-aligned
    }
  });

  it('decodes earlier ticks via explicit bundleAt refs', () => {
    reader = new ShmBundleReader(ringPath);
    for (const tick of manifest.ticks) {
      const bundle = reader.bundleAt(tick.bundleOffset, tick.bundleLen);
      expect(bundle.simTick).toBe(tick.simTick);
      expect(bundle.entries.map((entry) => entry.digest)).toEqual(tick.frames.map((frame) => frame.digest));
    }
  });

  it('latestNew() yields a bundle once per sim tick', () => {
    reader = new ShmBundleReader(ringPath);
    expect(reader.latestNew()?.simTick).toBe(3);
    expect(reader.latestNew()).toBeNull();
  });

  it('throws TornBundleError on corrupted payload bytes', () => {
    const bytes = readFileSync(ringPath);
    const frame = manifest.ticks.at(-1)!.frames[0]!;
    bytes[frame.offset + 128 + 100]! ^= 0xff;
    writeFileSync(ringPath, bytes);
    reader = new ShmBundleReader(ringPath);
    expect(() => reader!.latest()).toThrow(TornBundleError);
  });

  it('throws TornBundleError on a torn bundle table', () => {
    const bytes = readFileSync(ringPath);
    const last = manifest.ticks.at(-1)!;
    bytes[last.bundleOffset + 128 + 32 + 70]! ^= 0xff;
    writeFileSync(ringPath, bytes);
    reader = new ShmBundleReader(ringPath);
    expect(() => reader!.latest()).toThrow(/CRC mismatch/);
  });
});
