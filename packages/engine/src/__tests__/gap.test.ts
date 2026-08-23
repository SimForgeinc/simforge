/**
 * `gap(actor, value, time|distance, dyn)` — the car-following verb behind C1
 * (car following) and every queue archetype.
 *
 * The scenarios below give the follower a higher cruise speed than the leader
 * so it has authority to *acquire* the commanded gap inside the clip; the
 * assertions are on the settled tail, not the transient.
 */

import { describe, expect, it } from 'vitest';
import { runSimulation } from '../sim/engine.js';
import { scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';

const graph = syntheticGraph();
const CAR_LENGTH = 4.5;

function sampleAt(trace: ReturnType<typeof runSimulation>['trace'], t: number): number {
  return trace.ticks.t.findIndex((v) => v >= t - 1e-9);
}

function bumperGap(
  trace: ReturnType<typeof runSimulation>['trace'],
  follower: string,
  leader: string,
  i: number,
): number {
  return trace.ticks.actors[leader]!.x[i]! - trace.ticks.actors[follower]!.x[i]! - CAR_LENGTH;
}

describe('gap controller', () => {
  it('holds a 2.0 s time gap to within 5 %', () => {
    const input = scenario(graph, {
      actors: [
        vehicle(graph, { id: 'lead', s: 150, speedMps: 12, cruiseSpeedMps: 12 }),
        vehicle(graph, { id: 'follow', s: 60, speedMps: 16, cruiseSpeedMps: 16 }),
      ],
      interactions: [
        {
          id: 'keep-gap',
          actorId: 'follow',
          trigger: { kind: 'at', t: 0 },
          verb: 'gap',
          target: { actorId: 'lead' },
          value: 2.0,
          mode: 'time',
          dynamics: { shape: 'linear', constraint: 'time', value: 4 },
        },
      ],
    });
    const { trace } = runSimulation(input, { graph });
    for (const t of [16, 18, 20]) {
      const i = sampleAt(trace, t);
      const headway = bumperGap(trace, 'follow', 'lead', i) / trace.ticks.actors['follow']!.speedMps[i]!;
      expect(Math.abs(headway - 2.0)).toBeLessThan(0.1); // ±5 %
    }
  });

  it('holds a distance gap in metres', () => {
    const input = scenario(graph, {
      actors: [
        vehicle(graph, { id: 'lead', s: 150, speedMps: 12, cruiseSpeedMps: 12 }),
        vehicle(graph, { id: 'follow', s: 60, speedMps: 16, cruiseSpeedMps: 16 }),
      ],
      interactions: [
        {
          id: 'keep-gap',
          actorId: 'follow',
          trigger: { kind: 'at', t: 0 },
          verb: 'gap',
          target: { actorId: 'lead' },
          value: 30,
          mode: 'distance',
          dynamics: { shape: 'cubic', constraint: 'time', value: 5 },
        },
      ],
    });
    const { trace } = runSimulation(input, { graph });
    expect(bumperGap(trace, 'follow', 'lead', trace.ticks.t.length - 1)).toBeCloseTo(30, 0);
  });

  it('aggression tightens the accepted gap', () => {
    const run = (aggression: number) => {
      const input = scenario(graph, {
        actors: [
          vehicle(graph, { id: 'lead', s: 150, speedMps: 12, cruiseSpeedMps: 12 }),
          vehicle(graph, {
            id: 'follow',
            s: 60,
            speedMps: 16,
            cruiseSpeedMps: 16,
            rules: { aggression },
          }),
        ],
        interactions: [
          {
            id: 'keep-gap',
            actorId: 'follow',
            trigger: { kind: 'at', t: 0 },
            verb: 'gap',
            target: { actorId: 'lead' },
            value: 2.0,
            mode: 'time',
            dynamics: { shape: 'linear', constraint: 'time', value: 4 },
          },
        ],
      });
      const { trace } = runSimulation(input, { graph });
      return bumperGap(trace, 'follow', 'lead', trace.ticks.t.length - 1);
    };
    expect(run(1.0)).toBeLessThan(run(0.5));
    expect(run(0.5)).toBeLessThan(run(0.0));
  }, 10_000);
});
