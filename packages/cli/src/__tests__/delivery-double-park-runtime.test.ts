/** Exact runtime closure for the Belmont double-parked delivery-van mechanism. */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateMetrics, runSimulation } from '@uniscenarios/sim-engine';

import { checkInvariants } from '../invariants.js';
import { REPO_ROOT, artifactPresence } from '@uniscenarios/scenario-materializer';
import { materialize } from '../materialize.js';
import { matchOnMap } from '@uniscenarios/scenario-materializer';
import { readTemplate } from '@uniscenarios/scenario-materializer';

const MAP = 'belmont-research-center';
const SITE_ID = '767cdf652d9f2cb1';
const SEED = 'e0dbf12ef79d2e754d4d619773b38842722782f5417cc82a03c2f84953701084';
const TEMPLATE = path.join(REPO_ROOT, 'examples', 'mechanisms', 'parking-transit', 'delivery-double-park.template.json');
const present = artifactPresence(MAP);
const haveArtifacts = present.topologyIndex && present.derivedTopology && present.locations;

describe.skipIf(!haveArtifacts)('delivery double park — exact Belmont runtime', () => {
  it('hard-excludes wider corridors where the curbside reveal geometry cannot close', async () => {
    const template = await readTemplate(TEMPLATE);
    expect(template.anchor.corridor?.throughLanesSameDir).toEqual({
      value: [2, 6], essentiality: 'required',
    });
    const yale = await matchOnMap(template, 'yale-street');
    const falseSite = yale.report.sites.find((candidate) => candidate.siteId === '52627e8af12f5e45');
    expect(falseSite, 'topology may match before executable delivery preflight').toBeDefined();
    expect(() => materialize(template, yale.bundle, falseSite!, { drawIndex: 0 })).toThrowError(
      expect.objectContaining({
        code: 'delivery_geometry_unclosed',
        message: expect.stringMatching(/van\/worker\/pass-path hard eligibility/),
      }),
    );
  }, 90_000);

  it('puts the static van before the worker, proves a reveal conflict, and settles safely', async () => {
    const template = await readTemplate(TEMPLATE);
    const matched = await matchOnMap(template, MAP);
    const site = matched.report.sites.find((candidate) => candidate.siteId === SITE_ID);
    expect(site, `truthful Belmont delivery site ${SITE_ID}`).toBeDefined();

    const { input, manifest } = materialize(template, matched.bundle, site!, { drawIndex: 0, seed: SEED });
    expect(manifest.feasible).toBe(true);
    expect(manifest.issues).toEqual([]);
    const ego = input.actors.find((actor) => actor.id === 'ego')!;
    const van = input.actors.find((actor) => actor.id === 'delivery-vehicle')!;
    const worker = input.actors.find((actor) => actor.id === 'delivery-worker')!;
    expect(van).toMatchObject({ kind: 'van', static: true, initial: { speedMps: 0 } });
    expect(worker).toMatchObject({ kind: 'pedestrian', static: false, behavior: { route: { kind: 'polyline' } } });
    expect(input.occlusionPairs).toContainEqual({
      observer: 'ego', target: 'delivery-worker', occluderId: 'actor:delivery-vehicle',
    });
    expect(manifest.arrival).toContainEqual(expect.objectContaining({
      actorId: 'delivery-worker', referenceActorId: 'ego', converged: true,
    }));

    const distanceFromEgo = (actor: typeof ego): number => Math.hypot(
      actor.initial.pose.x - ego.initial.pose.x,
      actor.initial.pose.z - ego.initial.pose.z,
    );
    expect(distanceFromEgo(van)).toBeLessThan(distanceFromEgo(worker));

    const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
    expect(trace.metrics.collisions).toEqual([]);
    expect(trace.metrics.triggerNeverFired).toEqual([]);
    expect(trace.metrics.clippedCriticality).toBe(false);
    expect(trace.metrics.minPET).toMatchObject({
      pair: expect.arrayContaining(['ego', 'delivery-worker']), value: expect.any(Number),
    });
    expect(trace.metrics.minPET!.value).toBeGreaterThanOrEqual(0.3);
    expect(trace.metrics.minPET!.value).toBeLessThanOrEqual(1.5);
    expect(trace.metrics.minTTC).toMatchObject({
      pair: expect.arrayContaining(['ego', 'delivery-worker']), value: expect.any(Number),
    });
    expect(trace.metrics.minTTC!.value).toBeLessThanOrEqual(3);
    const workerClearance = trace.metrics.minDistance.find(({ pair }) =>
      pair.includes('ego') && pair.includes('delivery-worker'));
    expect(workerClearance).toBeDefined();
    expect(workerClearance!.minDistanceM).toBeGreaterThanOrEqual(0.3);
    expect(trace.metrics.requiredDecelMax.ego).toBeLessThanOrEqual(8);
    expect(trace.metrics.revealToConflict).toMatchObject({
      pair: expect.arrayContaining(['ego', 'delivery-worker']), occluderId: 'actor:delivery-vehicle',
      firstBlockedT: expect.any(Number), losOpenT: expect.any(Number), conflictT: expect.any(Number),
    });
    expect(trace.metrics.revealToConflict!.firstBlockedT).toBeLessThan(trace.metrics.revealToConflict!.losOpenT!);
    expect(trace.metrics.revealToConflict!.losOpenT!).toBeLessThan(trace.metrics.revealToConflict!.conflictT!);

    const findings = evaluateMetrics(trace.metrics, template.choreography.clipSeconds).findings;
    expect(findings).not.toContainEqual(expect.objectContaining({ code: 'out_of_window' }));
    expect(findings).not.toContainEqual(expect.objectContaining({ code: 'trivially_safe' }));
    expect(findings).not.toContainEqual(expect.objectContaining({ code: 'occlusion_unproven' }));

    const egoTrack = trace.ticks.actors.ego!;
    const workerTrack = trace.ticks.actors['delivery-worker']!;
    const finalEgoSpeeds = egoTrack.speedMps.slice(-25);
    expect(Math.max(...finalEgoSpeeds) - Math.min(...finalEgoSpeeds)).toBeLessThan(1e-5);
    expect(Math.hypot(
      egoTrack.x.at(-1)! - egoTrack.x.at(-25)!,
      egoTrack.y.at(-1)! - egoTrack.y.at(-25)!,
    )).toBeGreaterThan(5);
    expect(new Set(workerTrack.x.slice(-25)).size).toBe(1);
    expect(new Set(workerTrack.y.slice(-25)).size).toBe(1);
    expect(new Set(workerTrack.speedMps.slice(-25)).size).toBe(1);

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
  }, 120_000);
});
