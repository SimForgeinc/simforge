/** Exact runtime closure for the cyclist dooring mechanism. */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveExactCorridorSite } from '@uniscenarios/anchor-matcher';
import { runSimulation } from '@uniscenarios/sim-engine';

import { adaptTemplate } from '../adapt.js';
import { checkInvariants } from '../invariants.js';
import { REPO_ROOT, artifactPresence, loadMap } from '../maps.js';
import { materialize } from '../materialize.js';
import { readTemplate } from '../template-io.js';

const MAP = 'yale-street';
const SITE_ID = '2d295212b00a36ba';
const ORIGIN_SEGMENT = 'seg_b800c7dff6274e2e';
const SEED = '704b8fe40808ac6c1ebf4101c90cf3b4bb85f7111c183a19b1aacc84331f3c2b';
const TEMPLATE = path.join(REPO_ROOT, 'examples', 'mechanisms', 'remaining', 'dooring-cyclist.template.json');
const present = artifactPresence(MAP);
const haveArtifacts = present.topologyIndex && present.derivedTopology && present.locations;

describe.skipIf(!haveArtifacts)('dooring cyclist — exact Yale runtime', () => {
  it('places the bicycle in the left-door sweep and records a door-zone TTC', async () => {
    const template = await readTemplate(TEMPLATE);
    const bundle = await loadMap(MAP);
    const adapted = adaptTemplate(template);
    const site = resolveExactCorridorSite(adapted.anchor, bundle.index, ORIGIN_SEGMENT, { roles: adapted.roles, scope: adapted.scope });
    expect(site).toMatchObject({ siteId: SITE_ID, mapId: MAP, score: 1 });
    const { input, manifest } = materialize(template, bundle, site!, { drawIndex: 0, seed: SEED });
    expect(manifest.feasible).toBe(true);
    expect(manifest.issues).toEqual([]);
    expect(input.actors.find((actor) => actor.id === 'cyclist')?.kind).toBe('bicycle');
    expect(input.actors.find((actor) => actor.id === 'parked-car')).toMatchObject({ kind: 'car', static: true });

    const { trace } = runSimulation(input, { graph: bundle.graph, guards: 'collect' });
    expect(trace.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'state_set', actorId: 'parked-car', key: 'doors.left', value: 'opening' }),
      expect.objectContaining({ kind: 'state_set', actorId: 'parked-car', key: 'doors.left', value: 'open' }),
    ]));
    expect(trace.metrics.minTTC).toMatchObject({
      pair: expect.arrayContaining(['cyclist', 'parked-car']),
      value: expect.any(Number),
    });
    expect(trace.metrics.minTTC!.value).toBeGreaterThanOrEqual(0.2);
    expect(trace.metrics.minTTC!.value).toBeLessThanOrEqual(3);
    expect(trace.metrics.minPathTTC).toMatchObject({
      pair: expect.arrayContaining(['cyclist', 'parked-car']),
      value: expect.any(Number),
    });
    expect(trace.metrics.minPathTTC!.value).toBeGreaterThanOrEqual(0.2);
    expect(trace.metrics.minPathTTC!.value).toBeLessThanOrEqual(3);
    expect(trace.metrics.collisions).toEqual([]);
    expect(trace.ticks.actors.cyclist!.speedMps.at(-1)).toBe(0);
    const speedLimitKph = bundle.index.lanes[site!.frame.entryLaneRsl]?.speedLimitKph ?? null;
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
    expect(residuals).toEqual([expect.objectContaining({ id: 'door-zone-criticality', status: 'held' })]);
  }, 120_000);
});
