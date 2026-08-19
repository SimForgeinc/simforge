/**
 * Trigger semantics: `byLatest` / `ifNever`, `after`, `until` release, the
 * occlusion-aware `visible` condition, `exist`, and pedestrian polyline routes.
 */

import { describe, expect, it } from 'vitest';
import { runSimulation } from '../sim/engine.js';
import { buildLaneGraph } from '../map/lane-graph.js';
import { hasLineOfSight, buildOccluders } from '../sim/visibility.js';
import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';

const graph = syntheticGraph();

describe('byLatest / ifNever', () => {
  function unreachable(ifNever: 'skip' | 'fire') {
    return scenario(graph, {
      actors: [vehicle(graph, { id: 'ego', s: 20, speedMps: 12, cruiseSpeedMps: 12 })],
      interactions: [
        {
          id: 'never',
          actorId: 'ego',
          trigger: {
            kind: 'when',
            // The ego never gets near 200 m/s.
            condition: { kind: 'speed', actorId: 'ego', cmp: 'gte', value: 200 },
            byLatest: 8,
            ifNever,
          },
          verb: 'speed',
          target: { mode: 'stop' },
          dynamics: { shape: 'linear', constraint: 'rate', value: 3 },
        },
      ],
    });
  }

  it('skip records the trigger in metrics.triggerNeverFired', () => {
    const { trace } = runSimulation(unreachable('skip'), { graph });
    expect(trace.metrics.triggerNeverFired).toEqual(['never']);
    expect(trace.events.some((e) => e.kind === 'trigger_skipped' && e.interactionId === 'never')).toBe(true);
    expect(trace.ticks.actors['ego']!.speedMps.at(-1)!).toBeCloseTo(12, 1);
  });

  it('fire forces the interaction at byLatest and says so', () => {
    const { trace } = runSimulation(unreachable('fire'), { graph });
    expect(trace.metrics.triggerNeverFired).toEqual([]);
    const fired = trace.events.find((e) => e.kind === 'trigger_fired');
    expect(fired).toMatchObject({ interactionId: 'never', forced: true });
    expect(fired!.t).toBeCloseTo(8, 2);
    expect(trace.ticks.actors['ego']!.speedMps.at(-1)!).toBeLessThan(0.05);
  });

  it('a trigger never evaluated at all still lands in triggerNeverFired', () => {
    const input = scenario(graph, {
      clipSeconds: 5,
      actors: [vehicle(graph, { id: 'ego', s: 20, speedMps: 12, cruiseSpeedMps: 12 })],
      interactions: [
        {
          id: 'late',
          actorId: 'ego',
          trigger: { kind: 'at', t: 40 },
          verb: 'speed',
          target: { mode: 'stop' },
          dynamics: { shape: 'linear', constraint: 'rate', value: 3 },
        },
      ],
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.metrics.triggerNeverFired).toEqual(['late']);
  });
});

describe('actor-relative trigger boundaries', () => {
  it('applies distance hysteresis on the entry side of the threshold', () => {
    const run = (hysteresis: number) => runSimulation(scenario(graph, {
      clipSeconds: 8,
      warmupSeconds: 0,
      actors: [
        vehicle(graph, { id: 'walker-carrier', s: 20, speedMps: 12, cruiseSpeedMps: 12 }),
        vehicle(graph, { id: 'target', s: 50, speedMps: 6, cruiseSpeedMps: 6 }),
      ],
      interactions: [{
        id: 'relative', actorId: 'walker-carrier',
        trigger: { kind: 'when', condition: { kind: 'distance', a: 'walker-carrier', b: 'target', mode: 'euclidean', cmp: 'lte', value: 15, hysteresis }, byLatest: 7, ifNever: 'skip' },
        verb: 'set', target: { key: 'audio.horn', value: true },
      }],
    }), { graph, guards: 'collect' }).trace.events.find((event) => event.kind === 'trigger_fired')?.t;
    const without = run(0)!;
    const withBand = run(2)!;
    expect(withBand).toBeGreaterThan(without);
    expect(withBand - without).toBeGreaterThan(0.1);
  });

  it('fails TTC comparisons closed for a diverging pair', () => {
    const { trace } = runSimulation(scenario(graph, {
      clipSeconds: 4,
      actors: [
        vehicle(graph, { id: 'front', s: 50, speedMps: 12, cruiseSpeedMps: 12 }),
        vehicle(graph, { id: 'rear', s: 20, speedMps: 6, cruiseSpeedMps: 6 }),
      ],
      interactions: [{
        id: 'undefined-ttc', actorId: 'front',
        trigger: { kind: 'when', condition: { kind: 'ttc', a: 'front', b: 'rear', cmp: 'gte', value: 2 }, byLatest: 3, ifNever: 'skip' },
        verb: 'set', target: { key: 'audio.horn', value: true },
      }],
    }), { graph, guards: 'collect' });
    expect(trace.events.some((event) => event.kind === 'trigger_fired' && event.interactionId === 'undefined-ttc')).toBe(false);
    expect(trace.metrics.triggerNeverFired).toContain('undefined-ttc');
  });
});

describe('route commitment timing', () => {
  const branchGraph = buildLaneGraph({
    schemaVersion: 1,
    mapName: 'branch',
    source: { xodrSha256: 'branch' },
    gates: [],
    junctions: {},
    lanes: {
      approach: {
        rsl: 'approach', roadId: 1, section: 0, laneId: -1, laneType: 'driving', isJunction: false, junctionId: null,
        predecessors: [], successors: ['straight', 'turn'], speedLimitKph: 50, representativeWidthM: 3.5,
        widthSamples: [{ s: 0, widthM: 3.5 }, { s: 20, widthM: 3.5 }],
        adjacentLanes: { left: { side: 'left', laneRsl: null, sameDirection: false, permissionIds: [] }, right: { side: 'right', laneRsl: null, sameDirection: false, permissionIds: [] } },
        laneChangePermissions: [], polyline: [{ x: 0, y: 0 }, { x: 20, y: 0 }],
      },
      straight: {
        rsl: 'straight', roadId: 2, section: 0, laneId: -1, laneType: 'driving', isJunction: false, junctionId: null,
        predecessors: ['approach'], successors: [], speedLimitKph: 50, representativeWidthM: 3.5,
        widthSamples: [{ s: 0, widthM: 3.5 }, { s: 40, widthM: 3.5 }],
        adjacentLanes: { left: { side: 'left', laneRsl: null, sameDirection: false, permissionIds: [] }, right: { side: 'right', laneRsl: null, sameDirection: false, permissionIds: [] } },
        laneChangePermissions: [], polyline: [{ x: 20, y: 0 }, { x: 60, y: 0 }],
      },
      turn: {
        rsl: 'turn', roadId: 3, section: 0, laneId: -1, laneType: 'driving', isJunction: false, junctionId: null,
        predecessors: ['approach'], successors: [], speedLimitKph: 50, representativeWidthM: 3.5,
        widthSamples: [{ s: 0, widthM: 3.5 }, { s: 40, widthM: 3.5 }],
        adjacentLanes: { left: { side: 'left', laneRsl: null, sameDirection: false, permissionIds: [] }, right: { side: 'right', laneRsl: null, sameDirection: false, permissionIds: [] } },
        laneChangePermissions: [], polyline: [{ x: 20, y: 0 }, { x: 20, y: 40 }],
      },
    },
  });

  function routedTurn(at: number) {
    const actor = vehicle(branchGraph, { id: 'ego', rsl: 'approach', s: 0, speedMps: 10, cruiseSpeedMps: 10 });
    actor.behavior.route = { kind: 'lanePath', lanes: ['approach', 'straight'] };
    return scenario(branchGraph, {
      clipSeconds: 5,
      warmupSeconds: 0,
      actors: [actor],
      interactions: [{ id: 'turn', actorId: 'ego', trigger: { kind: 'at', t: at }, verb: 'route', target: { kind: 'lanePath', lanes: ['approach', 'turn'] } }],
    });
  }

  it('waits for the shared approach instead of changing a future turn immediately', () => {
    const { trace } = runSimulation(routedTurn(0), { graph: branchGraph, guards: 'collect' });
    const fired = trace.events.find((event) => event.kind === 'trigger_fired' && event.interactionId === 'turn');
    expect(fired?.t).toBeGreaterThan(0);
    expect(fired?.t).toBeLessThan(2);
  });

  it('skips a late future turn after the actor has passed its commitment point', () => {
    const { trace } = runSimulation(routedTurn(3), { graph: branchGraph, guards: 'collect' });
    expect(trace.events).toContainEqual(expect.objectContaining({
      kind: 'trigger_skipped', interactionId: 'turn', reason: 'route_commit_missed',
    }));
    expect(trace.events.some((event) => event.kind === 'trigger_fired' && event.interactionId === 'turn')).toBe(false);
    expect(trace.metrics.triggerNeverFired).toContain('turn');
  });
});

describe('after and until', () => {
  it('after(id, delay) chains off the referenced fire time', () => {
    const input = scenario(graph, {
      actors: [vehicle(graph, { id: 'ego', s: 20, speedMps: 12, cruiseSpeedMps: 12 })],
      interactions: [
        {
          id: 'first',
          actorId: 'ego',
          trigger: { kind: 'at', t: 3 },
          verb: 'speed',
          target: { mode: 'absolute', value: 6 },
          dynamics: { shape: 'linear', constraint: 'time', value: 2 },
        },
        {
          id: 'second',
          actorId: 'ego',
          trigger: { kind: 'after', interactionId: 'first', delayS: 4 },
          verb: 'speed',
          target: { mode: 'absolute', value: 12 },
          dynamics: { shape: 'linear', constraint: 'time', value: 2 },
        },
      ],
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    const times = trace.events.filter((e) => e.kind === 'trigger_fired').map((e) => e.t);
    expect(times[0]).toBeCloseTo(3, 2);
    expect(times[1]).toBeCloseTo(7, 2);
    // The second command preempted the first on the longitudinal axis.
    expect(trace.events.some((e) => e.kind === 'preemption' && e.axis === 'longitudinal')).toBe(true);
    expect(trace.ticks.actors['ego']!.speedMps.at(-1)!).toBeCloseTo(12, 1);
  });

  it('until releases the axis back to default cruise', () => {
    const input = scenario(graph, {
      actors: [vehicle(graph, { id: 'ego', s: 20, speedMps: 12, cruiseSpeedMps: 12 })],
      interactions: [
        {
          id: 'creep',
          actorId: 'ego',
          trigger: { kind: 'at', t: 2 },
          verb: 'speed',
          target: { mode: 'absolute', value: 3 },
          dynamics: { shape: 'linear', constraint: 'rate', value: 3 },
          until: { kind: 'speed', actorId: 'ego', cmp: 'lte', value: 3.5 },
        },
      ],
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    const released = trace.events.find((e) => e.kind === 'released');
    expect(released).toMatchObject({ axis: 'longitudinal', interactionId: 'creep', reason: 'until' });
    // Back on the default cruise law, it returns to 12 m/s.
    expect(trace.ticks.actors['ego']!.speedMps.at(-1)!).toBeCloseTo(12, 1);
  });

  it('after(end) measures from the source window end, not its start', () => {
    const input = scenario(graph, {
      clipSeconds: 10,
      actors: [vehicle(graph, { id: 'ego', s: 20, speedMps: 12, cruiseSpeedMps: 12 })],
      interactions: [
        { id: 'source', actorId: 'ego', trigger: { kind: 'at', t: 2 }, window: { startS: 2, endS: 5 }, verb: 'speed', target: { mode: 'absolute', value: 8 }, dynamics: { shape: 'linear', constraint: 'time', value: 1 } },
        { id: 'after-end', actorId: 'ego', trigger: { kind: 'after', interactionId: 'source', event: 'end', delayS: 0 }, verb: 'set', target: { key: 'audio.horn', value: true } },
      ],
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.events.find((event) => event.kind === 'trigger_fired' && event.interactionId === 'after-end')).toMatchObject({ t: 5 });
  });
});

describe('strict interaction windows', () => {
  const actor = () => vehicle(graph, { id: 'ego', s: 20, speedMps: 12, cruiseSpeedMps: 12 });

  it('waits for the inclusive start and releases a non-lateral command at the end', () => {
    const input = scenario(graph, {
      clipSeconds: 8,
      actors: [actor()],
      interactions: [{
        id: 'windowed', actorId: 'ego',
        trigger: { kind: 'when', condition: { kind: 'speed', actorId: 'ego', cmp: 'gte', value: 0 }, byLatest: 7, ifNever: 'skip' },
        window: { startS: 3, endS: 5 },
        verb: 'speed', target: { mode: 'absolute', value: 2 },
        dynamics: { shape: 'linear', constraint: 'time', value: .5 },
      }],
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.events.find((event) => event.kind === 'trigger_fired')).toMatchObject({ interactionId: 'windowed', t: 3 });
    expect(trace.events.find((event) => event.kind === 'released' && event.interactionId === 'windowed')).toMatchObject({ t: 5, reason: 'window' });
    const at = (time: number) => trace.ticks.t.findIndex((sample) => sample >= time - 1e-9);
    expect(trace.ticks.actors.ego!.speedMps[at(2.9)]!).toBeGreaterThan(10);
  });

  it('marks a missed precondition at the end tick and never executes it later', () => {
    const input = scenario(graph, {
      clipSeconds: 8,
      actors: [actor()],
      interactions: [{
        id: 'missed', actorId: 'ego',
        trigger: { kind: 'when', condition: { kind: 'speed', actorId: 'ego', cmp: 'gte', value: 200 }, byLatest: 7, ifNever: 'fire' },
        window: { startS: 2, endS: 4 },
        verb: 'speed', target: { mode: 'stop' },
        dynamics: { shape: 'linear', constraint: 'time', value: .5 },
      }],
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.events).toContainEqual(expect.objectContaining({ kind: 'trigger_skipped', interactionId: 'missed', t: 4, reason: 'window_elapsed' }));
    expect(trace.events.some((event) => event.kind === 'trigger_fired' && event.interactionId === 'missed')).toBe(false);
    expect(trace.metrics.triggerNeverFired).toContain('missed');
  });

  it('treats the exact end point as outside the half-open eligibility window', () => {
    const input = scenario(graph, {
      clipSeconds: 7, actors: [actor()], interactions: [{
        id: 'endpoint', actorId: 'ego', trigger: { kind: 'at', t: 5 }, window: { startS: 3, endS: 5 },
        verb: 'set', target: { key: 'audio.horn', value: true },
      }],
    });
    const { trace } = runSimulation(input, { graph });
    expect(trace.events).toContainEqual(expect.objectContaining({ kind: 'trigger_skipped', interactionId: 'endpoint', t: 5, reason: 'window_elapsed' }));
  });

  it('resolves incompatible same-axis actions deterministically by sorted id while independent state keys stack', () => {
    const input = scenario(graph, {
      clipSeconds: 5, actors: [actor()], interactions: [
        { id: 'z-fast', actorId: 'ego', trigger: { kind: 'at', t: 1 }, verb: 'speed', target: { mode: 'absolute', value: 15 }, dynamics: { shape: 'step', constraint: 'time', value: .1 } },
        { id: 'a-slow', actorId: 'ego', trigger: { kind: 'at', t: 1 }, verb: 'speed', target: { mode: 'absolute', value: 4 }, dynamics: { shape: 'step', constraint: 'time', value: .1 } },
        { id: 'horn', actorId: 'ego', trigger: { kind: 'at', t: 1 }, verb: 'set', target: { key: 'audio.horn', value: true } },
        { id: 'lights', actorId: 'ego', trigger: { kind: 'at', t: 1 }, verb: 'set', target: { key: 'lights.headlights', value: 'low' } },
      ],
    });
    const first = runSimulation(input, { graph, guards: 'collect' }).trace;
    const second = runSimulation(input, { graph, guards: 'collect' }).trace;
    expect(first.events).toEqual(second.events);
    expect(first.events).toContainEqual(expect.objectContaining({ kind: 'preemption', byInteractionId: 'z-fast', preemptedInteractionId: 'a-slow' }));
    expect(first.events.filter((event) => event.kind === 'state_set' && event.t === 1)).toHaveLength(2);
  });
});

describe('exist', () => {
  it('spawns an absent actor mid-clip and despawns it again', () => {
    const input = scenario(graph, {
      actors: [
        vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 12, cruiseSpeedMps: 12 }),
        vehicle(graph, {
          id: 'ghost',
          rsl: LANE_RIGHT,
          s: 200,
          speedMps: 10,
          cruiseSpeedMps: 10,
          presentAtStart: false,
        }),
      ],
      interactions: [
        {
          id: 'appear',
          actorId: 'ghost',
          trigger: { kind: 'at', t: 4 },
          verb: 'exist',
          target: { state: 'present' },
        },
        {
          id: 'vanish',
          actorId: 'ghost',
          trigger: { kind: 'at', t: 12 },
          verb: 'exist',
          target: { state: 'absent' },
        },
      ],
    });
    const { trace } = runSimulation(input, { graph });
    const present = trace.ticks.actors['ghost']!.present;
    const at = (t: number) => trace.ticks.t.findIndex((v) => v >= t - 1e-9);
    expect(present[at(2)]).toBe(0);
    expect(present[at(6)]).toBe(1);
    expect(present[at(14)]).toBe(0);
    expect(trace.events.some((e) => e.kind === 'spawn' && e.actorId === 'ghost')).toBe(true);
    expect(trace.events.some((e) => e.kind === 'despawn' && e.actorId === 'ghost')).toBe(true);
    // Frozen while absent, moving while present.
    const x = trace.ticks.actors['ghost']!.x;
    expect(x[at(0)]).toBeCloseTo(x[at(3)]!, 6);
    expect(x[at(10)]!).toBeGreaterThan(x[at(6)]! + 30);
  });
});

describe('visible / occluders', () => {
  const occluders = buildOccluders([
    { id: 'van', obb: { center: { x: 100, z: 1.75 }, lengthM: 8, widthM: 2.4, headingRad: 0, heightM: 2.6 } },
  ]);

  it('blocks and clears line of sight geometrically', () => {
    // Straddling the van in y: blocked.
    expect(hasLineOfSight({ x: 100, y: -6 }, { x: 100, y: 4 }, occluders)).toBe(false);
    // Well clear of it: open.
    expect(hasLineOfSight({ x: 130, y: -6 }, { x: 160, y: -6 }, occluders)).toBe(true);
  });

  it('drives a when(visible) trigger and reports reveal-to-conflict', () => {
    const input = scenario(graph, {
      metricSubject: 'ego',
      actors: [
        vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 12, cruiseSpeedMps: 12 }),
        vehicle(graph, { id: 'hidden', rsl: LANE_RIGHT, s: 150, speedMps: 10, cruiseSpeedMps: 10 }),
      ],
      occlusionPairs: [{ observer: 'ego', target: 'hidden', occluderId: 'hoarding' }],
      occluders: [
        // A long hoarding between the lanes, hiding the right lane from the left.
        { id: 'hoarding', obb: { center: { x: 140, z: 1.75 }, lengthM: 120, widthM: 0.6, headingRad: 0, heightM: 3 } },
      ],
      interactions: [
        {
          id: 'react',
          actorId: 'ego',
          trigger: {
            kind: 'when',
            condition: { kind: 'visible', a: 'hidden', to: 'ego', value: true },
            byLatest: 19,
            ifNever: 'skip',
          },
          verb: 'speed',
          target: { mode: 'delta', value: -4 },
          dynamics: { shape: 'cubic', constraint: 'rate', value: 3 },
        },
      ],
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.metrics.triggerNeverFired).toEqual([]);
    const fired = trace.events.find((e) => e.kind === 'trigger_fired');
    expect(fired!.t).toBeGreaterThan(0);
    expect(trace.metrics.declaredOcclusion).toEqual([
      expect.objectContaining({ status: 'revealed_before_conflict', losOpenT: fired!.t }),
    ]);
    // These are parallel lanes with no physical conflict; LOS evidence must
    // not manufacture a global criticality record.
    expect(trace.metrics.revealToConflict).toBeNull();
  });
});

describe('pedestrians', () => {
  it('walks a polyline crossing and remains at the far kerb for aftermath', () => {
    const input = scenario(graph, {
      clipSeconds: 14,
      actors: [
        {
          id: 'walker',
          kind: 'pedestrian',
          dims: { l: 0.6, w: 0.6, h: 1.75 },
          initial: {
            // Scene frame: z = -y, so this walks from y=-20 to y=+4 in local.
            pose: { x: 120, z: 20, headingRad: Math.PI / 2 },
            speedMps: 1.4,
          },
          behavior: {
            route: {
              kind: 'polyline',
              points: [
                { x: 120, z: 20 },
                { x: 120, z: -4 },
              ],
            },
            cruiseSpeedMps: 1.4,
          },
        },
      ],
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    const track = trace.ticks.actors['walker']!;
    expect(track.laneRsl[0]).toBeNull();
    // The 5 s prologue already walked 7 m of the 24 m path.
    expect(track.y[0]!).toBeCloseTo(-20 + 1.4 * 5, 2);
    // The remaining 17 m at 1.4 m/s take 12.1 s, inside the 14 s clip.
    expect(track.y.at(-1)!).toBeCloseTo(4, 1);
    expect(track.present.at(-1)).toBe(1);
    expect(track.speedMps.at(-1)).toBe(0);
    expect(trace.events.some((e) => e.kind === 'despawn' && e.actorId === 'walker')).toBe(false);
  });

  it('stays visible to conditions once her route motion has finished', () => {
    // A pedestrian waiting for her crossing to be installed, or standing at the
    // far kerb afterwards, is `retired` but still physically present and still
    // recorded in the trace. Conditions must see her: "step out when the car is
    // 30 m away" is the whole of a hesitating crossing, and it is unauthorable
    // if a stationary pedestrian reads as absent.
    const input = scenario(graph, {
      clipSeconds: 8,
      warmupSeconds: 0,
      actors: [
        vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 12, cruiseSpeedMps: 12 }),
        {
          id: 'walker',
          kind: 'pedestrian',
          dims: { l: 0.6, w: 0.6, h: 1.75 },
          // Spawned on the last metre of her path: she finishes it in the first
          // second and is retired for the rest of the clip.
          initial: { pose: { x: 120, z: 6, headingRad: Math.PI / 2 }, speedMps: 1.4 },
          behavior: {
            route: { kind: 'polyline', points: [{ x: 120, z: 6 }, { x: 120, z: 5 }] },
            cruiseSpeedMps: 1.4,
          },
        },
      ],
      interactions: [{
        id: 'horn',
        actorId: 'ego',
        trigger: {
          kind: 'when',
          condition: { kind: 'distance', a: 'ego', b: 'walker', mode: 'euclidean', cmp: 'lte', value: 30 },
          byLatest: 7,
          ifNever: 'skip',
        },
        verb: 'set',
        target: { key: 'audio.horn', value: true },
      }],
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    const walker = trace.ticks.actors['walker']!;
    // Retired: present, parked at the end of her path, not moving.
    expect(walker.present.at(-1)).toBe(1);
    expect(walker.speedMps.at(-1)).toBe(0);
    const fired = trace.events.find((e) => e.kind === 'trigger_fired' && e.interactionId === 'horn');
    expect(fired).toBeDefined();
    expect(fired!.t).toBeGreaterThan(1);
    expect(trace.metrics.triggerNeverFired).toEqual([]);
  });
});
