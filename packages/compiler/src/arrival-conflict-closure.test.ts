import { describe, expect, it } from 'vitest';

import { Route } from '@simforge-oss/engine';

import { closeArrivalConflict } from './materialize.js';

describe('arrival conflict closure', () => {
  it('accepts a declared conflict shared by the final executed paths', () => {
    const eastbound = Route.fromPolyline([{ x: -20, y: 0 }, { x: 20, y: 0 }]);
    const northbound = Route.fromPolyline([{ x: 0, y: -20 }, { x: 0, y: 20 }]);

    const closure = closeArrivalConflict({ x: 0, y: 0 }, eastbound, northbound, 1.9, 1.9);

    expect(closure.closed).toBe(true);
    expect(closure.aDistanceM).toBeLessThan(1e-3);
    expect(closure.bDistanceM).toBeLessThan(1e-3);
    expect(closure.pathSeparationM).toBeLessThan(1e-3);
  });

  it('rejects a matcher point when a final rebound route never approaches it', () => {
    const egoTurn = Route.fromPolyline([{ x: -20, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 20 }]);
    const oncomingElsewhere = Route.fromPolyline([{ x: 40, y: -20 }, { x: 40, y: 20 }]);

    const closure = closeArrivalConflict({ x: 0, y: 0 }, egoTurn, oncomingElsewhere, 1.9, 1.9);

    expect(closure.closed).toBe(false);
    expect(closure.bDistanceM).toBeGreaterThan(30);
    expect(closure.pathSeparationM).toBeGreaterThan(30);
  });
});
