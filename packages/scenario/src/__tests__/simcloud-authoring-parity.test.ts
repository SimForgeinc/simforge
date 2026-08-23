import { describe, expect, it } from 'vitest';

import { ScenarioValidationError } from '../errors.js';
import { TemplateDocument } from '../template-document.js';
import { validateTemplate } from '../validate/index.js';

describe('SimCloud authoring parity', () => {
  it('persists reasoning trace segments with undo and clip validation', () => {
    const document = TemplateDocument.create({ name: 'Reasoning trace parity' });
    document.addRole({
      id: 'ego', kind: 'scene_absolute',
      actor: { class: 'car', static: false, sensors: [] },
      pose: { position: { x: 0, y: 0, z: 0 }, headingRad: 0 },
      essentiality: 'required',
    });
    document.setMetricSubject('ego');
    document.addReasoningTraceSegment({
      id: 'trace-brake', actor: 'ego', startS: 3, endS: 5,
      observation: 'Pedestrian approaches the crossing.',
      action: 'Ease off the accelerator and prepare to brake.',
    });

    expect(document.reasoningTrace[0]?.observation).toContain('Pedestrian');
    document.replaceReasoningTraceSegment('trace-brake', { ...document.reasoningTrace[0]!, endS: 6 });
    expect(document.reasoningTrace[0]?.endS).toBe(6);
    expect(document.undo()).toBe(true);
    expect(document.reasoningTrace[0]?.endS).toBe(5);
    expect(() => document.addReasoningTraceSegment({
      id: 'trace-too-long', actor: 'ego', startS: 19, endS: 21,
      observation: '', action: '',
    })).toThrow(ScenarioValidationError);
  });

  it('supports the full product actor and authoring operation vocabulary', () => {
    const document = TemplateDocument.create({ name: 'Editor parity' });
    document.setEnvironment({ weather: 'heavy_rain', timeOfDay: 'dusk', surfacePatches: [] });
    document.addParam({ id: 'speed_factor', type: 'continuous', range: [0.8, 1.2], default: 1, distribution: 'uniform', tier: 1 });
    document.addProp({
      id: 'barrier', catalogId: 'construction.barrier',
      pose: { laneOffset: 0, s: 12, tFrac: 0, headingOffsetRad: 0 },
      headingOffsetRad: 0, scale: 1, essentiality: 'preferred',
    });
    document.addVariant({
      id: 'wet', when: [{ left: 1, op: '>=', right: 1 }],
      overrides: [{ path: 'environment.weather', op: 'set', value: 'wet_road' }],
    });

    for (const [index, actor] of [
      { class: 'sidewalk_robot' as const, catalogId: 'sidewalk_robot.delivery_rover' },
      { class: 'drone' as const, catalogId: 'drone.camera_quadcopter' },
      { class: 'animal' as const, catalogId: 'animal.deer' },
    ].entries()) {
      document.addRole({
        id: `dynamic-actor-${index}`, kind: 'scene_absolute',
        actor: { ...actor, static: false, sensors: [] },
        pose: { position: { x: index, y: 0, z: 0 }, headingRad: 0 },
        essentiality: 'required',
      });
    }

    expect(document.data.environment).toMatchObject({ weather: 'heavy_rain', timeOfDay: 'dusk' });
    expect(document.data.params.declarations).toHaveLength(1);
    expect(document.data.props).toHaveLength(1);
    expect(document.data.variants).toHaveLength(1);
    expect(document.roles.map((role) => role.actor.class)).toEqual(['sidewalk_robot', 'drone', 'animal']);
  });

  it('accepts product route intents without conflating portable and map-bound paths', () => {
    const document = TemplateDocument.create({ name: 'Route parity' });
    document.addRole({
      id: 'vehicle', kind: 'scene_absolute',
      actor: { class: 'car', static: false, sensors: [] },
      pose: { position: { x: 0, y: 0, z: 0 }, headingRad: 0 },
      essentiality: 'required',
    });
    document.addInteraction({
      id: 'next-left', verb: 'route', actor: 'vehicle', trigger: { kind: 'at', t: 1 },
      target: { mode: 'nextJunction', turn: 'left' },
    });
    document.addInteraction({
      id: 'custom-path', verb: 'route', actor: 'vehicle', trigger: { kind: 'at', t: 3 },
      target: { mode: 'customRoute', points: [{ x: 0, z: 0 }, { x: 4, z: 8 }] },
    });
    expect(document.interactions.map((interaction) => interaction.id)).toEqual(['next-left', 'custom-path']);
  });

  it('rejects motion authored for a static actor', () => {
    const document = TemplateDocument.create({ name: 'Static actor parity' });
    document.addRole({
      id: 'parked', kind: 'scene_absolute', initialSpeedKph: 20,
      actor: { class: 'car', static: true, sensors: [] },
      pose: { position: { x: 0, y: 0, z: 0 }, headingRad: 0 },
      essentiality: 'required',
    });
    document.addInteraction({
      id: 'parked-route', verb: 'route', actor: 'parked', trigger: { kind: 'at', t: 1 },
      target: { mode: 'nextJunction', turn: 'straight' },
    });

    const staticMotion = validateTemplate(document.data).issues.filter((issue) => issue.code === 'static_actor_motion');
    expect(staticMotion.map((issue) => issue.path)).toEqual(expect.arrayContaining([
      'roles.0.initialSpeedKph',
      'choreography.interactions.0',
    ]));
    expect(staticMotion).toHaveLength(2);
  });
});
