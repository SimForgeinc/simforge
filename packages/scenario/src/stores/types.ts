/**
 * Persistence interface.
 *
 * Deliberately async and name-keyed, because the implementation that matters
 * most (the Electron `fs` adapter, later) is both. `read` returns a *validated,
 * migrated* document rather than text: every adapter therefore round-trips
 * through the canonical serializer, so a file written by one adapter is
 * readable by all of them and a corrupt store fails at the boundary rather than
 * three layers into the UI.
 */

import type { ScenarioV1 } from '../schema/v1.js';

/** Anything the store can persist: a raw document or a `ScenarioDocument`. */
export type ScenarioLike = ScenarioV1 | { toJSON(): ScenarioV1 };

/** One stored scenario, as reported by {@link ScenarioFileStore.list}. */
export interface ScenarioFileEntry {
  /** Store key, without any `.scenario.json` suffix. */
  name: string;
  /** `meta.name` from the document, for display without a full load. */
  displayName?: string;
  /** `meta.modifiedAt` from the document. */
  modifiedAt?: string;
  /** Size of the serialized text in UTF-16 code units. */
  bytes?: number;
}

/**
 * A place scenarios live.
 *
 * Implementations: `MemoryScenarioFileStore` (tests, scratch),
 * `WebScenarioFileStore` (browser `localStorage`), and — later — an Electron
 * `fs` adapter. Nothing in the interface assumes a key/value store or a
 * filesystem, so the `fs` adapter needs no changes to it.
 */
export interface ScenarioFileStore {
  /** Every stored scenario, sorted by name. */
  list(): Promise<ScenarioFileEntry[]>;
  /**
   * Load and validate one scenario.
   *
   * @throws {ScenarioNotFoundError} If the name is unknown.
   * @throws {ScenarioValidationError} If the stored bytes are not a valid scenario.
   */
  read(name: string): Promise<ScenarioV1>;
  /** Write (or overwrite) one scenario in canonical form. */
  write(name: string, doc: ScenarioLike): Promise<void>;
  /**
   * Remove one scenario.
   *
   * @returns True if something was removed.
   */
  delete(name: string): Promise<boolean>;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;

/**
 * Guard a store key.
 *
 * Names are used as filesystem names by the Electron adapter, so path
 * separators, leading dots and `..` are rejected here rather than in each
 * implementation.
 *
 * @throws {TypeError} If the name is unusable.
 */
export function assertValidScenarioName(name: string): void {
  if (!NAME_PATTERN.test(name) || name.includes('..')) {
    throw new TypeError(
      `invalid scenario name "${name}": use 1-128 chars of [A-Za-z0-9 ._-], starting alphanumeric, with no ".."`,
    );
  }
}

/** Normalise {@link ScenarioLike} to a plain document. */
export function toScenarioV1(doc: ScenarioLike): ScenarioV1 {
  return 'toJSON' in doc && typeof doc.toJSON === 'function' ? doc.toJSON() : (doc as ScenarioV1);
}
