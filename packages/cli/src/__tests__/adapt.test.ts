/**
 * The template → matcher adapter.
 *
 * Pure, so these run without dev-assets. Every assertion here is one of the
 * places the two shipped vocabularies genuinely disagree; the point is that the
 * disagreement is *handled and reported*, never silently dropped.
 */

import { describe, expect, it } from 'vitest';

import { ScenarioTemplateV2Schema, type ScenarioTemplateV2 } from '@simforge/scenario';

import { OPEN_END_M, adaptTemplate, templateCrossingAngle } from '../adapt.js';

function parse(partial: Record<string, unknown>): ScenarioTemplateV2 {
  return ScenarioTemplateV2Schema.parse({
    scenarioVersion: 2,
    meta: {
      name: 'adapt fixture',
      createdAt: '2026-08-01T00:00:00.000Z',
      modifiedAt: '2026-08-01T00:00:00.000Z',
      appVersion: 'test',
    },
    anchor: { id: 'adapt-fixture', features: [] },
    ...partial,
  });
}

describe('adaptTemplate — corridor', () => {
  it('closes open range ends with a sentinel the matcher can do arithmetic on', () => {
    const { anchor } = adaptTemplate(
      parse({
        anchor: {
          id: 'a',
          corridor: { speedLimitKph: { value: [30, null], essentiality: 'preferred' } },
          features: [],
        },
      }),
    );
    expect(anchor.corridor?.speedLimitKph?.value).toEqual([30, OPEN_END_M]);
  });

  it('turns a runway *range* into the matcher\'s single minimum', () => {
    const { anchor } = adaptTemplate(
      parse({
        anchor: {
          id: 'a',
          corridor: { runwayUpstreamM: { value: [120, null], essentiality: 'required' } },
          features: [],
        },
      }),
    );
    expect(anchor.corridor?.runwayUpstreamM).toEqual({ value: 120, essentiality: 'required' });
  });

  it('drops an open-ended runway range with a note rather than inventing a minimum', () => {
    const { anchor, notes } = adaptTemplate(
      parse({
        anchor: {
          id: 'a',
          corridor: { runwayDownstreamM: { value: [null, 300], essentiality: 'preferred' } },
          features: [],
        },
      }),
    );
    expect(anchor.corridor?.runwayDownstreamM).toBeUndefined();
    expect(notes.map((n) => n.path)).toContain('anchor.corridor.runwayDownstreamM');
  });

  it('renames `bike` and reports the adjacency kinds the matcher cannot evaluate', () => {
    const { anchor, notes } = adaptTemplate(
      parse({
        anchor: {
          id: 'a',
          corridor: {
            requiresAdjacent: { value: ['bike', 'parking'], essentiality: 'required' },
            forbidsAdjacent: { value: ['rail'], essentiality: 'preferred' },
          },
          features: [],
        },
      }),
    );
    expect(anchor.corridor?.requiresAdjacent?.value).toEqual(['biking', 'parking']);
    expect(anchor.corridor?.forbidsAdjacent).toBeUndefined();
    expect(notes.some((n) => n.reason.includes('"rail"'))).toBe(true);
  });
});

describe('adaptTemplate — features', () => {
  const junctionAnchor = {
    id: 'a',
    features: [
      {
        id: 'jx',
        kind: 'junction',
        atM: { value: [0, 0], essentiality: 'required' },
        arms: { value: [4, 4], essentiality: 'preferred' },
        control: { value: ['signalized'], essentiality: 'preferred' },
        egoTurn: { value: ['left', 'uturn'], essentiality: 'required' },
        conflictingApproach: {
          value: { from: 'opposing', turn: 'straight', crossingAngleDeg: [110, 170] },
          essentiality: 'required',
        },
      },
    ],
  };

  it('preserves required point-feature lateral proximity as a matcher clause', () => {
    const { anchor } = adaptTemplate(parse({
      anchor: {
        id: 'bus-stop-proximity',
        features: [{
          id: 'stop',
          kind: 'bus_stop',
          atM: { value: [40, 120], essentiality: 'required' },
          lateralDistanceM: { value: [0, 7], essentiality: 'required' },
          sameRoad: { value: true, essentiality: 'required' },
        }],
      },
    }));

    expect(anchor.features[0]?.lateralDistanceM).toEqual({
      value: [0, 7], essentiality: 'required',
    });
    expect(anchor.features[0]?.sameRoad).toEqual({ value: true, essentiality: 'required' });
  });

  it('re-nests the junction predicates the v2 union hoists', () => {
    const { anchor } = adaptTemplate(parse({ anchor: junctionAnchor }));
    const feature = anchor.features[0]!;
    expect(feature.kind).toBe('junction');
    expect(feature.junction?.arms?.value).toEqual([4, 4]);
    expect(feature.junction?.control?.value).toEqual(['signalized']);
    expect(feature.junction?.conflictingApproach?.value).toEqual({
      from: 'opposing',
      turn: 'straight',
      crossingAngleDeg: [110, 170],
    });
  });

  it('keeps one ego turn and says which ones it dropped', () => {
    const { anchor, notes } = adaptTemplate(parse({ anchor: junctionAnchor }));
    expect(anchor.features[0]!.junction?.egoTurn?.value).toBe('left');
    expect(notes.some((n) => n.reason.includes('dropped uturn'))).toBe(true);
  });

  it('carries the authored crossing-angle band through to the role ranking', () => {
    expect(templateCrossingAngle(parse({ anchor: junctionAnchor }), 'jx')).toBe(140);
  });

  it('defaults a missing atM: [0,0] for the origin, unconstrained for the rest', () => {
    const { anchor } = adaptTemplate(
      parse({
        anchor: {
          id: 'a',
          features: [
            { id: 'jx', kind: 'junction' },
            { id: 'xw', kind: 'crossing' },
          ],
        },
      }),
    );
    expect(anchor.features[0]!.atM.value).toEqual([0, 0]);
    expect(anchor.features[1]!.atM.value).toEqual([-OPEN_END_M, OPEN_END_M]);
    expect(anchor.features[1]!.atM.essentiality).toBe('cosmetic');
  });

  it('preserves every authored crossing predicate for strict map evaluation', () => {
    const { anchor, notes } = adaptTemplate(parse({
      anchor: {
        id: 'strict-crossing',
        features: [{
          id: 'xw', kind: 'crossing',
          marked: { value: true, essentiality: 'required' },
          controlled: { value: true, essentiality: 'required' },
          lengthM: { value: [12, 32], essentiality: 'preferred' },
          placement: { value: 'junction_leg', essentiality: 'required' },
        }],
      },
    }));
    expect(anchor.features[0]?.crossing).toEqual({
      marked: { value: true, essentiality: 'required' },
      controlled: { value: true, essentiality: 'required' },
      lengthM: { value: [12, 32], essentiality: 'preferred' },
      placement: { value: 'junction_leg', essentiality: 'required' },
    });
    expect(notes).toEqual([]);
  });

  it('preserves work-zone suitability now that the matcher supports it', () => {
    const { anchor, notes } = adaptTemplate(
      parse({ anchor: { id: 'a', features: [{ id: 'wz', kind: 'work_zone_suitable' }] } }),
    );
    expect(anchor.features).toEqual([
      expect.objectContaining({
        id: 'wz',
        kind: 'work_zone_suitable',
        atM: expect.objectContaining({ value: [0, 0] }),
      }),
    ]);
    expect(notes.some((n) => n.reason.includes('not matchable'))).toBe(false);
  });

  it('preserves school zones as exact matcher features', () => {
    const { anchor, notes } = adaptTemplate(
      parse({ anchor: { id: 'a', features: [{ id: 'sz', kind: 'school_zone', essentiality: 'required' }] } }),
    );
    expect(anchor.features).toEqual([
      expect.objectContaining({ id: 'sz', kind: 'school_zone', atM: expect.objectContaining({ value: [0, 0] }) }),
    ]);
    expect(notes.some((note) => note.path.includes('features.sz'))).toBe(false);
  });
});

describe('adaptTemplate — policy and roles', () => {
  it('maps the diversity vocabulary positionally', () => {
    for (const [v2, matcher] of [
      ['strict', 'junction'],
      ['moderate', 'road_direction'],
      ['off', 'none'],
    ] as const) {
      const { anchor } = adaptTemplate(
        parse({ anchor: { id: 'a', features: [], policy: { diversity: v2 } } }),
      );
      expect(anchor.policy?.diversity).toBe(matcher);
    }
  });

  it('drops a pin with no siteId and explains why', () => {
    const { anchor, notes } = adaptTemplate(
      parse({ anchor: { id: 'a', features: [], pin: { mapId: 'yale-st-palo-alto-ca' } } }),
    );
    expect(anchor.pin).toBeUndefined();
    expect(notes.some((n) => n.reason.includes('pin_site_unresolved'))).toBe(true);
  });

  it('translates every portable role kind and refuses the non-portable one', () => {
    const { roles, notes } = adaptTemplate(
      parse({
        anchor: {
          id: 'a',
          features: [{ id: 'jx', kind: 'junction' }],
        },
        roles: [
          { id: 'ego', kind: 'on_reference', actor: { class: 'car' }, pose: { s: -40, tFrac: 0.1 } },
          {
            id: 'left',
            kind: 'lane_offset',
            actor: { class: 'car' },
            k: 1,
            onMissing: 'clamp',
            pose: { s: -10 },
          },
          { id: 'opp', kind: 'opposing', actor: { class: 'van' }, k: 0, pose: { s: 25 } },
          {
            id: 'chall',
            kind: 'conflicting_gate',
            actor: { class: 'car' },
            feature: 'jx',
            from: 'same',
            turn: 'left',
            arriveAtConflict: { relativeTo: 'ego', deltaT: 1.5 },
            requiredUpstreamRunwayM: 180,
          },
          { id: 'ghost', kind: 'scene_absolute', actor: { class: 'car' }, pose: { position: { x: 1, y: 0, z: 2 }, headingRad: 0 } },
        ],
      }),
    );
    expect(roles.map((r) => r.kind)).toEqual([
      'on_reference',
      'lane_offset',
      'opposing',
      'conflicting_gate',
    ]);
    expect(roles[0]).toMatchObject({ role: 'ego', dsM: -40, tFrac: 0.1 });
    expect(roles[2]).toMatchObject({ role: 'opp', index: 0, dsM: 25 });
    expect(roles[3]).toMatchObject({
      from: 'merge', arriveAtConflict: { deltaT: 1.5 }, minUpstreamRunwayM: 180,
    });
    expect(notes.some((n) => n.reason.includes("'same' has no matcher equivalent"))).toBe(true);
    expect(notes.some((n) => n.reason.includes('not portable'))).toBe(true);
  });

  it('falls back to 0 for a site-dependent spawn, because the structural pass has no site', () => {
    const { roles } = adaptTemplate(
      parse({
        anchor: { id: 'a', features: [] },
        roles: [
          {
            id: 'ego',
            kind: 'on_reference',
            actor: { class: 'car' },
            pose: { s: '-(0.8 * lane.speedLimitKph / 3.6) * 8' },
          },
        ],
      }),
    );
    // Not an error: `materialize.ts` re-evaluates it against the bound site and
    // extends the lane chain to reach it.
    expect(roles[0]).toMatchObject({ dsM: 0 });
  });
});
