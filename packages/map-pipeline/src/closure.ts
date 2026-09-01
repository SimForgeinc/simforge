import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { canonicalJson, sha256 } from '@simforge-oss/map-registry';
import type { ClosureMember, MapClosure } from '@simforge-oss/map-registry';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ClosureKind = MapClosure['kind'];
export type { ClosureMember, MapClosure };
export { canonicalJson, sha256 };

export function closureBytes(closure: MapClosure): Buffer {
  return Buffer.from(canonicalJson(closure));
}

export function closureDigest(closure: MapClosure): string {
  return sha256(closureBytes(closure));
}

export async function filesUnder(root: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) output.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  };
  await walk(root);
  return output;
}

async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

export async function hashTree(root: string): Promise<string> {
  const rows: string[] = [];
  for (const relativePath of await filesUnder(root)) {
    rows.push(`${relativePath}\0${(await hashFile(path.join(root, relativePath))).sha256}`);
  }
  return sha256(rows.join('\n'));
}

export async function buildClosure(
  root: string,
  kind: ClosureKind,
  options: { toolFingerprint?: string; viewerOnly?: boolean } = {},
): Promise<MapClosure> {
  const members: Record<string, ClosureMember> = {};
  for (const relativePath of await filesUnder(root)) {
    members[relativePath] = await hashFile(path.join(root, relativePath));
  }
  return {
    schema: 'map-closure.v1',
    members,
    kind,
    ...(options.toolFingerprint ? { toolFingerprint: options.toolFingerprint } : {}),
    ...(options.viewerOnly ? { metadata: { viewerOnly: true } } : {}),
  };
}

export async function writeClosure(root: string, closure: MapClosure): Promise<{ path: string; digest: string }> {
  await mkdir(root, { recursive: true });
  const output = path.join(root, 'closure.json');
  const bytes = closureBytes(closure);
  await writeFile(output, bytes);
  return { path: output, digest: sha256(bytes) };
}

export async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  for (const relativePath of await filesUnder(root)) total += (await stat(path.join(root, relativePath))).size;
  return total;
}
