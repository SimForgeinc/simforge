/**
 * Executability contract for the portable corridor mechanism examples.
 *
 * These checks intentionally run without dev-assets. They prove that every
 * checked-in file parses, is structurally valid, resolves a deterministic
 * parameter draw, adapts every required role, and stays inside the subset of
 * choreography primitives the current materializer can emit to sim-engine.
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  validateTemplate,
  type Interaction,
  type ScenarioTemplateV2,
} from '@uniscenarios/scenario-model';

import { adaptTemplate } from '../adapt.js';
import { assertRequiredRoleBindings } from '../materialize.js';
import { REPO_ROOT } from '@uniscenarios/scenario-materializer';
import { resolveParams } from '../params.js';
import { readTemplate } from '@uniscenarios/scenario-materializer';

const DIRECTORY = path.join(REPO_ROOT, 'examples', 'mechanisms', 'corridor');

const CASES = [
  ['lead-hard-brake.template.json', 'longitudinal.lead-hard-brake'],
  ['queue-tail.template.json', 'longitudinal.queue-tail'],
  ['cutout-reveals-stopped.template.json', 'longitudinal.cutout-reveals-stopped'],
  ['cut-in-brake.template.json', 'longitudinal.cut-in-brake'],
  ['sideswipe.template.json', 'lane-change.sideswipe'],
  ['merge-gap-collapse.template.json', 'lane-change.merge-gap-collapse'],
] as const;

function file(name: string): string {
  return path.join(DIRECTORY, name);
}

async function template(name: string): Promise<ScenarioTemplateV2> {
  return readTemplate(file(name));
}

/** True for choreography forms materialize.ts currently preserves. */
function interactionIsExecutable(interaction: Interaction): boolean {
  if (interaction.trigger.kind === 'after' && interaction.trigger.event === 'end') return false;
  if (interaction.until && interaction.until.kind !== 'when') return false;
  if (interaction.verb === 'speed' && interaction.target.mode === 'resume') return false;
  if (interaction.verb === 'route' && interaction.target.mode !== 'polyline') return false;
  if (interaction.verb === 'changeLane' && interaction.target.mode === 'relative' && interaction.target.dk === 0) return false;
  return true;
}

function continuousInteractionHasDynamics(interaction: Interaction): boolean {
  switch (interaction.verb) {
    case 'speed':
    case 'gap':
    case 'changeLane':
    case 'laneOffset':
      return interaction.dynamics !== undefined;
    default:
      return true;
  }
}

describe('corridor mechanism templates', () => {
  it.each(CASES)('%s parses, validates, adapts, and resolves a draw', async (name, archetype) => {
    const doc = await template(name);
    expect(doc.meta.archetype).toBe(archetype);
    expect(doc.metricSubject).toBe(name === 'queue-tail.template.json' ? undefined : 'ego');

    const report = validateTemplate(doc);
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);

    const adapted = adaptTemplate(doc);
    expect(adapted.roles.map((role) => role.role).sort()).toEqual(
      doc.roles.map((role) => role.id).sort(),
    );
    expect(adapted.notes.filter((note) => /not portable|not matchable/.test(note.reason))).toEqual([]);

    for (const drawIndex of [-1, 0, 1]) {
      const draw = resolveParams(doc, { siteId: 'corridor-mechanism-test-site', drawIndex });
      expect(draw.rejectedConstraints).toEqual([]);
      expect(Object.keys(draw.values)).toHaveLength(doc.params.declarations.length);
    }

    expect(doc.choreography.interactions.every(interactionIsExecutable)).toBe(true);
    expect(doc.choreography.interactions.every(continuousInteractionHasDynamics)).toBe(true);
  });

  it('lead-hard-brake carries the brake/reaction sequence and deceleration budget', async () => {
    const doc = await template('lead-hard-brake.template.json');
    expect(doc.choreography.interactions.find((item) => item.id === 'lead-brakes')).toMatchObject({
      verb: 'speed',
      target: { mode: 'stop' },
      dynamics: { constraint: 'rate' },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'ego-brakes')).toMatchObject({
      verb: 'speed',
      trigger: { kind: 'after', of: 'lead-brakes', event: 'start', delayS: { kind: 'ref', name: 'param.reactionDelayS' } },
      target: { mode: 'stop' },
      dynamics: { constraint: 'rate', value: 8 },
    });
    expect(doc.invariants).toContainEqual(expect.objectContaining({ kind: 'decel_budget', of: 'ego' }));
    expect(doc.invariants).toContainEqual(expect.objectContaining({
      kind: 'event_order', events: ['lead-brakes', 'ego-brakes'], minSeparationS: { kind: 'ref', name: 'param.reactionDelayS' },
    }));
    expect(doc.invariants).toContainEqual(expect.objectContaining({
      id: 'minimum-clearance', kind: 'gap', of: 'ego', to: 'lead', range: [4.5, null],
    }));
  });

  it('queue-tail contains a stopped two-vehicle queue, an occlusion pair, and physical braking on reveal', async () => {
    const doc = await template('queue-tail.template.json');
    expect(doc.roles.map((role) => role.id)).toEqual(['ego', 'queue-tail', 'queue-lead']);
    expect(doc.roles.filter((role) => role.id.startsWith('queue-')).every((role) => role.actor.static)).toBe(true);
    expect(doc.props).toContainEqual(expect.objectContaining({
      occludes: { observer: 'ego', target: 'queue-tail' },
    }));
    expect(doc.choreography.interactions.find((item) => item.id === 'ego-cannot-react-before-reveal')).toMatchObject({
      actor: 'ego', verb: 'set', target: { key: 'rules.collisionAvoidance', value: false },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'ego-brakes-on-reveal')).toMatchObject({
      actor: 'ego',
      verb: 'speed',
      trigger: {
        kind: 'when',
        condition: { kind: 'distance', from: 'ego', to: { role: 'queue-tail' }, measure: 'euclidean' },
        ifNever: 'skip',
      },
      target: { mode: 'stop' },
    });
    expect(doc.invariants).toContainEqual(expect.objectContaining({
      kind: 'closing_speed', of: 'ego', to: 'queue-tail',
    }));
    expect(doc.invariants).toContainEqual(expect.objectContaining({
      id: 'queue-clearance', kind: 'gap', range: [4.5, null],
    }));
  });

  it('cut-out uses the moving lead as occluder, reveals the static hazard, then brakes ego', async () => {
    const doc = await template('cutout-reveals-stopped.template.json');
    expect(doc.roles.find((role) => role.id === 'lead-cutout')?.extensions?.['occludes']).toEqual({
      observer: 'ego', target: 'stopped',
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'lead-cuts-out')).toMatchObject({
      verb: 'route',
      trigger: { kind: 'at', t: 0.2 },
      target: {
        mode: 'polyline',
        points: [
          expect.objectContaining({ tFrac: 0 }),
          expect.objectContaining({ tFrac: -1 }),
          expect.objectContaining({ tFrac: -1 }),
        ],
      },
    });
    expect(doc.roles.find((role) => role.id === 'stopped')?.actor.static).toBe(true);
    expect(doc.choreography.interactions.find((item) => item.id === 'ego-cannot-react-before-reveal')).toMatchObject({
      actor: 'ego', verb: 'set', target: { key: 'rules.collisionAvoidance', value: false },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'ego-brakes-on-reveal')).toMatchObject({
      actor: 'ego', verb: 'speed',
      trigger: { kind: 'after', of: 'lead-cuts-out', event: 'start' },
      target: { mode: 'stop' },
    });
    expect(doc.invariants).toContainEqual(expect.objectContaining({
      kind: 'event_order', events: ['lead-cuts-out', 'ego-brakes-on-reveal'],
    }));
    expect(doc.invariants).toContainEqual(expect.objectContaining({
      id: 'stopped-vehicle-clearance', kind: 'gap', range: [4.5, null],
    }));
  });

  it('rejects a cached cut-out site that is missing its required moving occluder', async () => {
    const doc = await template('cutout-reveals-stopped.template.json');
    expect(doc.roles.find((role) => role.id === 'lead-cutout')?.essentiality).toBe('required');

    expect(() => assertRequiredRoleBindings(doc, {
      bindings: [
        { role: 'ego', kind: 'on_reference', status: 'bound', notes: [] },
        { role: 'stopped', kind: 'relative_to', status: 'bound', notes: [] },
      ],
    })).toThrow(expect.objectContaining({
      code: 'role_unbound',
      path: 'roles.lead-cutout',
      detail: expect.objectContaining({ status: 'missing' }),
    }));
  });

  it('cut-in-brake orders lateral insertion, cut-in braking, and ego aftermath braking', async () => {
    const doc = await template('cut-in-brake.template.json');
    expect(doc.choreography.interactions.find((item) => item.id === 'cut-in-enters')).toMatchObject({
      verb: 'changeLane', target: { mode: 'toRole', role: 'ego' },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'cut-in-brakes')).toMatchObject({
      verb: 'speed', trigger: { kind: 'after', of: 'cut-in-enters', event: 'start', delayS: 2.6 },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'ego-brakes')).toMatchObject({
      actor: 'ego', verb: 'speed',
      trigger: { kind: 'after', of: 'cut-in-brakes', event: 'start', delayS: 1.1 },
      target: { mode: 'stop' },
    });
    expect(doc.choreography.interactions.some((item) =>
      item.actor === 'ego' && item.verb === 'set' && item.target.key === 'rules.collisionAvoidance',
    )).toBe(false);
    expect(doc.invariants).toContainEqual(expect.objectContaining({
      kind: 'event_order', events: ['cut-in-enters', 'cut-in-brakes', 'ego-brakes'],
    }));
    expect(doc.invariants).toContainEqual(expect.objectContaining({
      id: 'stable-aftermath-clearance', kind: 'gap', range: [4.5, null],
    }));
  });

  it('sideswipe proves side-envelope overlap and preserves the delayed yielding aftermath', async () => {
    const doc = await template('sideswipe.template.json');
    const drifter = doc.roles.find((role) => role.id === 'drifting-vehicle');
    expect(drifter).toMatchObject({ kind: 'relative_to', ref: 'ego', dLane: -1 });
    expect(doc.choreography.interactions.find((item) => item.id === 'unsignalled-drift')).toMatchObject({
      verb: 'changeLane', target: { mode: 'toRole', role: 'ego' },
      dynamics: { shape: 'sinusoidal', constraint: 'rate' },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'drifter-aborts-incursion')).toMatchObject({
      verb: 'changeLane', target: { mode: 'absolute', k: 1 },
      dynamics: { shape: 'sinusoidal', constraint: 'rate' },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'ego-yields-after-incursion')).toMatchObject({
      actor: 'ego', verb: 'speed', trigger: { kind: 'after', of: 'unsignalled-drift', delayS: 2.8 },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'ego-holds-course')).toMatchObject({
      actor: 'ego', verb: 'set', target: { key: 'rules.collisionAvoidance', value: false },
    });
    expect(doc.invariants.some((invariant) => invariant.kind === 'ttc')).toBe(false);
    expect(doc.invariants).toContainEqual(expect.objectContaining({
      id: 'side-envelope-conflict', kind: 'gap', of: 'ego', to: 'drifting-vehicle', range: [0, 2.2],
    }));
    expect(doc.invariants).toContainEqual(expect.objectContaining({
      kind: 'event_order', events: ['unsignalled-drift', 'ego-yields-after-incursion'], minSeparationS: 2.8,
    }));
  });

  it('does not substitute reveal or response events with ego presentation markers', async () => {
    const docs = await Promise.all([
      'lead-hard-brake.template.json',
      'queue-tail.template.json',
      'cutout-reveals-stopped.template.json',
      'cut-in-brake.template.json',
      'sideswipe.template.json',
    ].map(template));
    const egoPresentationMarkers = docs.flatMap((doc) => doc.choreography.interactions)
      .filter((item) => item.actor === 'ego' && item.verb === 'set' && item.target.key.startsWith('lights.'));
    expect(egoPresentationMarkers).toEqual([]);
  });

  it('merge-gap-collapse is anchored to a merge approach and accelerates both participants before entry', async () => {
    const doc = await template('merge-gap-collapse.template.json');
    expect(doc.anchor.features).toContainEqual(expect.objectContaining({
      id: 'merge-point',
      kind: 'junction',
      conflictingApproach: expect.objectContaining({
        value: expect.objectContaining({ from: 'merge' }),
      }),
    }));
    expect(doc.roles.find((role) => role.id === 'merging')).toMatchObject({
      kind: 'conflicting_gate',
      feature: 'merge-point',
      from: 'merge',
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'ego-accelerates')?.verb).toBe('speed');
    expect(doc.choreography.interactions.find((item) => item.id === 'merger-accelerates')?.verb).toBe('speed');
    expect(doc.choreography.interactions.find((item) => item.id === 'merging-enters')).toMatchObject({
      verb: 'set', trigger: { kind: 'at', t: 2 }, target: { key: 'lights.indicator', value: 'left' },
    });
  });
});
