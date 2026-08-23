import { readdir, rm } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { LOCAL_ARTIFACTS_DIR } from "../db/config";
import { localObjectPath } from "./s3-object";
import { S3_BUCKET } from "./s3-config";

async function walkFiles(root: string, current: string, output: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) await walkFiles(root, path, output);
    else if (entry.isFile()) output.push(relative(root, path).split(sep).join("/"));
  }
}

export async function listS3Keys(prefix: string, bucket = S3_BUCKET): Promise<string[]> {
  const root = resolve(LOCAL_ARTIFACTS_DIR, bucket);
  const keys: string[] = [];
  await walkFiles(root, root, keys);
  return keys.filter((key) => key.startsWith(prefix)).sort();
}

export async function deleteS3Keys(keys: string[], bucket = S3_BUCKET): Promise<number> {
  for (const key of keys) {
    await rm(localObjectPath(bucket, key), { force: true });
    const metadataRoot = resolve(LOCAL_ARTIFACTS_DIR, ".metadata", bucket);
    const metadataFile = resolve(metadataRoot, `${key}.json`);
    if (metadataFile.startsWith(`${metadataRoot}${sep}`)) await rm(metadataFile, { force: true });
  }
  return keys.length;
}
