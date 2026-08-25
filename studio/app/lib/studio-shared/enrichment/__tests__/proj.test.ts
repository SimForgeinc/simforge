import { describe, expect, it } from "vitest";
import { MapProjection, synthesizeTmercProjString } from "../proj";

/**
 * Safety net against the class of bug we hit before: projection helpers
 * claiming to apply the XODR's TMerc projection but actually applying a
 * flat-earth equirectangular approximation. These tests cover:
 *
 *   1. Round-trip identity (geoToLocal then localToGeo → input, machine precision)
 *   2. Origin maps to (0, 0) — basic correctness
 *   3. Hardcoded golden values (immutable references, regression catches)
 *   4. The "not equirectangular" smoke test — projection must disagree with
 *      the flat-earth formula by a known minimum amount as you move away from
 *      origin, otherwise we've silently regressed to the old bug
 *   5. Non-default PROJ parameters (false easting/northing, k≠1, alternate
 *      projection families) work — this is the whole point of routing
 *      through proj4
 *   6. `MapProjection.fromCoordinateRef` precedence (asset proj_string >
 *      synthesized fallback > undefined)
 */

// PROJ origin used by Saratoga School Area in the local dataset.
const SARATOGA_LAT = 37.3062949404212;
const SARATOGA_LON = -121.987040676177;
const SARATOGA = new MapProjection(synthesizeTmercProjString(SARATOGA_LAT, SARATOGA_LON));

// PROJ string copied verbatim from a real RoadRunner XODR (RFS map).
const RFS_PROJ_STR = "+proj=tmerc +lat_0=37.9150891287087 +lon_0=-122.333308830857 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +vunits=m +no_defs";

describe("MapProjection — round-trip identity", () => {
  // Sample several points at varying distances/bearings from origin.
  const points = [
    { lng: SARATOGA_LON, lat: SARATOGA_LAT, label: "origin" },
    { lng: SARATOGA_LON + 0.001, lat: SARATOGA_LAT + 0.001, label: "100m NE" },
    { lng: SARATOGA_LON - 0.005, lat: SARATOGA_LAT + 0.003, label: "500m NW" },
    { lng: SARATOGA_LON + 0.01, lat: SARATOGA_LAT - 0.008, label: "1km SE" },
    { lng: SARATOGA_LON + 0.05, lat: SARATOGA_LAT - 0.04, label: "5km SE" },
  ];

  for (const p of points) {
    it(`round-trips ${p.label} to machine precision`, () => {
      const xy = SARATOGA.geoToLocal(p.lng, p.lat);
      const back = SARATOGA.localToGeo(xy.x, xy.y);
      // Round-trip should be exact to ~1e-12 deg (sub-µm at lat 37°).
      expect(Math.abs(back.lon - p.lng)).toBeLessThan(1e-12);
      expect(Math.abs(back.lat - p.lat)).toBeLessThan(1e-12);
    });
  }

  it("maps the origin to (0, 0)", () => {
    const { x, y } = SARATOGA.geoToLocal(SARATOGA_LON, SARATOGA_LAT);
    expect(Math.abs(x)).toBeLessThan(1e-6);
    expect(Math.abs(y)).toBeLessThan(1e-6);
  });

  it("round-trips correctly when constructed from a real verbatim XODR PROJ string (RFS)", () => {
    // Use the verbatim PROJ string format from a real XODR — proves we don't
    // depend on a particular parameter ordering or the absence of +vunits/+no_defs.
    const rfs = new MapProjection(RFS_PROJ_STR);
    const lng = -122.333308830857 + 0.01;
    const lat = 37.9150891287087 - 0.008;
    const xy = rfs.geoToLocal(lng, lat);
    const back = rfs.localToGeo(xy.x, xy.y);
    expect(Math.abs(back.lon - lng)).toBeLessThan(1e-12);
    expect(Math.abs(back.lat - lat)).toBeLessThan(1e-12);
  });

  it("exposes the constructor PROJ string verbatim", () => {
    expect(SARATOGA.proj).toBe(synthesizeTmercProjString(SARATOGA_LAT, SARATOGA_LON));
    expect(new MapProjection(RFS_PROJ_STR).proj).toBe(RFS_PROJ_STR);
  });
});

describe("MapProjection.geoToLocal — golden reference values (regression guard)", () => {
  // These are the projected (x, y) outputs at fixed lng/lat for the Saratoga
  // PROJ origin. Generated once via proj4. Any future projection regression
  // (changed library, accidental swap to a different formula) will move these
  // values measurably and fail the test.
  //
  // To regenerate after a deliberate library upgrade: log the value of
  // `SARATOGA.geoToLocal(lng, lat)` and paste below.
  const goldens = [
    { lng: -121.986040676177, lat: 37.3072949404212, x: 88.652185, y: 110.98387 },
    { lng: -121.977040676177, lat: 37.2982949404212, x: 886.627498, y: -887.819647 },
    { lng: -121.992040676177, lat: 37.3092949404212, x: -443.249183, y: 332.961982 },
  ];

  for (const g of goldens) {
    it(`projects (${g.lng - SARATOGA_LON}, ${g.lat - SARATOGA_LAT}) to (${g.x}, ${g.y}) m within 1mm`, () => {
      const xy = SARATOGA.geoToLocal(g.lng, g.lat);
      expect(Math.abs(xy.x - g.x)).toBeLessThan(0.001);
      expect(Math.abs(xy.y - g.y)).toBeLessThan(0.001);
    });
  }
});

describe("MapProjection.geoToLocal — diverges from equirectangular as expected", () => {
  // Smoke test against the historical bug: the flat-earth formula treats
  // earth as flat using a constant 111320 m/degree and cos(origin_lat).
  // Proper TMerc accounts for the WGS84 ellipsoid, so the disagreement grows
  // linearly with distance from origin. If a future regression silently swaps
  // proj4 for the equirectangular shortcut, these tests fail.

  function equirect(lng: number, lat: number) {
    return {
      x: (lng - SARATOGA_LON) * 111320 * Math.cos((SARATOGA_LAT * Math.PI) / 180),
      y: (lat - SARATOGA_LAT) * 111320,
    };
  }

  it("agrees with equirectangular at the origin (no projection error to magnify)", () => {
    const tm = SARATOGA.geoToLocal(SARATOGA_LON, SARATOGA_LAT);
    const eq = equirect(SARATOGA_LON, SARATOGA_LAT);
    expect(Math.abs(tm.x - eq.x)).toBeLessThan(1e-6);
    expect(Math.abs(tm.y - eq.y)).toBeLessThan(1e-6);
  });

  it("disagrees with equirectangular by 0.5–5m on the y axis at 1km from origin", () => {
    // ~0.009° lat ≈ 1km north. The meridional-arc difference vs flat-earth is
    // ~0.17% at lat 37° → ~1.7m on a 1km offset.
    const lng = SARATOGA_LON;
    const lat = SARATOGA_LAT + 0.009;
    const tm = SARATOGA.geoToLocal(lng, lat);
    const eq = equirect(lng, lat);
    const dy = Math.abs(tm.y - eq.y);
    expect(dy).toBeGreaterThan(0.5);
    expect(dy).toBeLessThan(5);
  });

  it("disagreement scales with distance — 5km point shows ~5x the dy error of 1km", () => {
    // Confirms the divergence is the systematic projection-method one, not
    // numerical noise. If proj4 were ever silently aliased back to a flat
    // approximation this would catch it because the dy at 5km would stay
    // near zero.
    const dy1km = Math.abs(
      SARATOGA.geoToLocal(SARATOGA_LON, SARATOGA_LAT + 0.009).y - equirect(SARATOGA_LON, SARATOGA_LAT + 0.009).y,
    );
    const dy5km = Math.abs(
      SARATOGA.geoToLocal(SARATOGA_LON, SARATOGA_LAT + 0.045).y - equirect(SARATOGA_LON, SARATOGA_LAT + 0.045).y,
    );
    expect(dy5km).toBeGreaterThan(4 * dy1km);
    expect(dy5km).toBeLessThan(6 * dy1km);
  });
});

describe("MapProjection — non-default PROJ parameters work via proj4", () => {
  // The historical hand-rolled implementation hardcoded k=1, x_0=0, y_0=0,
  // WGS84. proj4 picks all of these up from the PROJ string. These tests
  // verify that future maps with non-default parameters produce expected
  // results, so we know proj4 is actually consulting the string (rather than
  // silently defaulting back to vanilla TMerc).

  it("respects +x_0 false easting", () => {
    const base = synthesizeTmercProjString(SARATOGA_LAT, SARATOGA_LON);
    const shifted = base.replace("+x_0=0", "+x_0=500");
    const xBase = new MapProjection(base).geoToLocal(SARATOGA_LON, SARATOGA_LAT).x;
    const xShifted = new MapProjection(shifted).geoToLocal(SARATOGA_LON, SARATOGA_LAT).x;
    expect(xShifted - xBase).toBeCloseTo(500, 6);
  });

  it("respects +y_0 false northing", () => {
    const base = synthesizeTmercProjString(SARATOGA_LAT, SARATOGA_LON);
    const shifted = base.replace("+y_0=0", "+y_0=-1000");
    const yBase = new MapProjection(base).geoToLocal(SARATOGA_LON, SARATOGA_LAT).y;
    const yShifted = new MapProjection(shifted).geoToLocal(SARATOGA_LON, SARATOGA_LAT).y;
    expect(yShifted - yBase).toBeCloseTo(-1000, 6);
  });

  it("respects +k scale factor", () => {
    // k=0.9996 is UTM-style. At 5km north of origin, expect the projected y
    // to be ~5km × 0.9996 = ~4998m vs ~5000m at k=1.
    const base = synthesizeTmercProjString(SARATOGA_LAT, SARATOGA_LON);
    const utm = base.replace("+k=1", "+k=0.9996");
    const lat = SARATOGA_LAT + 0.045; // ~5km north
    const yBase = new MapProjection(base).geoToLocal(SARATOGA_LON, lat).y;
    const yScaled = new MapProjection(utm).geoToLocal(SARATOGA_LON, lat).y;
    expect(yScaled / yBase).toBeCloseTo(0.9996, 6);
  });

  it("handles a full UTM PROJ string (different projection family entirely)", () => {
    const utm10n = new MapProjection("+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs");
    const xy = utm10n.geoToLocal(SARATOGA_LON, SARATOGA_LAT);
    const back = utm10n.localToGeo(xy.x, xy.y);
    expect(Math.abs(back.lon - SARATOGA_LON)).toBeLessThan(1e-9);
    expect(Math.abs(back.lat - SARATOGA_LAT)).toBeLessThan(1e-9);
    // UTM zone 10N covers most of California; Saratoga's easting should land
    // in the typical 580–600km range for this zone at this longitude.
    expect(xy.x).toBeGreaterThan(580_000);
    expect(xy.x).toBeLessThan(600_000);
  });
});

describe("MapProjection.fromCoordinateRef — precedence", () => {
  it("uses the asset's verbatim proj_string when present and looks like PROJ", () => {
    const proj = MapProjection.fromCoordinateRef({ proj_string: RFS_PROJ_STR });
    expect(proj).toBeDefined();
    expect(proj!.proj).toBe(RFS_PROJ_STR);
  });

  it("synthesizes a vanilla tmerc projection when only origin is on record", () => {
    const proj = MapProjection.fromCoordinateRef({ origin_lat: 37.5, origin_lon: -122.5 });
    expect(proj).toBeDefined();
    expect(proj!.proj).toContain("+proj=tmerc");
    expect(proj!.proj).toContain("+lat_0=37.5");
    expect(proj!.proj).toContain("+lon_0=-122.5");
  });

  it("returns undefined when neither proj_string nor origin is available", () => {
    expect(MapProjection.fromCoordinateRef({})).toBeUndefined();
  });

  it("ignores a malformed proj_string (no +proj= prefix) and falls back to origin", () => {
    const proj = MapProjection.fromCoordinateRef({
      proj_string: "garbage",
      origin_lat: 37.5,
      origin_lon: -122.5,
    });
    expect(proj).toBeDefined();
    expect(proj!.proj).toContain("+proj=tmerc");
    expect(proj!.proj).toContain("+lat_0=37.5");
  });
});
