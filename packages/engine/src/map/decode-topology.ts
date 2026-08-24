import type { TopologyIndex } from './topology.js';

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** The topology sidecar format consumed by the Scenario editor and engine. */
export type TopologyIndexFile = TopologyIndex;

function isGzipped(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const Decompressor = globalThis.DecompressionStream;
  if (Decompressor) {
    const blob = new Blob([bytes.slice() as unknown as BlobPart]);
    const stream = blob.stream().pipeThrough(new Decompressor('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { gunzipSync } = await import('node:zlib');
  return new Uint8Array(gunzipSync(bytes));
}

function assertTopologyIndex(value: unknown): asserts value is TopologyIndexFile {
  if (!value || typeof value !== 'object') throw new Error('Topology index must be a JSON object');
  const candidate = value as Partial<TopologyIndexFile>;
  if (!candidate.lanes || typeof candidate.lanes !== 'object' || Array.isArray(candidate.lanes)) {
    throw new Error('Topology index is missing its lanes object');
  }
  if (!Array.isArray(candidate.gates)) throw new Error('Topology index is missing its gates array');
  if (!candidate.junctions || typeof candidate.junctions !== 'object' || Array.isArray(candidate.junctions)) {
    throw new Error('Topology index is missing its junctions object');
  }
}

/** Decode a plain or gzip-compressed topology JSON sidecar. */
export async function decodeTopologyIndex(
  input: ArrayBuffer | Uint8Array,
): Promise<TopologyIndexFile> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const plain = isGzipped(bytes) ? await gunzip(bytes) : bytes;
  const value: unknown = JSON.parse(new TextDecoder().decode(plain));
  assertTopologyIndex(value);
  return value;
}
