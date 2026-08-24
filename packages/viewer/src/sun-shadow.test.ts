import { describe, expect, it } from 'vitest';
import { Box3, DirectionalLight, Vector3 } from 'three';
import {
  BAKED_SUPPRESSION_OFF,
  applySunShadowFit,
  bakedSuppressionRadii,
  fitSunShadow,
  shadowBakeIsStale,
  shadowRadiusForScene,
} from './sun-shadow';
import { bakedSuppression, setBakedSuppression } from './materials';

describe('sun shadow fit', () => {
  it('parks the light up-sun of the focus and looks back at it', () => {
    const focus = new Vector3(10, 2, -5);
    // Light travelling straight down: the caster sits directly overhead.
    const fit = fitSunShadow(focus, new Vector3(0, -1, 0), 120, 40);
    expect(fit.target.equals(focus)).toBe(true);
    expect(fit.position.x).toBeCloseTo(focus.x, 6);
    expect(fit.position.z).toBeCloseTo(focus.z, 6);
    expect(fit.position.y).toBeGreaterThan(focus.y);
  });

  it('keeps the whole covered region in front of the near plane', () => {
    const focus = new Vector3(0, 0, 0);
    const fit = fitSunShadow(focus, new Vector3(-0.5, -0.6, -0.6), 120, 60);
    const distance = fit.position.distanceTo(fit.target);
    expect(fit.near).toBeLessThan(distance);
    // The far plane has to clear the focus and the geometry standing behind it.
    expect(fit.far).toBeGreaterThan(distance);
  });

  it('falls back to overhead light rather than dividing by zero', () => {
    const fit = fitSunShadow(new Vector3(), new Vector3(0, 0, 0), 100, 40);
    expect(Number.isFinite(fit.position.y)).toBe(true);
    expect(fit.position.y).toBeGreaterThan(0);
  });

  it('writes an orthographic frustum sized to the radius', () => {
    const sun = new DirectionalLight();
    applySunShadowFit(sun, fitSunShadow(new Vector3(), new Vector3(0, -1, 0), 80, 40));
    expect(sun.shadow.camera.right - sun.shadow.camera.left).toBeCloseTo(160, 6);
    expect(sun.shadow.camera.top - sun.shadow.camera.bottom).toBeCloseTo(160, 6);
  });
});

describe('shadow radius for a scene', () => {
  it('never covers more than the map itself', () => {
    const small = new Box3(new Vector3(-30, 0, -30), new Vector3(30, 10, 30));
    // A 60 m map does not need a 120 m frustum; the texels are better spent.
    expect(shadowRadiusForScene(small, 120)).toBeCloseTo(30, 6);
  });

  it('keeps the requested radius on a map larger than it', () => {
    const city = new Box3(new Vector3(-800, 0, -800), new Vector3(800, 60, 800));
    expect(shadowRadiusForScene(city, 120)).toBeCloseTo(120, 6);
  });

  it('survives an empty scene box', () => {
    expect(shadowRadiusForScene(new Box3(), 120)).toBeGreaterThan(0);
  });
});

describe('bake staleness', () => {
  const sun = new Vector3(0, 1, 0);

  it('bakes when nothing has been baked', () => {
    expect(shadowBakeIsStale(null, { focus: new Vector3(), radius: 120, sun })).toBe(true);
  });

  it('holds the bake while the camera stays inside the covered region', () => {
    const baked = { focus: new Vector3(), radius: 120, sun: sun.clone() };
    expect(shadowBakeIsStale(baked, { focus: new Vector3(20, 0, 0), radius: 120, sun })).toBe(false);
  });

  it('re-bakes once the camera has left the covered region', () => {
    const baked = { focus: new Vector3(), radius: 120, sun: sun.clone() };
    expect(shadowBakeIsStale(baked, { focus: new Vector3(90, 0, 0), radius: 120, sun })).toBe(true);
  });

  it('re-bakes when the sun moves even though the camera has not', () => {
    const baked = { focus: new Vector3(), radius: 120, sun: sun.clone() };
    const moved = new Vector3(0.3, 0.9, 0).normalize();
    expect(shadowBakeIsStale(baked, { focus: new Vector3(), radius: 120, sun: moved })).toBe(true);
  });
});

describe('baked term suppression', () => {
  it('suppresses the bake inside the real-time region and restores it outside', () => {
    const radii = bakedSuppressionRadii(100);
    // Inside `start` the real-time map owns the shadow; beyond `end` the bake
    // does. Applying both to the same ground double-darkens it.
    expect(radii.start).toBeLessThan(radii.end);
    expect(radii.end).toBeCloseTo(100, 6);
  });

  it('defaults to leaving the baked term applied everywhere', () => {
    // Negative radii make the shader's smoothstep return 1 at every real
    // distance, which is full baked strength.
    expect(BAKED_SUPPRESSION_OFF.start).toBeLessThan(0);
    expect(BAKED_SUPPRESSION_OFF.end).toBeLessThan(0);
    expect(BAKED_SUPPRESSION_OFF.start).toBeLessThan(BAKED_SUPPRESSION_OFF.end);
  });

  it('shares one region across every patched material', () => {
    setBakedSuppression({ x: 12, z: -8 }, 70, 100);
    expect(bakedSuppression()).toEqual({ x: 12, z: -8, start: 70, end: 100 });
    setBakedSuppression(
      { x: 0, z: 0 },
      BAKED_SUPPRESSION_OFF.start,
      BAKED_SUPPRESSION_OFF.end,
    );
    expect(bakedSuppression().end).toBe(BAKED_SUPPRESSION_OFF.end);
  });
});
