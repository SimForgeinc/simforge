/**
 * Lane-offset loudness: a role that asks for a lane the site does not have must
 * say so, not be relocated.
 *
 * The defect this pins: `relative_to` resolved its `dLane` through an
 * unconditional nearest-lane clamp. On a one-lane-per-direction corridor —
 * ~70% of the driving lanes on the five dev maps — `dLane: -1` therefore
 * resolved to `k = 0`, i.e. the reference actor's own lane, and the two actors
 * were spawned interpenetrating with nothing louder than a note. Every other
 * lane-bound role kind already had an explicit `onMissing`; this one did not,
 * so the silent branch was not even reachable by an author who wanted to avoid
 * it.
 */

import { describe, expect, it } from 'vitest';

import { deriveMapIndexFromTopology } from '../derive.js';
import { matchAnchor, matchAnchorReport } from '../matcher.js';
import { parseRoleBindings } from '../types/roles.js';
import { syntheticSearchIndex, syntheticTopology } from './fixtures/synthetic-map.js';
import { workedExampleAnchor } from './fixtures/anchors.js';

const index = deriveMapIndexFromTopology(syntheticTopology(), {
  mapId: 'synthetic',
  searchIndex: syntheticSearchIndex('traffic_light'),
});

/**
 * The worked example's approach carries `k = 0, -1, -2` and nothing to the
 * left, so `dLane: +1` is a lane the site genuinely does not have.
 */
const MISSING_D_LANE = 1;
const PRESENT_D_LANE = -1;

const rolesWith = (dLane: number, onMissing?: 'clamp' | 'drop' | 'fail') =>
  parseRoleBindings([
    { role: 'ego', kind: 'on_reference' },
    {
      role: 'buddy',
      kind: 'relative_to',
      ref: 'ego',
      dLane,
      ...(onMissing === undefined ? {} : { onMissing }),
    },
  ]);

describe('relative_to — dLane that the site cannot satisfy', () => {
  it('binds normally when the lane is there', () => {
    const sites = matchAnchor(workedExampleAnchor(), index, { roles: rolesWith(PRESENT_D_LANE) });
    const buddy = sites[0]!.bindings.find((b) => b.role === 'buddy')!;
    expect(buddy.status).toBe('bound');
    expect(buddy.pose!.k).toBe(PRESENT_D_LANE);
    expect(buddy.laneRsl).toBe('1:0:-2');
  });

  it('makes the site infeasible by default rather than relocating the actor', () => {
    const report = matchAnchorReport(workedExampleAnchor(), index, {
      roles: rolesWith(MISSING_D_LANE),
    });
    expect(report.sites).toEqual([]);
    const rejected = report.rejected[0]!;
    const buddy = rejected.bindings.find((b) => b.role === 'buddy')!;
    expect(buddy.status).toBe('failed');
    // The actor must never end up sharing the reference actor's lane.
    expect(buddy.pose?.k).not.toBe(0);
    expect(buddy.laneRsl).toBeUndefined();
    expect(buddy.notes.join(' ')).toMatch(/does not exist at this site/);
    expect(rejected.degradation.failedRequiredClauses).toContain('roles.buddy');
  });

  it('still clamps when the author explicitly opts in', () => {
    const sites = matchAnchor(workedExampleAnchor(), index, {
      roles: rolesWith(MISSING_D_LANE, 'clamp'),
    });
    const buddy = sites[0]!.bindings.find((b) => b.role === 'buddy')!;
    expect(buddy.status).toBe('clamped');
    expect(buddy.pose!.k).toBe(0);
    expect(sites[0]!.degradation.verdict).toBe('degraded');
  });

  it('drops the actor when the author explicitly opts in', () => {
    const sites = matchAnchor(workedExampleAnchor(), index, {
      roles: rolesWith(MISSING_D_LANE, 'drop'),
    });
    const buddy = sites[0]!.bindings.find((b) => b.role === 'buddy')!;
    expect(buddy.status).toBe('dropped');
    expect(sites[0]!.degradation.verdict).toBe('degraded');
  });
});
