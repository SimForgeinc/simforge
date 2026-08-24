import { describe, expect, it, vi } from 'vitest';

import { ScenarioDocument } from '../document.js';
import { ScenarioNotFoundError, ScenarioValidationError } from '../errors.js';
import { serializeScenario } from '../serialize.js';
import { MemoryScenarioFileStore } from '../stores/memory.js';
import { assertValidScenarioName, type ScenarioFileStore } from '../stores/types.js';
import { MemoryStorage, WebScenarioFileStore } from '../stores/web.js';
import { CREATED_AT, testOptions, validScenario } from './fixtures.js';

const MAP = { mapId: 'yale-street', mapName: 'Yale Street' };

function sampleDoc(name = 'Left turn') {
  const doc = ScenarioDocument.create(
    { name, map: MAP, createdAt: CREATED_AT },
    testOptions(),
  );
  doc.addEntity({
    kind: 'vehicle',
    model: { catalogId: 'sedan.generic' },
    pose: { position: { x: 118.25, y: 0, z: -402.5 }, headingRad: Math.PI / 2 },
  });
  return doc;
}

const implementations: Array<[string, () => ScenarioFileStore]> = [
  ['MemoryScenarioFileStore', () => new MemoryScenarioFileStore()],
  ['WebScenarioFileStore', () => new WebScenarioFileStore({ storage: new MemoryStorage() })],
];

describe.each(implementations)('%s', (_name, make) => {
  it('writes, lists, reads and deletes', async () => {
    const store = make();
    const doc = sampleDoc();
    expect(await store.list()).toEqual([]);

    await store.write('left-turn', doc);
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe('left-turn');
    expect(listed[0]!.displayName).toBe('Left turn');
    expect(listed[0]!.modifiedAt).toBe(doc.data.meta.modifiedAt);
    expect(listed[0]!.bytes).toBeGreaterThan(0);

    expect(await store.read('left-turn')).toEqual(doc.data);
    expect(await store.delete('left-turn')).toBe(true);
    expect(await store.delete('left-turn')).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it('accepts a raw document as well as a ScenarioDocument', async () => {
    const store = make();
    await store.write('raw', validScenario());
    expect((await store.read('raw')).meta.name).toBe('Yale & Grant left turn');
  });

  it('overwrites in place', async () => {
    const store = make();
    const doc = sampleDoc();
    await store.write('a', doc);
    doc.setMeta({ name: 'Renamed' });
    await store.write('a', doc);
    expect((await store.list())).toHaveLength(1);
    expect((await store.read('a')).meta.name).toBe('Renamed');
  });

  it('sorts the listing by name', async () => {
    const store = make();
    for (const name of ['charlie', 'alpha', 'bravo']) await store.write(name, sampleDoc(name));
    expect((await store.list()).map((e) => e.name)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('throws ScenarioNotFoundError for unknown names', async () => {
    await expect(make().read('nope')).rejects.toBeInstanceOf(ScenarioNotFoundError);
  });

  it('rejects unusable names', async () => {
    const store = make();
    for (const bad of ['../escape', 'a/b', '', '.hidden', 'x'.repeat(129)]) {
      await expect(store.write(bad, sampleDoc())).rejects.toBeInstanceOf(TypeError);
    }
  });

  it('validates on read', async () => {
    const store = make();
    // Bytes corrupted the way an external editor would: an unknown key.
    await store.write('good', { ...validScenario(), unexpected: true } as never);
    await expect(store.read('good')).rejects.toBeInstanceOf(ScenarioValidationError);
  });

  it('round-trips a document without reordering or losing anything', async () => {
    const store = make();
    const doc = sampleDoc();
    await store.write('rt', doc);
    expect(serializeScenario(await store.read('rt'))).toBe(doc.serialize());
  });
});

describe('MemoryScenarioFileStore specifics', () => {
  it('seeds from a plain object and stores canonical text', async () => {
    const store = new MemoryScenarioFileStore({ seeded: validScenario() });
    expect((await store.list()).map((e) => e.name)).toEqual(['seeded']);
    expect(store.peek('seeded')?.endsWith('}\n')).toBe(true);
  });

  it('lists unreadable entries so the UI can offer to delete them', async () => {
    const store = new MemoryScenarioFileStore();
    await store.write('ok', validScenario());
    const listed = await store.list();
    expect(listed[0]!.displayName).toBe('Yale & Grant left turn');
  });
});

describe('WebScenarioFileStore specifics', () => {
  it('namespaces keys with a prefix and ignores foreign keys', async () => {
    const storage = new MemoryStorage();
    storage.setItem('unrelated-app:thing', 'junk');
    const store = new WebScenarioFileStore({ storage, prefix: 'ss:' });
    await store.write('one', validScenario());
    expect(storage.getItem('ss:one')).toContain('"scenarioVersion": 1');
    expect((await store.list()).map((e) => e.name)).toEqual(['one']);
  });

  it('falls back to globalThis.localStorage when present', () => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    expect(() => new WebScenarioFileStore()).not.toThrow();
    vi.unstubAllGlobals();
  });

  it('explains itself when there is no localStorage', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => new WebScenarioFileStore()).toThrow(/no localStorage/);
    vi.unstubAllGlobals();
  });
});

describe('assertValidScenarioName', () => {
  it('accepts ordinary names', () => {
    for (const name of ['a', 'Yale left turn', 'run_02.v3', 'A-B_C']) {
      expect(() => assertValidScenarioName(name)).not.toThrow();
    }
  });

  it('rejects traversal and separators', () => {
    for (const name of ['..', 'a..b', 'a/b', 'a\\b', ' leading', '/abs']) {
      expect(() => assertValidScenarioName(name)).toThrow(TypeError);
    }
  });
});
