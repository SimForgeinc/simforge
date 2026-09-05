import { createHash, randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { isRegistryWriteConflict, type RegistryBackend } from './backend.js';
import {
  assertClosure,
  assertRelease,
  releaseDigest,
  mapVisibility,
  type MapRelease,
  assertSafeRelativePath,
  canonicalJson,
  closureDigest,
  sha256,
  type DerivedClosureInput,
  type DerivedClosureKind,
  type MapClosure,
  type MapIndexEntry,
  type MapRegistryIndex,
  type MapSummary,
  type MapVersion,
  type MapVersionRecord,
} from './schema.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function blobKey(digest: string): string {
  return `blobs/sha256/${digest.slice(0, 2)}/${digest}`;
}

function parseJson<T>(bytes: Uint8Array, label: string): T {
  try {
    return JSON.parse(textDecoder.decode(bytes)) as T;
  } catch (error) {
    throw new Error(`invalid JSON in ${label}`, { cause: error });
  }
}

async function readOptionalJson<T>(backend: RegistryBackend, key: string, fallback: T): Promise<T> {
  if (!(await backend.exists(key))) return fallback;
  return parseJson<T>(await backend.get(key), key);
}


export interface IndexWriteRetryOptions {
  maxAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

export async function mergeIndexEntry(
  backend: RegistryBackend,
  name: string,
  version: MapVersion,
  summary: MapSummary | undefined,
  options: IndexWriteRetryOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 7;
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  let lastConflict: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const exists = await backend.exists('index.json');
    const snapshot = exists
      ? backend.getVersioned
        ? await backend.getVersioned('index.json')
        : { bytes: await backend.get('index.json') }
      : undefined;
    const index = snapshot === undefined ? {} : parseJson<MapRegistryIndex>(snapshot.bytes, 'index.json');
    if (snapshot && !snapshot.etag) throw new Error('registry backend must support conditional writes');
    const previous = index[name];
    const versions = [...new Set([...(previous?.versions ?? []), version])]
      .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
    const latest = versions.at(-1) ?? version;
    const entry: MapIndexEntry = {
      latest,
      versions,
      summary: summary ?? previous?.summary ?? {},
    };
    try {
      await backend.put(
        'index.json',
        textEncoder.encode(canonicalJson({ ...index, [name]: entry })),
        snapshot?.etag ? { ifMatch: snapshot.etag } : exists ? {} : { ifAbsent: true },
      );
      return;
    } catch (error) {
      if (!isRegistryWriteConflict(error)) throw error;
      lastConflict = error;
      if (attempt + 1 >= maxAttempts) break;
      const exponentialMs = Math.min(25 * 2 ** attempt, 1_000);
      await sleep(exponentialMs + Math.floor(exponentialMs * 0.25 * random()));
    }
  }
  throw new Error(`registry index update for ${name}@${version} exhausted ${maxAttempts} attempts`, {
    cause: lastConflict,
  });
}

async function boundedEach<T>(items: readonly T[], concurrency: number, visit: (item: T) => Promise<void>): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('registry concurrency must be an integer from 1 to 32');
  let cursor = 0;
  let failed = false;
  const results = await Promise.allSettled(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (!failed && cursor < items.length) {
      const item = items[cursor++]!;
      try { await visit(item); }
      catch (error) { failed = true; throw error; }
    }
  }));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

async function uploadClosureMembers(
  backend: RegistryBackend,
  closure: MapClosure,
  files: Record<string, string | Uint8Array>,
  uploaded: Set<string>,
  concurrency: number,
): Promise<void> {
  assertClosure(closure);
  const declaredPaths = Object.keys(closure.members).sort();
  const suppliedPaths = Object.keys(files).sort();
  if (canonicalJson(declaredPaths) !== canonicalJson(suppliedPaths)) {
    throw new Error('closure members and supplied files differ');
  }
  await boundedEach(declaredPaths, concurrency, async (memberPath) => {
    const member = closure.members[memberPath];
    const source = files[memberPath];
    if (member === undefined || source === undefined) throw new Error(`missing closure source: ${memberPath}`);
    if (typeof source === 'string') {
      const actual = await hashFile(source);
      if (actual.sha256 !== member.sha256 || actual.bytes !== member.bytes) {
        throw new Error(`closure source does not match ${memberPath}`);
      }
    } else if (sha256(source) !== member.sha256 || source.byteLength !== member.bytes) {
      throw new Error(`closure source does not match ${memberPath}`);
    }
    const key = blobKey(member.sha256);
    if (uploaded.has(member.sha256)) return;
    uploaded.add(member.sha256);
    if (await backend.exists(key)) {
      await verifyRemoteBlob(backend, memberPath, member.sha256, member.bytes);
      return;
    }
    try {
      if (typeof source === 'string') await backend.putFile(key, source, { ifAbsent: true });
      else await backend.put(key, source, { ifAbsent: true });
    } catch (error) {
      if (!isRegistryWriteConflict(error)) throw error;
      await verifyRemoteBlob(backend, memberPath, member.sha256, member.bytes);
    }
  });
}

function derivedClosureKey(name: string, version: MapVersion, closure: MapClosure): string {
  if (closure.kind === 'canonical' || closure.toolFingerprint === undefined) {
    throw new Error('derived closure requires a derived kind and tool fingerprint');
  }
  const fingerprint = sha256(closure.toolFingerprint).slice(0, 24);
  return `maps/${name}/${version}/derived/${closure.kind}-${fingerprint}.json`;
}

export interface PublishVersionInput {
  name: string;
  version?: MapVersion;
  closure: MapClosure;
  files: Record<string, string | Uint8Array>;
  derived?: readonly DerivedClosureInput[];
  summary?: MapSummary;
  createdAt?: string;
  promotedFrom?: string;
  sourceRef?: string;
  target?: 'private' | 'public';
  concurrency?: number;
}

export interface PublishedVersion {
  release: MapRelease;
  record: MapVersionRecord;
  derivedKeys: string[];
}

function validateMapName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`invalid map name: ${name}`);
}

function nextVersion(records: readonly MapVersionRecord[]): MapVersion {
  const highest = records.reduce((value, record) => Math.max(value, Number(record.version.slice(1))), 0);
  return `v${highest + 1}`;
}

async function validateResourceShape(closure: MapClosure, files: Record<string, string | Uint8Array>): Promise<void> {
  assertClosure(closure);
  const rootDocument = closure.kind === 'canonical' ? 'master.gltf' : '3d/manifest.json';
  if (!closure.members[rootDocument] || (closure.kind === 'canonical' && closure.metadata?.master !== true)) {
    throw new Error(`release requires ${rootDocument}`);
  }
  const readPart = async (path: string, start: number, length: number): Promise<Uint8Array> => {
    const source = files[path];
    if (source === undefined) throw new Error(`missing closure source: ${path}`);
    if (typeof source !== 'string') return source.subarray(start, start + length);
    const handle = await open(source, 'r');
    try {
      const bytes = Buffer.alloc(length);
      const result = await handle.read(bytes, 0, length, start);
      return bytes.subarray(0, result.bytesRead);
    } finally { await handle.close(); }
  };
  for (const [path, member] of Object.entries(closure.members)) {
    if (closure.kind === 'canonical' && (path.endsWith('.glb') || (path.endsWith('.gltf') && path !== 'master.gltf'))) {
      throw new Error('canonical release must contain exactly one master scene');
    }
    if (!path.endsWith('.gltf') && !path.endsWith('.glb') && path !== rootDocument) continue;
    let json: Uint8Array;
    if (path.endsWith('.glb')) {
      const header = Buffer.from(await readPart(path, 0, 20));
      if (header.length !== 20 || header.readUInt32LE(0) !== 0x46546c67 || header.readUInt32LE(4) !== 2 ||
          header.readUInt32LE(8) !== member.bytes || header.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`invalid GLB: ${path}`);
      const length = header.readUInt32LE(12);
      if (length > 64 * 1024 * 1024 || length + 20 > member.bytes) throw new Error(`invalid GLB JSON length: ${path}`);
      json = await readPart(path, 20, length);
    } else {
      if (member.bytes > 64 * 1024 * 1024) throw new Error(`scene JSON exceeds size limit: ${path}`);
      json = await readPart(path, 0, member.bytes);
    }
    const document = parseJson<Record<string, unknown>>(json, path);
    if (!document || Array.isArray(document) || typeof document !== 'object') throw new Error(`invalid scene document: ${path}`);
    if (path === '3d/manifest.json' && (document.version !== '1.2.0' || !Array.isArray(document.tiles) ||
        !Array.isArray(document.staticLayers) || !Array.isArray(document.vegetationTiles))) {
      throw new Error('unsupported web manifest shape');
    }
    if (path.endsWith('.gltf') || path.endsWith('.glb')) {
      if ((document.asset as { version?: string } | undefined)?.version !== '2.0') throw new Error(`unsupported glTF asset: ${path}`);
      if (document.buffers !== undefined && !Array.isArray(document.buffers)) throw new Error(`invalid glTF buffers: ${path}`);
      for (const buffer of (document.buffers ?? []) as Array<{ uri?: string; byteLength: number }>) {
        if (!Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0 || (path.endsWith('.gltf') && typeof buffer.uri !== 'string')) {
          throw new Error(`invalid glTF buffer: ${path}`);
        }
        if (typeof buffer.uri === 'string') {
          const resource = posix.normalize(posix.join(posix.dirname(path), buffer.uri));
          if (closure.members[resource]?.bytes !== buffer.byteLength) throw new Error(`glTF buffer length mismatch: ${resource}`);
        }
      }
    }
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if ((key === 'uri' || (path === '3d/manifest.json' && key === 'file')) && typeof item === 'string') {
          if (/^[a-z][a-z0-9+.-]*:|^[\\/]|[%?#\u0000-\u001f\\]/iu.test(item)) throw new Error(`unsafe scene resource ${item} in ${path}`);
          const resource = posix.normalize(posix.join(posix.dirname(path), item));
          assertSafeRelativePath(resource);
          if (!closure.members[resource]) throw new Error(`missing scene resource ${resource} in ${path}`);
        } else visit(item);
      }
    };
    visit(document);
  }
}

async function exactDerivedClosures(backend: RegistryBackend, release: MapRelease, supplied?: readonly MapClosure[]): Promise<MapClosure[]> {
  const closures: MapClosure[] = [];
  if (release.web) {
    const closure = parseJson<MapClosure>(await backend.get(release.web.key), release.web.key);
    assertClosure(closure);
    if (closure.kind !== 'web' || closureDigest(closure) !== release.web.digest) throw new Error('release web closure digest mismatch');
    closures.push(closure);
  }
  if (supplied && canonicalJson(supplied.map(closureDigest)) !== canonicalJson(closures.map(closureDigest))) {
    throw new Error('supplied web closures differ from immutable release');
  }
  return closures;
}

async function immutableJson(backend: RegistryBackend, key: string, value: unknown): Promise<void> {
  const bytes = textEncoder.encode(canonicalJson(value));
  try { await backend.put(key, bytes, { ifAbsent: true }); }
  catch (error) {
    if (!isRegistryWriteConflict(error)) throw error;
    if (sha256(await backend.get(key)) !== sha256(bytes)) throw new Error(`immutable registry object conflict: ${key}`);
  }
}

async function updateJson<T>(backend: RegistryBackend, key: string, initial: T, update: (value: T) => T): Promise<T> {
  if (!backend.getVersioned) throw new Error('registry backend must support conditional writes');
  for (let attempt = 0; attempt < 40; attempt++) {
    const snapshot = await backend.exists(key) ? await backend.getVersioned(key) : undefined;
    if (snapshot && !snapshot.etag) throw new Error('registry backend must support conditional writes');
    const value = update(snapshot ? parseJson<T>(snapshot.bytes, key) : initial);
    try {
      await backend.put(key, textEncoder.encode(canonicalJson(value)), snapshot ? { ifMatch: snapshot.etag! } : { ifAbsent: true });
      return value;
    } catch (error) {
      if (!isRegistryWriteConflict(error)) throw error;
      await delay(Math.min(10 * (attempt + 1), 200));
    }
  }
  throw new Error(`registry conditional write retries exhausted: ${key}`);
}

function guardTarget(name: string, target: 'private' | 'public' = 'private'): void {
  if (target !== 'private' && target !== 'public') throw new Error('invalid publication target');
  if (target === 'public' && mapVisibility(name) !== 'public') throw new Error(`public registry rejects private map: ${name}`);
}

function effectiveTarget(backend: RegistryBackend, requested?: 'private' | 'public'): 'private' | 'public' {
  const url = backend.url.replace(/\/+$/, '');
  const configured = process.env.SIMFORGE_MAPS_PUBLIC_URL?.replace(/\/+$/, '');
  return /^s3:\/\/simforge-maps-public(?:\/|$)/u.test(url) || (configured !== undefined && url === configured)
    ? 'public' : requested ?? 'private';
}

export async function publishVersion(
  backend: RegistryBackend,
  input: PublishVersionInput,
): Promise<PublishedVersion> {
  validateMapName(input.name);
  guardTarget(input.name, effectiveTarget(backend, input.target));
  if (input.version && !/^v[1-9][0-9]*$/.test(input.version)) throw new Error('invalid map version');
  if (input.closure.kind !== 'canonical') throw new Error('publishVersion requires a canonical closure');
  assertClosure(input.closure);
  if ((input.derived?.length ?? 0) > 1) throw new Error('a release has at most one web closure');
  const web = input.derived?.[0];
  if (web && web.closure.kind !== 'web') throw new Error('release derivative must be web');
  await validateResourceShape(input.closure, input.files);
  if (web) await validateResourceShape(web.closure, web.files);
  const identity = sha256(canonicalJson({
    canonical: closureDigest(input.closure), web: web ? closureDigest(web.closure) : null,
    sourceRef: input.sourceRef ?? null,
  }));
  const versionsKey = `maps/${input.name}/versions.json`;
  const records = await readOptionalJson<MapVersionRecord[]>(backend, versionsKey, []);
  type Intent = { version: MapVersion; createdAt: string };
  const intents = await updateJson<Record<string, Intent>>(backend, `maps/${input.name}/intents.json`, {}, (current) => {
    if (current[identity]) {
      if (input.version && input.version !== current[identity]!.version) throw new Error('identical content already has a different immutable version');
      return current;
    }
    const version = input.version ?? nextVersion([...records, ...Object.values(current).map((intent) => ({
      ...intent, closureDigest: '',
    }))]);
    if (Object.values(current).some((intent) => intent.version === version) || records.some((record) => record.version === version)) {
      throw new Error(`${input.name}@${version} already exists with a different publication intent`);
    }
    return { ...current, [identity]: { version, createdAt: input.createdAt ?? new Date().toISOString() } };
  });
  const intent = intents[identity]!;
  const version = intent.version;
  const canonicalKey = `maps/${input.name}/${version}/closure.json`;
  const derivedKeys = web ? [derivedClosureKey(input.name, version, web.closure)] : [];
  const release: MapRelease = {
    schema: 'simforge.map-release.v1', name: input.name, version,
    visibility: mapVisibility(input.name), createdAt: intent.createdAt,
    canonical: { key: canonicalKey, digest: closureDigest(input.closure) },
    ...(web ? { web: { key: derivedKeys[0]!, digest: closureDigest(web.closure) } } : {}),
    ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
  };
  assertRelease(release);
  const uploaded = new Set<string>();
  await uploadClosureMembers(backend, input.closure, input.files, uploaded, input.concurrency ?? 8);
  if (web) await uploadClosureMembers(backend, web.closure, web.files, uploaded, input.concurrency ?? 8);
  await immutableJson(backend, canonicalKey, input.closure);
  if (web) await immutableJson(backend, derivedKeys[0]!, web.closure);
  await immutableJson(backend, `maps/${input.name}/${version}/release.json`, release);
  const record: MapVersionRecord = {
    version, closureDigest: release.canonical.digest, releaseDigest: releaseDigest(release), createdAt: release.createdAt,
    ...(input.promotedFrom === undefined ? {} : { promotedFrom: input.promotedFrom }),
    ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
  };
  await updateJson<MapVersionRecord[]>(backend, versionsKey, [], (current) => {
    const previous = current.find((item) => item.version === version);
    if (previous) {
      if (previous.releaseDigest !== record.releaseDigest) throw new Error('immutable version record conflict');
      return current;
    }
    return [...current, record].sort((a, b) => Number(a.version.slice(1)) - Number(b.version.slice(1)));
  });
  await mergeIndexEntry(backend, input.name, version, input.summary);
  return { record, derivedKeys, release };
}

export async function listMaps(backend: RegistryBackend): Promise<MapRegistryIndex> {
  return readOptionalJson<MapRegistryIndex>(backend, 'index.json', {});
}

export interface ResolvedVersion {
  name: string;
  record: MapVersionRecord;
  closure: MapClosure;
  release?: MapRelease;
}

export async function resolveVersion(
  backend: RegistryBackend,
  reference: string,
): Promise<ResolvedVersion> {
  const separator = reference.lastIndexOf('@');
  const name = separator === -1 ? reference : reference.slice(0, separator);
  validateMapName(name);
  const index = await listMaps(backend);
  const entry = index[name];
  if (entry === undefined) throw new Error(`unknown map: ${name}`);
  const version = (separator === -1 ? entry.latest : reference.slice(separator + 1)) as MapVersion;
  if (!/^v[1-9][0-9]*$/.test(version)) throw new Error(`invalid map version: ${version}`);
  const records = await readOptionalJson<MapVersionRecord[]>(backend, `maps/${name}/versions.json`, []);
  const record = records.find((candidate) => candidate.version === version);
  if (record === undefined) throw new Error(`unknown map version: ${name}@${version}`);
  const releaseKey = `maps/${name}/${version}/release.json`;
  const release = record.releaseDigest === undefined ? undefined : parseJson<MapRelease>(await backend.get(releaseKey), releaseKey);
  if (release) {
    assertRelease(release);
    if (release.name !== name || release.version !== version || releaseDigest(release) !== record.releaseDigest) throw new Error('release digest or identity mismatch');
  }
  const closureKey = release?.canonical.key ?? `maps/${name}/${version}/closure.json`;
  const closure = parseJson<MapClosure>(await backend.get(closureKey), closureKey);
  assertClosure(closure);
  if (closure.kind !== 'canonical') throw new Error('release canonical reference is not canonical');
  const actualDigest = closureDigest(closure);
  if (actualDigest !== record.closureDigest || (release && actualDigest !== release.canonical.digest)) throw new Error(`closure digest mismatch for ${name}@${version}`);
  return { name, record, closure, ...(release ? { release } : {}) };
}

async function verifyRemoteBlob(backend: RegistryBackend, memberPath: string, digest: string, bytes: number, outputPath?: string): Promise<void> {
  const hash = createHash('sha256');
  const handle = outputPath ? await open(outputPath, 'wx') : undefined;
  try {
    if (bytes === 0) {
      try {
        const empty = await backend.getRange(blobKey(digest), 0, 0);
        if (empty.byteLength !== 0) throw new Error(`registry blob verification failed for ${memberPath}`);
      } catch (error) {
        const status = (error as { statusCode?: number; $metadata?: { httpStatusCode?: number } });
        if ((status.statusCode ?? status.$metadata?.httpStatusCode) !== 416) throw error;
      }
    }
    for (let offset = 0; offset < bytes;) {
      const count = Math.min(8 * 1024 * 1024, bytes - offset);
      const chunk = await backend.getRange(blobKey(digest), offset, offset + count - (offset + count === bytes ? 0 : 1));
      if (chunk.byteLength !== count) throw new Error(`invalid bounded blob response for ${memberPath}`);
      hash.update(chunk);
      if (handle) await handle.writeFile(chunk);
      offset += count;
    }
    if (hash.digest('hex') !== digest) throw new Error(`registry blob verification failed for ${memberPath} (${digest})`);
  } finally {
    await handle?.close();
  }
}

/** Which closure members a pull profile materializes. */
type MemberFilter = (memberPath: string) => boolean;

/**
 * Ensure the blob for `member` sits in the local content-addressed cache and
 * return its path. The cache is what lets one KTX2 image land in the corpus
 * and the browser bundle (and every later version that still references it)
 * as one download and, where the filesystem allows, one inode.
 */
async function cachedBlob(
  backend: RegistryBackend,
  blobCacheRoot: string,
  memberPath: string,
  digest: string,
  bytes: number,
): Promise<string> {
  const cached = join(blobCacheRoot, 'sha256', digest.slice(0, 2), digest);
  try {
    const actual = await hashFile(cached);
    if (actual.bytes === bytes && actual.sha256 === digest) return cached;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(cached), { recursive: true });
  const temporary = `${cached}.${randomUUID()}`;
  try {
    await verifyRemoteBlob(backend, memberPath, digest, bytes, temporary);
    await rename(temporary, cached);
  } finally { await rm(temporary, { force: true }); }
  return cached;
}

/** Local installed-profile receipt, written only after every resource verifies. */
export interface MapInstallation {
  schema: 'simforge.map-installation.v1';
  name: string;
  version: MapVersion;
  releaseDigest: string;
  canonicalDigest: string;
  webDigest?: string;
  profile: 'semantic' | 'native' | 'web';
  members: MapClosure['members'];
}

async function materializeClosure(
  backend: RegistryBackend,
  closure: MapClosure,
  destination: string,
  blobCacheRoot: string,
  include: MemberFilter,
  concurrency: number,
  cached: Map<string, Promise<string>>,
  installation: Omit<MapInstallation, 'members'>,
): Promise<void> {
  if (closure.members['.map-release.json']) throw new Error('map closure uses reserved installation receipt path');
  const temporary = `${destination}.pull-${randomUUID()}`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  await boundedEach(Object.entries(closure.members), concurrency, async ([memberPath, member]) => {
    assertSafeRelativePath(memberPath);
    if (!include(memberPath)) return;
    let pending = cached.get(member.sha256);
    if (!pending) {
      pending = cachedBlob(backend, blobCacheRoot, memberPath, member.sha256, member.bytes);
      cached.set(member.sha256, pending);
    }
    const source = await pending;
    const target = join(temporary, memberPath);
    await mkdir(dirname(target), { recursive: true });
    try {
      await link(source, target);
    } catch {
      await copyFile(source, target);
    }
  });
  const members = Object.fromEntries(Object.entries(closure.members).filter(([memberPath]) => include(memberPath)));
  await writeFile(join(temporary, '.map-release.json'), `${canonicalJson({ ...installation, members })}\n`);
  await mkdir(dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
}

/** Verbatim source rasters: archive only, never needed to render. */
const isSourceImage: MemberFilter = (memberPath) => /^images\/[^/]+\.(?:png|jpe?g|webp|avif)$/i.test(memberPath);
/** The master document, its geometry buffer and every image. */
const isMasterContent: MemberFilter = (memberPath) =>
  memberPath === 'master.gltf' || memberPath === 'geometry.bin' || memberPath.startsWith('images/');

export interface PullLayouts {
  /** Web tier per map: `3d/**` cells + `images/*.ktx2`. */
  browserBundlesRoot: string;
  /** Road sidecars per map (xodr, topology, lanes, signals, reports); the full archive with `archive`. */
  devAssetsRoot: string;
  /** Native scene per map: `master.gltf` + `geometry.bin` + `images/*.ktx2` + sidecars. */
  nativeCorpusRoot: string;
  /** Content-addressed blob cache shared by every layout and version. */
  blobCacheRoot: string;
}

export interface PullOptions {
  layouts: PullLayouts;
  derivedClosures?: readonly MapClosure[];
  /** Also materialize the verbatim source rasters (`images/*.png`) under `devAssetsRoot`. */
  archive?: boolean;
  concurrency?: number;
}

export interface PullResult {
  name: string;
  version: MapVersion;
  closureDigest: string;
  releaseDigest: string;
  materialized: Record<string, string>;
  nativeWorkerInputs: Array<{
    inputId: `map.tile.${string}` | `map.resource.${string}`;
    relativePath: string;
    memberPath: string;
    materializedPath: string;
    sha256: string;
    sizeBytes: number;
  }>;
}

export async function listDerivedClosures(
  backend: RegistryBackend,
  name: string,
  version: MapVersion,
): Promise<MapClosure[]> {
  const prefix = `maps/${name}/${version}/derived`;
  const keys = await backend.list(prefix);
  const closures: MapClosure[] = [];
  for (const key of keys) {
    if (!key.endsWith('.json')) continue;
    const closure = parseJson<MapClosure>(await backend.get(key), key);
    assertClosure(closure);
    if (closure.kind === 'canonical') throw new Error(`canonical closure stored in derived path: ${key}`);
    closures.push(closure);
  }
  return closures;
}


export async function pullVersion(
  backend: RegistryBackend,
  reference: string,
  options: PullOptions,
): Promise<PullResult> {
  const resolvedVersion = await resolveVersion(backend, reference);
  const { closure, name } = resolvedVersion;
  if (!resolvedVersion.release) throw new Error(`${name} has no supported immutable release; re-ingest before pulling`);
  if (closure.metadata?.master !== true) {
    throw new Error(
      `${name}@${resolvedVersion.record.version} predates the map master format (tiled canonical closure); re-ingest it with the current pipeline`,
    );
  }
  const { layouts } = options;
  const cached = new Map<string, Promise<string>>();
  const derivedClosures = await exactDerivedClosures(backend, resolvedVersion.release, options.derivedClosures);
  const installation = {
    schema: 'simforge.map-installation.v1' as const, name, version: resolvedVersion.record.version,
    releaseDigest: resolvedVersion.record.releaseDigest!, canonicalDigest: resolvedVersion.record.closureDigest,
    ...(resolvedVersion.release.web ? { webDigest: resolvedVersion.release.web.digest } : {}),
  };
  const devDestination = join(layouts.devAssetsRoot, name);
  await materializeClosure(
    backend,
    closure,
    devDestination,
    layouts.blobCacheRoot,
    options.archive === true ? () => true : (memberPath) => !isMasterContent(memberPath),
    options.concurrency ?? 8, cached, { ...installation, profile: 'semantic' },
  );
  const nativeDestination = join(layouts.nativeCorpusRoot, name);
  await materializeClosure(backend, closure, nativeDestination, layouts.blobCacheRoot, (memberPath) => !isSourceImage(memberPath), options.concurrency ?? 8, cached, { ...installation, profile: 'native' });
  const materialized: Record<string, string> = { canonical: devDestination, native: nativeDestination };
  const nativeWorkerInputs: PullResult['nativeWorkerInputs'] = Object.entries(closure.members)
    .filter(([memberPath]) => !isSourceImage(memberPath))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([memberPath, member]) => ({
      inputId: memberPath === 'master.gltf' ? 'map.tile.000000' as const : `map.resource.${sha256(memberPath)}` as const,
      relativePath: memberPath,
      memberPath,
      materializedPath: join(nativeDestination, ...memberPath.split('/')),
      sha256: member.sha256,
      sizeBytes: member.bytes,
    }));
  if (nativeWorkerInputs.length === 0) throw new Error(`${name} master closure carries no .gltf document`);
  for (const derived of derivedClosures) {
    assertClosure(derived);
    const destination = join(layouts.browserBundlesRoot, name);
    // A browser installation is self-contained for Studio registration: web
    // geometry/textures plus the same canonical semantics used by the compiler.
    const semanticMembers = Object.fromEntries(Object.entries(closure.members).filter(([memberPath]) => !isMasterContent(memberPath)));
    for (const [memberPath, member] of Object.entries(semanticMembers)) {
      const webMember = derived.members[memberPath];
      if (webMember && (webMember.sha256 !== member.sha256 || webMember.bytes !== member.bytes)) throw new Error(`web/semantic profile conflict: ${memberPath}`);
    }
    await materializeClosure(backend, { ...derived, members: { ...semanticMembers, ...derived.members } }, destination, layouts.blobCacheRoot, () => true, options.concurrency ?? 8, cached, { ...installation, profile: 'web' });
    materialized[derived.kind] = destination;
  }
  return {
    name,
    version: resolvedVersion.record.version,
    closureDigest: resolvedVersion.record.closureDigest,
    releaseDigest: resolvedVersion.record.releaseDigest!,
    materialized,
    nativeWorkerInputs,
  };
}

export async function loadDerivedClosure(
  backend: RegistryBackend,
  name: string,
  version: MapVersion,
  kind: DerivedClosureKind,
  toolFingerprint: string,
): Promise<MapClosure> {
  const fingerprint = sha256(toolFingerprint).slice(0, 24);
  const key = `maps/${name}/${version}/derived/${kind}-${fingerprint}.json`;
  const closure = parseJson<MapClosure>(await backend.get(key), key);
  assertClosure(closure);
  return closure;
}

export interface PromoteInput {
  reference: string;
  sourceRegistry: string;
  summary?: MapSummary;
  derivedClosures?: readonly MapClosure[];
  target?: 'private' | 'public';
  blobCacheRoot?: string;
  concurrency?: number;
}

export async function promoteVersion(
  source: RegistryBackend,
  destination: RegistryBackend,
  input: PromoteInput,
): Promise<PublishedVersion> {
  const resolvedVersion = await resolveVersion(source, input.reference);
  guardTarget(resolvedVersion.name, effectiveTarget(destination, input.target));
  if (!resolvedVersion.release) throw new Error('legacy map version has no supported immutable release; re-ingest before promotion');
  const derivedClosures = await exactDerivedClosures(source, resolvedVersion.release, input.derivedClosures);
  const cache = input.blobCacheRoot ?? await mkdtemp(join(tmpdir(), 'map-promotion-'));
  try {
    const inputs: DerivedClosureInput[] = [];
    const cached = new Map<string, Promise<string>>();
    for (const closure of [resolvedVersion.closure, ...derivedClosures]) {
      const files: Record<string, string> = {};
      await boundedEach(Object.entries(closure.members), input.concurrency ?? 8, async ([memberPath, member]) => {
        let pending = cached.get(member.sha256);
        if (!pending) {
          pending = cachedBlob(source, cache, memberPath, member.sha256, member.bytes);
          cached.set(member.sha256, pending);
        }
        files[memberPath] = await pending;
      });
      inputs.push({ closure, files });
    }
    return await publishVersion(destination, {
      name: resolvedVersion.name, version: resolvedVersion.record.version,
      closure: resolvedVersion.closure, files: inputs[0]!.files, derived: inputs.slice(1),
      summary: input.summary, target: input.target, createdAt: resolvedVersion.release.createdAt,
      concurrency: input.concurrency,
      promotedFrom: `${input.sourceRegistry}/${resolvedVersion.name}@${resolvedVersion.record.version}`,
      sourceRef: resolvedVersion.release.sourceRef,
    });
  } finally {
    if (!input.blobCacheRoot) await rm(cache, { recursive: true, force: true });
  }
}

async function visitFiles(root: string, current: string, files: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await visitFiles(root, path, files);
    } else if (entry.isFile()) {
      files.push(relative(root, path).split(sep).join('/'));
    } else if (!entry.isSymbolicLink()) {
      throw new Error(`closure source contains unsupported filesystem entry: ${path}`);
    }
  }
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
      bytes += chunk.length;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), bytes };
}

export async function closureFromDirectory(
  directory: string,
  kind: MapClosure['kind'] = 'canonical',
  toolFingerprint?: string,
): Promise<DerivedClosureInput> {
  const root = resolve(directory);
  const filesInDirectory: string[] = [];
  await visitFiles(root, root, filesInDirectory);
  const members: MapClosure['members'] = {};
  const files: Record<string, string> = {};
  for (const memberPath of filesInDirectory) {
    const sourcePath = join(root, memberPath);
    members[memberPath] = await hashFile(sourcePath);
    files[memberPath] = sourcePath;
  }
  let recorded: MapClosure | undefined;
  try {
    recorded = JSON.parse(await readFile(join(dirname(root), 'closure.json'), 'utf8')) as MapClosure;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (recorded) {
    assertClosure(recorded);
    if (recorded.kind !== kind || (toolFingerprint !== undefined && recorded.toolFingerprint !== toolFingerprint)
      || canonicalJson(recorded.members) !== canonicalJson(members)) throw new Error('prebuilt_closure_changed: rebuild the source stage');
    return { closure: recorded, files };
  }
  const closure: MapClosure = {
    schema: 'map-closure.v1',
    members,
    kind,
    ...(kind === 'canonical' ? {} : { toolFingerprint: toolFingerprint ?? basename(root) }),
    ...(kind === 'canonical' && members['master.gltf'] !== undefined ? { metadata: { master: true } } : {}),
  };
  assertClosure(closure);
  return { closure, files };
}

export interface SourcePushInput {
  name: string;
  archivePath: string;
  label: string;
  date?: string;
  resumeFile?: string;
}

export async function pushSourceArchive(backend: RegistryBackend, input: SourcePushInput): Promise<string> {
  validateMapName(input.name);
  guardTarget(input.name, effectiveTarget(backend));
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.label)) throw new Error(`invalid source label: ${input.label}`);
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid source date: ${date}`);
  const archive = resolve(input.archivePath);
  const key = `sources/${input.name}/${date}-${input.label}/${basename(archive)}`;
  await backend.putFile(key, archive, { ifAbsent: true, resumeFile: input.resumeFile });
  return key;
}
