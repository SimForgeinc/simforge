import { describe, expect, it } from 'vitest';

import {
  buildLaneGraph,
  contentHash,
  parseSimScenarioInput,
  runSimulation,
  type TopologyIndex,
} from '@simforge-oss/engine';

import { verifyEvidenceHashes } from '../evidence.js';
import type { InstanceFile } from '@simforge-oss/compiler/node';
const LANE = '1:0:-1';
const topology: TopologyIndex = {
  schemaVersion: 1,
  mapName: 'evidence-map',
  source: { xodrSha256: 'engine-synthetic' },
  lanes: {
    [LANE]: {
      rsl: LANE,
      roadId: 1,
      section: 0,
      laneId: -1,
      laneType: 'driving',
      isJunction: false,
      junctionId: null,
      predecessors: [],
      successors: [],
      speedLimitKph: 30,
      representativeWidthM: 3.5,
      widthSamples: [{ s: 0, widthM: 3.5 }, { s: 100, widthM: 3.5 }],
      adjacentLanes: {
        left: { side: 'left', laneRsl: null, sameDirection: false, permissionIds: [] },
        right: { side: 'right', laneRsl: null, sameDirection: false, permissionIds: [] },
      },
      laneChangePermissions: [],
      polyline: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    },
  },
  gates: [],
  junctions: {},
};
const graph = buildLaneGraph(topology);

function evidencePair(): { instance: InstanceFile; trace: ReturnType<typeof runSimulation>['trace'] } {
  const input = parseSimScenarioInput({
    mapId: 'evidence-map',
    clipSeconds: 1,
    warmupSeconds: 0,
    actors: [{
      id: 'ego',
      kind: 'vehicle',
      dims: { l: 4.5, w: 1.9, h: 1.5 },
      initial: {
        laneRef: { rsl: LANE, s: 10, tFrac: 0 },
        pose: { x: 10, z: 0, headingRad: 0 },
        speedMps: 5,
      },
      behavior: {
        route: { kind: 'lanePath', lanes: [LANE] },
        cruiseSpeedMps: 5,
      },
    }],
  });
  const trace = runSimulation(input, { graph, guards: 'collect' }).trace;
  const instance = {
    kind: 'scenario-instance' as const,
    version: 1 as const,
    input,
    manifest: {
      inputHash: contentHash(input),
      replayKey: {
        mapId: input.mapId,
        matcherIndexDigest: 'matcher-synthetic',
        engineGraphDigest: trace.header.engineGraphDigest,
      },
      actors: input.actors.map((actor) => ({ id: actor.id })),
    },
  } as unknown as InstanceFile;
  return { instance, trace };
}

describe('strict instance/trace evidence provenance', () => {
  it('accepts only a complete same-input, same-map, same-topology pair', () => {
    const { instance, trace } = evidencePair();
    const report = verifyEvidenceHashes(instance, trace);

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.matcherIndexDigest).toBe('matcher-synthetic');
    expect(report.manifestEngineGraphDigest).toBe(trace.header.engineGraphDigest);
    expect(report.traceEngineGraphDigest).toBe(trace.header.engineGraphDigest);
    expect(report.traceTrackActorIds).toEqual(['ego']);
    expect(report.physicsMode).toBe('dynamic-v1');
    expect(report.physicsProvenance).toBe('matched');
  });

  it('replays pre-0.3 omitted-input kinematic evidence without relabeling it dynamic', () => {
    const { instance, trace } = evidencePair();
    const legacyTrace = {
      ...trace,
      header: {
        ...trace.header,
        engineVersion: '0.2.8',
        physics: { ...trace.header.physics, mode: 'kinematic-v1' as const, solverVersion: '0.2.8' },
      },
    };
    const report = verifyEvidenceHashes(instance, legacyTrace);
    expect(report.ok).toBe(true);
    expect(report.physicsMode).toBe('kinematic-v1');
    expect(report.physicsProvenance).toBe('legacy-kinematic');
  });

  it('rejects a newly generated omitted-input trace silently labeled kinematic', () => {
    const { instance, trace } = evidencePair();
    const relabeled = {
      ...trace,
      header: { ...trace.header, physics: { ...trace.header.physics, mode: 'kinematic-v1' as const } },
    };
    const report = verifyEvidenceHashes(instance, relabeled);
    expect(report.ok).toBe(false);
    expect(report.physicsProvenance).toBe('mismatch');
    expect(report.issues.map((issue) => issue.code)).toContain('physics_mode_mismatch');
  });

  it('never applies the legacy exception to an explicit dynamic selection', () => {
    const { instance, trace } = evidencePair();
    const explicitInput = { ...instance.input, physics: { mode: 'dynamic-v1' as const } };
    const explicitInstance = {
      ...instance,
      input: explicitInput,
      manifest: { ...instance.manifest, inputHash: contentHash(explicitInput) },
    } as InstanceFile;
    const falselyKinematic = {
      ...trace,
      header: {
        ...trace.header,
        inputHash: contentHash(explicitInput),
        engineVersion: '0.2.8',
        physics: { ...trace.header.physics, mode: 'kinematic-v1' as const, solverVersion: '0.2.8' },
      },
    };
    const report = verifyEvidenceHashes(explicitInstance, falselyKinematic);
    expect(report.ok).toBe(false);
    expect(report.physicsProvenance).toBe('mismatch');
    expect(report.issues.map((issue) => issue.code)).toContain('physics_mode_mismatch');
  });

  it('accepts semantically identical operational conditions with different property order', () => {
    const { instance, trace } = evidencePair();
    const conditions = instance.input.operationalConditions;
    const reordered = {
      effects: {
        trafficSpeedFactor: conditions.effects.trafficSpeedFactor,
        frictionScale: conditions.effects.frictionScale,
        visibilityRangeM: conditions.effects.visibilityRangeM,
      },
      visibility: conditions.visibility,
      traffic: conditions.traffic,
      timeOfDay: conditions.timeOfDay,
      weather: conditions.weather,
    };
    expect(verifyEvidenceHashes(instance, {
      ...trace,
      header: { ...trace.header, operationalConditions: reordered },
    }).ok).toBe(true);
  });

  it('rejects engine topology drift without comparing it to the matcher domain', () => {
    const { instance, trace } = evidencePair();
    const report = verifyEvidenceHashes(instance, {
      ...trace,
      header: { ...trace.header, engineGraphDigest: 'different-engine-graph' },
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'trace_engine_graph_digest_mismatch',
      'trace_topology_alias_mismatch',
    ]));
  });

  it('rejects a missing matcher-domain digest even when engine topology matches', () => {
    const { instance, trace } = evidencePair();
    const replayKey = { ...instance.manifest.replayKey } as Record<string, unknown>;
    delete replayKey['matcherIndexDigest'];
    const broken = {
      ...instance,
      manifest: { ...instance.manifest, replayKey },
    } as unknown as InstanceFile;
    const report = verifyEvidenceHashes(broken, trace);

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain('matcher_index_digest_missing');
  });

  it('rejects map, manifest actors, header actors, and track actors independently', () => {
    const { instance, trace } = evidencePair();
    const broken = {
      ...instance,
      manifest: {
        ...instance.manifest,
        replayKey: { ...instance.manifest.replayKey, mapId: 'wrong-map' },
        actors: [],
      },
    } as unknown as InstanceFile;
    const report = verifyEvidenceHashes(broken, {
      ...trace,
      header: { ...trace.header, mapId: 'other-map', actorIds: [] },
      ticks: { ...trace.ticks, actors: {} },
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'instance_map_id_mismatch',
      'trace_map_id_mismatch',
      'instance_actor_ids_mismatch',
      'trace_actor_ids_mismatch',
      'trace_actor_tracks_mismatch',
    ]));
  });

  it('rejects any catalog provenance mutation between the instance and trace', () => {
    const { instance, trace } = evidencePair();
    const catalogSlot = {
      identity: 'slot-1', seed: 'a'.repeat(64), attemptSeed: 'b'.repeat(64),
      designDigest: 'c'.repeat(64), mapId: 'evidence-map', incidentId: 'incident',
      selectedLocationId: 'loc-1', selectedMatcherSiteId: '0123456789abcdef',
      variant: {
        id: 'weekday-clear', title: 'Weekday clear daylight', weather: 'clear', timeOfDay: 'day',
        traffic: 'moderate', visibility: 'unrestricted except authored occluders',
      },
      provenance: {
        namespace: 'catalog', generatorVersion: '2.0.0', mapCatalogRevision: 'rev',
        matcherIndexDigest: 'matcher-synthetic', engineGraphDigest: trace.header.engineGraphDigest,
        locationCatalogDigest: 'locations', taxonomyDigest: 'taxonomy', templateDigest: 'template-digest',
      },
      templateId: 'template-id',
    } as const;
    const concrete = instance.input.operationalConditions;
    const reorderedConcrete = {
      effects: {
        trafficSpeedFactor: concrete.effects.trafficSpeedFactor,
        frictionScale: concrete.effects.frictionScale,
        visibilityRangeM: concrete.effects.visibilityRangeM,
      },
      visibility: concrete.visibility,
      traffic: concrete.traffic,
      timeOfDay: concrete.timeOfDay,
      weather: concrete.weather,
    };
    const catalogInstance = {
      ...instance,
      catalogSlot,
      manifest: {
        ...instance.manifest,
        operationalVariant: {
          visibility: catalogSlot.variant.visibility,
          traffic: catalogSlot.variant.traffic,
          timeOfDay: catalogSlot.variant.timeOfDay,
          weather: catalogSlot.variant.weather,
          title: catalogSlot.variant.title,
          id: catalogSlot.variant.id,
          concrete: reorderedConcrete,
        },
        replayKey: {
          ...instance.manifest.replayKey,
          siteId: catalogSlot.selectedMatcherSiteId,
          paramSeed: catalogSlot.attemptSeed,
          templateId: catalogSlot.templateId,
          templateDigest: catalogSlot.provenance.templateDigest,
        },
      },
    } as unknown as InstanceFile;
    expect(verifyEvidenceHashes(catalogInstance, {
      ...trace,
      header: { ...trace.header, catalogSlot, operationalConditions: reorderedConcrete },
    }).ok).toBe(true);

    const report = verifyEvidenceHashes(catalogInstance, {
      ...trace,
      header: {
        ...trace.header,
        catalogSlot: { ...catalogSlot, variant: { ...catalogSlot.variant, weather: 'fog' } },
      },
    });
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain('catalog_provenance_mismatch');
  });

  it('rejects a self-consistent instance/trace catalog closure that disagrees with replay semantics', () => {
    const { instance, trace } = evidencePair();
    const catalogSlot = {
      identity: 'slot-1', seed: 'a'.repeat(64), attemptSeed: 'b'.repeat(64),
      designDigest: 'c'.repeat(64), mapId: 'wrong-map', incidentId: 'incident',
      selectedLocationId: 'loc-1', selectedMatcherSiteId: 'wrong-site',
      variant: { id: 'weekday-clear', title: 'Clear', weather: 'clear', timeOfDay: 'day', traffic: 'moderate', visibility: 'clear' },
      provenance: {
        namespace: 'catalog', generatorVersion: '2.0.0', mapCatalogRevision: 'rev',
        matcherIndexDigest: 'wrong-matcher', engineGraphDigest: 'wrong-engine',
        locationCatalogDigest: 'locations', taxonomyDigest: 'taxonomy', templateDigest: 'wrong-template',
      },
      templateId: 'wrong-template-id',
    } as const;
    const catalogInstance = { ...instance, catalogSlot } as unknown as InstanceFile;
    const report = verifyEvidenceHashes(catalogInstance, {
      ...trace,
      header: { ...trace.header, catalogSlot },
    });
    expect(report.issues.map((issue) => issue.code)).toContain('catalog_provenance_invalid');
  });
});
