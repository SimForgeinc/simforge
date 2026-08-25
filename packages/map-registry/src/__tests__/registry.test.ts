import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileRegistryBackend,
  canonicalJson,
  closureDigest,
  closureFromDirectory,
  promoteVersion,
  publishVersion,
  pullVersion,
  sha256,
} from '../index.js';
import type { MapClosure } from '../index.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `simforge-${label}-`));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
    const backend = new FileRegistryBackend(`file://${join(root, 'registry')}`);
    await publishVersion(backend, { name: 'test-map', version: 'v1', closure: built.closure, files: built.files });
    const layouts = {
      browserBundlesRoot: join(root, 'cache', 'map-bundles'),
      devAssetsRoot: join(root, 'cache', 'dev-assets'),
      nativeCorpusRoot: join(root, 'cache', '.corpus'),
    };
    await pullVersion(backend, 'test-map@v1', { layouts });
    expect(await readFile(join(layouts.devAssetsRoot, 'test-map', 'map.xodr'))).toEqual(
      await readFile(join(source, 'map.xodr')),
    );
    expect(await readFile(join(layouts.devAssetsRoot, 'test-map', 'nested', 'manifest.json'))).toEqual(
      await readFile(join(source, 'nested', 'manifest.json')),
    );
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
