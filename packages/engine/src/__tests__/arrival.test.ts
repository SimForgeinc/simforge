/**
 * The arrival solver: back-solve the challenger's spawn so it reaches a
 * conflict point at a declared criticality relative to the reference actor.
 */

import { describe, expect, it } from 'vitest';
import { applyArrivalSolution, solveArrival, resolveArrivalTriggers } from '../solve/arrival.js';
import { runSimulation } from '../sim/engine.js';
import { nominalRun } from '../solve/nominal.js';
import { buildRoute } from '../map/route.js';
import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';

const graph = syntheticGraph();
/** The conflict point: 300 m along, between the two lanes. */
const CONFLICT = { x: 300, z: 1.75 };

function twoActor() {
  return scenario(graph, {
    metricSubject: 'ego',
    actors: [
      vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 10, speedMps: 14, cruiseSpeedMps: 14 }),
      vehicle(graph, { id: 'challenger', rsl: LANE_RIGHT, s: 10, speedMps: 10, cruiseSpeedMps: 10 }),
    ],
  });
}

describe('solveArrival', () => {
  it('hits a target TTC to within 0.05 s', () => {
    for (const ttc of [1.0, 1.5, 2.5]) {
      const result = solveArrival(
        twoActor(),
        { of: 'challenger', at: { kind: 'point', at: CONFLICT }, syncWith: 'ego', ttc },
        graph,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.solution.converged).toBe(true);
      expect(Math.abs(result.solution.achievedTtc - ttc)).toBeLessThan(0.05);
    }
  });

  it('deltaT is the same solve with the opposite sign', () => {
    const byTtc = solveArrival(
      twoActor(),
      { of: 'challenger', at: { kind: 'point', at: CONFLICT }, syncWith: 'ego', ttc: 1.5 },
      graph,
    );
    const byDelta = solveArrival(
      twoActor(),
      { of: 'challenger', at: { kind: 'point', at: CONFLICT }, syncWith: 'ego', deltaT: -1.5 },
      graph,
    );
    expect(byTtc.ok && byDelta.ok).toBe(true);
    if (!byTtc.ok || !byDelta.ok) return;
    expect(byDelta.solution.spawnS).toBeCloseTo(byTtc.solution.spawnS, 6);
  });

  it('converges to the 1 mm spawn tolerance deterministically', () => {
    const a = solveArrival(
      twoActor(),
      { of: 'challenger', at: { kind: 'point', at: CONFLICT }, syncWith: 'ego', ttc: 1.5 },
      graph,
    );
    const b = solveArrival(
      twoActor(),
      { of: 'challenger', at: { kind: 'point', at: CONFLICT }, syncWith: 'ego', ttc: 1.5 },
      graph,
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.solution.spawnS).toBe(b.solution.spawnS);
    expect(a.solution.iterations).toBe(b.solution.iterations);
  });

  it('the solved spawn really produces the requested nominal timing', () => {
    const input = twoActor();
    const result = solveArrival(
      input,
      { of: 'challenger', at: { kind: 'point', at: CONFLICT }, syncWith: 'ego', ttc: 1.5 },
      graph,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const egoRoute = buildRoute(graph, input.actors.find((a) => a.id === 'ego')!.behavior.route);
    const chRoute = buildRoute(graph, input.actors.find((a) => a.id === 'challenger')!.behavior.route);
    expect(egoRoute.ok && chRoute.ok).toBe(true);
    if (!egoRoute.ok || !chRoute.ok) return;

    const opts = { dt: input.dt, warmupSeconds: input.warmupSeconds, horizonSeconds: input.clipSeconds };
    const tEgo = nominalRun(
      graph,
      {
        kind: 'vehicle',
        route: egoRoute.route,
        startS: 10,
        initialSpeedMps: 14,
        speedFactor: 1,
        cruiseOverrideMps: 14,
      },
      egoRoute.route.projectPoint({ x: CONFLICT.x, y: -CONFLICT.z }).s,
      opts,
    ).tAtTarget!;
    const tCh = nominalRun(
      graph,
      {
        kind: 'vehicle',
        route: chRoute.route,
        startS: result.solution.spawnS,
        initialSpeedMps: 10,
        speedFactor: 1,
        cruiseOverrideMps: 10,
      },
      chRoute.route.projectPoint({ x: CONFLICT.x, y: -CONFLICT.z }).s,
      opts,
    ).tAtTarget!;
    expect(tEgo - tCh).toBeCloseTo(1.5, 1);
  });

  it('resolves a lane-offset arrival by exact reference-frame stations', () => {
    const result = solveArrival(
      twoActor(),
      {
        of: 'challenger',
        at: {
          kind: 'point',
          at: { x: 300, z: 3.5 },
          referenceFrame: {
            stations: [
              { rsl: LANE_LEFT, s: 300 },
              { rsl: LANE_RIGHT, s: 300 },
            ],
          },
        },
        syncWith: 'ego',
        ttc: 1.5,
      },
      graph,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.solution.converged).toBe(true);
    expect(Math.abs(result.solution.achievedTtc - 1.5)).toBeLessThan(0.05);
  });

  it('treats reference-frame stations as strict lane provenance, not a nearest-route hint', () => {
    const result = solveArrival(
      twoActor(),
      {
        of: 'challenger',
        at: {
          kind: 'point',
          // Geometrically close enough to the challenger lane to pass the
          // fallback, but semantically declared only on the ego lane.
          at: { x: 300, z: 1.75 },
          referenceFrame: { stations: [{ rsl: LANE_LEFT, s: 300 }] },
        },
        syncWith: 'ego',
        ttc: 1.5,
      },
      graph,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.code).toBe('arrival_unsolvable');
  });

  it('keeps parameterized lateral and heading placement when moving a solved spawn', () => {
    const input = twoActor();
    const challenger = input.actors.find((actor) => actor.id === 'challenger')!;
    const shifted = {
      ...input,
      actors: input.actors.map((actor) => actor.id === 'challenger'
        ? {
            ...actor,
            initial: {
              ...actor.initial,
              laneRef: { ...actor.initial.laneRef!, tFrac: 0.6 },
              pose: {
                ...actor.initial.pose,
                z: actor.initial.pose.z - 0.6 * 3.5,
                headingRad: actor.initial.pose.headingRad + 0.2,
              },
            },
          }
        : actor),
    };
    const moved = applyArrivalSolution(
      shifted,
      {
        interactionId: null,
        actorId: 'challenger',
        referenceActorId: 'ego',
        spawnDeltaS: 90,
        spawnS: 100,
        targetDeltaT: 0,
        achievedDeltaT: 0,
        achievedTtc: 0,
        fireTime: 0,
        iterations: 1,
        converged: true,
      },
      graph,
    );
    const actor = moved.actors.find((candidate) => candidate.id === 'challenger')!;
    expect(actor.initial.laneRef?.tFrac).toBe(0.6);
    expect(actor.initial.pose.x).toBeCloseTo(100, 6);
    expect(actor.initial.pose.z).toBeCloseTo(challenger.initial.pose.z - 0.6 * 3.5, 6);
    expect(actor.initial.pose.headingRad).toBeCloseTo(0.2, 6);
  });

  it('does not bind a geometric point to a merely nearby parallel road', () => {
    const result = solveArrival(
      twoActor(),
      { of: 'challenger', at: { kind: 'point', at: { x: 300, z: 7 } }, syncWith: 'ego', ttc: 1.5 },
      graph,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.code).toBe('arrival_unsolvable');
  });

  it('rejects an arrival point far enough away to be on another road', () => {
    const result = solveArrival(
      twoActor(),
      { of: 'challenger', at: { kind: 'point', at: { x: 300, z: -16 } }, syncWith: 'ego', ttc: 1.5 },
      graph,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.code).toBe('arrival_unsolvable');
  });
});

describe('arrival triggers', () => {
  it('resolve into fixed times and move the challenger’s spawn', () => {
    const base = twoActor();
    const input = {
      ...base,
      interactions: [
        {
          id: 'commit',
          actorId: 'challenger',
          trigger: {
            kind: 'arrival' as const,
            arrival: {
              of: 'challenger',
              at: { kind: 'point' as const, at: CONFLICT },
              syncWith: 'ego',
              ttc: 1.5,
            },
          },
          verb: 'set' as const,
          target: { key: 'rules.collisionAvoidance', value: false },
        },
      ],
    };
    const spawnBefore = input.actors.find((a) => a.id === 'challenger')!.initial.pose.x;
    const resolved = resolveArrivalTriggers(input, graph);
    expect(resolved.solutions).toHaveLength(1);
    expect(resolved.input.interactions[0]!.trigger.kind).toBe('at');
    const spawnAfter = resolved.input.actors.find((a) => a.id === 'challenger')!.initial.pose.x;
    expect(spawnAfter).not.toBeCloseTo(spawnBefore, 1);

    const { trace, arrival } = runSimulation(input, { graph, guards: 'collect' });
    expect(arrival).toHaveLength(1);
    const fired = trace.events.find((e) => e.kind === 'trigger_fired');
    expect(fired).toBeDefined();
    expect(fired!.t).toBeCloseTo(arrival[0]!.fireTime, 1);
  });
});
