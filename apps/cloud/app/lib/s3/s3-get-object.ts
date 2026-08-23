import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { localObjectPath, readLocalObject, readLocalObjectMetadata } from "./s3-object";

const gunzipAsync = promisify(gunzip);

export type S3RawObjectDigest = {
  sha256Hex: string;
  sizeBytes: number;
};

type S3RawObjectDigestLimits = {
  maximumBytes: number;
  expectedBytes?: number;
};

export async function sha256S3RawObjectBounded(
  bucket: string,
  key: string,
  limits: S3RawObjectDigestLimits,
): Promise<S3RawObjectDigest> {
  const filePath = localObjectPath(bucket, key);
  const info = await stat(filePath);
  if (info.size > limits.maximumBytes) throw new Error("s3_object_exceeds_maximum_bytes");
  if (limits.expectedBytes !== undefined && info.size !== limits.expectedBytes) {
    throw new Error("s3_object_size_mismatch");
  }
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    sizeBytes += chunk.length;
    if (sizeBytes > limits.maximumBytes) throw new Error("s3_object_exceeds_maximum_bytes");
    hash.update(chunk);
  }
  return { sha256Hex: hash.digest("hex"), sizeBytes };
}

export async function headS3ObjectInfo(
  bucket: string,
  key: string,
): Promise<{ exists: boolean; sizeBytes: number | null }> {
  try {
    const metadata = await readLocalObjectMetadata(bucket, key);
    return { exists: true, sizeBytes: metadata.sizeBytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, sizeBytes: null };
    throw error;
  }
}

export async function getS3ObjectBytes(bucket: string, key: string): Promise<Uint8Array> {
  const bytes = await readLocalObject(bucket, key);
  const metadata = await readLocalObjectMetadata(bucket, key);
  return metadata.contentEncoding === "gzip" ? gunzipAsync(bytes) : bytes;
}

export async function getS3ObjectUtf8(bucket: string, key: string): Promise<string> {
  return Buffer.from(await getS3ObjectBytes(bucket, key)).toString("utf8");
}

export async function getS3ObjectUtf8Bounded(
  bucket: string,
  key: string,
  limits: { maximumStoredBytes: number; maximumRawBytes: number },
): Promise<string> {
  const metadata = await readLocalObjectMetadata(bucket, key);
  if (metadata.sizeBytes > limits.maximumStoredBytes) throw new Error("s3_object_exceeds_maximum_stored_bytes");
  const bytes = await getS3ObjectBytes(bucket, key);
  if (bytes.byteLength > limits.maximumRawBytes) throw new Error("s3_object_exceeds_maximum_raw_bytes");
  return Buffer.from(bytes).toString("utf8");
}
