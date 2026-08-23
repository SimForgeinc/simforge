import { parseSimScenarioInput } from '@simforge/engine';
import { describe, expect, it } from 'vitest';
import { analyzeAsamCapabilities } from './common.js';

describe('special catalog OpenSCENARIO capability reporting', () => {
  it('warns about procedural appearance and nonportable emergency audio', () => {
    const input = parseSimScenarioInput({
      mapId: 'fixture', clipSeconds: 2, warmupSeconds: 0,
      actors: [{
        id: 'ambulance', kind: 'car', dims: { l: 6.1, w: 2.1, h: 2.65 },
        tags: ['catalog:vehicle.ambulance'],
        initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0 },
        behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] } },
      }],
      interactions: [{
        id: 'horn', actorId: 'ambulance', trigger: { kind: 'at', t: 1 },
        verb: 'set', target: { key: 'audio.horn', value: true },
      }],
    });
    const { warnings } = analyzeAsamCapabilities(input, 'xml-1.4-trajectory-replay');
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'catalog_appearance_approximate' }));
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'nonportable_emergency_cue', path: 'interactions.horn.target.key' }));
  });
});
