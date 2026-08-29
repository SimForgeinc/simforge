import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { LOCAL_ARTIFACTS_DIR } from "../db/config";
import { readLocalObjectMetadata, writeLocalObject } from "./s3-object";
import { S3_BUCKET } from "./s3-config";

export const MEDIA_URL_TTL_SECONDS = 3600;
export const PRESIGN_TTL_SECONDS = MEDIA_URL_TTL_SECONDS;
export const UPLOAD_TTL_SECONDS = 900;

export type CompletedPart = { ETag?: string; PartNumber?: number };

export function checksumBoundPutRequiredHeaders(
  contentType: string,
  checksumSha256Hex: string,
): Readonly<Record<string, string>> {
  return {
    "content-type": contentType,
    "x-amz-checksum-sha256": Buffer.from(checksumSha256Hex, "hex").toString("base64"),
    "x-amz-sdk-checksum-algorithm": "SHA256",
  };
}

function objectUrl(bucket: string, key: string): URL {
  const base = process.env.SIMFORGE_API_BASE_URL?.trim()
    ?? process.env.NEXT_PUBLIC_APP_URL?.trim()
    ?? `http://127.0.0.1:${process.env.PORT?.trim() || "5199"}`;
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return new URL(`/api/local-objects/${encodeURIComponent(bucket)}/${encoded}`, base);
}

export async function getPresignedGetUrl(
  key: string,
  bucket = S3_BUCKET,
  _expiresIn = MEDIA_URL_TTL_SECONDS,
  responseContentDisposition?: string,
): Promise<string> {
  const url = objectUrl(bucket, key);
  if (responseContentDisposition) url.searchParams.set("response-content-disposition", responseContentDisposition);
  return url.toString();
}

export async function getPresignedPutUrl(
  key: string,
  contentType: string,
  bucket = S3_BUCKET,
  _expiresIn = UPLOAD_TTL_SECONDS,
  checksumSha256Hex?: string | null,
): Promise<string> {
  const url = objectUrl(bucket, key);
  url.searchParams.set("content-type", contentType);
  if (checksumSha256Hex) url.searchParams.set("sha256", checksumSha256Hex.toLowerCase());
  return url.toString();
}

export async function headS3Object(key: string, bucket = S3_BUCKET) {
  const metadata = await readLocalObjectMetadata(bucket, key);
  return {
    contentLength: metadata.sizeBytes,
    contentType: metadata.contentType,
    etag: `"${metadata.checksumSha256Hex}"`,
    checksumSha256: Buffer.from(metadata.checksumSha256Hex, "hex").toString("base64"),
  };
}

export async function getS3ObjectChecksum(key: string, bucket = S3_BUCKET) {
  const metadata = await readLocalObjectMetadata(bucket, key);
  return {
    checksumSha256: Buffer.from(metadata.checksumSha256Hex, "hex").toString("base64"),
    objectSize: metadata.sizeBytes,
  };
}

function multipartRoot(uploadId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(uploadId)) throw new Error("invalid_upload_id");
  return resolve(LOCAL_ARTIFACTS_DIR, ".multipart", uploadId);
}

export async function initiateS3MultipartUpload(
  key: string,
  contentType: string,
  bucket = S3_BUCKET,
) {
  const uploadId = randomUUID();
  const root = multipartRoot(uploadId);
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, "manifest.json"), JSON.stringify({ key, contentType, bucket }));
  return { uploadId, bucket, key };
}

export async function getPresignedMultipartPartUrl(
  key: string,
  uploadId: string,
  partNumber: number,
  bucket = S3_BUCKET,
  _expiresIn = UPLOAD_TTL_SECONDS,
) {
  const url = objectUrl(bucket, key);
  url.searchParams.set("uploadId", uploadId);
  url.searchParams.set("partNumber", String(partNumber));
  return url.toString();
}

export async function completeS3MultipartUpload(
  key: string,
  uploadId: string,
  parts: CompletedPart[],
  bucket = S3_BUCKET,
): Promise<void> {
  const root = multipartRoot(uploadId);
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")) as {
    key: string; contentType: string; bucket: string;
  };
  if (manifest.key !== key || manifest.bucket !== bucket) throw new Error("multipart_coordinate_mismatch");
  const ordered = [...parts].sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0));
  const buffers = await Promise.all(ordered.map((part) => readFile(resolve(root, `${part.PartNumber}.part`))));
  await writeLocalObject(bucket, key, Buffer.concat(buffers), manifest.contentType);
  await rm(root, { recursive: true, force: true });
}

export async function abortS3MultipartUpload(
  _key: string,
  uploadId: string,
  _bucket = S3_BUCKET,
): Promise<void> {
  await rm(multipartRoot(uploadId), { recursive: true, force: true });
}

export async function writeMultipartPart(uploadId: string, partNumber: number, bytes: Uint8Array): Promise<void> {
  if (!Number.isInteger(partNumber) || partNumber < 1) throw new Error("invalid_part_number");
  const path = resolve(multipartRoot(uploadId), `${partNumber}.part`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
