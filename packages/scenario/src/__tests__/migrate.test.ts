import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScenarioMigrationError, ScenarioValidationError } from '../errors.js';
import {
  CURRENT_SCENARIO_VERSION,
  SCENARIO_MIGRATIONS,
  migrate,
  runMigrations,
  type ScenarioMigration,
} from '../migrate.js';
import type { ScenarioV1 } from '../schema/v1.js';
import { validScenario } from './fixtures.js';

/**
 * A synthetic chain, so dispatch is tested without inventing a future schema.
 * When v2 lands, its real step gets the same treatment plus a fixture test.
 */
const step = (from: number, to: number, mutate: (raw: Record<string, unknown>) => void = () => {}): ScenarioMigration => ({
  from,
  to,
  description: `v${from} -> v${to}`,
  up: (raw) => {
    const next = { ...raw, scenarioVersion: to };
    mutate(next);
    return next;
  },
});

/** Accepts anything; used when the synthetic chain does not end at a real schema. */
const passthrough = (json: unknown) => json as ScenarioV1;

describe('migrate (v1 baseline)', () => {
  it('ships an empty chain at v1', () => {
    expect(CURRENT_SCENARIO_VERSION).toBe(1);
    expect(SCENARIO_MIGRATIONS).toHaveLength(0);
  });

  it('passes a v1 document through unmigrated', () => {
    const result = migrate(validScenario());
    expect(result.migrated).toBe(false);
    expect(result.fromVersion).toBe(1);
    expect(result.applied).toEqual([]);
    expect(result.doc.meta.name).toBe('Yale & Grant left turn');
  });

  it('validates the result', () => {
    expect(() => migrate({ ...validScenario(), stray: 1 })).toThrow(ScenarioValidationError);
  });

  it('rejects things that are not scenario documents', () => {
    for (const bad of [null, 42, 'text', [], {}, { scenarioVersion: '1' }, { scenarioVersion: 0 }]) {
      expect(() => migrate(bad)).toThrow(ScenarioMigrationError);
    }
  });

  it('rejects documents from a newer app with an actionable message', () => {
    try {
      migrate({ ...validScenario(), scenarioVersion: 7 });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioMigrationError);
      expect((error as ScenarioMigrationError).fromVersion).toBe(7);
      expect((error as Error).message).toMatch(/newer version of the app/);
    }
  });
});

describe('runMigrations dispatch', () => {
  it('walks every step in order and reports what ran', () => {
    const result = runMigrations(
      { scenarioVersion: 1, marks: [] },
      {
        migrations: [
          step(1, 2, (raw) => (raw.marks as string[]).push('a')),
          step(2, 3, (raw) => (raw.marks as string[]).push('b')),
        ],
        targetVersion: 3,
        validate: passthrough,
      },
    );
    expect(result.migrated).toBe(true);
    expect(result.fromVersion).toBe(1);
    expect(result.applied).toEqual(['v1 -> v2', 'v2 -> v3']);
    expect((result.doc as unknown as { marks: string[] }).marks).toEqual(['a', 'b']);
    expect(result.doc.scenarioVersion).toBe(3);
  });

  it('starts mid-chain when the file is only one version behind', () => {
    const result = runMigrations(
      { scenarioVersion: 2 },
      { migrations: [step(1, 2), step(2, 3)], targetVersion: 3, validate: passthrough },
    );
    expect(result.applied).toEqual(['v2 -> v3']);
  });

  it('fails loudly on a gap in the chain', () => {
    expect(() =>
      runMigrations(
        { scenarioVersion: 1 },
        { migrations: [step(2, 3)], targetVersion: 3, validate: passthrough },
      ),
    ).toThrow(/no migration from schema v1 to v3/);
  });

  it('fails when a step does not stamp the version it promised', () => {
    const liar: ScenarioMigration = {
      from: 1,
      to: 2,
      description: 'forgets to bump',
      up: (raw) => ({ ...raw }),
    };
    expect(() =>
      runMigrations({ scenarioVersion: 1 }, { migrations: [liar], targetVersion: 2, validate: passthrough }),
    ).toThrow(/supposed to produce v2/);
  });

  it('runs the final validation on the migrated output', () => {
    expect(() =>
      runMigrations(
        { scenarioVersion: 1 },
        { migrations: [step(1, 2)], targetVersion: 2, validate: () => {
          throw new ScenarioValidationError('nope', []);
        } },
      ),
    ).toThrow(ScenarioValidationError);
  });
});

describe('ScenarioDocument.fromJSON + migrations', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../migrate.js');
  });

  it('loads a migrated document dirty, because the file on disk is stale', async () => {
    vi.doMock('../migrate.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../migrate.js')>();
      return {
        ...actual,
        migrate: (json: unknown) => ({ ...actual.migrate(json), migrated: true, applied: ['fake'] }),
      };
    });
    const { ScenarioDocument } = await import('../document.js');
    const doc = ScenarioDocument.fromJSON(validScenario());
    expect(doc.isDirty).toBe(true);
    expect(doc.canUndo).toBe(false);
  });
});
