import { MemoryStorage, WebTemplateFileStore, type Interaction } from '@simforge-oss/scenario';
import { describe, expect, it } from 'vitest';
import { armActorSimpleTimedRoute } from './authoring-policy';
import { EditorDocument } from './document';
import { TEST_MAP } from './map';

async function blankDocument(): Promise<EditorDocument> {
  return EditorDocument.openBlank(TEST_MAP, {
    store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
    autosaveMs: 60_000,
  });
}

describe('armActorSimpleTimedRoute', () => {
  it('replaces compiled motion with a stationary two-point route spanning the clip', async () => {
    const document = await blankDocument();
    document.add([{
      id: 'car-1',
      catalogId: 'vehicle.sedan',
      x: 12.3456,
      y: 0,
      z: -7.8912,
      headingRad: 0,
    }]);
    document.addInteraction({
      id: 'compiled-lane-route',
      actor: 'car-1',
      label: 'Follow lanes',
      trigger: { kind: 'at', t: 0 },
      verb: 'route',
      target: { mode: 'lanePath', lanes: ['lane-1'] },
    } as Interaction);

    expect(armActorSimpleTimedRoute(document, 'car-1')).toBe(true);
    expect(document.data.choreography.interactions).toEqual([{
      id: 'simple_timed_route_car-1',
      actor: 'car-1',
      label: 'Simple timed route',
      trigger: { kind: 'at', t: 0 },
      until: { kind: 'at', t: document.data.choreography.clipSeconds },
      verb: 'route',
      target: {
        mode: 'customTimedRoute',
        points: [
          { timeS: 0, x: 12.346, z: -7.891 },
          { timeS: 1, x: 12.346, z: -7.891 },
        ],
      },
    }]);
    document.dispose();
  });

  it('does not arm static actors', async () => {
    const document = await blankDocument();
    document.add([{
      id: 'prop-1',
      catalogId: 'vehicle.sedan',
      x: 1,
      y: 0,
      z: 2,
      headingRad: 0,
      static: true,
    }]);

    expect(armActorSimpleTimedRoute(document, 'prop-1')).toBe(false);
    expect(document.data.choreography.interactions).toEqual([]);
    document.dispose();
  });
});
