/** Exact runtime closure for the stratified Yale bus-stop emergence draw. */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateMetrics, runSimulation } from '@simforge/engine';

import { checkInvariants } from '../invariants.js';
import { REPO_ROOT, artifactPresence } from '@simforge/compiler';
import { materialize } from '../materialize.js';
import { matchOnMap } from '@simforge/compiler';
import { readTemplate } from '@simforge/compiler';

const MAP = 'yale-street';
const SITE_ID = 'fa9fa19457cf576f';
const SEED = '8903ac83c04ac8af2127fa3867de3462900bd8a9468153ac4392d45dc5fc6672';
const TEMPLATE = path.join(REPO_ROOT, 'examples', 'bus-stop-emergence.template.json');
const present = artifactPresence(MAP);
const haveArtifacts = present.topologyIndex && present.derivedTopology && present.locations;

describe.skipIf(!haveArtifacts)('bus-stop emergence — exact Yale runtime', () => {
  it('keeps the real dwelling bus, folded alighting route, and delayed critical episode truthful', async () => {
    const template = await readTemplate(TEMPLATE);
    const matched = await matchOnMap(template, MAP);
    const site = matched.report.sites.find((candidate) => candidate.siteId === SITE_ID);
    expect(site, `truthful Yale bus-stop site ${SITE_ID}`).toBeDefined();
    expect(site!.featureMatches.stop?.mapFeatureId).toBe('loc_92ea6eb02738f97c3061a3cd');

    const { input, manifest } = materialize(template, matched.bundle, site!, { drawIndex: 0, seed: SEED });
    const bus = input.actors.find((actor) => actor.id === 'bus')!;
    const ego = input.actors.find((actor) => actor.id === 'ego')!;
    const ped = input.actors.find((actor) => actor.id === 'ped')!;
    expect(manifest.params.values).toMatchObject({
      arrivalTtc: expect.closeTo(1.5190551705658437, 10),
      pedSpeedKph: expect.closeTo(8.473804399487562, 10),
      busGapM: expect.closeTo(11.795444837072864, 10),
    });
    expect(bus).toMatchObject({ kind: 'bus', static: true, initial: { speedMps: 0 } });
    expect(ego.behavior.route).toMatchObject({ kind: 'lanePath' });
    expect(ped.behavior.route).toMatchObject({ kind: 'polyline' });
    expect(input.occlusionPairs).toContainEqual({ observer: 'ego', target: 'ped', occluderId: 'actor:bus' });
    expect(manifest.notes).toContainEqual(expect.objectContaining({
      path: 'choreography.interactions.ped-rounds-the-bus',
      reason: expect.stringContaining('folded into ped'),
    }));

    const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
    const occlusion = trace.metrics.revealToConflict;
    expect(occlusion).toMatchObject({ pair: ['ego', 'ped'], occluderId: 'actor:bus' });
    expect(occlusion!.firstBlockedT).toBe(0);
    expect(occlusion!.losOpenT).toBeGreaterThan(3);
    expect(occlusion!.conflictT).toBeGreaterThan(6);
    expect(occlusion!.conflictT).toBeLessThan(7);
    expect(trace.metrics.minDistance).toContainEqual(expect.objectContaining({
      pair: ['ego', 'ped'],
      t: expect.closeTo(6.58, 2),
    }));
    expect(trace.metrics.collisions).toEqual([]);
    const findings = evaluateMetrics(trace.metrics, template.choreography.clipSeconds).findings;
    expect(findings).not.toContainEqual(expect.objectContaining({ code: 'out_of_window' }));
    expect(findings).not.toContainEqual(expect.objectContaining({ code: 'trivially_safe' }));

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
  }, 90_000);
});
