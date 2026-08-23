import { describe, expect, it } from 'vitest';

import { buildSumoRouteDocument, resolveAmbientTrafficProfile, sumoVehicleId } from '../index.js';

const candidates = [['a', 'b'], ['c', 'd'], ['e', 'f']];
const profile = resolveAmbientTrafficProfile({ version: 1, preset: 'custom', seed: 'shared', maxActors: 2 });

describe('shared SUMO route generation', () => {
  it('uses stable one-shot ids for headless path collection', () => {
    const xml = buildSumoRouteDocument(candidates, profile);
    expect(xml.match(/<vehicle /g)).toHaveLength(2);
    expect(xml).not.toContain('<flow ');
    expect(xml).toContain(`id="${sumoVehicleId(profile.seed, 0)}"`);
    expect(xml).toContain('depart="0"');
  });

  it('supports the editor stagger and bounded replenishment contract', () => {
    const xml = buildSumoRouteDocument(candidates, profile, {
      departureWindowSeconds: 1,
      replenishmentPeriodSeconds: 40,
      replenishmentStride: 4,
      flowEndSeconds: 3600,
    });
    expect(xml.match(/<flow /g)).toHaveLength(1);
    expect(xml.match(/<vehicle /g)).toHaveLength(1);
    expect(xml).toContain('begin="0.00"');
    expect(xml).toContain('depart="1.00"');
    expect(xml).toContain('period="40"');
  });
});
