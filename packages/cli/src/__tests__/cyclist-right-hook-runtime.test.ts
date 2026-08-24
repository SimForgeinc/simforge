/** Exact runtime closure for the cyclist right-hook mechanism. */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateTrace, runSimulation } from '@simforge/engine';

import { checkInvariants } from '../invariants.js';
import { REPO_ROOT, artifactPresence } from '@simforge/compiler/node';
import { materialize } from '../materialize.js';
import { matchOnMap } from '@simforge/compiler/node';
import { readTemplate } from '@simforge/compiler/node';

const YALE_MAP = 'yale-street';
const YALE_SITE_ID = '810c8b2fbab4be67';
const YALE_SEEDS = [
  '6a45b16fade09d4f895f7ba6737ddfce17d9dca2ff350b72e891d27d6dd1f5d3',
  'e5dc088cd2a24542cc3a9ff3db7affb913c562ff1bcfedae58bd2a158b3aefbb',
  '22332e7ed2bb38ed5fbb2858dca85a1a772fcc0654c1251540b42b2450775598',
] as const;
const TEMPLATE = path.join(REPO_ROOT, 'examples', 'mechanisms', 'remaining', 'cyclist-right-hook.template.json');
const yalePresent = artifactPresence(YALE_MAP);
const haveYaleArtifacts = yalePresent.topologyIndex && yalePresent.derivedTopology && yalePresent.locations;

describe.skipIf(!haveYaleArtifacts)('cyclist right hook — fresh Yale catalog slot', () => {
  it.each(YALE_SEEDS)('keeps seed %s critical, collision-free, and in-window', async (seed) => {
    const template = await readTemplate(TEMPLATE);
    const matched = await matchOnMap(template, YALE_MAP);
    const site = matched.report.sites.find((candidate) => candidate.siteId === YALE_SITE_ID);
    expect(site, `fresh catalog site ${YALE_SITE_ID}`).toBeDefined();

    const { input, manifest } = materialize(template, matched.bundle, site!, { drawIndex: 0, seed });
    const cyclist = input.actors.find((actor) => actor.id === 'cyclist')!;
    const ego = input.actors.find((actor) => actor.id === 'ego')!;
    expect(cyclist.kind).toBe('bicycle');
    expect(cyclist.behavior.route.kind).toBe('lanePath');
    expect(ego.behavior.route.kind).toBe('lanePath');
    if (cyclist.behavior.route.kind !== 'lanePath' || ego.behavior.route.kind !== 'lanePath') {
      throw new Error('right-hook actors must remain lane-bound');
    }
    const cyclistLanes = cyclist.behavior.route.lanes;
    const egoLanes = ego.behavior.route.lanes;
    const shared = cyclistLanes.find((lane) => egoLanes.includes(lane));
    expect(shared).toBeDefined();
    expect(cyclistLanes.at(-1)).not.toBe(egoLanes.at(-1));

    const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
    const evaluation = evaluateTrace(trace, { rejectCollisions: true });
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
    expect(manifest.feasible).toBe(true);
    expect(residuals.every((residual) => residual.status === 'held')).toBe(true);
    expect(trace.metrics.collisions).toEqual([]);
    expect(trace.metrics.minPET?.value).toBeGreaterThanOrEqual(0.2);
    expect(trace.metrics.minPET?.value).toBeLessThanOrEqual(3);
    expect(trace.ticks.actors.cyclist?.present.at(-1)).toBe(1);
    expect(trace.ticks.actors.ego?.present.at(-1)).toBe(1);
    expect(evaluation, JSON.stringify(evaluation.findings)).toMatchObject({ verdict: 'accept', findings: [] });
  }, 60_000);
});
