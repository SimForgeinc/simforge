/** Exact topology and runtime closure for the curated ambulance corridor. */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildLanePathRoute, runSimulation } from '@uniscenarios/sim-engine';

import { DEV_ASSETS, REPO_ROOT, loadMap } from '@uniscenarios/scenario-materializer';
import { readInstance } from '@uniscenarios/scenario-materializer';

const MAP = 'yale-street';
const INSTANCE = path.join(
  REPO_ROOT,
  'examples',
  'edge-cases',
  '03-red-light-ambulance-preemption',
  'scenario.instance.json',
);
const haveArtifacts =
  existsSync(path.join(DEV_ASSETS, MAP, 'topology-index.json.gz')) &&
  existsSync(INSTANCE);

describe.skipIf(!haveArtifacts)('red-light ambulance preemption route', () => {
  it('uses a legal drivable corridor through the intended straight junction gate', async () => {
    const [bundle, instance] = await Promise.all([loadMap(MAP), readInstance(INSTANCE)]);
    const ambulance = instance.input.actors.find((actor) => actor.id === 'ambulance')!;
    const focus = instance.input.actors.find((actor) => actor.id === 'focus-vehicle')!;

    expect(ambulance.initial.laneRef).toMatchObject({ rsl: '93:0:1', s: 13.734383391386212 });
    expect(ambulance.behavior.route.kind).toBe('lanePath');
    if (ambulance.behavior.route.kind !== 'lanePath') throw new Error('ambulance route must be lane-bound');

    const built = buildLanePathRoute(bundle.graph, ambulance.behavior.route.lanes);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.error.reason);

    for (const leg of built.route.legs) {
      expect(bundle.graph.requireGeometry(leg.rsl).lane.laneType).toBe('driving');
      const nominal = bundle.graph.nominalReversed(leg.rsl);
      if (nominal !== null) expect(leg.reversed).toBe(nominal);
    }
    for (let index = 0; index < built.route.legs.length - 1; index += 1) {
      const leg = built.route.legs[index]!;
      const next = built.route.legs[index + 1]!;
      expect(bundle.graph.successors(leg)).toContainEqual({ rsl: next.rsl, reversed: next.reversed });
    }

    const gate = bundle.topology.gates.find((candidate) => candidate.id === '1201:0:1-1');
    expect(gate).toMatchObject({
      junctionId: '1201',
      approachLaneRsl: '93:0:1',
      connectingLaneRsl: '1207:0:1',
      exitLaneRsls: ['92:0:1'],
      turnRelation: 'Straight',
    });
    expect(ambulance.behavior.route.lanes).toEqual(expect.arrayContaining([
      gate!.approachLaneRsl,
      gate!.connectingLaneRsl,
      gate!.exitLaneRsls[0]!,
    ]));

    const spawnRouteS = built.route.sOfLaneStorage(
      ambulance.initial.laneRef!.rsl,
      ambulance.initial.laneRef!.s,
    );
    const focusProjection = built.route.projectPoint({
      x: focus.initial.pose.x,
      y: -focus.initial.pose.z,
    });
    expect(spawnRouteS).not.toBeNull();
    expect(focusProjection.s - spawnRouteS!).toBeCloseTo(7.2825, 4);

    const result = runSimulation(instance.input, { graph: bundle.graph, guards: 'collect' });
    const ambulanceInteractionIds = new Set(instance.input.interactions
      .filter((interaction) => interaction.actorId === 'ambulance')
      .map((interaction) => interaction.id));
    expect(result.issues.filter((candidate) =>
      candidate.detail?.['actorId'] === 'ambulance' || candidate.path.includes('ambulance'))).toEqual([]);
    expect(result.trace.metrics.collisions.filter((collision) =>
      collision.a === 'ambulance' || collision.b === 'ambulance')).toEqual([]);
    expect(result.trace.metrics.triggerNeverFired.filter((interactionId) =>
      ambulanceInteractionIds.has(interactionId))).toEqual([]);
    expect(result.trace.events.some((event) =>
      event.kind === 'road_departure_prevented' && event.actorId === 'ambulance')).toBe(false);
    const track = result.trace.ticks.actors.ambulance!;
    const connectorIndex = track.laneRsl.indexOf('1207:0:1');
    const exitIndex = track.laneRsl.indexOf('92:0:1');
    const downstreamIndex = track.laneRsl.indexOf('1181:0:1');
    const finalPresentIndex = track.present.lastIndexOf(1);
    expect(connectorIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThan(connectorIndex);
    expect(downstreamIndex).toBeGreaterThan(exitIndex);
    expect(finalPresentIndex).toBeGreaterThanOrEqual(downstreamIndex);

    const ambulanceEvents = result.trace.events.filter((event) =>
      'actorId' in event && event.actorId === 'ambulance');
    const completed = ambulanceEvents.filter((event) => event.kind === 'interaction_completed');
    expect(completed.map((event) => event.interactionId)).toEqual(expect.arrayContaining([
      'ambulance-enters-refuge',
      'ambulance-centers-for-junction',
    ]));
    expect(ambulanceEvents.filter((event) =>
      event.kind === 'interaction_aborted' || event.kind === 'trigger_skipped')).toEqual([]);
    const despawns = ambulanceEvents.filter((event) => event.kind === 'despawn');
    expect(despawns).toEqual([{ t: 18.14, kind: 'despawn', actorId: 'ambulance', reason: 'interaction' }]);
    expect(track.present.slice(finalPresentIndex + 1).every((present) => present === 0)).toBe(true);

    // Independent footprint closure: every oriented ambulance corner must lie
    // inside the union of map-authored driving-lane strips while it is present.
    // This does not consult the runtime's departure guard or authored offset.
    const drivingLanes = bundle.graph.laneRsls().flatMap((rsl) => {
      const geometry = bundle.graph.requireGeometry(rsl);
      if (geometry.lane.laneType !== 'driving') return [];
      const maxHalfWidth = Math.max(
        geometry.widthM,
        ...(geometry.lane.widthSamples ?? []).map((sample) => sample.widthM),
      ) / 2;
      const xs = geometry.points.map((point) => point.x);
      const ys = geometry.points.map((point) => point.y);
      return [{
        rsl,
        maxHalfWidth,
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
      }];
    });
    let minimumFootprintMarginM = Number.POSITIVE_INFINITY;
    let minimumAt = -1;
    for (let index = 0; index <= finalPresentIndex; index += 1) {
      if (track.present[index] !== 1) continue;
      const heading = track.headingRad[index]!;
      const forwardX = Math.cos(heading);
      const forwardY = Math.sin(heading);
      const leftX = -forwardY;
      const leftY = forwardX;
      for (const longitudinalSign of [-1, 1]) {
        for (const lateralSign of [-1, 1]) {
          const point = {
            x: track.x[index]!
              + longitudinalSign * forwardX * ambulance.dims.l / 2
              + lateralSign * leftX * ambulance.dims.w / 2,
            y: track.y[index]!
              + longitudinalSign * forwardY * ambulance.dims.l / 2
              + lateralSign * leftY * ambulance.dims.w / 2,
          };
          let unionMarginM = Number.NEGATIVE_INFINITY;
          for (const lane of drivingLanes) {
            if (point.x < lane.minX - lane.maxHalfWidth || point.x > lane.maxX + lane.maxHalfWidth
              || point.y < lane.minY - lane.maxHalfWidth || point.y > lane.maxY + lane.maxHalfWidth) continue;
            const projection = bundle.graph.projectOnto(lane.rsl, point);
            if (!projection) continue;
            unionMarginM = Math.max(
              unionMarginM,
              bundle.graph.widthAt(lane.rsl, projection.s) / 2 - projection.d,
            );
          }
          if (unionMarginM < minimumFootprintMarginM) {
            minimumFootprintMarginM = unionMarginM;
            minimumAt = index;
          }
        }
      }
    }
    expect({ minimumFootprintMarginM, t: result.trace.ticks.t[minimumAt] }).toMatchObject({
      minimumFootprintMarginM: expect.any(Number),
    });
    expect(minimumFootprintMarginM).toBeGreaterThan(0.1);

    for (let index = 1; index <= finalPresentIndex; index += 1) {
      const displacementM = Math.hypot(
        track.x[index]! - track.x[index - 1]!,
        track.y[index]! - track.y[index - 1]!,
      );
      expect(displacementM).toBeLessThan(0.5);
    }
  }, 30_000);
});
