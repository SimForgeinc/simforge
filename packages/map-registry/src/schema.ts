import { createHash } from 'node:crypto';

export type Sha256Digest = string;
export type MapVersion = `v${number}`;
export type DerivedClosureKind = 'browser-optimized' | 'ktx2' | 'native-corpus';

export interface ClosureMember {
  sha256: Sha256Digest;
  bytes: number;
}

export interface MapClosure {
  schema: 'map-closure.v1';
  members: Record<string, ClosureMember>;
  kind: 'canonical' | DerivedClosureKind;
  toolFingerprint?: string;
  metadata?: { viewerOnly?: boolean };
}

export interface MapVersionRecord {
  version: MapVersion;
  closureDigest: Sha256Digest;
  createdAt: string;
  promotedFrom?: string;
  sourceRef?: string;
}

export interface MapSummary {
  label?: string;
  description?: string;
  [key: string]: unknown;
}

export interface MapIndexEntry {
  latest: MapVersion;
  versions: MapVersion[];
  summary: MapSummary;
}

export type MapRegistryIndex = Record<string, MapIndexEntry>;

export interface DerivedClosureInput {
  closure: MapClosure;
  files: Record<string, string | Uint8Array>;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot encode a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}

export function sha256(bytes: Uint8Array | string): Sha256Digest {
  return createHash('sha256').update(bytes).digest('hex');
}

export function closureDigest(closure: MapClosure): Sha256Digest {
  return sha256(canonicalJson(closure));
}

export function assertSafeRelativePath(memberPath: string): void {
  if (
    memberPath.length === 0 ||
    memberPath.startsWith('/') ||
    memberPath.includes('\\') ||
    memberPath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe closure member path: ${memberPath}`);
  }
}

export function assertClosure(closure: MapClosure): void {
  if (closure.schema !== 'map-closure.v1') throw new Error(`unsupported closure schema: ${closure.schema}`);
  if (closure.kind !== 'canonical' && closure.toolFingerprint === undefined) {
    throw new Error(`derived closure ${closure.kind} requires toolFingerprint`);
  }
  for (const [memberPath, member] of Object.entries(closure.members)) {
    assertSafeRelativePath(memberPath);
    if (!/^[a-f0-9]{64}$/.test(member.sha256)) throw new Error(`invalid sha256 for ${memberPath}`);
    if (!Number.isSafeInteger(member.bytes) || member.bytes < 0) throw new Error(`invalid byte count for ${memberPath}`);
  }
}
