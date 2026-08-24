/** Exact runtime closure for a reversing vehicle yielding across a pedestrian path. */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSimulation } from '@simforge/engine';

import { checkInvariants } from '../invariants.js';
import { REPO_ROOT, artifactPresence } from '@simforge/compiler/node';
import { materialize } from '../materialize.js';
import { matchOnMap } from '@simforge/compiler/node';
import { readTemplate } from '@simforge/compiler/node';

const MAP = 'yale-street';
const SITE_ID = '0cf36401b44b00cd';
const SEED = 'c91e6da0305369eebbdaf3a2d6656d691135439ded49e95b7b3d6c7f50b568d1';
const TEMPLATE = path.join(REPO_ROOT, 'examples', 'mechanisms', 'remaining', 'reversing-pedestrian.template.json');
const present = artifactPresence(MAP);
const haveArtifacts = present.topologyIndex && present.derivedTopology && present.locations;

describe.skipIf(!haveArtifacts)('reversing pedestrian — exact Yale runtime', () => {
  it('backs rear-first, yields at one physical path crossing, and settles without collision', async () => {
    const template = await readTemplate(TEMPLATE);
    const matched = await matchOnMap(template, MAP);
    const site = matched.report.sites.find((candidate) => candidate.siteId === SITE_ID);
    expect(site, `truthful Yale reversing-pedestrian site ${SITE_ID}`).toBeDefined();

    const { input, manifest } = materialize(template, matched.bundle, site!, { seed: SEED });
    expect(manifest.feasible).toBe(true);
    expect(manifest.params.values).toMatchObject({
      reverseSpeedKph: 3.5,
      pedestrianSpeedKph: 5,
      arrivalTtc: 1.5,
    });
    expect(manifest.arrival).toContainEqual(expect.objectContaining({
      actorId: 'pedestrian',
      referenceActorId: 'ego',
      targetDeltaT: -1.5,
      converged: true,
    }));

    const ego = input.actors.find((actor) => actor.id === 'ego')!;
    const pedestrian = input.actors.find((actor) => actor.id === 'pedestrian')!;
    expect(ego).toMatchObject({ kind: 'car', tags: expect.arrayContaining(['motion:reverse']) });
    expect(pedestrian).toMatchObject({ kind: 'pedestrian' });
    expect(ego.behavior.route.kind).toBe('polyline');
    expect(pedestrian.behavior.route.kind).toBe('polyline');

    const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
    expect(trace.metrics.collisions).toEqual([]);
    expect(trace.metrics.triggerNeverFired).toEqual([]);
    expect(trace.metrics.clippedCriticality).toBe(false);
    expect(trace.metrics.minPathTTC).toMatchObject({
      pair: ['ego', 'pedestrian'],
      value: expect.closeTo(0.80196, 5),
      t: expect.closeTo(3.38, 2),
    });

    const egoTrack = trace.ticks.actors.ego!;
    const pedestrianTrack = trace.ticks.actors.pedestrian!;
    expect(new Set(egoTrack.motionDirection)).toEqual(new Set([-1]));
    expect(new Set(egoTrack.x.slice(-25)).size).toBe(1);
    expect(new Set(egoTrack.y.slice(-25)).size).toBe(1);
    expect(new Set(egoTrack.speedMps.slice(-25)).size).toBe(1);
    expect(new Set(pedestrianTrack.x.slice(-25)).size).toBe(1);
    expect(new Set(pedestrianTrack.y.slice(-25)).size).toBe(1);
    expect(new Set(pedestrianTrack.speedMps.slice(-25)).size).toBe(1);
    expect(trace.header.actorMetadata?.pedestrian?.kind).toBe('pedestrian');

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
