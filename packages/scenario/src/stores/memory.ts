/** In-memory {@link ScenarioFileStore}, for tests and scratch documents. */

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

/**
 * Keeps canonical text in a `Map`.
 *
 * Text rather than live objects on purpose: it round-trips through the real
 * serializer, so tests against this store exercise the same code path the disk
 * adapters do and cannot accidentally share mutable state with the caller.
 */
export class MemoryScenarioFileStore implements ScenarioFileStore {
  readonly #files = new Map<string, string>();

  /** @param seed Optional initial contents, keyed by scenario name. */
  constructor(seed?: Record<string, ScenarioLike>) {
    for (const [name, doc] of Object.entries(seed ?? {})) {
      assertValidScenarioName(name);
      this.#files.set(name, serializeScenario(toScenarioV1(doc)));
    }
  }

  async list(): Promise<ScenarioFileEntry[]> {
    return [...this.#files.entries()]
      .map(([name, text]) => {
        const entry: ScenarioFileEntry = { name, bytes: text.length };
        try {
          const parsed = JSON.parse(text) as ScenarioV1;
          entry.displayName = parsed.meta?.name;
          entry.modifiedAt = parsed.meta?.modifiedAt;
        } catch {
          // Unreadable entries still list, so the UI can offer to delete them.
        }
        return entry;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(name: string): Promise<ScenarioV1> {
    assertValidScenarioName(name);
    const text = this.#files.get(name);
    if (text === undefined) throw new ScenarioNotFoundError(name);
    return deserializeScenario(text);
  }

  async write(name: string, doc: ScenarioLike): Promise<void> {
    assertValidScenarioName(name);
    this.#files.set(name, serializeScenario(toScenarioV1(doc)));
  }

  async delete(name: string): Promise<boolean> {
    assertValidScenarioName(name);
    return this.#files.delete(name);
  }

  /** The raw stored text, for assertions. Not part of {@link ScenarioFileStore}. */
  peek(name: string): string | undefined {
    return this.#files.get(name);
  }
}
