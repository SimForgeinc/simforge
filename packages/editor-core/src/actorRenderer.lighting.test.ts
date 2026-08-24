import { SpotLight } from 'three';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ActorRenderer, MAX_PROJECTED_HEADLIGHTS, type ActorView } from './actorRenderer';

const renderers: ActorRenderer[] = [];
afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.dispose();
});

beforeAll(() => {
  if ('document' in globalThis) return;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ width: 0, height: 0, getContext: () => null }) },
  });
});

function vehicle(id: string, headlights?: boolean): ActorView {
  return {
    id,
    catalogId: 'vehicle.sedan',
    x: 0,
    y: 0,
    z: 0,
    headingRad: 0,
    dims: { l: 4.6, w: 1.84, h: 1.45 },
    ...(headlights === undefined ? {} : { headlights }),
  };
}

function headlightBatch(renderer: ActorRenderer) {
  return renderer.group.getObjectByName('actor-headlights') as { count: number; visible: boolean } | undefined;
}

describe('ActorRenderer headlights', () => {
  it('turns two emissive low-beam lenses and one projected beam on per automatic vehicle', () => {
    const renderer = new ActorRenderer();
    renderers.push(renderer);
    renderer.sync([vehicle('car')]);
    expect(headlightBatch(renderer)).toBeUndefined();

    renderer.setHeadlightsEnabled(true);
    expect(headlightBatch(renderer)).toMatchObject({ count: 2, visible: true });
    expect(renderer.group.children.filter((child) => child instanceof SpotLight && child.visible)).toHaveLength(1);

    renderer.setHeadlightsEnabled(false);
    expect(headlightBatch(renderer)).toMatchObject({ count: 0, visible: false });
  });

  it('honours an explicit actor override and bounds projected lights', () => {
    const renderer = new ActorRenderer();
    renderers.push(renderer);
    const actors = Array.from({ length: MAX_PROJECTED_HEADLIGHTS + 3 }, (_, index) => vehicle(`car-${index}`));
    actors.push(vehicle('dark-car', false));
    renderer.setHeadlightsEnabled(true);
    renderer.sync(actors);

    expect(headlightBatch(renderer)?.count).toBe((actors.length - 1) * 2);
    expect(renderer.group.children.filter((child) => child instanceof SpotLight && child.visible))
      .toHaveLength(MAX_PROJECTED_HEADLIGHTS);
  });

  it('allows an explicitly lit vehicle during daylight', () => {
    const renderer = new ActorRenderer();
    renderers.push(renderer);
    renderer.sync([vehicle('car', true)]);
    expect(headlightBatch(renderer)).toMatchObject({ count: 2, visible: true });
  });
});
