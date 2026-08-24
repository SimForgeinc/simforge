/**
 * A latent defect in the *pre-existing* declared-occlusion metric, found while
 * building the perception layer.
 *
 * `occludersForTick()` promotes every static actor to a line-of-sight blocker,
 * and the reveal-to-conflict monitor tests the segment between the observer's
 * and the target's centres against the relevant occluder set. When that set
 * contains a body that *is* one of the endpoints, the segment necessarily
 * crosses its footprint, so the sight line is reported blocked for the whole
 * clip and no reveal can ever be observed.
 *
 * Two reachable ways in:
 *   1. an `occlusionPair` with no `occluderId` (the schema allows it) whose
 *      target is a static actor — every occluder is relevant, including the
 *      target's own body;
 *   2. an explicit `occluderId: 'actor:<target>'`, which is what
 *      `role.extensions.occludes` lowers to when the declaration is written on
 *      the target's own role.
 *
 * These tests pin the defect so the fix is checkable. They are deliberately
 * about the *existing* metric, not the new perception channel.
 */

import { describe, expect, it } from 'vitest';

import { runSimulation } from '../../sim/engine.js';
import { parseSimScenarioInput } from '../../schema/input.js';
import { LANE_LEFT, poseOnLane, syntheticGraph, vehicle } from '../../__tests__/fixtures/scenarios.js';

function scenarioWith(occluderId: string | undefined) {
  const graph = syntheticGraph();
  const ego = vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 0, speedMps: 12, cruiseSpeedMps: 12 });
  const target: any = {
    id: 'target',
    kind: 'pedestrian',
    initial: { laneRef: { rsl: LANE_LEFT, s: 120, tFrac: 0 }, pose: poseOnLane(graph, LANE_LEFT, 120), speedMps: 0 },
    behavior: { route: { kind: 'follow', startRsl: LANE_LEFT, turns: [], maxLengthM: 400 }, cruiseSpeedMps: 0 },
    // Static: a kerbside body. This is what makes it an engine occluder.
    static: true,
  };
  const input = parseSimScenarioInput({
    mapId: 'synthetic-straight',
    clipSeconds: 15,
    warmupSeconds: 0,
    dt: 0.02,
    seed: 'self-occlusion',
    physics: { mode: 'kinematic-v1' },
    actors: [ego, target],
    // No occluding geometry at all: nothing stands between the two bodies.
    occluders: [],
    occlusionPairs: [{ observer: 'ego', target: 'target', ...(occluderId ? { occluderId } : {}) }],
  });
  return runSimulation(input, { graph, guards: 'skip' }).trace;
}

describe('declared occlusion: an endpoint must not occlude itself', () => {
  it('is currently reported blocked for the whole clip when the target is its own occluder', () => {
    const trace = scenarioWith('actor:target');
    const entry = trace.metrics.declaredOcclusion![0]!;
    expect(entry.relevantOccluderIds).toContain('actor:target');
    // Nothing physically stands between them, yet:
    expect(entry.firstBlockedT).toBe(0);
    expect(entry.losOpenT).toBeNull();
    expect(entry.status).not.toBe('revealed_before_conflict');
  });

  it('is currently reported blocked when no occluder is named and the target is static', () => {
    const trace = scenarioWith(undefined);
    const entry = trace.metrics.declaredOcclusion![0]!;
    expect(entry.relevantOccluderIds).toContain('actor:target');
    expect(entry.losOpenT).toBeNull();
  });

  it('the perception layer is not affected: neither endpoint occludes the segment', () => {
    // Same static target, seen through a declared sensor. The perception pass
    // filters both endpoints out of the occluder set, so line of sight is open
    // from t = 0 even though the target is a static body.
    const graph = syntheticGraph();
    const ego: any = vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 0, speedMps: 12, cruiseSpeedMps: 12 });
    ego.sensors = [{
      id: 'cam', type: 'dash_camera',
      mount: { position: { x: 1.8, y: 1.1, z: 0 } },
      aperture: { horizontalFovDeg: 90, verticalFovDeg: 60, nearM: 0.05, farM: 400 },
    }];
    const target: any = {
      id: 'target', kind: 'pedestrian',
      initial: { laneRef: { rsl: LANE_LEFT, s: 120, tFrac: 0 }, pose: poseOnLane(graph, LANE_LEFT, 120), speedMps: 0 },
      behavior: { route: { kind: 'follow', startRsl: LANE_LEFT, turns: [], maxLengthM: 400 }, cruiseSpeedMps: 0 },
      static: true,
    };
    const trace = runSimulation(
      parseSimScenarioInput({
        mapId: 'synthetic-straight', clipSeconds: 15, warmupSeconds: 0, dt: 0.02, seed: 'self-occlusion',
        physics: { mode: 'kinematic-v1' }, actors: [ego, target],
      }),
      { graph, guards: 'skip' },
    ).trace;
    expect(trace.metrics.perception!.sensors[0]!.firstLineOfSightT).toBe(0);
  });
});
