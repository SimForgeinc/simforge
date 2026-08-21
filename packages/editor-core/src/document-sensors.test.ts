import { describe, expect, it } from 'vitest';
import {
  defaultDashCamera,
  type ActorSensor,
  type ScenarioFileEntry,
  type TemplateFileStore,
  type TemplateLike,
} from '@uniscenarios/scenario-model';
import { EditorDocument } from './document';
import { TEST_MAP } from './map';

const store: TemplateFileStore = {
  async read(_name: string): Promise<unknown> {
    throw new Error('not used by openBlank');
  },
  async write(_name: string, _document: TemplateLike): Promise<void> {},
  async delete(_name: string): Promise<boolean> { return true; },
  async list(): Promise<ScenarioFileEntry[]> { return []; },
};

function camera(id: string): ActorSensor {
  return defaultDashCamera({ class: 'car' }, id);
}

describe('EditorDocument.replaceActorSensors', () => {
  it('preserves authored sensor ids and replaces the suite as one undoable edit', async () => {
    const document = await EditorDocument.openBlank(TEST_MAP, { store, autosaveMs: 60_000 });
    try {
      const [actorId] = document.add([{
        id: 'ego',
        catalogId: 'vehicle.sedan',
        x: 0,
        y: 0,
        z: 0,
        headingRad: 0,
      }]);
      const sensors = [camera('front-left'), camera('front-right')];

      document.replaceActorSensors(actorId!, sensors);
      expect(document.actor(actorId!)?.sensors.map((sensor) => sensor.id)).toEqual([
        'front-left',
        'front-right',
      ]);

      expect(document.undo()).toBe(true);
      expect(document.actor(actorId!)?.sensors).toEqual([]);
      expect(document.redo()).toBe(true);
      expect(document.actor(actorId!)?.sensors).toEqual(sensors);
    } finally {
      document.dispose();
    }
  });

  it('rejects duplicate sensor identity without changing the actor', async () => {
    const document = await EditorDocument.openBlank(TEST_MAP, { store, autosaveMs: 60_000 });
    try {
      const [actorId] = document.add([{
        id: 'ego',
        catalogId: 'vehicle.sedan',
        x: 0,
        y: 0,
        z: 0,
        headingRad: 0,
      }]);
      const original = camera('front');
      document.replaceActorSensors(actorId!, [original]);

      expect(() => document.replaceActorSensors(actorId!, [camera('same'), camera('same')])).toThrow(
        /duplicate sensor id/,
      );
      expect(document.actor(actorId!)?.sensors).toEqual([original]);
    } finally {
      document.dispose();
    }
  });
});
