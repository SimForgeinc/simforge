/**
 * Route-prewarm tile selection must be pure grid math: given a camera route,
 * exactly the cells the route can touch are selected, road always travels
 * along, and vegetation rides the same grid as its static sibling. The fixture
 * is the real yale-street 3D manifest shape (8×8 grid), so any drift in the
 * producer's grid fields breaks loudly here.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePoses, selectRouteTiles } from '../commands/corpus.js';
import { REPO_ROOT } from '../maps.js';

const FIXTURE = path.join(REPO_ROOT, 'fixtures', 'yale-3d-manifest.json');

const scene = existsSync(FIXTURE)
  ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Parameters<typeof selectRouteTiles>[0])
  : undefined;

// Fixture tile_5_5 bounds: min [739.90, …, -1702.17], max [816.33, …, -1638.03].
// Grid origin [357.78, …, -2022.90], cellSize [76.42 x, 64.14 z].
const INSIDE_5_5 = { x: 780, y: 14, z: -1670 };

describe.skipIf(scene === undefined)('corpus route prewarm', () => {
  it('selects the cell containing a pose and its lod ladder', () => {
    const result = selectRouteTiles(scene!, 'yale-street', [INSIDE_5_5]);
    expect(result.mapId).toBe('yale-street');
    expect(result.cells).toEqual([[5, 5]]);
    expect(result.staticTiles).toEqual(['tile_5_5']);
    expect(result.files).toContain('tiles/tile_5_5.lod0.glb');
    expect(result.files).toContain('tiles/tile_5_5.lod3.glb');
  });

  it('always includes the road static layer and never shadow lightmaps', () => {
    const result = selectRouteTiles(scene!, 'yale-street', [INSIDE_5_5]);
    expect(result.files).toContain('tiles/road.glb');
    for (const file of result.files) {
      expect(file).not.toMatch(/shadow/);
    }
  });

  it('radius expands to neighbouring cells on both axes', () => {
    const tight = selectRouteTiles(scene!, 'yale-street', [INSIDE_5_5], 0);
    const wide = selectRouteTiles(scene!, 'yale-street', [INSIDE_5_5], 80);
    // 80 m exceeds half of either cell dimension → at least the 3×3 ring.
    expect(wide.cells.length).toBeGreaterThanOrEqual(9);
    expect(wide.staticTiles).toContain('tile_4_4');
    expect(wide.staticTiles).toContain('tile_6_6');
    expect(tight.cells.length).toBeLessThan(wide.cells.length);
  });

  it('selects vegetation tiles for the same cells when the map has them', () => {
    const result = selectRouteTiles(scene!, 'yale-street', [INSIDE_5_5]);
    if (result.vegTiles.length > 0) {
      for (const veg of result.vegTiles) {
        expect(veg).toMatch(/^veg_\d+_\d$/);
        expect(result.files).toContain(`tiles/${veg}.lod0.glb`);
        expect(result.files).toContain(`tiles/${veg}.instances.json`);
      }
    }
  });

  it('clamps poses far outside the grid into edge cells instead of throwing', () => {
    const result = selectRouteTiles(scene!, 'yale-street', [{ x: -10000, y: 0, z: 10000 }]);
    expect(result.cells).toEqual([[0, 7]]);
  });

  it('output ordering is deterministic regardless of pose order', () => {
    const a = selectRouteTiles(scene!, 'yale-street', [INSIDE_5_5, { x: 400, y: 10, z: -1900 }], 60);
    const b = selectRouteTiles(scene!, 'yale-street', [{ x: 400, y: 10, z: -1900 }, INSIDE_5_5], 60);
    expect(a.files).toEqual(b.files);
    expect(a.cells).toEqual(b.cells);
    expect(a.files).toEqual([...a.files].sort());
  });

  it('parses [x,y,z] triples, {x,y,z} objects, and {poses:[…]} wrappers', () => {
    expect(parsePoses([[1, 2, 3]])).toEqual([{ x: 1, y: 2, z: 3 }]);
    expect(parsePoses({ poses: [{ x: 1, z: 3 }] })).toEqual([{ x: 1, y: 0, z: 3 }]);
    expect(() => parsePoses({ nope: 1 })).toThrow();
    expect(() => parsePoses([[1, 'x']])).toThrow();
  });

  it('splits camera {eye,target} entries into both endpoints', () => {
    const poses = parsePoses([{ eye: [0, 10, 0], target: [100, 5, -200] }]);
    expect(poses).toEqual([
      { x: 0, y: 10, z: 0 },
      { x: 100, y: 5, z: -200 },
    ]);
  });
});
