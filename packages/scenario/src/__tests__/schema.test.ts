import { describe, expect, it } from 'vitest';

import { ScenarioValidationError, toScenarioIssues } from '../errors.js';
import { ScenarioV1Schema } from '../schema/v1.js';
import { parseScenario } from '../serialize.js';
import { validScenario } from './fixtures.js';

/** Parse and return the issue paths, or fail if the document was accepted. */
function issuesOf(doc: unknown): string[] {
  const result = ScenarioV1Schema.safeParse(doc);
  if (result.success) throw new Error('expected the document to be rejected');
  return toScenarioIssues(result.error.issues).map((i) => i.path);
}

describe('accepts', () => {
  it('a minimal valid document', () => {
    expect(ScenarioV1Schema.safeParse(validScenario()).success).toBe(true);
  });

  it('a document with every optional field populated', () => {
    const doc = validScenario();
    const full = {
      ...doc,
      meta: { ...doc.meta, description: 'unprotected left across two lanes' },
      map: { ...doc.map, xodrSha256: 'a'.repeat(64) },
      entities: [
        {
          ...doc.entities[0]!,
          label: 'Ego',
          laneRef: {
            roadId: '17',
            section: 0,
            laneId: -1,
            s: 42.5,
            t: -0.25,
            headingOffsetRad: 0.01,
          },
          dims: { length: 4.6, width: 1.85, height: 1.45 },
          extensions: { 'sim.carla': { blueprint: 'vehicle.tesla.model3' } },
        },
      ],
      extensions: { 'studio.camera': { yaw: 1.2 } },
    };
    expect(ScenarioV1Schema.safeParse(full).success).toBe(true);
  });

  it('fills defaults for omitted reserved blocks and description', () => {
    const doc = validScenario() as Record<string, unknown>;
    delete doc.routes;
    delete doc.triggers;
    delete doc.lightPrograms;
    delete doc.parameters;
    delete (doc.meta as Record<string, unknown>).description;
    const parsed = parseScenario(doc);
    expect(parsed.routes).toEqual([]);
    expect(parsed.triggers).toEqual([]);
    expect(parsed.lightPrograms).toEqual([]);
    expect(parsed.parameters).toEqual({});
    expect(parsed.meta.description).toBe('');
  });

  it('lane refs with omitted t / headingOffsetRad, defaulting both to 0', () => {
    const doc = validScenario();
    const parsed = parseScenario({
      ...doc,
      entities: [{ ...doc.entities[0]!, laneRef: { roadId: '3', section: 0, laneId: -2, s: 0 } }],
    });
    expect(parsed.entities[0]!.laneRef).toEqual({
      roadId: '3',
      section: 0,
      laneId: -2,
      s: 0,
      t: 0,
      headingOffsetRad: 0,
    });
  });

  it('zero-valued numbers (the falsy-zero trap)', () => {
    const doc = validScenario();
    const parsed = parseScenario({
      ...doc,
      entities: [
        {
          ...doc.entities[0]!,
          pose: { position: { x: 0, y: 0, z: 0 }, headingRad: 0 },
          laneRef: { roadId: '3', section: 0, laneId: 0, s: 0, t: 0, headingOffsetRad: 0 },
        },
      ],
    });
    expect(parsed.entities[0]!.pose.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(parsed.entities[0]!.laneRef!.s).toBe(0);
  });
});

describe('rejects', () => {
  it('unknown keys at the document root', () => {
    expect(issuesOf({ ...validScenario(), somethingNew: true })).toContain('somethingNew');
  });

  it('unknown keys inside meta, map, entity and pose', () => {
    const doc = validScenario();
    expect(issuesOf({ ...doc, meta: { ...doc.meta, author: 'me' } })).toContain('meta.author');
    expect(issuesOf({ ...doc, map: { ...doc.map, crs: 'epsg:4326' } })).toContain('map.crs');
    expect(issuesOf({ ...doc, entities: [{ ...doc.entities[0]!, speed: 12 }] })).toContain(
      'entities.0.speed',
    );
    expect(
      issuesOf({
        ...doc,
        entities: [{ ...doc.entities[0]!, pose: { ...doc.entities[0]!.pose, heading: 1 } }],
      }),
    ).toContain('entities.0.pose.heading');
  });

  it('but tolerates arbitrary keys inside extensions', () => {
    const doc = validScenario();
    const result = ScenarioV1Schema.safeParse({
      ...doc,
      extensions: { anything: { deeply: { nested: [1, 'two', null] } }, 'other-tool': 42 },
      entities: [{ ...doc.entities[0]!, extensions: { whatever: true } }],
    });
    expect(result.success).toBe(true);
    expect(result.data!.extensions!['other-tool']).toBe(42);
  });

  it('a wrong or missing scenarioVersion', () => {
    expect(issuesOf({ ...validScenario(), scenarioVersion: 2 })).toContain('scenarioVersion');
    const doc = validScenario() as Record<string, unknown>;
    delete doc.scenarioVersion;
    expect(issuesOf(doc)).toContain('scenarioVersion');
  });

  it('duplicate entity ids', () => {
    const doc = validScenario();
    const dup = { ...doc, entities: [doc.entities[0]!, { ...doc.entities[0]! }] };
    expect(issuesOf(dup)).toContain('entities.1.id');
  });

  it('modifiedAt before createdAt', () => {
    const doc = validScenario();
    expect(
      issuesOf({ ...doc, meta: { ...doc.meta, modifiedAt: '2026-07-30T00:00:00.000Z' } }),
    ).toContain('meta.modifiedAt');
  });

  it('non-finite numbers', () => {
    const doc = validScenario();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const broken = {
        ...doc,
        entities: [
          { ...doc.entities[0]!, pose: { ...doc.entities[0]!.pose, headingRad: bad } },
        ],
      };
      expect(issuesOf(broken)).toContain('entities.0.pose.headingRad');
    }
  });

  it('non-empty reserved blocks', () => {
    const doc = validScenario();
    expect(issuesOf({ ...doc, routes: [{ id: 'r1' }] })).toContain('routes');
    expect(issuesOf({ ...doc, triggers: [{}] })).toContain('triggers');
    expect(issuesOf({ ...doc, lightPrograms: [{}] })).toContain('lightPrograms');
    expect(issuesOf({ ...doc, parameters: { speed: 5 } })).toContain('parameters.speed');
  });

  it('bad enums, ids, timestamps and hashes', () => {
    const doc = validScenario();
    expect(issuesOf({ ...doc, entities: [{ ...doc.entities[0]!, kind: 'drone' }] })).toContain(
      'entities.0.kind',
    );
    expect(issuesOf({ ...doc, entities: [{ ...doc.entities[0]!, id: 'has/slash' }] })).toContain(
      'entities.0.id',
    );
    expect(issuesOf({ ...doc, meta: { ...doc.meta, createdAt: '31/07/2026' } })).toContain(
      'meta.createdAt',
    );
    expect(issuesOf({ ...doc, map: { ...doc.map, xodrSha256: 'ABC' } })).toContain(
      'map.xodrSha256',
    );
  });

  it('non-positive dimensions', () => {
    const doc = validScenario();
    expect(
      issuesOf({
        ...doc,
        entities: [{ ...doc.entities[0]!, dims: { length: 0, width: 1, height: 1 } }],
      }),
    ).toContain('entities.0.dims.length');
  });

  it('and parseScenario throws a ScenarioValidationError carrying every issue', () => {
    const doc = validScenario() as Record<string, unknown>;
    delete doc.map;
    try {
      parseScenario({ ...doc, nope: 1 });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioValidationError);
      const issues = (error as ScenarioValidationError).issues;
      expect(issues.map((i) => i.path).sort()).toEqual(['map', 'nope']);
      expect((error as Error).message).toContain('map');
    }
  });
});
