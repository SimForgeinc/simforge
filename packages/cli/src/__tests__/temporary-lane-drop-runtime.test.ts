/** Exact-site execution closure for the scenario-authored temporary lane drop. */
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateTrace, runSimulation } from '@simforge/engine';

import { filtersFor } from '../commands/evaluate.js';
import { checkInvariants } from '../invariants.js';
import { artifactPresence, REPO_ROOT } from '@simforge/compiler/node';
import { materialize } from '../materialize.js';
import { matchOnMap } from '@simforge/compiler/node';
import { readTemplate } from '@simforge/compiler/node';

const MAP = 'el-camino-road';
const SITE = '0a8fc7e0ff2a6cad';
const FILE = path.join(REPO_ROOT, 'examples', 'mechanisms', 'remaining', 'lane-drop-late-merge.template.json');
const SEEDS = ['temporary-drop-0', 'temporary-drop-1', 'temporary-drop-2'] as const;
const present = artifactPresence(MAP);
const haveMap = present.topologyIndex && present.derivedTopology && present.locations;

describe.skipIf(!haveMap)('temporary lane-drop late merge', () => {
  it('binds the exact work-zone corridor and materializes physical authored control', async () => {
    const template = await readTemplate(FILE);
    const matched = await matchOnMap(template, MAP, { maxSites: 100 });
    const site = matched.report.sites.find((candidate) => candidate.siteId === SITE);
    expect(site).toMatchObject({
      degradation: { verdict: 'exact' },
      featureMatches: {
        'temporary-closure-reservation': {
          mapFeatureId: 'loc_0788193232cb4f515e1c4622', kind: 'work_zone_suitable',
        },
      },
    });
    const concrete = materialize(template, matched.bundle, site!, { seed: SEEDS[0], drawIndex: 0 });
    expect(concrete.manifest.issues).toEqual([]);
    expect(concrete.input.actors.find((actor) => actor.id === 'ego')?.initial.laneRef?.rsl)
      .not.toBe(concrete.input.actors.find((actor) => actor.id === 'late-merger')?.initial.laneRef?.rsl);
    expect(concrete.input.actors.find((actor) => actor.id === 'terminal-channelizer')).toMatchObject({
      kind: 'static_object', static: true,
    });
    expect(concrete.input.props).toHaveLength(8);
    expect(concrete.input.props.every((prop) => prop.collidable)).toBe(true);
    expect(concrete.input.signalPrograms).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'control:closing-lane-red-x',
        phases: [{ phase: 'red_x', durationS: 12 }],
      }),
    ]));
  }, 90_000);

  it.each(SEEDS)('is collision-free, critical, and stable for %s', async (seed) => {
    const template = await readTemplate(FILE);
    const matched = await matchOnMap(template, MAP, { maxSites: 100 });
    const site = matched.report.sites.find((candidate) => candidate.siteId === SITE)!;
    const concrete = materialize(template, matched.bundle, site, { seed, drawIndex: SEEDS.indexOf(seed) });
    const simulation = runSimulation(concrete.input, { graph: matched.bundle.graph, guards: 'collect' });
    expect(concrete.manifest.issues).toEqual([]);
    expect(simulation.issues).toEqual([]);
    expect(simulation.trace.metrics.collisions).toEqual([]);
    expect(simulation.trace.metrics.triggerNeverFired).toEqual([]);
    expect(simulation.trace.metrics.minTTC).toMatchObject({
      pair: expect.arrayContaining(['ego', 'late-merger']), value: expect.any(Number),
    });
    expect(simulation.trace.metrics.minTTC!.value).toBeGreaterThanOrEqual(0.2);
    expect(simulation.trace.metrics.minTTC!.value).toBeLessThanOrEqual(3);
    expect(simulation.trace.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        interactionId: 'merge-at-temporary-taper', kind: 'released', reason: 'complete',
      }),
    ]));

    const speedLimitKph = matched.bundle.index.lanes[site.frame.entryLaneRsl]?.speedLimitKph ?? null;
    const residuals = checkInvariants({
      template,
      trace: simulation.trace,
      scope: {
        params: concrete.manifest.params.values,
        clip: { seconds: template.choreography.clipSeconds },
        ...(speedLimitKph === null ? {} : { lane: { speedLimitKph } }),
      },
      arrival: concrete.manifest.arrival,
      speedLimitKph,
    });
    expect(residuals.filter((entry) => entry.essentiality === 'required' && entry.status !== 'held')).toEqual([]);
    expect(evaluateTrace(simulation.trace, filtersFor('critical', { rejectCollisions: true }))).toMatchObject({
      verdict: 'accept', findings: [],
    });

    const ego = simulation.trace.ticks.actors.ego!;
    const merger = simulation.trace.ticks.actors['late-merger']!;
    const last = ego.x.length - 1;
    expect(ego.present[last]).toBe(1);
    expect(merger.present[last]).toBe(1);
    expect(Math.hypot(ego.x[last]! - merger.x[last]!, ego.y[last]! - merger.y[last]!)).toBeGreaterThan(10);
  }, 90_000);
});
