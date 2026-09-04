import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

export interface PutOptions {
  ifAbsent?: boolean;
  ifMatch?: string;
}

export interface VersionedObject {
  bytes: Uint8Array;
  etag?: string;
}

export interface MultipartOptions {
  resumeFile?: string;
  partBytes?: number;
}

export interface RegistryBackend {
  readonly url: string;
  get(key: string): Promise<Uint8Array>;
  getVersioned?(key: string): Promise<VersionedObject>;
  getRange(key: string, start: number, endInclusive?: number): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  put(key: string, bytes: Uint8Array, options?: PutOptions): Promise<void>;
  putFile(key: string, sourcePath: string, options?: PutOptions & MultipartOptions): Promise<void>;
}

function safeFilePath(root: string, key: string): string {
  const target = resolve(root, key);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(rootPrefix)) throw new Error(`registry key escapes root: ${key}`);
  return target;
}

async function writeAtomic(target: string, bytes: Uint8Array, ifAbsent: boolean): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes);
    if (ifAbsent) await link(temporary, target);
    else await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export class FileRegistryBackend implements RegistryBackend {
  readonly url: string;
  readonly root: string;

  constructor(url: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') throw new Error(`expected file:// registry URL, got ${url}`);
    this.root = resolve(decodeURIComponent(parsed.pathname));
    this.url = `file://${this.root}`;
  }

  async get(key: string): Promise<Uint8Array> {
    return readFile(safeFilePath(this.root, key));
  }

  async getVersioned(key: string): Promise<VersionedObject> {
    const bytes = await this.get(key);
    return { bytes, etag: createHash('sha256').update(bytes).digest('hex') };
  }

  async getRange(key: string, start: number, endInclusive?: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(start) || start < 0) throw new Error(`invalid range start: ${start}`);
    const target = safeFilePath(this.root, key);
    const info = await stat(target);
    const end = endInclusive ?? info.size - 1;
    if (!Number.isSafeInteger(end) || end < start) throw new Error(`invalid range end: ${end}`);
    const length = Math.min(end, info.size - 1) - start + 1;
    if (length <= 0) return new Uint8Array();
    const handle = await open(target, 'r');
    try {
      const bytes = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(bytes, 0, length, start);
      return bytes.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async list(prefix: string): Promise<string[]> {
    const base = safeFilePath(this.root, prefix);
    const keys: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
        } else if (entry.isFile()) {
          keys.push(path.slice(this.root.length + 1).split(sep).join('/'));
        }
      }
    };
    await visit(base);
    return keys.sort();
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(safeFilePath(this.root, key));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async put(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<void> {
    const target = safeFilePath(this.root, key);
    await mkdir(dirname(target), { recursive: true });
    const lock = `${target}.lock`;
    let handle;
    for (let attempt = 0; attempt < 1000; attempt++) {
      try {
        handle = await open(lock, 'wx');
        await handle.writeFile(String(process.pid));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const owner = Number(await readFile(lock, 'utf8'));
          if (Number.isSafeInteger(owner) && owner > 0) {
            try { process.kill(owner, 0); }
            catch (probe) {
              if ((probe as NodeJS.ErrnoException).code === 'ESRCH') await unlink(lock).catch(() => undefined);
            }
          }
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code !== 'ENOENT') throw probe;
        }
        await delay(10);
      }
    }
    if (!handle) throw new Error(`registry lock timeout: ${key}`);
    try {
      if (options.ifMatch) {
        const current = await this.getVersioned(key);
        if (current.etag !== options.ifMatch) throw Object.assign(new Error(`registry CAS conflict: ${key}`), { code: 'PreconditionFailed' });
      }
      await writeAtomic(target, bytes, options.ifAbsent ?? false);
    } finally {
      await handle.close();
      await unlink(lock);
    }
  }

  async putFile(key: string, sourcePath: string, options: PutOptions & MultipartOptions = {}): Promise<void> {
    const target = safeFilePath(this.root, key);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${randomUUID()}`;
    try {
      await copyFile(sourcePath, temporary);
      if (options.ifAbsent) await link(temporary, target);
      else await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

interface MultipartResumeState {
  bucket: string;
  key: string;
  sourcePath: string;
  sourceBytes: number;
  sourceMtimeMs: number;
  uploadId: string;
  partBytes: number;
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  if (body !== null && typeof body === 'object' && 'transformToByteArray' in body) {
    return (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
  }
  throw new Error('S3 returned an unreadable response body');
}

export function isRegistryWriteConflict(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  let status: unknown;
  if ('$metadata' in error && error.$metadata !== null && typeof error.$metadata === 'object'
    && 'httpStatusCode' in error.$metadata) {
    status = error.$metadata.httpStatusCode;
  } else if ('statusCode' in error) {
    status = error.statusCode;
  }
  return status === 409 || status === 412 || ('code' in error && (error.code === 'EEXIST' || error.code === 'PreconditionFailed'));
}

export class S3RegistryBackend implements RegistryBackend {
  readonly url: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly client: S3Client;

  constructor(url: string, client = new S3Client({})) {
    const parsed = new URL(url);
    if (parsed.protocol !== 's3:') throw new Error(`expected s3:// registry URL, got ${url}`);
    this.bucket = parsed.hostname;
    if (this.bucket.length === 0) throw new Error(`S3 registry URL has no bucket: ${url}`);
    this.prefix = parsed.pathname.replace(/^\/+|\/+$/g, '');
    this.url = `s3://${this.bucket}${this.prefix.length > 0 ? `/${this.prefix}` : ''}`;
    this.client = client;
  }

  private objectKey(key: string): string {
    return this.prefix.length > 0 ? `${this.prefix}/${key}` : key;
  }

  async get(key: string): Promise<Uint8Array> {
    return (await this.getVersioned(key)).bytes;
  }

  async getVersioned(key: string): Promise<VersionedObject> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
    return {
      bytes: await bodyBytes(response.Body),
      ...(response.ETag === undefined ? {} : { etag: response.ETag }),
    };
  }

  async getRange(key: string, start: number, endInclusive?: number): Promise<Uint8Array> {
    const range = `bytes=${start}-${endInclusive ?? ''}`;
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key), Range: range }),
    );
    return bodyBytes(response.Body);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return false;
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.objectKey(prefix),
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key === undefined) continue;
        keys.push(this.prefix.length > 0 ? object.Key.slice(this.prefix.length + 1) : object.Key);
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    return keys.sort();
  }

  async put(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(key),
          Body: bytes,
          ...(options.ifAbsent ? { IfNoneMatch: '*' } : {}),
          ...(options.ifMatch ? { IfMatch: options.ifMatch } : {}),
        }),
      );
    } catch (error) {
      if (!options.ifAbsent || !isRegistryWriteConflict(error) || !/^blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/u.test(key)) throw error;
      await this.verifyExistingBlob(key, bytes.byteLength);
    }
  }

  private async verifyExistingBlob(key: string, expectedBytes: number): Promise<void> {
    const response = await this.client.send(new HeadObjectCommand({
      Bucket: this.bucket,
      Key: this.objectKey(key),
      ChecksumMode: 'ENABLED',
    }));
    if (response.ContentLength !== expectedBytes) {
      throw new Error(`content-addressed blob collision for ${key}: expected ${expectedBytes} bytes, found ${response.ContentLength ?? 'unknown'}`);
    }
    const expectedDigest = key.split('/').at(-1);
    if (response.ChecksumSHA256 !== undefined && expectedDigest?.match(/^[a-f0-9]{64}$/)) {
      const expectedChecksum = Buffer.from(expectedDigest, 'hex').toString('base64');
      if (response.ChecksumSHA256 !== expectedChecksum) {
        throw new Error(`content-addressed blob checksum mismatch for ${key}`);
      }
    }
    if (response.ChecksumSHA256 === undefined) {
      const hash = createHash('sha256');
      for (let offset = 0; offset < expectedBytes;) {
        const count = Math.min(8 * 1024 * 1024, expectedBytes - offset);
        const bytes = await this.getRange(key, offset, offset + count - 1);
        if (bytes.byteLength !== count) throw new Error(`invalid blob range: ${key}`);
        hash.update(bytes);
        offset += count;
      }
      if (hash.digest('hex') !== expectedDigest) throw new Error(`content-addressed blob checksum mismatch for ${key}`);
    }
  }

  async putFile(key: string, sourcePath: string, options: PutOptions & MultipartOptions = {}): Promise<void> {
    const source = await stat(sourcePath);
    if (options.ifAbsent && (await this.exists(key))) {
      if (!/^blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/u.test(key)) throw new Error(`registry object already exists: ${key}`);
      await this.verifyExistingBlob(key, source.size);
      return;
    }
    if (source.size === 0) {
      await this.put(key, new Uint8Array(), { ifAbsent: options.ifAbsent });
      if (options.resumeFile !== undefined) await unlink(options.resumeFile).catch(() => undefined);
      return;
    }
    const partBytes = Math.max(options.partBytes ?? 64 * 1024 * 1024, 5 * 1024 * 1024);
    const objectKey = this.objectKey(key);
    let state: MultipartResumeState | undefined;
    if (options.resumeFile !== undefined) {
      try {
        state = JSON.parse(await readFile(options.resumeFile, 'utf8')) as MultipartResumeState;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (
        state !== undefined &&
        (state.bucket !== this.bucket ||
          state.key !== objectKey ||
          state.sourcePath !== resolve(sourcePath) ||
          state.sourceBytes !== source.size ||
          state.sourceMtimeMs !== source.mtimeMs ||
          state.partBytes !== partBytes)
      ) {
        await this.client.send(
          new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: state.key, UploadId: state.uploadId }),
        );
        state = undefined;
      }
    }
    if (state === undefined) {
      const created = await this.client.send(
        new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      if (created.UploadId === undefined) throw new Error('S3 did not return a multipart upload id');
      state = {
        bucket: this.bucket,
        key: objectKey,
        sourcePath: resolve(sourcePath),
        sourceBytes: source.size,
        sourceMtimeMs: source.mtimeMs,
        uploadId: created.UploadId,
        partBytes,
      };
      if (options.resumeFile !== undefined) {
        await mkdir(dirname(options.resumeFile), { recursive: true });
        await writeFile(options.resumeFile, JSON.stringify(state));
      }
    }
    const completed = new Map<number, string>();
    let partNumberMarker: string | undefined;
    do {
      const listed = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: objectKey,
          UploadId: state.uploadId,
          PartNumberMarker: partNumberMarker,
        }),
      );
      for (const part of listed.Parts ?? []) {
        if (part.PartNumber !== undefined && part.ETag !== undefined) {
          completed.set(part.PartNumber, part.ETag);
        }
      }
      partNumberMarker = listed.IsTruncated ? listed.NextPartNumberMarker : undefined;
    } while (partNumberMarker !== undefined);
    const partCount = Math.ceil(source.size / partBytes);
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      if (completed.has(partNumber)) continue;
      const start = (partNumber - 1) * partBytes;
      const end = Math.min(source.size - 1, start + partBytes - 1);
      const uploaded = await this.client.send(
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: objectKey,
          UploadId: state.uploadId,
          PartNumber: partNumber,
          Body: createReadStream(sourcePath, { start, end }),
          ContentLength: end - start + 1,
        }),
      );
      if (uploaded.ETag === undefined) throw new Error(`S3 did not return an ETag for part ${partNumber}`);
      completed.set(partNumber, uploaded.ETag);
    }
    try {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: objectKey,
        UploadId: state.uploadId,
        ...(options.ifAbsent ? { IfNoneMatch: '*' } : {}),
        ...(options.ifMatch ? { IfMatch: options.ifMatch } : {}),
        MultipartUpload: {
          Parts: [...completed.entries()]
            .sort(([left], [right]) => (left ?? 0) - (right ?? 0))
            .map(([PartNumber, ETag]) => ({ PartNumber, ETag })),
        },
      }),
    );
    } catch (error) {
      if (!options.ifAbsent || !isRegistryWriteConflict(error)) throw error;
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: objectKey, UploadId: state.uploadId })).catch(() => undefined);
      if (!/^blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/u.test(key)) throw error;
      await this.verifyExistingBlob(key, source.size);
    }
    if (options.resumeFile !== undefined) await unlink(options.resumeFile).catch(() => undefined);
  }
}

export class HttpRegistryBackend implements RegistryBackend {
  readonly url: string;

  constructor(url: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`expected HTTP registry URL, got ${url}`);
    }
    this.url = url.replace(/\/+$/, '');
  }

  private objectUrl(key: string): string {
    return `${this.url}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await fetch(this.objectUrl(key));
    if (!response.ok) throw new Error(`registry GET ${key} failed: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async getRange(key: string, start: number, endInclusive?: number): Promise<Uint8Array> {
    const response = await fetch(this.objectUrl(key), {
      headers: { Range: `bytes=${start}-${endInclusive ?? ''}` },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw Object.assign(new Error(`registry ranged GET ${key} failed: HTTP ${response.status}`), { statusCode: response.status });
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error(`registry does not support bounded range reads: ${key}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async exists(key: string): Promise<boolean> {
    const response = await fetch(this.objectUrl(key), { method: 'HEAD' });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`registry HEAD ${key} failed: HTTP ${response.status}`);
    return true;
  }

  async list(_prefix: string): Promise<string[]> {
    throw new Error('HTTP registries cannot enumerate derived closures; provide tool fingerprints');
  }

  async put(_key: string, _bytes: Uint8Array, _options: PutOptions = {}): Promise<void> {
    throw new Error('HTTP registries are read-only');
  }

  async putFile(_key: string, _sourcePath: string, _options: PutOptions & MultipartOptions = {}): Promise<void> {
    throw new Error('HTTP registries are read-only');
  }
}


export function createRegistryBackend(url: string): RegistryBackend {
  if (url.startsWith('file://')) return new FileRegistryBackend(url);
  if (url.startsWith('s3://')) return new S3RegistryBackend(url);
  if (url.startsWith('https://') || url.startsWith('http://')) return new HttpRegistryBackend(url);
  throw new Error(`unsupported registry URL: ${url}`);
}
