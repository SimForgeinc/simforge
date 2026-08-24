import { describe, expect, it } from 'vitest';

import {
  applyAmbientTraffic,
  contentHash,
  createAmbientCandidatePool,
  evaluateAmbientRobustness,
  materializeAmbientCandidatePool,
  materializeAmbientTrafficProfile,
  promoteAmbientActor,
  runSimulation,
} from '../index.js';
import { scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';

describe('native ambient traffic', () => {
  const graph = syntheticGraph();
  const base = scenario(graph, {
    clipSeconds: 8,
    warmupSeconds: 0,
    actors: [vehicle(graph, { id: 'ego', s: 200, speedMps: 8, cruiseSpeedMps: 8 })],
    metricSubject: 'ego',
  });

  it('resolves the City preset to a car-heavy, deterministic street population', () => {
    const profile = { version: 1 as const, preset: 'city' as const, seed: 'city-default' };
    const a = applyAmbientTraffic(base, graph, profile);
    const b = applyAmbientTraffic(base, graph, profile);
    expect(a.provenance.profile).toMatchObject({
      preset: 'city',
      densityVehiclesPerKm: 8,
      pedestrianShare: 0.06,
      cyclistShare: 0.02,
      maxActors: 32,
    });
    expect(a.provenance.actors.length).toBeGreaterThan(0);
    expect(contentHash(a)).toBe(contentHash(b));
    const vulnerableUsers = a.provenance.actors.filter(({ kind }) => kind === 'pedestrian' || kind === 'bicycle');
    expect(vulnerableUsers.length).toBeLessThan(a.provenance.actors.length);
  });

  it('keeps a bounded City population present from t=0 through a 20 second clip', () => {
    const twentySecondBase = scenario(graph, {
      ...base,
      clipSeconds: 20,
      actors: [vehicle(graph, { id: 'ego', s: 200, speedMps: 8, cruiseSpeedMps: 8 })],
    });
    const generated = applyAmbientTraffic(twentySecondBase, graph, {
      version: 1,
      preset: 'city',
      seed: 'city-20-second-visibility',
    });
    const trace = runSimulation(generated.input, { graph, guards: 'throw' }).trace;
    expect(generated.provenance.actors.length).toBeGreaterThan(0);
    expect(generated.provenance.actors.length).toBeLessThanOrEqual(32);
    expect(trace.ticks.t[0]).toBe(0);
    expect(trace.ticks.t.at(-1)).toBe(20);
    for (const actor of generated.provenance.actors) {
      expect(actor.routeLaneRsls.length).toBeGreaterThan(0);
      expect(trace.ticks.actors[actor.id]!.present[0]).toBe(1);
      expect(trace.ticks.actors[actor.id]!.present.at(-1)).toBe(1);
    }
    const ambientIds = new Set(generated.provenance.actors.map(({ id }) => id));
    expect(trace.metrics.collisions.filter(({ a, b }) => ambientIds.has(a) || ambientIds.has(b))).toEqual([]);
  }, 30_000);

  it('is deterministic, provenance-closed, and leaves the authored input unchanged', () => {
    const profile = {
      version: 1 as const,
      preset: 'custom' as const,
      densityVehiclesPerKm: 10,
      seed: 'pinned-a',
      maxActors: 8,
      pedestrianShare: 0,
      cyclistShare: 0.2,
    };
    const before = contentHash(base);
    const a = applyAmbientTraffic(base, graph, profile);
    const b = applyAmbientTraffic(base, graph, profile);
    expect(contentHash(base)).toBe(before);
    expect(a.provenance.actors.length).toBeGreaterThan(0);
    expect(contentHash(a)).toBe(contentHash(b));
    expect(a.provenance.baseInputHash).toBe(before);
    expect(a.provenance.generatedInputHash).toBe(contentHash(a.input));
    expect(a.input.actors.filter((actor) => actor.tags.includes('ambient')).length).toBe(a.provenance.actors.length);
    for (const actor of a.input.actors.filter((candidate) => candidate.tags.includes('ambient'))) {
      expect(actor.tags.filter((tag) => tag.startsWith('catalog:'))).toHaveLength(1);
    }
    expect(() => runSimulation(a.input, { graph, guards: 'throw' })).not.toThrow();
  });

  it('reuses one candidate pool through the canonical browser/compiler entrypoint', () => {
    const profile = { version: 1 as const, preset: 'custom' as const, densityVehiclesPerKm: 10, seed: 'shared', maxActors: 8 };
    const first = materializeAmbientTrafficProfile(base, graph, profile);
    const second = materializeAmbientTrafficProfile(base, graph, profile, first.candidatePool);
    expect(second.candidatePool).toBe(first.candidatePool);
    expect(second.input.actors.map((actor) => actor.id)).toEqual(first.input.actors.map((actor) => actor.id));
    expect(second.provenance.generatedInputHash).toBe(first.provenance.generatedInputHash);
  });

  it('reserves runway for warm-up as well as the recorded clip', () => {
    const warmed = scenario(graph, {
      ...base,
      clipSeconds: 8,
      warmupSeconds: 20,
      actors: [vehicle(graph, { id: 'ego', s: 200, speedMps: 8, cruiseSpeedMps: 8 })],
    });
    const generated = applyAmbientTraffic(warmed, graph, {
      version: 1,
      preset: 'custom',
      densityVehiclesPerKm: 10,
      seed: 'warmup-runway-regression',
      maxActors: 8,
      pedestrianShare: 0,
      cyclistShare: 0,
    });
    expect(generated.provenance.actors.length).toBeGreaterThan(0);
    expect(() => runSimulation(generated.input, { graph, guards: 'throw' })).not.toThrow();
  });

  it('uses the seed only for background generation and respects authored exclusion space', () => {
    const profile = {
      version: 1 as const,
      preset: 'custom' as const,
      densityVehiclesPerKm: 12,
      maxActors: 10,
      exclusionRadiusM: 30,
    };
    const a = applyAmbientTraffic(base, graph, { ...profile, seed: 'a' });
    const b = applyAmbientTraffic(base, graph, { ...profile, seed: 'b' });
    expect(a.provenance.baseInputHash).toBe(b.provenance.baseInputHash);
    expect(a.provenance.generatedInputHash).not.toBe(b.provenance.generatedInputHash);
    const ego = base.actors[0]!;
    for (const actor of a.input.actors.filter((candidate) => candidate.tags.includes('ambient'))) {
      expect(Math.hypot(actor.initial.pose.x - ego.initial.pose.x, actor.initial.pose.z - ego.initial.pose.z)).toBeGreaterThan(30);
    }
  });

  it('supports off/light/moderate robustness checks and an ambient-to-authored promotion seam', () => {
    const report = evaluateAmbientRobustness(base, graph, [
      { label: 'off', profile: { version: 1, preset: 'off', seed: 'off' } },
      { label: 'light', profile: { version: 1, preset: 'light', seed: 'light', maxActors: 4 } },
      { label: 'moderate', profile: { version: 1, preset: 'moderate', seed: 'moderate', maxActors: 6 } },
    ], { filters: { negativeControl: true } });
    expect(report.cases.every((item) => item.deterministic)).toBe(true);
    expect(report.cases.every((item) => item.authoredEventOrderPreserved)).toBe(true);
    const ambient = applyAmbientTraffic(base, graph, {
      version: 1,
      preset: 'custom',
      densityVehiclesPerKm: 10,
      seed: 'promote',
      maxActors: 4,
    }).input.actors.find((actor) => actor.tags.includes('ambient'))!;
    const promoted = promoteAmbientActor(ambient, 'new-authored-actor');
    expect(promoted.id).toBe('new-authored-actor');
    expect(promoted.tags.some((tag) => tag.startsWith('ambient'))).toBe(false);
  });

  it('keys the candidate pool only to graph/profile/mix/seed', () => {
    const profile = {
      version: 1,
      preset: 'custom',
      densityVehiclesPerKm: 20,
      seed: 'pool-identity',
      maxActors: 16,
      radiusM: 1_000,
      pedestrianShare: 0,
      cyclistShare: 0,
    } as const;
    const pool = createAmbientCandidatePool(graph, profile);
    const edited = scenario(graph, { ...base, actors: [vehicle(graph, { id: 'ego-edited', s: 350, speedMps: 8 })], metricSubject: 'ego-edited' });
    expect(materializeAmbientCandidatePool(base, graph, pool).provenance.candidatePoolKey).toBe(pool.key);
    expect(materializeAmbientCandidatePool(edited, graph, pool).provenance.candidatePoolKey).toBe(pool.key);
    expect(createAmbientCandidatePool(graph, { ...profile, seed: 'regenerate' }).key).not.toBe(pool.key);
    expect(createAmbientCandidatePool(graph, {
      ...profile,
      vehicleMix: { car: 0, van: 1, truck: 0, bus: 0, motorcycle: 0 },
    }).key).not.toBe(pool.key);
    expect(pool.mapGraphDigest).toBe(graph.topologyDigest);
    expect(pool.candidates.every((item) => item.origin === 'ambient' && !item.timelineVisible && !item.editable)).toBe(true);
  });

  it('filters authored reservations without rerolling unaffected ids or routes', () => {
    const profile = {
      version: 1,
      preset: 'custom',
      densityVehiclesPerKm: 30,
      seed: 'no-reroll',
      maxActors: 24,
      exclusionRadiusM: 2,
      radiusM: 1_000,
      pedestrianShare: 0,
      cyclistShare: 0,
    } as const;
    const pool = createAmbientCandidatePool(graph, profile);
    const before = materializeAmbientCandidatePool(base, graph, pool);
    const victim = before.input.actors.find((actor) => actor.tags.includes('ambient'))!;
    const after = materializeAmbientCandidatePool(base, graph, pool, {
      reservations: [{ x: victim.initial.pose.x, z: victim.initial.pose.z, radiusM: 1 }],
    });
    const beforeById = new Map(before.input.actors.filter((actor) => actor.tags.includes('ambient')).map((actor) => [actor.id, actor]));
    const afterAmbient = after.input.actors.filter((actor) => actor.tags.includes('ambient'));
    expect(afterAmbient.some((actor) => actor.id === victim.id)).toBe(false);
    for (const actor of afterAmbient) {
      const prior = beforeById.get(actor.id);
      if (prior) expect(actor.behavior.route).toEqual(prior.behavior.route);
    }
  });

  it('materializes quickly and uses the same actor physics/routes/signals/collisions as authored actors', () => {
    const profile = {
      version: 1 as const,
      preset: 'custom' as const,
      densityVehiclesPerKm: 20,
      seed: 'performance-parity',
      maxActors: 32,
      radiusM: 1_000,
      pedestrianShare: 0,
      cyclistShare: 0,
    };
    const pool = createAmbientCandidatePool(graph, profile);
    const started = performance.now();
    const generated = materializeAmbientCandidatePool(base, graph, pool);
    expect(performance.now() - started).toBeLessThan(25);
    expect(generated.provenance.screening.evaluated).toBe(false);
    const ambient = generated.input.actors.find((actor) => actor.tags.includes('ambient'))!;
    const authoredTwin = { ...ambient, id: 'authored-twin', tags: [] };
    const ambientTrace = runSimulation({ ...generated.input, actors: [ambient] }, { graph, guards: 'collect' }).trace;
    const authoredTrace = runSimulation({ ...generated.input, actors: [authoredTwin] }, { graph, guards: 'collect' }).trace;
    expect(ambientTrace.ticks.actors[ambient.id]!.x).toEqual(authoredTrace.ticks.actors[authoredTwin.id]!.x);
    expect(ambientTrace.ticks.actors[ambient.id]!.speedMps).toEqual(authoredTrace.ticks.actors[authoredTwin.id]!.speedMps);
  });
});
