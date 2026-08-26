import { describe, expect, it } from 'vitest';
import { CoordinateFrame } from '../coordinate-frame.js';
import { lanePolygonsFromGeoJson, type LanePolygon } from '../lanes.js';
import { MissingHeightError } from '../overlays/height.js';
import {
  buildLaneOverlay,
  laneIdForFace,
  type LaneOverlayUserData,
} from '../overlays/lanes.js';
import type { FeatureCollection } from '../geojson.js';
import type { LanePolygonProperties } from '../lanes.js';
import { yaleHeaderText, yaleLanePolygonSample, mapManifest } from './fixtures.js';

const frame = (): CoordinateFrame =>
  CoordinateFrame.fromMapAssets(yaleHeaderText(), mapManifest());

async function load(): Promise<LanePolygon[]> {
  return lanePolygonsFromGeoJson(await yaleLanePolygonSample(), frame());
}

/** Signed area in the (x, -z) plane — positive means CCW / +Y-facing. */
function signedArea(ring: Float64Array): number {
  let sum = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum +=
      (ring[i * 2] as number) * -(ring[j * 2 + 1] as number) -
      (ring[j * 2] as number) * -(ring[i * 2 + 1] as number);
  }
  return sum / 2;
}

describe('lanePolygonsFromGeoJson', () => {
  it('converts every sampled lane into scene space', async () => {
    const lanes = await load();
    expect(lanes).toHaveLength(32);
    const f = frame();
    const b = f.sceneBounds!;
    for (const lane of lanes) {
      expect(lane.rings.length).toBeGreaterThan(0);
      expect(lane.id).toMatch(/^\d+:\d+:-?\d+$/);
      expect(lane.bounds.minX).toBeGreaterThanOrEqual(b.min[0] as number);
      expect(lane.bounds.maxX).toBeLessThanOrEqual(b.max[0] as number);
      expect(lane.bounds.minZ).toBeGreaterThanOrEqual(b.min[2] as number);
      expect(lane.bounds.maxZ).toBeLessThanOrEqual(b.max[2] as number);
      for (const ring of lane.rings) {
        expect(ring.length % 2).toBe(0);
        expect(ring.length / 2).toBeGreaterThanOrEqual(3);
        for (const v of ring) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('normalises mixed source winding to CCW outer rings', async () => {
    // The raw Yale data is 475 CCW / 669 CW, so winding carries no meaning and
    // must be normalised or half the surfaces would face away from the camera.
    const raw = await yaleLanePolygonSample();
    const rawCw = raw.features.filter((f) => {
      const ring = (f.geometry as { coordinates: number[][][] }).coordinates[0] as number[][];
      let s = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i] as number[];
        const b = ring[i + 1] as number[];
        s += (a[0] as number) * (b[1] as number) - (b[0] as number) * (a[1] as number);
      }
      return s < 0;
    });
    expect(rawCw.length).toBeGreaterThan(0);
    expect(rawCw.length).toBeLessThan(raw.features.length);

    for (const lane of await load()) {
      expect(signedArea(lane.rings[0] as Float64Array)).toBeGreaterThan(0);
    }
  });

  it('drops the duplicate closing vertex', async () => {
    const raw = await yaleLanePolygonSample();
    const lanes = await load();
    const first = raw.features[0] as { geometry: { coordinates: number[][][] } };
    const sourceLen = (first.geometry.coordinates[0] as number[][]).length;
    expect((lanes[0] as LanePolygon).rings[0]!.length / 2).toBe(sourceLen - 1);
  });

  it('preserves lane identity and properties', async () => {
    const lanes = await load();
    const types = new Set(lanes.map((l) => l.laneType));
    expect(types.size).toBeGreaterThanOrEqual(5);
    expect(types.has('driving')).toBe(true);
    for (const lane of lanes) {
      expect(lane.properties.lane_guid).toMatch(/^\{[0-9a-f-]+\}$/);
      expect(lane.id).toBe(`${lane.roadId}:${lane.sectionId}:${lane.laneId}`);
      expect(typeof lane.isJunction).toBe('boolean');
    }
  });

  it('handles holes and MultiPolygons defensively', () => {
    const f = frame();
    const [lon, lat] = f.localToWgs84(600, 1700);
    const d = 0.0005;
    const square = (cx: number, cy: number, r: number, cw = false): number[][] => {
      const pts: number[][] = [
        [cx - r, cy - r],
        [cx + r, cy - r],
        [cx + r, cy + r],
        [cx - r, cy + r],
      ];
      const ring = cw ? pts.reverse() : pts;
      return [...ring, ring[0] as number[]];
    };
    const collection: FeatureCollection<LanePolygonProperties> = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { road_id: '9', section_id: 0, lane_id: -1, LaneType: 'driving' },
          geometry: {
            type: 'Polygon',
            coordinates: [square(lon, lat, d), square(lon, lat, d / 3)],
          },
        },
        {
          type: 'Feature',
          properties: { road_id: '9', section_id: 0, lane_id: -2, LaneType: 'driving' },
          geometry: {
            type: 'MultiPolygon',
            coordinates: [[square(lon, lat, d, true)], [square(lon + 3 * d, lat, d)]],
          },
        },
      ],
    };
    const lanes = lanePolygonsFromGeoJson(collection, f);
    expect(lanes.map((l) => l.id)).toEqual(['9:0:-1', '9:0:-2#0', '9:0:-2#1']);
    const withHole = lanes[0] as LanePolygon;
    expect(withHole.rings).toHaveLength(2);
    expect(signedArea(withHole.rings[0] as Float64Array)).toBeGreaterThan(0); // outer CCW
    expect(signedArea(withHole.rings[1] as Float64Array)).toBeLessThan(0); // hole CW

    const overlay = buildLaneOverlay(lanes);
    // A square-with-square-hole triangulates to 8 triangles.
    const ranges = overlay.userData.ranges as Array<{ id: string; indexCount: number }>;
    expect((ranges[0] as { indexCount: number }).indexCount / 3).toBe(8);
  });
});

describe('buildLaneOverlay', () => {
  it('produces finite, non-degenerate triangles for every lane', async () => {
    const lanes = await load();
    const group = buildLaneOverlay(lanes, { defaultHeight: 10, drapeOffset: 0.05 });
    expect(group.name).toBe('lanes');

    const mesh = group.getObjectByName('lane-surfaces') as unknown as {
      geometry: {
        attributes: { position: { array: ArrayLike<number>; count: number } };
        index: { array: ArrayLike<number>; count: number } | null;
      };
    };
    const pos = mesh.geometry.attributes.position;
    const index = mesh.geometry.index!;
    expect(pos.count).toBeGreaterThan(100);
    expect(index.count % 3).toBe(0);
    expect(index.count / 3).toBe(group.userData.triangleCount);
    expect(group.userData.laneCount).toBe(32);

    for (let i = 0; i < pos.count * 3; i++) expect(Number.isFinite(pos.array[i] as number)).toBe(true);

    let minArea = Infinity;
    const readTri = (i: number): number[][] => {
      const out: number[][] = [];
      for (let k = 0; k < 3; k++) {
        const vi = index.array[i * 3 + k] as number;
        out.push([pos.array[vi * 3] as number, pos.array[vi * 3 + 1] as number, pos.array[vi * 3 + 2] as number]);
      }
      return out;
    };
    for (let t = 0; t < index.count / 3; t++) {
      const [a, b, c] = readTri(t) as [number[], number[], number[]];
      // All draped to the same plane (Float32 position buffer, hence 1e-5).
      expect(a[1]).toBeCloseTo(10.05, 5);
      // Area in the ground plane.
      const area = Math.abs(
        ((b[0] as number) - (a[0] as number)) * ((c[2] as number) - (a[2] as number)) -
          ((c[0] as number) - (a[0] as number)) * ((b[2] as number) - (a[2] as number)),
      ) / 2;
      expect(Number.isFinite(area)).toBe(true);
      minArea = Math.min(minArea, area);
    }
    // Every emitted triangle survives Float32 quantisation with positive area.
    expect(minArea).toBeGreaterThan(0);
    // ...and the earcut slivers that would not were culled, not emitted.
    expect(group.userData.degenerateTriangles).toBeGreaterThan(0);
    expect(group.userData.degenerateTriangles).toBeLessThan(group.userData.triangleCount * 0.2);
  });

  it('drapes per-vertex when a height sampler is supplied', async () => {
    const lanes = await load();
    const group = buildLaneOverlay(lanes, {
      drapeOffset: 0.03,
      heightSampler: (x, z) => (x + z) * 0.01,
    });
    const mesh = group.getObjectByName('lane-surfaces') as unknown as {
      geometry: { attributes: { position: { array: ArrayLike<number>; count: number } } };
    };
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.array[i * 3] as number;
      const y = pos.array[i * 3 + 1] as number;
      const z = pos.array[i * 3 + 2] as number;
      expect(y).toBeCloseTo((x + z) * 0.01 + 0.03, 4);
    }
  });

  it('falls back to defaultHeight where the sampler returns null', async () => {
    const lanes = await load();
    const group = buildLaneOverlay(lanes, {
      defaultHeight: 7,
      drapeOffset: 0,
      heightSampler: () => null,
    });
    const mesh = group.getObjectByName('lane-surfaces') as unknown as {
      geometry: { attributes: { position: { array: ArrayLike<number>; count: number } } };
    };
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) expect(pos.array[i * 3 + 1]).toBe(7);
  });

  it('skips or throws on a missing height when asked to', async () => {
    const lanes = await load();
    // Answer only for the eastern half of the sample.
    const mid = (lanes[0]?.bounds.minX ?? 0) + 1;
    const sampler = (x: number): number | null => (x > mid ? 5 : null);

    const all = buildLaneOverlay(lanes, { heightSampler: sampler });
    expect((all.userData as LaneOverlayUserData).skippedLanes).toBe(0);
    expect((all.userData as LaneOverlayUserData).laneCount).toBe(lanes.length);

    const skipped = buildLaneOverlay(lanes, {
      heightSampler: sampler,
      onMissingHeight: 'skip',
    });
    const data = skipped.userData as LaneOverlayUserData;
    expect(data.skippedLanes).toBeGreaterThan(0);
    expect(data.laneCount + data.skippedLanes).toBe(lanes.length);
    // Nothing landed at the default height: every surviving vertex was sampled.
    const mesh = skipped.getObjectByName('lane-surfaces') as unknown as {
      geometry: { attributes: { position: { array: ArrayLike<number>; count: number } } };
    };
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      expect(pos.array[i * 3 + 1]).toBeCloseTo(5.04, 5);
    }

    expect(() => buildLaneOverlay(lanes, { heightSampler: sampler, onMissingHeight: 'throw' }))
      .toThrow(MissingHeightError);
  });

  it('merges to a single draw call and still resolves faces to lane ids', async () => {
    const lanes = await load();
    const group = buildLaneOverlay(lanes);
    let meshes = 0;
    group.traverse((o) => {
      if ((o as { isMesh?: boolean }).isMesh) meshes++;
    });
    expect(meshes).toBe(1);

    const ranges = group.userData.ranges as Array<{ id: string; indexStart: number; indexCount: number }>;
    expect(ranges).toHaveLength(lanes.length);
    for (const r of ranges) {
      const firstFace = r.indexStart / 3;
      const lastFace = (r.indexStart + r.indexCount) / 3 - 1;
      expect(laneIdForFace(group, firstFace)).toBe(r.id);
      expect(laneIdForFace(group, lastFace)).toBe(r.id);
    }
    expect(laneIdForFace(group, 10 ** 7)).toBeNull();
    expect(laneIdForFace(group, -1)).toBeNull();
  });

  it('supports filtering and per-lane tinting', async () => {
    const lanes = await load();
    const group = buildLaneOverlay(lanes, {
      filter: (l) => l.laneType === 'driving',
      colorFor: (l) => (l.isJunction ? 0xff0000 : 0x00ff00),
    });
    expect(group.userData.laneCount).toBe(lanes.filter((l) => l.laneType === 'driving').length);
    const mesh = group.getObjectByName('lane-surfaces') as unknown as {
      geometry: { attributes: { color?: { count: number } } };
      material: { vertexColors: boolean; transparent: boolean; depthWrite: boolean };
    };
    expect(mesh.geometry.attributes.color).toBeDefined();
    expect(mesh.material.vertexColors).toBe(true);
    expect(mesh.material.transparent).toBe(true);
    expect(mesh.material.depthWrite).toBe(false);
  });

  it('returns an empty but valid group for no lanes', () => {
    const group = buildLaneOverlay([]);
    expect(group.name).toBe('lanes');
    expect(group.userData.laneCount).toBe(0);
    expect(group.userData.triangleCount).toBe(0);
  });
});
