import { describe, expect, it } from 'vitest';

import type { Environment } from '@simforge-oss/scenario';
import { LIGHTING_EXTENSION_KEY, SCENE_TIME_EXTENSION_KEY } from '@simforge-oss/scenario/contracts';

import { CINEMATIC_PROFILE_CONFIG, resolveNativeLighting, sceneMinutes, solarPosition, weatherPreset } from './lighting.js';

const BASE: Environment = { weather: 'clear', timeOfDay: 'dawn', surfacePatches: [] };

describe('native lighting', () => {
  it('matches the lab solar model at the canonical hours', () => {
    // lab/server/settings.py::solar_position on day 172.
    expect(solarPosition(385)).toEqual({ elevationDeg: 5.758, azimuthDeg: 115.248 });
    expect(solarPosition(720)).toEqual({ elevationDeg: 69.511, azimuthDeg: 51.898 });
    expect(solarPosition(1195)).toEqual({ elevationDeg: 5.724, azimuthDeg: 244.72 });
    expect(solarPosition(0)).toEqual({ elevationDeg: -26.938, azimuthDeg: 162.031 });
  });

  it('reads the exact scene clock, else the preset hour', () => {
    expect(sceneMinutes(BASE)).toBe(6 * 60);
    expect(sceneMinutes({ ...BASE, extensions: { [SCENE_TIME_EXTENSION_KEY]: { minutes: 1195 } } })).toBe(1195);
    expect(sceneMinutes({ ...BASE, timeOfDay: 'night_lit' })).toBe(21 * 60);
  });

  it('is the lab default for a fresh scenario', () => {
    const { lighting, profileConfig } = resolveNativeLighting(
      { ...BASE, extensions: { [SCENE_TIME_EXTENSION_KEY]: { minutes: 385 } } },
    );
    expect(lighting).toMatchObject({
      sun_elev_deg: 5.758, sun_azim_deg: 115.248, weather: 'clear', atmosphere: true,
      visibility_m: 80_000, turbidity: 2.4, cloud_cover: 0, haze: 0, wetness: 0,
      sun_scale: 1, ambient_scale: 1, ev100_bias: 0,
    });
    expect(lighting.night).toMatchObject({
      utc_minutes: 805, utc_day_of_year: 172, cloud_type: 0.85, cloud_base_m: 1200, cloud_top_m: 2800,
      window_mode: 'synthetic_facade', cloud_quality: 'scalable', sky_display_lift: 120,
    });
    expect(profileConfig).toBe(CINEMATIC_PROFILE_CONFIG);
    expect(profileConfig.cinematic).toMatchObject({ aa: 'taa', toneMap: 'agx', motionShutterAngle: 0, bloomIntensity: 0.1 });
  });

  it('maps every scenario weather onto a renderer air mass', () => {
    expect(weatherPreset('cloudy')).toMatchObject({ weather: 'cloudy', cloudCover: 0.45, visibilityM: 30_000 });
    expect(weatherPreset('heavy_rain')).toMatchObject({ weather: 'rain', wetness: 1, visibilityM: 1_500 });
    expect(weatherPreset('fog_dense')).toMatchObject({ weather: 'fog', visibilityM: 150 });
    expect(weatherPreset('snow')).toMatchObject({ weather: 'overcast', wetness: 0.3 });
  });

  it('honours the Studio lighting block as the lab knobs', () => {
    const { lighting, provenance } = resolveNativeLighting({
      ...BASE,
      weather: 'cloudy',
      extensions: {
        [LIGHTING_EXTENSION_KEY]: { scaleRevision: 2, sun: 1.5, ambient: 0.5, exposure: 2, visibilityM: 4_000, haze: 0.2 },
      },
    });
    expect(lighting).toMatchObject({
      sun_scale: 1.5, ambient_scale: 0.5, ev100_bias: -1, visibility_m: 4_000, haze: 0.2, weather: 'cloudy',
    });
    expect(provenance.overrides).toEqual({ sun: 1.5, ambient: 0.5, exposure: 2, visibilityM: 4_000, haze: 0.2 });
  });

  it('rolls the UTC day past midnight PDT', () => {
    const { lighting } = resolveNativeLighting({ ...BASE, extensions: { [SCENE_TIME_EXTENSION_KEY]: { minutes: 1380 } } });
    expect(lighting.night.utc_minutes).toBe(360);
    expect(lighting.night.utc_day_of_year).toBe(173);
  });
});
