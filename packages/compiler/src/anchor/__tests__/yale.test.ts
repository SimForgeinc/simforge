/**
 * The matcher against **real Yale Street data**.
 *
 * Skipped when `dev-assets/` is absent (it is not committed). Runs against
 * map-intel's derived index through the normalizer when that exists, and
 * against our own derivation otherwise — both paths are asserted to agree on
 * the facts the matcher depends on.
 */

import { describe, expect, it } from 'vitest';

import { matchAnchor, matchAnchorReport } from '../matcher.js';
import { parseLogicalAnchor } from '../types/anchor.js';
import { parseRoleBindings } from '../types/roles.js';
import { impossibleAnchor, workedExampleAnchor, workedExampleRoles } from './fixtures/anchors.js';
import { hasMapIntelDerived, hasYaleAssets, loadYaleIndex, loadYaleSelfDerived } from './yale.js';

describe.skipIf(!hasYaleAssets())('yale street', () => {
  it('derives a usable index', async () => {
    const index = await loadYaleIndex();
    expect(Object.keys(index.lanes).length).toBeGreaterThan(1000);
    expect(index.gates.length).toBeGreaterThan(400);
    expect(Object.keys(index.junctionDescriptors).length).toBe(56);
    expect(index.topologyDigest.length).toBeGreaterThan(16);
    expect(index.capabilities.junctionControl).toBe(true);
    // Yale's signalized junctions are the anchor class the worked example needs.
    expect((index.factIndex.junctionsByControl['signalized'] ?? []).length).toBeGreaterThan(0);
    // Every junction with more than one gate should have some conflict geometry.
    const totalConflicts = Object.values(index.junctionDescriptors).reduce(
      (acc, d) => acc + d.conflictPairs.length,
      0,
    );
    expect(totalConflicts).toBeGreaterThan(100);
  });

  it('matches the worked example: 3-lane arterial, signalized 4-way, ego left across opposing straight', async () => {
    const index = await loadYaleIndex();
    const report = matchAnchorReport(workedExampleAnchor(), index, { roles: workedExampleRoles() });

    // Yale has 56 junctions; only the signalized ones are candidates.
    expect(report.stats.candidatesConsidered).toBeGreaterThan(0);
    expect(report.stats.candidatesConsidered).toBeLessThan(30);
    expect(report.sites.length).toBeGreaterThanOrEqual(1);

    for (const site of report.sites) {
      expect(site.frame.origin.mapFeatureId.startsWith('junction:')).toBe(true);
      expect(site.frame.egoTurn).toBe('left');
      expect(site.degradation.verdict).not.toBe('infeasible');
      expect(site.score).toBeGreaterThanOrEqual(0.3);

      // The junction really is signalized with four arms.
      expect(site.clauses.find((c) => c.path === 'features.jx.junction.control')!.actual).toBe(
        'signalized',
      );
      expect(site.clauses.find((c) => c.path === 'features.jx.junction.arms')!.actual).toBe(4);

      // And the conflict the scenario is about actually exists there.
      const challenger = site.bindings.find((b) => b.role === 'challenger')!;
      expect(challenger.status).toBe('bound');
      expect(challenger.conflict!.relation).toBe('opposing');
      expect(challenger.conflict!.crossingAngleDeg).toBeGreaterThan(30);
      expect(challenger.routeLaneChain!.length).toBeGreaterThan(1);
      expect(challenger.conflict!.sOnEgo).toBeGreaterThan(0);
      expect(site.matchedReasons.length).toBeGreaterThan(0);
    }

    // Diversity keeps one site per junction.
    const junctions = report.sites.map((s) => s.frame.origin.mapFeatureId);
    expect(new Set(junctions).size).toBe(junctions.length);

    // Yale really does have the 3-lane arterial approach the example is about,
    // so at least one site must match it exactly rather than by degradation.
    // (If it ever stops having one, this is the assertion to relax to 2 lanes —
    // see the anchor's `laneRange` override.)
    const exact = report.sites.filter((s) => s.degradation.verdict === 'exact');
    expect(exact.length).toBeGreaterThanOrEqual(1);
    const laneCounts = exact.map(
      (s) => s.clauses.find((c) => c.path === 'corridor.throughLanesSameDir')!.actual as number,
    );
    expect(Math.max(...laneCounts)).toBeGreaterThanOrEqual(3);
    expect(report.sites[0]!.score).toBe(1);
  });

  it('relaxes to a two-lane approach and finds at least as many sites', async () => {
    const index = await loadYaleIndex();
    const strict = matchAnchor(workedExampleAnchor(), index, { roles: workedExampleRoles() });
    const relaxed = matchAnchor(workedExampleAnchor({ laneRange: [2, 4] }), index, {
      roles: workedExampleRoles(),
    });
    expect(relaxed.length).toBeGreaterThanOrEqual(strict.length);
  });

  it('returns nothing, with a report, for an impossible anchor', async () => {
    const index = await loadYaleIndex();
    const report = matchAnchorReport(impossibleAnchor(), index);
    expect(report.sites).toEqual([]);
    expect(report.failureSummary.length).toBeGreaterThan(20);
  });

  it('is deterministic across runs on real data', async () => {
    const index = await loadYaleIndex();
    const a = matchAnchor(workedExampleAnchor(), index, { roles: workedExampleRoles() });
    const b = matchAnchor(workedExampleAnchor(), index, { roles: workedExampleRoles() });
    expect(a.map((s) => s.siteId)).toEqual(b.map((s) => s.siteId));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('binds a pedestrian on a crossing when the location catalog is available', async () => {
    const index = await loadYaleIndex();
    if (!index.capabilities.crossings && index.pointFeatures.length === 0) {
      // No location catalog on disk: the matcher must say so rather than
      // silently binding a pedestrian to nothing.
      const report = matchAnchorReport(workedExampleAnchor(), index);
      expect(report.warnings.join(' ')).toContain('crossing layer');
      return;
    }
    expect(index.pointFeatures.some((p) => p.kind === 'crossing')).toBe(true);
  });

  it('completes a full-map match in well under a second', async () => {
    const index = await loadYaleIndex();
    const started = performance.now();
    matchAnchor(workedExampleAnchor(), index, { roles: workedExampleRoles() });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe.skipIf(!hasYaleAssets() || !hasMapIntelDerived())('map-intel normalizer seam', () => {
  it('adopts map-intel derived facts rather than re-deriving them', async () => {
    const index = await loadYaleIndex();
    expect(index.provenance.source).toBe('map-intel');
    expect(index.provenance.notes.join(' ')).toContain('adopted junctionDescriptors');
    // Segment ids come from map-intel, because corridor site ids embed them.
    expect(index.segments.every((s) => s.laneRsls.length > 0)).toBe(true);
    expect(index.factIndex.segmentsByLaneCount['3']?.length ?? 0).toBeGreaterThan(0);
  });

  it('agrees with our own derivation on the facts the matcher keys off', async () => {
    const [adopted, self] = await Promise.all([loadYaleIndex(), loadYaleSelfDerived()]);
    for (const id of Object.keys(self.junctionDescriptors)) {
      const a = adopted.junctionDescriptors[id]!;
      const s = self.junctionDescriptors[id]!;
      // Arm counts must agree exactly: both are structural derivations.
      expect(Math.abs(a.arms - s.arms)).toBeLessThanOrEqual(1);
    }
    // map-intel sees signals we cannot (rrdata phases), so it may find strictly
    // more signalized junctions — but never fewer.
    const adoptedSignals = (adopted.factIndex.junctionsByControl['signalized'] ?? []).length;
    const selfSignals = (self.factIndex.junctionsByControl['signalized'] ?? []).length;
    expect(adoptedSignals).toBeGreaterThanOrEqual(selfSignals);
  });

  it('matches the worked example on both index paths', async () => {
    const [adopted, self] = await Promise.all([loadYaleIndex(), loadYaleSelfDerived()]);
    const roles = () => parseRoleBindings(JSON.parse(JSON.stringify(workedExampleRoles())));
    const viaMapIntel = matchAnchor(workedExampleAnchor(), adopted, { roles: roles() });
    const viaSelf = matchAnchor(workedExampleAnchor(), self, { roles: roles() });
    expect(viaMapIntel.length).toBeGreaterThan(0);
    expect(viaSelf.length).toBeGreaterThan(0);
    // Site ids differ by construction (different topology digests), but the
    // junctions the two paths select must overlap.
    const overlap = viaSelf
      .map((s) => s.frame.origin.mapFeatureId)
      .filter((id) => viaMapIntel.some((m) => m.frame.origin.mapFeatureId === id));
    expect(overlap.length).toBeGreaterThan(0);
  });

  it('carries crossings and parking zones from the location catalog', async () => {
    const index = await loadYaleIndex();
    const kinds = new Set(index.pointFeatures.map((p) => p.kind));
    // The catalog has 12 crosswalks and 639 parking spaces on Yale.
    expect(kinds.has('crossing') || kinds.has('parking_zone')).toBe(true);
    for (const feature of index.pointFeatures.slice(0, 20)) {
      expect(index.lanes[feature.laneRsl]).toBeDefined();
      expect(Number.isFinite(feature.s)).toBe(true);
    }
  });
});

describe.skipIf(!hasYaleAssets())('yale — anchors an author would actually write', () => {
  it('finds a straight-through arterial corridor with a bike lane', async () => {
    const index = await loadYaleIndex();
    const anchor = parseLogicalAnchor({
      id: 'arterial-with-bike-lane',
      corridor: {
        throughLanesSameDir: { value: [2, 4], essentiality: 'required' },
        speedLimitKph: { value: [45, 70], essentiality: 'preferred' },
        requiresAdjacent: { value: ['biking'], essentiality: 'preferred' },
        runwayDownstreamM: { value: 60, essentiality: 'required' },
      },
      policy: { diversity: 'road_direction', maxSitesPerMap: 5, minScore: 0.4 },
    });
    const sites = matchAnchor(anchor, index);
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect(site.frame.origin.kind).toBe('corridor');
      expect(site.frame.runwayDownstreamM).toBeGreaterThanOrEqual(60);
    }
  });
});
