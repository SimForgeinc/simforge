import { describe, expect, it } from 'vitest';
import { parseTemplate, TemplateDocument } from '@simforge/scenario';
import { materializeMapBound } from '@simforge/compiler/node';
import { buildSeededPlacementRoute, createFixedStepSimulation, runSimulation } from '@simforge/engine';
import { loadMap } from '@simforge/compiler/node';
import { localMapAssetRequirement } from './asset-test-utils.js';

const studioMapAssets = localMapAssetRequirement(['yale-st-palo-alto-ca', 'belmont-office-park-belmont-ca']);
function xy(point: { x: number; y: number } | readonly [number, number]): { x: number; y: number } {
  return Array.isArray(point) ? { x: point[0]!, y: point[1]! } : point as { x: number; y: number };
}

describe.skipIf(!studioMapAssets.available)(`map-bound Studio materialization${studioMapAssets.missingReason}`, () => {
  it('materializes a browser-created fresh scenario with no actors', async () => {
    const bundle = await loadMap('belmont-office-park-belmont-ca');
    const document = TemplateDocument.create({
      name: 'Fresh Belmont scenario',
      sourceMap: { mapId: bundle.mapId, mapName: 'Belmont Research Center' },
      anchor: { features: [], pin: { mapId: bundle.mapId } },
    });
    document.setClip(undefined, 0);

    const product = materializeMapBound(document.toJSON(), bundle);

    expect(product.manifest.feasible).toBe(true);
    expect(product.manifest.replayKey.siteId).toBe(`studio:${bundle.mapId}`);
    expect(product.input.actors).toEqual([]);
    expect(product.input.clipSeconds).toBe(20);
  }, 30_000);

  it('compiles the actor-owned initial lanePath and exact 30 mph profile without timeline indirection', async () => {
    const bundle = await loadMap('yale-st-palo-alto-ca');
    const actorId = 'vehicle-random-turns';
    const candidate = Object.values(bundle.topology.lanes)
      .filter((lane) => lane.laneType === 'driving')
      .sort((a, b) => a.rsl.localeCompare(b.rsl))
      .map((lane) => ({
        lane,
        planned: buildSeededPlacementRoute(bundle.graph, {
          startRsl: lane.rsl,
          startStorageS: 0,
          requiredDownstreamM: 350,
          seed: 'studio-random-turns-materializer',
          actorId,
        }),
      }))
      .find((item) => item.planned.ok);
    expect(candidate).toBeDefined();
    if (!candidate || !candidate.planned.ok) throw new Error('test map has no 350 m connected driving route');
    const spawnS = candidate.planned.route.sOfLaneStorage(candidate.lane.rsl, 0)!;
    const spawn = candidate.planned.route.poseAt(spawnS);
    const [roadId, section, laneId] = candidate.lane.rsl.split(':');
    const exactKph = 13.4112 * 3.6;
    const doc = TemplateDocument.create({
      name: 'Random turns materializer',
      sourceMap: { mapId: bundle.mapId, mapName: bundle.mapId },
      anchor: { features: [], pin: { mapId: bundle.mapId } },
    });
    doc.addRole({
      id: actorId,
      kind: 'scene_absolute',
      actor: { class: 'car', catalogId: 'vehicle.sedan', static: false, sensors: [] },
      initialSpeedKph: exactKph,
      pose: { position: { x: spawn.point.x, y: 0, z: -spawn.point.y }, headingRad: spawn.headingRad },
      laneRef: { roadId: roadId!, section: Number(section), laneId: Number(laneId), s: 0, t: 0, headingOffsetRad: 0 },
      initialRoute: { mode: 'lanePath', lanes: [...candidate.planned.lanes] },
      essentiality: 'required',
    });
    doc.addInteraction({
      id: `speed_${actorId}_initial`, actor: actorId, label: '30 mph',
      trigger: { kind: 'at', t: 0 }, verb: 'speed',
      target: { mode: 'absolute', valueKph: exactKph },
      dynamics: { shape: 'linear', constraint: 'time', value: 0.25 },
    });

    const product = materializeMapBound(doc.toJSON(), bundle);
    const actor = product.input.actors.find((item) => item.id === actorId)!;
    expect(actor.initial.speedMps).toBe(13.4112);
    expect(actor.behavior.cruiseSpeedMps).toBe(13.4112);
    expect(actor.behavior.route).toEqual({ kind: 'lanePath', lanes: candidate.planned.lanes });
    expect(product.input.interactions.some((item) => item.id === `route_${actorId}_initial`)).toBe(false);
    expect(product.manifest.notes.some((note) => note.path.includes(`route_${actorId}_initial`))).toBe(false);

    const canonicalRole = doc.role(actorId)!;
    if (canonicalRole.kind !== 'scene_absolute') throw new Error('test actor must be scene_absolute');
    const { initialRoute: _initialRoute, ...legacyRole } = canonicalRole;
    const legacyProduct = materializeMapBound(parseTemplate({
      ...doc.toJSON(),
      roles: [legacyRole],
      choreography: {
        ...doc.data.choreography,
        interactions: [{
          id: `route_${actorId}_initial`, actor: actorId, label: 'Random turns',
          trigger: { kind: 'at', t: 0 }, verb: 'route',
          target: { mode: 'lanePath', lanes: [...candidate.planned.lanes] },
        }, ...doc.data.choreography.interactions],
      },
    }), bundle);
    expect(legacyProduct.input.actors.find((item) => item.id === actorId)?.behavior.route).toEqual(actor.behavior.route);
    expect(legacyProduct.manifest.notes).toContainEqual(expect.objectContaining({
      path: `choreography.interactions.route_${actorId}_initial`, impact: 'informational',
    }));
    const result = runSimulation(product.input, { graph: bundle.graph, guards: 'throw' });
    expect(result.trace.ticks.t.at(-1)).toBe(20);
    const speedTrack = result.trace.ticks.actors[actorId]!.speedMps;
    // The profile is authored at exactly 30 mph, while dynamic playback may
    // slow for map controls or route geometry before the clip ends.
    expect(speedTrack[0]).toBeCloseTo(13.4112, 3);
    expect(Math.max(...speedTrack)).toBeLessThanOrEqual(13.4112 * 1.05);
    expect(result.trace.metrics.collisions).toEqual([]);
  }, 30_000);

  it('materializes a freshly placed v2 vehicle and simulates the exact clip duration', async () => {
    const bundle = await loadMap('yale-st-palo-alto-ca');
    const lane = Object.values(bundle.topology.lanes)
      .filter((candidate) => candidate.laneType === 'driving' && candidate.polyline.length >= 2)
      .sort((a, b) => a.rsl.localeCompare(b.rsl))[0]!;
    const point = xy(lane.polyline[0]!);
    const next = xy(lane.polyline[1]!);
    const headingRad = Math.atan2(next.y - point.y, next.x - point.x);
    const doc = TemplateDocument.create({
      name: 'fresh Studio placement',
      sourceMap: { mapId: bundle.mapId, mapName: bundle.mapId },
      anchor: { features: [], pin: { mapId: bundle.mapId } },
    });
    doc.addRole({
      id: 'vehicle-1',
      kind: 'scene_absolute',
      actor: { class: 'car', catalogId: 'vehicle.sedan', static: false, sensors: [] },
      pose: { position: { x: point.x, y: 0, z: -point.y }, headingRad },
      laneRef: { roadId: String(lane.roadId), section: lane.section, laneId: lane.laneId, s: 0, t: 0, headingOffsetRad: 0 },
      essentiality: 'required',
    });
    const product = materializeMapBound(doc.toJSON(), bundle);
    expect(product.manifest.notes).toEqual([]);
    expect(product.input.actors.map((actor) => actor.id)).toEqual(['vehicle-1']);
    const result = runSimulation(product.input, { graph: bundle.graph, guards: 'throw' });
    expect(result.trace.ticks.t.at(-1)).toBe(product.input.clipSeconds);
    expect(result.trace.header.inputHash).toBe(product.manifest.inputHash);
  }, 30_000);

  it('uses the full choreography and prop compiler for authored map-bound actors', async () => {
    const bundle = await loadMap('yale-st-palo-alto-ca');
    const lane = Object.values(bundle.topology.lanes)
      .filter((candidate) => candidate.laneType === 'driving' && candidate.polyline.length >= 2 && candidate.polyline.length >= 2)
      .sort((a, b) => b.polyline.length - a.polyline.length || a.rsl.localeCompare(b.rsl))[0]!;
    const point = xy(lane.polyline[0]!);
    const next = xy(lane.polyline[1]!);
    const headingRad = Math.atan2(next.y - point.y, next.x - point.x);
    const doc = TemplateDocument.create({
      name: 'Studio choreography',
      sourceMap: { mapId: bundle.mapId, mapName: bundle.mapId },
      anchor: { features: [], pin: { mapId: bundle.mapId } },
    });
    const role = (id: string, s: number) => ({
      id,
      kind: 'scene_absolute' as const,
      actor: { class: 'car' as const, catalogId: 'vehicle.sedan', static: false, sensors: [] },
      pose: { position: { x: point.x, y: 0, z: -point.y }, headingRad },
      laneRef: { roadId: String(lane.roadId), section: lane.section, laneId: lane.laneId, s, t: 0, headingOffsetRad: 0 },
      essentiality: 'required' as const,
    });
    doc.addRole(role('vehicle-1', 0));
    doc.addRole(role('vehicle-2', Math.min(20, bundle.graph.geometry(lane.rsl)!.lengthM / 2)));
    doc.addInteraction({
      id: 'accelerate', actor: 'vehicle-1', verb: 'speed', trigger: { kind: 'at', t: 1 },
      target: { mode: 'absolute', valueKph: 8 }, dynamics: { shape: 'linear', constraint: 'time', value: 1 },
      until: { kind: 'when', condition: { kind: 'speed', of: 'vehicle-1', op: '>=', valueKph: 7 }, byLatest: 4, ifNever: 'fire' },
    });
    doc.addInteraction({
      id: 'indicator', actor: 'vehicle-1', verb: 'set',
      trigger: { kind: 'after', of: 'accelerate', event: 'start', delayS: 0.2 },
      target: { key: 'lights.indicator', value: 'left' },
    });
    doc.addInteraction({
      id: 'despawn', actor: 'vehicle-2', verb: 'exist',
      trigger: { kind: 'when', condition: { kind: 'distance', from: 'vehicle-1', to: { role: 'vehicle-2' }, measure: 'euclidean', op: '<=', valueM: 100 }, byLatest: 2, ifNever: 'fire' },
      target: { state: 'absent' },
    });
    doc.addInteraction({
      id: 'offset', actor: 'vehicle-1', verb: 'laneOffset', trigger: { kind: 'at', t: 3 },
      target: { tFrac: 0.2, reference: 'lane_center' }, dynamics: { shape: 'sinusoidal', constraint: 'time', value: 1 },
    });
    doc.addInteraction({
      id: 'reroute', actor: 'vehicle-1', verb: 'route', trigger: { kind: 'at', t: 5 },
      target: { mode: 'polyline', points: [
        { laneOffset: 0, s: 10, tFrac: 0, headingOffsetRad: 0 },
        { laneOffset: 0, s: 40, tFrac: 0, headingOffsetRad: 0 },
      ] },
    });
    const template = parseTemplate({
      ...doc.toJSON(),
      props: [{ id: 'box-1', catalogId: 'hazard.cardboard_box', pose: { laneOffset: 0, s: 30, tFrac: 0, headingOffsetRad: 0 }, essentiality: 'required' }],
    });
    const product = materializeMapBound(template, bundle);
    expect(product.input.interactions.map((interaction) => interaction.id).sort()).toEqual(
      ['accelerate', 'despawn', 'indicator', 'offset', 'reroute'].sort(),
    );
    expect(product.input.props.map((prop) => prop.id)).toEqual(['box-1']);
    const result = runSimulation(product.input, { graph: bundle.graph, guards: 'collect' });
    expect(result.trace.events.some((event) => event.kind === 'state_set' && event.actorId === 'vehicle-1')).toBe(true);
    expect(result.trace.ticks.actors['vehicle-2']!.present.at(-1)).toBe(0);
    expect(result.trace.ticks.t.at(-1)).toBe(product.input.clipSeconds);
  }, 30_000);

  it('resolves arrival triggers and compiles lane changes on authored lane actors', async () => {
    const bundle = await loadMap('yale-st-palo-alto-ca');
    const lane = Object.values(bundle.topology.lanes)
      .filter((candidate) => candidate.laneType === 'driving' && candidate.polyline.length >= 2)
      .find((candidate) => candidate.adjacentLanes?.left?.sameDirection || candidate.adjacentLanes?.right?.sameDirection)!;
    const point = xy(lane.polyline[0]!);
    const next = xy(lane.polyline[1]!);
    const headingRad = Math.atan2(next.y - point.y, next.x - point.x);
    const doc = TemplateDocument.create({
      name: 'Studio arrival and lane change',
      sourceMap: { mapId: bundle.mapId, mapName: bundle.mapId },
      anchor: { features: [], pin: { mapId: bundle.mapId } },
    });
    for (const [id, s] of [['vehicle-1', 0], ['vehicle-2', 20]] as const) {
      doc.addRole({
        id, kind: 'scene_absolute', actor: { class: 'car', catalogId: 'vehicle.sedan', static: false, sensors: [] }, initialSpeedKph: 12,
        pose: { position: { x: point.x, y: 0, z: -point.y }, headingRad },
        laneRef: { roadId: String(lane.roadId), section: lane.section, laneId: lane.laneId, s, t: 0, headingOffsetRad: 0 },
        essentiality: 'required',
      });
    }
    doc.addInteraction({
      id: 'arrival-brake', actor: 'vehicle-1', verb: 'speed',
      trigger: {
        kind: 'arrival', of: 'vehicle-1',
        at: { pose: { laneOffset: 0, s: 60, tFrac: 0, headingOffsetRad: 0 } },
        syncWith: 'vehicle-2', deltaT: 1,
      },
      target: { mode: 'stop' }, dynamics: { shape: 'linear', constraint: 'time', value: 2 },
    });
    doc.addInteraction({
      id: 'change-lane', actor: 'vehicle-1', verb: 'changeLane', trigger: { kind: 'at', t: 4 },
      target: { mode: 'relative', dk: lane.adjacentLanes?.left?.sameDirection ? 1 : -1 },
      dynamics: { shape: 'sinusoidal', constraint: 'time', value: 2 },
    });
    const product = materializeMapBound(doc.toJSON(), bundle);
    expect(product.manifest.arrival.some((solution) => solution.interactionId === 'arrival-brake')).toBe(true);
    expect(product.input.interactions.find((interaction) => interaction.id === 'arrival-brake')?.trigger.kind).toBe('at');
    expect(product.input.interactions.find((interaction) => interaction.id === 'change-lane')).toMatchObject({ verb: 'changeLane' });
  }, 30_000);

  it('keeps two distinct Belmont authoring poses exact at Play t=0', async () => {
    const bundle = await loadMap('belmont-office-park-belmont-ca');
    const speedKph = 48.28032;
    const requiredDownstreamM = speedKph / 3.6 * 20 + 10;
    const usable = Object.values(bundle.topology.lanes)
      .filter((lane) => lane.laneType === 'driving')
      .sort((a, b) => a.rsl.localeCompare(b.rsl))
      .flatMap((lane, ordinal) => {
        const storageS = (lane.widthSamples?.at(-1)?.s ?? 0) * (ordinal % 2 ? .25 : .65);
        const planned = buildSeededPlacementRoute(bundle.graph, {
          startRsl: lane.rsl, startStorageS: storageS, requiredDownstreamM,
          seed: 'belmont-two-car-t0', actorId: `authored-${ordinal}`,
        });
        return planned.ok ? [{ lane, storageS, planned }] : [];
      });
    const first = usable[0]!;
    const firstRouteS = first.planned.route.sOfLaneStorage(first.lane.rsl, first.storageS)!;
    const firstPoint = first.planned.route.poseAt(firstRouteS).point;
    const second = usable.find((candidate) => {
      const routeS = candidate.planned.route.sOfLaneStorage(candidate.lane.rsl, candidate.storageS)!;
      const point = candidate.planned.route.poseAt(routeS).point;
      return Math.hypot(point.x - firstPoint.x, point.y - firstPoint.y) > 100;
    })!;
    const doc = TemplateDocument.create({
      name: 'Belmont exact authoring t0', sourceMap: { mapId: bundle.mapId, mapName: bundle.mapId },
      anchor: { features: [], pin: { mapId: bundle.mapId } },
    });
    doc.setClip(20, 0);
    for (const [ordinal, candidate] of [first, second].entries()) {
      const id = `authored-car-${ordinal + 1}`;
      const routeS = candidate.planned.route.sOfLaneStorage(candidate.lane.rsl, candidate.storageS)!;
      const pose = candidate.planned.route.poseAt(routeS);
      const [roadId, section, laneId] = candidate.lane.rsl.split(':');
      doc.addRole({
        id, kind: 'scene_absolute', actor: { class: 'car', catalogId: 'vehicle.sedan', static: false, sensors: [] },
        initialSpeedKph: speedKph,
        pose: { position: { x: pose.point.x, y: 0, z: -pose.point.y }, headingRad: pose.headingRad },
        laneRef: { roadId: roadId!, section: Number(section), laneId: Number(laneId), s: candidate.storageS, t: 0, headingOffsetRad: 0 },
        initialRoute: { mode: 'lanePath', lanes: [...candidate.planned.lanes] }, essentiality: 'required',
      });
    }

    const product = materializeMapBound(doc.toJSON(), bundle);
    const play = (): ReturnType<typeof createFixedStepSimulation> => createFixedStepSimulation(product.input, { graph: bundle.graph, guards: 'throw' });
    const firstPlay = play().advance(2, { trace: true }).trace!;
    const resetPlay = play().advance(2, { trace: true }).trace!;

    for (const actor of product.input.actors) {
      const role = doc.role(actor.id)!;
      if (role.kind !== 'scene_absolute') throw new Error('fixture role must be scene_absolute');
      const track = firstPlay.ticks.actors[actor.id]!;
      expect(actor.initial.pose).toMatchObject({ x: role.pose.position.x, z: role.pose.position.z });
      expect(firstPlay.ticks.t[0]).toBe(0);
      expect(Math.hypot(track.x[0]! - role.pose.position.x, -track.y[0]! - role.pose.position.z)).toBeLessThan(1e-9);
      expect(Math.hypot(track.x[1]! - track.x[0]!, track.y[1]! - track.y[0]!)).toBeLessThan(speedKph / 3.6 * product.input.dt * 1.1);
      expect(resetPlay.ticks.actors[actor.id]!.x[0]).toBe(track.x[0]);
      expect(resetPlay.ticks.actors[actor.id]!.y[0]).toBe(track.y[0]);
    }
  }, 30_000);
});
