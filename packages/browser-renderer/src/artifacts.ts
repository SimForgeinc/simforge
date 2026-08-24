import { Sha256 } from '@uniscenarios/scenario-model';

import { crc32 } from './sensors/png.js';

export type ArtifactModality = 'rgb' | 'depth' | 'semantic' | 'instance' | 'lidar' | 'radar' | 'manifest' | 'frames' | 'sensor-video';
export type ArtifactIdentity = Readonly<{
  role: string;
  actorId: string | null;
  sensorId: string | null;
  modality: ArtifactModality;
}>;
export type ArtifactReceipt = ArtifactIdentity & Readonly<{
  mediaType: string;
  byteLength: number;
  sha256: string;
}>;

/** A sequential destination supplied by the host (filesystem, upload, or IPC). */
export interface ArtifactByteSink {
  write(chunk: Uint8Array, signal?: AbortSignal): Promise<void>;
  close(signal?: AbortSignal): Promise<void>;
  abort(reason: unknown): Promise<void>;
}

export type ArtifactSinkFactory = (identity: ArtifactIdentity, mediaType: string) => Promise<ArtifactByteSink>;

export class HashedArtifactSink {
  private readonly hash = new Sha256();
  private byteLength = 0;
  private closed = false;

  constructor(
    readonly identity: ArtifactIdentity,
    readonly mediaType: string,
    private readonly destination: ArtifactByteSink,
  ) {}

  async write(chunk: Uint8Array, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.closed) throw new Error('Cannot write a closed artifact sink.');
    this.hash.update(chunk);
    this.byteLength += chunk.byteLength;
    await this.destination.write(chunk, signal);
    throwIfAborted(signal);
  }

  async close(signal?: AbortSignal): Promise<ArtifactReceipt> {
    throwIfAborted(signal);
    if (this.closed) throw new Error('Artifact sink was closed more than once.');
    this.closed = true;
    await this.destination.close(signal);
    return { ...this.identity, mediaType: this.mediaType, byteLength: this.byteLength, sha256: this.hash.digestHex() };
  }

  async abort(reason: unknown): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.destination.abort(reason);
  }
}

export class StreamingZipWriter {
  private readonly entries: Uint8Array[] = [];
  private offset = 0;
  private count = 0;
  private previousName: Uint8Array | null = null;
  private closed = false;

  constructor(private readonly sink: HashedArtifactSink) {}

  /** Writes frame payload immediately; only small central-directory records remain resident. */
  async add(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('Cannot add to a closed ZIP archive.');
    const name = validatedZipName(path);
    if (this.previousName && compareBytes(this.previousName, name) >= 0) throw new Error(`ZIP paths must be unique and lexical: ${path}`);
    this.previousName = name;
    if (this.count >= 0xffff || this.offset > 0xffffffff) throw new Error('ZIP64 is not supported by sensor archives.');
    const checksum = crc32(bytes);
    const local = zipLocalHeader(name, checksum, bytes.byteLength);
    await this.sink.write(local, signal);
    await this.sink.write(bytes, signal);
    this.entries.push(zipCentralHeader(name, checksum, bytes.byteLength, this.offset));
    this.offset += local.byteLength + bytes.byteLength;
    this.count += 1;
  }

  async close(signal?: AbortSignal): Promise<ArtifactReceipt> {
    if (this.closed) throw new Error('ZIP archive was closed more than once.');
    this.closed = true;
    const centralOffset = this.offset;
    let centralSize = 0;
    for (const entry of this.entries) {
      await this.sink.write(entry, signal);
      centralSize += entry.byteLength;
    }
    await this.sink.write(zipEnd(this.count, centralSize, centralOffset), signal);
    return this.sink.close(signal);
  }

  abort(reason: unknown): Promise<void> {
    this.closed = true;
    this.entries.length = 0;
    return this.sink.abort(reason);
  }
}

export function sensorFramePath(sensorId: string, outputFrameIndex: number, extension: 'ply' | 'csv'): string {
  if (!sensorId || sensorId.includes('/') || sensorId.includes('\\') || sensorId === '.' || sensorId === '..') throw new Error('Sensor id cannot contain a path separator.');
  if (!Number.isSafeInteger(outputFrameIndex) || outputFrameIndex < 0 || outputFrameIndex > 99_999_999) throw new Error('Output frame index must fit the eight-digit artifact layout.');
  return `${sensorId}/${outputFrameIndex.toString().padStart(8, '0')}.${extension}`;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Render cancelled', 'AbortError');
}

const UTF8_FLAG = 0x0800;
const DOS_DATE = 0x0021;
const textEncoder = new TextEncoder();

function validatedZipName(path: string): Uint8Array {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe ZIP entry path: ${path}`);
  const name = textEncoder.encode(path);
  if (name.byteLength > 0xffff) throw new Error('ZIP entry path is too long.');
  return name;
}

function zipLocalHeader(name: Uint8Array, checksum: number, size: number): Uint8Array {
  const bytes = new Uint8Array(30 + name.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(10, 0, true); view.setUint16(12, DOS_DATE, true); view.setUint32(14, checksum, true);
  view.setUint32(18, size, true); view.setUint32(22, size, true); view.setUint16(26, name.byteLength, true);
  bytes.set(name, 30);
  return bytes;
}

function zipCentralHeader(name: Uint8Array, checksum: number, size: number, offset: number): Uint8Array {
  const bytes = new Uint8Array(46 + name.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true); view.setUint16(4, 20, true); view.setUint16(6, 20, true); view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(12, 0, true); view.setUint16(14, DOS_DATE, true); view.setUint32(16, checksum, true);
  view.setUint32(20, size, true); view.setUint32(24, size, true); view.setUint16(28, name.byteLength, true); view.setUint32(42, offset, true);
  bytes.set(name, 46);
  return bytes;
}

function zipEnd(count: number, centralSize: number, centralOffset: number): Uint8Array {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, count, true); view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true); view.setUint32(16, centralOffset, true);
  return bytes;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}
