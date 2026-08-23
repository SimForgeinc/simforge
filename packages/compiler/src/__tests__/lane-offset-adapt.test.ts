/**
 * `pose.laneOffset` must never be quietly thrown away.
 *
 * The defect this pins is the most expensive kind: a field the schema accepts,
 * the validator passes, and the adapter deletes. `OnReferenceRoleSchema` carries
 * a full `FramePose`, so `kind: "on_reference"` with `pose.laneOffset: -1` is a
 * legal, plausible, and (to an author told "start in the adjacent lane") an
 * obvious way to write an adjacent-lane actor. `adaptRole` mapped it to the
 * matcher's `{ kind: 'on_reference', dsM, tFrac }`, which has no lane index at
 * all, so the actor bound to `k = 0` — the reference actor's own lane — with no
 * note, no warning, and `template validate` reporting `ok: true`.
 *
 * The fix is to carry the authored offset into the one binding that can express
 * it, `lane_offset`, and to resolve it with `onMissing: 'fail'` so a site that
 * cannot hold the actor is rejected instead of quietly re-parked.
 */

import { describe, expect, it } from 'vitest';

import { ScenarioTemplateV2Schema, type ScenarioTemplateV2 } from '@simforge/scenario';

import { adaptTemplate } from '../adapt.js';

function templateWith(roles: unknown[]): ScenarioTemplateV2 {
  return ScenarioTemplateV2Schema.parse({
    scenarioVersion: 2,
    meta: {
      name: 'lane-offset adapter fixture',
      createdAt: '2026-08-01T00:00:00.000Z',
      modifiedAt: '2026-08-01T00:00:00.000Z',
      appVersion: 'uniscenarios/0.0.1',
      archetype: 'test.lane-offset',
      author: 'test',
    },
    params: { declarations: [], constraints: [] },
    environment: { weather: 'clear', timeOfDay: 'afternoon' },
    anchor: {
      id: 'lane-offset-fixture',
      corridor: { runwayDownstreamM: { value: [100, null], essentiality: 'required' } },
      features: [],
      policy: {},
    },
    roles,
    props: [],
    choreography: { clipSeconds: 8, warmupSeconds: 1, interactions: [] },
    invariants: [],
    variants: [],
    metricSubject: 'ego',
  });
}

const car = { class: 'car', catalogId: 'vehicle.sedan' } as const;

const ego = {
  id: 'ego',
  kind: 'on_reference',
  actor: car,
  pose: { laneOffset: 0, s: 10, tFrac: 0, headingOffsetRad: 0 },
  initialSpeedKph: 30,
};

const neighbourOnReference = {
  id: 'nb',
  kind: 'on_reference',
  actor: car,
  pose: { laneOffset: -1, s: 30, tFrac: 0, headingOffsetRad: 0 },
  initialSpeedKph: 30,
};

describe('adaptRole — an authored pose.laneOffset survives the adapter', () => {
  it('carries a non-zero laneOffset on an on_reference role into a lane_offset binding', () => {
    const { roles, notes } = adaptTemplate(templateWith([ego, neighbourOnReference]));
    const nb = roles.find((r) => r.role === 'nb')!;
    expect(nb.kind).toBe('lane_offset');
    expect(nb).toMatchObject({ kind: 'lane_offset', k: -1, onMissing: 'fail', dsM: 30 });
    // The rewrite is a real change of binding semantics and must be reported.
    expect(notes.some((n) => n.path === 'roles.nb.pose.laneOffset')).toBe(true);
  });

  it('leaves a laneOffset of 0 on the reference binding', () => {
    const { roles } = adaptTemplate(templateWith([ego]));
    expect(roles.find((r) => r.role === 'ego')).toMatchObject({ kind: 'on_reference', dsM: 10 });
  });

  it('does not let a laneOffset silently override an explicit lane_offset k', () => {
    const { roles } = adaptTemplate(
      templateWith([
        ego,
        {
          id: 'nb',
          kind: 'lane_offset',
          k: -2,
          onMissing: 'fail',
          actor: car,
          pose: { laneOffset: -1, s: 30, tFrac: 0, headingOffsetRad: 0 },
          initialSpeedKph: 30,
        },
      ]),
    );
    expect(roles.find((r) => r.role === 'nb')).toMatchObject({ kind: 'lane_offset', k: -2 });
  });

  it('reports a laneOffset on a role whose lane is structural rather than positional', () => {
    const { roles, notes } = adaptTemplate(
      templateWith([
        ego,
        {
          id: 'opp',
          kind: 'opposing',
          k: 0,
          actor: car,
          pose: { laneOffset: 2, s: 30, tFrac: 0, headingOffsetRad: 0 },
          initialSpeedKph: 30,
        },
      ]),
    );
    expect(roles.find((r) => r.role === 'opp')).toMatchObject({ kind: 'opposing', index: 0 });
    expect(notes.some((n) => n.path === 'roles.opp.pose.laneOffset')).toBe(true);
  });
});
