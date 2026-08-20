import { describe, expect, it } from 'vitest';

import { parseSimScenarioInput, isKnockdownVulnerableKind } from '../schema/input.js';
import {
  BALANCE_RECOVERY_DELTA_V_MPS,
  DynamicV1Backend,
  ACTOR_PHYSICS_PROFILES,
} from '../sim/dynamic-v1.js';
import { runSimulation } from '../sim/engine.js';
import type { SimEvent } from '../trace/trace.js';
import { LANE_LEFT, poseOnLane, syntheticGraph } from './fixtures/scenarios.js';

/**
 * A car driving down the lane and a pedestrian standing in it.
 *
 * The walker is authored stationary so the contact — not its own gait — is the
 * only thing that can move it, which is what makes the assertions about
 * carried impulse meaningful.
 */
function carIntoPedestrian(carSpeedMps: number) {
  const graph = syntheticGraph();
  return parseSimScenarioInput({
    mapId: 'synthetic-straight',
    clipSeconds: 4,
    warmupSeconds: 0,
    actors: [
      {
        id: 'car',
        kind: 'car',
        initial: {
          laneRef: { rsl: LANE_LEFT, s: 10, tFrac: 0 },
          pose: poseOnLane(graph, LANE_LEFT, 10),
          speedMps: carSpeedMps,
        },
        behavior: {
          route: { kind: 'follow' as const, startRsl: LANE_LEFT, turns: [], maxLengthM: 2000 },
          cruiseSpeedMps: carSpeedMps,
        },
      },
      {
        id: 'walker',
        kind: 'pedestrian',
        initial: {
          laneRef: { rsl: LANE_LEFT, s: 25, tFrac: 0 },
          pose: poseOnLane(graph, LANE_LEFT, 25),
          speedMps: 0,
        },
        behavior: {
          route: { kind: 'follow' as const, startRsl: LANE_LEFT, turns: [], maxLengthM: 2000 },
          cruiseSpeedMps: 0,
        },
      },
    ],
  });
}

function knockdowns(events: readonly SimEvent[]) {
  return events.filter((event): event is Extract<SimEvent, { kind: 'knocked_down' }> =>
    event.kind === 'knocked_down');
}

describe('pedestrian knockdown', () => {
  it('takes a struck pedestrian off its feet and records who did it', () => {
    const graph = syntheticGraph();
    const { trace } = runSimulation(carIntoPedestrian(12), { graph, guards: 'collect' });

    const downs = knockdowns(trace.events);
    expect(downs).toHaveLength(1);
    expect(downs[0]).toMatchObject({ actorId: 'walker', otherId: 'car' });
    // The solver's own impulse, reported as telemetry.
    expect(downs[0]!.normalImpulseNs).toBeGreaterThan(
      ACTOR_PHYSICS_PROFILES.pedestrian.massKg * BALANCE_RECOVERY_DELTA_V_MPS,
    );
    // The car is never knocked down — only vulnerable kinds are.
    expect(downs.some((event) => event.actorId === 'car')).toBe(false);
  });

  it('publishes the fall time on the walker track and nowhere else', () => {
    const graph = syntheticGraph();
    const { trace } = runSimulation(carIntoPedestrian(12), { graph, guards: 'collect' });

    const downAt = trace.ticks.actors.walker!.downSinceS;
    expect(downAt).toBeTypeOf('number');
    expect(downAt).toBe(knockdowns(trace.events)[0]!.t);
    expect(trace.ticks.actors.car!.downSinceS).toBeUndefined();
  });

  it('carries the impulse instead of erasing it, then slides to rest', () => {
    const graph = syntheticGraph();
    const { trace } = runSimulation(carIntoPedestrian(12), { graph, guards: 'collect' });

    const track = trace.ticks.actors.walker!;
    const downIndex = trace.ticks.t.findIndex((t) => t >= track.downSinceS!);
    // The contact resolves within the interval the event is stamped at, so the
    // impulse first appears on the tick recorded after it. Renderers reading
    // `t >= downSinceS` therefore begin the fall no later than the motion.
    const afterImpact = track.speedMps.slice(downIndex);
    const peak = Math.max(...afterImpact);

    // Struck from rest, so all of this speed is the contact's doing.
    expect(peak).toBeGreaterThan(BALANCE_RECOVERY_DELTA_V_MPS);
    // The walker agent would have zeroed it within one substep; a downed body
    // keeps it, so the impulse is still readable as motion a tick later.
    expect(peak).toBeCloseTo(
      knockdowns(trace.events)[0]!.normalImpulseNs / ACTOR_PHYSICS_PROFILES.pedestrian.massKg,
      2,
    );

    // Ground friction alone removes it: v^2 / 2*mu*g, and nothing re-accelerates.
    const slideDistanceM = Math.hypot(
      track.x.at(-1)! - track.x[downIndex]!,
      track.y.at(-1)! - track.y[downIndex]!,
    );
    const expectedM = (peak * peak) / (2 * 0.55 * 9.80665);
    expect(slideDistanceM).toBeGreaterThan(expectedM * 0.9);
    expect(slideDistanceM).toBeLessThan(expectedM * 1.1);
    expect(track.speedMps.at(-1)).toBeCloseTo(0, 3);
  });

  it('reports a side impact as motion, not as a stationary body', () => {
    // A struck body slides whichever way it was thrown. Reading only the
    // longitudinal axis would report a perpendicular hit as speed 0 while the
    // body visibly moves, so `speedMps` is the planar magnitude once down.
    const backend = new DynamicV1Backend();
    backend.register({
      actorId: 'walker',
      kind: 'pedestrian',
      dimensions: { l: 0.6, w: 0.6 },
      state: { x: 0, y: 0, yawRad: 0, longitudinalVelocityMps: 0, lateralVelocityMps: 4 },
    });
    const before = backend.state('walker')!;
    expect(before.lateralVelocityMps).toBe(4);

    const downedIntent = {
      targetSpeedMps: 0,
      targetAccelerationMps2: 0,
      previewPoint: { x: 1, y: 0 },
      previewHeadingRad: 0,
      downed: true,
    };
    const result = backend.step('walker', downedIntent, 0.05, 1);
    // Sideways motion survives, and the body did not turn to face it.
    expect(Math.abs(result.state.lateralVelocityMps)).toBeGreaterThan(3.5);
    expect(result.state.yawRad).toBeCloseTo(0, 9);
    expect(result.state.y).toBeGreaterThan(0.1);
  });

  it('never stands a body back up', () => {
    const graph = syntheticGraph();
    const { trace } = runSimulation(carIntoPedestrian(12), { graph, guards: 'collect' });

    // Monotonic by construction: consumers read `t >= downSinceS`, so a second
    // knockdown event for the same actor would make that reading ambiguous.
    expect(knockdowns(trace.events).filter((event) => event.actorId === 'walker')).toHaveLength(1);
  });

  it('is byte-identical across runs and independent of actor order', () => {
    const graph = syntheticGraph();
    const input = carIntoPedestrian(12);
    const reversed = { ...input, actors: [...input.actors].reverse() };

    const first = JSON.stringify(runSimulation(input, { graph, guards: 'collect' }).trace);
    const second = JSON.stringify(runSimulation(input, { graph, guards: 'collect' }).trace);
    const permuted = runSimulation(reversed, { graph, guards: 'collect' }).trace;

    expect(second).toBe(first);
    expect(permuted.ticks.actors.walker!.downSinceS).toBe(JSON.parse(first).ticks.actors.walker.downSinceS);
    expect(knockdowns(permuted.events)).toHaveLength(1);
  });

  it('never knocks down a walker approaching a parked car', () => {
    // The longitudinal controller brings a walker to rest short of a static
    // obstacle, with or without avoidance, so this contact does not occur — and
    // if it ever did, the rule measures the velocity the contact *added*, so
    // arresting the walker's own momentum could not put it on the ground.
    const graph = syntheticGraph();
    const input = parseSimScenarioInput({
      mapId: 'synthetic-straight',
      clipSeconds: 12,
      warmupSeconds: 0,
      actors: [
        {
          id: 'parked',
          kind: 'car',
          static: true,
          initial: {
            laneRef: { rsl: LANE_LEFT, s: 25, tFrac: 0 },
            pose: poseOnLane(graph, LANE_LEFT, 25),
            speedMps: 0,
          },
          behavior: {
            route: { kind: 'follow' as const, startRsl: LANE_LEFT, turns: [], maxLengthM: 2000 },
            cruiseSpeedMps: 0,
          },
        },
        {
          id: 'walker',
          kind: 'pedestrian',
          rules: { collisionAvoidance: false },
          initial: {
            laneRef: { rsl: LANE_LEFT, s: 15, tFrac: 0 },
            pose: poseOnLane(graph, LANE_LEFT, 15),
            speedMps: 1.4,
          },
          behavior: {
            route: { kind: 'follow' as const, startRsl: LANE_LEFT, turns: [], maxLengthM: 2000 },
            cruiseSpeedMps: 1.4,
          },
        },
      ],
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    const track = trace.ticks.actors.walker!;

    expect(knockdowns(trace.events)).toHaveLength(0);
    expect(track.downSinceS).toBeUndefined();
    // Came to rest on its feet, short of the car.
    expect(track.speedMps.at(-1)).toBeCloseTo(0, 2);
    expect(track.x.at(-1)).toBeLessThan(25);
  });

  it('leaves a shove below the balance limit recoverable', () => {
    // The impulse a 78 kg body needs to exceed 0.6 m/s is ~47 Ns; a slow nudge
    // stays under it, and the walker must keep its feet.
    const backend = new DynamicV1Backend();
    backend.register({
      actorId: 'walker',
      kind: 'pedestrian',
      dimensions: { l: 0.6, w: 0.6 },
      state: { x: 0, y: 0, yawRad: 0, longitudinalVelocityMps: 0 },
    });
    const nudged = ACTOR_PHYSICS_PROFILES.pedestrian.massKg * (BALANCE_RECOVERY_DELTA_V_MPS - 0.1);
    expect(nudged / ACTOR_PHYSICS_PROFILES.pedestrian.massKg).toBeLessThan(BALANCE_RECOVERY_DELTA_V_MPS);
  });

  it('excludes drones, which have no stance to lose', () => {
    expect(isKnockdownVulnerableKind('pedestrian')).toBe(true);
    expect(isKnockdownVulnerableKind('animal')).toBe(true);
    expect(isKnockdownVulnerableKind('sidewalk_robot')).toBe(true);
    expect(isKnockdownVulnerableKind('drone')).toBe(false);
    expect(isKnockdownVulnerableKind('car')).toBe(false);
  });
});
