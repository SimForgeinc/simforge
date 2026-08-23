/**
 * Localised surface conditions.
 *
 * `operationalConditions.effects.frictionScale` is scene-wide: it can only make
 * the entire world slippery. "Black ice on the bend", "a flooded dip", "wet
 * leaves under the trees" are all the same shape of thing — a *region* of the
 * corridor with different grip — and none of them is expressible with one
 * scalar. These tests pin the per-actor-per-tick behaviour: outside the patch
 * the tyres deliver the dry ceiling, inside it they do not.
 */

import { describe, expect, it } from 'vitest';

import { SURFACE_KIND_FRICTION_SCALE, SurfaceField } from '../environment.js';
import { parseSimScenarioInput, type SimScenarioInputSpec } from '../schema/input.js';
import { runSimulation } from '../sim/engine.js';
import { LANE_LEFT, LANE_RIGHT, poseOnLane, syntheticGraph } from './fixtures/scenarios.js';

const graph = syntheticGraph();
const START_S = 20;
const CRUISE_MPS = 22;
/** The ego is 54 m inside the patch by the time it brakes. */
const PATCH = { kind: 'laneWindow' as const, rsl: LANE_LEFT, sMin: 120, sMax: 400 };
const BRAKE_AT_S = 7.0;
const DT = 0.02;

type Patch = NonNullable<SimScenarioInputSpec['surfacePatches']>[number];

function brakingRun(surfacePatches: Patch[], rsl: string = LANE_LEFT) {
  const input = parseSimScenarioInput({
    mapId: 'synthetic-straight',
    clipSeconds: 40,
    warmupSeconds: 0,
    dt: DT,
    seed: 'surface',
    physics: { mode: 'dynamic-v1' },
    actors: [{
      id: 'ego',
      kind: 'car',
      initial: {
        laneRef: { rsl, s: START_S, tFrac: 0 },
        pose: poseOnLane(graph, rsl, START_S),
        speedMps: CRUISE_MPS,
      },
      behavior: {
        route: { kind: 'follow' as const, startRsl: rsl, turns: [], maxLengthM: 2000 },
        cruiseSpeedMps: CRUISE_MPS,
      },
    }],
    interactions: [{
      id: 'emergency-stop',
      actorId: 'ego',
      trigger: { kind: 'at' as const, t: BRAKE_AT_S },
      verb: 'speed' as const,
      target: { mode: 'stop' as const },
      dynamics: { shape: 'step' as const, constraint: 'time' as const, value: 0.01 },
    }],
    surfacePatches,
  });
  const { trace } = runSimulation(input, { graph, guards: 'collect' });
  const ticks = trace.ticks.actors.ego!;
  const brakeIndex = trace.ticks.t.findIndex((t) => t >= BRAKE_AT_S);
  const stopIndex = ticks.speedMps.findIndex((v, i) => i >= brakeIndex && v <= 0.05);
  return {
    stopped: stopIndex >= 0,
    stoppingDistanceM: (stopIndex < 0 ? ticks.s.at(-1)! : ticks.s[stopIndex]!) - ticks.s[brakeIndex]!,
    peakDecelMps2: Math.max(...ticks.speedMps
      .slice(brakeIndex, stopIndex < 0 ? undefined : stopIndex)
      .map((v, i, arr) => (i === 0 ? 0 : (arr[i - 1]! - v) / DT))),
  };
}

describe('localised surface patches', () => {
  it('needs far more stopping distance inside an ice patch than on dry asphalt', () => {
    const dry = brakingRun([]);
    const iced = brakingRun([{ id: 'black-ice', kind: 'ice' as const, region: PATCH }]);

    expect(dry.stopped).toBe(true);
    expect(iced.stopped).toBe(true);
    // Dry ~41.9 m at a 7.51 m/s^2 peak; iced ~200.7 m at 1.22 m/s^2.
    expect(iced.peakDecelMps2).toBeLessThan(dry.peakDecelMps2 * 0.3);
    expect(iced.stoppingDistanceM).toBeGreaterThan(dry.stoppingDistanceM * 3);
  });

  it('leaves grip untouched outside the patch', () => {
    const dry = brakingRun([]);
    // The same ice, moved behind the ego. Nothing about the braking changes.
    const behind = brakingRun([{
      id: 'black-ice',
      kind: 'ice' as const,
      region: { kind: 'laneWindow' as const, rsl: LANE_LEFT, sMin: 0, sMax: 10 },
    }]);
    expect(behind.stoppingDistanceM).toBeCloseTo(dry.stoppingDistanceM, 6);
    expect(behind.peakDecelMps2).toBeCloseTo(dry.peakDecelMps2, 6);
  });

  it('does not leak grip into the neighbouring carriageway', () => {
    const dry = brakingRun([], LANE_RIGHT);
    const iced = brakingRun([{ id: 'black-ice', kind: 'ice' as const, region: PATCH }], LANE_RIGHT);
    expect(iced.stoppingDistanceM).toBeCloseTo(dry.stoppingDistanceM, 6);
  });

  it('scales the severity with the covering rather than hard-coding one hazard', () => {
    const dry = brakingRun([]);
    const gravel = brakingRun([{ id: 'p', kind: 'loose_gravel' as const, region: PATCH }]);
    const leaves = brakingRun([{ id: 'p', kind: 'wet_leaves' as const, region: PATCH }]);
    const ice = brakingRun([{ id: 'p', kind: 'ice' as const, region: PATCH }]);
    expect(dry.stoppingDistanceM)
      .toBeLessThan(gravel.stoppingDistanceM);
    expect(gravel.stoppingDistanceM).toBeLessThan(leaves.stoppingDistanceM);
    expect(leaves.stoppingDistanceM).toBeLessThan(ice.stoppingDistanceM);
  });

  it('lets the exact coefficient be authored when the study is about the number', () => {
    const named = brakingRun([{ id: 'p', kind: 'ice' as const, region: PATCH }]);
    const explicit = brakingRun([{
      id: 'p', kind: 'ice' as const, region: PATCH, frictionScale: SURFACE_KIND_FRICTION_SCALE.ice,
    }]);
    expect(explicit.stoppingDistanceM).toBeCloseTo(named.stoppingDistanceM, 6);

    const milder = brakingRun([{ id: 'p', kind: 'ice' as const, region: PATCH, frictionScale: 0.45 }]);
    expect(milder.stoppingDistanceM).toBeLessThan(named.stoppingDistanceM);
    expect(milder.stoppingDistanceM).toBeGreaterThan(brakingRun([]).stoppingDistanceM);
  });
});

describe('the surface field itself', () => {
  const at = (x: number) => ({ position: { x, y: 0 }, lane: { rsl: LANE_LEFT, laneS: x } });

  it('is the scene baseline where nothing covers the road', () => {
    const field = new SurfaceField(0.72, []);
    expect(field.isUniform).toBe(true);
    expect(field.frictionScaleAt(at(50))).toBe(0.72);
    expect(field.worstFrictionScale).toBe(0.72);
  });

  it('tapers into a patch over the declared distance instead of stepping', () => {
    const patch = {
      id: 'flooded-dip',
      kind: 'standing_water' as const,
      region: { kind: 'laneWindow' as const, rsl: LANE_LEFT, sMin: 100, sMax: 200 },
      edgeTaperM: 10,
    };
    const field = new SurfaceField(1, [patch]);
    expect(field.frictionScaleAt(at(99))).toBe(1);
    // 5 m in: half blended between 1 and 0.5.
    expect(field.frictionScaleAt(at(105))).toBeCloseTo(0.75, 9);
    expect(field.frictionScaleAt(at(110))).toBeCloseTo(0.5, 9);
    expect(field.frictionScaleAt(at(150))).toBeCloseTo(0.5, 9);
    expect(field.frictionScaleAt(at(195))).toBeCloseTo(0.75, 9);
    expect(field.frictionScaleAt(at(201))).toBe(1);
  });

  it('is a hard edge by default, because a sheet of ice has one', () => {
    const field = new SurfaceField(1, [{
      id: 'ice', kind: 'ice' as const,
      region: { kind: 'laneWindow' as const, rsl: LANE_LEFT, sMin: 100, sMax: 200 },
      edgeTaperM: 0,
    }]);
    expect(field.frictionScaleAt(at(99.99))).toBe(1);
    expect(field.frictionScaleAt(at(100.01))).toBeCloseTo(0.15, 9);
  });

  it('resolves overlaps by largest deviation, in either direction and in any order', () => {
    const ice = {
      id: 'ice', kind: 'ice' as const,
      region: { kind: 'laneWindow' as const, rsl: LANE_LEFT, sMin: 0, sMax: 300 }, edgeTaperM: 0,
    };
    const grit = {
      id: 'grit', kind: 'grit_treated' as const,
      region: { kind: 'laneWindow' as const, rsl: LANE_LEFT, sMin: 100, sMax: 200 }, edgeTaperM: 0,
    };
    // Ice deviates 0.85 from dry; a gritted strip deviates 0.15. Ice wins.
    expect(new SurfaceField(1, [ice, grit]).frictionScaleAt(at(150))).toBeCloseTo(0.15, 9);
    expect(new SurfaceField(1, [grit, ice]).frictionScaleAt(at(150))).toBeCloseTo(0.15, 9);
    // In a snowfield the gritted strip is the larger deviation, so grip improves.
    const snowy = new SurfaceField(0.3, [grit]);
    expect(snowy.frictionScaleAt(at(150))).toBeCloseTo(1.15, 9);
    expect(snowy.frictionScaleAt(at(50))).toBeCloseTo(0.3, 9);
  });

  it('answers circle and polygon regions in the engine frame', () => {
    // Scene points are (x, z) with z = -y; the field must flip them like everything else.
    const field = new SurfaceField(1, [{
      id: 'spill', kind: 'spilled_oil' as const,
      region: { kind: 'circle' as const, center: { x: 10, z: -4 }, radiusM: 5 },
      edgeTaperM: 0,
    }]);
    expect(field.frictionScaleAt({ position: { x: 10, y: 4 }, lane: null })).toBeCloseTo(0.25, 9);
    expect(field.frictionScaleAt({ position: { x: 10, y: -4 }, lane: null })).toBe(1);

    const poly = new SurfaceField(1, [{
      id: 'leaves', kind: 'wet_leaves' as const,
      region: {
        kind: 'polygon' as const,
        points: [{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: -10 }, { x: 0, z: -10 }],
      },
      edgeTaperM: 0,
    }]);
    expect(poly.frictionScaleAt({ position: { x: 10, y: 5 }, lane: null })).toBeCloseTo(0.45, 9);
    expect(poly.frictionScaleAt({ position: { x: 10, y: -5 }, lane: null })).toBe(1);
  });

  it('reports the worst grip anywhere, for the friction ceiling', () => {
    const field = new SurfaceField(0.72, [
      { id: 'a', kind: 'wet_leaves' as const, region: PATCH, edgeTaperM: 0 },
      { id: 'b', kind: 'ice' as const, region: PATCH, edgeTaperM: 0 },
    ]);
    expect(field.worstFrictionScale).toBeCloseTo(0.15, 9);
    expect(field.ids()).toEqual(['a', 'b']);
  });
});
