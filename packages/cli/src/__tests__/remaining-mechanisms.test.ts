/**
 * Executability and semantic contracts for the final taxonomy mechanisms.
 *
 * All nine use typed v2 primitives. The dooring case additionally records the
 * engine contract that doors.left must own a hinged collision shape, not just
 * renderer state.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  validateTemplate,
  type Interaction,
  type ScenarioTemplateV2,
} from '@uniscenarios/scenario-model';

import { adaptTemplate } from '../adapt.js';
import { INCIDENT_TAXONOMY } from '../catalog-taxonomy.js';
import { REPO_ROOT } from '../maps.js';
import { resolveParams } from '../params.js';
import { readTemplate } from '../template-io.js';

const DIRECTORY = path.join(REPO_ROOT, 'examples', 'mechanisms', 'remaining');
const CASES = [
  ['cross-traffic-stop-violation.template.json', 'intersection.cross-traffic-stop-violation'],
  ['red-light-late-entry.template.json', 'intersection.red-light-late-entry'],
  ['opposing-turn-encroachment.template.json', 'intersection.opposing-turn-encroachment'],
  ['reversing-pedestrian.template.json', 'vru.reversing-pedestrian'],
  ['cyclist-right-hook.template.json', 'vru.cyclist-right-hook'],
  ['dooring-cyclist.template.json', 'vru.dooring-cyclist'],
  ['slow-vulnerable-lead.template.json', 'longitudinal.slow-vulnerable-lead'],
  ['lane-drop-late-merge.template.json', 'lane-change.lane-drop-late-merge'],
  ['oncoming-overtake.template.json', 'lane-change.oncoming-overtake'],
] as const;

const DOORING = 'dooring-cyclist.template.json';
const EXECUTABLE_FILES = [
  'cross-traffic-stop-violation.template.json',
  'red-light-late-entry.template.json',
  'opposing-turn-encroachment.template.json',
  'reversing-pedestrian.template.json',
  'cyclist-right-hook.template.json',
  'dooring-cyclist.template.json',
  'slow-vulnerable-lead.template.json',
  'lane-drop-late-merge.template.json',
  'oncoming-overtake.template.json',
] as const;

function file(name: string): string {
  return path.join(DIRECTORY, name);
}

async function template(name: string): Promise<ScenarioTemplateV2> {
  return readTemplate(file(name));
}

function interactionIsExecutable(interaction: Interaction): boolean {
  if (interaction.trigger.kind === 'after' && interaction.trigger.event === 'end') return false;
  if (interaction.until && interaction.until.kind !== 'when') return false;
  if (interaction.verb === 'speed' && interaction.target.mode === 'resume') return false;
  if (interaction.verb === 'route' && !['polyline', 'turn'].includes(interaction.target.mode)) return false;
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

describe('remaining mechanism templates', () => {
  it('contains exactly the nine requested templates', async () => {
    const names = (await readdir(DIRECTORY)).filter((name) => name.endsWith('.template.json')).sort();
    expect(names).toEqual(CASES.map(([name]) => name).sort());
  });

  it.each(CASES)('%s parses, adapts every role, and resolves deterministic draws', async (name, archetype) => {
    const doc = await template(name);
    expect(doc.meta.archetype).toBe(archetype);
    expect(doc.metricSubject).toBe(name === 'dooring-cyclist.template.json' ? 'cyclist' : 'ego');

    const adapted = adaptTemplate(doc);
    expect(adapted.roles.map((role) => role.role).sort()).toEqual(doc.roles.map((role) => role.id).sort());
    expect(adapted.notes.filter((note) => /not portable|not matchable/.test(note.reason))).toEqual([]);

    for (const drawIndex of [-1, 0, 1]) {
      const draw = resolveParams(doc, { siteId: 'remaining-mechanism-test-site', drawIndex });
      expect(draw.rejectedConstraints).toEqual([]);
      expect(Object.keys(draw.values)).toHaveLength(doc.params.declarations.length);
    }
  });

  it.each(EXECUTABLE_FILES)('%s validates and uses executable choreography', async (name) => {
    const doc = await template(name);
    expect(validateTemplate(doc).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(doc.choreography.interactions.every(interactionIsExecutable)).toBe(true);
    expect(doc.choreography.interactions.every(continuousInteractionHasDynamics)).toBe(true);
  });

  it('preserves stop control and a non-stopping cross-traffic conflict gate', async () => {
    const doc = await template('cross-traffic-stop-violation.template.json');
    expect(doc.anchor.features[0]).toMatchObject({
      kind: 'junction',
      control: { value: ['minor_stop'], essentiality: 'required' },
      conflictingApproach: { value: { from: 'from_left', turn: 'straight' } },
    });
    expect(doc.roles.find((role) => role.id === 'violator')).toMatchObject({
      kind: 'conflicting_gate',
      from: 'from_left',
      turn: 'straight',
      arriveAtConflict: { relativeTo: 'ego' },
      requiredMovementControl: 'stop',
    });
    expect(doc.roles.find((role) => role.id === 'ego')).toMatchObject({
      requiredMovementControl: 'uncontrolled',
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'violator-ignores-stop')).toMatchObject({
      verb: 'set', target: { key: 'rules.obeySignals', value: false },
    });
  });

  it('binds red-light entry to physical signal phases on both approaches', async () => {
    const doc = await template('red-light-late-entry.template.json');
    expect(doc.anchor.features[0]).toMatchObject({ kind: 'junction', control: { value: ['signalized'] } });
    expect(doc.choreography.interactions.find((item) => item.id === 'late-entry-commits')?.trigger).toMatchObject({
      kind: 'when', condition: { kind: 'signal', signal: { feature: 'signal-junction', approach: 'left' }, phase: 'red' },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'ego-released')?.trigger).toMatchObject({
      kind: 'when', condition: { kind: 'signal', signal: { feature: 'signal-junction', approach: 'subject' }, phase: 'green' },
    });
  });

  it('keeps the opposing turning path, bounds the apex encroachment, and recentres for aftermath', async () => {
    const doc = await template('opposing-turn-encroachment.template.json');
    expect(doc.roles.find((role) => role.id === 'encroaching-turner')).toMatchObject({
      kind: 'conflicting_gate', from: 'opposing', turn: 'left', arriveAtConflict: { relativeTo: 'ego' },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'cuts-apex')).toMatchObject({
      verb: 'laneOffset', target: { reference: 'lane_edge_right' }, dynamics: { shape: 'sinusoidal', constraint: 'rate' },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'turner-recentres')).toMatchObject({
      actor: 'encroaching-turner',
      verb: 'laneOffset',
      trigger: { kind: 'after', of: 'cuts-apex', event: 'start' },
      target: { tFrac: 0, reference: 'lane_center' },
      dynamics: { shape: 'sinusoidal', constraint: 'time' },
    });
    expect(doc.invariants).toContainEqual(expect.objectContaining({
      kind: 'event_order',
      events: ['cuts-apex', 'turner-recentres'],
      essentiality: 'required',
    }));
  });

  it('keeps reversing motion explicit while the pedestrian walks continuously behind it', async () => {
    const doc = await template('reversing-pedestrian.template.json');
    expect(doc.roles.find((role) => role.id === 'ego')).toMatchObject({
      kind: 'in_parking_zone', facing: 'perpendicular', extensions: { motionSemantics: 'reverse', vehicleFacingRelativeToTravel: 'opposite' },
    });
    expect(doc.roles.find((role) => role.id === 'pedestrian')?.actor.class).toBe('pedestrian');
    expect(doc.choreography.interactions.find((item) => item.id === 'ego-backing-route')).toMatchObject({ verb: 'route', target: { mode: 'polyline' } });
    expect(doc.choreography.interactions.find((item) => item.id === 'reverse-lamps-on')).toMatchObject({ verb: 'set', target: { key: 'lights.reverse', value: true } });
  });

  it('uses a bicycle, not a pedestrian, on the straight kerb-side right-hook path', async () => {
    const doc = await template('cyclist-right-hook.template.json');
    expect(doc.anchor.features[0]).toMatchObject({ kind: 'junction', egoTurn: { value: ['right'] } });
    expect(doc.roles.find((role) => role.id === 'cyclist')).toMatchObject({
      kind: 'relative_to', ref: 'ego', dLane: 0, tFrac: -0.82, actor: { class: 'bicycle' }, extensions: { movementSemantics: 'same-approach-straight-kerb-edge', mustNotSubstituteClass: true },
    });
    expect(doc.roles.some((role) => role.id === 'cyclist' && role.actor.class === 'pedestrian')).toBe(false);
    expect(INCIDENT_TAXONOMY.find((incident) => incident.id === 'vru.cyclist-right-hook')).toMatchObject({
      requiredAffordances: ['route', 'vehicleSpawn'],
      actors: expect.arrayContaining([expect.objectContaining({ role: 'cyclist', kind: 'cyclist' })]),
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'ego-turns-right')).toMatchObject({
      verb: 'route', target: { mode: 'turn', feature: 'hook-junction', turn: 'right' },
    });
  });

  it('uses the typed left-door state whose engine primitive is hinged and collidable', async () => {
    const doc = await template(DOORING);
    expect(validateTemplate(doc).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(doc.choreography.interactions[0]).toMatchObject({
      actor: 'parked-car', verb: 'set', target: { key: 'doors.left', value: 'opening' },
    });
    expect(doc.extensions?.['requiredPrimitive']).toBe(
      'The typed doors.left state must drive a hinged child collision shape attached to the parked vehicle, including its opening sweep; trace-only articulation is insufficient.',
    );
    expect(doc.roles.find((role) => role.id === 'parked-car')).toMatchObject({
      kind: 'in_parking_zone', actor: { class: 'car', static: true },
    });
    expect(doc.roles.find((role) => role.id === 'cyclist')?.actor.class).toBe('bicycle');
  });

  it('keeps the slow lead vulnerable, edge-riding, and constrained by oncoming traffic', async () => {
    const doc = await template('slow-vulnerable-lead.template.json');
    expect(doc.roles.find((role) => role.id === 'slow-road-user')).toMatchObject({
      kind: 'relative_to', ref: 'ego', dLane: 0, actor: { class: 'bicycle' }, extensions: { vulnerableRoadUser: true, mustNotSubstituteClass: true },
    });
    expect(doc.roles.find((role) => role.id === 'oncoming-constraint')?.kind).toBe('opposing');
    expect(doc.choreography.interactions.find((item) => item.id === 'cyclist-edge-wander')?.verb).toBe('laneOffset');
  });

  it('authors a temporary lane drop without claiming map-owned taper provenance', async () => {
    const doc = await template('lane-drop-late-merge.template.json');
    expect(doc.anchor.features[0]).toMatchObject({
      id: 'temporary-closure-reservation', kind: 'work_zone_suitable', essentiality: 'required',
    });
    expect(doc.extensions?.['temporaryControlProvenance']).toMatchObject({
      ownership: 'scenario-authored', mapOwnedLaneDrop: false, mechanism: 'temporary_lane_drop',
    });
    expect(doc.roles.find((role) => role.id === 'ego')).toMatchObject({ kind: 'lane_offset', k: -1, onMissing: 'fail' });
    expect(doc.roles.find((role) => role.id === 'late-merger')).toMatchObject({
      kind: 'on_reference', actor: { class: 'car' },
    });
    expect(doc.roles.find((role) => role.id === 'terminal-channelizer')).toMatchObject({
      actor: { class: 'static_object', static: true, catalogId: 'construction.channelizer_drum' },
    });
    expect(doc.props[0]).toMatchObject({
      id: 'closing-lane-taper', catalogId: 'construction.traffic_cone', essentiality: 'required',
      extensions: { collidable: true, controlOwnership: 'scenario-authored' },
    });
    expect(doc.trafficControls[0]).toMatchObject({
      id: 'closing-lane-red-x', kind: 'lane_control', phases: [{ indication: 'red_x', durationS: 12 }],
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'merge-at-temporary-taper')).toMatchObject({
      verb: 'changeLane', trigger: { kind: 'when', condition: { kind: 'distance' } },
      target: { mode: 'toRole', role: 'ego' },
    });
  });

  it('keeps both passing actors on the opposing path and returns the overtaker there', async () => {
    const doc = await template('oncoming-overtake.template.json');
    expect(doc.roles.find((role) => role.id === 'slow-vehicle')?.kind).toBe('opposing');
    expect(doc.roles.find((role) => role.id === 'overtaker')).toMatchObject({
      kind: 'opposing', extensions: { pathSemantics: 'opposing-to-ego-lane-and-return' },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'crosses-centerline')).toMatchObject({
      verb: 'changeLane', target: { mode: 'toRole', role: 'ego' },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'returns-opposing')).toMatchObject({
      verb: 'laneOffset', target: { tFrac: 0, reference: 'lane_center' },
    });
  });
});
