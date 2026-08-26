/**
 * BEV raster sanity: geometry, channel semantics, ego-centric frame, and the
 * observation builders' contracts.
 */
import { describe, expect, it } from 'vitest';

import type { SimScenarioInput } from '@simforge-oss/engine';

import { BevRasterBuilder, ObjectListBuilder, StateVectorBuilder, STATE_VECTOR_SIZE } from '../observations.js';
import { DEFAULT_BEV_CONFIG, DEFAULT_OBSERVATION_CONFIG } from '../types.js';
import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, vehicle } from '../fixture.js';
import { EnvSession } from '../session.js';

const graph = syntheticGraph();

function twoCarScenario(): SimScenarioInput {
  return scenario(graph, {
    physics: { mode: 'kinematic-v1' },
    metricSubject: 'ego',
    clipSeconds: 4,
    warmupSeconds: 1,
    actors: [
      vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 10, cruiseSpeedMps: 10 }),
      vehicle(graph, { id: 'other', rsl: LANE_RIGHT, s: 40, speedMps: 8, cruiseSpeedMps: 8 }),
    ],
  });
}

describe('BEV raster', () => {
  it('has consistent shape and per-channel occupancy', () => {
    const env = new EnvSession({
      input: twoCarScenario(),
      graph,
      episode: { decisionHz: 10, observation: { bev: {} } },
    });
    env.reset('bev-shape');
    const result = env.step({});
    const bev = result.observation.bev!;
    expect(bev.channels).toBe(3);
    expect(bev.width).toBe(Math.round((2 * DEFAULT_BEV_CONFIG.halfWidthM) / bev.resolutionM));
    expect(bev.height).toBe(
      Math.round((DEFAULT_BEV_CONFIG.forwardM + DEFAULT_BEV_CONFIG.backwardM) / bev.resolutionM),
    );
    expect(bev.data.length).toBe(bev.width * bev.height * bev.channels);

    let actorCells = 0;
    let roadCells = 0;
    for (let i = 0; i < bev.width * bev.height; i++) {
      if (bev.data[i * bev.channels + 0]! > 0) roadCells += 1;
      if (bev.data[i * bev.channels + 2]! > 0) actorCells += 1;
    }
    expect(actorCells).toBeGreaterThan(0);
    // Two cars on a two-lane road: a meaningful strip of surface is drawn.
    expect(roadCells).toBeGreaterThan(bev.width * 4);
  });

  it('keeps the ego-centric frame: road directly ahead is the ego lane', () => {
    const env = new EnvSession({
      input: twoCarScenario(),
      graph,
      episode: { decisionHz: 10, observation: { bev: {} } },
    });
    env.reset('bev-frame');
    const bev = env.step({}).observation.bev!;
    const midRow = Math.floor(DEFAULT_BEV_CONFIG.forwardM / bev.resolutionM / 2);
    const midCol = Math.floor(bev.width / 2);
    // Directly ahead of the ego is its OWN lane: the ego-lane indicator.
    expect(bev.data[(midRow * bev.width + midCol) * bev.channels + 1]!).toBe(1);
    // One lane over (~3.5 m right of the ego lane centre) the generic road
    // surface channel carries the neighbouring lane.
    const neighbourCol = midCol - Math.round(3.5 / bev.resolutionM);
    expect(bev.data[(midRow * bev.width + neighbourCol) * bev.channels]!).toBe(1);
    // The ego lane indicator (channel 1) is set somewhere on its own lane.
    let egoLaneCells = 0;
    for (let i = 0; i < bev.width * bev.height; i++) {
      if (bev.data[i * bev.channels + 1]! > 0) egoLaneCells += 1;
    }
    expect(egoLaneCells).toBeGreaterThan(0);
  });
});

describe('state vector', () => {
  it('reports pose, kinematics, lateral state and nearest range', () => {
    const env = new EnvSession({ input: twoCarScenario(), graph, episode: { decisionHz: 10 } });
    const first = env.reset();
    const v = first.observation.stateVector!;
    expect(v.length).toBe(STATE_VECTOR_SIZE);
    // Ego starts at s=20 on y=0 heading east; the warm-up prologue moved it.
    expect(v[0]!).toBeGreaterThan(20);
    expect(v[1]!).toBeCloseTo(0, 6);
    expect(v[2]!).toBeCloseTo(1, 9); // cos(0)
    expect(v[3]!).toBeCloseTo(0, 9); // sin(0)
    expect(v[4]!).toBeCloseTo(10, 1);
    // Nearest other actor: 20 m ahead, one lane over.
    expect(v[9]!).toBeGreaterThan(15);
    expect(v[9]!).toBeLessThan(30);
  });
});

describe('object list', () => {
  it('gates by range and reports LOS with sorted deterministic order', () => {
    const env = new EnvSession({
      input: twoCarScenario(),
      graph,
      episode: { decisionHz: 10, observation: { objectListRangeM: 25 } },
    });
    env.reset();
    const objects = env.step({}).observation.objects;
    expect(objects.length).toBeGreaterThan(0);
    for (let i = 1; i < objects.length; i++) {
      expect(objects[i - 1]!.rangeM).toBeLessThanOrEqual(objects[i]!.rangeM);
    }
    expect(objects.every((o) => o.rangeM <= 25)).toBe(true);
    expect(typeof objects[0]!.lineOfSight).toBe('boolean');
  });

  it('applies declared sensor apertures when present', () => {
    const sensorScenario = scenario(graph, {
      physics: { mode: 'kinematic-v1' },
      metricSubject: 'ego',
      clipSeconds: 4,
      warmupSeconds: 1,
      actors: [
        {
          ...vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 10 }),
          sensors: [
            {
              id: 'cam',
              mount: { position: { x: 0, y: 0, z: 1.2 } },
              type: 'dash_camera' as const,
              aperture: { horizontalFovDeg: 40, verticalFovDeg: 30, nearM: 0.05, farM: 30 },
            },
          ],
        },
        vehicle(graph, { id: 'behind', rsl: LANE_LEFT, s: 5, speedMps: 10 }),
        vehicle(graph, { id: 'ahead', rsl: LANE_LEFT, s: 45, speedMps: 10 }),
      ],
    } as never);
    const env = new EnvSession({ input: sensorScenario, graph, episode: { decisionHz: 10 } });
    env.reset();
    const objects = env.step({}).observation.objects;
    const ids = objects.map((o) => o.id);
    // The camera looks forward only: the trailing car must be gated out.
    expect(ids).toContain('ahead');
    expect(ids).not.toContain('behind');
  });
});
