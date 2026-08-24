import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { ScenarioTemplateV2Schema } from '@simforge/scenario';

import { DEV_ASSETS, REPO_ROOT } from '@simforge/compiler/node';
import { materialize } from '../materialize.js';
import { findSite } from '@simforge/compiler/node';
import { readTemplate } from '@simforge/compiler/node';

const TEMPLATE = path.join(REPO_ROOT, 'examples', 'edge-cases', 'wrong-way-sedan-blind-crest', 'scenario.template.json');
const MAP = 'yale-street';
const SITE = '650b4f334df1323c';
const haveArtifacts = existsSync(TEMPLATE) &&
  existsSync(path.join(DEV_ASSETS, MAP, 'derived', 'topology-derived.json.gz'));

describe.skipIf(!haveArtifacts)('opposing role longitudinal station', () => {
  it('moves with pose.s while remaining bound to the opposing route', async () => {
    const source = await readTemplate(TEMPLATE);
    const { bundle, site } = await findSite(source, MAP, SITE);
    const bindingLane = site.bindings.find((binding) => binding.role === 'opposing-bus')?.laneRsl;

    const at = (station: number) => {
      const template = ScenarioTemplateV2Schema.parse({
        ...source,
        roles: source.roles.map((role) => role.id === 'opposing-bus' && role.kind === 'opposing'
          ? { ...role, pose: { ...role.pose, s: station } }
          : role),
      });
      return materialize(template, bundle, site, { seed: 'opposing-station-regression' });
    };

    const near = at(12);
    const far = at(110);
    const nearActor = near.input.actors.find((actor) => actor.id === 'opposing-bus')!;
    const farActor = far.input.actors.find((actor) => actor.id === 'opposing-bus')!;
    const displacement = Math.hypot(
      farActor.initial.pose.x - nearActor.initial.pose.x,
      farActor.initial.pose.z - nearActor.initial.pose.z,
    );

    // This real corridor bends sharply, so chord displacement is smaller than
    // the authored 98 m station delta; it must nevertheless be substantial and
    // must no longer collapse both placements onto the same route endpoint.
    expect(displacement).toBeGreaterThan(30);
    expect(near.manifest.actors.find((actor) => actor.id === 'opposing-bus')?.roleKind).toBe('opposing');
    expect(far.manifest.actors.find((actor) => actor.id === 'opposing-bus')?.roleKind).toBe('opposing');
    for (const actor of [nearActor, farActor]) {
      expect(actor.behavior.route).toMatchObject({ kind: 'lanePath' });
      expect(actor.behavior.route.kind === 'lanePath' ? actor.behavior.route.lanes : []).toContain(bindingLane);
    }
  }, 60_000);
});
