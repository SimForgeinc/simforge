/** Exact-site physics closure for the three lane-change catalog mechanisms. */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateTrace, runSimulation } from '@simforge/engine';
import type { ScenarioTemplateV2 } from '@simforge/scenario';

import { filtersFor } from '../commands/evaluate.js';
import { checkInvariants } from '../invariants.js';
import { REPO_ROOT, artifactPresence } from '@simforge/compiler';
import { materialize } from '../materialize.js';
import { matchOnMap } from '@simforge/compiler';
import { readTemplate } from '@simforge/compiler';

const MAP_ID = 'belmont-research-center';
const MERGE_MAP_ID = 'yale-street';
const MERGE_CAMPAIGN_MAP_ID = 'el-camino-road';
const SIDESWIPE_SEEDS = [
  '489f9d77419a4f82cc8042fc3482c9c282d5d0e81ec85f119c636f70983710f8',
  '01e16d4d1334d5a1f2ba41bd0fa11f19431670d81094b583c466e19b2caea051',
  '38787af3b4659bb9690a2d16464565d790b34bd16666801df63dc9fe9a26f714',
] as const;
const haveArtifacts = (() => {
  return [MAP_ID, MERGE_MAP_ID, MERGE_CAMPAIGN_MAP_ID].every((mapId) => {
    const present = artifactPresence(mapId);
    return present.topologyIndex && present.derivedTopology && present.locations;
  });
})();

const cases = {
  sideswipe: {
    file: path.join(REPO_ROOT, 'examples', 'mechanisms', 'corridor', 'sideswipe.template.json'),
    mapId: MERGE_MAP_ID,
    siteId: '7364375ffc69d02f',
    seed: SIDESWIPE_SEEDS[0],
  },
  merge: {
    file: path.join(REPO_ROOT, 'examples', 'mechanisms', 'corridor', 'merge-gap-collapse.template.json'),
    mapId: MERGE_MAP_ID,
    siteId: '31b9505a310b5d51',
    seed: 'merge-yale-exact',
  },
  mergeCampaign: {
    file: path.join(REPO_ROOT, 'examples', 'mechanisms', 'corridor', 'merge-gap-collapse.template.json'),
    mapId: MERGE_CAMPAIGN_MAP_ID,
    siteId: '356f47801fdae38d',
    seed: 'fec7139f4f13f4770c757a29060631f1101451474ed3cc3754bee897ab8a1c10',
    drawIndex: 2,
  },
  overtake: {
    file: path.join(REPO_ROOT, 'examples', 'mechanisms', 'remaining', 'oncoming-overtake.template.json'),
    mapId: MAP_ID,
    siteId: '008040107482f5a1',
    seed: 'ab732cbd74717e11913341f4c7a6e4a236dc737eea33507bb47fb1b91f1dc825',
  },
} as const;

interface ExactRuntimeSpec {
  readonly file: string;
  readonly mapId: string;
  readonly siteId: string;
  readonly seed: string;
  readonly drawIndex?: number;
}

async function exactRuntime(spec: ExactRuntimeSpec, clipSeconds?: number): Promise<{
  template: ScenarioTemplateV2;
  input: ReturnType<typeof materialize>['input'];
  trace: ReturnType<typeof runSimulation>['trace'];
  residuals: ReturnType<typeof checkInvariants>;
  site: NonNullable<Awaited<ReturnType<typeof matchOnMap>>['report']['sites'][number]>;
}> {
  const template = await readTemplate(spec.file);
  const matched = await matchOnMap(template, spec.mapId);
  const site = matched.report.sites.find((candidate) => candidate.siteId === spec.siteId);
  expect(site, `exact audited site ${spec.siteId}; rejected=${JSON.stringify(matched.report.rejected.find((candidate) => candidate.siteId === spec.siteId))}`).toBeDefined();
  const { input, manifest } = materialize(template, matched.bundle, site!, {
    drawIndex: spec.drawIndex ?? 0,
    seed: spec.seed,
  });
  if (clipSeconds !== undefined) input.clipSeconds = clipSeconds;
  expect(manifest.feasible).toBe(true);
  expect(manifest.issues).toEqual([]);
  const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
  const speedLimitKph = matched.bundle.index.lanes[site!.frame.entryLaneRsl]?.speedLimitKph ?? null;
  const residuals = checkInvariants({
    template,
    trace,
    scope: {
      params: manifest.params.values,
      clip: { seconds: template.choreography.clipSeconds },
      ...(speedLimitKph === null ? {} : { lane: { speedLimitKph } }),
    },
    arrival: manifest.arrival,
    speedLimitKph,
  });
  return { template, input, trace, residuals, site: site! };
}

function expectEligible(trace: ReturnType<typeof runSimulation>['trace'], residuals: ReturnType<typeof checkInvariants>): void {
  expect(trace.metrics.collisions).toEqual([]);
  expect(residuals).toEqual(expect.arrayContaining([
    expect.objectContaining({ essentiality: 'required', status: 'held' }),
  ]));
  expect(residuals.filter((entry) => entry.essentiality === 'required' && entry.status !== 'held')).toEqual([]);
  expect(evaluateTrace(trace, filtersFor('critical', { rejectCollisions: true }))).toMatchObject({
    verdict: 'accept',
    findings: [],
  });
}

describe.skipIf(!haveArtifacts)('lane-change mechanisms — exact catalog runtime', () => {
  it.each(SIDESWIPE_SEEDS)('creates a true attempt-and-abort sideswipe for fresh seed %s', async (seed) => {
    const { input, trace, residuals } = await exactRuntime({ ...cases.sideswipe, seed });
    expectEligible(trace, residuals);
    expect(trace.metrics.minTTC).toMatchObject({
      pair: expect.arrayContaining(['ego', 'drifting-vehicle']),
      value: expect.any(Number),
    });
    expect(trace.metrics.minTTC!.value).toBeLessThanOrEqual(3);
    expect(input.interactions.filter((interaction) => interaction.actorId === 'drifting-vehicle'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'unsignalled-drift', verb: 'changeLane' }),
        expect.objectContaining({ id: 'drifter-aborts-incursion', verb: 'changeLane' }),
      ]));
    expect(trace.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'preemption', byInteractionId: 'drifter-aborts-incursion',
        preemptedInteractionId: 'unsignalled-drift',
      }),
      expect.objectContaining({
        kind: 'released', interactionId: 'drifter-aborts-incursion', reason: 'complete',
      }),
    ]));
    expect(trace.ticks.actors['drifting-vehicle']?.present.at(-1)).toBe(1);
    expect(trace.ticks.actors.ego?.present.at(-1)).toBe(1);
  }, 90_000);

  it('preserves the recovered sideswipe aftermath beyond the authored clip', async () => {
    const extended = await exactRuntime(cases.sideswipe, 20);
    expect(extended.trace.ticks.t).toHaveLength(1001);
    expect(extended.trace.ticks.t.at(-1)).toBe(20);
    expect(extended.trace.metrics.collisions).toEqual([]);
    expect(extended.trace.ticks.actors['drifting-vehicle']?.present.at(-1)).toBe(1);
  }, 90_000);

  it('starts the merger behind ego and collapses to a survivable accepted gap', async () => {
    const template = await readTemplate(cases.merge.file);
    const falseBelmont = await matchOnMap(template, MAP_ID);
    expect(falseBelmont.report.sites.some((site) => site.siteId === '68eaedf0be0221e7')).toBe(false);
    const { trace, residuals, site } = await exactRuntime(cases.merge);
    expect(site.frame.origin).toMatchObject({ kind: 'junction', mapFeatureId: 'junction:561' });
    expect(site.bindings.find((binding) => binding.role === 'merging')?.conflict).toMatchObject({
      relation: 'merge', crossingAngleDeg: expect.closeTo(0.146, 2),
    });
    expectEligible(trace, residuals);
    expect(trace.metrics.minDistance).toEqual(expect.arrayContaining([expect.objectContaining({
      pair: expect.arrayContaining(['ego', 'merging']),
      minDistanceM: expect.closeTo(2.741, 2),
    })]));
    const extended = await exactRuntime(cases.merge, 20);
    expect(extended.trace.ticks.t).toHaveLength(1001);
    expect(extended.trace.ticks.t.at(-1)).toBe(20);
    expect(extended.trace.metrics.collisions).toEqual([]);
    expect(extended.trace.metrics.minDistance).toEqual(expect.arrayContaining([expect.objectContaining({
      pair: expect.arrayContaining(['ego', 'merging']), minDistanceM: expect.closeTo(2.741, 2),
    })]));
  }, 90_000);

  it('preserves the formerly rejected El Camino merge as a critical, contact-free corrective merge', async () => {
    const { trace, residuals, site } = await exactRuntime(cases.mergeCampaign);
    expect(site.frame.origin).toMatchObject({ kind: 'junction', mapFeatureId: 'junction:2022' });
    expect(site.bindings.find((binding) => binding.role === 'merging')?.conflict).toMatchObject({
      relation: 'merge', crossingAngleDeg: expect.closeTo(2.48, 1),
    });
    expectEligible(trace, residuals);
    expect(trace.metrics.minDistance).toEqual(expect.arrayContaining([expect.objectContaining({
      pair: expect.arrayContaining(['ego', 'merging']), minDistanceM: expect.closeTo(1.248, 2),
    })]));
    const extended = await exactRuntime(cases.mergeCampaign, 20);
    expect(extended.trace.metrics.collisions).toEqual([]);
    expect(extended.trace.ticks.actors.ego?.present.at(-1)).toBe(1);
    expect(extended.trace.ticks.actors.merging?.present.at(-1)).toBe(1);
  }, 90_000);

  it('executes a local antiparallel overtake and returns without either collision', async () => {
    const { input, trace, residuals } = await exactRuntime(cases.overtake);
    const ego = input.actors.find((actor) => actor.id === 'ego')!;
    const overtaker = input.actors.find((actor) => actor.id === 'overtaker')!;
    const headingError = Math.abs(Math.atan2(
      Math.sin(overtaker.initial.pose.headingRad - ego.initial.pose.headingRad - Math.PI),
      Math.cos(overtaker.initial.pose.headingRad - ego.initial.pose.headingRad - Math.PI),
    ));
    expect(headingError).toBeLessThan(8 * Math.PI / 180);
    expectEligible(trace, residuals);
    expect(trace.metrics.minTTC).toMatchObject({
      pair: expect.arrayContaining(['ego', 'overtaker']),
    });
  }, 90_000);
});
