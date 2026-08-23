/** Exact regressions for the control/arrival failures preserved by campaign 688dd78d. */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateTrace, runSimulation } from '@uniscenarios/sim-engine';

import { checkInvariants } from '../invariants.js';
import { REPO_ROOT, artifactPresence } from '@uniscenarios/scenario-materializer';
import { materialize } from '../materialize.js';
import { matchOnMap } from '@uniscenarios/scenario-materializer';
import { readTemplate } from '@uniscenarios/scenario-materializer';

const MAP = 'yale-street';
const present = artifactPresence(MAP);
const haveArtifacts = present.topologyIndex && present.derivedTopology && present.locations;

const CASES = [
  {
    id: 'ltap',
    file: path.join(REPO_ROOT, 'examples', 'ltap-opposing.template.json'),
    siteId: 'f21b5a603ce99a14',
    seeds: [
      '2ce9c8a7c63689be84b7e487e87f1afd175581bb34a75e011c78ab39f68a9929',
      '3764f487aa7d6c9b9500e2fe021a5dfd3c6929928d6137fe840d41db35c79b38',
      'ca7fe59f408c1b4ea10f67577ae035b304f1041dcfa9e29823e2d98d9bc98463',
    ],
    pair: ['ego', 'oncoming'],
  },
  {
    id: 'blocked-box',
    file: path.join(REPO_ROOT, 'examples', 'mechanisms', 'junction-vru', 'intersection-blocked-box-reveal.template.json'),
    siteId: '1d8174d22276a1b5',
    seeds: [
      '61031c79b08f37a2fb0dce5e86ef2d2e15d6e9521d26553d21ad455360b1249e',
      '1b7a0a3e832cd52097f5b0c507a45b7b58fd1d1d941e229e9580ad72eef7860b',
      '74fc56ddbf8c7bcaf34314ae47e3b5afd6a97ac663db51862156f0e870603df5',
    ],
    pair: ['cross-traffic', 'ego'],
  },
  {
    id: 'multiple-threat',
    file: path.join(REPO_ROOT, 'examples', 'multiple-threat.template.json'),
    siteId: 'ba43e6994bee9bf2',
    seeds: [
      '803fcbb6d392f5eebd65d97218ef4f49a1bc5a1fbada6d0f432acd220ee7ebb4',
      'd1678a9c5d7c3be1093d7889b29e2e28da0d857c37e3579724737f30b3593981',
      '08cef45fdd2ce07336ffcb015fbccc637ff51dc08d49e7337b2786f37cd275c6',
    ],
    pair: ['ego', 'ped'],
  },
  {
    id: 'reversing-pedestrian',
    file: path.join(REPO_ROOT, 'examples', 'mechanisms', 'remaining', 'reversing-pedestrian.template.json'),
    siteId: '2dee4f73e92f110f',
    seeds: [
      'dae3fedc20e61a3b438db025fbaf69aae08884c51519709b4cee4e47226660f3',
      'c0d2ee3aff1ab1304c5fc5afdb2469a90d04d3ecccea81f3ed9791e4e6059e25',
      '14fb2a7c77f04488e49b4663c338e9470e997d79606f6c8a560072ee936ec110',
    ],
    pair: ['ego', 'pedestrian'],
  },
] as const;

describe.skipIf(!haveArtifacts)('campaign 688dd78d exact arrival/control regressions', () => {
  it.each(CASES)('$id keeps all preserved draws truthful and collision-free', async ({ id, file, siteId, seeds, pair }) => {
    const template = await readTemplate(file);
    const matched = await matchOnMap(template, MAP);
    const site = matched.report.sites.find((candidate) => candidate.siteId === siteId);
    expect(site, `${id} exact site ${siteId}`).toBeDefined();

    for (const seed of seeds) {
      const { input, manifest } = materialize(template, matched.bundle, site!, { seed, drawIndex: 0 });
      const { trace, issues } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
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

      expect(manifest.feasible, seed).toBe(true);
      expect(manifest.arrival.every((arrival) => arrival.converged), seed).toBe(true);
      expect(issues.filter((issue) => issue.severity === 'error'), seed).toEqual([]);
      expect(trace.metrics.collisions, seed).toEqual([]);
      expect(trace.metrics.minDistance).toContainEqual(expect.objectContaining({
        pair: expect.arrayContaining([...pair]),
      }));
      expect(residuals.filter((residual) => residual.essentiality === 'required' && residual.status !== 'held'), seed).toEqual([]);
      expect(evaluateTrace(trace, { rejectCollisions: true }), seed).toMatchObject({ verdict: 'accept', findings: [] });

      if (id === 'ltap') {
        expect(input.signalPrograms.filter((program) => program.mapBinding)).not.toEqual([]);
        expect(input.signalPrograms.filter((program) => program.mapBinding).every((program) =>
          program.mapBinding?.timingSource === 'synthetic-default')).toBe(true);
      } else if (id === 'blocked-box') {
        expect(trace.metrics.declaredOcclusion).toContainEqual(expect.objectContaining({
          observer: 'ego', target: 'cross-traffic', status: 'revealed_before_conflict',
        }));
        expect(trace.metrics.revealToConflict?.value).toBeGreaterThan(2);
      } else if (id === 'multiple-threat') {
        expect(trace.metrics.declaredOcclusion).toContainEqual(expect.objectContaining({
          observer: 'ego', target: 'ped', status: 'revealed_before_conflict',
        }));
      } else {
        expect(input.actors.find((actor) => actor.id === 'ego')?.tags).toContain('motion:reverse');
        expect(trace.metrics.minPathTTC?.value).toBeGreaterThanOrEqual(0.2);
        expect(trace.metrics.minPathTTC?.value).toBeLessThanOrEqual(3);
      }
    }
  }, 90_000);
});
