/** Semantic rejection and truthful runtime closure for the slow vulnerable lead. */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildLanePathRoute, criticalityWindow, evaluateTrace, runSimulation } from '@uniscenarios/sim-engine';

import { checkInvariants } from '../invariants.js';
import { REPO_ROOT, artifactPresence } from '@uniscenarios/scenario-materializer';
import { materialize } from '../materialize.js';
import { matchOnMap } from '@uniscenarios/scenario-materializer';
import { readTemplate } from '@uniscenarios/scenario-materializer';

const TEMPLATE = path.join(
  REPO_ROOT,
  'examples',
  'mechanisms',
  'remaining',
  'slow-vulnerable-lead.template.json',
);
const EASTERBROOK = 'easterbrook-discovery-school';
const TRUTHFUL_MAP = 'belmont-research-center';
const TRUTHFUL_SITE = 'c648c147b5e8874e';
const CUTOFF_SITE = 'a02eb506deded3fc';
const FRESH_SITE = 'fbeca729e9fb4cab';
const FRESH_SEEDS = [
  'fb1bfffd4f08acd643fb23f8f32be7c8434a5816b130e87c9b7fde373f022810',
  '66918ed6e69cd6c29dd5276699bddc1aa9af52e6c52dee6d4633928d60496837',
  'fa082a83072c718cb4252005a8a385aa1bd594e60c3e0e71ea6d49c6e845819d',
] as const;
const haveArtifacts = [EASTERBROOK, TRUTHFUL_MAP].every((mapId) => {
  const present = artifactPresence(mapId);
  return present.topologyIndex && present.derivedTopology && present.locations;
});

function headingErrorRad(actual: number, expected: number): number {
  return Math.abs(Math.atan2(Math.sin(actual - expected), Math.cos(actual - expected)));
}

describe.skipIf(!haveArtifacts)('slow vulnerable lead — semantic runtime closure', () => {
  it('hard-rejects the three geometrically false Easterbrook candidates', async () => {
    const template = await readTemplate(TEMPLATE);
    const matched = await matchOnMap(template, EASTERBROOK);
    const expected = ['dfd3caefa4e17d79', 'aa9ab11c159421a1', '2e10017e0d34975d'];

    expect(matched.report.sites.map((site) => site.siteId)).not.toEqual(expect.arrayContaining(expected));
    for (const siteId of expected) {
      const site = matched.report.rejected.find((candidate) => candidate.siteId === siteId);
      expect(site, `audited Easterbrook candidate ${siteId}`).toBeDefined();
      expect(site!.bindings.some((binding) => binding.status === 'failed' && binding.notes.some((note) =>
        /requires same (local segment|road section)|heading error/.test(note),
      ))).toBe(true);
    }
  }, 90_000);

  it('retains a co-linear, anti-parallel, fully eligible Belmont encounter', async () => {
    const template = await readTemplate(TEMPLATE);
    const matched = await matchOnMap(template, TRUTHFUL_MAP);
    const site = matched.report.sites.find((candidate) => candidate.siteId === TRUTHFUL_SITE);
    expect(site, `truthful Belmont site ${TRUTHFUL_SITE}`).toBeDefined();
    const { input, manifest } = materialize(template, matched.bundle, site!, { drawIndex: -1 });
    expect(manifest.feasible).toBe(true);
    expect(manifest.issues).toEqual([]);

    const ego = input.actors.find((actor) => actor.id === 'ego')!;
    const lead = input.actors.find((actor) => actor.id === 'slow-road-user')!;
    const oncoming = input.actors.find((actor) => actor.id === 'oncoming-constraint')!;
    const oncomingBinding = site!.bindings.find((binding) => binding.role === 'oncoming-constraint')!;
    const oncomingManifest = manifest.actors.find((actor) => actor.id === 'oncoming-constraint')!;
    expect(oncoming.initial.laneRef?.rsl).toBe(oncomingManifest.laneRsl);
    expect(oncoming.behavior.route).toMatchObject({
      kind: 'lanePath',
      lanes: expect.arrayContaining([oncomingBinding.laneRsl]),
    });
    if (oncoming.behavior.route.kind !== 'lanePath') throw new Error('oncoming route must be lane-bound');
    expect(oncoming.behavior.route.lanes[0]).toBe(oncoming.initial.laneRef?.rsl);
    expect(oncoming.behavior.route.lanes).not.toContain('417:0:-1');
    const oncomingRoute = buildLanePathRoute(matched.bundle.graph, oncoming.behavior.route.lanes);
    expect(oncomingRoute.ok).toBe(true);
    if (!oncomingRoute.ok || !oncoming.initial.laneRef) throw new Error('oncoming route and lane station required');
    const oncomingRouteS = oncomingRoute.route.sOfLaneStorage(
      oncoming.initial.laneRef.rsl,
      oncoming.initial.laneRef.s,
    );
    expect(oncomingRouteS).not.toBeNull();
    expect(oncomingRoute.route.lengthM - oncomingRouteS!).toBeGreaterThan(30);
    expect(lead.kind).toBe('bicycle');
    expect(headingErrorRad(lead.initial.pose.headingRad, ego.initial.pose.headingRad))
      .toBeLessThan(5 * Math.PI / 180);
    expect(headingErrorRad(oncoming.initial.pose.headingRad, ego.initial.pose.headingRad + Math.PI))
      .toBeLessThan(5 * Math.PI / 180);

    const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
    expect(trace.metrics.collisions).toEqual([]);
    const speedLimitKph = matched.bundle.index.lanes[site!.frame.entryLaneRsl]?.speedLimitKph ?? null;
    const residuals = checkInvariants({
      template,
      trace,
      scope: {
        params: manifest.params.values,
        clip: { seconds: template.choreography.clipSeconds },
        lane: speedLimitKph === null ? {} : { speedLimitKph },
      },
      arrival: manifest.arrival,
      speedLimitKph,
    });
    expect(residuals.every((residual) => residual.status === 'held')).toBe(true);
    expect(trace.metrics.minTTC).toMatchObject({
      pair: expect.arrayContaining(['ego', 'slow-road-user']),
      value: expect.any(Number),
    });
  }, 90_000);

  it('fails closed when the bound opposing lane cannot cover the authored station', async () => {
    const template = await readTemplate(TEMPLATE);
    const matched = await matchOnMap(template, TRUTHFUL_MAP);
    const site = [...matched.report.sites, ...matched.report.rejected]
      .find((candidate) => candidate.siteId === CUTOFF_SITE);
    expect(site).toBeDefined();
    expect(site!.bindings.find((binding) => binding.role === 'oncoming-constraint')?.laneRsl).toBe('79:0:1');

    expect(() => materialize(template, matched.bundle, site!, { drawIndex: -1 })).toThrow(
      /role_semantic_projection_failed.*matcher-selected local lane within 12\.00 m/,
    );
  }, 90_000);

  it.each(FRESH_SEEDS)(
    'keeps fresh selected seed %s critical in-window, restores recognition, and settles safely',
    async (seed) => {
      const template = await readTemplate(TEMPLATE);
      const matched = await matchOnMap(template, TRUTHFUL_MAP);
      const site = matched.report.sites.find((candidate) => candidate.siteId === FRESH_SITE);
      expect(site, `fresh catalog site ${FRESH_SITE}`).toBeDefined();
      const { input, manifest } = materialize(template, matched.bundle, site!, { drawIndex: 0, seed });
      const lead = input.actors.find((actor) => actor.id === 'slow-road-user')!;
      expect(lead.kind).toBe('bicycle');

      const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
      const [lo, hi] = criticalityWindow(trace.header.clipSeconds);
      const inWindowTtc = (trace.metrics.criticalitySamples?.ttc ?? [])
        .filter((sample) => sample.pair.includes('ego') && sample.pair.includes('slow-road-user'))
        .flatMap((sample) => sample.t.map((t, index) => ({ t, value: sample.value[index]! })))
        .filter(({ t, value }) => t >= lo && t <= hi && Number.isFinite(value));
      const evaluation = evaluateTrace(trace, { rejectCollisions: true });

      expect(manifest.feasible).toBe(true);
      expect(trace.metrics.collisions).toEqual([]);
      expect(Math.min(...inWindowTtc.map(({ value }) => value))).toBeLessThanOrEqual(3);
      expect(trace.events).toContainEqual(expect.objectContaining({
        kind: 'trigger_fired', interactionId: 'ego-recognizes-vru', actorId: 'ego', verb: 'set',
      }));
      expect(trace.ticks.actors.ego?.present.at(-1)).toBe(1);
      expect(trace.ticks.actors['slow-road-user']?.present.at(-1)).toBe(1);
      expect(trace.ticks.actors.ego?.speedMps.at(-1)).toBeGreaterThanOrEqual(0);
      expect(evaluation, JSON.stringify(evaluation.findings)).toMatchObject({ verdict: 'accept', findings: [] });
    },
    90_000,
  );
});
