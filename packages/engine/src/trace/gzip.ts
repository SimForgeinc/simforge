/**
 * Trace serialisation.
 *
 * `serializeTrace` produces the **canonical bytes** a determinism test compares:
 * sorted keys, no whitespace, quantised channels. Gzip is applied on top with
 * `CompressionStream` in the browser and `node:zlib` under Node — note that the
 * *compressed* bytes are not guaranteed identical across those two backends, so
 * byte-comparison happens on the uncompressed canonical JSON.
 */

import { canonicalJson, sha256 } from '../core/hash.js';
import { quantizeTrace, type SimTrace } from './trace.js';

/** Canonical, quantised JSON bytes for a trace. */
export function serializeTrace(trace: SimTrace): Uint8Array {
  return new TextEncoder().encode(canonicalJson(quantizeTrace(trace)));
}

/** Content digest of the canonical trace bytes. */
export function traceDigest(trace: SimTrace): string {
  return sha256(canonicalJson(quantizeTrace(trace)));
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (CS) {
    const stream = new Blob([bytes.slice() as unknown as BlobPart]).stream().pipeThrough(new CS('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { gzipSync } = await import('node:zlib');
  return new Uint8Array(gzipSync(bytes));
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (DS) {
    const stream = new Blob([bytes.slice() as unknown as BlobPart]).stream().pipeThrough(new DS('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { gunzipSync } = await import('node:zlib');
  return new Uint8Array(gunzipSync(bytes));
}

/** Gzipped canonical JSON — the `.trace.json.gz` payload. */
export async function encodeTraceGz(trace: SimTrace): Promise<Uint8Array> {
  return gzip(serializeTrace(trace));
}

/** Inverse of `encodeTraceGz`; also accepts uncompressed JSON bytes. */
export async function decodeTraceGz(bytes: Uint8Array): Promise<SimTrace> {
  const gzipped = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const plain = gzipped ? await gunzip(bytes) : bytes;
  return JSON.parse(new TextDecoder().decode(plain)) as SimTrace;
}
