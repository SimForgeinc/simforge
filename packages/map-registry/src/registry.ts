import { createHash } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { RegistryBackend } from './backend.js';
import {
  assertClosure,
  assertSafeRelativePath,
  canonicalJson,
  closureDigest,
  sha256,
  type DerivedClosureInput,
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


async function uploadClosureMembers(
  backend: RegistryBackend,
  closure: MapClosure,
  files: Record<string, string | Uint8Array>,
): Promise<void> {
  assertClosure(closure);
  const declaredPaths = Object.keys(closure.members).sort();
  const suppliedPaths = Object.keys(files).sort();
  if (canonicalJson(declaredPaths) !== canonicalJson(suppliedPaths)) {
    throw new Error('closure members and supplied files differ');
  }
  for (const memberPath of declaredPaths) {
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
    if (await backend.exists(key)) continue;
    if (typeof source === 'string') {
      await backend.putFile(key, source, { ifAbsent: true });
    } else {
      await backend.put(key, source, { ifAbsent: true });
    }
  }
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
}

export interface PublishedVersion {
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

export async function publishVersion(
  backend: RegistryBackend,
  input: PublishVersionInput,
): Promise<PublishedVersion> {
  validateMapName(input.name);
  if (input.closure.kind !== 'canonical') throw new Error('publishVersion requires a canonical closure');
  assertClosure(input.closure);
  const versionsKey = `maps/${input.name}/versions.json`;
  const records = await readOptionalJson<MapVersionRecord[]>(backend, versionsKey, []);
  const version = input.version ?? nextVersion(records);
  if (records.some((record) => record.version === version) || (await backend.exists(`maps/${input.name}/${version}/closure.json`))) {
    throw new Error(`${input.name}@${version} already exists`);
  }

  await uploadClosureMembers(backend, input.closure, input.files);
  for (const derived of input.derived ?? []) {
    if (derived.closure.kind === 'canonical') throw new Error('derived input cannot be canonical');
    await uploadClosureMembers(backend, derived.closure, derived.files);
  }

  const canonicalKey = `maps/${input.name}/${version}/closure.json`;
  await backend.put(canonicalKey, textEncoder.encode(canonicalJson(input.closure)), { ifAbsent: true });
  const derivedKeys: string[] = [];
  for (const derived of input.derived ?? []) {
    const key = derivedClosureKey(input.name, version, derived.closure);
    await backend.put(key, textEncoder.encode(canonicalJson(derived.closure)), { ifAbsent: true });
    derivedKeys.push(key);
  }

  const record: MapVersionRecord = {
    version,
    closureDigest: closureDigest(input.closure),
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.promotedFrom === undefined ? {} : { promotedFrom: input.promotedFrom }),
    ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
  };
  await backend.put(versionsKey, textEncoder.encode(canonicalJson([...records, record])));

  const index = await readOptionalJson<MapRegistryIndex>(backend, 'index.json', {});
  const previous = index[input.name];
  const entry: MapIndexEntry = {
    latest: version,
    versions: [...(previous?.versions ?? []), version],
    summary: input.summary ?? previous?.summary ?? {},
  };
  await backend.put('index.json', textEncoder.encode(canonicalJson({ ...index, [input.name]: entry })));
  return { record, derivedKeys };
}

export async function listMaps(backend: RegistryBackend): Promise<MapRegistryIndex> {
  return readOptionalJson<MapRegistryIndex>(backend, 'index.json', {});
}

export interface ResolvedVersion {
  name: string;
  record: MapVersionRecord;
  closure: MapClosure;
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
  const closureKey = `maps/${name}/${version}/closure.json`;
  const closure = parseJson<MapClosure>(await backend.get(closureKey), closureKey);
  assertClosure(closure);
  const actualDigest = closureDigest(closure);
  if (actualDigest !== record.closureDigest) throw new Error(`closure digest mismatch for ${name}@${version}`);
  return { name, record, closure };
}

async function verifiedBlob(backend: RegistryBackend, memberPath: string, digest: string, bytes: number): Promise<Uint8Array> {
  const content = await backend.get(blobKey(digest));
  if (content.byteLength !== bytes || sha256(content) !== digest) {
    throw new Error(`registry blob verification failed for ${memberPath} (${digest})`);
  }
  return content;
}

async function materializeClosure(
  backend: RegistryBackend,
  closure: MapClosure,
  destination: string,
): Promise<void> {
  const temporary = `${destination}.pull-${process.pid}-${Date.now()}`;
  await rm(temporary, { recursive: true, force: true });
  for (const [memberPath, member] of Object.entries(closure.members)) {
    assertSafeRelativePath(memberPath);
    const content = await verifiedBlob(backend, memberPath, member.sha256, member.bytes);
    const target = join(temporary, memberPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await mkdir(dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
}

export interface PullLayouts {
  browserBundlesRoot: string;
  devAssetsRoot: string;
  nativeCorpusRoot: string;
}

export interface PullOptions {
  layouts: PullLayouts;
  derivedClosures?: readonly MapClosure[];
}

export interface PullResult {
  name: string;
  version: MapVersion;
  closureDigest: string;
  materialized: Record<string, string>;
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
  const devDestination = join(options.layouts.devAssetsRoot, resolvedVersion.name);
  await materializeClosure(backend, resolvedVersion.closure, devDestination);
  const materialized: Record<string, string> = { canonical: devDestination };
  const derivedClosures =
    options.derivedClosures ??
    (await listDerivedClosures(backend, resolvedVersion.name, resolvedVersion.record.version));
  for (const closure of derivedClosures) {
    assertClosure(closure);
    let destination: string;
    if (closure.kind === 'browser-optimized') {
      destination = join(options.layouts.browserBundlesRoot, resolvedVersion.name);
    } else if (closure.kind === 'native-corpus') {
      destination = join(options.layouts.nativeCorpusRoot, resolvedVersion.name);
    } else {
      destination = join(options.layouts.browserBundlesRoot, resolvedVersion.name, 'ktx2');
    }
    await materializeClosure(backend, closure, destination);
    materialized[closure.kind] = destination;
  }
  return {
    name: resolvedVersion.name,
    version: resolvedVersion.record.version,
    closureDigest: resolvedVersion.record.closureDigest,
    materialized,
  };
}

export async function loadDerivedClosure(
  backend: RegistryBackend,
  name: string,
  version: MapVersion,
  kind: 'browser-optimized' | 'ktx2' | 'native-corpus',
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
}

export async function promoteVersion(
  source: RegistryBackend,
  destination: RegistryBackend,
  input: PromoteInput,
): Promise<PublishedVersion> {
  const resolvedVersion = await resolveVersion(source, input.reference);
  const files: Record<string, Uint8Array> = {};
  for (const [memberPath, member] of Object.entries(resolvedVersion.closure.members)) {
    files[memberPath] = await verifiedBlob(source, memberPath, member.sha256, member.bytes);
  }
  const derived: DerivedClosureInput[] = [];
  const derivedClosures =
    input.derivedClosures ??
    (await listDerivedClosures(source, resolvedVersion.name, resolvedVersion.record.version));
  for (const closure of derivedClosures) {
    const derivedFiles: Record<string, Uint8Array> = {};
    for (const [memberPath, member] of Object.entries(closure.members)) {
      derivedFiles[memberPath] = await verifiedBlob(source, memberPath, member.sha256, member.bytes);
    }
    derived.push({ closure, files: derivedFiles });
  }
  return publishVersion(destination, {
    name: resolvedVersion.name,
    version: resolvedVersion.record.version,
    closure: resolvedVersion.closure,
    files,
    derived,
    summary: input.summary,
    createdAt: resolvedVersion.record.createdAt,
    promotedFrom: `${input.sourceRegistry}/${resolvedVersion.name}@${resolvedVersion.record.version}`,
    sourceRef: resolvedVersion.record.sourceRef,
  });
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
  const closure: MapClosure = {
    schema: 'map-closure.v1',
    members,
    kind,
    ...(kind === 'canonical' ? {} : { toolFingerprint: toolFingerprint ?? basename(root) }),
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
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.label)) throw new Error(`invalid source label: ${input.label}`);
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid source date: ${date}`);
  const archive = resolve(input.archivePath);
  const key = `sources/${input.name}/${date}-${input.label}/${basename(archive)}`;
  await backend.putFile(key, archive, { ifAbsent: true, resumeFile: input.resumeFile });
  return key;
}
