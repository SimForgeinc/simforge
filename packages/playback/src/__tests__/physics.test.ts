import { describe, expect, it } from 'vitest';
import { parseSimScenarioInput } from '@simforge-oss/engine';
import {
  activePhysicsModeForTrace,
  physicsSummaryForAuthoredActors,
  physicsSummaryForTrace,
  withEditablePhysicsDefault,
} from '../physics';

describe('Studio physics migration', () => {
  const legacy = parseSimScenarioInput({
    actors: [{
      id: 'car', kind: 'car',
      initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0 },
      behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] } },
    }],
  });

  it('pins an omitted editable document to dynamic-v1 without mutating the source', () => {
    const migrated = withEditablePhysicsDefault(legacy);
    expect(legacy.physics).toBeUndefined();
    expect(migrated.physics).toEqual({ mode: 'dynamic-v1' });
    expect(withEditablePhysicsDefault(migrated)).toBe(migrated);
  });

  it('migrates an editable legacy pin and treats provenance-less evidence as kinematic', () => {
    const pinned = { ...legacy, physics: { mode: 'kinematic-v1' as const } };
    expect(withEditablePhysicsDefault(pinned)).toEqual({ ...pinned, physics: { mode: 'dynamic-v1' } });
    expect(activePhysicsModeForTrace({ header: {} } as never)).toBe('kinematic-v1');
    expect(activePhysicsModeForTrace(null)).toBe('dynamic-v1');
  });

  it('shows Dynamic for an ambient-only trace with a supported vehicle backend', () => {
    const trace = {
      header: {
        physics: {
          mode: 'dynamic-v1',
          actorBackends: {
            'ambient:v1:car': { mode: 'dynamic-v1', reason: 'selected' },
          },
        },
      },
    } as never;
    expect(activePhysicsModeForTrace(trace)).toBe('dynamic-v1');
    expect(physicsSummaryForTrace(trace)).toMatchObject({ dynamicCount: 1, fallbackCount: 0, legacyReplay: false });
  });

  it('classifies authored actors without changing authored data', () => {
    const actors = [
      { id: 'car', simulationKind: 'car', static: false, reverse: false },
      { id: 'ped', simulationKind: 'pedestrian', static: false, reverse: false },
      { id: 'parked', simulationKind: 'static_object', static: true, reverse: false },
      { id: 'reverse', simulationKind: 'car', static: false, reverse: true },
    ] as const;
    const before = JSON.stringify(actors);
    const summary = physicsSummaryForAuthoredActors(actors);
    expect(JSON.stringify(actors)).toBe(before);
    expect(summary).toMatchObject({ mode: 'dynamic-v1', dynamicCount: 3, staticCount: 1, fallbackCount: 0, unknownCount: 0 });
    expect(summary.actors.map(({ id, mode, reason }) => ({ id, mode, reason }))).toEqual([
      { id: 'car', mode: 'dynamic-v1', reason: 'selected' },
      { id: 'ped', mode: 'dynamic-v1', reason: 'selected' },
      { id: 'parked', mode: 'fixed-static-v1', reason: 'static-actor' },
      { id: 'reverse', mode: 'dynamic-v1', reason: 'selected' },
    ]);
  });

  it('keeps provenance-less immutable evidence visibly legacy', () => {
    expect(physicsSummaryForTrace({ header: { actorIds: ['car'] } })).toEqual({
      mode: 'kinematic-v1', legacyReplay: true, actors: [], dynamicCount: 0, staticCount: 0, fallbackCount: 0, unknownCount: 0,
    });
  });
});
