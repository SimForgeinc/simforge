/**
 * Golden-maneuver PROVENANCE gate (WS6).
 *
 * `fixtures/physics/golden-maneuvers.v2.json` extends the v1 suite with a
 * per-case `provenance` field: measured-carla | published-data | engine-derived.
 *
 * CI teeth:
 *  1. every entry must declare a provenance from the enum;
 *  2. no entry may claim external reference values while being engine-derived —
 *     engine-derived entries are only tolerated as solver self-checks, and the
 *     set of them is PINNED by `documentedEngineDerivedIds` (any addition or
 *     removal fails this test, so unvalidated physics can never sneak in);
 *  3. every reference row carries its own provenance;
 *  4. the TS engine's maneuver outputs (via the shared
 *     `validateGoldenManeuvers` harness) must fall inside the v2 tolerance
 *     bands.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  validateGoldenManeuvers,
  type GoldenManeuverFixture,
} from '../validation/golden-maneuvers.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../../fixtures/physics/golden-maneuvers.v2.json', import.meta.url),
);

interface V2Case {
  readonly id: string;
  readonly family: string;
  readonly provenance?: string;
  readonly references?: readonly {
    readonly metric: string;
    readonly provenance?: string;
  }[];
}

interface V2Fixture extends GoldenManeuverFixture {
  readonly provenanceEnum?: readonly string[];
  readonly documentedEngineDerivedIds?: readonly string[];
  readonly cases: readonly V2Case[];
}

describe('golden physics maneuvers v2 — provenance', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as V2Fixture;
  const ENUM = fixture.provenanceEnum ?? ['measured-carla', 'published-data', 'engine-derived'];
  const allowlist = new Set(fixture.documentedEngineDerivedIds ?? []);

  it('declares a provenance for every entry', () => {
    const missing = fixture.cases.filter((c) => !c.provenance);
    expect(missing.map((c) => c.id)).toEqual([]);
    for (const c of fixture.cases) {
      expect(ENUM, `${c.id}: unknown provenance "${c.provenance}"`).toContain(c.provenance);
    }
  });

  it('never lets an engine-derived entry outside the pinned allowlist pass CI', () => {
    const derived = fixture.cases.filter((c) => c.provenance === 'engine-derived');
    const undeclared = derived.filter((c) => !allowlist.has(c.id));
    // The failure list documents exactly which maneuvers still lack an oracle.
    if (undeclared.length > 0) {
      throw new Error(
        `engine-derived entries not in documentedEngineDerivedIds (CI fail): ` +
          undeclared.map((c) => c.id).join(', '),
      );
    }
    // The allowlist must match reality exactly — no stale pins, no silent adds.
    expect([...derived.map((c) => c.id)].sort()).toEqual([...allowlist].sort());
  });

  it('marks every reference row with its own provenance and never an engine-derived one', () => {
    for (const c of fixture.cases) {
      for (const ref of c.references ?? []) {
        expect(ref.provenance, `${c.id}:${ref.metric} missing reference provenance`)
          .toBeDefined();
        expect(
          ref.provenance === 'engine-derived',
          `${c.id}:${ref.metric}: reference values may never be engine-derived`,
        ).toBe(false);
        expect(ENUM).toContain(ref.provenance);
      }
    }
  });

  it('runs the TS engine against the v2 tolerance bands', () => {
    const report = validateGoldenManeuvers(fixture);
    const failed = report.findings.filter((f) => f.status === 'fail');
    expect(failed).toEqual([]);
    const executed = report.findings.filter((f) => f.status !== 'not-run');
    expect(executed.every((f) => f.status === 'pass')).toBe(true);
    // acceleration(2 rows) + braking(3 rows, one at-most) + coast(1 row)
    const compared = report.findings.filter((f) => f.status === 'pass');
    expect(compared.length).toBeGreaterThanOrEqual(5);
  });

  it('records the CARLA oracle that anchors the measured-carla entries', () => {
    expect(fixture.oracle.carlaServerVersion).toBe('0.9.16');
    for (const c of fixture.cases) {
      if (c.provenance === 'measured-carla') {
        expect(c.references?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});
