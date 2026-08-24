import { Box3, Mesh, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { CATALOG } from '../catalog.js';
import { buildProp } from '../registry.js';

/** Measured extents of a built prop, in the catalog's l/w/h convention. */
function measure(id: Parameters<typeof buildProp>[0]) {
  const object = buildProp(id);
  object.updateMatrixWorld(true);
  const bbox = new Box3().setFromObject(object);
  const size = bbox.getSize(new Vector3());
  const centre = bbox.getCenter(new Vector3());
  let meshes = 0;
  object.traverse((child) => {
    if ((child as Mesh).isMesh) meshes += 1;
  });
  return {
    object,
    bbox,
    meshes,
    dims: { l: size.x, w: size.z, h: size.y },
    centre,
  };
}

describe('every catalog entry', () => {
  for (const entry of CATALOG) {
    describe(entry.id, () => {
      it('builds without error and produces geometry', () => {
        const { object, meshes } = measure(entry.id);
        expect(object.userData.catalogId).toBe(entry.id);
        expect(object.name).toBe(entry.id);
        expect(meshes).toBeGreaterThan(0);
      });

      it('matches its catalogued dimensions within 10%', () => {
        const { dims } = measure(entry.id);
        for (const axis of ['l', 'w', 'h'] as const) {
          const expected = entry.dims[axis];
          const actual = dims[axis];
          expect(
            Math.abs(actual - expected) / expected,
            `${entry.id}.${axis}: catalog ${expected}, built ${actual.toFixed(3)}`,
          ).toBeLessThanOrEqual(0.1);
        }
      });

      it('sits on the ground plane', () => {
        const { bbox } = measure(entry.id);
        // Nothing may float above y = 0 or sink below it by more than 2 cm.
        expect(bbox.min.y, `${entry.id} min-y`).toBeGreaterThan(-0.02);
        expect(bbox.min.y, `${entry.id} min-y`).toBeLessThan(0.02);
      });

      it('is centred on its placement point in X and Z', () => {
        const { centre } = measure(entry.id);
        const tolX = entry.dims.l * 0.15 + 0.05;
        const tolZ = entry.dims.w * 0.15 + 0.05;
        expect(Math.abs(centre.x), `${entry.id} centre-x`).toBeLessThanOrEqual(tolX);
        expect(Math.abs(centre.z), `${entry.id} centre-z`).toBeLessThanOrEqual(tolZ);
      });

      it('has finite geometry with no NaNs', () => {
        const { object } = measure(entry.id);
        object.traverse((child) => {
          const mesh = child as Mesh;
          if (!mesh.isMesh) return;
          const position = mesh.geometry.getAttribute('position');
          expect(position).toBeTruthy();
          const array = position.array as ArrayLike<number>;
          for (let i = 0; i < array.length; i++) {
            expect(Number.isFinite(array[i] as number)).toBe(true);
          }
        });
      });
    });
  }
});

describe('parametric builds', () => {
  it('scales a traffic cone with its height parameter', () => {
    const small = buildProp('construction.traffic_cone', { height: 0.45 });
    small.updateMatrixWorld(true);
    const size = new Box3().setFromObject(small).getSize(new Vector3());
    expect(size.y).toBeCloseTo(0.45, 2);
  });

  it('honours the length of a hedge run', () => {
    for (const length of [3, 12, 25]) {
      const hedge = buildProp('occluder.hedge_run', { length });
      hedge.updateMatrixWorld(true);
      const size = new Box3().setFromObject(hedge).getSize(new Vector3());
      expect(size.x).toBeCloseTo(length, 1);
    }
  });

  it('splits a barrier run into whole segments', () => {
    const run = buildProp('construction.jersey_barrier_run', {
      length: 30.5,
      segmentLength: 3.05,
    });
    expect(run.children).toHaveLength(10);
    run.updateMatrixWorld(true);
    const size = new Box3().setFromObject(run).getSize(new Vector3());
    expect(size.x).toBeCloseTo(30.5, 1);
  });

  it('paints vehicles per instance without leaking between them', () => {
    const red = buildProp('vehicle.sedan', { color: '#ff0000' });
    const blue = buildProp('vehicle.sedan', { color: '#0000ff' });
    const paintOf = (group: ReturnType<typeof buildProp>): string => {
      const body = group.children[0] as Mesh;
      const mat = body.material as unknown as { color: { getHexString(): string } };
      return `#${mat.color.getHexString()}`;
    };
    expect(paintOf(red)).toBe('#ff0000');
    expect(paintOf(blue)).toBe('#0000ff');
  });

  it('varies the pedestrian stride with the pose', () => {
    const standing = buildProp('pedestrian.adult_standing');
    const walking = buildProp('pedestrian.adult_walking');
    standing.updateMatrixWorld(true);
    walking.updateMatrixWorld(true);
    const spanOf = (group: ReturnType<typeof buildProp>): number =>
      new Box3().setFromObject(group).getSize(new Vector3()).x;
    expect(spanOf(walking)).toBeGreaterThan(spanOf(standing) * 1.5);
  });

  it('scales pedestrians by height', () => {
    const tall = buildProp('pedestrian.adult_standing', { height: 1.95, pose: 'standing' });
    tall.updateMatrixWorld(true);
    expect(new Box3().setFromObject(tall).getSize(new Vector3()).y).toBeCloseTo(1.95, 1);
  });

  it('rejects unknown ids', () => {
    expect(() => buildProp('vehicle.hovercraft' as never)).toThrow(/Unknown catalog id/);
  });
});
