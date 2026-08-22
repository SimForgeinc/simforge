/**
 * Golden-maneuver acceptance: the executable maneuver cases in
 * `fixtures/physics/golden-maneuvers.v1.json` must land inside the published,
 * cited reference bands when run against `DynamicV1Backend` with the generic
 * passenger-car profile. Cases without an executable comparison are reported
 * `not-run` — absence of a result is never a pass.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  validateGoldenManeuvers,
  type GoldenManeuverFixture,
} from '../validation/golden-maneuvers.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../../fixtures/physics/golden-maneuvers.v1.json', import.meta.url),
);

describe('golden physics maneuvers', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GoldenManeuverFixture;

  it('meets every published reference band', () => {
    const report = validateGoldenManeuvers(fixture);
    const failed = report.findings.filter((finding) => finding.status === 'fail');
    expect(failed).toEqual([]);
    // The wired gates must all pass; unwired cases stay `not-run` (checked
    // separately) which keeps the whole-contract report honestly incomplete.
    const executed = report.findings.filter((finding) => finding.status !== 'not-run');
    expect(executed.every((finding) => finding.status === 'pass')).toBe(true);
    // Every measurable case produced at least one compared finding.
    const compared = report.findings.filter((finding) => finding.status === 'pass');
    expect(compared.length).toBeGreaterThanOrEqual(5);
  });

  it('reports not-run rather than silently skipping unwired cases', () => {
    const report = validateGoldenManeuvers(fixture);
    const notRun = report.findings.filter((finding) => finding.status === 'not-run');
    expect(notRun.length).toBeGreaterThan(0);
    for (const finding of notRun) {
      expect(finding.detail).toContain('no executable reference comparison');
    }
  });
});
