import { readFile } from "node:fs/promises";
import type { ReadStream } from "node:fs";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { writeLocalObject } from "./s3-object";

const gzipAsync = promisify(gzip);

export interface PutS3ObjectOptions {
  contentEncoding?: string;
}

async function bodyBytes(body: string | Uint8Array | ReadStream): Promise<Uint8Array> {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function putS3Object(
  bucket: string,
  key: string,
  body: string | Uint8Array | ReadStream,
  contentType = "application/octet-stream",
  options: PutS3ObjectOptions = {},
): Promise<void> {
  await writeLocalObject(bucket, key, await bodyBytes(body), contentType, options.contentEncoding);
}

export async function putS3ObjectFromFile(
  bucket: string,
  key: string,
  filePath: string,
  contentType = "application/octet-stream",
): Promise<void> {
  await writeLocalObject(bucket, key, await readFile(filePath), contentType);
}

export async function putS3ObjectUtf8(
  bucket: string,
  key: string,
  body: string,
  contentType = "application/json",
): Promise<void> {
  await writeLocalObject(bucket, key, Buffer.from(body), contentType);
}

export async function putS3ObjectUtf8Gzipped(
  bucket: string,
  key: string,
  body: string,
  contentType = "application/json",
): Promise<void> {
  await writeLocalObject(bucket, key, await gzipAsync(Buffer.from(body)), contentType, "gzip");
}
