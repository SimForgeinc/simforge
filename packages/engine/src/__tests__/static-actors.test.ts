import { describe, expect, it } from 'vitest';

import { parseSimScenarioInput } from '../schema/input.js';
import { runSimulation } from '../sim/engine.js';
import { LANE_LEFT, LANE_RIGHT, syntheticGraph, vehicle } from './fixtures/scenarios.js';

const graph = syntheticGraph();

function inputWithStaticQueue(staticFlag: boolean) {
  const ego = vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 0, speedMps: 10, cruiseSpeedMps: 10 });
  const target = vehicle(graph, { id: 'target', rsl: LANE_LEFT, s: 32, speedMps: 0, cruiseSpeedMps: 0, dims: { l: 0.6, w: 0.6, h: 1.7 } });
  const parked = vehicle(graph, { id: 'parked', rsl: LANE_RIGHT, s: 1, speedMps: 0, cruiseSpeedMps: 0 });
  return parseSimScenarioInput({
    mapId: 'synthetic-straight',
    clipSeconds: 2,
    warmupSeconds: 0,
    dt: 0.02,
    seed: 'static-metrics',
    metricSubject: 'ego',
    actors: [ego, target, { ...parked, static: staticFlag }],
    interactions: [],
    occluders: [],
  });
}

describe('static actors', () => {
  it('can resume after reaching a route end when an explicit route action supplies a new path', () => {
    const cart = vehicle(graph, { id: 'cart', rsl: LANE_LEFT, s: 790, speedMps: 12, cruiseSpeedMps: 12, dims: { l: 1.05, w: 0.65, h: 1.05 } });
    const input = parseSimScenarioInput({
      mapId: 'synthetic-straight', clipSeconds: 3, warmupSeconds: 0, dt: 0.02, seed: 'reroute-retired',
      actors: [{ ...cart, kind: 'scooter', behavior: { ...cart.behavior, rules: { ...cart.behavior.rules, yield: false, collisionAvoidance: false } } }],
      interactions: [
        { id: 'rollback-path', actorId: 'cart', trigger: { kind: 'at', t: 1.5 }, verb: 'route', target: { kind: 'polyline', points: [{ x: 800, z: 0 }, { x: 790, z: 0 }] } },
        { id: 'rollback-speed', actorId: 'cart', trigger: { kind: 'at', t: 1.5 }, verb: 'speed', target: { mode: 'absolute', value: 2 }, dynamics: { shape: 'linear', constraint: 'time', value: 0.5 } },
      ],
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    const tr = trace.ticks.actors.cart!;
    const atReroute = trace.ticks.t.findIndex((t) => t >= 1.5);
    expect(tr.speedMps.slice(atReroute).some((speed) => speed > 0.5)).toBe(true);
    expect(Math.hypot(tr.x.at(-1)! - tr.x[atReroute]!, tr.y.at(-1)! - tr.y[atReroute]!)).toBeGreaterThan(1);
  });

  it('records physical spacing for a scored static-static queue pair', () => {
    const tail = vehicle(graph, { id: 'queue-tail', rsl: LANE_LEFT, s: 20, speedMps: 0, cruiseSpeedMps: 0 });
    const lead = vehicle(graph, { id: 'queue-lead', rsl: LANE_LEFT, s: 28, speedMps: 0, cruiseSpeedMps: 0 });
    const input = parseSimScenarioInput({
      mapId: 'synthetic-straight', clipSeconds: 1, warmupSeconds: 0, dt: 0.02,
      seed: 'static-queue-spacing', actors: [
        { ...tail, static: true },
        { ...lead, static: true },
      ], interactions: [], occluders: [],
    });

    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.metrics.minDistance).toContainEqual(expect.objectContaining({
      pair: ['queue-lead', 'queue-tail'],
      t: 0,
    }));
    expect(trace.metrics.minTTC).toBeNull();
  });

  it('uses an explicitly declared moving actor as a tick-updated occluder', () => {
    const ego = vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 0, speedMps: 10, cruiseSpeedMps: 10 });
    const van = vehicle(graph, { id: 'moving-van', rsl: LANE_LEFT, s: 25, speedMps: 10, cruiseSpeedMps: 10 });
    const target = vehicle(graph, { id: 'target', rsl: LANE_LEFT, s: 55, speedMps: 0, cruiseSpeedMps: 0 });
    const input = parseSimScenarioInput({
      mapId: 'synthetic-straight', clipSeconds: 2, warmupSeconds: 0, dt: 0.02,
      seed: 'moving-actor-occluder', metricSubject: 'ego', actors: [ego, van, target], interactions: [],
      occlusionPairs: [{ observer: 'ego', target: 'target', occluderId: 'actor:moving-van' }],
    });

    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.metrics.declaredOcclusion).toContainEqual(expect.objectContaining({
      observer: 'ego', target: 'target', occluderId: 'actor:moving-van',
      relevantOccluderIds: ['actor:moving-van'],
      firstBlockedT: 0,
    }));
  });

  it('remain immobile even when authored with nonzero speed and cruise', () => {
    const parked = vehicle(graph, { id: 'parked', rsl: LANE_LEFT, s: 790, speedMps: 12, cruiseSpeedMps: 12 });
    const input = parseSimScenarioInput({
      mapId: 'synthetic-straight',
      clipSeconds: 2,
      warmupSeconds: 1,
      dt: 0.02,
      seed: 'static-immobile',
      actors: [{ ...parked, static: true }],
      interactions: [],
      occluders: [],
    });

    const { trace, issues } = runSimulation(input, { graph, guards: 'collect' });
    expect(issues.some((i) => i.code === 'runway_insufficient')).toBe(false);
    const tr = trace.ticks.actors['parked']!;
    expect(new Set(tr.x).size).toBe(1);
    expect(new Set(tr.y).size).toBe(1);
    expect(tr.speedMps.every((v) => v === 0)).toBe(true);
  });

  it('does not let adjacent-lane corner radii steal minTTC from the incident pair', () => {
    const dynamic = runSimulation(inputWithStaticQueue(false), { graph, guards: 'collect' }).trace;
    expect(dynamic.metrics.minTTC?.pair).toEqual(['ego', 'target']);
    expect(dynamic.metrics.minDistance.some((d) => d.pair.includes('parked'))).toBe(true);

    const fixed = runSimulation(inputWithStaticQueue(true), { graph, guards: 'collect' }).trace;
    expect(fixed.metrics.minTTC?.pair).toEqual(['ego', 'target']);
    expect(fixed.metrics.minTTC?.value).toBeGreaterThan(0);
    expect(fixed.metrics.minDistance.some((d) => d.pair.includes('parked'))).toBe(false);
  });

  it('marks declared occlusion ineffective when it never blocks the incident pair', () => {
    const ego = vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 0, speedMps: 10, cruiseSpeedMps: 10 });
    const target = vehicle(graph, { id: 'target', rsl: LANE_LEFT, s: 40, speedMps: 0, cruiseSpeedMps: 0 });
    const input = parseSimScenarioInput({
      mapId: 'synthetic-straight',
      clipSeconds: 2,
      warmupSeconds: 0,
      dt: 0.02,
      seed: 'ineffective-occluder',
      metricSubject: 'ego',
      actors: [ego, target],
      interactions: [],
      occlusionPairs: [{ observer: 'ego', target: 'target', occluderId: 'off-axis-wall' }],
      occluders: [
        {
          id: 'off-axis-wall',
          obb: { center: { x: 20, z: 50 }, lengthM: 10, widthM: 2, heightM: 2, headingRad: 0 },
        },
      ],
    });

    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.metrics.minTTC?.pair).toEqual(['ego', 'target']);
    expect(trace.metrics.occluderIneffective).toEqual([
      {
        observer: 'ego',
        target: 'target',
        pair: ['ego', 'target'],
        conflictT: trace.metrics.minTTC!.t + trace.metrics.minTTC!.value,
        occluderId: 'off-axis-wall',
        relevantOccluderIds: ['off-axis-wall'],
        reason: 'never_blocked_before_conflict',
      },
    ]);
    expect(trace.metrics.revealToConflict).toBeNull();
  });

  it('honors occluderId when deciding which declared occluder was ineffective', () => {
    const ego = vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 0, speedMps: 10, cruiseSpeedMps: 10 });
    const target = vehicle(graph, { id: 'target', rsl: LANE_LEFT, s: 40, speedMps: 0, cruiseSpeedMps: 0 });
    const input = parseSimScenarioInput({
      mapId: 'synthetic-straight',
      clipSeconds: 2,
      warmupSeconds: 0,
      dt: 0.02,
      seed: 'occluder-id',
      metricSubject: 'ego',
      actors: [ego, target],
      interactions: [],
      occlusionPairs: [
        { observer: 'ego', target: 'target', occluderId: 'on-axis-wall' },
        { observer: 'ego', target: 'target', occluderId: 'off-axis-wall' },
      ],
      occluders: [
        {
          id: 'on-axis-wall',
          obb: { center: { x: 20, z: 0 }, lengthM: 10, widthM: 2, heightM: 2, headingRad: 0 },
        },
        {
          id: 'off-axis-wall',
          obb: { center: { x: 20, z: 50 }, lengthM: 10, widthM: 2, heightM: 2, headingRad: 0 },
        },
      ],
    });

    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.metrics.occluderIneffective).toEqual([
      {
        observer: 'ego',
        target: 'target',
        pair: ['ego', 'target'],
        conflictT: trace.metrics.minTTC!.t + trace.metrics.minTTC!.value,
        occluderId: 'off-axis-wall',
        relevantOccluderIds: ['off-axis-wall'],
        reason: 'never_blocked_before_conflict',
      },
    ]);
  });

  it('does not mark declared occlusion ineffective when the pair is actually blocked', () => {
    const ego = vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 0, speedMps: 10, cruiseSpeedMps: 10 });
    const target = vehicle(graph, { id: 'target', rsl: LANE_LEFT, s: 40, speedMps: 0, cruiseSpeedMps: 0 });
    const input = parseSimScenarioInput({
      mapId: 'synthetic-straight',
      clipSeconds: 2,
      warmupSeconds: 0,
      dt: 0.02,
      seed: 'effective-occluder',
      metricSubject: 'ego',
      actors: [ego, target],
      interactions: [],
      occlusionPairs: [{ observer: 'ego', target: 'target', occluderId: 'on-axis-wall' }],
      occluders: [
        {
          id: 'on-axis-wall',
          obb: { center: { x: 20, z: 0 }, lengthM: 10, widthM: 2, heightM: 2, headingRad: 0 },
        },
      ],
    });

    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.metrics.occluderIneffective).toEqual([]);
  });

  it('still lets a parked actor block line-of-sight triggers', () => {
    const ego = vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 0, speedMps: 0, cruiseSpeedMps: 0 });
    const target = vehicle(graph, { id: 'target', rsl: LANE_LEFT, s: 30, speedMps: 0, cruiseSpeedMps: 0 });
    const parked = vehicle(graph, { id: 'parked', rsl: LANE_LEFT, s: 15, speedMps: 0, cruiseSpeedMps: 0 });
    const input = parseSimScenarioInput({
      mapId: 'synthetic-straight',
      clipSeconds: 2,
      warmupSeconds: 0,
      dt: 0.02,
      seed: 'static-occludes',
      actors: [ego, target, { ...parked, static: true }],
      interactions: [
        {
          id: 'when-visible',
          actorId: 'ego',
          trigger: {
            kind: 'when',
            condition: { kind: 'visible', a: 'ego', to: 'target', value: true },
            byLatest: 1,
            ifNever: 'skip',
          },
          verb: 'speed',
          target: { mode: 'absolute', value: 1 },
          dynamics: { shape: 'linear', constraint: 'time', value: 0.1 },
        },
      ],
      occluders: [],
    });

    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.events.some((e) => e.kind === 'trigger_fired' && e.interactionId === 'when-visible')).toBe(false);
    expect(trace.metrics.triggerNeverFired).toEqual(['when-visible']);
    // The parked actor was an occluder but not a metric participant.
    expect(trace.metrics.minDistance.some((d) => d.pair.includes('parked'))).toBe(false);
  });
});
