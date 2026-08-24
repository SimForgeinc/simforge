import { describe, expect, it } from 'vitest';

import { migrateLegacyInitialRoutes } from '../initial-route-migration.js';
import { parseTemplate, serializeTemplate } from '../serialize.js';

function template() {
  return parseTemplate({
    scenarioVersion: 2,
    meta: { name: 'initial route migration', description: '', createdAt: '2026-01-01T00:00:00.000Z', modifiedAt: '2026-01-01T00:00:00.000Z', appVersion: 'test' },
    anchor: { features: [], pin: { mapId: 'map' } },
    roles: [{
      id: 'ego', kind: 'scene_absolute', actor: { class: 'car' },
      pose: { position: { x: 0, y: 0, z: 0 }, headingRad: 0 },
    }],
    choreography: { interactions: [
      { id: 'route_ego_initial', actor: 'ego', label: 'Random turns', trigger: { kind: 'at', t: 0 }, verb: 'route', target: { mode: 'lanePath', lanes: ['1:0:-1', '2:0:-1'] } },
      { id: 'reroute', actor: 'ego', trigger: { kind: 'at', t: 5 }, verb: 'route', target: { mode: 'lanePath', lanes: ['2:0:-1', '3:0:-1'] } },
    ] },
  });
}

describe('legacy initial route migration', () => {
  it('moves only generated t=0 lane paths into scene_absolute spawn state', () => {
    const result = migrateLegacyInitialRoutes(template());
    expect(result.interactionIds).toEqual(['route_ego_initial']);
    expect(result.template.roles[0]).toMatchObject({ initialRoute: { mode: 'lanePath', lanes: ['1:0:-1', '2:0:-1'] } });
    expect(result.template.choreography.interactions.map((item) => item.id)).toEqual(['reroute']);
    expect(migrateLegacyInitialRoutes(result.template)).toEqual({ template: result.template, interactionIds: [] });
    const roundTrip = parseTemplate(JSON.parse(serializeTemplate(result.template)));
    expect(serializeTemplate(roundTrip)).toBe(serializeTemplate(result.template));
  });

  it('does not remove an initial-looking interaction referenced by choreography', () => {
    const source = template();
    const withReference = parseTemplate({
      ...source,
      choreography: { interactions: [
        ...source.choreography.interactions,
        { id: 'after_route', actor: 'ego', trigger: { kind: 'after', of: 'route_ego_initial', event: 'start', delayS: 0 }, verb: 'set', target: { key: 'audio.horn', value: true } },
      ] },
    });
    const result = migrateLegacyInitialRoutes(withReference);
    expect(result.template).toBe(withReference);
    expect(result.interactionIds).toEqual([]);
  });
});
