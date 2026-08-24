import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  ATMOSPHERE_LAYER,
  CLEAR_SKY,
  SkyDome,
  environmentNeedsRebuild,
  skyAppearanceForWeather,
  sunElevationFalloff,
} from './sky';

describe('sky dome', () => {
  it('is excluded from a default camera, so sensor passes never see it', () => {
    const sky = new SkyDome();
    try {
      // A three.js `Camera` enables only layer 0; sensor depth/LiDAR/id passes
      // build their own cameras and must not resolve a hit against the dome.
      expect(sky.mesh.layers.isEnabled(0)).toBe(false);
      expect(sky.mesh.layers.isEnabled(ATMOSPHERE_LAYER)).toBe(true);
    } finally {
      sky.dispose();
    }
  });

  it('sizes the dome inside the camera far plane so it is not clipped away', () => {
    const sky = new SkyDome();
    try {
      // The dome is geometry: parked past the far plane it renders nothing,
      // which looks exactly like a missing sky.
      sky.fitToCamera(6000);
      expect(sky.currentRadius()).toBeLessThan(6000);
      expect(sky.currentRadius()).toBeGreaterThan(0);
      expect(sky.mesh.scale.x).toBeCloseTo(sky.currentRadius(), 6);

      sky.fitToCamera(0);
      expect(sky.currentRadius()).toBeGreaterThan(0);
      sky.fitToCamera(Number.NaN);
      expect(Number.isFinite(sky.currentRadius())).toBe(true);
    } finally {
      sky.dispose();
    }
  });

  it('rides with the camera so the viewpoint never leaves the dome', () => {
    const sky = new SkyDome();
    try {
      sky.follow(new Vector3(1200, 40, -900));
      expect(sky.mesh.position.toArray()).toEqual([1200, 40, -900]);
    } finally {
      sky.dispose();
    }
  });

  it('applies the overcast tint patch to the shader it was compiled against', () => {
    const sky = new SkyDome();
    try {
      // The constructor throws if the anchor is missing, so this pins the
      // patched result rather than a silent no-op replace.
      expect(sky.mesh.material.fragmentShader).toContain('uSkyTintAmount');
      expect(sky.mesh.material.fragmentShader).toContain('mix( texColor');
    } finally {
      sky.dispose();
    }
  });

  it('aims at the sun from the direction light travels', () => {
    const sky = new SkyDome();
    try {
      // Manifest convention: the vector points away from the sun.
      sky.setSunTravelDirection(new Vector3(0, -1, 0));
      expect(sky.sunDirection().y).toBeCloseTo(1, 10);
      expect(sky.sunElevationDeg()).toBeCloseTo(90, 6);

      sky.setSunTravelDirection(new Vector3(-1, 0, 0));
      expect(sky.sunDirection().x).toBeCloseTo(1, 10);
      expect(sky.sunElevationDeg()).toBeCloseTo(0, 6);
    } finally {
      sky.dispose();
    }
  });

  it('ignores a zero direction rather than producing NaN uniforms', () => {
    const sky = new SkyDome();
    try {
      sky.setSunTravelDirection(new Vector3(0, -1, 0));
      sky.setSunTravelDirection(new Vector3(0, 0, 0));
      expect(sky.sunDirection().y).toBeCloseTo(1, 10);
      expect(Number.isNaN(sky.sunElevationDeg())).toBe(false);
    } finally {
      sky.dispose();
    }
  });

  it('writes weather onto the scattering uniforms', () => {
    const sky = new SkyDome();
    try {
      const overcast = skyAppearanceForWeather({ haze: 1, backgroundColor: 0x8a929c });
      sky.setAppearance(overcast);
      // Overcast is a high-aerosol, low-Rayleigh sky: bright and desaturated
      // rather than deep blue.
      expect(sky.uniformValues().turbidity).toBeGreaterThan(CLEAR_SKY.turbidity);
      expect(sky.uniformValues().rayleigh).toBeLessThan(CLEAR_SKY.rayleigh);
      expect(sky.uniformValues().tintAmount).toBeGreaterThan(0);

      sky.setAppearance(CLEAR_SKY);
      expect(sky.uniformValues().turbidity).toBeCloseTo(CLEAR_SKY.turbidity, 6);
      expect(sky.uniformValues().tintAmount).toBe(0);
    } finally {
      sky.dispose();
    }
  });

  it('leaves a clear sky untinted when weather authors no colour', () => {
    const appearance = skyAppearanceForWeather({ haze: 0, backgroundColor: null });
    expect(appearance.tint).toBeNull();
    expect(appearance.tintAmount).toBe(0);
    expect(appearance.turbidity).toBeCloseTo(CLEAR_SKY.turbidity, 6);
  });

  it('does not wash a clear sky toward the authored flat colour', () => {
    // Clear weather still carries a background colour, and tinting toward it
    // turns a blue midday sky into white haze.
    const clear = skyAppearanceForWeather({ haze: 0, backgroundColor: 0x9fb8d4 });
    expect(clear.tintAmount).toBe(0);

    const overcast = skyAppearanceForWeather({ haze: 1, backgroundColor: 0x8a929c });
    expect(overcast.tintAmount).toBeGreaterThan(0.5);
  });
});

describe('sun elevation falloff', () => {
  it('fades direct sun out through civil twilight', () => {
    expect(sunElevationFalloff(45)).toBe(1);
    expect(sunElevationFalloff(0)).toBe(1);
    expect(sunElevationFalloff(-3)).toBeCloseTo(0.5, 6);
    expect(sunElevationFalloff(-6)).toBe(0);
    // Night: no direct term at all, so no shadow pass is worth baking.
    expect(sunElevationFalloff(-30)).toBe(0);
  });
});

describe('environment rebuild gating', () => {
  const up = new Vector3(0, 1, 0);

  it('builds when nothing is baked yet', () => {
    expect(environmentNeedsRebuild(null, { sun: up, key: 'a' })).toBe(true);
  });

  it('holds the bake for sub-degree sun movement', () => {
    const baked = { sun: up.clone(), key: 'a' };
    const nudged = new Vector3(0, 1, 0).applyAxisAngle(new Vector3(1, 0, 0), 0.01);
    expect(environmentNeedsRebuild(baked, { sun: nudged, key: 'a' })).toBe(false);
  });

  it('rebuilds once the sun has moved far enough to change the ambient', () => {
    const baked = { sun: up.clone(), key: 'a' };
    const moved = new Vector3(0, 1, 0).applyAxisAngle(new Vector3(1, 0, 0), 0.1);
    expect(environmentNeedsRebuild(baked, { sun: moved, key: 'a' })).toBe(true);
  });

  it('rebuilds when the sky parameters change under a fixed sun', () => {
    const baked = { sun: up.clone(), key: 'clear' };
    expect(environmentNeedsRebuild(baked, { sun: up, key: 'overcast' })).toBe(true);
  });
});
