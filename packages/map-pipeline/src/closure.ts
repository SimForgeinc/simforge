import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ClosureKind = 'canonical' | 'browser-optimized' | 'ktx2' | 'native-corpus';

export interface ClosureMember {
  sha256: string;
  bytes: number;
}

export interface MapClosure {
  schema: 'map-closure.v1';
  members: Record<string, ClosureMember>;
  kind: ClosureKind;
  toolFingerprint?: string;
  metadata?: { viewerOnly?: boolean };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

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

export async function hashTree(root: string): Promise<string> {
  const rows: string[] = [];
  for (const relativePath of await filesUnder(root)) {
    rows.push(`${relativePath}\0${sha256(await readFile(path.join(root, relativePath)))}`);
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
    const bytes = await readFile(path.join(root, relativePath));
    members[relativePath] = { sha256: sha256(bytes), bytes: bytes.byteLength };
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
