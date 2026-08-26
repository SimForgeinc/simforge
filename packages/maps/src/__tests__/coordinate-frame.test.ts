/**
 * These tests double as the written record of how the xodr-local -> scene
 * transform was determined. They assert against the real Yale Street manifest
 * numbers, so a pipeline change that re-axes or recentres the scene fails here
 * with a readable diff rather than silently mis-placing every overlay.
 */

import { describe, expect, it } from 'vitest';
import { CoordinateFrame } from '../coordinate-frame.js';
import { parseXodrHeader } from '../header.js';
import { yaleHeaderText, mapManifest } from './fixtures.js';

function frame(): CoordinateFrame {
  return CoordinateFrame.fromMapAssets(yaleHeaderText(), mapManifest());
}

describe('CoordinateFrame — projection', () => {
  it('round-trips WGS84 -> local -> WGS84 to well under 1e-6 degrees', () => {
    const f = frame();
    const samples: Array<[number, number]> = [
      [-122.154771275882, 37.4100548676094], // projection origin
      [-122.14915306343191, 37.42749646704693], // a real signal
      [-122.1490743, 37.4275916], // a real lane vertex
      [-122.16, 37.42],
      [-122.14, 37.435],
    ];
    for (const [lon, lat] of samples) {
      const [x, y] = f.wgs84ToLocal(lon, lat);
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      const [lon2, lat2] = f.localToWgs84(x, y);
      expect(Math.abs(lon2 - lon)).toBeLessThan(1e-6);
      expect(Math.abs(lat2 - lat)).toBeLessThan(1e-6);
    }
  });

  it('puts the projection origin at local (0, 0)', () => {
    const [x, y] = frame().wgs84ToLocal(-122.154771275882, 37.4100548676094);
    expect(Math.abs(x)).toBeLessThan(1e-6);
    expect(Math.abs(y)).toBeLessThan(1e-6);
  });

  it('round-trips WGS84 -> scene -> WGS84', () => {
    const f = frame();
    const [lon, lat] = [-122.1491, 37.4275];
    const scene = f.wgs84ToScene(lon, lat, 12.5);
    const [lon2, lat2] = f.sceneToWgs84(scene);
    expect(Math.abs(lon2 - lon)).toBeLessThan(1e-6);
    expect(Math.abs(lat2 - lat)).toBeLessThan(1e-6);
  });
});

describe('CoordinateFrame — the empirically calibrated local -> scene axes', () => {
  it('maps local (x-east, y-north, z-up) to scene (x, z, -y), y-up', () => {
    const f = frame();
    expect(f.localToScene(10, 20, 30)).toEqual([10, 30, -20]);
    expect(f.localToScene(0, 0, 0)).toEqual([0, 0, 0]);
    // and back
    expect(f.sceneToLocal([10, 30, -20])).toEqual([10, 20, 30]);
    expect(f.sceneToLocal({ x: 10, y: 30, z: -20 })).toEqual([10, 20, 30]);
  });

  it('is a rotation, not a mirror (determinant +1)', () => {
    const f = frame();
    // columns = images of the local basis vectors
    const c0 = f.localToScene(1, 0, 0);
    const c1 = f.localToScene(0, 1, 0);
    const c2 = f.localToScene(0, 0, 1);
    const det =
      (c0[0] as number) * ((c1[1] as number) * c2[2] - (c1[2] as number) * c2[1]) -
      (c1[0] as number) * ((c0[1] as number) * c2[2] - (c0[2] as number) * c2[1]) +
      (c2[0] as number) * ((c0[1] as number) * c1[2] - (c0[2] as number) * c1[1]);
    expect(det).toBeCloseTo(1, 12);
  });

  it('applies no translation: manifest.scene.origin is the tile-grid corner', () => {
    const f = frame();
    const manifest = mapManifest();
    expect(f.sceneOrigin).toEqual([0, 0, 0]);
    expect(f.tileGridOrigin).toEqual(manifest.scene.origin);

    // Proof that scene.origin anchors the LOD grid rather than translating the
    // scene: tile_i_j.bounds.min === origin + [i, j] * cellSize, exactly.
    const scene = manifest.scene as unknown as {
      origin: number[];
      cellSize: number[];
      bounds: { min: number[]; max: number[] };
    };
    const tiles = (mapManifest() as unknown as {
      tiles: Array<{ gridX: number; gridZ: number; bounds: { min: number[] } }>;
    }).tiles;
    expect(tiles.length).toBeGreaterThan(10);
    for (const tile of tiles) {
      expect((tile.bounds.min[0] as number) - (scene.origin[0] as number)).toBeCloseTo(
        tile.gridX * (scene.cellSize[0] as number),
        6,
      );
      expect((tile.bounds.min[2] as number) - (scene.origin[2] as number)).toBeCloseTo(
        tile.gridZ * (scene.cellSize[1] as number),
        6,
      );
    }
    // ...and the scene box does NOT start at the origin, so it was never subtracted.
    expect(scene.bounds.min[0] as number).toBeLessThan(scene.origin[0] as number);
    expect(scene.bounds.min[2] as number).toBeLessThan(scene.origin[2] as number);
  });

  it('maps the xodr extent rectangle inside manifest.scene.bounds', () => {
    const report = frame().calibrationReport();

    // Mapped road box, from the header extents.
    expect(report.mappedExtents.minX).toBeCloseTo(328.2025, 3);
    expect(report.mappedExtents.maxX).toBeCloseTo(996.5178, 3);
    expect(report.mappedExtents.minZ).toBeCloseTo(-2029.3416, 3);
    expect(report.mappedExtents.maxZ).toBeCloseTo(-1454.0892, 3);

    // The scene box legitimately extends past the road network (terrain,
    // vegetation, buildings), so containment — not equality — is the bar.
    expect(report.contained).toBe(true);
    expect(report.residuals.west).toBeCloseTo(0.53, 2);
    expect(report.residuals.east).toBeCloseTo(95.12, 2);
    expect(report.residuals.south).toBeCloseTo(21.9, 1);
    expect(report.residuals.north).toBeCloseTo(30.83, 2);
    for (const slack of Object.values(report.residuals)) {
      expect(slack).toBeGreaterThanOrEqual(-0.5);
    }
  });

  it('rejects every other axis/sign permutation', () => {
    const f = frame();
    const e = parseXodrHeader(yaleHeaderText()).extents;
    const bounds = f.sceneBounds!;
    const corners: Array<[number, number]> = [
      [e.west, e.south],
      [e.east, e.south],
      [e.west, e.north],
      [e.east, e.north],
    ];
    const candidates: Record<string, (x: number, y: number) => [number, number]> = {
      'scene=(x,-y)  [chosen]': (x, y) => [x, -y],
      'scene=(x, y)': (x, y) => [x, y],
      'scene=(-y, x)': (x, y) => [-y, x],
      'scene=(y, x)': (x, y) => [y, x],
      'scene=(-x,-y)': (x, y) => [-x, -y],
    };
    const inside = (name: string): number =>
      corners.filter(([x, y]) => {
        const [sx, sz] = (candidates[name] as (a: number, b: number) => [number, number])(x, y);
        return (
          sx >= (bounds.min[0] as number) &&
          sx <= (bounds.max[0] as number) &&
          sz >= (bounds.min[2] as number) &&
          sz <= (bounds.max[2] as number)
        );
      }).length;

    expect(inside('scene=(x,-y)  [chosen]')).toBe(4);
    for (const name of Object.keys(candidates)) {
      if (name.includes('chosen')) continue;
      expect(inside(name), `${name} should place no corner inside the scene box`).toBe(0);
    }
  });

  it('rejects a manifest that is not y-up', () => {
    expect(() =>
      CoordinateFrame.fromMapAssets(yaleHeaderText(), { scene: { coordinateSystem: 'z-up' } }),
    ).toThrow(/y-up/);
  });

  it('honours an explicit sceneOrigin for pipelines that do recentre', () => {
    const f = CoordinateFrame.fromMapAssets(yaleHeaderText(), mapManifest(), [-100, -5, 200]);
    expect(f.localToScene(10, 20, 30)).toEqual([-90, 25, 180]);
    expect(f.sceneToLocal(f.localToScene(10, 20, 30))).toEqual([10, 20, 30]);
  });

  it('builds the same frame from a parsed header as from raw text', () => {
    // `fetchXodrHeader` Range-requests 16 KB and hands back a parsed header, so
    // the app never has the text `fromMapAssets` wants. Both paths must agree —
    // including the manifest-derived fields, which callers used to wire by hand
    // (and which `calibrationReport` needs).
    const manifest = mapManifest();
    const fromText = CoordinateFrame.fromMapAssets(yaleHeaderText(), manifest);
    const fromParsed = CoordinateFrame.fromHeader(parseXodrHeader(yaleHeaderText()), manifest);

    expect(fromParsed.projString).toBe(fromText.projString);
    expect(fromParsed.extents).toEqual(fromText.extents);
    expect(fromParsed.sceneBounds).toEqual(fromText.sceneBounds);
    expect(fromParsed.tileGridOrigin).toEqual(fromText.tileGridOrigin);
    expect(fromParsed.calibrationReport()).toEqual(fromText.calibrationReport());
    expect(fromParsed.wgs84ToScene(-122.1490743, 37.4275916)).toEqual(
      fromText.wgs84ToScene(-122.1490743, 37.4275916),
    );
  });

  it('rejects a non-y-up manifest through fromHeader too', () => {
    expect(() =>
      CoordinateFrame.fromHeader(parseXodrHeader(yaleHeaderText()), {
        scene: { coordinateSystem: 'z-up' },
      }),
    ).toThrow(/y-up/);
  });

  it('works from a header with no manifest at all', () => {
    const f = CoordinateFrame.fromHeader(parseXodrHeader(yaleHeaderText()));
    expect(f.sceneBounds).toBeUndefined();
    expect(f.tileGridOrigin).toBeUndefined();
    expect(() => f.calibrationReport()).toThrow(/scene bounds/);
    expect(f.localToScene(1, 2, 3)).toEqual([1, 3, -2]);
  });
});
