import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import net from 'node:net';

import { decode, encode } from '@msgpack/msgpack';

const HEADER_BYTES = 4;
const RECORD_HEADER_BYTES = 128;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface NativeFrameRecord {
  readonly sensorId: string;
  readonly pass: string;
  readonly offset: number;
  readonly len: number;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly tickId: number;
  readonly digest?: string;
}

interface NativeResponse {
  readonly i: number;
  readonly op: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly protocol?: number;
  readonly shm?: { readonly path: string; readonly size_bytes: number; readonly meta_bytes: number };
  readonly frames?: readonly NativeFrameRecord[];
  readonly server_ms?: number;
}

export class NativeServiceClient {
  readonly #socket: net.Socket;
  readonly #pending = new Map<number, { resolve: (value: NativeResponse) => void; reject: (reason?: unknown) => void }>();
  #buffer = Buffer.alloc(0);
  #sequence = 0;
  #shmPath = '';

  private constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => this.#consume(chunk));
    socket.on('error', (error) => this.#fail(error));
    socket.on('close', () => this.#fail(new Error('native render service socket closed')));
  }

  static async connect(socketPath: string): Promise<NativeServiceClient> {
    const socket = net.createConnection(socketPath);
    await once(socket, 'connect');
    const client = new NativeServiceClient(socket);
    const hello = await client.rpc({ op: 'hello' });
    if (hello.protocol !== 2 || !hello.shm?.path) {
      await client.close();
      throw new Error(`native render service protocol mismatch: ${String(hello.protocol)}`);
    }
    client.#shmPath = hello.shm.path;
    return client;
  }

  async rpc(body: Readonly<Record<string, unknown>>): Promise<NativeResponse> {
    const i = ++this.#sequence;
    const payload = Buffer.from(encode({ i, ...body }));
    if (payload.byteLength > MAX_FRAME_BYTES) throw new Error('native service request exceeds 64 MiB');
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header.writeUInt32LE(payload.byteLength);
    const promiseConstructor = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };
    };
    const { promise: response, resolve, reject } = promiseConstructor.withResolvers<NativeResponse>();
    this.#pending.set(i, { resolve, reject });
    this.#socket.write(Buffer.concat([header, payload]));
    const value = await response;
    if (!value.ok) throw new Error(value.error ?? `native service ${value.op} failed`);
    return value;
  }

  async readFrame(frame: NativeFrameRecord): Promise<Buffer> {
    if (!Number.isSafeInteger(frame.offset) || !Number.isSafeInteger(frame.len) || frame.len < 0) {
      throw new Error('native service returned an invalid shared-memory frame range');
    }
    const handle = await fs.open(this.#shmPath, 'r');
    try {
      const bytes = Buffer.allocUnsafe(frame.len);
      const { bytesRead } = await handle.read(bytes, 0, frame.len, frame.offset + RECORD_HEADER_BYTES);
      if (bytesRead !== frame.len) throw new Error(`short shared-memory read: ${bytesRead}/${frame.len}`);
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async close(): Promise<void> {
    if (this.#socket.destroyed) return;
    try { await this.rpc({ op: 'close' }); } catch { /* process teardown owns final cleanup */ }
    this.#socket.end();
  }

  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.byteLength >= HEADER_BYTES) {
      const length = this.#buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) return this.#fail(new Error(`native service response exceeds ${MAX_FRAME_BYTES} bytes`));
      if (this.#buffer.byteLength < HEADER_BYTES + length) return;
      const payload = this.#buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      this.#buffer = this.#buffer.subarray(HEADER_BYTES + length);
      const value = decode(payload) as NativeResponse;
      const pending = this.#pending.get(value.i);
      if (!pending) return this.#fail(new Error(`native service returned unknown request id ${value.i}`));
      this.#pending.delete(value.i);
      pending.resolve(value);
    }
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#socket.destroy();
  }
}

export function stripRgbaPadding(bytes: Buffer, width: number, height: number): Buffer {
  const rowBytes = width * 4;
  const stride = Math.ceil(rowBytes / 256) * 256;
  if (bytes.byteLength !== stride * height) {
    throw new Error(`unexpected RGBA payload size ${bytes.byteLength}; expected ${stride * height}`);
  }
  if (stride === rowBytes) return bytes;
  const packed = Buffer.allocUnsafe(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    bytes.copy(packed, row * rowBytes, row * stride, row * stride + rowBytes);
  }
  return packed;
}
