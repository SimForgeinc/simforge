/**
 * Property-ish coverage of the operation log: for a few hundred random but
 * always-legal operation sequences, undoing everything must return the document
 * to a byte-identical serialization, and redoing everything must return it to
 * the byte-identical post-sequence serialization.
 *
 * This is the invariant the whole undo design rests on — if any operation's
 * inverse patch is incomplete (a forgotten `modifiedAt`, a deleted optional key
 * that comes back as `undefined` rather than absent), one of these seeds will
 * catch it.
 */

import { describe, expect, it } from 'vitest';

import { ScenarioDocument } from '../document.js';
import type { ScenarioOp } from '../operations.js';
import { CREATED_AT, seededRandom, testOptions } from './fixtures.js';

const MAP = { mapId: 'yale-street', mapName: 'Yale Street' };
const CATALOG = ['sedan.generic', 'suv.generic', 'ped.adult', 'ped.child'];

function makeDoc(seed: number) {
  return ScenarioDocument.create(
    { name: `Fuzz ${seed}`, map: MAP, createdAt: CREATED_AT },
    testOptions(`F${seed}X`),
  );
}

/** Pick a random legal operation for the document's current state. */
function randomOp(doc: ScenarioDocument, rnd: () => number, mintId: () => string): ScenarioOp {
  const ids = doc.entities.map((e) => e.id);
  const pickId = () => ids[Math.floor(rnd() * ids.length)] as string;
  const coord = () => Math.round((rnd() * 2000 - 1000) * 1e4) / 1e4;
  const choices: Array<() => ScenarioOp> = [
    () => ({
      type: 'addEntity',
      entity: {
        id: mintId(),
        kind: rnd() < 0.5 ? 'vehicle' : 'pedestrian',
        model: { catalogId: CATALOG[Math.floor(rnd() * CATALOG.length)] as string },
        pose: { position: { x: coord(), y: 0, z: coord() }, headingRad: rnd() * 8 - 4 },
        ...(rnd() < 0.3 ? { label: `actor-${Math.floor(rnd() * 100)}` } : {}),
        ...(rnd() < 0.3
          ? {
              laneRef: {
                roadId: String(Math.floor(rnd() * 50)),
                section: 0,
                laneId: Math.floor(rnd() * 5) - 2,
                s: rnd() * 100,
                t: rnd() - 0.5,
                headingOffsetRad: 0,
              },
            }
          : {}),
      },
    }),
    () => ({ type: 'setMeta', patch: { name: `Fuzz ${Math.floor(rnd() * 1000)}` } }),
    () => ({ type: 'setMeta', patch: { description: 'x'.repeat(Math.floor(rnd() * 20)) } }),
    () => ({
      type: 'setMap',
      map: {
        mapId: `map-${Math.floor(rnd() * 3)}`,
        mapName: 'Other Map',
        ...(rnd() < 0.5 ? { xodrSha256: 'ab'.repeat(32) } : {}),
      },
    }),
  ];
  // Ops that need an existing entity.
  if (ids.length > 0) {
    choices.push(
      () => ({ type: 'removeEntity', id: pickId() }),
      () => ({
        type: 'updateEntity',
        id: pickId(),
        patch: { pose: { position: { x: coord() }, headingRad: rnd() * 8 - 4 } },
      }),
      () => ({
        type: 'updateEntity',
        id: pickId(),
        patch: { label: rnd() < 0.3 ? null : `renamed-${Math.floor(rnd() * 100)}` },
      }),
      () => ({
        type: 'updateEntity',
        id: pickId(),
        patch:
          rnd() < 0.4
            ? { dims: null }
            : { dims: { length: 3 + rnd(), width: 1 + rnd(), height: 1 + rnd() } },
      }),
      () => ({
        type: 'updateEntity',
        id: pickId(),
        patch: rnd() < 0.4 ? { laneRef: null } : { laneRef: { roadId: 'r', section: 0, laneId: -1, s: rnd() * 10 } },
      }),
      () => ({ type: 'moveEntity', id: pickId(), toIndex: Math.floor(rnd() * ids.length) }),
      () => ({
        type: 'setExtension',
        key: `tool.${Math.floor(rnd() * 3)}`,
        value: rnd() < 0.3 ? undefined : { n: Math.floor(rnd() * 10) },
      }),
    );
  }
  const chosen = choices[Math.floor(rnd() * choices.length)] as () => ScenarioOp;
  return chosen();
}

describe('random operation sequences', () => {
  const SEEDS = 40;
  const OPS_PER_SEED = 30;

  it(`undo-all restores the initial bytes across ${SEEDS} seeds`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const doc = makeDoc(seed);
      const rnd = seededRandom(seed);
      let n = 0;
      const mintId = () => `S${seed}N${String(++n).padStart(3, '0')}`;
      const initial = doc.serialize();

      const applied: number[] = [];
      for (let i = 0; i < OPS_PER_SEED; i++) {
        if (doc.apply(randomOp(doc, rnd, mintId))) applied.push(i);
      }
      const final = doc.serialize();

      let undone = 0;
      while (doc.undo()) undone++;
      expect(undone, `seed ${seed}`).toBe(applied.length);
      expect(doc.serialize(), `seed ${seed}: undo-all bytes`).toBe(initial);
      expect(doc.isDirty, `seed ${seed}: clean again`).toBe(false);

      while (doc.redo());
      expect(doc.serialize(), `seed ${seed}: redo-all bytes`).toBe(final);
    }
  });

  it('every intermediate state stays schema-valid and internally consistent', () => {
    const doc = makeDoc(99);
    const rnd = seededRandom(99);
    let n = 0;
    const mintId = () => `Q${String(++n).padStart(3, '0')}`;
    for (let i = 0; i < 200; i++) {
      doc.apply(randomOp(doc, rnd, mintId));
      const ids = doc.entities.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const entity of doc.entities) {
        expect(entity.pose.headingRad).toBeGreaterThan(-Math.PI - 1e-9);
        expect(entity.pose.headingRad).toBeLessThanOrEqual(Math.PI + 1e-9);
      }
      expect(doc.data.meta.modifiedAt >= doc.data.meta.createdAt).toBe(true);
    }
    // Validation runs on every apply, so reaching here means all 200 states parsed.
    expect(doc.history.length).toBeGreaterThan(0);
  });

  it('undo/redo cycling is idempotent', () => {
    const doc = makeDoc(7);
    const rnd = seededRandom(7);
    let n = 0;
    for (let i = 0; i < 15; i++) doc.apply(randomOp(doc, rnd, () => `C${String(++n).padStart(3, '0')}`));
    const snapshot = doc.serialize();
    for (let round = 0; round < 3; round++) {
      while (doc.undo());
      while (doc.redo());
      expect(doc.serialize()).toBe(snapshot);
    }
  });
});
