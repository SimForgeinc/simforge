/** Exact multiple-threat closure: mapped crossing, queue reveal, and arrival. */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateTrace, runSimulation } from '@simforge/engine';

import { REPO_ROOT, artifactPresence } from '@simforge/compiler';
import { materialize } from '../materialize.js';
import { matchOnMap } from '@simforge/compiler';
import { readTemplate } from '@simforge/compiler';

const MAP = 'yale-street';
const TEMPLATE = path.join(REPO_ROOT, 'examples', 'multiple-threat.template.json');
const present = artifactPresence(MAP);
const haveArtifacts = present.topologyIndex && present.derivedTopology && present.locations;

describe.skipIf(!haveArtifacts)('multiple-threat — exact Yale runtime', () => {
  it('binds the pedestrian to the mapped crossing and proves queue reveal before conflict', async () => {
    const template = await readTemplate(TEMPLATE);
    const matched = await matchOnMap(template, MAP);
    const site = matched.report.sites.find((candidate) => candidate.siteId === '1c751b957d99f426');
    expect(site).toBeDefined();

    const { input, manifest } = materialize(template, matched.bundle, site!);
    expect(input.actors.find((actor) => actor.id === 'ped')).toMatchObject({
      kind: 'pedestrian',
      static: false,
      behavior: { route: { kind: 'polyline' } },
    });
    expect(input.props.filter((prop) => prop.groupId === 'stopped-queue')).toHaveLength(4);
    expect(input.occlusionPairs).toContainEqual({
      observer: 'ego', target: 'ped', occluderId: 'stopped-queue',
    });
    expect(manifest.arrival.find((arrival) => arrival.actorId === 'ped')).toMatchObject({
      converged: true,
      targetDeltaT: -1.775,
      achievedDeltaT: expect.closeTo(-1.775, 3),
    });

    const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
    expect(trace.metrics.minPET).toMatchObject({ pair: expect.arrayContaining(['ego', 'ped']) });
    expect(trace.metrics.minPET!.value).toBeGreaterThanOrEqual(0.2);
    expect(trace.metrics.minPET!.value).toBeLessThanOrEqual(3);
    expect(trace.metrics.declaredOcclusion).toContainEqual(expect.objectContaining({
      observer: 'ego', target: 'ped', occluderId: 'stopped-queue',
      status: 'revealed_before_conflict',
      revealToConflictS: expect.any(Number),
    }));
    expect(trace.metrics.triggerNeverFired).toEqual([]);
    expect(trace.metrics.collisions).toEqual([]);
    expect(evaluateTrace(trace)).toMatchObject({ verdict: 'accept', findings: [] });
  }, 30_000);

  it('hard-rejects the old smoke site whose adjacent route never reaches the crossing', async () => {
    const template = await readTemplate(TEMPLATE);
    const matched = await matchOnMap(template, MAP);
    const site = matched.report.sites.find((candidate) => candidate.siteId === '9682a3e5610ef04a');
    expect(site).toBeDefined();
    expect(() => materialize(template, matched.bundle, site!)).toThrow(expect.objectContaining({
      code: 'arrival_unconverged',
      path: 'interactions.ped-reaches-the-ego-lane.trigger.arrival',
    }));
  }, 30_000);
});
