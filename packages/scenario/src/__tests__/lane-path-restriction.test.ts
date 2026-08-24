import { describe, expect, it } from 'vitest';

import { parseTemplate } from '../serialize.js';
import { validateTemplate } from '../validate/index.js';
import { ltapTemplateInput } from './v2-fixtures.js';

function withLanePath(options: { pinned: boolean; sceneAbsolute: boolean }) {
  const base = ltapTemplateInput();
  const ego = options.sceneAbsolute
    ? {
        id: 'ego',
        kind: 'scene_absolute' as const,
        actor: { class: 'car' as const, catalogId: 'vehicle.sedan' },
        pose: { position: { x: 0, y: 0, z: 0 }, headingRad: 0 },
        laneRef: { roadId: '1', section: 0, laneId: -1, s: 5, t: 0, headingOffsetRad: 0 },
        initialSpeedKph: 30,
      }
    : base.roles![0]!;
  return parseTemplate({
    ...base,
    anchor: {
      ...base.anchor,
      ...(options.pinned ? { pin: { mapId: 'yale-street' } } : {}),
    },
    roles: [ego, base.roles![1]!],
    choreography: {
      clipSeconds: 20,
      interactions: [{
        id: 'ego-exact-route',
        actor: 'ego',
        trigger: { kind: 'at', t: 0 },
        verb: 'route',
        target: { mode: 'lanePath', lanes: ['1:0:-1', '2:0:-1'] },
      }],
    },
    invariants: [],
  });
}

describe('exact lanePath structural restriction', () => {
  it('accepts a lanePath only for a pinned scene_absolute actor', () => {
    const report = validateTemplate(withLanePath({ pinned: true, sceneAbsolute: true }));
    expect(report.issues.filter((issue) => issue.path.endsWith('.target'))).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it.each([
    { pinned: false, sceneAbsolute: true, label: 'unpinned actor' },
    { pinned: true, sceneAbsolute: false, label: 'portable actor' },
  ])('rejects a lanePath for a $label', ({ pinned, sceneAbsolute }) => {
    const report = validateTemplate(withLanePath({ pinned, sceneAbsolute }));
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        code: 'route_disconnected',
        path: 'choreography.interactions.0.target',
      }),
    ]));
    expect(report.ok).toBe(false);
  });
});
