import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import {
  actorIdsInRect,
  applySelectionOp,
  normalizedRect,
  projectToClient,
  selectionOpForModifiers,
  type ScreenSurface,
} from './marquee';

/** Camera at y=100 looking straight down at the origin, +X right, +Z down-screen. */
function topDownCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 100, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

const SURFACE: ScreenSurface = { left: 0, top: 0, width: 800, height: 800 };

describe('normalizedRect', () => {
  it('orders any two drag corners', () => {
    expect(normalizedRect(10, 20, 3, 5)).toEqual({ left: 3, top: 5, right: 10, bottom: 20 });
    expect(normalizedRect(3, 5, 10, 20)).toEqual({ left: 3, top: 5, right: 10, bottom: 20 });
  });
});

describe('projectToClient', () => {
  it('projects the look-at point to the surface centre', () => {
    const point = projectToClient(topDownCamera(), SURFACE, 0, 0, 0);
    expect(point).not.toBeNull();
    expect(point!.x).toBeCloseTo(400, 3);
    expect(point!.y).toBeCloseTo(400, 3);
  });

  it('respects the surface offset', () => {
    const surface: ScreenSurface = { left: 100, top: 50, width: 800, height: 800 };
    const point = projectToClient(topDownCamera(), surface, 0, 0, 0);
    expect(point!.x).toBeCloseTo(500, 3);
    expect(point!.y).toBeCloseTo(450, 3);
  });

  it('rejects points behind the camera', () => {
    expect(projectToClient(topDownCamera(), SURFACE, 0, 200, 0)).toBeNull();
  });
});

describe('actorIdsInRect', () => {
  const actors = [
    { id: 'centre', x: 0, y: 0, z: 0 },
    { id: 'right', x: 40, y: 0, z: 0 },
    { id: 'up-screen', x: 0, y: 0, z: -40 },
    { id: 'far-corner', x: 90, y: 0, z: 90 },
  ];

  it('selects exactly the centroids inside the rectangle', () => {
    // Camera at 100 m with 60° fov sees ±57.7 m → 40 m ≈ 277 px from centre.
    // A 100..700 px box takes centre, right and up-screen; the far corner
    // projects past 700 px and stays out.
    const camera = topDownCamera();
    const rect = normalizedRect(100, 100, 700, 700);
    const picked = actorIdsInRect(actors, camera, SURFACE, rect);
    expect(picked).toContain('centre');
    expect(picked).toContain('right');
    expect(picked).toContain('up-screen');
    expect(picked).not.toContain('far-corner');
  });

  it('tests the body centroid, not the ground contact', () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 5, 30);
    camera.lookAt(0, 5, 0);
    camera.updateMatrixWorld(true);
    // A tall body whose ground contact projects below the rect but whose
    // centroid (y + h/2) lands inside it.
    const tall = [{ id: 'tall', x: 0, y: 0, z: 0, dims: { h: 10 } }];
    const centroid = projectToClient(camera, SURFACE, 0, 5, 0)!;
    const rect = normalizedRect(centroid.x - 5, centroid.y - 5, centroid.x + 5, centroid.y + 5);
    expect(actorIdsInRect(tall, camera, SURFACE, rect)).toEqual(['tall']);
    const ground = projectToClient(camera, SURFACE, 0, 0, 0)!;
    expect(ground.y).toBeGreaterThan(rect.bottom);
  });

  it('never selects actors behind the camera', () => {
    const camera = topDownCamera();
    const rect = normalizedRect(0, 0, 800, 800);
    const behind = [{ id: 'behind', x: 0, y: 200, z: 0 }];
    expect(actorIdsInRect(behind, camera, SURFACE, rect)).toEqual([]);
  });
});

describe('applySelectionOp', () => {
  it('replace swaps the set and deduplicates', () => {
    expect(applySelectionOp(['a', 'b'], ['c', 'c'], 'replace')).toEqual(['c']);
  });

  it('add unions while keeping existing order', () => {
    expect(applySelectionOp(['a', 'b'], ['b', 'c'], 'add')).toEqual(['a', 'b', 'c']);
  });

  it('toggle flips membership per picked id', () => {
    expect(applySelectionOp(['a', 'b'], ['b', 'c'], 'toggle')).toEqual(['a', 'c']);
  });

  it('maps modifiers per the editor contract: shift adds, ctrl toggles', () => {
    expect(selectionOpForModifiers({ shiftKey: true, ctrlKey: false })).toBe('add');
    expect(selectionOpForModifiers({ shiftKey: false, ctrlKey: true })).toBe('toggle');
    expect(selectionOpForModifiers({ shiftKey: false, ctrlKey: false, metaKey: true })).toBe('toggle');
    expect(selectionOpForModifiers({ shiftKey: false, ctrlKey: false })).toBe('replace');
  });
});
