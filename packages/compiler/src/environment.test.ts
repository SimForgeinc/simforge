import { describe, expect, it } from 'vitest';

import { applyTemplateEnvironment } from './materialize.js';

describe('canonical template environment materialization', () => {
  it('preserves heavy-rain friction and low-sun directional glare without a catalog variant', () => {
    expect(applyTemplateEnvironment({
      weather: 'heavy_rain',
      timeOfDay: 'dusk',
      surfacePatches: [],
      frictionScale: 0.58,
      sunAzimuthDeg: 180,
      sunElevationDeg: 4,
      extensions: { visibility: 'directional-glare' },
    })).toEqual({
      weather: 'rain',
      timeOfDay: 'dusk',
      traffic: 'moderate',
      visibility: 'directional-glare',
      effects: { visibilityRangeM: 105, frictionScale: 0.58, trafficSpeedFactor: 1 },
    });
  });

  it('maps ordinary authoring presets into the engine vocabulary', () => {
    expect(applyTemplateEnvironment({ weather: 'snow', timeOfDay: 'night_lit', surfacePatches: [] })).toMatchObject({
      weather: 'overcast', timeOfDay: 'night', effects: { frictionScale: 0.35 },
    });
  });
});
