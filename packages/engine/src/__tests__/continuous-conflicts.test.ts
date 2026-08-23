import { describe, expect, it } from 'vitest';

import { obbOverlap, type Obb } from '../core/math.js';
import { parseSimScenarioInput } from '../schema/input.js';
import { runSimulation } from '../sim/engine.js';
import {
  articulatedDoorObb,
  readPair,
  readPathConflict,
  readStaticObbPathConflict,
  sweptObbTimeOfImpact,
} from '../sim/pairs.js';
import type { ActorRuntime } from '../sim/state.js';
import { Route } from '../map/route.js';
import { serializeTrace, traceDigest } from '../trace/gzip.js';
import { computeMetrics, newMetricAccumulator, observeTick } from '../trace/metrics.js';
import { LANE_LEFT, syntheticGraph, vehicle } from './fixtures/scenarios.js';

function box(x: number, y: number, lengthM = 2, widthM = 2, headingRad = 0): Obb {
  return { center: { x, y }, lengthM, widthM, headingRad };
}

function pathActor(
  id: string,
  points: Array<{ x: number; y: number }>,
  speedMps: number,
  dims = { l: 2, w: 2, h: 1.5 },
): ActorRuntime {
  const route = Route.fromPolyline(points);
  const pose = route.poseAt(0);
  return {
    id,
    kind: 'vehicle',
    dims,
    tags: [],
    static: false,
    rules: {
      obeySignals: true,
      yield: true,
      yieldToVehicles: true,
      yieldToPedestrians: true,
      collisionAvoidance: true,
      aggression: 0.5,
      speedFactor: 1,
    },
    cruiseSpeedMps: speedMps,
    cruiseOverrideMps: speedMps,
    route,
    routeS: 0,
    timedRoute: null,
    bestEffortWorldPath: false,
    remainingTurns: [],
    speedMps,
    accelMps2: 0,
    lateralOffsetM: 0,
    lateralReferenceOffsetM: 0,
    lateralReferenceRateMps: 0,
    lateralReferenceAccelMps2: 0,
    lateralRateMps: 0,
    position: pose.point,
    headingRad: pose.headingRad,
    present: true,
    retired: false,
    longCmd: null,
    latCmd: null,
    untilByAxis: new Map(),
    stateKeys: new Map(),
    roadControlStates: new Map(),
    motionDirection: 1,
    pendingMotionDirection: null,
    hasMoved: false,
    standstillSinceS: null,
    requiredDecelMax: 0,
  };
}

describe('continuous collision detection', () => {
  it('finds first contact when two disjoint tick samples tunnel through each other', () => {
    const hit = sweptObbTimeOfImpact(
      box(0, 0),
      box(10, 0),
      box(5, 0),
      box(5, 0),
    );
    expect(hit).not.toBeNull();
    expect(hit!.toi).toBeCloseTo(0.3, 12);
  });

  it('does not turn a close swept pass into a collision', () => {
    const hit = sweptObbTimeOfImpact(
      box(0, 0),
      box(10, 0),
      box(5, 2.01),
      box(5, 2.01),
    );
    expect(hit).toBeNull();
  });

  it('detects a rotating footprint that overlaps only between endpoints', () => {
    const start = box(0, 0, 4, 0.5, 0);
    const end = box(0, 0, 4, 0.5, Math.PI);
    const obstacle = box(0, 1.5, 0.4, 0.4, 0);
    expect(obbOverlap(start, obstacle)).toBe(false);
    expect(obbOverlap(end, obstacle)).toBe(false);
    const first = sweptObbTimeOfImpact(start, end, obstacle, obstacle);
    const second = sweptObbTimeOfImpact(start, end, obstacle, obstacle);
    expect(first).not.toBeNull();
    expect(first).toEqual(second);
    expect(first!.toi).toBeGreaterThan(0);
    expect(first!.toi).toBeLessThan(1);
  });

  it('sweeps the thin free edge of an opening side door without tunneling', () => {
    const parked = pathActor('parked', [{ x: 0, y: 0 }, { x: 20, y: 0 }], 0, { l: 4.5, w: 1.9, h: 1.5 });
    const closed = articulatedDoorObb(parked, 'left', 0);
    const middle = articulatedDoorObb(parked, 'left', 0.1);
    const opened = articulatedDoorObb(parked, 'left', 0.2);
    const freeEdge = {
      x: middle.center.x - Math.cos(middle.headingRad) * middle.lengthM / 2,
      y: middle.center.y - Math.sin(middle.headingRad) * middle.lengthM / 2,
    };
    const cyclist = box(freeEdge.x, freeEdge.y, 0.04, 0.04, 0);
    expect(obbOverlap(closed, cyclist)).toBe(false);
    expect(obbOverlap(opened, cyclist)).toBe(false);
    expect(sweptObbTimeOfImpact(closed, opened, cyclist, cyclist)).not.toBeNull();
  });

  it('keeps a bus entrance door in the body envelope instead of substituting a car hinge', () => {
    const bus = {
      ...pathActor('bus', [{ x: 0, y: 0 }, { x: 20, y: 0 }], 0, { l: 12, w: 2.55, h: 3.2 }),
      kind: 'bus' as const,
    };
    const closed = articulatedDoorObb(bus, 'right', 0);
    const opened = articulatedDoorObb(bus, 'right', 1);
    expect(closed.headingRad).toBe(bus.headingRad);
    expect(opened.headingRad).toBe(bus.headingRad);
    expect(Math.abs(opened.center.y - bus.position.y)).toBeLessThan(bus.dims.w / 2 + 0.05);
    expect(Math.abs(opened.center.x - closed.center.x)).toBeGreaterThan(0.5);
  });

  it('continuously sweeps an expanding rear door footprint', () => {
    const parked = pathActor('parked', [{ x: 0, y: 0 }, { x: 20, y: 0 }], 0, { l: 4.5, w: 1.9, h: 1.5 });
    const closed = articulatedDoorObb(parked, 'rear', 0);
    const opened = articulatedDoorObb(parked, 'rear', 1);
    const midway = articulatedDoorObb(parked, 'rear', 0.5);
    const obstacle = box(
      midway.center.x - Math.cos(parked.headingRad) * midway.widthM / 2,
      midway.center.y - Math.sin(parked.headingRad) * midway.widthM / 2,
      0.02,
      0.02,
    );
    const hit = sweptObbTimeOfImpact(closed, opened, obstacle, obstacle);
    expect(hit).not.toBeNull();
    expect(hit!.toi).toBeGreaterThan(0);
    expect(hit!.toi).toBeLessThan(1);
  });

  it('records sub-tick impact against a static collidable', () => {
    const graph = syntheticGraph();
    const mover = vehicle(graph, {
      id: 'mover',
      rsl: LANE_LEFT,
      s: 0,
      speedMps: 100,
      cruiseSpeedMps: 100,
      dims: { l: 1, w: 1, h: 1 },
      rules: { collisionAvoidance: false },
    });
    const barrier = vehicle(graph, {
      id: 'barrier',
      rsl: LANE_LEFT,
      s: 10,
      speedMps: 0,
      cruiseSpeedMps: 0,
      dims: { l: 1, w: 1, h: 1 },
    });
    const input = parseSimScenarioInput({
      mapId: 'synthetic-straight',
      clipSeconds: 0.2,
      warmupSeconds: 0,
      dt: 0.2,
      seed: 'static-tunneling',
      actors: [mover, { ...barrier, static: true }],
      interactions: [
        {
          id: 'on-impact',
          actorId: 'mover',
          trigger: {
            kind: 'when',
            condition: { kind: 'collision', a: 'mover', b: 'barrier' },
            byLatest: 0.2,
            ifNever: 'skip',
          },
          verb: 'set',
          target: { key: 'lights.impact', value: true },
        },
      ],
      occluders: [],
    });

    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    const collisions = trace.events.filter((event) => event.kind === 'collision');
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.t).toBeGreaterThan(0);
    expect(collisions[0]!.t).toBeLessThan(0.2);
    expect(trace.metrics.collisions).toEqual(collisions.map(({ t, a, b }) => ({ t, a, b })));
    expect(trace.events.some((event) => event.kind === 'trigger_fired' && event.interactionId === 'on-impact'))
      .toBe(true);
    // A static actor on a collision course is an intended physical participant.
    expect(trace.metrics.minDistance[0]?.pair).toEqual(['barrier', 'mover']);
    expect(trace.metrics.minPathTTC?.pair).toEqual(['barrier', 'mover']);
  });

  it('sweeps collidable props and exposes their stable prop namespace to triggers', () => {
    const graph = syntheticGraph();
    const mover = vehicle(graph, {
      id: 'mover',
      rsl: LANE_LEFT,
      s: 0,
      speedMps: 100,
      cruiseSpeedMps: 100,
      dims: { l: 1, w: 1, h: 1 },
      rules: { collisionAvoidance: false },
    });
    const input = parseSimScenarioInput({
      mapId: 'prop-tunneling',
      clipSeconds: 0.2,
      warmupSeconds: 0,
      dt: 0.2,
      actors: [mover],
      props: [{
        id: 'crate',
        catalogId: 'cargo.crate',
        pose: { x: 10, z: 0, headingRad: 0 },
        dims: { l: 1, w: 1, h: 1 },
        collidable: true,
      }],
      interactions: [{
        id: 'prop-impact',
        actorId: 'mover',
        trigger: {
          kind: 'when',
          condition: { kind: 'collision', a: 'mover', b: 'prop:crate' },
          byLatest: 0.2,
          ifNever: 'skip',
        },
        verb: 'set',
        target: { key: 'lights.impact', value: true },
      }],
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.metrics.collisions).toEqual([
      expect.objectContaining({ a: 'mover', b: 'prop:crate', colliderB: 'static' }),
    ]);
    expect(trace.metrics.collisions[0]!.t).toBeGreaterThan(0);
    expect(trace.metrics.collisions[0]!.t).toBeLessThan(0.2);
    expect(trace.events).toContainEqual(expect.objectContaining({
      kind: 'trigger_fired', interactionId: 'prop-impact', actorId: 'mover',
    }));
  });

  it('sweeps attached prop geometry with its carrier without self-collision', () => {
    const graph = syntheticGraph();
    const carrier = vehicle(graph, {
      id: 'worker', rsl: LANE_LEFT, s: 0, speedMps: 10, cruiseSpeedMps: 10,
      dims: { l: 0.6, w: 0.6, h: 1.8 }, rules: { collisionAvoidance: false },
    });
    const bystanderBase = vehicle(graph, {
      id: 'bystander', rsl: LANE_LEFT, s: 5, speedMps: 0, cruiseSpeedMps: 0,
      dims: { l: 0.6, w: 0.6, h: 1.8 },
    });
    // Move the bystander three metres to the carrier's left: their bodies are
    // disjoint, while the cross-carried eight-metre pipe reaches it.
    const bystander = {
      ...bystanderBase,
      static: true,
      initial: { ...bystanderBase.initial, pose: { ...bystanderBase.initial.pose, z: -3 } },
      behavior: { ...bystanderBase.behavior, route: { kind: 'polyline' as const, points: [
        { x: bystanderBase.initial.pose.x, z: -3 },
        { x: bystanderBase.initial.pose.x + 1, z: -3 },
      ] } },
    };
    const input = parseSimScenarioInput({
      mapId: 'attached-prop-sweep', clipSeconds: 1, warmupSeconds: 0, dt: 0.1,
      actors: [carrier, bystander],
      props: [{
        id: 'pipe', catalogId: 'construction.long_pipe',
        pose: { x: 0, z: 0, headingRad: 0 }, dims: { l: 8, w: 0.62, h: 0.62 },
        collidable: true,
        attachment: { actorId: 'worker', longitudinalM: 0, lateralM: 0, heightM: 1.1, headingOffsetRad: Math.PI / 2 },
      }],
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.metrics.collisions).toContainEqual(expect.objectContaining({
      a: 'bystander', b: 'worker', colliderB: 'prop:pipe',
    }));
    expect(trace.metrics.collisions.some(({ a, b }) => a === 'worker' && b === 'prop:pipe')).toBe(false);
  });
});

describe('mechanism-faithful conflict metrics', () => {
  it('scores only pairs joined to the declared metric subject', () => {
    const graph = syntheticGraph();
    const make = (id: string, x: number, y: number, dx: number) => ({
      id,
      kind: 'car' as const,
      dims: { l: 2, w: 2, h: 1.5 },
      initial: { pose: { x, z: -y, headingRad: dx < 0 ? Math.PI : 0 }, speedMps: 5 },
      behavior: {
        rules: { collisionAvoidance: false },
        route: { kind: 'polyline' as const, points: [{ x, z: -y }, { x: x + dx, z: -y }] },
        cruiseSpeedMps: 5,
      },
    });
    const input = parseSimScenarioInput({
      mapId: 'metric-subject',
      clipSeconds: 0.2,
      warmupSeconds: 0,
      dt: 0.1,
      metricSubject: 'ego',
      actors: [
        make('ego', -10, 10, 20),
        make('target', 10, 10, -20),
        make('incidental-a', -2, 0, 20),
        make('incidental-b', 2, 0, -20),
      ],
    });
    const metrics = runSimulation(input, { graph, guards: 'collect' }).trace.metrics;
    expect(metrics.minDistance.every(({ pair }) => pair.includes('ego'))).toBe(true);
    expect(metrics.minTTC?.pair.includes('ego')).toBe(true);
  });

  it('rejects a crossing-path temporal near miss from instantaneous TTC', () => {
    const a = pathActor('a', [{ x: -10, y: 0 }, { x: 10, y: 0 }], 5);
    const b = pathActor('b', [{ x: 0, y: -20 }, { x: 0, y: 10 }], 5);
    expect(readPair(a, b).closingMps).toBeGreaterThan(0);
    expect(readPair(a, b).ttcS).toBe(Infinity);
  });

  it('does not report circle-corner contact for opposing traffic in adjacent lanes', () => {
    const a = pathActor('a', [{ x: -20, y: 0 }, { x: 20, y: 0 }], 10, { l: 4.8, w: 1.9, h: 1.5 });
    const b = pathActor('b', [{ x: 20, y: 5 }, { x: -20, y: 5 }], 10, { l: 4.8, w: 1.9, h: 1.5 });
    // The old circumscribed circles overlap at this lateral separation even
    // though the actual vehicle boxes have more than three metres clearance.
    expect(readPair(a, b).gapM).toBeGreaterThan(0);
    expect(readPair(a, b).ttcS).toBe(Infinity);
  });

  it('honors the pedestrian-specific yield rule in the engine conflict governor', () => {
    const graph = syntheticGraph();
    const run = (yieldToPedestrians: boolean) => {
      const input = parseSimScenarioInput({
        mapId: 'crossing-yield',
        clipSeconds: 1,
        warmupSeconds: 0,
        dt: 0.1,
        seed: 'yield-category',
        actors: [
          {
            id: 'ego',
            kind: 'vehicle',
            dims: { l: 4.5, w: 1.9, h: 1.5 },
            initial: { pose: { x: -40, z: 0, headingRad: 0 }, speedMps: 10 },
            behavior: {
              rules: { yield: true, yieldToVehicles: false, yieldToPedestrians: true },
              route: { kind: 'polyline', points: [{ x: -40, z: 0 }, { x: 40, z: 0 }] },
              cruiseSpeedMps: 10,
            },
            presentAtStart: true,
          },
          {
            id: 'walker',
            kind: 'pedestrian',
            dims: { l: 0.6, w: 0.6, h: 1.7 },
            initial: { pose: { x: 0, z: 5, headingRad: Math.PI / 2 }, speedMps: 2 },
            behavior: {
              rules: { collisionAvoidance: false },
              route: { kind: 'polyline', points: [{ x: 0, z: 5 }, { x: 0, z: -15 }] },
              cruiseSpeedMps: 2,
            },
            presentAtStart: true,
          },
        ],
        interactions: yieldToPedestrians
          ? []
          : [
              {
                id: 'disable-pedestrian-yield',
                actorId: 'ego',
                trigger: { kind: 'at', t: 0 },
                verb: 'set',
                target: { key: 'rules.yieldToPedestrians', value: false },
              },
            ],
        occluders: [],
      });
      return runSimulation(input, { graph, guards: 'collect' }).trace.ticks.actors['ego']!.speedMps.at(-1)!;
    };

    expect(run(true)).toBeLessThan(run(false) - 0.5);
  });

  it('reports path-TTC for overlapping conflict occupancy and PET for separated occupancy', () => {
    const a = pathActor('a', [{ x: -10, y: 0 }, { x: 10, y: 0 }], 5);
    const simultaneous = pathActor('b', [{ x: 0, y: -10 }, { x: 0, y: 10 }], 5);
    const overlap = readPathConflict(a, simultaneous)!;
    expect(overlap.conflictPoint).toEqual({ x: 0, y: 0 });
    expect(overlap.pathTtcS).toBeCloseTo(2 - Math.SQRT2 / 5, 10);
    expect(overlap.petS).toBe(0);

    const later = pathActor('b', [{ x: 0, y: -10 }, { x: 0, y: 10 }], 2.5);
    const separated = readPathConflict(a, later)!;
    expect(separated.pathTtcS).toBe(Infinity);
    expect(separated.petS).toBeCloseTo(2 - Math.SQRT2 / 5 - Math.SQRT2 / 2.5, 10);
  });

  it('emits finite, deterministically hashable path metrics', () => {
    const graph = syntheticGraph();
    const actor = (
      id: string,
      pose: { x: number; z: number; headingRad: number },
      points: Array<{ x: number; z: number }>,
    ) => ({
      id,
      kind: 'vehicle' as const,
      dims: { l: 2, w: 2, h: 1.5 },
      initial: { pose, speedMps: 5 },
      behavior: {
        rules: { collisionAvoidance: false },
        route: { kind: 'polyline' as const, points },
        cruiseSpeedMps: 5,
      },
      presentAtStart: true,
    });
    const input = parseSimScenarioInput({
      mapId: 'crossing-polylines',
      clipSeconds: 0.2,
      warmupSeconds: 0,
      dt: 0.2,
      seed: 'path-metrics',
      actors: [
        actor('a', { x: -10, z: 0, headingRad: 0 }, [{ x: -10, z: 0 }, { x: 10, z: 0 }]),
        actor(
          'b',
          { x: 0, z: 10, headingRad: Math.PI / 2 },
          [{ x: 0, z: 10 }, { x: 0, z: -10 }],
        ),
      ],
      interactions: [],
      occluders: [],
    });

    const first = runSimulation(input, { graph, guards: 'collect' }).trace;
    const second = runSimulation(input, { graph, guards: 'collect' }).trace;
    expect(first.metrics.minPathTTC).not.toBeNull();
    // Simultaneous conflict-zone occupancy is represented by path TTC, not a
    // zero-valued post-encroachment time.
    expect(first.metrics.minPET).toBeNull();
    expect(() => serializeTrace(first)).not.toThrow();
    expect(traceDigest(first)).toBe(traceDigest(second));
    expect(JSON.parse(new TextDecoder().decode(serializeTrace(first))).metrics.minPathTTC.value)
      .toBeCloseTo(first.metrics.minPathTTC!.value, 6);
  });

  it('keeps the first positive PET after overlapping occupancy instead of the zero sentinel', () => {
    const a = pathActor('a', [{ x: -10, y: 0 }, { x: 10, y: 0 }], 5);
    const b = pathActor('b', [{ x: 0, y: -10 }, { x: 0, y: 10 }], 5);
    const metrics = newMetricAccumulator(['a', 'b']);

    expect(readPathConflict(a, b)?.petS).toBe(0);
    observeTick(metrics, 0, [a, b], new Set(), []);

    b.speedMps = 2.5;
    const positivePet = readPathConflict(a, b)?.petS;
    expect(positivePet).toBeGreaterThan(0);
    observeTick(metrics, 1, [a, b], new Set(), []);

    const result = computeMetrics(metrics, 20);
    expect(result.minPathTTC).toMatchObject({ pair: ['a', 'b'], t: 0 });
    expect(result.minPET).toMatchObject({ pair: ['a', 'b'], t: 1, value: positivePet });
    expect(result.criticalitySamples?.pet).toEqual([expect.objectContaining({
      pair: ['a', 'b'],
      t: [1],
      value: [positivePet],
    })]);
  });

  it('includes an intended static cargo collision course in TTC and path-TTC', () => {
    const graph = syntheticGraph();
    const ego = vehicle(graph, {
      id: 'ego',
      rsl: LANE_LEFT,
      s: 0,
      speedMps: 10,
      cruiseSpeedMps: 10,
      rules: { collisionAvoidance: false },
    });
    const cargo = vehicle(graph, {
      id: 'cargo',
      rsl: LANE_LEFT,
      s: 30,
      speedMps: 0,
      cruiseSpeedMps: 0,
      dims: { l: 1.8, w: 1.3, h: 0.9 },
    });
    const input = parseSimScenarioInput({
      mapId: 'static-cargo',
      clipSeconds: 0.2,
      warmupSeconds: 0,
      dt: 0.1,
      seed: 'cargo-metrics',
      actors: [ego, { ...cargo, kind: 'static_object' as const, static: true }],
      interactions: [],
      occluders: [],
    });
    const metrics = runSimulation(input, { graph, guards: 'collect' }).trace.metrics;
    expect(metrics.minTTC?.pair).toEqual(['cargo', 'ego']);
    expect(metrics.minTTC?.value).toBeGreaterThan(0);
    expect(metrics.minPathTTC?.pair).toEqual(['cargo', 'ego']);
    expect(metrics.minDistance.some((entry) => entry.pair[0] === 'cargo')).toBe(true);
  });

  it('projects an active sinusoidal lane change around a static channelizer', () => {
    const shifting = pathActor('ego', [{ x: 0, y: 0 }, { x: 60, y: 0 }], 10, { l: 4.5, w: 2, h: 1.5 });
    shifting.latCmd = {
      kind: 'laneOffset',
      interactionId: 'shift-right',
      firedAt: 0,
      dynamics: { shape: 'sinusoidal', constraint: 'time', value: 1 },
      from: 0,
      to: 4,
      duration: 1,
      remaining: 0,
      done: false,
    };
    const channelizer = box(20, 0, 1, 1, 0);
    expect(readStaticObbPathConflict(shifting, channelizer, 4, 0)).toBeNull();
  });

  it('retains static channelizer path-TTC without an active lateral command', () => {
    const straight = pathActor('ego', [{ x: 0, y: 0 }, { x: 60, y: 0 }], 10, { l: 4.5, w: 2, h: 1.5 });
    const channelizer = box(20, 0, 1, 1, 0);
    const conflict = readStaticObbPathConflict(straight, channelizer, 4, 0);
    expect(conflict).not.toBeNull();
    expect(conflict!.pathTtcS).toBeGreaterThan(0);
    expect(conflict!.pathTtcS).toBeLessThan(4);
  });
});

describe('collidable door articulation', () => {
  it('opens continuously into a cyclist, records the door collider, and stays open', () => {
    const graph = syntheticGraph();
    const parked = vehicle(graph, {
      id: 'parked',
      rsl: LANE_LEFT,
      s: 10,
      speedMps: 0,
      cruiseSpeedMps: 0,
    });
    const input = parseSimScenarioInput({
      mapId: 'dooring',
      clipSeconds: 2,
      warmupSeconds: 0,
      dt: 0.1,
      seed: 'door-collision',
      metricSubject: 'ego',
      actors: [
        { ...parked, static: true },
        vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 300, speedMps: 0, cruiseSpeedMps: 0 }),
        {
          id: 'cyclist',
          kind: 'bicycle',
          dims: { l: 1.8, w: 0.6, h: 1.7 },
          initial: { pose: { x: 7, z: -2, headingRad: 0 }, speedMps: 3 },
          behavior: {
            rules: { collisionAvoidance: false },
            route: { kind: 'polyline', points: [{ x: 7, z: -2 }, { x: 20, z: -2 }] },
            cruiseSpeedMps: 3,
          },
          presentAtStart: true,
        },
      ],
      interactions: [
        {
          id: 'open-door',
          actorId: 'parked',
          trigger: { kind: 'at', t: 0 },
          verb: 'set',
          target: { key: 'doors.left', value: 'opening' },
        },
      ],
      occluders: [],
    });

    const trace = runSimulation(input, { graph, guards: 'collect' }).trace;
    const collision = trace.events.find((event) => event.kind === 'collision');
    expect(collision).toMatchObject({
      kind: 'collision',
      a: 'cyclist',
      b: 'parked',
      colliderA: 'body',
      colliderB: 'door:left',
    });
    expect(trace.metrics.collisions[0]).toMatchObject({ colliderB: 'door:left' });
    expect(trace.metrics.minTTC?.pair).toEqual(['cyclist', 'parked']);
    expect(trace.metrics.criticalitySamples?.ttc).toContainEqual(expect.objectContaining({
      pair: ['cyclist', 'parked'],
    }));
    expect(trace.events).toContainEqual({
      t: 1,
      kind: 'state_set',
      actorId: 'parked',
      key: 'doors.left',
      value: 'open',
    });
    expect(trace.events.some(
      (event) => event.kind === 'state_set' && event.key === 'doors.left' && event.value === 'closing',
    )).toBe(false);
    expect(trace.ticks.actors['parked']!.present.at(-1)).toBe(1);
  });
});

describe('signed reverse motion', () => {
  it('moves rear-first while retaining facing heading, lamps, and pedestrian conflict metrics', () => {
    const graph = syntheticGraph();
    const input = parseSimScenarioInput({
      mapId: 'reverse-crossing',
      clipSeconds: 1.5,
      warmupSeconds: 0,
      dt: 0.1,
      seed: 'reverse-pedestrian',
      actors: [
        {
          id: 'backing-car',
          kind: 'car',
          dims: { l: 4.5, w: 1.9, h: 1.5 },
          initial: { pose: { x: 0, z: 0, headingRad: Math.PI }, speedMps: 5 },
          behavior: {
            rules: { collisionAvoidance: false },
            route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 12, z: 0 }] },
            cruiseSpeedMps: 5,
          },
          presentAtStart: true,
          tags: ['motion:reverse'],
        },
        {
          id: 'pedestrian',
          kind: 'pedestrian',
          dims: { l: 0.6, w: 0.6, h: 1.7 },
          initial: { pose: { x: 5, z: 5, headingRad: Math.PI / 2 }, speedMps: 5 },
          behavior: {
            rules: { collisionAvoidance: false },
            route: { kind: 'polyline', points: [{ x: 5, z: 5 }, { x: 5, z: -5 }] },
            cruiseSpeedMps: 5,
          },
          presentAtStart: true,
        },
      ],
      interactions: [
        {
          id: 'reverse-lamps',
          actorId: 'backing-car',
          trigger: { kind: 'at', t: 0 },
          verb: 'set',
          target: { key: 'lights.reverse', value: true },
        },
      ],
      occluders: [],
    });

    const trace = runSimulation(input, { graph, guards: 'collect' }).trace;
    const car = trace.ticks.actors['backing-car']!;
    expect(car.x.at(-1)).toBeGreaterThan(car.x[0]!);
    const impactIndex = trace.ticks.t.findIndex((t) =>
      t >= (trace.metrics.collisions.find(({ a, b }) => a === 'backing-car' || b === 'backing-car')?.t ?? Infinity));
    const preImpactHeadings = impactIndex < 0 ? car.headingRad : car.headingRad.slice(0, impactIndex);
    expect(preImpactHeadings.every((heading) => Math.abs(Math.abs(heading) - Math.PI) < 1e-6)).toBe(true);
    expect(car.motionDirection?.every((direction) => direction === -1)).toBe(true);
    expect(trace.events).toContainEqual({
      t: 0,
      kind: 'state_set',
      actorId: 'backing-car',
      key: 'lights.reverse',
      value: true,
    });
    expect(trace.metrics.minPathTTC?.pair).toEqual(['backing-car', 'pedestrian']);
    expect(trace.metrics.collisions.some(({ a, b }) => a === 'backing-car' && b === 'pedestrian')).toBe(true);
  });
});

describe('deterministic road-control primitives', () => {
  it('stops, dwells continuously, and releases exactly once at a stop control', () => {
    const graph = syntheticGraph();
    const ego = vehicle(graph, {
      id: 'ego',
      rsl: LANE_LEFT,
      s: 0,
      speedMps: 10,
      cruiseSpeedMps: 10,
    });
    const input = parseSimScenarioInput({
      mapId: 'synthetic-straight',
      clipSeconds: 6,
      warmupSeconds: 0,
      dt: 0.1,
      seed: 'stop-dwell',
      actors: [ego],
      interactions: [],
      occluders: [],
      roadControls: [
        {
          id: 'stop-main',
          kind: 'stop',
          dwellS: 0.5,
          stopLines: [{ rsl: LANE_LEFT, s: 20, connectingLaneRsls: [] }],
        },
      ],
    });

    const track = runSimulation(input, { graph, guards: 'collect' }).trace.ticks.actors['ego']!;
    const stopped = track.speedMps
      .map((speed, index) => ({ speed, index }))
      .filter(({ speed }) => speed <= 0.05);
    expect(stopped.length).toBeGreaterThanOrEqual(5);
    expect(Math.max(...stopped.map(({ index }) => track.x[index]!))).toBeLessThanOrEqual(20);
    const lastStoppedIndex = stopped.at(-1)!.index;
    expect(Math.max(...track.speedMps.slice(lastStoppedIndex + 1))).toBeGreaterThan(1);
    expect(track.x.at(-1)).toBeGreaterThan(20);
  });
});
