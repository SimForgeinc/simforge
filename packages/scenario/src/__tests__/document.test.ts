import { describe, expect, it, vi } from 'vitest';

import { ScenarioDocument } from '../document.js';
import { ScenarioOperationError, ScenarioValidationError } from '../errors.js';
import { normalizeHeading } from '../operations.js';
import type { NewEntity } from '../operations.js';
import { CREATED_AT, testOptions, validScenario } from './fixtures.js';

const MAP = { mapId: 'yale-street', mapName: 'Yale Street' };

function car(overrides: Partial<NewEntity> = {}): NewEntity {
  return {
    kind: 'vehicle',
    model: { catalogId: 'sedan.generic' },
    pose: { position: { x: 1, y: 0, z: 2 }, headingRad: 0 },
    ...overrides,
  };
}

function freshDoc() {
  return ScenarioDocument.create(
    { name: 'Test', map: MAP, createdAt: CREATED_AT },
    testOptions(),
  );
}

describe('create / load', () => {
  it('produces a valid, clean, empty document', () => {
    const doc = freshDoc();
    expect(doc.data.scenarioVersion).toBe(1);
    expect(doc.data.entities).toEqual([]);
    expect(doc.data.routes).toEqual([]);
    expect(doc.data.parameters).toEqual({});
    expect(doc.isDirty).toBe(false);
    expect(doc.canUndo).toBe(false);
  });

  it('seeds entities without polluting the undo history', () => {
    const doc = ScenarioDocument.create(
      { name: 'Test', map: MAP, createdAt: CREATED_AT, entities: [car(), car()] },
      testOptions(),
    );
    expect(doc.entities.map((e) => e.id)).toEqual(['E0001', 'E0002']);
    expect(doc.canUndo).toBe(false);
    expect(doc.isDirty).toBe(false);
  });

  it('rejects invalid seed data', () => {
    expect(() => ScenarioDocument.create({ name: '', map: MAP })).toThrow(ScenarioValidationError);
  });

  it('round-trips through fromJSON / serialize', () => {
    const doc = freshDoc();
    doc.addEntity(car());
    const reloaded = ScenarioDocument.parse(doc.serialize());
    expect(reloaded.data).toEqual(doc.data);
    expect(reloaded.isDirty).toBe(false);
  });

  it('freezes the exposed state', () => {
    const doc = freshDoc();
    doc.addEntity(car());
    expect(Object.isFrozen(doc.data)).toBe(true);
    expect(() => {
      (doc.data.entities[0] as { kind: string }).kind = 'pedestrian';
    }).toThrow();
  });
});

describe('operations', () => {
  it('adds, updates and removes entities', () => {
    const doc = freshDoc();
    const id = doc.addEntity(car({ label: 'Ego' }));
    expect(doc.entity(id)?.label).toBe('Ego');

    doc.updateEntity(id, { pose: { position: { x: 9 } }, label: 'Lead' });
    expect(doc.entity(id)?.pose.position).toEqual({ x: 9, y: 0, z: 2 });
    expect(doc.entity(id)?.label).toBe('Lead');

    doc.removeEntity(id);
    expect(doc.entities).toHaveLength(0);
  });

  it('clears optional fields with null and leaves them alone with undefined', () => {
    const doc = freshDoc();
    const id = doc.addEntity(
      car({ label: 'Ego', dims: { length: 4, width: 2, height: 1.5 } }),
    );
    doc.updateEntity(id, { dims: undefined });
    expect(doc.entity(id)?.dims).toEqual({ length: 4, width: 2, height: 1.5 });
    doc.updateEntity(id, { dims: null, label: null });
    expect(doc.entity(id)?.dims).toBeUndefined();
    expect('label' in doc.entity(id)!).toBe(false);
  });

  it('materialises lane-ref defaults on write', () => {
    const doc = freshDoc();
    const id = doc.addEntity(car({ laneRef: { roadId: '7', section: 0, laneId: -1, s: 12 } }));
    expect(doc.entity(id)?.laneRef).toEqual({
      roadId: '7',
      section: 0,
      laneId: -1,
      s: 12,
      t: 0,
      headingOffsetRad: 0,
    });
  });

  it('normalises headings into (-pi, pi]', () => {
    const doc = freshDoc();
    const id = doc.addEntity(car({ pose: { position: { x: 0, y: 0, z: 0 }, headingRad: 7 } }));
    expect(doc.entity(id)?.pose.headingRad).toBeCloseTo(7 - 2 * Math.PI, 5);
    doc.updateEntity(id, { pose: { headingRad: -Math.PI } });
    expect(doc.entity(id)?.pose.headingRad).toBeCloseTo(Math.PI, 5);
    expect(normalizeHeading(3 * Math.PI)).toBeCloseTo(Math.PI, 5);
    // Hand-built ops go through the same normalisation as the helper methods.
    doc.apply({
      type: 'addEntity',
      entity: {
        id: 'RAW1',
        kind: 'vehicle',
        model: { catalogId: 'sedan.generic' },
        pose: { position: { x: 0, y: 0, z: 0 }, headingRad: -3.63 },
      },
    });
    expect(doc.entity('RAW1')!.pose.headingRad).toBeCloseTo(-3.63 + 2 * Math.PI, 5);
  });

  it('quantises coordinates to the serialized precision, so save/load is exact', () => {
    const doc = freshDoc();
    const id = doc.addEntity(
      car({ pose: { position: { x: 0.1 + 0.2, y: 1 / 3, z: 0 }, headingRad: 0 } }),
    );
    expect(doc.entity(id)?.pose.position.x).toBe(0.3);
    expect(doc.entity(id)?.pose.position.y).toBe(0.333333);
    expect(ScenarioDocument.parse(doc.serialize()).data).toEqual(doc.data);
  });

  it('reorders entities', () => {
    const doc = freshDoc();
    const a = doc.addEntity(car());
    const b = doc.addEntity(car());
    doc.moveEntity(b, 0);
    expect(doc.entities.map((e) => e.id)).toEqual([b, a]);
  });

  it('sets and deletes document extensions', () => {
    const doc = freshDoc();
    doc.setExtension('studio.camera', { yaw: 1 });
    expect(doc.data.extensions).toEqual({ 'studio.camera': { yaw: 1 } });
    doc.setExtension('studio.camera', undefined);
    expect(doc.data.extensions).toBeUndefined();
  });

  it('bumps modifiedAt on every change, never createdAt', () => {
    const doc = freshDoc();
    doc.addEntity(car());
    expect(doc.data.meta.createdAt).toBe(CREATED_AT);
    const first = doc.data.meta.modifiedAt;
    doc.setMeta({ name: 'Renamed' });
    expect(doc.data.meta.modifiedAt > first).toBe(true);
  });

  it('rejects operations on unknown entities without touching state', () => {
    const doc = freshDoc();
    doc.addEntity(car());
    const before = doc.data;
    expect(() => doc.removeEntity('E9999')).toThrow(ScenarioOperationError);
    expect(doc.data).toBe(before);
    expect(doc.canUndo).toBe(true); // only the add
    expect(doc.history).toHaveLength(1);
  });

  it('rejects operations that would invalidate the document', () => {
    const doc = freshDoc();
    const before = doc.data;
    expect(() => doc.setMeta({ name: '' })).toThrow(ScenarioValidationError);
    expect(doc.data).toBe(before);
    expect(doc.canUndo).toBe(false);
  });

  it('treats a no-op as a no-op', () => {
    const doc = freshDoc();
    const id = doc.addEntity(car());
    const before = doc.data;
    expect(doc.updateEntity(id, {})).toBe(false);
    expect(doc.data).toBe(before);
    expect(doc.history).toHaveLength(1);
  });

  it('shares structure for untouched entities', () => {
    const doc = freshDoc();
    const a = doc.addEntity(car());
    doc.addEntity(car());
    const untouched = doc.entity(a);
    doc.updateEntity(doc.entities[1]!.id, { pose: { position: { x: 5 } } });
    expect(doc.entity(a)).toBe(untouched);
  });
});

describe('undo / redo', () => {
  it('restores the previous state exactly', () => {
    const doc = freshDoc();
    const before = doc.serialize();
    const id = doc.addEntity(car());
    doc.updateEntity(id, { pose: { position: { x: 42 } } });
    expect(doc.undo()).toBe(true);
    expect(doc.entity(id)?.pose.position.x).toBe(1);
    expect(doc.undo()).toBe(true);
    expect(doc.serialize()).toBe(before);
    expect(doc.undo()).toBe(false);
  });

  it('redoes forward again', () => {
    const doc = freshDoc();
    doc.addEntity(car());
    const after = doc.serialize();
    doc.undo();
    expect(doc.redo()).toBe(true);
    expect(doc.serialize()).toBe(after);
    expect(doc.redo()).toBe(false);
  });

  it('restores modifiedAt, so undo is byte-exact', () => {
    const doc = freshDoc();
    const stamp = doc.data.meta.modifiedAt;
    doc.addEntity(car());
    doc.undo();
    expect(doc.data.meta.modifiedAt).toBe(stamp);
  });

  it('drops the redo branch when a new edit lands', () => {
    const doc = freshDoc();
    doc.addEntity(car());
    doc.addEntity(car());
    doc.undo();
    doc.addEntity(car({ label: 'third' }));
    expect(doc.canRedo).toBe(false);
    expect(doc.entities.map((e) => e.label)).toEqual([undefined, 'third']);
  });

  it('exposes labels for the history UI', () => {
    const doc = freshDoc();
    doc.addEntity(car());
    doc.setMeta({ name: 'Renamed' });
    expect(doc.history).toEqual(['Add vehicle', 'Edit scenario info']);
    expect(doc.undoLabel).toBe('Edit scenario info');
    doc.undo();
    expect(doc.redoLabel).toBe('Edit scenario info');
  });

  it('bounds the history and forgets the oldest entries', () => {
    const doc = ScenarioDocument.create(
      { name: 'Test', map: MAP, createdAt: CREATED_AT },
      testOptions('E', { historyLimit: 3 }),
    );
    for (let i = 0; i < 5; i++) doc.addEntity(car());
    expect(doc.history).toHaveLength(3);
    let undone = 0;
    while (doc.undo()) undone++;
    expect(undone).toBe(3);
    expect(doc.entities).toHaveLength(2); // the two forgotten adds survive
  });

  it('clearHistory keeps state but drops the stacks', () => {
    const doc = freshDoc();
    doc.addEntity(car());
    doc.clearHistory();
    expect(doc.canUndo).toBe(false);
    expect(doc.entities).toHaveLength(1);
  });
});

describe('dirty tracking', () => {
  it('goes dirty on edit and clean on markClean', () => {
    const doc = freshDoc();
    expect(doc.isDirty).toBe(false);
    doc.addEntity(car());
    expect(doc.isDirty).toBe(true);
    doc.markClean();
    expect(doc.isDirty).toBe(false);
  });

  it('clears again when undoing back to the saved point', () => {
    const doc = freshDoc();
    doc.addEntity(car());
    doc.markClean();
    doc.setMeta({ name: 'Renamed' });
    expect(doc.isDirty).toBe(true);
    doc.undo();
    expect(doc.isDirty).toBe(false);
    doc.redo();
    expect(doc.isDirty).toBe(true);
  });

  it('stays dirty when the saved point is orphaned by a new edit', () => {
    const doc = freshDoc();
    doc.addEntity(car());
    doc.markClean();
    doc.undo();
    expect(doc.isDirty).toBe(true);
    doc.addEntity(car()); // forks the branch the clean point lived on
    doc.undo();
    expect(doc.isDirty).toBe(true);
  });

  it('stays dirty when the saved point falls off the end of the history', () => {
    const doc = ScenarioDocument.create(
      { name: 'Test', map: MAP, createdAt: CREATED_AT },
      testOptions('E', { historyLimit: 2 }),
    );
    doc.markClean();
    for (let i = 0; i < 4; i++) doc.addEntity(car());
    while (doc.undo());
    expect(doc.isDirty).toBe(true);
  });

  // The complementary case — a migrated file loads *dirty* — lives in
  // migrate.test.ts, where the migration chain can be stubbed.
  it('loads clean when the file needed no migration', () => {
    const clean = ScenarioDocument.fromJSON(validScenario());
    expect(clean.isDirty).toBe(false);
  });
});

describe('subscribe', () => {
  it('notifies on apply, undo, redo and markClean', () => {
    const doc = freshDoc();
    const seen: string[] = [];
    const off = doc.subscribe((change) => seen.push(change.reason));
    doc.addEntity(car());
    doc.undo();
    doc.redo();
    doc.markClean();
    off();
    doc.addEntity(car());
    expect(seen).toEqual(['apply', 'undo', 'redo', 'clean']);
  });

  it('hands listeners the new state, the op and the dirty flag', () => {
    const doc = freshDoc();
    const listener = vi.fn();
    doc.subscribe(listener);
    doc.addEntity(car());
    const change = listener.mock.calls[0]![0];
    expect(change.reason).toBe('apply');
    expect(change.op.type).toBe('addEntity');
    expect(change.dirty).toBe(true);
    expect(change.doc).toBe(doc.data);
  });

  it('does not fire for no-ops or failed operations', () => {
    const doc = freshDoc();
    const id = doc.addEntity(car());
    const listener = vi.fn();
    doc.subscribe(listener);
    doc.updateEntity(id, {});
    expect(() => doc.removeEntity('missing')).toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it('tolerates unsubscribing during a notification', () => {
    const doc = freshDoc();
    const other = vi.fn();
    const off = doc.subscribe(() => off());
    doc.subscribe(other);
    doc.addEntity(car());
    expect(other).toHaveBeenCalledTimes(1);
    doc.addEntity(car());
    expect(other).toHaveBeenCalledTimes(2);
  });
});
