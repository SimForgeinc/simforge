import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileRegistryBackend,
  S3RegistryBackend,
  canonicalJson,
  closureDigest,
  closureFromDirectory,
  promoteVersion,
  mergeIndexEntry,
  publishVersion,
  pullVersion,
  sha256,
} from '../index.js';
import type { MapClosure, PutOptions, RegistryBackend, VersionedObject } from '../index.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `simforge-${label}-`));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class ConflictBackend implements RegistryBackend {
  readonly url = 'memory://registry';
  readonly objects = new Map<string, Uint8Array>();
  private revision = 0;

  constructor(private conflictsRemaining: number) {}

  async get(key: string): Promise<Uint8Array> {
    const bytes = this.objects.get(key);
    if (bytes === undefined) throw Object.assign(new Error('missing'), { statusCode: 404 });
    return bytes;
  }

  async getVersioned(key: string): Promise<VersionedObject> {
    return { bytes: await this.get(key), etag: String(this.revision) };
  }

  async getRange(key: string, start: number, endInclusive?: number): Promise<Uint8Array> {
    return (await this.get(key)).slice(start, endInclusive === undefined ? undefined : endInclusive + 1);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async put(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<void> {
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      throw Object.assign(new Error('precondition'), { $metadata: { httpStatusCode: 412 } });
    }
    if (options.ifAbsent && this.objects.has(key)) {
      throw Object.assign(new Error('precondition'), { $metadata: { httpStatusCode: 412 } });
    }
    if (options.ifMatch !== undefined && options.ifMatch !== String(this.revision)) {
      throw Object.assign(new Error('precondition'), { $metadata: { httpStatusCode: 412 } });
    }
    this.objects.set(key, bytes);
    this.revision += 1;
  }

  async putFile(): Promise<void> {
    throw new Error('not used');
  }
}

describe('concurrent registry writes', () => {
  it('re-reads and additively merges index entries after conditional conflicts', async () => {
    const backend = new ConflictBackend(2);
    await Promise.all([
      mergeIndexEntry(backend, 'alpha-map', 'v1', { label: 'Alpha' }, { sleep: async () => undefined, random: () => 0 }),
      mergeIndexEntry(backend, 'beta-map', 'v1', { label: 'Beta' }, { sleep: async () => undefined, random: () => 0 }),
    ]);
    const index = JSON.parse(new TextDecoder().decode(await backend.get('index.json')));
    expect(Object.keys(index).sort()).toEqual(['alpha-map', 'beta-map']);
  });

  it('surfaces an exhausted index retry cap', async () => {
    const backend = new ConflictBackend(10);
    await expect(mergeIndexEntry(
      backend,
      'blocked-map',
      'v1',
      undefined,
      { maxAttempts: 3, sleep: async () => undefined, random: () => 0 },
    )).rejects.toThrow('exhausted 3 attempts');
    expect(await backend.exists('index.json')).toBe(false);
  });

  it('treats a raced content-addressed blob put as success only at matching length', async () => {
    const digest = 'a'.repeat(64);
    const bytes = Buffer.from('shared');
    const send = vi.fn(async (command: object) => {
      if (command.constructor.name === 'PutObjectCommand') {
        throw Object.assign(new Error('precondition'), { $metadata: { httpStatusCode: 412 } });
      }
      return { ContentLength: bytes.byteLength };
    });
    // Deliberately structural fake: only the AWS client's send boundary is exercised.
    const client = { send } as unknown as ConstructorParameters<typeof S3RegistryBackend>[1];
    const backend = new S3RegistryBackend('s3://registry-test', client);
    await expect(backend.put(`blobs/sha256/aa/${digest}`, bytes, { ifAbsent: true })).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects a raced blob whose existing length disagrees', async () => {
    const digest = 'b'.repeat(64);
    const send = vi.fn(async (command: object) => {
      if (command.constructor.name === 'PutObjectCommand') {
        throw Object.assign(new Error('precondition'), { $metadata: { httpStatusCode: 412 } });
      }
      return { ContentLength: 999 };
    });
    // Deliberately structural fake: only the AWS client's send boundary is exercised.
    const client = { send } as unknown as ConstructorParameters<typeof S3RegistryBackend>[1];
    const backend = new S3RegistryBackend('s3://registry-test', client);
    await expect(backend.put(`blobs/sha256/bb/${digest}`, Buffer.from('shared'), { ifAbsent: true }))
      .rejects.toThrow('content-addressed blob collision');
  });
});

describe('canonical registry schema', () => {
  it('canonicalizes object keys recursively before digesting', () => {
    const left: MapClosure = {
      members: { 'b.bin': { bytes: 2, sha256: 'b'.repeat(64) }, 'a.bin': { sha256: 'a'.repeat(64), bytes: 1 } },
      kind: 'canonical',
      schema: 'map-closure.v1',
    };
    const right: MapClosure = {
      schema: 'map-closure.v1',
      kind: 'canonical',
      members: { 'a.bin': { bytes: 1, sha256: 'a'.repeat(64) }, 'b.bin': { sha256: 'b'.repeat(64), bytes: 2 } },
    };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(closureDigest(left)).toBe(closureDigest(right));
  });
});

describe('file registry', () => {
  it('publishes and pulls a byte-identical directory', async () => {
    const root = await temporaryRoot('roundtrip');
    const source = join(root, 'source');
    await mkdir(join(source, 'nested'), { recursive: true });
    await writeFile(join(source, 'map.xodr'), Buffer.from([0, 1, 2, 255]));
    await writeFile(join(source, 'nested', 'manifest.json'), '{"map":"test"}\n');
    const built = await closureFromDirectory(source);
    const nativeSource = join(root, 'native');
    await mkdir(join(nativeSource, 'tiles'), { recursive: true });
    await writeFile(join(nativeSource, 'tiles', 'road.glb'), Buffer.from([4, 5, 6]));
    await writeFile(join(nativeSource, 'scene-manifest.json'), '{}\n');
    const native = await closureFromDirectory(nativeSource, 'native-corpus', 'decoder-v1');
    const backend = new FileRegistryBackend(`file://${join(root, 'registry')}`);
    await publishVersion(backend, {
      name: 'test-map', version: 'v1', closure: built.closure, files: built.files,
      derived: [{ closure: native.closure, files: native.files }],
    });
    const layouts = {
      browserBundlesRoot: join(root, 'cache', 'map-bundles'),
      devAssetsRoot: join(root, 'cache', 'dev-assets'),
      nativeCorpusRoot: join(root, 'cache', '.corpus'),
    };
    const result = await pullVersion(backend, 'test-map@v1', { layouts });
    expect(await readFile(join(layouts.devAssetsRoot, 'test-map', 'map.xodr'))).toEqual(
      await readFile(join(source, 'map.xodr')),
    );
    expect(await readFile(join(layouts.devAssetsRoot, 'test-map', 'nested', 'manifest.json'))).toEqual(
      await readFile(join(source, 'nested', 'manifest.json')),
    );
    expect(result.nativeWorkerInputs).toEqual([{
      inputId: 'map.tile.000000',
      memberPath: 'tiles/road.glb',
      materializedPath: join(layouts.nativeCorpusRoot, 'test-map', 'tiles', 'road.glb'),
      sha256: sha256(Buffer.from([4, 5, 6])),
      sizeBytes: 3,
    }]);
  });

  it('fails pull when a blob is corrupt', async () => {
    const root = await temporaryRoot('corruption');
    const source = join(root, 'input.bin');
    await writeFile(source, 'correct');
    const digest = sha256(Buffer.from('correct'));
    const closure: MapClosure = {
      schema: 'map-closure.v1',
      kind: 'canonical',
      members: { 'input.bin': { sha256: digest, bytes: 7 } },
    };
    const backend = new FileRegistryBackend(`file://${join(root, 'registry')}`);
    await publishVersion(backend, { name: 'corrupt-map', closure, files: { 'input.bin': source } });
    await backend.put(`blobs/sha256/${digest.slice(0, 2)}/${digest}`, Buffer.from('broken!'));
    await expect(
      pullVersion(backend, 'corrupt-map', {
        layouts: {
          browserBundlesRoot: join(root, 'browser'),
          devAssetsRoot: join(root, 'dev'),
          nativeCorpusRoot: join(root, 'native'),
        },
      }),
    ).rejects.toThrow('verification failed');
  });

  it('promotion copies exactly the closure blob set', async () => {
    const root = await temporaryRoot('promote');
    const source = new FileRegistryBackend(`file://${join(root, 'internal')}`);
    const destination = new FileRegistryBackend(`file://${join(root, 'public')}`);
    const keep = Buffer.from('kept');
    const ignored = Buffer.from('not-in-closure');
    const keepDigest = sha256(keep);
    const ignoredDigest = sha256(ignored);
    const closure: MapClosure = {
      schema: 'map-closure.v1',
      kind: 'canonical',
      members: { 'keep.bin': { sha256: keepDigest, bytes: keep.byteLength } },
    };
    await publishVersion(source, { name: 'promoted-map', version: 'v1', closure, files: { 'keep.bin': keep } });
    await source.put(`blobs/sha256/${ignoredDigest.slice(0, 2)}/${ignoredDigest}`, ignored);
    await promoteVersion(source, destination, {
      reference: 'promoted-map@v1',
      sourceRegistry: source.url,
    });
    const prefixes = await readdir(join(destination.root, 'blobs', 'sha256'));
    expect(prefixes).toEqual([keepDigest.slice(0, 2)]);
    expect(await destination.exists(`blobs/sha256/${keepDigest.slice(0, 2)}/${keepDigest}`)).toBe(true);
    expect(await destination.exists(`blobs/sha256/${ignoredDigest.slice(0, 2)}/${ignoredDigest}`)).toBe(false);
    const versions = JSON.parse(await readFile(join(destination.root, 'maps', 'promoted-map', 'versions.json'), 'utf8'));
    expect(versions[0].promotedFrom).toBe(`${source.url}/promoted-map@v1`);
  });

  it('does not allow an existing version to be published again', async () => {
    const root = await temporaryRoot('immutable');
    const backend = new FileRegistryBackend(`file://${join(root, 'registry')}`);
    const bytes = Buffer.from('one');
    const closure: MapClosure = {
      schema: 'map-closure.v1',
      kind: 'canonical',
      members: { 'one.bin': { sha256: sha256(bytes), bytes: bytes.byteLength } },
    };
    await publishVersion(backend, { name: 'immutable-map', version: 'v1', closure, files: { 'one.bin': bytes } });
    await expect(
      publishVersion(backend, { name: 'immutable-map', version: 'v1', closure, files: { 'one.bin': bytes } }),
    ).rejects.toThrow('already exists');
  });
});
