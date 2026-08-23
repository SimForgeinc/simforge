import { describe, expect, it } from 'vitest';
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import { GroundIndex } from './ground-index';

/** A flat quad in the XZ plane at height `y`, spanning [x0,x1] x [z0,z1]. */
function quad(x0: number, x1: number, z0: number, z1: number, y: number): Mesh {
  const positions = new Float32Array([
    x0, y, z0, x1, y, z0, x1, y, z1,
    x0, y, z0, x1, y, z1, x0, y, z1,
  ]);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  return new Mesh(geometry, new MeshBasicMaterial());
}

/** The same quad, but indexed, to exercise the index path. */
function indexedQuad(x0: number, x1: number, z0: number, z1: number, y: number): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1]), 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return new Mesh(geometry, new MeshBasicMaterial());
}

describe('GroundIndex', () => {
  it('returns null when there is nothing to index', () => {
    expect(GroundIndex.build(new Group())).toBeNull();
  });

  it('samples a flat surface exactly and reports null off the edge', () => {
    const index = GroundIndex.build(quad(0, 20, 0, 20, 7.25));
    expect(index).not.toBeNull();
    expect(index?.sample(10, 10)).toBeCloseTo(7.25, 6);
    expect(index?.sample(0.01, 19.99)).toBeCloseTo(7.25, 6);
    expect(index?.sample(-5, 10)).toBeNull();
    expect(index?.sample(10, 40)).toBeNull();
    expect(index?.stats.triangles).toBe(2);
  });

  it('interpolates across a sloped triangle', () => {
    // A gentle grade: y=0 at z=0 rising to y=2 at z=10 over a 10 m span. Kept
    // shallow on purpose — a 10 m rise over 10 m would (rightly) be classified
    // as an object rather than ground.
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 2, 10, 0, 0, 0, 10, 2, 10, 0, 2, 10]);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    const index = GroundIndex.build(new Mesh(geometry, new MeshBasicMaterial()));
    expect(index?.sample(5, 0.001)).toBeCloseTo(0, 2);
    expect(index?.sample(5, 5)).toBeCloseTo(1, 2);
    expect(index?.sample(5, 9.999)).toBeCloseTo(2, 2);
  });

  it('takes the lowest of two stacked surfaces by default — the thing above is furniture', () => {
    const group = new Group();
    group.add(quad(0, 20, 0, 20, 2), indexedQuad(4, 16, 4, 16, 9));
    const index = GroundIndex.build(group);
    expect(index?.sample(10, 10)).toBeCloseTo(2, 6); // ignores the floating patch
    expect(index?.sample(2, 2)).toBeCloseTo(2, 6);
  });

  it('surface: "highest" reproduces ray-from-above semantics', () => {
    const group = new Group();
    group.add(quad(0, 20, 0, 20, 2), indexedQuad(4, 16, 4, 16, 9));
    const index = GroundIndex.build(group, { surface: 'highest' });
    expect(index?.sample(10, 10)).toBeCloseTo(9, 6);
    expect(index?.sample(2, 2)).toBeCloseTo(2, 6);
  });

  it('sampleAll reports the whole stack, ascending', () => {
    const group = new Group();
    group.add(quad(0, 20, 0, 20, 2), indexedQuad(4, 16, 4, 16, 9));
    const index = GroundIndex.build(group);
    // Off the quads' shared diagonal, so exactly one triangle per sheet covers it.
    const stack = index?.sampleAll(12, 8) ?? [];
    expect(stack.length).toBe(2);
    expect(stack[0]).toBeCloseTo(2, 6);
    expect(stack[1]).toBeCloseTo(9, 6);
    expect(index?.sampleAll(-99, -99)).toEqual([]);
  });

  it('rejects small-footprint meshes as furniture rather than ground', () => {
    const group = new Group();
    // The case that made this filter necessary: a 0.8 x 0.8 m luminaire head
    // floating 8 m up. It is short, so an aspect-ratio test lets it through;
    // its footprint gives it away.
    group.add(quad(0, 20, 0, 20, 2), quad(9.6, 10.4, 9.6, 10.4, 8));
    const index = GroundIndex.build(group);
    expect(index?.stats.rejectedMeshes).toBe(1);
    expect(index?.stats.meshes).toBe(1);
    expect(index?.sample(10, 10)).toBeCloseTo(2, 6);

    // Without the filter the head wins under 'highest' — the original bug.
    const unfiltered = GroundIndex.build(group, {
      meshFilter: () => true,
      surface: 'highest',
    });
    expect(unfiltered?.stats.rejectedMeshes).toBe(0);
    expect(unfiltered?.sample(10, 10)).toBeCloseTo(8, 6);
  });

  it('honours world transforms', () => {
    const group = new Group();
    group.position.set(100, 3, -50);
    group.add(quad(0, 20, 0, 20, 7));
    const index = GroundIndex.build(group);
    expect(index?.sample(110, -40)).toBeCloseTo(10, 5);
    expect(index?.sample(10, 10)).toBeNull();
  });

  it('skips instanced meshes — vegetation is not ground', () => {
    const group = new Group();
    const proto = quad(0, 20, 0, 20, 7);
    const instanced = new InstancedMesh(proto.geometry, proto.material as MeshBasicMaterial, 4);
    group.add(instanced);
    expect(GroundIndex.build(group)).toBeNull();
  });

  it('sampleNear snaps to the closest surface only outside the covered area', () => {
    const index = GroundIndex.build(quad(0, 20, 0, 20, 4));
    // Inside: identical to sample(), no snapping involved.
    expect(index?.sampleNear(10, 10)).toBeCloseTo(4, 6);
    // Just past the edge: snaps to the surface height.
    expect(index?.sampleNear(21, 10, 8)).toBeCloseTo(4, 6);
    // Well beyond the radius: still null.
    expect(index?.sampleNear(200, 10, 8)).toBeNull();
  });

  it('is stable regardless of cell size', () => {
    const group = new Group();
    group.add(quad(0, 200, 0, 200, 1.5), indexedQuad(90, 110, 90, 110, 6.5));
    const coarse = GroundIndex.build(group, { cellSize: 64 });
    const fine = GroundIndex.build(group, { cellSize: 2 });
    for (const [x, z] of [
      [1, 1],
      [95, 95],
      [100, 100],
      [150, 40],
      [199, 199],
    ] as const) {
      expect(coarse?.sample(x, z)).toBeCloseTo(fine?.sample(x, z) as number, 6);
    }
    expect(coarse?.stats.cells).toBeLessThan(fine?.stats.cells as number);
  });
});
