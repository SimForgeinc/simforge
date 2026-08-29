import type { Interaction } from '@simforge-oss/scenario';
import { describe, expect, it } from 'vitest';
import {
  emptyTimedRouteIssues,
  isSimpleModeEngineIssueSuppressed,
  SIMPLE_MODE_SUPPRESSED_ENGINE_ISSUE_CODES,
} from './authoring-validation';

describe('Simple-mode engine issue policy', () => {
  it('suppresses only the three canonical engine findings', () => {
    for (const code of SIMPLE_MODE_SUPPRESSED_ENGINE_ISSUE_CODES) {
      expect(isSimpleModeEngineIssueSuppressed(code)).toBe(true);
    }
    expect(isSimpleModeEngineIssueSuppressed('route_disconnected')).toBe(false);
    expect(isSimpleModeEngineIssueSuppressed(undefined)).toBe(false);
  });
});

describe('emptyTimedRouteIssues', () => {
  it('reports each empty custom route using the editor actor name', () => {
    const interactions: Interaction[] = [{
      id: 'route-1',
      actor: 'car-1',
      trigger: { kind: 'at', t: 0 },
      verb: 'route',
      target: { mode: 'customTimedRoute', points: [] },
    }];

    expect(emptyTimedRouteIssues(interactions, { 'car-1': 'Fire truck 1' })).toEqual([{
      id: 'timed-route-empty:route-1',
      severity: 'error',
      title: 'Custom timed route has no points',
      detail: "Fire truck 1's custom timed route needs at least one point before it can be previewed.",
      solution: 'Open the route, add its first point on the map, then run the preview again.',
    }]);
  });

  it('ignores populated custom routes and other route modes', () => {
    const interactions: Interaction[] = [
      {
        id: 'route-1',
        actor: 'car-1',
        trigger: { kind: 'at', t: 0 },
        verb: 'route',
        target: { mode: 'customTimedRoute', points: [{ timeS: 0, x: 0, z: 0 }] },
      },
      {
        id: 'route-2',
        actor: 'car-2',
        trigger: { kind: 'at', t: 0 },
        verb: 'route',
        target: { mode: 'lanePath', lanes: ['lane-1'] },
      },
    ];

    expect(emptyTimedRouteIssues(interactions)).toEqual([]);
  });
});
