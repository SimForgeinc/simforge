/**
 * The mutable scenario document: operation log, undo/redo, dirty tracking and
 * change notification.
 *
 * The state itself is an immutable, deep-frozen {@link ScenarioV1}. Every edit
 * runs through immer's `produceWithPatches`, which yields the next state plus a
 * forward and an inverse patch set; the inverse sets *are* the undo stack. That
 * buys three things a hand-rolled command pattern does not: undo entries cost
 * bytes rather than whole document copies, structural sharing makes
 * `prev.entities[i] === next.entities[i]` true for untouched entities (so a
 * future React layer can memo on identity), and no operation can forget to
 * write its own inverse.
 *
 * Nothing here imports a framework. `subscribe()` is a plain callback set;
 * binding it to React/Vue/whatever is the caller's job.
 */

import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';

import { ScenarioValidationError, toScenarioIssues } from './errors.js';
import { newId as mintId } from './ids.js';
import { migrate } from './migrate.js';
import {
  applyOp,
  buildEntity,
  describeOp,
  type EntityPatch,
  type MetaPatch,
  type NewEntity,
  type ScenarioOp,
} from './operations.js';
import {
  ScenarioV1Schema,
  SCENARIO_VERSION,
  type Entity,
  type MapRef,
  type ScenarioV1,
} from './schema/v1.js';
import { deepFreeze, serializeScenario } from './serialize.js';

enablePatches();

/** Default history depth. Roughly a full editing session; ~1 KB of patches. */
export const DEFAULT_HISTORY_LIMIT = 200;

/** `meta.appVersion` used when the caller does not supply one. */
export const DEFAULT_APP_VERSION = '0.0.0-dev';

/** Why {@link ScenarioDocument.subscribe} fired. */
export type ScenarioChangeReason = 'apply' | 'undo' | 'redo' | 'clean';

/** Payload handed to subscribers. */
export interface ScenarioChange {
  /** The document after the change. */
  doc: ScenarioV1;
  reason: ScenarioChangeReason;
  /** The operation, for `apply` / `undo` / `redo`. */
  op?: ScenarioOp;
  /** Dirty flag after the change, so listeners need not re-read it. */
  dirty: boolean;
}

/** Construction-time knobs. All injectable so tests are deterministic. */
export interface ScenarioDocumentOptions {
  /** Max undo entries kept. Older entries are dropped from the front. Default {@link DEFAULT_HISTORY_LIMIT}. */
  historyLimit?: number;
  /** ISO-timestamp source for `meta.modifiedAt`. Default `() => new Date().toISOString()`. */
  now?: () => string;
  /** Entity id factory. Default: ULIDs. */
  newId?: () => string;
  /**
   * Validate after every operation. Default `true`. Turning it off is only
   * sensible for bulk imports that validate once at the end.
   */
  validate?: boolean;
}

/** Fields needed to start a new scenario. */
export interface CreateScenarioInit {
  name: string;
  map: MapRef;
  description?: string;
  appVersion?: string;
  /** Entities to seed the document with. They do not enter the undo history. */
  entities?: NewEntity[];
  /** Override `meta.createdAt` (and the initial `modifiedAt`). */
  createdAt?: string;
}

interface HistoryEntry {
  label: string;
  op: ScenarioOp;
  patches: Patch[];
  inverse: Patch[];
}

function validateOrThrow(doc: ScenarioV1, context: string): void {
  const result = ScenarioV1Schema.safeParse(doc);
  if (!result.success) {
    throw new ScenarioValidationError(
      `${context} would produce an invalid document`,
      toScenarioIssues(result.error.issues),
    );
  }
}

/**
 * A scenario plus its edit history.
 *
 * @example
 * ```ts
 * const doc = ScenarioDocument.create({
 *   name: 'Unprotected left',
 *   map: { mapId: 'yale-street', mapName: 'Yale Street' },
 * });
 * const id = doc.addEntity({
 *   kind: 'vehicle',
 *   model: { catalogId: 'sedan.generic' },
 *   pose: { position: { x: 12, y: 0, z: -40 }, headingRad: Math.PI / 2 },
 * });
 * doc.updateEntity(id, { pose: { position: { x: 14 } } });
 * doc.undo();
 * await store.write('unprotected-left', doc);
 * ```
 */
export class ScenarioDocument {
  #state: ScenarioV1;
  #history: HistoryEntry[] = [];
  /** Number of history entries currently applied; the undo cursor. */
  #index = 0;
  /** `#index` at the last save. `null` once that point has been trimmed away. */
  #cleanIndex: number | null = 0;
  readonly #listeners = new Set<(change: ScenarioChange) => void>();
  readonly #historyLimit: number;
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly #validate: boolean;

  private constructor(state: ScenarioV1, options: ScenarioDocumentOptions = {}) {
    this.#historyLimit = Math.max(0, options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? (() => mintId());
    this.#validate = options.validate ?? true;
    this.#state = deepFreeze(state);
  }

  /**
   * Start a new scenario.
   *
   * @throws {ScenarioValidationError} If the seed data is invalid.
   */
  static create(init: CreateScenarioInit, options: ScenarioDocumentOptions = {}): ScenarioDocument {
    const now = options.now ?? (() => new Date().toISOString());
    const mint = options.newId ?? (() => mintId());
    const createdAt = init.createdAt ?? now();
    const draft: ScenarioV1 = {
      scenarioVersion: SCENARIO_VERSION,
      meta: {
        name: init.name,
        description: init.description ?? '',
        createdAt,
        modifiedAt: createdAt,
        appVersion: init.appVersion ?? DEFAULT_APP_VERSION,
      },
      map: { ...init.map },
      entities: (init.entities ?? []).map((e) => buildEntity(e, e.id ?? mint())),
      routes: [],
      triggers: [],
      lightPrograms: [],
      parameters: {},
    };
    validateOrThrow(draft, 'create');
    return new ScenarioDocument(draft, options);
  }

  /**
   * Load a parsed `.scenario.json`, migrating it forward if needed.
   *
   * The returned document starts clean unless a migration ran — a migrated
   * document differs from the bytes on disk, so it is dirty by construction.
   */
  static fromJSON(json: unknown, options: ScenarioDocumentOptions = {}): ScenarioDocument {
    const { doc, migrated } = migrate(json);
    const instance = new ScenarioDocument(doc, options);
    if (migrated) instance.#cleanIndex = null;
    return instance;
  }

  /** Load `.scenario.json` text. See {@link ScenarioDocument.fromJSON}. */
  static parse(text: string, options: ScenarioDocumentOptions = {}): ScenarioDocument {
    return ScenarioDocument.fromJSON(JSON.parse(text), options);
  }

  /** The current document. Deep-frozen: mutate it through operations only. */
  get data(): ScenarioV1 {
    return this.#state;
  }

  /** Entities in outliner order. */
  get entities(): readonly Entity[] {
    return this.#state.entities;
  }

  /** True when the document differs from the last {@link markClean} point. */
  get isDirty(): boolean {
    return this.#cleanIndex !== this.#index;
  }

  /** True when {@link undo} would do something. */
  get canUndo(): boolean {
    return this.#index > 0;
  }

  /** True when {@link redo} would do something. */
  get canRedo(): boolean {
    return this.#index < this.#history.length;
  }

  /** Labels of the undoable entries, oldest first. Handy for a history panel. */
  get history(): readonly string[] {
    return this.#history.slice(0, this.#index).map((e) => e.label);
  }

  /** Label of the next {@link undo}, if any. */
  get undoLabel(): string | undefined {
    return this.canUndo ? this.#history[this.#index - 1]?.label : undefined;
  }

  /** Label of the next {@link redo}, if any. */
  get redoLabel(): string | undefined {
    return this.canRedo ? this.#history[this.#index]?.label : undefined;
  }

  /** Look up an entity by id. */
  entity(id: string): Entity | undefined {
    return this.#state.entities.find((e) => e.id === id);
  }

  /**
   * Apply one operation, recording it in the undo history.
   *
   * A no-op (an operation whose patch set is empty) is not recorded and does
   * not touch `modifiedAt` or the dirty flag.
   *
   * @returns True if the document changed.
   * @throws {ScenarioOperationError} If the op is not applicable.
   * @throws {ScenarioValidationError} If the result would be invalid. The
   *   document is left untouched in both cases.
   */
  apply(op: ScenarioOp): boolean {
    const [afterOp, opPatches, opInverse] = produceWithPatches(this.#state, (draft) => {
      applyOp(draft as ScenarioV1, op);
    });
    if (opPatches.length === 0) return false;

    const stamp = this.#now();
    const [next, stampPatches, stampInverse] = produceWithPatches(afterOp, (draft) => {
      draft.meta.modifiedAt = stamp;
    });

    if (this.#validate) validateOrThrow(next, `operation "${op.type}"`);

    this.#push({
      label: describeOp(op),
      op,
      patches: [...opPatches, ...stampPatches],
      // Inverses undo in reverse order of application.
      inverse: [...stampInverse, ...opInverse],
    });
    this.#state = next;
    this.#emit({ doc: next, reason: 'apply', op, dirty: this.isDirty });
    return true;
  }

  /**
   * Add an entity.
   *
   * @param input Entity fields; `id` is minted when omitted.
   * @param index Insertion point in the outliner. Defaults to the end.
   * @returns The entity id.
   */
  addEntity(input: NewEntity, index?: number): string {
    const entity = buildEntity(input, input.id ?? this.#newId());
    const op: ScenarioOp =
      index === undefined
        ? { type: 'addEntity', entity }
        : { type: 'addEntity', entity, index };
    this.apply(op);
    return entity.id;
  }

  /** Patch an existing entity. See {@link EntityPatch} for `null` semantics. */
  updateEntity(id: string, patch: EntityPatch): boolean {
    return this.apply({ type: 'updateEntity', id, patch });
  }

  /** Delete an entity. */
  removeEntity(id: string): boolean {
    return this.apply({ type: 'removeEntity', id });
  }

  /** Move an entity within the outliner order. */
  moveEntity(id: string, toIndex: number): boolean {
    return this.apply({ type: 'moveEntity', id, toIndex });
  }

  /** Patch document metadata. Timestamps are managed for you. */
  setMeta(patch: MetaPatch): boolean {
    return this.apply({ type: 'setMeta', patch });
  }

  /** Repoint the scenario at a (different) map. */
  setMap(map: MapRef): boolean {
    return this.apply({ type: 'setMap', map });
  }

  /** Set a document-level extension key, or delete it by passing `undefined`. */
  setExtension(key: string, value?: unknown): boolean {
    return this.apply({ type: 'setExtension', key, value });
  }

  /**
   * Revert the most recent operation.
   *
   * @returns True if something was undone.
   */
  undo(): boolean {
    if (!this.canUndo) return false;
    const entry = this.#history[this.#index - 1] as HistoryEntry;
    this.#state = deepFreeze(applyPatches(this.#state, entry.inverse));
    this.#index -= 1;
    this.#emit({ doc: this.#state, reason: 'undo', op: entry.op, dirty: this.isDirty });
    return true;
  }

  /**
   * Re-apply the most recently undone operation.
   *
   * @returns True if something was redone.
   */
  redo(): boolean {
    if (!this.canRedo) return false;
    const entry = this.#history[this.#index] as HistoryEntry;
    this.#state = deepFreeze(applyPatches(this.#state, entry.patches));
    this.#index += 1;
    this.#emit({ doc: this.#state, reason: 'redo', op: entry.op, dirty: this.isDirty });
    return true;
  }

  /**
   * Mark the current state as saved. {@link isDirty} goes false, and undoing
   * back to this point clears it again.
   */
  markClean(): void {
    this.#cleanIndex = this.#index;
    this.#emit({ doc: this.#state, reason: 'clean', dirty: false });
  }

  /** Drop all undo/redo entries, keeping the current state. */
  clearHistory(): void {
    this.#history = [];
    this.#index = 0;
    this.#cleanIndex = 0;
  }

  /**
   * Listen for changes.
   *
   * @returns An unsubscribe function. Safe to call during a notification.
   */
  subscribe(listener: (change: ScenarioChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The document, for `JSON.stringify`. Prefer {@link serialize} for files. */
  toJSON(): ScenarioV1 {
    return this.#state;
  }

  /** Canonical `.scenario.json` text. See `serialize.ts` for the guarantees. */
  serialize(): string {
    return serializeScenario(this.#state);
  }

  #push(entry: HistoryEntry): void {
    this.#history.length = this.#index; // a new edit forks the redo branch away
    if (this.#cleanIndex !== null && this.#cleanIndex > this.#index) this.#cleanIndex = null;
    this.#history.push(entry);
    this.#index += 1;
    const overflow = this.#history.length - this.#historyLimit;
    if (overflow > 0) {
      this.#history.splice(0, overflow);
      this.#index -= overflow;
      if (this.#cleanIndex !== null) {
        this.#cleanIndex -= overflow;
        // The saved point fell off the back of the history: it is no longer
        // reachable by undo, so the document can never prove it is clean again.
        if (this.#cleanIndex < 0) this.#cleanIndex = null;
      }
    }
  }

  #emit(change: ScenarioChange): void {
    for (const listener of [...this.#listeners]) listener(change);
  }
}
