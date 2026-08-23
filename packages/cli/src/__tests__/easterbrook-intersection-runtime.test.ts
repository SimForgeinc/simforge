/** Exact regressions for truthful Easterbrook intersection conflicts. */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSimulation } from '@uniscenarios/sim-engine';

import { REPO_ROOT, artifactPresence } from '@uniscenarios/scenario-materializer';
import { materialize } from '../materialize.js';
import { matchOnMap } from '@uniscenarios/scenario-materializer';
import { readTemplate } from '@uniscenarios/scenario-materializer';

const MAP = 'easterbrook-discovery-school';
const DIRECTORY = path.join(REPO_ROOT, 'examples', 'mechanisms', 'remaining');
const present = artifactPresence(MAP);
const haveArtifacts = present.topologyIndex && present.derivedTopology && present.locations;

describe.skipIf(!haveArtifacts)('exact Easterbrook intersection mechanisms', () => {
  it('rejects the inverted Easterbrook stop assignment at movement level', async () => {
    const template = await readTemplate(path.join(DIRECTORY, 'cross-traffic-stop-violation.template.json'));
    const matched = await matchOnMap(template, MAP);
    const site = matched.report.sites.find((candidate) => candidate.siteId === '7d84024ee796fff8');
    expect(site).toBeDefined();

    expect(() => materialize(template, matched.bundle, site!, { drawIndex: 0, seed: 'cross-stop-0' }))
      .toThrow(expect.objectContaining({
        code: 'movement_priority_missing',
        path: 'roles.ego.requiredMovementControl',
        detail: expect.objectContaining({ gateId: '11302:3:2-1' }),
      }));

    const violator = template.roles.find((role) => role.id === 'violator')!;
    const ego = template.roles.find((role) => role.id === 'ego')!;
    const violatorFirst = { ...template, roles: [violator, ego] };
    expect(() => materialize(violatorFirst, matched.bundle, site!, { drawIndex: 0, seed: 'cross-stop-0' }))
      .toThrow(expect.objectContaining({
        code: 'movement_stop_missing',
        path: 'roles.violator.requiredMovementControl',
        detail: expect.objectContaining({ gateId: '11302:23:1-1' }),
      }));
  }, 30_000);

  it('executes, recentres, and clears the exact opposing-turn site within truthful runway', async () => {
    const template = await readTemplate(path.join(DIRECTORY, 'opposing-turn-encroachment.template.json'));
    const matched = await matchOnMap(template, MAP);
    const site = matched.report.sites.find((candidate) => candidate.siteId === 'bb1f398b3d0d07b6');
    expect(site).toBeDefined();

    const { input, manifest } = materialize(template, matched.bundle, site!, {
      drawIndex: 1,
      seed: '9280e93558391e3ca6479eba9129d4b0cd5bbf4deda7594e668bae3adaed5204',
    });
    expect(manifest.feasible).toBe(true);
    expect(manifest.issues).toEqual([]);
    expect(manifest.arrival.find((arrival) => arrival.actorId === 'encroaching-turner')?.converged).toBe(true);

    const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
    const cut = trace.events.find(
      (event) => event.kind === 'trigger_fired' && event.interactionId === 'cuts-apex',
    );
    const recover = trace.events.find(
      (event) => event.kind === 'trigger_fired' && event.interactionId === 'turner-recentres',
    );
    expect(cut).toMatchObject({ actorId: 'encroaching-turner', verb: 'laneOffset', t: expect.any(Number) });
    expect(recover).toMatchObject({ actorId: 'encroaching-turner', verb: 'laneOffset', t: expect.any(Number) });
    expect((recover as { t: number }).t - (cut as { t: number }).t).toBeCloseTo(1.8, 6);
    expect((recover as { t: number }).t + 1.2).toBeLessThanOrEqual(template.choreography.clipSeconds - 1.9);
    expect(trace.metrics.minPET).toMatchObject({ pair: expect.arrayContaining(['ego', 'encroaching-turner']) });
    expect(trace.metrics.minPET!.value).toBeGreaterThanOrEqual(0.2);
    expect(trace.metrics.minPET!.value).toBeLessThanOrEqual(3);
    expect(trace.metrics.collisions).toEqual([]);
  }, 30_000);
});
