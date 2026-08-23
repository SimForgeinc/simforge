/** End-to-end closure for the moving cut-out occluder. */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateTrace, runSimulation } from '@uniscenarios/sim-engine';

import { filtersFor } from '../commands/evaluate.js';
import { checkInvariants } from '../invariants.js';
import { DEV_ASSETS, REPO_ROOT } from '@uniscenarios/scenario-materializer';
import { materialize } from '../materialize.js';
import { findSite, matchOnMap } from '@uniscenarios/scenario-materializer';
import { readTemplate } from '@uniscenarios/scenario-materializer';

const MAP = 'yale-street';
const TEMPLATE = path.join(
  REPO_ROOT,
  'examples',
  'mechanisms',
  'corridor',
  'cutout-reveals-stopped.template.json',
);
const haveArtifacts =
  existsSync(path.join(DEV_ASSETS, MAP, 'derived', 'topology-derived.json.gz')) &&
  existsSync(path.join(DEV_ASSETS, MAP, 'derived', 'locations.json.gz'));

describe.skipIf(!haveArtifacts)('cut-out materialization closure', () => {
  it.each([
    'a28a40bc5d85f0c0d67ef855d10c77245654f2e3eb3903594b0eca29572ebf3a',
    'bc1a7576e7506841a2e2c4be73c0ed66d07e4174d9fd14aa8aff8b4b54d2234c',
    'a68ccc4595ab1ef83c7642381a98f642d6468dbfa93422e169e3b99a0fddab65',
  ])('keeps preserved selected-Yale attempt seed %s collision-free', async (seed) => {
    const template = await readTemplate(TEMPLATE);
    const { bundle, site } = await findSite(template, MAP, 'b65c6130ac15c3bd');
    const { input, manifest } = materialize(template, bundle, site, { drawIndex: 0, seed });
    const { trace } = runSimulation(input, { graph: bundle.graph, guards: 'collect' });
    const speedLimitKph = bundle.index.lanes[site.frame.entryLaneRsl]?.speedLimitKph ?? null;
    expect(trace.metrics.collisions).toEqual([]);
    expect(evaluateTrace(trace, filtersFor('critical', { rejectCollisions: true }))).toMatchObject({
      verdict: 'accept', findings: [],
    });
    expect(checkInvariants({
      template,
      trace,
      scope: {
        params: manifest.params.values,
        clip: { seconds: template.choreography.clipSeconds },
        ...(speedLimitKph === null ? {} : { lane: { speedLimitKph } }),
      },
      arrival: manifest.arrival,
      speedLimitKph,
    }).filter((residual) => residual.essentiality === 'required' && residual.status !== 'held')).toEqual([]);
  }, 30_000);

  it('materializes and observes the moving van as the declared occluder', async () => {
    const template = await readTemplate(TEMPLATE);
    const matched = await matchOnMap(template, MAP);
    expect(matched.report.sites.length).toBeGreaterThan(0);
    const { bundle, site } = await findSite(template, MAP, 'b65c6130ac15c3bd');

    const { input, manifest } = materialize(template, bundle, site, { drawIndex: 0 });
    expect(input.actors.find((actor) => actor.id === 'lead-cutout')).toMatchObject({
      id: 'lead-cutout',
      kind: 'van',
      static: false,
    });
    expect(input.occlusionPairs).toContainEqual({
      observer: 'ego',
      target: 'stopped',
      occluderId: 'actor:lead-cutout',
    });

    const { trace } = runSimulation(input, { graph: bundle.graph, guards: 'collect' });
    expect(trace.metrics.collisions).toEqual([]);
    expect(checkInvariants({
      template,
      trace,
      scope: {
        params: manifest.params.values,
        clip: { seconds: template.choreography.clipSeconds },
        lane: { speedLimitKph: bundle.index.lanes[site.frame.entryLaneRsl]?.speedLimitKph },
      },
      arrival: manifest.arrival,
      speedLimitKph: bundle.index.lanes[site.frame.entryLaneRsl]?.speedLimitKph ?? null,
    }).filter((residual) => residual.essentiality === 'required' && residual.status !== 'held')).toEqual([]);
    expect(trace.metrics.declaredOcclusion).toContainEqual(expect.objectContaining({
      observer: 'ego',
      target: 'stopped',
      occluderId: 'actor:lead-cutout',
    }));
  }, 30_000);

  it('atomically rejects a stale site missing its required moving occluder', async () => {
    const template = await readTemplate(TEMPLATE);
    const matched = await matchOnMap(template, MAP);
    expect(matched.report.sites.length).toBeGreaterThan(0);
    const { bundle, site } = await findSite(template, MAP, matched.report.sites[0]!.siteId);
    const staleSite = {
      ...site,
      bindings: site.bindings.filter((binding) => binding.role !== 'lead-cutout'),
    };

    expect(() => materialize(template, bundle, staleSite, { drawIndex: 0 })).toThrow(expect.objectContaining({
      code: 'role_unbound',
      path: 'roles.lead-cutout',
      detail: expect.objectContaining({ status: 'missing' }),
    }));
  }, 30_000);
});
