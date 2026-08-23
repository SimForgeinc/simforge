/**
 * Reverse gear.
 *
 * A reversing vehicle is *not* a vehicle with a negative speed. `speedMps` is a
 * magnitude everywhere downstream — TTC, required-decel, exporters — so signing
 * it would poison all of them. Reverse is a discrete gear state on its own
 * `set` axis, and the invariant that makes it coherent is:
 *
 *   **The route is the path the body travels.** In reverse the body traverses
 *   that path rear-first, so its heading is `routeTangent + PI` and its
 *   displacement along its own heading is negative. The heading is never
 *   flipped away from that: an oriented bounding box, a clearance measurement
 *   and a render all read `headingRad` directly.
 *
 * These tests pin that invariant against the *default* physics backend
 * (dynamic-v1), which is what a materialized template actually runs on.
 */

import { describe, expect, it } from 'vitest';

import { runSimulation } from '../sim/engine.js';
import { parseSimScenarioInput } from '../schema/input.js';
import { DynamicV1Backend } from '../sim/dynamic-v1.js';
import { REVERSE_MAX_SPEED_MPS } from '../sim/gear.js';
import { LANE_LEFT, syntheticGraph } from './fixtures/scenarios.js';

/** Signed displacement along each sample's own heading, summed over the clip. */
function alongOwnHeadingM(track: {
  x: readonly number[];
  y: readonly number[];
  headingRad: readonly number[];
}): number {
  let total = 0;
  for (let i = 1; i < track.x.length; i++) {
    const dx = track.x[i]! - track.x[i - 1]!;
    const dy = track.y[i]! - track.y[i - 1]!;
    total += dx * Math.cos(track.headingRad[i - 1]!) + dy * Math.sin(track.headingRad[i - 1]!);
  }
  return total;
}

function headingSpreadRad(headings: readonly number[]): number {
  const first = headings[0]!;
  let worst = 0;
  for (const h of headings) {
    const d = Math.abs(Math.atan2(Math.sin(h - first), Math.cos(h - first)));
    if (d > worst) worst = d;
  }
  return worst;
}

/** A lane-bound car that spawns already in reverse gear. */
function reversingOnLane(startS: number, speedMps: number) {
  const graph = syntheticGraph();
  const entry = graph.sampleDirected({ rsl: LANE_LEFT, reversed: false }, startS);
  return {
    graph,
    actor: {
      id: 'backing',
      kind: 'car' as const,
      dims: { l: 4.8, w: 1.9, h: 1.5 },
      initial: {
        // Authored facing along the lane tangent — exactly what the
        // materializer emits for a parking/driveway role today.
        pose: { x: entry.point.x, z: -entry.point.y, headingRad: entry.headingRad },
        speedMps: 0,
      },
      behavior: {
        rules: { collisionAvoidance: false },
        route: { kind: 'follow' as const, startRsl: LANE_LEFT, turns: [], maxLengthM: 400 },
        cruiseSpeedMps: speedMps,
      },
      presentAtStart: true,
      tags: ['motion:reverse'],
    },
  };
}

describe('reverse gear under the default (dynamic-v1) backend', () => {
  it('keeps a reversing actor bound to its route and lane', () => {
    const { graph, actor } = reversingOnLane(100, 2.5);
    const trace = runSimulation(
      parseSimScenarioInput({
        mapId: 'synthetic-straight',
        clipSeconds: 8,
        warmupSeconds: 0,
        dt: 0.05,
        seed: 'reverse-route-binding',
        actors: [actor],
        interactions: [
          {
            id: 'back-up',
            actorId: 'backing',
            trigger: { kind: 'at', t: 0 },
            verb: 'speed',
            target: { mode: 'absolute', value: 2.5 },
            dynamics: { shape: 'linear', constraint: 'time', value: 1 },
          },
        ],
        occluders: [],
      }),
      { graph, guards: 'collect' },
    ).trace;

    const track = trace.ticks.actors['backing']!;

    // The route is the path of travel: station must advance, not sit still.
    expect(track.s.at(-1)! - track.s[0]!).toBeGreaterThan(3);
    // A reversing car never leaves the lane graph.
    expect(new Set(track.laneRsl)).toEqual(new Set([LANE_LEFT]));
    // ...and it travels rear-first.
    expect(alongOwnHeadingM(track)).toBeLessThan(-3);
    // ...without flipping its heading.
    expect(headingSpreadRad(track.headingRad)).toBeLessThan(0.1);
    expect(new Set(track.motionDirection!)).toEqual(new Set([-1]));
  });

  it('governs reverse speed well below the forward cap', () => {
    const { graph, actor } = reversingOnLane(60, 30);
    const trace = runSimulation(
      parseSimScenarioInput({
        mapId: 'synthetic-straight',
        clipSeconds: 8,
        warmupSeconds: 0,
        dt: 0.05,
        seed: 'reverse-governor',
        actors: [actor],
        interactions: [
          {
            id: 'floor-it-backwards',
            actorId: 'backing',
            trigger: { kind: 'at', t: 0 },
            verb: 'speed',
            // 30 m/s is flatly impossible in reverse gear; the engine must
            // govern it rather than obey it.
            target: { mode: 'absolute', value: 30 },
            dynamics: { shape: 'linear', constraint: 'time', value: 1 },
          },
        ],
        occluders: [],
      }),
      { graph, guards: 'collect' },
    ).trace;

    const track = trace.ticks.actors['backing']!;
    const tail = track.speedMps.slice(-20);
    // The governor bounds the *command*. The physical body tracks it with the
    // ordinary overshoot of a throttle loop — asserting a hard ceiling on the
    // integrated velocity would be asserting that the physics is fake — so the
    // contract is: steady state sits on the ceiling, the transient stays within
    // a tenth of it, and 30 m/s never happens.
    expect(Math.max(...tail)).toBeLessThanOrEqual(REVERSE_MAX_SPEED_MPS + 1e-6);
    expect(Math.min(...tail)).toBeGreaterThan(REVERSE_MAX_SPEED_MPS - 0.5);
    expect(Math.max(...track.speedMps)).toBeLessThanOrEqual(REVERSE_MAX_SPEED_MPS * 1.1);
  });
});

describe('reverse gear is a timeline state, not a spawn flag', () => {
  it('shifts into reverse mid-clip and reverses only after the shift', () => {
    const graph = syntheticGraph();
    const entry = graph.sampleDirected({ rsl: LANE_LEFT, reversed: false }, 40);
    const trace = runSimulation(
      parseSimScenarioInput({
        mapId: 'synthetic-straight',
        clipSeconds: 14,
        warmupSeconds: 0,
        dt: 0.05,
        seed: 'reverse-shift',
        actors: [
          {
            id: 'shifter',
            kind: 'car',
            dims: { l: 4.8, w: 1.9, h: 1.5 },
            initial: {
              pose: { x: entry.point.x, z: -entry.point.y, headingRad: entry.headingRad },
              speedMps: 6,
            },
            behavior: {
              rules: { collisionAvoidance: false },
              route: { kind: 'follow', startRsl: LANE_LEFT, turns: [], maxLengthM: 400 },
              cruiseSpeedMps: 6,
            },
            presentAtStart: true,
            tags: [],
          },
        ],
        interactions: [
          {
            id: 'halt',
            actorId: 'shifter',
            trigger: { kind: 'at', t: 1 },
            verb: 'speed',
            target: { mode: 'stop' },
            dynamics: { shape: 'linear', constraint: 'rate', value: 3 },
          },
          {
            id: 'select-reverse',
            actorId: 'shifter',
            trigger: { kind: 'at', t: 5 },
            verb: 'set',
            target: { key: 'motion.gear', value: 'reverse' },
          },
          {
            id: 'back-up',
            actorId: 'shifter',
            trigger: { kind: 'at', t: 5.5 },
            verb: 'speed',
            target: { mode: 'absolute', value: 2.5 },
            dynamics: { shape: 'linear', constraint: 'time', value: 1 },
          },
        ],
        occluders: [],
      }),
      { graph, guards: 'collect' },
    ).trace;

    const track = trace.ticks.actors['shifter']!;
    const shiftIndex = trace.ticks.t.findIndex((t) => t >= 5 - 1e-9);
    const before = {
      x: track.x.slice(0, shiftIndex + 1),
      y: track.y.slice(0, shiftIndex + 1),
      headingRad: track.headingRad.slice(0, shiftIndex + 1),
    };
    const after = {
      x: track.x.slice(shiftIndex),
      y: track.y.slice(shiftIndex),
      headingRad: track.headingRad.slice(shiftIndex),
    };

    expect(track.motionDirection![0]).toBe(1);
    expect(track.motionDirection!.at(-1)).toBe(-1);
    expect(alongOwnHeadingM(before)).toBeGreaterThan(3);
    expect(alongOwnHeadingM(after)).toBeLessThan(-3);
    expect(headingSpreadRad(track.headingRad)).toBeLessThan(0.1);
    // The request and the engagement are separate keys: `motion.gear` is what
    // the author asked for, `motion.gearEngaged` is what the gearbox did.
    expect(trace.events).toContainEqual(
      expect.objectContaining({ kind: 'state_set', actorId: 'shifter', key: 'motion.gear', value: 'reverse' }),
    );
    expect(trace.events).toContainEqual(
      expect.objectContaining({ kind: 'state_set', actorId: 'shifter', key: 'motion.gearEngaged', value: 'reverse' }),
    );
  });

  it('refuses to engage reverse while the vehicle is still moving forward', () => {
    const graph = syntheticGraph();
    const entry = graph.sampleDirected({ rsl: LANE_LEFT, reversed: false }, 40);
    const trace = runSimulation(
      parseSimScenarioInput({
        mapId: 'synthetic-straight',
        clipSeconds: 6,
        warmupSeconds: 0,
        dt: 0.05,
        seed: 'reverse-shift-at-speed',
        actors: [
          {
            id: 'shifter',
            kind: 'car',
            dims: { l: 4.8, w: 1.9, h: 1.5 },
            initial: {
              pose: { x: entry.point.x, z: -entry.point.y, headingRad: entry.headingRad },
              speedMps: 12,
            },
            behavior: {
              rules: { collisionAvoidance: false },
              route: { kind: 'follow', startRsl: LANE_LEFT, turns: [], maxLengthM: 400 },
              cruiseSpeedMps: 12,
            },
            presentAtStart: true,
            tags: [],
          },
        ],
        interactions: [
          {
            id: 'select-reverse',
            actorId: 'shifter',
            trigger: { kind: 'at', t: 1 },
            verb: 'set',
            target: { key: 'motion.gear', value: 'reverse' },
          },
        ],
        occluders: [],
      }),
      { graph, guards: 'collect' },
    ).trace;

    const track = trace.ticks.actors['shifter']!;
    // A gearbox cannot select reverse at 12 m/s. The request is pending, never
    // engaged, and the body keeps travelling forward — no momentum teleport.
    expect(new Set(track.motionDirection!)).toEqual(new Set([1]));
    expect(alongOwnHeadingM(track)).toBeGreaterThan(10);
    // The request is recorded; the engagement never happens, and the trace says
    // so by the two gear keys disagreeing rather than by a silent no-op.
    expect(trace.events).toContainEqual(
      expect.objectContaining({ kind: 'state_set', actorId: 'shifter', key: 'motion.gear', value: 'reverse' }),
    );
    expect(trace.events.some(
      (event) => event.kind === 'state_set' && event.key === 'motion.gearEngaged' && event.value === 'reverse',
    )).toBe(false);
  });
});

describe('a parked car told to come out backwards', () => {
  it('reverses along its authored escape path without rotating on the spot', () => {
    const graph = syntheticGraph();
    // A bay 4 m off the lane, nose pointing away from the carriageway. The
    // authored polyline is the escape path: bay → lane centre.
    const bay = { x: 120, y: 6 };
    const exitPoint = { x: 126, y: 0 };
    const trace = runSimulation(
      parseSimScenarioInput({
        mapId: 'synthetic-straight',
        clipSeconds: 10,
        warmupSeconds: 1,
        dt: 0.05,
        seed: 'parked-backs-out',
        actors: [
          {
            id: 'backing',
            kind: 'car',
            dims: { l: 4.8, w: 1.9, h: 1.5 },
            initial: {
              // Parked nose-in: facing *away* from the carriageway, i.e. the
              // opposite of the escape path's direction of travel.
              pose: { x: bay.x, z: -bay.y, headingRad: Math.atan2(bay.y - exitPoint.y, bay.x - exitPoint.x) },
              speedMps: 0,
            },
            behavior: {
              rules: { collisionAvoidance: false },
              route: { kind: 'polyline', points: [{ x: bay.x, z: -bay.y }, { x: exitPoint.x, z: -exitPoint.y }] },
              // A parked car. Triggers do not fire during the unrecorded
              // warm-up, so a non-zero free-flow speed would have it creep out
              // of the bay nose-first before its gear is ever selected.
              cruiseSpeedMps: 0,
            },
            presentAtStart: true,
            tags: [],
          },
        ],
        interactions: [
          {
            // Selecting the gear during the unrecorded warm-up is how an
            // initial gear is authored: no separate spawn-only surface.
            id: 'select-reverse',
            actorId: 'backing',
            trigger: { kind: 'at', t: -1 },
            verb: 'set',
            target: { key: 'motion.gear', value: 'reverse' },
          },
          {
            id: 'back-out',
            actorId: 'backing',
            trigger: { kind: 'at', t: 0 },
            verb: 'speed',
            target: { mode: 'absolute', value: 2 },
            dynamics: { shape: 'linear', constraint: 'time', value: 1 },
          },
        ],
        occluders: [],
      }),
      { graph, guards: 'collect' },
    ).trace;

    const track = trace.ticks.actors['backing']!;
    expect(new Set(track.motionDirection!)).toEqual(new Set([-1]));
    // Rear-first, along the authored escape path, heading held.
    expect(alongOwnHeadingM(track)).toBeLessThan(-3);
    expect(headingSpreadRad(track.headingRad)).toBeLessThan(0.25);
    expect(track.s.at(-1)! - track.s[0]!).toBeGreaterThan(3);

    // Crossing from off-corridor into the carriageway must be observable. A
    // freeform route carries no `rsl`, so the lane binding comes from the graph.
    expect(track.laneRsl[0]).toBeNull();
    expect(track.laneRsl.at(-1)).toBe(LANE_LEFT);
  });
});

describe('dynamic-v1 tyre slip is signed by the direction of travel', () => {
  /** Yaw change produced by holding one steer angle for a second. */
  function yawAfterSteer(motionDirection: 1 | -1, steerCommandRad: number): number {
    const backend = new DynamicV1Backend();
    backend.register({
      actorId: 'v',
      kind: 'car',
      dimensions: { l: 4.8, w: 1.9 },
      motionDirection,
      state: { x: 0, y: 0, yawRad: 0, longitudinalVelocityMps: 2 },
    });
    let last = 0;
    for (let i = 0; i < 100; i++) {
      const state = backend.state('v')!;
      // Aim at a point 6 m away, offset laterally, so the controller commands a
      // steady steer in the requested direction of travel.
      const travelYaw = state.yawRad + (motionDirection === -1 ? Math.PI : 0);
      const previewPoint = {
        x: state.x + Math.cos(travelYaw) * 6 - Math.sin(travelYaw) * steerCommandRad * 6,
        y: state.y + Math.sin(travelYaw) * 6 + Math.cos(travelYaw) * steerCommandRad * 6,
      };
      last = backend.step('v', {
        motionDirection,
        targetSpeedMps: 2,
        targetAccelerationMps2: 0,
        previewPoint,
        previewHeadingRad: travelYaw,
      }, 0.01, 1).state.yawRad;
    }
    return last;
  }

  it('turns the same way, in the travel frame, forwards and backwards', () => {
    // Aiming left of the direction of travel must curve the *travel* left,
    // whichever gear is selected. Before the slip sign was corrected, a
    // reversing body turned the opposite way to the command, so every steering
    // correction was positive feedback and the body peeled off its route.
    expect(yawAfterSteer(1, 0.2)).toBeGreaterThan(0.05);
    expect(yawAfterSteer(-1, 0.2)).toBeGreaterThan(0.05);
    expect(yawAfterSteer(1, -0.2)).toBeLessThan(-0.05);
    expect(yawAfterSteer(-1, -0.2)).toBeLessThan(-0.05);
  });
});
