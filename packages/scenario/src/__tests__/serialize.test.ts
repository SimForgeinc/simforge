import { describe, expect, it } from 'vitest';

import { ScenarioDocument } from '../document.js';
import { deserializeScenario } from '../migrate.js';
import { canonicalize, roundFloat, serializeScenario, FLOAT_DECIMALS } from '../serialize.js';
import { CREATED_AT, testOptions, validScenario } from './fixtures.js';

describe('roundFloat', () => {
  it(`keeps ${FLOAT_DECIMALS} decimals and is idempotent`, () => {
    expect(roundFloat(0.1 + 0.2)).toBe(0.3);
    expect(roundFloat(1.23456789)).toBe(1.234568);
    expect(roundFloat(roundFloat(1.23456789))).toBe(roundFloat(1.23456789));
    expect(roundFloat(118.2500001)).toBe(118.25);
  });

  it('normalises -0 and passes integers through', () => {
    expect(Object.is(roundFloat(-0), 0)).toBe(true);
    expect(Object.is(roundFloat(-1e-9), 0)).toBe(true);
    expect(roundFloat(1234567)).toBe(1234567);
  });

  it('refuses non-finite values', () => {
    expect(() => roundFloat(Number.NaN)).toThrow(TypeError);
    expect(() => roundFloat(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('canonicalize', () => {
  it('sorts object keys recursively but preserves array order', () => {
    const out = canonicalize({ b: 1, a: { d: 2, c: 3 }, list: [{ z: 1, y: 2 }, 'first'] });
    expect(JSON.stringify(out)).toBe('{"a":{"c":3,"d":2},"b":1,"list":[{"y":2,"z":1},"first"]}');
  });

  it('drops undefined properties and keeps nulls', () => {
    expect(JSON.stringify(canonicalize({ a: undefined, b: null }))).toBe('{"b":null}');
  });
});

describe('serializeScenario', () => {
  it('is independent of key insertion order', () => {
    const a = validScenario();
    const b = validScenario();
    const shuffled = {
      parameters: b.parameters,
      entities: b.entities.map((e) => ({ pose: e.pose, model: e.model, kind: e.kind, id: e.id })),
      lightPrograms: b.lightPrograms,
      map: { mapName: b.map.mapName, mapId: b.map.mapId },
      triggers: b.triggers,
      routes: b.routes,
      meta: {
        appVersion: b.meta.appVersion,
        modifiedAt: b.meta.modifiedAt,
        createdAt: b.meta.createdAt,
        description: b.meta.description,
        name: b.meta.name,
      },
      scenarioVersion: b.scenarioVersion,
    };
    expect(serializeScenario(shuffled as typeof b)).toBe(serializeScenario(a));
  });

  it('ends with exactly one newline and uses two-space indent', () => {
    const text = serializeScenario(validScenario());
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('}\n\n')).toBe(false);
    expect(text).toContain('\n  "entities": [');
  });

  it('quantises float noise out of the diff', () => {
    const doc = validScenario();
    doc.entities[0]!.pose.position.x = 0.1 + 0.2;
    expect(serializeScenario(doc)).toContain('"x": 0.3');
  });

  it('is stable across a parse/serialize round trip', () => {
    const doc = ScenarioDocument.create(
      { name: 'Round trip', map: { mapId: 'yale-street', mapName: 'Yale Street' }, createdAt: CREATED_AT },
      testOptions(),
    );
    doc.addEntity({
      kind: 'pedestrian',
      model: { catalogId: 'ped.adult' },
      pose: { position: { x: 1 / 3, y: 0, z: -2 / 7 }, headingRad: Math.PI / 6 },
      laneRef: { roadId: '9', section: 1, laneId: 2, s: 1 / 9 },
    });
    const once = doc.serialize();
    const twice = serializeScenario(deserializeScenario(once));
    const thrice = serializeScenario(deserializeScenario(twice));
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });

  it('preserves extension payloads verbatim (modulo key order)', () => {
    const doc = validScenario();
    doc.extensions = { 'tool.x': { nested: [1, 2, { deep: true }], s: 'text' } };
    const back = deserializeScenario(serializeScenario(doc));
    expect(back.extensions).toEqual(doc.extensions);
  });
});
