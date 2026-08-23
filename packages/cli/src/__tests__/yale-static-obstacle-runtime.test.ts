/** Exact fresh-campaign closure for Yale's collidable static hazards. */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateMetrics, runSimulation } from '@uniscenarios/sim-engine';

import { checkInvariants } from '../invariants.js';
import { REPO_ROOT, artifactPresence } from '@uniscenarios/scenario-materializer';
import { materialize } from '../materialize.js';
import { matchOnMap } from '@uniscenarios/scenario-materializer';
import { readTemplate } from '@uniscenarios/scenario-materializer';

const MAP = 'yale-street';
const DIRECTORY = path.join(REPO_ROOT, 'examples', 'mechanisms', 'obstacle');
const present = artifactPresence(MAP);
const haveArtifacts = present.topologyIndex && present.derivedTopology && present.locations;

const CASES = [
  {
    file: 'fallen-cargo.template.json',
    siteId: '317a3834a46e7f43',
    actorId: 'cargo',
    kind: 'static_object',
    seeds: [
      '0b24f1ffbfd34556bc756a0d1836d742c7b191d9ec69d8f47a50fbb4a9f2db2f',
      '456666e9bf6e44c2636e31d10e77073d48936cc719f1018ff13b8e30bbaef204',
      'addc614ba349d1ccfd67d09c352e4c34980e8bee7d563bd67a57b6dd7cb6996a',
    ],
  },
  {
    file: 'disabled-vehicle.template.json',
    siteId: '6764d40bb39c30ae',
    actorId: 'disabled-vehicle',
    kind: 'car',
    seeds: [
      '87d21aadba1170b901ec1d15643a32638c77ef14625ee70212a2041587121903',
      '3854f2c671d2f7bc5bc1f75879f9b60cf24a0ede7ec001262e9c4f514c6b25b3',
      '3af3a23ff80d08216984adc625290ce81593d90c3c369223c366552ea9e5cf76',
    ],
  },
] as const;

describe.skipIf(!haveArtifacts)('Yale static-obstacle exact runtimes', () => {
  it.each(CASES)('$actorId is collidable, critical, collision-free, and settled for every preserved attempt', async (entry) => {
    const template = await readTemplate(path.join(DIRECTORY, entry.file));
    const matched = await matchOnMap(template, MAP);
    const site = matched.report.sites.find((candidate) => candidate.siteId === entry.siteId);
    expect(site).toBeDefined();

    for (let drawIndex = 0; drawIndex < entry.seeds.length; drawIndex += 1) {
      const { input, manifest } = materialize(template, matched.bundle, site!, {
        drawIndex,
        seed: entry.seeds[drawIndex],
      });
      expect(manifest.feasible).toBe(true);
      expect(input.actors.find((actor) => actor.id === entry.actorId)).toMatchObject({
        kind: entry.kind,
        static: true,
      });

      const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
      expect(trace.metrics.collisions).toEqual([]);
      const evaluation = evaluateMetrics(trace.metrics, template.choreography.clipSeconds, { rejectCollisions: true });
      expect(evaluation.findings).toEqual([]);
      expect(evaluation.summary.criticality).toBeGreaterThanOrEqual(0.5);
      expect(evaluation.summary.criticality).toBeLessThanOrEqual(3);
      expect(trace.ticks.actors.ego!.speedMps.at(-1)).toBe(0);

      const residuals = checkInvariants({
        template,
        trace,
        scope: { params: manifest.params.values, clip: { seconds: template.choreography.clipSeconds } },
        arrival: manifest.arrival,
        speedLimitKph: matched.bundle.index.lanes[site!.frame.entryLaneRsl]?.speedLimitKph ?? null,
      });
      expect(residuals.every((residual) => residual.status === 'held'), JSON.stringify(residuals)).toBe(true);
    }
  }, 120_000);
});
