import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { hashFile, throwIfCanceled, type RenderInputFile } from '@simforge-oss/render';
import type { JobInputTransfer } from '@simforge-oss/render';

function safeInputName(inputId: string): string {
  const stem = inputId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'input';
  const suffix = createHash('sha256').update(inputId).digest('hex').slice(0, 12);
  return `${stem}-${suffix}`;
}

async function verifyFile(path: string, expectedSha256: string, expectedSize: number): Promise<void> {
  const actual = await hashFile(path);
  if (actual.sha256 !== expectedSha256 || actual.sizeBytes !== expectedSize) {
    throw new Error(`transfer integrity mismatch for ${basename(path)}: expected ${expectedSha256}/${expectedSize}, got ${actual.sha256}/${actual.sizeBytes}`);
  }
}

export async function downloadInputs(
  transfers: readonly JobInputTransfer[],
  workspace: string,
  cacheDir: string,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, RenderInputFile>> {
  const inputDir = join(workspace, 'inputs');
  await mkdir(inputDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  const result = new Map<string, RenderInputFile>();

  for (const transfer of transfers) {
    throwIfCanceled(signal);
    if (result.has(transfer.inputId)) throw new Error(`duplicate inputId ${transfer.inputId}`);
    const cachePath = join(cacheDir, transfer.sha256);
    let cacheValid = false;
    try {
      const cached = await stat(cachePath);
      cacheValid = cached.isFile() && cached.size === transfer.sizeBytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (!cacheValid) {
      const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.part`;
      const response = await fetch(transfer.download.url, { headers: transfer.download.headers, signal });
      if (!response.ok || !response.body) throw new Error(`input ${transfer.inputId} download returned ${response.status}`);
      const digest = createHash('sha256');
      let sizeBytes = 0;
      const hashingStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sizeBytes += chunk.length;
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(response.body as never), hashingStream, createWriteStream(temporaryPath, { mode: 0o600 }), { signal });
        const sha256 = digest.digest('hex');
        if (sha256 !== transfer.sha256 || sizeBytes !== transfer.sizeBytes) {
          throw new Error(`input ${transfer.inputId} integrity mismatch: expected ${transfer.sha256}/${transfer.sizeBytes}, got ${sha256}/${sizeBytes}`);
        }
        await rename(temporaryPath, cachePath).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
          await rm(temporaryPath, { force: true });
        });
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
    }

    const localPath = join(inputDir, safeInputName(transfer.inputId));
    await copyFile(cachePath, localPath);
    try {
      await verifyFile(localPath, transfer.sha256, transfer.sizeBytes);
    } catch (error) {
      await Promise.all([rm(cachePath, { force: true }), rm(localPath, { force: true })]);
      throw error;
    }
    result.set(transfer.inputId, { inputId: transfer.inputId, path: localPath, sha256: transfer.sha256, sizeBytes: transfer.sizeBytes });
  }
  return result;
}

export async function uploadFile(
  url: string,
  headers: Readonly<Record<string, string>>,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  const size = (await stat(path)).size;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'content-length': String(size) },
    body: createReadStream(path),
    duplex: 'half',
    signal,
  } as unknown as RequestInit & { duplex: 'half' });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`artifact upload returned ${response.status}: ${text.slice(0, 2048)}`);
  }
}
