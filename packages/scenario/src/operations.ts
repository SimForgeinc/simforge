/**
 * The closed set of edits a scenario can undergo.
 *
 * Every mutation in the app goes through one of these. They are plain
 * JSON-serializable records, so the same values can later drive a command
 * palette, a collaborative transport or a scripted test — nothing here reaches
 * for a class instance or a closure.
 *
 * Patch semantics, applied uniformly:
 *
 * - `undefined` (or an absent key) means **leave alone**.
 * - `null` on an optional field means **clear it**.
 * - Nested objects (`pose`, `pose.position`, `model`) are **shallow-merged**;
 *   `laneRef`, `dims` and `extensions` are **replaced wholesale**, because a
 *   half-updated lane anchor is never what the caller meant.
 *
 * Two normalisations happen on write, in {@link applyOp} rather than in the
 * schema, so that operations built by hand get them too:
 *
 * - headings are folded into `(-π, π]` ({@link normalizeHeading});
 * - every geometric number is quantised to the serializer's precision
 *   ({@link roundFloat}, 6 decimals = 1 µm / 1 µrad).
 *
 * The second one is what makes "write to disk, read back" an exact identity
 * rather than an approximate one: the in-memory document never holds a value
 * the file cannot represent. (Numbers nested inside `extensions` are opaque to
 * this package and are only quantised at serialization time.)
 */

import { ScenarioOperationError } from './errors.js';
import {
  LaneRefSchema,
  type Dimensions,
  type Entity,
  type EntityKind,
  type Extensions,
  type LaneRef,
  type LaneRefInput,
  type MapRef,
  type ModelRef,
  type Pose,
  type ScenarioMeta,
  type ScenarioV1,
  type Vec3,
} from './schema/v1.js';
import { roundFloat } from './serialize.js';

const TAU = Math.PI * 2;

/** Quantise a coordinate to the serializer's precision. */
function q(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new ScenarioOperationError(`${field} must be finite, got ${value}`);
  }
  return roundFloat(value);
}

function quantizeLaneRef(input: LaneRefInput): LaneRef {
  const parsed = LaneRefSchema.parse(input);
  return {
    ...parsed,
    s: q(parsed.s, 'laneRef.s'),
    t: q(parsed.t, 'laneRef.t'),
    headingOffsetRad: normalizeHeading(parsed.headingOffsetRad),
  };
}

function quantizeDims(dims: Dimensions): Dimensions {
  return {
    length: q(dims.length, 'dims.length'),
    width: q(dims.width, 'dims.width'),
    height: q(dims.height, 'dims.height'),
  };
}

/**
 * Fold a heading into `(-π, π]`.
 *
 * Applied to every heading written through an operation so that "rotate right
 * 400 times" and "rotate right 40 times" serialize identically, and so
 * headings never drift into large magnitudes where float precision degrades.
 */
export function normalizeHeading(rad: number): number {
  if (!Number.isFinite(rad)) {
    throw new ScenarioOperationError(`heading must be finite, got ${rad}`);
  }
  let out = rad % TAU;
  if (out > Math.PI) out -= TAU;
  if (out <= -Math.PI) out += TAU;
  return roundFloat(out);
}

/** Entity fields accepted by `addEntity`. `id` is minted when omitted. */
export interface NewEntity {
  id?: string;
  kind: EntityKind;
  label?: string;
  model: ModelRef;
  pose: Pose;
  laneRef?: LaneRefInput;
  dims?: Dimensions;
  extensions?: Extensions;
}

/** Partial update of an entity. See the module docs for `null` vs `undefined`. */
export interface EntityPatch {
  kind?: EntityKind;
  label?: string | null;
  model?: Partial<ModelRef>;
  pose?: { position?: Partial<Vec3>; headingRad?: number };
  laneRef?: LaneRefInput | null;
  dims?: Dimensions | null;
  extensions?: Extensions | null;
}

/** Editable subset of {@link ScenarioMeta}; timestamps are managed by the document. */
export type MetaPatch = Partial<Pick<ScenarioMeta, 'name' | 'description' | 'appVersion'>>;

/** Insert an entity. `index` defaults to the end of the list. */
export interface AddEntityOp {
  type: 'addEntity';
  entity: Entity;
  index?: number;
}

/** Update fields of an existing entity. */
export interface UpdateEntityOp {
  type: 'updateEntity';
  id: string;
  patch: EntityPatch;
}

/** Remove an entity by id. */
export interface RemoveEntityOp {
  type: 'removeEntity';
  id: string;
}

/** Reorder an entity within `entities` (the outliner order). */
export interface MoveEntityOp {
  type: 'moveEntity';
  id: string;
  toIndex: number;
}

/** Update document metadata. */
export interface SetMetaOp {
  type: 'setMeta';
  patch: MetaPatch;
}

/** Repoint the scenario at a map. */
export interface SetMapOp {
  type: 'setMap';
  map: MapRef;
}

/** Set or (with `value: undefined`) delete a document-level extension key. */
export interface SetExtensionOp {
  type: 'setExtension';
  key: string;
  value?: unknown;
}

/** Every edit the document understands. */
export type ScenarioOp =
  | AddEntityOp
  | UpdateEntityOp
  | RemoveEntityOp
  | MoveEntityOp
  | SetMetaOp
  | SetMapOp
  | SetExtensionOp;

/** Short human label for an op, used as the undo-stack entry name. */
export function describeOp(op: ScenarioOp): string {
  switch (op.type) {
    case 'addEntity':
      return `Add ${op.entity.kind}`;
    case 'updateEntity':
      return 'Edit entity';
    case 'removeEntity':
      return 'Delete entity';
    case 'moveEntity':
      return 'Reorder entity';
    case 'setMeta':
      return 'Edit scenario info';
    case 'setMap':
      return 'Change map';
    case 'setExtension':
      return 'Edit extension';
  }
}

function findIndex(doc: ScenarioV1, id: string): number {
  const index = doc.entities.findIndex((e) => e.id === id);
  if (index < 0) throw new ScenarioOperationError(`no entity with id "${id}"`);
  return index;
}

/** Normalise a caller-supplied entity into the stored shape. */
export function buildEntity(input: NewEntity, id: string): Entity {
  const entity: Entity = {
    id,
    kind: input.kind,
    model: { catalogId: input.model.catalogId },
    pose: {
      position: {
        x: q(input.pose.position.x, 'pose.position.x'),
        y: q(input.pose.position.y, 'pose.position.y'),
        z: q(input.pose.position.z, 'pose.position.z'),
      },
      headingRad: normalizeHeading(input.pose.headingRad),
    },
  };
  if (input.label !== undefined) entity.label = input.label;
  if (input.laneRef !== undefined) entity.laneRef = quantizeLaneRef(input.laneRef);
  if (input.dims !== undefined) entity.dims = quantizeDims(input.dims);
  if (input.extensions !== undefined) entity.extensions = { ...input.extensions };
  return entity;
}

/**
 * Apply one operation to a mutable draft.
 *
 * Called inside `produceWithPatches`; it must mutate `draft` in place and never
 * return a value, so immer can derive the forward and inverse patches.
 *
 * @throws {ScenarioOperationError} If the op references a missing entity, a
 *   duplicate id, or an out-of-range index.
 */
export function applyOp(draft: ScenarioV1, op: ScenarioOp): void {
  switch (op.type) {
    case 'addEntity': {
      if (draft.entities.some((e) => e.id === op.entity.id)) {
        throw new ScenarioOperationError(`entity id "${op.entity.id}" already exists`);
      }
      const at = op.index ?? draft.entities.length;
      if (at < 0 || at > draft.entities.length) {
        throw new ScenarioOperationError(`index ${at} is out of range`);
      }
      // Re-run buildEntity: an op may have been constructed by hand, and the
      // stored form must always be normalised.
      draft.entities.splice(at, 0, buildEntity(op.entity, op.entity.id));
      return;
    }
    case 'removeEntity': {
      draft.entities.splice(findIndex(draft, op.id), 1);
      return;
    }
    case 'moveEntity': {
      const from = findIndex(draft, op.id);
      if (op.toIndex < 0 || op.toIndex >= draft.entities.length) {
        throw new ScenarioOperationError(`index ${op.toIndex} is out of range`);
      }
      const [moved] = draft.entities.splice(from, 1);
      draft.entities.splice(op.toIndex, 0, moved as Entity);
      return;
    }
    case 'updateEntity': {
      const entity = draft.entities[findIndex(draft, op.id)] as Entity;
      const patch = op.patch;
      if (patch.kind !== undefined) entity.kind = patch.kind;
      if (patch.label !== undefined) {
        if (patch.label === null) delete entity.label;
        else entity.label = patch.label;
      }
      if (patch.model?.catalogId !== undefined) entity.model.catalogId = patch.model.catalogId;
      if (patch.pose) {
        const p = patch.pose.position;
        if (p) {
          if (p.x !== undefined) entity.pose.position.x = q(p.x, 'pose.position.x');
          if (p.y !== undefined) entity.pose.position.y = q(p.y, 'pose.position.y');
          if (p.z !== undefined) entity.pose.position.z = q(p.z, 'pose.position.z');
        }
        if (patch.pose.headingRad !== undefined) {
          entity.pose.headingRad = normalizeHeading(patch.pose.headingRad);
        }
      }
      if (patch.laneRef !== undefined) {
        if (patch.laneRef === null) delete entity.laneRef;
        else entity.laneRef = quantizeLaneRef(patch.laneRef);
      }
      if (patch.dims !== undefined) {
        if (patch.dims === null) delete entity.dims;
        else entity.dims = quantizeDims(patch.dims);
      }
      if (patch.extensions !== undefined) {
        if (patch.extensions === null) delete entity.extensions;
        else entity.extensions = { ...patch.extensions };
      }
      return;
    }
    case 'setMeta': {
      if (op.patch.name !== undefined) draft.meta.name = op.patch.name;
      if (op.patch.description !== undefined) draft.meta.description = op.patch.description;
      if (op.patch.appVersion !== undefined) draft.meta.appVersion = op.patch.appVersion;
      return;
    }
    case 'setMap': {
      const next: MapRef = { mapId: op.map.mapId, mapName: op.map.mapName };
      if (op.map.xodrSha256 !== undefined) next.xodrSha256 = op.map.xodrSha256;
      draft.map = next;
      return;
    }
    case 'setExtension': {
      if (op.value === undefined) {
        if (draft.extensions) {
          delete draft.extensions[op.key];
          if (Object.keys(draft.extensions).length === 0) delete draft.extensions;
        }
        return;
      }
      if (!draft.extensions) draft.extensions = {};
      draft.extensions[op.key] = op.value;
      return;
    }
  }
}
