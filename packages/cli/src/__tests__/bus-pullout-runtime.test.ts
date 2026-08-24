/** Exact runtime contract for a bus departing a truthful same-road stop. */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSimulation } from '@simforge/engine';

import { REPO_ROOT, artifactPresence } from '@simforge/compiler/node';
import { materialize } from '../materialize.js';
import { matchOnMap } from '@simforge/compiler/node';
import { readTemplate } from '@simforge/compiler/node';

const MAP = 'belmont-research-center';
const SITE_ID = '5532969124e19a99';
const TEMPLATE = path.join(
  REPO_ROOT,
  'examples',
  'mechanisms',
  'parking-transit',
  'bus-pullout.template.json',
);
const present = artifactPresence(MAP);
const haveArtifacts = present.topologyIndex && present.derivedTopology && present.locations;

describe.skipIf(!haveArtifacts)('bus pull-out — exact Belmont runtime', () => {
  it.each([
    { label: 'default', drawIndex: -1, seed: undefined },
    { label: 'bus-pet-0', drawIndex: 0, seed: 'bus-pet-0' },
    { label: 'bus-pet-7', drawIndex: 7, seed: 'bus-pet-7' },
  ])('uses post-departure merge PET for stable seed $label', async ({ drawIndex, seed }) => {
    const template = await readTemplate(TEMPLATE);
    const matched = await matchOnMap(template, MAP);
    const site = matched.report.sites.find((candidate) => candidate.siteId === SITE_ID);
    expect(site, 'exact truthful same-road Belmont stop').toBeDefined();
    expect(site!.clauses.find((clause) => clause.path === 'features.stop.sameRoad')).toMatchObject({
      required: true,
      actual: true,
      score: 1,
    });
    expect(site!.clauses.find((clause) => clause.path === 'features.stop.atM')?.reason)
      .toContain('same-road station');

    const { input, manifest } = materialize(template, matched.bundle, site!, { drawIndex, seed });
    const bus = input.actors.find((actor) => actor.id === 'bus');
    expect(bus).toMatchObject({
      kind: 'bus',
      static: false,
      initial: { speedMps: 0, laneRef: { tFrac: -1 } },
      behavior: { cruiseSpeedMps: 0 },
    });
    expect(input.interactions.find((interaction) => interaction.id === 'bus-enters-lane')).toMatchObject({
      actorId: 'bus',
      verb: 'laneOffset',
      target: { mode: 'fraction', value: 0 },
    });

    const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
    const departure = trace.events.find(
      (event) => event.kind === 'trigger_fired' && event.interactionId === 'bus-accelerates',
    );
    const merge = trace.events.find(
      (event) => event.kind === 'trigger_fired' && event.interactionId === 'bus-enters-lane',
    );
    expect(departure).toMatchObject({ actorId: 'bus', verb: 'speed', t: expect.any(Number) });
    expect(merge).toMatchObject({ actorId: 'bus', verb: 'laneOffset', t: expect.any(Number) });
    expect((merge as { t: number }).t - (departure as { t: number }).t).toBeCloseTo(0.2, 6);

    const pet = trace.metrics.minPET;
    expect(pet).toMatchObject({ pair: expect.arrayContaining(['ego', 'bus']) });
    expect(pet!.t).toBeGreaterThan((merge as { t: number }).t);
    expect(pet!.value).toBeGreaterThanOrEqual(0.5);
    expect(pet!.value).toBeLessThanOrEqual(3.5);
    expect(trace.metrics.collisions).toEqual([]);
    expect(manifest.replayKey.drawIndex).toBe(drawIndex);
    if (seed !== undefined) expect(manifest.replayKey.paramSeed).toBe(seed);

    const criticality = template.invariants.find((invariant) => invariant.id === 'bus-pullout-criticality');
    expect(criticality).toMatchObject({
      kind: 'pet',
      of: 'ego',
      to: 'bus',
      range: [0.5, 3.5],
      window: [3, 8],
      essentiality: 'required',
    });
  }, 30_000);
});
