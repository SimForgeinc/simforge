import { describe, expect, it } from 'vitest';

import { DRIVER_PROFILES, driverProfileDefinition } from '../driver-profiles.js';

describe('driver profiles', () => {
  it('keeps assertiveness independent from traffic-law compliance', () => {
    expect(DRIVER_PROFILES.assertive.rules.aggression).toBeGreaterThan(DRIVER_PROFILES.lawful.rules.aggression);
    expect(DRIVER_PROFILES.assertive.rules.obeySignals).toBe(true);
    expect(DRIVER_PROFILES.cautious.rules.obeySignals).toBe(true);
    expect(DRIVER_PROFILES.violator.rules.obeySignals).toBe(false);
    expect(DRIVER_PROFILES.violator.rules.collisionAvoidance).toBe(true);
  });

  it('defaults older authored roles to the lawful profile', () => {
    expect(driverProfileDefinition(undefined).id).toBe('lawful');
  });
});
