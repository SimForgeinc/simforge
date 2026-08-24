/** Browser persistence for v2 templates, including raw legacy-v1 reads for explicit migration. */

import { ScenarioNotFoundError } from '../errors.js';
import type { ScenarioTemplateV2 } from '../schema/v2/template.js';
import { serializeTemplate } from '../serialize.js';
import { assertValidScenarioName, type ScenarioFileEntry } from './types.js';
import {
  DEFAULT_STORAGE_PREFIX,
  type StorageLike,
  type WebScenarioFileStoreOptions,
} from './web.js';

export type TemplateLike = ScenarioTemplateV2 | { toJSON(): ScenarioTemplateV2 };

export interface TemplateFileStore {
  list(): Promise<ScenarioFileEntry[]>;
  /** Returns raw parsed JSON so TemplateDocument can retain migration provenance. */
  read(name: string): Promise<unknown>;
  write(name: string, doc: TemplateLike): Promise<void>;
  delete(name: string): Promise<boolean>;
}

export class WebTemplateFileStore implements TemplateFileStore {
  readonly #storage: StorageLike;
  readonly #prefix: string;

  constructor(options: WebScenarioFileStoreOptions = {}) {
    const storage = options.storage ?? (globalThis as { localStorage?: StorageLike }).localStorage;
    if (!storage) throw new Error('WebTemplateFileStore: no localStorage; pass options.storage');
    this.#storage = storage;
    this.#prefix = options.prefix ?? DEFAULT_STORAGE_PREFIX;
  }

  #key(name: string): string {
    assertValidScenarioName(name);
    return this.#prefix + name;
  }

  async list(): Promise<ScenarioFileEntry[]> {
    const names: string[] = [];
    for (let i = 0; i < this.#storage.length; i++) {
      const key = this.#storage.key(i);
      if (key?.startsWith(this.#prefix)) names.push(key.slice(this.#prefix.length));
    }
    return names.sort().map((name) => {
      const text = this.#storage.getItem(this.#prefix + name) ?? '';
      const entry: ScenarioFileEntry = { name, bytes: text.length };
      try {
        const parsed = JSON.parse(text) as { meta?: { name?: string; modifiedAt?: string } };
        entry.displayName = parsed.meta?.name;
        entry.modifiedAt = parsed.meta?.modifiedAt;
      } catch { /* Corrupt entries remain listable and deletable. */ }
      return entry;
    });
  }

  async read(name: string): Promise<unknown> {
    const text = this.#storage.getItem(this.#key(name));
    if (text === null) throw new ScenarioNotFoundError(name);
    return JSON.parse(text) as unknown;
  }

  async write(name: string, doc: TemplateLike): Promise<void> {
    const candidate = doc as { toJSON?: () => ScenarioTemplateV2 };
    const template: ScenarioTemplateV2 = typeof candidate.toJSON === 'function'
      ? candidate.toJSON()
      : doc as ScenarioTemplateV2;
    this.#storage.setItem(this.#key(name), serializeTemplate(template));
  }

  async delete(name: string): Promise<boolean> {
    const key = this.#key(name);
    if (this.#storage.getItem(key) === null) return false;
    this.#storage.removeItem(key);
    return true;
  }
}
