import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CoordinateFrame } from '../coordinate-frame.js';
import { LegacyFlatEarthFrame } from '../legacy-flat-earth.js';

interface GoldenPoint {
  id: string;
  wgs84: { lat: number; lon: number };
  xodrLocal: [number, number];
  legacyFlatEarth: [number, number];
  crossFrameDeltaMeters: number;
}

interface GoldenFixtures {
  lineages: Record<string, { xodrSha256: string }>;
  projString: string;
  tolerances: {
    tmercRoundTripMeters: number;
    flatEarthRoundTripDegrees: number;
  };
  points: GoldenPoint[];
}

const fixtures: GoldenFixtures = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../fixtures/v2x-richmond-golden-projections.json', import.meta.url),
    ),
    'utf8',
  ),
) as GoldenFixtures;

const frame = new CoordinateFrame({ projString: fixtures.projString });
const legacy = LegacyFlatEarthFrame.fromProjString(fixtures.projString);

describe('v2x golden projections (richmond-field-station)', () => {
  it('fixture carries both Richmond lineages with their pinned digests', () => {
    expect(fixtures.lineages.deployed?.xodrSha256).toMatch(/^0737f3d9/);
    expect(fixtures.lineages.uni?.xodrSha256).toMatch(/^80704cd1/);
  });

  for (const p of fixtures.points) {
    it(`[${p.id}] strict tmerc recomputes from WGS-84 within tolerance`, () => {
      const [x, y] = frame.wgs84ToLocal(p.wgs84.lon, p.wgs84.lat);
      expect(Math.hypot(x - p.xodrLocal[0], y - p.xodrLocal[1])).toBeLessThan(
        fixtures.tolerances.tmercRoundTripMeters,
      );
    });

    it(`[${p.id}] strict tmerc round-trips local -> WGS-84 -> local`, () => {
      const [lon, lat] = frame.localToWgs84(p.xodrLocal[0], p.xodrLocal[1]);
      const back = frame.wgs84ToLocal(lon, lat);
      // 1e-9 degrees is ~0.11 mm of latitude; the proj4 inverse is exact to
      // well under that, so this catches any sign/axis swap.
      expect(Math.hypot(back[0] - p.xodrLocal[0], back[1] - p.xodrLocal[1])).toBeLessThan(0.001);
    });

    it(`[${p.id}] legacy flat-earth matches the geo_utils.py formula and round-trips`, () => {
      const fe = legacy.wgs84ToLocal(p.wgs84.lat, p.wgs84.lon);
      expect(fe.x).toBeCloseTo(p.legacyFlatEarth[0], 3);
      expect(fe.y).toBeCloseTo(p.legacyFlatEarth[1], 3);
      // exact algebraic inverse
      const geo = legacy.localToWgs84(fe.x, fe.y);
      expect(Math.abs(geo.lat - p.wgs84.lat)).toBeLessThan(1e-12);
      expect(Math.abs(geo.lon - p.wgs84.lon)).toBeLessThan(1e-12);
      // independent recomputation straight from the contract formula
      const expectedX = (p.wgs84.lon - legacy.lon0) * legacy.metersPerDegLon;
      const expectedY = -(p.wgs84.lat - legacy.lat0) * 111_320.0;
      expect(fe.x).toBeCloseTo(expectedX, 6);
      expect(fe.y).toBeCloseTo(expectedY, 6);
    });

    it(`[${p.id}] cross-frame divergence (legacy vs strict tmerc) matches the recorded value`, () => {
      const [tx, ty] = frame.wgs84ToLocal(p.wgs84.lon, p.wgs84.lat);
      // legacy CARLA y is the NEGATED northing; undo before comparing
      const dx = p.legacyFlatEarth[0] - tx;
      const dy = -p.legacyFlatEarth[1] - ty;
      expect(Math.hypot(dx, dy)).toBeCloseTo(p.crossFrameDeltaMeters, 3);
    });
  }

  it('camera-pole legacy placement reproduces the deployed twin transform', () => {
    const pole = fixtures.points.find((p) => p.id === 'camera-pole');
    expect(pole).toBeDefined();
    if (!pole) return;
    // gps_to_carla(site.lat, site.lon) in the deployed twin, before Z snap:
    // the pole sits ~130 m west / ~57 m south of the CARLA origin.
    const loc = legacy.wgs84ToLocal(pole.wgs84.lat, pole.wgs84.lon);
    expect(loc.x).toBeLessThan(-125);
    expect(loc.y).toBeGreaterThan(-62);
    expect(loc.y).toBeLessThan(-52);
  });

  it('LegacyFlatEarthFrame.fromProjString rejects strings without +lat_0/+lon_0', () => {
    expect(() => LegacyFlatEarthFrame.fromProjString('+proj=utm +zone=10')).toThrow();
  });
});
