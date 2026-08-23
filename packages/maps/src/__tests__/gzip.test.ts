import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { decodeMaybeGzippedJson, isGzipped, loadGzipJson } from '../gzip.js';
import { readFixtureBytes } from './fixtures.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gzip json loading', () => {
  it('detects the gzip magic number', () => {
    expect(isGzipped(readFixtureBytes('yale-signals.geojson.gz'))).toBe(true);
    expect(isGzipped(new TextEncoder().encode('{"a":1}'))).toBe(false);
    expect(isGzipped(new Uint8Array([0x1f]))).toBe(false);
  });

  it('inflates raw gzip bytes (server sends application/gzip)', async () => {
    const json = await decodeMaybeGzippedJson<{ features: unknown[] }>(
      readFixtureBytes('yale-signals.geojson.gz'),
    );
    expect(json.features).toHaveLength(164);
  });

  it('passes through already-decompressed JSON (server sent Content-Encoding: gzip)', async () => {
    const plain = new TextEncoder().encode(JSON.stringify({ hello: 'world' }));
    expect(await decodeMaybeGzippedJson(plain)).toEqual({ hello: 'world' });
  });

  it('accepts an ArrayBuffer as well as a Uint8Array', async () => {
    const bytes = gzipSync(Buffer.from('[1,2,3]'));
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(await decodeMaybeGzippedJson(ab as ArrayBuffer)).toEqual([1, 2, 3]);
  });

  it('fetches and inflates over the network path', async () => {
    const body = readFixtureBytes('yale-signals.geojson.gz');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      })),
    );
    const json = await loadGzipJson<{ features: unknown[] }>('https://example.test/signals.geojson.gz');
    expect(json.features).toHaveLength(164);
  });

  it('throws a useful error on a failed fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' })),
    );
    await expect(loadGzipJson('https://example.test/missing.gz')).rejects.toThrow(/404/);
  });
});
