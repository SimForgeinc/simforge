import { describe, expect, it } from 'vitest';
import { MemoryStorage, WebTemplateFileStore, type Interaction } from '@simforge-oss/scenario';
import { EditorDocument } from './document';
import { TEST_MAP } from './map';

async function blankDocument(): Promise<EditorDocument> {
  return EditorDocument.openBlank(TEST_MAP, {
    store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
    autosaveMs: 60_000,
  });
}

describe('addWithInteractions', () => {
  it('adds actors and their route clips as one undo gesture', async () => {
    const document = await blankDocument();
    const clipSeconds = document.data.choreography.clipSeconds;
    const route: Interaction = {
      id: 'route_pasted_vehicle_0',
      actor: 'pasted_vehicle',
      label: 'Simple timed route',
      verb: 'route',
      trigger: { kind: 'at', t: 0 },
      until: { kind: 'at', t: clipSeconds },
      target: {
        mode: 'customTimedRoute',
        points: [
          { timeS: 0, x: 10, z: 5 },
          { timeS: 1, x: 14, z: 5 },
        ],
      },
    } as Interaction;

    const ids = document.addWithInteractions(
      [{ id: 'pasted_vehicle', catalogId: 'vehicle.sedan', x: 10, y: 0, z: 5, headingRad: 0 }],
      [route],
    );
    expect(ids).toEqual(['pasted_vehicle']);
    expect(document.actor('pasted_vehicle')).toBeDefined();
    const clip = document.data.choreography.interactions.find((item) => item.id === 'route_pasted_vehicle_0');
    expect(clip).toMatchObject({ actor: 'pasted_vehicle', verb: 'route' });

    // One Ctrl+Z removes the actor *and* its clip together.
    expect(document.undo()).toBe(true);
    expect(document.actor('pasted_vehicle')).toBeUndefined();
    expect(document.data.choreography.interactions).toHaveLength(0);
    document.dispose();
  });
});
