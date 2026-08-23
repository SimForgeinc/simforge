/**
 * Tier-1 validation: the document-only checks, then the map-dependent ones
 * against the in-memory fake.
 */

import { describe, expect, it } from 'vitest';

import { parseTemplate } from '../serialize.js';
import { createFakeMapContext } from '../validate/fake-map-context.js';
import {
  parseAndValidateTemplate,
  unusedRoles,
  validateTemplate,
} from '../validate/index.js';
import type { ClauseResult, IssueCode } from '../validate/issues.js';
import {
  interaction,
  ltapMapContext,
  ltapTemplate,
  ltapTemplateInput,
  templateWithInteractions,
} from './v2-fixtures.js';

const codes = (issues: ClauseResult[]): IssueCode[] => issues.map((i) => i.code);
const find = (issues: ClauseResult[], code: IssueCode) => issues.filter((i) => i.code === code);

describe('a well-formed template', () => {
  it('validates clean without a map', () => {
    const report = validateTemplate(ltapTemplate());
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.mapChecked).toBe(false);
  });

  it('validates clean against a site that satisfies it', () => {
    const report = validateTemplate(ltapTemplate(), ltapMapContext());
    expect(report.issues).toEqual([]);
    expect(report.mapChecked).toBe(true);
  });

  it('sorts issues deterministically', () => {
    const template = templateWithInteractions([
      interaction({ id: 'a', actor: 'ghost' }),
      interaction({ id: 'b', actor: 'ego', dynamics: undefined }),
    ]);
    const first = validateTemplate(template).issues;
    const second = validateTemplate(template).issues;
    expect(first).toEqual(second);
    expect(first.map((i) => i.severity)).toEqual([...first.map((i) => i.severity)].sort());
  });
});

describe('reference resolution', () => {
  it('reports an unknown actor, and lists the ids that do exist', () => {
    const report = validateTemplate(templateWithInteractions([interaction({ actor: 'ghost' })]));
    const [found] = find(report.issues, 'role_ref_unknown');
    expect(found?.path).toBe('choreography.interactions.0.actor');
    expect(found?.required).toEqual(['challenger', 'ego']);
    expect(report.ok).toBe(false);
  });

  it('reports unknown features, and the wrong kind of feature', () => {
    const base = ltapTemplateInput();
    const wrongKind = parseTemplate({
      ...base,
      anchor: { ...base.anchor, features: [{ id: 'jx', kind: 'crossing' }] },
    });
    expect(codes(validateTemplate(wrongKind).issues)).toContain('feature_kind_mismatch');

    const missing = templateWithInteractions([
      interaction({
        verb: 'route',
        dynamics: undefined,
        target: { mode: 'turn', feature: 'nope', turn: 'left' },
      }),
    ]);
    expect(codes(validateTemplate(missing).issues)).toContain('feature_ref_unknown');
  });

  it('reports unknown interaction references from after and event_order', () => {
    const afterGhost = templateWithInteractions([
      interaction({ trigger: { kind: 'after', of: 'nope', delayS: 1 } }),
    ]);
    expect(codes(validateTemplate(afterGhost).issues)).toContain('interaction_ref_unknown');

    const base = ltapTemplateInput();
    const orderGhost = parseTemplate({
      ...base,
      invariants: [{ id: 'o', kind: 'event_order', events: ['ego-cruise', 'nope'] }],
    });
    expect(codes(validateTemplate(orderGhost).issues)).toContain('interaction_ref_unknown');
  });

  it('reports self-references', () => {
    const report = validateTemplate(
      templateWithInteractions([
        interaction({
          verb: 'gap',
          target: { role: 'ego', value: 1.8, unit: 'time' },
        }),
      ]),
    );
    expect(codes(report.issues)).toContain('self_reference');
  });

  it('reports an undeclared parameter inside an expression', () => {
    const report = validateTemplate(
      templateWithInteractions([
        interaction({ target: { mode: 'absolute', valueKph: 'param.notDeclared' } }),
      ]),
    );
    const [found] = find(report.issues, 'param_ref_unknown');
    expect(found?.path).toContain('valueKph');
    expect(found?.actual).toBe('notDeclared');
  });

  it('reports a metricSubject that names nothing, and its absence', () => {
    const base = ltapTemplateInput();
    expect(
      codes(validateTemplate(parseTemplate({ ...base, metricSubject: 'nobody' })).issues),
    ).toContain('metric_subject_unknown');

    const { metricSubject: _drop, ...withoutSubject } = base;
    const report = validateTemplate(parseTemplate(withoutSubject));
    expect(codes(report.issues)).toContain('metric_subject_missing');
    expect(report.ok).toBe(true); // a warning, not a blocker
  });
});

describe('mandatory dynamics and byLatest', () => {
  it('requires dynamics on each continuous verb and not on the discrete ones', () => {
    const continuous = [
      { verb: 'speed', target: { mode: 'stop' } },
      { verb: 'gap', target: { role: 'challenger', value: 1.8, unit: 'time' } },
      { verb: 'changeLane', target: { mode: 'relative', dk: 1 } },
      { verb: 'laneOffset', target: { tFrac: 0.5 } },
    ];
    for (const shape of continuous) {
      const report = validateTemplate(
        templateWithInteractions([interaction({ ...shape, dynamics: undefined })]),
      );
      expect(codes(report.issues), shape.verb).toContain('dynamics_required');
      expect(validateTemplate(templateWithInteractions([interaction(shape)])).issues).toEqual([]);
    }

    const discrete = templateWithInteractions([
      interaction({ verb: 'exist', target: { state: 'absent' }, dynamics: undefined }),
    ]);
    expect(codes(validateTemplate(discrete).issues)).not.toContain('dynamics_required');
  });

  it('requires byLatest on every when trigger', () => {
    const report = validateTemplate(
      templateWithInteractions([
        interaction({
          trigger: {
            kind: 'when',
            condition: { kind: 'speed', of: 'ego', op: '>', valueKph: 10 },
          },
        }),
      ]),
    );
    const [found] = find(report.issues, 'bylatest_required');
    expect(found?.path).toBe('choreography.interactions.0.trigger.byLatest');
    expect(report.ok).toBe(false);
  });

  it('warns when the deadline is past the end of the clip', () => {
    const report = validateTemplate(
      templateWithInteractions([
        interaction({
          trigger: {
            kind: 'when',
            condition: { kind: 'speed', of: 'ego', op: '>', valueKph: 10 },
            byLatest: 40,
          },
        }),
      ]),
    );
    expect(find(report.issues, 'trigger_out_of_clip')[0]?.severity).toBe('warning');
  });
});

describe('one axis, one owner', () => {
  it('rejects two interactions on one axis at the same instant', () => {
    const report = validateTemplate(
      templateWithInteractions([
        interaction({ id: 'a', trigger: { kind: 'at', t: 2 }, target: { mode: 'stop' } }),
        interaction({
          id: 'b',
          trigger: { kind: 'at', t: 2 },
          verb: 'gap',
          target: { role: 'challenger', value: 1.8, unit: 'time' },
        }),
      ]),
    );
    const [found] = find(report.issues, 'axis_conflict');
    expect(found?.message).toMatch(/longitudinal axis of "ego"/);
    expect(report.ok).toBe(false);
  });

  it('rejects two untriggered interactions on one axis (both at t=0)', () => {
    const report = validateTemplate(
      templateWithInteractions([
        interaction({ id: 'a', trigger: { kind: 'at', t: 0 } }),
        interaction({ id: 'b', trigger: { kind: 'at', t: 0 }, target: { mode: 'resume' } }),
      ]),
    );
    expect(codes(report.issues)).toContain('axis_conflict');
  });

  it('accepts a sequence on one axis: later preempts earlier', () => {
    const report = validateTemplate(
      templateWithInteractions([
        interaction({ id: 'a', trigger: { kind: 'at', t: 0 } }),
        interaction({ id: 'b', trigger: { kind: 'at', t: 4 }, target: { mode: 'resume' } }),
        interaction({ id: 'c', trigger: { kind: 'at', t: 9 }, target: { mode: 'stop' } }),
      ]),
    );
    expect(report.issues).toEqual([]);
  });

  it('accepts the same instant on different axes and different actors', () => {
    const report = validateTemplate(
      templateWithInteractions([
        interaction({ id: 'a', trigger: { kind: 'at', t: 2 } }),
        interaction({
          id: 'b',
          trigger: { kind: 'at', t: 2 },
          verb: 'changeLane',
          target: { mode: 'relative', dk: 1 },
        }),
        interaction({ id: 'c', actor: 'challenger', trigger: { kind: 'at', t: 2 } }),
      ]),
    );
    expect(report.issues).toEqual([]);
  });

  it('treats each set key as its own axis', () => {
    const differentKeys = validateTemplate(
      templateWithInteractions([
        interaction({
          id: 'a',
          verb: 'set',
          dynamics: undefined,
          target: { key: 'lights.indicator', value: 'left' },
        }),
        interaction({
          id: 'b',
          verb: 'set',
          dynamics: undefined,
          target: { key: 'lights.brake', value: true },
        }),
      ]),
    );
    expect(differentKeys.issues).toEqual([]);

    const sameKey = validateTemplate(
      templateWithInteractions([
        interaction({
          id: 'a',
          verb: 'set',
          dynamics: undefined,
          target: { key: 'lights.indicator', value: 'left' },
        }),
        interaction({
          id: 'b',
          verb: 'set',
          dynamics: undefined,
          target: { key: 'lights.indicator', value: 'off' },
        }),
      ]),
    );
    expect(codes(sameKey.issues)).toContain('axis_conflict');
  });

  it('rejects an `until` that a later action on the same axis truncates', () => {
    const report = validateTemplate(
      templateWithInteractions([
        interaction({
          id: 'a',
          trigger: { kind: 'at', t: 1 },
          until: { kind: 'at', t: 10 },
        }),
        interaction({ id: 'b', trigger: { kind: 'at', t: 5 }, target: { mode: 'resume' } }),
      ]),
    );
    const [found] = find(report.issues, 'axis_conflict');
    expect(found?.path).toBe('choreography.interactions.0.until');
    expect(found?.message).toMatch(/until t=10s, but "b" takes it at t=5s/);
  });

  it('warns, but does not fail, when two conditional windows overlap', () => {
    const report = validateTemplate(
      templateWithInteractions([
        interaction({
          id: 'a',
          trigger: {
            kind: 'when',
            condition: { kind: 'ttc', of: 'ego', to: 'challenger', op: '<', valueS: 2 },
            byLatest: 10,
          },
        }),
        interaction({
          id: 'b',
          trigger: {
            kind: 'when',
            condition: { kind: 'headway', of: 'ego', to: 'challenger', op: '<', valueS: 1 },
            byLatest: 8,
          },
          target: { mode: 'resume' },
        }),
      ]),
    );
    expect(codes(report.issues)).toContain('axis_conflict_possible');
    expect(report.ok).toBe(true);
  });

  it('does not warn when an exact time meets a conditional window (the normal shape)', () => {
    const report = validateTemplate(
      templateWithInteractions([
        interaction({ id: 'a', trigger: { kind: 'at', t: 0 } }),
        interaction({
          id: 'b',
          trigger: {
            kind: 'when',
            condition: { kind: 'ttc', of: 'ego', to: 'challenger', op: '<', valueS: 2 },
            byLatest: 10,
          },
          target: { mode: 'stop' },
        }),
      ]),
    );
    expect(report.issues).toEqual([]);
  });

  it('resolves after-chains to exact times before comparing', () => {
    const report = validateTemplate(
      templateWithInteractions([
        interaction({ id: 'a', trigger: { kind: 'at', t: 2 } }),
        interaction({
          id: 'b',
          trigger: { kind: 'after', of: 'a', delayS: 0 },
          target: { mode: 'resume' },
        }),
      ]),
    );
    expect(codes(report.issues)).toContain('axis_conflict');
  });

  it('evaluates parameterised trigger times at their declared defaults', () => {
    const base = ltapTemplateInput();
    const template = parseTemplate({
      ...base,
      params: {
        declarations: [{ id: 'tCut', type: 'continuous', range: [1, 5], default: 3 }],
        constraints: [],
      },
      roles: base.roles,
      invariants: [],
      choreography: {
        interactions: [
          interaction({ id: 'a', trigger: { kind: 'at', t: 'param.tCut' } }),
          interaction({ id: 'b', trigger: { kind: 'at', t: 3 }, target: { mode: 'resume' } }),
        ],
      },
    });
    expect(codes(validateTemplate(template).issues)).toContain('axis_conflict');
  });
});

describe('timeline coherence', () => {
  it('rejects a trigger outside the clip', () => {
    const report = validateTemplate(
      templateWithInteractions([interaction({ trigger: { kind: 'at', t: 25 } })]),
    );
    const [found] = find(report.issues, 'trigger_out_of_clip');
    expect(found?.required).toEqual([-5, 20]);
    expect(found?.actual).toBe(25);
  });

  it('accepts a trigger inside the warm-up', () => {
    const report = validateTemplate(
      templateWithInteractions([interaction({ trigger: { kind: 'at', t: -3 } })]),
    );
    expect(report.issues).toEqual([]);
  });

  it('rejects an until at or before its own trigger', () => {
    const report = validateTemplate(
      templateWithInteractions([
        interaction({ trigger: { kind: 'at', t: 5 }, until: { kind: 'at', t: 5 } }),
      ]),
    );
    expect(codes(report.issues)).toContain('until_before_trigger');
  });

  it('detects a cycle of after-triggers', () => {
    const report = validateTemplate(
      templateWithInteractions([
        interaction({ id: 'a', trigger: { kind: 'after', of: 'b', delayS: 1 } }),
        interaction({
          id: 'b',
          trigger: { kind: 'after', of: 'a', delayS: 1 },
          verb: 'changeLane',
          target: { mode: 'relative', dk: 1 },
        }),
      ]),
    );
    const found = find(report.issues, 'trigger_cycle');
    expect(found).toHaveLength(1);
    expect(found[0]?.actual).toEqual(['a', 'b', 'a']);
  });

  it('rejects an event_order the static times already contradict', () => {
    const base = ltapTemplateInput();
    const template = parseTemplate({
      ...base,
      invariants: [{ id: 'o', kind: 'event_order', events: ['late', 'early'] }],
      choreography: {
        interactions: [
          interaction({ id: 'early', trigger: { kind: 'at', t: 1 } }),
          interaction({
            id: 'late',
            trigger: { kind: 'at', t: 9 },
            verb: 'changeLane',
            target: { mode: 'relative', dk: -1 },
          }),
        ],
      },
    });
    const [found] = find(validateTemplate(template).issues, 'event_order_inconsistent');
    expect(found?.message).toMatch(/fires earlier/);
  });
});

describe('typed state', () => {
  it('rejects an unknown set key with a suggestion', () => {
    const report = validateTemplate(
      templateWithInteractions([
        interaction({
          verb: 'set',
          dynamics: undefined,
          target: { key: 'rules.collisionAvoidence', value: false },
        }),
      ]),
    );
    const [found] = find(report.issues, 'unknown_set_key');
    expect(found?.message).toMatch(/did you mean/);
  });

  it('rejects a value of the wrong type or out of range', () => {
    const wrongType = validateTemplate(
      templateWithInteractions([
        interaction({
          verb: 'set',
          dynamics: undefined,
          target: { key: 'rules.collisionAvoidance', value: 'no' },
        }),
      ]),
    );
    expect(codes(wrongType.issues)).toContain('set_value_type');

    const outOfRange = validateTemplate(
      templateWithInteractions([
        interaction({
          verb: 'set',
          dynamics: undefined,
          target: { key: 'rules.aggression', value: 4 },
        }),
      ]),
    );
    expect(codes(outOfRange.issues)).toContain('set_value_range');
  });

  it('requires @world for env and signal keys, and a role for the rest', () => {
    const wrongActor = validateTemplate(
      templateWithInteractions([
        interaction({
          verb: 'set',
          dynamics: undefined,
          target: { key: 'env.frictionScale', value: 0.4 },
        }),
      ]),
    );
    expect(codes(wrongActor.issues)).toContain('set_actor_mismatch');

    const right = validateTemplate(
      templateWithInteractions([
        interaction({
          actor: '@world',
          verb: 'set',
          dynamics: undefined,
          target: { key: 'env.frictionScale', value: 0.4 },
        }),
      ]),
    );
    expect(right.issues).toEqual([]);

    const worldOnRole = validateTemplate(
      templateWithInteractions([
        interaction({
          actor: '@world',
          verb: 'set',
          dynamics: undefined,
          target: { key: 'lights.brake', value: true },
        }),
      ]),
    );
    expect(codes(worldOnRole.issues)).toContain('set_actor_mismatch');
  });

  it('rejects a vehicle-only key on a pedestrian', () => {
    const base = ltapTemplateInput();
    const template = parseTemplate({
      ...base,
      roles: [
        ...(base.roles as object[]),
        { id: 'ped', kind: 'on_reference', actor: { class: 'pedestrian' }, pose: { s: 20 } },
      ],
      invariants: [],
      choreography: {
        interactions: [
          interaction({
            actor: 'ped',
            verb: 'set',
            dynamics: undefined,
            target: { key: 'lights.indicator', value: 'left' },
          }),
        ],
      },
    });
    const [found] = find(validateTemplate(template).issues, 'set_actor_mismatch');
    expect(found?.actual).toBe('pedestrian');
  });
});

describe('document coherence', () => {
  it('warns about an anchor that constrains nothing', () => {
    const base = ltapTemplateInput();
    const report = validateTemplate(parseTemplate({ ...base, anchor: {} , roles: [], invariants: [], choreography: { interactions: [] }, metricSubject: undefined }));
    expect(codes(report.issues)).toContain('anchor_unconstrained');
  });

  it('reports a derived-parameter cycle', () => {
    const base = ltapTemplateInput();
    const template = parseTemplate({
      ...base,
      params: {
        declarations: [
          { id: 'a', type: 'derived', expr: 'param.b + 1' },
          { id: 'b', type: 'derived', expr: 'param.a - 1' },
        ],
        constraints: [],
      },
      roles: [],
      invariants: [],
      choreography: { interactions: [] },
      metricSubject: undefined,
    });
    expect(codes(validateTemplate(template).issues)).toContain('derived_param_cycle');
  });

  it('reports roles placed relative to each other in a cycle', () => {
    const base = ltapTemplateInput();
    const template = parseTemplate({
      ...base,
      roles: [
        { id: 'a', kind: 'relative_to', actor: { class: 'car' }, ref: 'b', dsM: 10 },
        { id: 'b', kind: 'relative_to', actor: { class: 'car' }, ref: 'a', dsM: -10 },
      ],
      invariants: [],
      choreography: { interactions: [] },
      metricSubject: 'a',
    });
    expect(codes(validateTemplate(template).issues)).toContain('relative_to_cycle');
  });

  it('requires an occlusion pair alongside a reveal target', () => {
    const base = ltapTemplateInput();
    const template = parseTemplate({
      ...base,
      props: [
        {
          id: 'van',
          catalogId: 'vehicle.parked.van',
          pose: { s: -20, tFrac: 0.9 },
          targetRevealToConflictS: 0.8,
        },
      ],
    });
    const [found] = find(validateTemplate(template).issues, 'occluder_pair_missing');
    expect(found?.message).toMatch(/who is hidden from whom/);
  });

  it('warns about a cosmetic occluder', () => {
    const base = ltapTemplateInput();
    const template = parseTemplate({
      ...base,
      props: [
        {
          id: 'van',
          catalogId: 'vehicle.parked.van',
          pose: { s: -20, tFrac: 0.9 },
          occludes: { observer: 'ego', target: 'challenger' },
          essentiality: 'cosmetic',
        },
      ],
    });
    expect(codes(validateTemplate(template).issues)).toContain('occluder_dropped');
  });

  it('warns about a conflicting gate with no arrival relation', () => {
    const base = ltapTemplateInput();
    const roles = (base.roles as Array<Record<string, unknown>>).map((role) =>
      role.id === 'challenger' ? { ...role, arriveAtConflict: undefined } : role,
    );
    const template = parseTemplate({ ...base, roles: roles as never });
    expect(codes(validateTemplate(template).issues)).toContain('trigger_unbindable');
  });

  it('reports an override that names a role which does not exist', () => {
    const base = ltapTemplateInput();
    const template = parseTemplate({
      ...base,
      variants: [
        {
          id: 'narrow',
          when: [{ left: 'lane.widthM', op: '<', right: 3 }],
          overrides: [{ path: 'roles#nobody.initialSpeedKph', value: 20 }],
        },
      ],
    });
    const [found] = find(validateTemplate(template).issues, 'variant_target_unknown');
    expect(found?.required).toEqual(['challenger', 'ego']);
  });

  it('accepts an override that names a role which does exist', () => {
    const base = ltapTemplateInput();
    const template = parseTemplate({
      ...base,
      variants: [
        {
          id: 'narrow',
          when: [{ left: 'lane.widthM', op: '<', right: 3 }],
          overrides: [{ path: 'roles#challenger.initialSpeedKph', value: 20 }],
        },
      ],
    });
    expect(validateTemplate(template).issues).toEqual([]);
  });

  it('lists roles nothing refers to', () => {
    const base = ltapTemplateInput();
    const template = parseTemplate({
      ...base,
      roles: [
        ...(base.roles as object[]),
        { id: 'bystander', kind: 'on_reference', actor: { class: 'car' }, pose: { s: 150 } },
      ],
    });
    expect(unusedRoles(template)).toEqual(['bystander']);
  });
});

describe('map-dependent checks', () => {
  it('reports a role with no lane under it', () => {
    const map = createFakeMapContext({ lanes: [{ k: 0, extentM: [-200, 200] }] });
    const base = ltapTemplateInput();
    const template = parseTemplate({
      ...base,
      roles: [
        ...(base.roles as object[]),
        { id: 'left', kind: 'lane_offset', actor: { class: 'car' }, k: 3, pose: { s: 0 } },
      ],
    });
    const found = find(validateTemplate(template, map).issues, 'role_unbound').find((i) =>
      i.message.includes('no lane at frame position'),
    );
    expect(found?.severity).toBe('error');
    expect(found?.message).toMatch(/no lane at frame position \(k=3, s=0 m\)/);
  });

  it('softens a missing lane when onMissing says how to cope', () => {
    const map = createFakeMapContext({ lanes: [{ k: 0, extentM: [-200, 200] }] });
    const base = ltapTemplateInput();
    const template = parseTemplate({
      ...base,
      roles: [
        ...(base.roles as object[]),
        {
          id: 'left',
          kind: 'lane_offset',
          actor: { class: 'car' },
          k: 3,
          onMissing: 'clamp',
          pose: { s: 0 },
        },
      ],
    });
    const found = find(validateTemplate(template, map).issues, 'role_unbound').find((i) =>
      i.message.includes('no lane at frame position'),
    );
    expect(found?.severity).toBe('warning');
    expect(found?.message).toMatch(/onMissing="clamp"/);
  });

  it('reports a vehicle on a sidewalk and a pedestrian on a driving lane', () => {
    const base = ltapTemplateInput();
    const carOnPavement = parseTemplate({
      ...base,
      roles: [
        ...(base.roles as object[]),
        { id: 'stray', kind: 'lane_offset', actor: { class: 'car' }, k: 2, pose: { s: 0 } },
      ],
    });
    expect(codes(validateTemplate(carOnPavement, ltapMapContext()).issues)).toContain(
      'wrong_lane_type',
    );

    const pedOnRoad = parseTemplate({
      ...base,
      roles: [
        ...(base.roles as object[]),
        { id: 'ped', kind: 'lane_offset', actor: { class: 'pedestrian' }, k: 1, pose: { s: 0 } },
      ],
    });
    expect(codes(validateTemplate(pedOnRoad, ltapMapContext()).issues)).toContain('wrong_lane_type');
  });

  it('reports overlapping spawn footprints in the same lane', () => {
    const base = ltapTemplateInput();
    const template = parseTemplate({
      ...base,
      roles: [
        ...(base.roles as object[]),
        { id: 'tooClose', kind: 'on_reference', actor: { class: 'car' }, pose: { s: -78 } },
      ],
    });
    const [found] = find(validateTemplate(template, ltapMapContext()).issues, 'spawn_overlap');
    expect(found?.required).toBe(4.8);
    expect(found?.actual).toBe(2);
  });

  it('reports insufficient runway over the whole clip, not just the event window', () => {
    // 45 kph for 20 s is 250 m; this corridor only offers 120 m ahead.
    const map = createFakeMapContext({ lanes: [{ k: 0, extentM: [-200, 40] }] });
    const found = find(validateTemplate(ltapTemplate(), map).issues, 'runway_insufficient');
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('warning');
    expect(found[0]?.path).toBe('roles.0');
    expect(found[0]?.required).toBe(250);
    expect(found[0]?.actual).toBe(120);
  });

  it('warns when there is not enough run-up for the warm-up', () => {
    const map = createFakeMapContext({ lanes: [{ k: 0, extentM: [-90, 300] }] });
    const warnings = find(validateTemplate(ltapTemplate(), map).issues, 'runway_insufficient').filter(
      (i) => i.severity === 'warning',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/run-up/);
  });

  it('reports a lane change into a lane that is not there, and one the markings forbid', () => {
    const noLane = templateWithInteractions([
      interaction({ verb: 'changeLane', target: { mode: 'relative', dk: 4 } }),
    ]);
    expect(codes(validateTemplate(noLane, ltapMapContext()).issues)).toContain(
      'illegal_lane_change',
    );

    const solidLine = ltapMapContext({
      lanes: [
        { k: 0, extentM: [-200, 200], changeLeft: false },
        { k: 1, extentM: [-200, 200] },
      ],
    });
    const legalTarget = templateWithInteractions([
      interaction({ verb: 'changeLane', target: { mode: 'relative', dk: 1 } }),
    ]);
    const found = find(validateTemplate(legalTarget, solidLine).issues, 'illegal_lane_change');
    expect(found[0]?.severity).toBe('warning');
  });

  it('reports a turn the junction does not offer', () => {
    const template = templateWithInteractions([
      interaction({
        verb: 'route',
        dynamics: undefined,
        target: { mode: 'turn', feature: 'jx', turn: 'uturn' },
      }),
    ]);
    expect(codes(validateTemplate(template, ltapMapContext()).issues)).toContain(
      'route_disconnected',
    );
  });

  it('reports a role bound to a junction movement the site does not have', () => {
    const map = ltapMapContext({ gates: { 'jx/same/straight': {} } });
    expect(codes(validateTemplate(ltapTemplate(), map).issues)).toContain('role_unbound');
  });

  it('reports a signal condition that cannot bind', () => {
    const missing = templateWithInteractions([
      interaction({
        trigger: {
          kind: 'when',
          condition: { kind: 'signal', signal: { handle: 'nope' }, phase: 'green' },
          byLatest: 10,
        },
      }),
    ]);
    expect(codes(validateTemplate(missing, ltapMapContext()).issues)).toContain(
      'trigger_unbindable',
    );

    const wrongPhase = templateWithInteractions([
      interaction({
        trigger: {
          kind: 'when',
          condition: {
            kind: 'signal',
            signal: { feature: 'jx', approach: 'subject' },
            phase: 'flashing_yellow',
          },
          byLatest: 10,
        },
      }),
    ]);
    const [found] = find(validateTemplate(wrongPhase, ltapMapContext()).issues, 'trigger_unbindable');
    expect(found?.required).toEqual(['green', 'yellow', 'red']);
  });

  it('warns when a role starts well over the posted limit', () => {
    const base = ltapTemplateInput();
    const template = parseTemplate({
      ...base,
      roles: [
        ...(base.roles as object[]),
        { id: 'speeder', kind: 'on_reference', actor: { class: 'car' }, pose: { s: 100 }, initialSpeedKph: 90 },
      ],
    });
    const [found] = find(validateTemplate(template, ltapMapContext()).issues, 'speed_over_limit');
    expect(found?.required).toBe(50);
  });

  it('stays silent about map facts when no context is supplied', () => {
    const map = createFakeMapContext({ lanes: [] });
    expect(validateTemplate(ltapTemplate()).issues).toEqual([]);
    expect(validateTemplate(ltapTemplate(), map).issues.length).toBeGreaterThan(0);
  });
});

describe('parseAndValidateTemplate', () => {
  it('returns schema failures in the same issue shape', () => {
    const { template, report } = parseAndValidateTemplate({ scenarioVersion: 2 });
    expect(template).toBeUndefined();
    expect(report.ok).toBe(false);
    expect(new Set(codes(report.issues))).toEqual(new Set(['schema_invalid']));
  });

  it('parses and then validates in one call', () => {
    const { template, report } = parseAndValidateTemplate(ltapTemplateInput(), ltapMapContext());
    expect(template?.meta.archetype).toBe('C3.ltap-od');
    expect(report.ok).toBe(true);
  });
});
