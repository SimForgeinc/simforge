import { createHash } from 'node:crypto';

export type Sha256Digest = string;
export type MapVersion = `v${number}`;
/**
 * The only presentation derivative: the web streaming tier (`3d/**` cells
 * plus the master's `images/*.ktx2` they reference).
 */
export type DerivedClosureKind = 'web';

export interface ClosureMember {
  sha256: Sha256Digest;
  bytes: number;
}

export interface MapClosure {
  schema: 'map-closure.v1';
  members: Record<string, ClosureMember>;
  kind: 'canonical' | DerivedClosureKind;
  toolFingerprint?: string;
  metadata?: {
    viewerOnly?: boolean;
    /**
     * The canonical closure is a map master: one `master.gltf` with
     * `geometry.bin`, verbatim `images/*.png`, their `images/*.ktx2`
     * encodes and the road sidecars. Pull profiles key off this flag.
     */
    master?: boolean;
  };
}

export interface MapVersionRecord {
  version: MapVersion;
  closureDigest: Sha256Digest;
  releaseDigest?: Sha256Digest;
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

export interface MapRelease {
  schema: 'simforge.map-release.v1';
  name: string;
  version: MapVersion;
  visibility: 'private' | 'public';
  createdAt: string;
  canonical: { key: string; digest: Sha256Digest };
  web?: { key: string; digest: Sha256Digest };
  sourceRef?: string;
}

export function mapVisibility(name: string): MapRelease['visibility'] {
  return name === 'richmond-field-station' ? 'public' : 'private';
}

export function assertRelease(release: MapRelease): void {
  if (!release || release.schema !== 'simforge.map-release.v1') throw new Error('unsupported map release');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(release.name) || !/^v[1-9][0-9]*$/.test(release.version)) {
    throw new Error('invalid map release identity');
  }
  if (release.visibility !== mapVisibility(release.name)) throw new Error('map release visibility violates public policy');
  if (typeof release.createdAt !== 'string' || !Number.isFinite(Date.parse(release.createdAt))) throw new Error('invalid release timestamp');
  if (release.sourceRef !== undefined && typeof release.sourceRef !== 'string') throw new Error('invalid sourceRef');
  for (const reference of [release.canonical, ...(release.web ? [release.web] : [])]) {
    if (!reference || typeof reference.key !== 'string') throw new Error('invalid release closure reference');
    assertSafeRelativePath(reference.key);
    if (!reference.key.startsWith(`maps/${release.name}/${release.version}/`) || !reference.key.endsWith('.json') ||
        !/^[a-f0-9]{64}$/.test(reference.digest)) throw new Error('invalid release closure reference');
  }
}

export function releaseDigest(release: MapRelease): Sha256Digest {
  assertRelease(release);
  return sha256(canonicalJson(release));
}

export function assertSafeRelativePath(memberPath: string): void {
  if (
    typeof memberPath !== 'string' || memberPath.length === 0 ||
    memberPath.startsWith('/') ||
    memberPath.includes('\\') ||
    /[%:?#\u0000-\u001f]/u.test(memberPath) ||
    memberPath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe closure member path: ${memberPath}`);
  }
}

export function assertClosure(closure: MapClosure): void {
  if (closure.schema !== 'map-closure.v1') throw new Error(`unsupported closure schema: ${closure.schema}`);
  if (closure.kind !== 'canonical' && closure.kind !== 'web') throw new Error(`unsupported closure kind: ${closure.kind}`);
  if (!closure.members || typeof closure.members !== 'object' || Array.isArray(closure.members)) throw new Error('invalid closure members');
  if (closure.kind !== 'canonical' && closure.toolFingerprint === undefined) {
    throw new Error(`derived closure ${closure.kind} requires toolFingerprint`);
  }
  for (const [memberPath, member] of Object.entries(closure.members)) {
    assertSafeRelativePath(memberPath);
    if (!/^[a-f0-9]{64}$/.test(member.sha256)) throw new Error(`invalid sha256 for ${memberPath}`);
    if (!Number.isSafeInteger(member.bytes) || member.bytes < 0) throw new Error(`invalid byte count for ${memberPath}`);
  }
}
