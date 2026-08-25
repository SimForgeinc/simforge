import { describe, expect, it } from 'vitest';
import {
  ev100ForSunElevation,
  sunColorTemperatureK,
  sunDirectNormalIlluminanceLx,
  twilightRamp,
} from './lighting-calibration';

// Mirrors renderer/render-core/src/calibration.rs tests: both modules are
// duplicated implementations of docs/lighting-calibration.md and must agree
// on the spec anchors.
describe('lighting calibration spec anchors', () => {
  it('matches the sun-model anchors from the spec table', () => {
    expect(sunDirectNormalIlluminanceLx(90)).toBeCloseTo(89_600, -3);
    const noon = sunDirectNormalIlluminanceLx(60);
    expect(noon).toBeGreaterThan(80_000);
    expect(noon).toBeLessThan(90_000);
    const dusk = sunDirectNormalIlluminanceLx(4);
    expect(dusk).toBeGreaterThan(5_000);
    expect(dusk).toBeLessThan(25_000);
    expect(sunDirectNormalIlluminanceLx(-6)).toBe(0);
  });

  it('ramps direct sun to zero through civil twilight', () => {
    expect(twilightRamp(1)).toBe(1);
    expect(twilightRamp(-3)).toBeCloseTo(0.5);
    expect(twilightRamp(-6)).toBe(0);
  });

  it('clamps EV100 to the spec band', () => {
    expect(ev100ForSunElevation(60)).toBeCloseTo(15, 4);
    expect(ev100ForSunElevation(-6)).toBe(9);
    const dusk = ev100ForSunElevation(4);
    expect(dusk).toBeGreaterThanOrEqual(9);
    expect(dusk).toBeLessThan(13);
  });

  it('cools the sun colour temperature toward the horizon', () => {
    expect(sunColorTemperatureK(60)).toBe(5500);
    expect(sunColorTemperatureK(0)).toBe(2500);
    expect(sunColorTemperatureK(-10)).toBe(2500);
  });
});
