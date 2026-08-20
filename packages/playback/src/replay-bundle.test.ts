import {
  exportOpenScenarioXml14,
  extractOpenScenarioExecutionPlan,
} from '../../openscenario/src/index.js';
import { buildLaneGraph, parseSimScenarioInput, type TopologyIndex } from '@uniscenarios/sim-engine';
import { describe, expect, it } from 'vitest';

import { canonicalPreviewIdentity, samplePlaybackActors, samplePlaybackSignals } from './model';
import { playbackBundleFromReplay } from './replay-bundle';

const SOURCE_DIGEST = 'a'.repeat(64);
const GRAPH_DIGEST = 'b'.repeat(64);
const graph = buildLaneGraph({
  schemaVersion: 1,
  mapName: 'map.test',
  source: { xodrSha256: 'fixture' },
  lanes: {},
  gates: [],
  junctions: {},
} satisfies TopologyIndex);

function planFixture() {
  const scenario = parseSimScenarioInput({
    mapId: 'map.test',
    clipSeconds: 2,
    warmupSeconds: 0.5,
    dt: 0.1,
    physics: { mode: 'kinematic-v1' },
    operationalConditions: {
      weather: 'clear',
      timeOfDay: 'day',
      visibility: 'unrestricted',
      traffic: 'moderate',
      effects: { frictionScale: 1, visibilityRangeM: 10_000, trafficSpeedFactor: 1 },
    },
    actors: [
      {
        id: 'ego',
        kind: 'bus',
        dims: { l: 4.8, w: 1.9, h: 1.5 },
        tags: ['catalog:vehicle.bus'],
        initial: { pose: { x: 0, z: -2, headingRad: 0 }, speedMps: 2 },
        behavior: { route: { kind: 'polyline', points: [{ x: 0, z: -2 }, { x: 20, z: 2 }] } },
      },
      {
        id: 'pedestrian',
        kind: 'pedestrian',
        dims: { l: 0.6, w: 0.5, h: 1.75 },
        initial: { pose: { x: 10, z: -5, headingRad: 0 }, speedMps: 1 },
        behavior: { route: { kind: 'polyline', points: [{ x: 10, z: -5 }, { x: 13, z: -5 }] } },
      },
    ],
    interactions: [{
      id: 'despawn-pedestrian',
      actorId: 'pedestrian',
      trigger: { kind: 'at', t: 1 },
      verb: 'exist',
      target: { state: 'absent' },
    }],
    signalPrograms: [{
      id: 'main-signal',
      phases: [
        { phase: 'red', durationS: 0.5 },
        { phase: 'green', durationS: 1 },
        { phase: 'yellow', durationS: 0.5 },
      ],
      offsetS: 0,
      loop: true,
      mapBinding: {
        junctionId: 'junction-1',
        controllerIds: ['controller-1'],
        headIds: ['signal-head-7'],
        controllerHeadGroups: [{ controllerId: 'controller-1', headIds: ['signal-head-7'] }],
        timingSource: 'authored',
      },
    }],
  });
  const exported = exportOpenScenarioXml14(scenario, {
    graph,
    executionMode: 'trajectory-replay',
    roadFile: 'maps/test.xodr',
  });
  return extractOpenScenarioExecutionPlan(exported.content, { sourceSha256: SOURCE_DIGEST });
}

describe('playbackBundleFromReplay', () => {
  it('maps the validated exporter plan, clip bounds, visuals, conditions, and provenance', () => {
    const plan = planFixture();
    const bundle = playbackBundleFromReplay(plan, {
      mapId: plan.mapId,
      engineGraphDigest: GRAPH_DIGEST,
    });

    expect(bundle.startTime).toBe(plan.warmupSeconds);
    expect(bundle.endTime).toBe(plan.stopTimeS);
    expect(bundle.instance.input).toMatchObject({
      warmupSeconds: plan.warmupSeconds,
      clipSeconds: plan.clipSeconds,
      operationalConditions: plan.environment.authored,
    });
    expect(bundle.trace.header).toMatchObject({
      source: 'openscenario-replay',
      sourceXoscSha256: SOURCE_DIGEST,
      inputHash: plan.inputHash,
      mapId: 'map.test',
      engineGraphDigest: GRAPH_DIGEST,
    });
    expect(bundle.instance.manifest.inputHash).toBe(plan.inputHash);
    expect(canonicalPreviewIdentity(bundle)).toMatchObject({
      inputHash: plan.inputHash,
      traceInputHash: plan.inputHash,
      hashBound: true,
      complete: true,
    });
    expect(bundle.actors.map(({ id, entityName, catalogId, modelBasis, kind, static: isStatic, dims, tags }) => ({
      id, entityName, catalogId, modelBasis, kind, static: isStatic, dims, tags,
    }))).toEqual(plan.actors
      .map((actor) => ({
        id: actor.id,
        entityName: actor.entityName,
        catalogId: actor.id === 'ego' ? 'vehicle.bus' : 'pedestrian.adult',
        modelBasis: actor.id === 'ego' ? 'input-tag' : 'kind-default',
        kind: actor.kind,
        static: actor.static,
        dims: actor.dims,
        tags: actor.tags,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)));

    const egoPlan = plan.actors.find((actor) => actor.id === 'ego')!;
    const atOne = egoPlan.samples.find((sample) => sample.t === 1)!;
    expect(samplePlaybackActors(bundle, 1).find((actor) => actor.id === 'ego')).toMatchObject({
      x: atOne.x,
      z: -atOne.y,
      headingRad: atOne.headingRad,
      speedMps: atOne.speedMps,
      present: atOne.present,
    });
  });

  it('retains plan despawn markers and physical signal states in playback overlays', () => {
    const plan = planFixture();
    const bundle = playbackBundleFromReplay(plan, {
      mapId: plan.mapId,
      engineGraphDigest: GRAPH_DIGEST,
    });
    const pedestrian = plan.actors.find((actor) => actor.id === 'pedestrian')!;
    const firstAbsent = pedestrian.samples.find((sample) => !sample.present)!;

    expect(samplePlaybackActors(bundle, firstAbsent.t).find((actor) => actor.id === 'pedestrian')?.present).toBe(false);
    const signal = plan.signals[0]!;
    for (const change of plan.physicalSignals[signal.headIds[0]!]!) {
      expect(samplePlaybackSignals(bundle, change.t)[0]).toMatchObject({
        id: signal.programId,
        headIds: signal.headIds,
        timingSource: 'authored',
        phase: change.state,
      });
    }
  });
});
