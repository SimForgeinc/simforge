import { describe, expect, it, vi } from 'vitest';

import { AuthoredActorLimitError, ScenarioMigrationError, ScenarioOperationError, ScenarioValidationError } from '../errors.js';
import { AUTHORED_ACTOR_LIMIT_CODE, MAX_AUTHORED_ACTORS } from '../actor-limits.js';
import { prepareSimulationInput } from '../materialization.js';
import { TemplateDocument } from '../template-document.js';
import { MemoryStorage } from '../stores/web.js';
import { WebTemplateFileStore } from '../stores/template-web.js';
import { ltapTemplate } from './v2-fixtures.js';

const T0 = '2026-08-01T10:00:00.000Z';
const T1 = '2026-08-01T10:00:01.000Z';

describe('TemplateDocument', () => {
  it('creates a canonical, clean v2 document', () => {
    const doc = TemplateDocument.create(
      { name: 'Scratch', sourceMap: { mapId: 'map', mapName: 'Map' }, createdAt: T0 },
      { now: () => T0 },
    );
    expect(doc.data.scenarioVersion).toBe(2);
    expect(doc.data.roles).toEqual([]);
    expect(doc.data.choreography.clipSeconds).toBe(20);
    expect(doc.isDirty).toBe(false);
    expect(Object.isFrozen(doc.data)).toBe(true);
  });

  it('edits roles and interactions with stable identities and undo/redo', () => {
    const now = vi.fn().mockReturnValue(T1);
    const doc = TemplateDocument.fromJSON(ltapTemplate(), { now });
    const original = doc.role('ego')!;
    doc.replaceRole('ego', { ...original, label: 'Metric vehicle' });
    expect(doc.role('ego')?.label).toBe('Metric vehicle');
    expect(doc.data.meta.modifiedAt).toBe(T1);

    const interaction = doc.interaction('ego-cruise')!;
    doc.replaceInteraction('ego-cruise', { ...interaction, label: 'Cruise' });
    expect(doc.interaction('ego-cruise')?.id).toBe('ego-cruise');
    expect(doc.undo()).toBe(true);
    expect(doc.interaction('ego-cruise')?.label).toBeUndefined();
    expect(doc.undo()).toBe(true);
    expect(doc.role('ego')).toEqual(original);
    expect(doc.redo()).toBe(true);
    expect(doc.role('ego')?.label).toBe('Metric vehicle');
  });

  it('rejects duplicate identity and schema-invalid operations atomically', () => {
    const doc = TemplateDocument.fromJSON(ltapTemplate());
    const before = doc.data;
    expect(() => doc.addRole({ ...doc.role('challenger')!, id: 'ego' })).toThrow(ScenarioOperationError);
    expect(doc.data).toBe(before);
    expect(() => doc.setClip(2)).toThrow(ScenarioValidationError);
    expect(doc.data).toBe(before);
  });

  it('allows referential repair states but surfaces them through validation', () => {
    const doc = TemplateDocument.fromJSON(ltapTemplate());
    doc.removeRole('challenger');
    expect(doc.validate().ok).toBe(false);
    expect(doc.validate().issues.some((issue) => issue.code === 'role_ref_unknown')).toBe(true);
  });

  it('enforces the 32 actor envelope with a stable error and atomic additions', () => {
    const doc = TemplateDocument.create({ name: 'Capacity' });
    const role = {
      id: 'actor-0',
      kind: 'scene_absolute' as const,
      actor: { class: 'car' as const, static: false, sensors: [] },
      pose: { position: { x: 0, y: 0, z: 0 }, headingRad: 0 },
      essentiality: 'required' as const,
    };
    for (let i = 0; i < MAX_AUTHORED_ACTORS; i++) doc.addRole({ ...role, id: `actor-${i}` });

    expect(() => doc.addRole({ ...role, id: 'actor-overflow' })).toThrow(AuthoredActorLimitError);
    try {
      doc.addRole({ ...role, id: 'actor-overflow' });
    } catch (error) {
      expect(error).toMatchObject({
        code: AUTHORED_ACTOR_LIMIT_CODE,
        actual: MAX_AUTHORED_ACTORS + 1,
        maximum: MAX_AUTHORED_ACTORS,
      });
    }
    expect(doc.roles).toHaveLength(MAX_AUTHORED_ACTORS);
  });

  it('opens legacy over-limit templates diagnostically and permits delete/undo recovery', () => {
    const seed = TemplateDocument.create({ name: 'Legacy capacity' });
    const roles = Array.from({ length: MAX_AUTHORED_ACTORS + 1 }, (_, index) => ({
      id: `legacy-${index}`,
      kind: 'scene_absolute' as const,
      actor: { class: 'car' as const, static: false, sensors: [] },
      pose: { position: { x: index, y: 0, z: 0 }, headingRad: 0 },
      essentiality: 'required' as const,
    }));
    const doc = TemplateDocument.fromJSON({ ...seed.data, roles });

    expect(doc.roles).toHaveLength(MAX_AUTHORED_ACTORS + 1);
    expect(doc.validate().ok).toBe(false);
    expect(doc.validate().issues.find((issue) => issue.code === AUTHORED_ACTOR_LIMIT_CODE)).toMatchObject({
      code: AUTHORED_ACTOR_LIMIT_CODE,
      path: 'roles',
      actual: MAX_AUTHORED_ACTORS + 1,
    });
    expect(() => doc.setMeta({ name: 'Blocked while over limit' })).toThrow(AuthoredActorLimitError);
    expect(doc.removeRole('legacy-32')).toBe(true);
    expect(doc.validate().issues.some((issue) => issue.code === AUTHORED_ACTOR_LIMIT_CODE)).toBe(false);
    expect(doc.undo()).toBe(true);
    expect(doc.roles).toHaveLength(MAX_AUTHORED_ACTORS + 1);
    expect(doc.redo()).toBe(true);
    expect(doc.roles).toHaveLength(MAX_AUTHORED_ACTORS);
  });

  it('is v2-only and clearly rejects legacy formats', () => {
    expect(() => TemplateDocument.fromJSON({ scenarioVersion: 1 })).toThrow(ScenarioMigrationError);
    expect(() => TemplateDocument.fromJSON({ scenarioVersion: 1 })).toThrow(/expected ScenarioTemplate v2/);
  });

  it('round-trips canonical v2 through browser storage', async () => {
    const store = new WebTemplateFileStore({ storage: new MemoryStorage(), prefix: 'v2:' });
    const doc = TemplateDocument.fromJSON(ltapTemplate());
    await store.write('scenario', doc);
    const loaded = TemplateDocument.fromJSON(await store.read('scenario'));
    expect(loaded.data).toEqual(doc.data);
    expect((await store.list())[0]?.displayName).toBe(doc.data.meta.name);
  });
});

describe('prepareSimulationInput', () => {
  it('returns a lossless adapter result through a UI-independent contract', async () => {
    const template = ltapTemplate();
    const result = await prepareSimulationInput({
      template,
      site: { id: 'site' },
      draw: { seed: 1 },
      materializer: {
        materialize: ({ template: received }) => ({
          input: { clipSeconds: received.choreography.clipSeconds },
          manifest: { id: 'instance' },
          semanticLosses: [],
        }),
      },
    });
    expect(result.input).toEqual({ clipSeconds: 20 });
  });

  it('fails closed before delegation for invalid templates', async () => {
    const template = ltapTemplate();
    const doc = TemplateDocument.fromJSON(template);
    doc.removeRole('challenger');
    const materialize = vi.fn();
    await expect(prepareSimulationInput({
      template: doc.data,
      site: {},
      draw: {},
      materializer: { materialize },
    })).rejects.toMatchObject({ code: 'template_invalid' });
    expect(materialize).not.toHaveBeenCalled();
  });

  it('fails closed and returns every explicit semantic loss', async () => {
    const losses = [{ path: 'choreography.interactions.0', code: 'unsupported', message: 'cannot preserve action' }];
    await expect(prepareSimulationInput({
      template: ltapTemplate(),
      site: {},
      draw: {},
      materializer: {
        materialize: () => ({ input: {}, manifest: {}, semanticLosses: losses }),
      },
    })).rejects.toMatchObject({ code: 'semantic_loss', losses });
  });
});
