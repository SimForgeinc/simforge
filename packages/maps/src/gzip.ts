/**
 * Gzipped-JSON loading that works in the browser and in Node tests.
 *
 * Map sidecars ship as `*.json.gz`. Servers are inconsistent about them:
 *
 * - Static hosts usually serve `.gz` as **raw bytes** with
 *   `Content-Type: application/gzip` and no `Content-Encoding`, so the fetch
 *   layer hands us a still-compressed body that we must inflate ourselves.
 * - Some servers (or dev proxies) set `Content-Encoding: gzip`, in which case
 *   the browser has *already* inflated it and we receive plain JSON.
 *
 * Both are handled by sniffing the gzip magic number rather than trusting
 * headers.
 */

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
// Node-only fallback: a static import would make this browser module unbundleable.
async function loadNodeZlib() {
  const specifier = ['node', 'zlib'].join(':');
  return import(/* webpackIgnore: true */ specifier);
}

/** True when the buffer starts with the gzip magic number. */
export function isGzipped(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (DS) {
    // Copy into a fresh ArrayBuffer so a view over a larger buffer is handled.
    const blobLike = new Blob([bytes.slice() as unknown as BlobPart]);
    const stream = blobLike.stream().pipeThrough(new DS('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  const { gunzipSync } = await loadNodeZlib();
  return new Uint8Array(gunzipSync(bytes));
}

/**
 * Decode a buffer that is either gzipped JSON or plain JSON.
 *
 * @param input Raw bytes as received from `fetch`/`readFile`.
 */
export async function decodeMaybeGzippedJson<T = unknown>(
  input: ArrayBuffer | Uint8Array,
): Promise<T> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const plain = isGzipped(bytes) ? await gunzip(bytes) : bytes;
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/**
 * Fetch a `*.json.gz` (or plain `*.json`) and parse it.
 *
 * Works unchanged in the browser and under Node/vitest, and tolerates servers
 * that transparently decompress the response.
 *
 * @param url Location of the resource.
 * @param init Passed through to `fetch`.
 */
export async function loadGzipJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`loadGzipJson: ${url} failed (${res.status} ${res.statusText})`);
  return decodeMaybeGzippedJson<T>(await res.arrayBuffer());
}
