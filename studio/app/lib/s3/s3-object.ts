import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { copyFile, link, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { LOCAL_ARTIFACTS_DIR, LOCAL_ARTIFACT_BUCKET } from "../db/config";

export type LocalObjectMetadata = {
  contentType: string;
  contentEncoding?: string;
  checksumSha256Hex: string;
  sizeBytes: number;
};

export function localObjectPath(bucket: string, key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bucket) || !key || key.includes("\0")) {
    throw new Error("invalid_object_coordinate");
  }
  const bucketRoot = resolve(LOCAL_ARTIFACTS_DIR, bucket);
  const filePath = resolve(bucketRoot, key);
  if (!filePath.startsWith(`${bucketRoot}${sep}`)) throw new Error("invalid_object_key");
  return filePath;
}

function metadataPath(bucket: string, key: string): string {
  const root = resolve(LOCAL_ARTIFACTS_DIR, ".metadata", bucket);
  const filePath = resolve(root, `${key}.json`);
  if (!filePath.startsWith(`${root}${sep}`)) throw new Error("invalid_object_key");
  return filePath;
}

export async function writeLocalObject(
  bucket: string,
  key: string,
  bytes: Uint8Array,
  contentType = "application/octet-stream",
  contentEncoding?: string,
): Promise<LocalObjectMetadata> {
  const filePath = localObjectPath(bucket, key);
  const metaPath = metadataPath(bucket, key);
  await mkdir(dirname(filePath), { recursive: true });
  await mkdir(dirname(metaPath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, bytes);
  await rename(temporaryPath, filePath);
  const metadata: LocalObjectMetadata = {
    contentType,
    ...(contentEncoding ? { contentEncoding } : {}),
    checksumSha256Hex: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
  await writeFile(metaPath, JSON.stringify(metadata));
  return metadata;
}

/** Register a seed asset without duplicating it when source and store share a filesystem. */
export async function registerLocalFile(
  bucket: string,
  key: string,
  sourcePath: string,
  contentType = "application/octet-stream",
): Promise<LocalObjectMetadata> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(sourcePath)) {
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  const filePath = localObjectPath(bucket, key);
  const metaPath = metadataPath(bucket, key);
  await mkdir(dirname(filePath), { recursive: true });
  await mkdir(dirname(metaPath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await link(sourcePath, temporaryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(sourcePath, temporaryPath);
  }
  await rename(temporaryPath, filePath);
  const metadata: LocalObjectMetadata = {
    contentType,
    checksumSha256Hex: hash.digest("hex"),
    sizeBytes,
  };
  await writeFile(metaPath, JSON.stringify(metadata));
  return metadata;
}

export async function readLocalObjectMetadata(bucket: string, key: string): Promise<LocalObjectMetadata> {
  const filePath = localObjectPath(bucket, key);
  const fileStat = await stat(filePath);
  try {
    const stored = JSON.parse(await readFile(metadataPath(bucket, key), "utf8")) as LocalObjectMetadata;
    if (stored.sizeBytes === fileStat.size) return stored;
  } catch {
    // Objects created outside the helper are still readable and get a computed digest.
  }
  const bytes = await readFile(filePath);
  return {
    contentType: "application/octet-stream",
    checksumSha256Hex: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

export async function readLocalObject(bucket: string, key: string): Promise<Uint8Array> {
  return readFile(localObjectPath(bucket, key));
}

export function streamLocalObject(bucket: string, key: string): ReadStream {
  return createReadStream(localObjectPath(bucket, key));
}

export { LOCAL_ARTIFACT_BUCKET };
