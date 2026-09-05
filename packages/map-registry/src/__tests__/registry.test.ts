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
  resolveVersion,
  releaseDigest,
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

  it('accepts a raced content-addressed blob only after verifying existing content', async () => {
    const digest = sha256(Buffer.from('shared'));
    const bytes = Buffer.from('shared');
    const send = vi.fn(async (command: object) => {
      if (command.constructor.name === 'PutObjectCommand') {
        throw Object.assign(new Error('precondition'), { $metadata: { httpStatusCode: 412 } });
      }
      if (command.constructor.name === 'GetObjectCommand') return { Body: bytes };
      return { ContentLength: bytes.byteLength };
    });
    // Deliberately structural fake: only the AWS client's send boundary is exercised.
    const client = { send } as unknown as ConstructorParameters<typeof S3RegistryBackend>[1];
    const backend = new S3RegistryBackend('s3://registry-test', client);
    await expect(backend.put(`blobs/sha256/${digest.slice(0, 2)}/${digest}`, bytes, { ifAbsent: true })).resolves.toBeUndefined();
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

function masterInput(payload = '') {
  const bytes = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, extras: { payload } }));
  const closure: MapClosure = {
    schema: 'map-closure.v1', kind: 'canonical', metadata: { master: true },
    members: { 'master.gltf': { sha256: sha256(bytes), bytes: bytes.byteLength } },
  };
  return { closure, files: { 'master.gltf': bytes } };
}

function emptyGlb(): Buffer {
  const json = Buffer.from('{"asset":{"version":"2.0"}}  ');
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json]);
}

describe('file registry', () => {
  it('keeps a prebuilt stage identity and rejects changed content beneath it', async () => {
    const root = await temporaryRoot('prebuilt-identity');
    const directory = join(root, 'content');
    await mkdir(directory);
    const source = masterInput();
    const recorded = { ...source.closure, metadata: { master: true, viewerOnly: true } };
    await writeFile(join(directory, 'master.gltf'), source.files['master.gltf']);
    await writeFile(join(root, 'closure.json'), canonicalJson(recorded));
    expect(closureDigest((await closureFromDirectory(directory)).closure)).toBe(closureDigest(recorded));
    await writeFile(join(directory, 'master.gltf'), masterInput('changed').files['master.gltf']);
    await expect(closureFromDirectory(directory)).rejects.toThrow('prebuilt_closure_changed');
  });

  it('publishes a master and pulls it into native, web and sidecar profiles', async () => {
    const root = await temporaryRoot('roundtrip');
    const source = join(root, 'source');
    await mkdir(join(source, 'images'), { recursive: true });
    await writeFile(join(source, 'master.gltf'), '{"asset":{"version":"2.0"}}\n');
    await writeFile(join(source, 'geometry.bin'), Buffer.from([4, 5, 6]));
    await writeFile(join(source, 'images', 'aa.png'), Buffer.from('png-bytes'));
    await writeFile(join(source, 'images', 'aa.ktx2'), Buffer.from('ktx2-bytes'));
    await writeFile(join(source, 'map.xodr'), Buffer.from([0, 1, 2, 255]));
    const built = await closureFromDirectory(source);
    expect(built.closure.metadata).toEqual({ master: true });
    const webSource = join(root, 'web');
    await mkdir(join(webSource, '3d', 'tiles'), { recursive: true });
    await mkdir(join(webSource, 'images'), { recursive: true });
    await writeFile(join(webSource, '3d', 'tiles', 'road.glb'), emptyGlb());
    await writeFile(join(webSource, '3d', 'manifest.json'), JSON.stringify({ version: '1.2.0', tiles: [], vegetationTiles: [], staticLayers: [{ file: 'tiles/road.glb' }] }));
    await writeFile(join(webSource, 'images', 'aa.ktx2'), Buffer.from('ktx2-bytes'));
    const web = await closureFromDirectory(webSource, 'web', 'web-tier-v1');
    const backend = new FileRegistryBackend(`file://${join(root, 'registry')}`);
    await publishVersion(backend, {
      name: 'test-map', version: 'v1', closure: built.closure, files: built.files,
      derived: [{ closure: web.closure, files: web.files }],
    });
    const layouts = {
      browserBundlesRoot: join(root, 'cache', 'map-bundles'),
      devAssetsRoot: join(root, 'cache', 'dev-assets'),
      nativeCorpusRoot: join(root, 'cache', '.corpus'),
      blobCacheRoot: join(root, 'cache', '.blobs'),
    };
    const result = await pullVersion(backend, 'test-map@v1', { layouts });
    // Sidecars only under dev-assets; the master content stays out of it.
    expect(await readFile(join(layouts.devAssetsRoot, 'test-map', 'map.xodr'))).toEqual(
      await readFile(join(source, 'map.xodr')),
    );
    await expect(readFile(join(layouts.devAssetsRoot, 'test-map', 'master.gltf'))).rejects.toThrow();
    // Native profile: master + geometry + KTX2 + sidecars, never the PNG.
    const nativeRoot = join(layouts.nativeCorpusRoot, 'test-map');
    expect(await readFile(join(nativeRoot, 'geometry.bin'))).toEqual(Buffer.from([4, 5, 6]));
    expect(await readFile(join(nativeRoot, 'images', 'aa.ktx2'))).toEqual(Buffer.from('ktx2-bytes'));
    expect(await readFile(join(nativeRoot, 'map.xodr'))).toEqual(Buffer.from([0, 1, 2, 255]));
    await expect(readFile(join(nativeRoot, 'images', 'aa.png'))).rejects.toThrow();
    expect(result.nativeWorkerInputs.map((item) => item.relativePath)).toEqual(['geometry.bin', 'images/aa.ktx2', 'map.xodr', 'master.gltf']);
    expect(result.nativeWorkerInputs.find((item) => item.relativePath === 'master.gltf')?.inputId).toBe('map.tile.000000');
    for (const input of result.nativeWorkerInputs) {
      expect(sha256(await readFile(input.materializedPath))).toBe(input.sha256);
    }
    // Web profile: the tier plus the shared KTX2, from the same blob.
    const webRoot = join(layouts.browserBundlesRoot, 'test-map');
    expect(await readFile(join(webRoot, '3d', 'tiles', 'road.glb'))).toEqual(emptyGlb());
    expect(await readFile(join(webRoot, 'images', 'aa.ktx2'))).toEqual(Buffer.from('ktx2-bytes'));
    expect(result.materialized).toEqual({ canonical: join(layouts.devAssetsRoot, 'test-map'), native: nativeRoot, web: webRoot });
    // Archive profile adds the source rasters under dev-assets.
    await pullVersion(backend, 'test-map@v1', { layouts, archive: true });
    expect(await readFile(join(layouts.devAssetsRoot, 'test-map', 'images', 'aa.png'))).toEqual(Buffer.from('png-bytes'));
  });

  it('refuses to pull a tiled canonical closure from before the master format', async () => {
    const root = await temporaryRoot('legacy');
    const source = join(root, 'source');
    await mkdir(join(source, '3d', 'tiles'), { recursive: true });
    await writeFile(join(source, '3d', 'tiles', 'road.glb'), Buffer.from([1]));
    const built = await closureFromDirectory(source);
    const backend = new FileRegistryBackend(`file://${join(root, 'registry')}`);
    await backend.put('maps/legacy-map/v1/closure.json', Buffer.from(canonicalJson(built.closure)));
    await backend.put('maps/legacy-map/versions.json', Buffer.from(canonicalJson([{ version: 'v1', createdAt: '2026-01-01T00:00:00Z', closureDigest: closureDigest(built.closure) }])));
    await mergeIndexEntry(backend, 'legacy-map', 'v1', {});
    expect((await resolveVersion(backend, 'legacy-map@v1')).release).toBeUndefined();
    await expect(pullVersion(backend, 'legacy-map@v1', {
      layouts: {
        browserBundlesRoot: join(root, 'browser'),
        devAssetsRoot: join(root, 'dev'),
        nativeCorpusRoot: join(root, 'native'),
        blobCacheRoot: join(root, 'blobs'),
      },
    })).rejects.toThrow('no supported immutable release');
  });

  it('fails pull when a blob is corrupt', async () => {
    const root = await temporaryRoot('corruption');
    const source = join(root, 'input.bin');
    await writeFile(source, 'correct');
    const digest = sha256(Buffer.from('correct'));
    const closure: MapClosure = {
      schema: 'map-closure.v1',
      kind: 'canonical',
      metadata: { master: true },
      members: { ...masterInput().closure.members, 'input.bin': { sha256: digest, bytes: 7 } },
    };
    const backend = new FileRegistryBackend(`file://${join(root, 'registry')}`);
    await publishVersion(backend, { name: 'corrupt-map', closure, files: { ...masterInput().files, 'input.bin': source } });
    await backend.put(`blobs/sha256/${digest.slice(0, 2)}/${digest}`, Buffer.from('broken!'));
    await expect(
      pullVersion(backend, 'corrupt-map', {
        layouts: {
          browserBundlesRoot: join(root, 'browser'),
          devAssetsRoot: join(root, 'dev'),
          nativeCorpusRoot: join(root, 'native'),
          blobCacheRoot: join(root, 'blobs'),
        },
      }),
    ).rejects.toThrow('verification failed');
  });

  it('promotion copies exactly the closure blob set', async () => {
    const root = await temporaryRoot('promote');
    const source = new FileRegistryBackend(`file://${join(root, 'internal')}`);
    const destination = new FileRegistryBackend(`file://${join(root, 'public')}`);
    const keep = masterInput().files['master.gltf'];
    const ignored = Buffer.from('not-in-closure');
    const keepDigest = sha256(keep);
    const ignoredDigest = sha256(ignored);
    const closure = masterInput().closure;
    const published = await publishVersion(source, { name: 'promoted-map', version: 'v1', closure, files: { 'master.gltf': keep } });
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
    expect((await resolveVersion(destination, 'promoted-map@v1')).record.releaseDigest).toBe(published.record.releaseDigest);
  });

  it('resumes identical content and preserves concurrent same-map versions', async () => {
    const root = await temporaryRoot('immutable');
    const backend = new FileRegistryBackend(`file://${join(root, 'registry')}`);
    const [first, second, repeated] = await Promise.all([
      publishVersion(backend, { name: 'immutable-map', ...masterInput('one') }),
      publishVersion(backend, { name: 'immutable-map', ...masterInput('two') }),
      publishVersion(backend, { name: 'immutable-map', ...masterInput('one') }),
    ]);
    expect(repeated.record.version).toBe(first.record.version);
    expect(second.record.version).not.toBe(first.record.version);
    const index = JSON.parse(Buffer.from(await backend.get('index.json')).toString());
    expect(index['immutable-map'].versions).toEqual(['v1', 'v2']);
    for (const result of [first, second]) {
      const resolved = await resolveVersion(backend, `immutable-map@${result.record.version}`);
      expect(releaseDigest(resolved.release!)).toBe(result.record.releaseDigest);
    }
  });

  it('rejects private maps in public targets and known public buckets', async () => {
    const root = await temporaryRoot('public-policy');
    const backend = new FileRegistryBackend(`file://${join(root, 'registry')}`);
    await expect(publishVersion(backend, { name: 'other-map', ...masterInput(), target: 'public' })).rejects.toThrow('public registry rejects');
    const publicBackend = new S3RegistryBackend('s3://simforge-maps-public');
    await expect(publishVersion(publicBackend, { name: 'other-map', ...masterInput() })).rejects.toThrow('public registry rejects');
    const result = await publishVersion(backend, { name: 'richmond-field-station', ...masterInput(), target: 'public' });
    expect(result.release.visibility).toBe('public');
  });

  it('rejects missing or escaping scene resources before exposing a version', async () => {
    const root = await temporaryRoot('resource-validation');
    const backend = new FileRegistryBackend(`file://${join(root, 'registry')}`);
    const bytes = Buffer.from('{"asset":{"version":"2.0"},"buffers":[{"uri":"../escape.bin","byteLength":4}]}');
    const input = masterInput();
    input.files['master.gltf'] = bytes;
    input.closure.members['master.gltf'] = { sha256: sha256(bytes), bytes: bytes.length };
    await expect(publishVersion(backend, { name: 'unsafe-map', ...input })).rejects.toThrow();
    expect(await backend.exists('index.json')).toBe(false);
  });

  it('resumes an interrupted release without making an incomplete version discoverable', async () => {
    const root = await temporaryRoot('resume');
    const backend = new FileRegistryBackend(`file://${join(root, 'registry')}`);
    const put = backend.put.bind(backend);
    let interrupt = true;
    backend.put = async (key, bytes, options) => {
      if (key.endsWith('/release.json') && interrupt) {
        interrupt = false;
        throw new Error('interrupted release commit');
      }
      await put(key, bytes, options);
    };
    const input = { name: 'resume-map', ...masterInput() };
    await expect(publishVersion(backend, input)).rejects.toThrow('interrupted release commit');
    expect(await backend.exists('index.json')).toBe(false);
    expect(await backend.exists('maps/resume-map/versions.json')).toBe(false);
    const published = await publishVersion(backend, input);
    expect(published.record.version).toBe('v1');
    expect((await resolveVersion(backend, 'resume-map')).record.releaseDigest).toBe(published.record.releaseDigest);
  });
});
