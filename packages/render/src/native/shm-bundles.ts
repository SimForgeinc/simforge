/**
 * F4 frame-bundle consumer for the native render service's shm ring.
 *
 * Studio-worker side: reads atomic multi-camera frame bundles published by
 * the renderer's `render_bundle` op for thumbnails/QA. Unlike the Python
 * consumer (zero-copy numpy views for the policy hot loop), this reader
 * COPIES payload bytes out of the ring — callers get stable Buffers that
 * survive writer wraparound.
 *
 * Binary layouts (little-endian) mirror renderer/service/src/shm.rs:
 * - meta page: [0..8) ring magic "UNISHRI1", [8..16) write_cursor_total,
 *   [16..24) bundle seq (seqlock; 0 = never published, odd = mid-flip),
 *   [24..32) bundle record offset, [32..40) bundle payload len,
 *   [40..48) bundle sim_tick.
 * - record header (128 B): magic u64, version u32, width u32, height u32,
 *   format u32, tick u64, payload_len u64, sensor_id[56] @40, pass[32] @96.
 * - bundle payload: 32-B header (magic "SFBNDL01", sim_tick u64,
 *   start_cursor u64, n_entries u32, entries_crc u32) + 96-B entries
 *   (id[48], pass[16], payload_offset u64, payload_len u64, width u32,
 *   height u32, format u32, digest u32). Digests are CRC32 (IEEE) of the
 *   payload bytes — the `digest` in PolicyStep frameBundle refs is the same
 *   value as 8-char lowercase hex.
 */
import { closeSync, openSync, readSync } from 'node:fs';

const META_BYTES = 4096;
const RECORD_HEADER_BYTES = 128;
const RING_MAGIC = 0x554e4953_48524931n; // "UNISHRI1"
const BUNDLE_MAGIC = 0x31304c44_4e424653n; // "SFBNDL01" LE
const BUNDLE_HEADER_BYTES = 32;
const BUNDLE_ENTRY_BYTES = 96;

const FORMAT_NAMES: Record<number, string> = { 1: 'rgba8', 2: 'depth32f', 3: 'jpeg', 4: 'bundle' };

/** One frame reference inside a bundle table. */
export interface ShmBundleEntry {
  cameraId: string;
  pass: string;
  /** Payload byte offset in the shm file (record header at byteOffset-128). */
  byteOffset: number;
  byteLength: number;
  width: number;
  height: number;
  /** rgba8 | depth32f | jpeg */
  format: string;
  /** CRC32 (IEEE) of payload bytes, 8-char lowercase hex. */
  digest: string;
}

/** One decoded atomic frame bundle (payloads already copied out). */
export interface ShmBundle {
  simTick: number;
  entries: ShmBundleEntry[];
  /** Copied payload bytes per entry, index-aligned with `entries`. */
  payloads: Buffer[];
  /** wgpu row-padded stride in bytes for 4-byte-per-pixel payloads. */
  rowStride(entry: ShmBundleEntry): number;
}

export class TornBundleError extends Error {}

/** CRC32 (IEEE 802.3), bitwise; matches zlib.crc32 / crc32fast. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function cstr(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? len : nul).toString('utf8');
}

/**
 * Poll-based bundle reader over the ring file. Snapshot semantics: `latest()`
 * copies every payload, digest-verifies against the bundle table, and throws
 * TornBundleError if the writer overwrote anything mid-read — retry on the
 * next poll in that case.
 */
export class ShmBundleReader {
  private readonly fd: number;
  private lastTick: number | null = null;

  constructor(readonly shmPath: string) {
    this.fd = openSync(shmPath, 'r');
    const meta = this.readBytes(0, 16);
    if (meta.readBigUInt64LE(0) !== RING_MAGIC) {
      throw new Error(`${shmPath}: not a simforge shm ring`);
    }
  }

  close(): void {
    closeSync(this.fd);
  }

  private readBytes(offset: number, length: number): Buffer {
    const out = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const n = readSync(this.fd, out, done, length - done, offset + done);
      if (n === 0) throw new Error(`short read at ${offset + done}`);
      done += n;
    }
    return out;
  }

  /** Seqlock read of the latest-bundle pointer; null while none published. */
  private pointer(): { recordOffset: number; payloadLen: number; simTick: number } | null {
    for (;;) {
      const a = this.readBytes(16, 32);
      const s1 = a.readBigUInt64LE(0);
      if (s1 === 0n) return null;
      if (s1 % 2n === 1n) continue;
      const b = this.readBytes(16, 8);
      if (b.readBigUInt64LE(0) !== s1) continue;
      return {
        recordOffset: Number(a.readBigUInt64LE(8)),
        payloadLen: Number(a.readBigUInt64LE(16)),
        simTick: Number(a.readBigUInt64LE(24)),
      };
    }
  }

  /** Latest bundle with copied, digest-verified payloads; null if none yet. */
  latest(): ShmBundle | null {
    const ptr = this.pointer();
    if (ptr === null) return null;
    return this.bundleAt(ptr.recordOffset, ptr.payloadLen);
  }

  /** Latest bundle only if newer than the previous `latestNew()` call. */
  latestNew(): ShmBundle | null {
    const ptr = this.pointer();
    if (ptr === null || ptr.simTick === this.lastTick) return null;
    const bundle = this.bundleAt(ptr.recordOffset, ptr.payloadLen);
    this.lastTick = bundle.simTick;
    return bundle;
  }

  /** Decode a bundle by explicit location (e.g. from a frameBundle ref). */
  bundleAt(recordOffset: number, payloadLen: number): ShmBundle {
    const payload = this.readBytes(recordOffset + RECORD_HEADER_BYTES, payloadLen);
    if (payload.readBigUInt64LE(0) !== BUNDLE_MAGIC) {
      throw new TornBundleError('bad bundle magic (torn or overwritten)');
    }
    const simTick = Number(payload.readBigUInt64LE(8));
    const n = payload.readUInt32LE(24);
    const entriesCrc = payload.readUInt32LE(28);
    const region = payload.subarray(BUNDLE_HEADER_BYTES, BUNDLE_HEADER_BYTES + n * BUNDLE_ENTRY_BYTES);
    if (region.length !== n * BUNDLE_ENTRY_BYTES) throw new TornBundleError('bundle table truncated');
    if (crc32(region) !== entriesCrc) throw new TornBundleError('bundle table CRC mismatch');

    const entries: ShmBundleEntry[] = [];
    const payloads: Buffer[] = [];
    for (let k = 0; k < n; k++) {
      const b = region.subarray(k * BUNDLE_ENTRY_BYTES, (k + 1) * BUNDLE_ENTRY_BYTES);
      const digest = b.readUInt32LE(92);
      const entry: ShmBundleEntry = {
        cameraId: cstr(b, 0, 48),
        pass: cstr(b, 48, 16),
        byteOffset: Number(b.readBigUInt64LE(64)),
        byteLength: Number(b.readBigUInt64LE(72)),
        width: b.readUInt32LE(80),
        height: b.readUInt32LE(84),
        format: FORMAT_NAMES[b.readUInt32LE(88)] ?? String(b.readUInt32LE(88)),
        digest: digest.toString(16).padStart(8, '0'),
      };
      const bytes = this.readBytes(entry.byteOffset, entry.byteLength);
      if (crc32(bytes) !== digest) {
        throw new TornBundleError(
          `frame digest mismatch for ${entry.cameraId}:${entry.pass} tick ${simTick} (writer lapped)`,
        );
      }
      entries.push(entry);
      payloads.push(bytes);
    }
    return {
      simTick,
      entries,
      payloads,
      rowStride: (entry) => Math.ceil((entry.width * 4) / 256) * 256,
    };
  }
}
