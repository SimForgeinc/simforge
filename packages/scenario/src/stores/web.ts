/**
 * Browser-backed {@link ScenarioFileStore}.
 *
 * ## Why `localStorage` and not OPFS
 *
 * OPFS is the better long-term home for large scenarios, but for v1 it costs
 * more than it returns: sync access handles are worker-only in Safari, the
 * async API differs enough between engines to need shims, and none of it is
 * reachable from Node, so the store could not be unit-tested without a browser
 * harness. `localStorage` is synchronous, universally available, and trivially
 * fakeable — this class takes any `Storage`-shaped object, so the tests run in
 * plain Node.
 *
 * The cost is the ~5 MB origin quota. A scenario is a few KB (entities only; no
 * geometry ever lands here), so that is thousands of documents — and the moment
 * it is not enough, the real answer is the Electron `fs` adapter, not OPFS.
 * {@link ScenarioFileStore} is async precisely so that swap is invisible.
 */

import { ScenarioNotFoundError } from '../errors.js';
import { deserializeScenario } from '../migrate.js';
import type { ScenarioV1 } from '../schema/v1.js';
import { serializeScenario } from '../serialize.js';
import {
  assertValidScenarioName,
  toScenarioV1,
  type ScenarioFileEntry,
  type ScenarioFileStore,
  type ScenarioLike,
} from './types.js';

/** The slice of the DOM `Storage` interface this adapter uses. */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Default key prefix in `localStorage`. */
export const DEFAULT_STORAGE_PREFIX = 'simforge:scenario:';

/** Options for {@link WebScenarioFileStore}. */
export interface WebScenarioFileStoreOptions {
  /** Storage backend. Defaults to `globalThis.localStorage`. */
  storage?: StorageLike;
  /** Key prefix. Defaults to {@link DEFAULT_STORAGE_PREFIX}. */
  prefix?: string;
}

/** An in-memory `Storage` implementation, for tests and non-browser hosts. */
export class MemoryStorage implements StorageLike {
  readonly #map = new Map<string, string>();

  get length(): number {
    return this.#map.size;
  }

  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }

  removeItem(key: string): void {
    this.#map.delete(key);
  }
}

/** Stores canonical scenario text under `<prefix><name>` keys. */
export class WebScenarioFileStore implements ScenarioFileStore {
  readonly #storage: StorageLike;
  readonly #prefix: string;

  constructor(options: WebScenarioFileStoreOptions = {}) {
    const storage = options.storage ?? (globalThis as { localStorage?: StorageLike }).localStorage;
    if (!storage) {
      throw new Error(
        'WebScenarioFileStore: no localStorage in this environment; pass options.storage',
      );
    }
    this.#storage = storage;
    this.#prefix = options.prefix ?? DEFAULT_STORAGE_PREFIX;
  }

  #key(name: string): string {
    assertValidScenarioName(name);
    return this.#prefix + name;
  }

  #names(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.#storage.length; i++) {
      const key = this.#storage.key(i);
      if (key && key.startsWith(this.#prefix)) out.push(key.slice(this.#prefix.length));
    }
    return out.sort((a, b) => a.localeCompare(b));
  }

  async list(): Promise<ScenarioFileEntry[]> {
    return this.#names().map((name) => {
      const text = this.#storage.getItem(this.#prefix + name) ?? '';
      const entry: ScenarioFileEntry = { name, bytes: text.length };
      try {
        const parsed = JSON.parse(text) as ScenarioV1;
        entry.displayName = parsed.meta?.name;
        entry.modifiedAt = parsed.meta?.modifiedAt;
      } catch {
        // Leave the extra fields off; the name alone is enough to delete it.
      }
      return entry;
    });
  }

  async read(name: string): Promise<ScenarioV1> {
    const text = this.#storage.getItem(this.#key(name));
    if (text === null) throw new ScenarioNotFoundError(name);
    return deserializeScenario(text);
  }

  async write(name: string, doc: ScenarioLike): Promise<void> {
    this.#storage.setItem(this.#key(name), serializeScenario(toScenarioV1(doc)));
  }

  async delete(name: string): Promise<boolean> {
    const key = this.#key(name);
    if (this.#storage.getItem(key) === null) return false;
    this.#storage.removeItem(key);
    return true;
  }
}
