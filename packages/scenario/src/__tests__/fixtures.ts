/** Shared test helpers: a valid v1 document, a pinned clock, and a seeded PRNG. */

import type { ScenarioDocumentOptions } from '../document.js';
import type { ScenarioV1 } from '../schema/v1.js';

export const CREATED_AT = '2026-07-31T12:00:00.000Z';

/** A minimal but complete v1 document. */
export function validScenario(overrides: Partial<ScenarioV1> = {}): ScenarioV1 {
  return {
    scenarioVersion: 1,
    meta: {
      name: 'Yale & Grant left turn',
      description: '',
      createdAt: CREATED_AT,
      modifiedAt: CREATED_AT,
      appVersion: '0.0.1',
    },
    map: { mapId: 'yale-street', mapName: 'Yale Street' },
    entities: [
      {
        id: 'E0001',
        kind: 'vehicle',
        model: { catalogId: 'sedan.generic' },
        pose: { position: { x: 118.25, y: 0, z: -402.5 }, headingRad: 1.5707963 },
      },
    ],
    routes: [],
    triggers: [],
    lightPrograms: [],
    parameters: {},
    ...overrides,
  };
}

/** A clock that advances one second per call, starting after {@link CREATED_AT}. */
export function tickingClock(startMs = Date.parse(CREATED_AT) + 1000): () => string {
  let t = startMs;
  return () => {
    const iso = new Date(t).toISOString();
    t += 1000;
    return iso;
  };
}

/** Deterministic document options: pinned clock plus sequential ids. */
export function testOptions(prefix = 'E', extra: ScenarioDocumentOptions = {}): ScenarioDocumentOptions {
  let n = 0;
  return {
    now: tickingClock(),
    newId: () => `${prefix}${String(++n).padStart(4, '0')}`,
    ...extra,
  };
}

/** mulberry32 — small, seeded, good enough for op-sequence fuzzing. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
