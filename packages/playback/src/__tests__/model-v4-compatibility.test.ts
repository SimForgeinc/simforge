import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  contentHash,
  parseSimScenarioInput,
  type SimScenarioInput,
  type SimTrace,
} from '@simforge/engine';
import {
  PlaybackLoadError,
  canonicalPreviewIdentity,
  canonicalPreviewParity,
  defaultCatalogIdForActorKind,
  evaluatePlaybackSignalHeadStates,
  parsePlaybackPair,
  readPlaybackFiles,
  samplePlaybackActors,
  samplePlaybackSignals,
  type PlaybackBundle,
  type PlaybackFile,
} from '../model';

function input(): SimScenarioInput {
  return parseSimScenarioInput({
    mapId: 'yale-street',
    clipSeconds: 1,
    warmupSeconds: 0,
    dt: 0.2,
    seed: 'playback-test',
    metricSubject: 'ego',
    actors: [
      {
        id: 'bus',
        kind: 'vehicle',
        dims: { l: 12, w: 2.55, h: 3.2 },
        initial: { pose: { x: 10, z: -20, headingRad: 0.25 }, speedMps: 0 },
        behavior: {
          route: { kind: 'polyline', points: [{ x: 10, z: -20 }, { x: 11, z: -20 }] },
        },
        static: true,
        tags: ['catalog:vehicle.bus'],
      },
      {
        id: 'ego',
        kind: 'vehicle',
        dims: { l: 4.8, w: 1.9, h: 1.5 },
        initial: { pose: { x: 0, z: 0, headingRad: 3.1 }, speedMps: 10 },
        behavior: {
          route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 20, z: 0 }] },
        },
      },
    ],
  });
}

function trace(documentInput = input()): SimTrace {
  const hash = contentHash(documentInput);
  return {
    header: {
      traceVersion: 2,
      engineVersion: '0.1.0',
      inputHash: hash,
      seed: 'playback-test',
      mapId: 'yale-street',
      engineGraphDigest: 'graph-digest',
      topologyDigest: 'graph-digest',
      dt: 0.2,
      clipSeconds: 1,
      warmupSeconds: 0,
      frame: 'xodr-local',
      actorIds: ['bus', 'ego'],
      metricSubject: 'ego',
      operationalConditions: documentInput.operationalConditions,
      physics: { mode: 'kinematic-v1', solver: 'uniscenarios-sim-engine', solverVersion: '0.1.0', substepS: 0.2, vehicleProfileDigest: null },
    },
    ticks: {
      t: [0, 1],
      actors: {
        bus: {
          x: [10, 10],
          y: [20, 20],
          headingRad: [0.25, 0.25],
          speedMps: [0, 0],
          laneRsl: [null, null],
          s: [0, 0],
          present: [1, 1],
        },
        ego: {
          x: [0, 10],
          y: [0, 0],
          headingRad: [3.1, -3.1],
          speedMps: [10, 10],
          laneRsl: [null, null],
          s: [0, 10],
          present: [1, 1],
          motionDirection: [-1, -1],
        },
      },
    },
    events: [],
    metrics: {
      minTTC: null,
      minDistance: [],
      requiredDecelMax: { bus: 0, ego: 0 },
      collisions: [],
      triggerNeverFired: [],
      clippedCriticality: false,
      ticksSimulated: 2,
    },
  } as unknown as SimTrace;
}

function pair() {
  const documentInput = input();
  return {
    instance: {
      kind: 'scenario-instance',
      version: 1,
      manifest: {
        instanceId: 'golden#1',
        inputHash: contentHash(documentInput),
        replayKey: { mapId: 'yale-street', engineGraphDigest: 'graph-digest' },
        actors: [{ id: 'bus' }, { id: 'ego' }],
      },
      input: documentInput,
    },
    trace: trace(documentInput),
  };
}

function catalogPair(): any {
  const fixture = pair() as any;
  const variant = {
    id: 'clear-day',
    title: 'Clear daytime',
    weather: 'clear',
    timeOfDay: 'day',
    traffic: 'moderate',
    visibility: 'unrestricted',
  };
  const catalogSlot = {
    identity: 'yale-street-001-bus-stop-deadbeef0000',
    mapId: 'yale-street',
    incidentId: 'bus-stop-emergence',
    seed: 'a'.repeat(64),
    attemptSeed: 'b'.repeat(64),
    designDigest: 'c'.repeat(64),
    selectedLocationId: 'location-1',
    selectedMatcherSiteId: 'site-1',
    variant,
    provenance: {
      namespace: 'catalog',
      generatorVersion: '2.0.0',
      mapCatalogRevision: 'revision-1',
      matcherIndexDigest: 'matcher-digest',
      engineGraphDigest: 'graph-digest',
      locationCatalogDigest: 'location-digest',
      taxonomyDigest: 'taxonomy-digest',
      templateDigest: 'template-digest',
    },
    templateId: 'bus-stop-emergence',
  };
  fixture.instance.catalogSlot = catalogSlot;
  fixture.instance.manifest.replayKey = {
    ...fixture.instance.manifest.replayKey,
    siteId: catalogSlot.selectedMatcherSiteId,
    paramSeed: catalogSlot.attemptSeed,
    templateId: catalogSlot.templateId,
    templateDigest: catalogSlot.provenance.templateDigest,
    matcherIndexDigest: catalogSlot.provenance.matcherIndexDigest,
  };
  fixture.instance.manifest.operationalVariant = {
    ...variant,
    concrete: structuredClone(fixture.instance.input.operationalConditions),
  };
  fixture.trace.header.catalogSlot = structuredClone(catalogSlot);
  return fixture;
}

class BytesFile implements PlaybackFile {
  constructor(readonly name: string, private readonly bytes: Uint8Array) {}
  async arrayBuffer(): Promise<ArrayBuffer> {
    return Uint8Array.from(this.bytes).buffer;
  }
}

function message(action: () => unknown): string {
  try {
    action();
    throw new Error('expected action to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(PlaybackLoadError);
    return (error as Error).message;
  }
}

describe('SimForge concrete playback import', () => {
  it('identifies an immutable full-duration preview and requires exact trace parity', () => {
    const fixture = pair();
    const bundle = parsePlaybackPair(fixture.instance, fixture.trace);
    const identity = canonicalPreviewIdentity(bundle);
    expect(identity).toMatchObject({ contractVersion: 1, complete: true, hashBound: true, samples: 2 });
    expect(canonicalPreviewParity(bundle, bundle)).toMatchObject({ ok: true });
    const changed = structuredClone(bundle);
    (changed.trace.ticks.actors.ego!.x as number[])[1] = 99;
    expect(canonicalPreviewParity(bundle, changed)).toMatchObject({ ok: false });
  });
  it.each([1, 2, 3])('accepts legacy trace format v%s without lateral offsets as lane-centred', (traceVersion) => {
    const fixture = pair();
    (fixture.trace.header as { traceVersion: number }).traceVersion = traceVersion;
    const parsed = parsePlaybackPair(fixture.instance, fixture.trace);
    expect(parsed.trace.header.traceVersion).toBe(traceVersion);
    expect(parsed.trace.ticks.actors.ego?.lateralOffsetM).toEqual([0, 0]);
    expect(parsed.trace.ticks.actors.bus?.lateralOffsetM).toEqual([0, 0]);
  });

  it('preserves the exact lateral-offset channel in current traces', () => {
    const fixture = pair();
    (fixture.trace.header as { traceVersion: number }).traceVersion = 4;
    (fixture.trace.ticks.actors.bus as any).lateralOffsetM = [0, 0];
    (fixture.trace.ticks.actors.ego as any).lateralOffsetM = [-0.25, 1.75];
    expect(parsePlaybackPair(fixture.instance, fixture.trace).trace.ticks.actors.ego?.lateralOffsetM)
      .toEqual([-0.25, 1.75]);
  });

  it.each([1, 2, 3, 4])('rejects a malformed present lateral channel in trace format v%s', (traceVersion) => {
    const fixture = pair();
    (fixture.trace.header as { traceVersion: number }).traceVersion = traceVersion;
    (fixture.trace.ticks.actors.bus as any).lateralOffsetM = [0];
    (fixture.trace.ticks.actors.ego as any).lateralOffsetM = [0, Number.NaN];
    const error = message(() => parsePlaybackPair(fixture.instance, fixture.trace));
    expect(error).toContain('ticks.actors.bus.lateralOffsetM length 1 does not match ticks.t length 2');
    expect(error).toContain('ticks.actors.ego.lateralOffsetM contains a non-finite value');
  });

  it('requires the lateral channel in current traces', () => {
    const fixture = pair();
    (fixture.trace.header as { traceVersion: number }).traceVersion = 4;
    const error = message(() => parsePlaybackPair(fixture.instance, fixture.trace));
    expect(error).toContain('ticks.actors.bus.lateralOffsetM length missing does not match ticks.t length 2');
  });

  it.each([0, 5, 99])('fails closed for unknown trace format v%s', (traceVersion) => {
    const fixture = pair();
    (fixture.trace.header as { traceVersion: number }).traceVersion = traceVersion;
    const error = message(() => parsePlaybackPair(fixture.instance, fixture.trace));
    expect(error).toContain('header.traceVersion must be one of 1, 2, 3, 4 (current 4)');
  });

  it('maps every semantic actor kind to a buildable fallback model', () => {
    expect({
      vehicle: defaultCatalogIdForActorKind('vehicle'),
      car: defaultCatalogIdForActorKind('car'),
      truck: defaultCatalogIdForActorKind('truck'),
      bus: defaultCatalogIdForActorKind('bus'),
      van: defaultCatalogIdForActorKind('van'),
      motorcycle: defaultCatalogIdForActorKind('motorcycle'),
      bicycle: defaultCatalogIdForActorKind('bicycle'),
      pedestrian: defaultCatalogIdForActorKind('pedestrian'),
      scooter: defaultCatalogIdForActorKind('scooter'),
      sidewalk_robot: defaultCatalogIdForActorKind('sidewalk_robot'),
      drone: defaultCatalogIdForActorKind('drone'),
      animal: defaultCatalogIdForActorKind('animal'),
      static_object: defaultCatalogIdForActorKind('static_object'),
    }).toEqual({
      vehicle: 'vehicle.sedan',
      car: 'vehicle.sedan',
      truck: 'vehicle.box_truck',
      bus: 'vehicle.bus',
      van: 'vehicle.van',
      motorcycle: 'vehicle.motorcycle',
      bicycle: 'vehicle.bicycle',
      pedestrian: 'pedestrian.adult',
      scooter: 'vehicle.bicycle',
      sidewalk_robot: 'sidewalk_robot.delivery_rover',
      drone: 'drone.camera_quadcopter',
      animal: 'animal.dog',
      static_object: 'hazard.cardboard_box',
    });
  });

  it('parses a concrete instance with plain JSON or a gzip trace', async () => {
    const fixture = pair();
    const instanceBytes = new TextEncoder().encode(JSON.stringify(fixture.instance));
    const traceBytes = new TextEncoder().encode(JSON.stringify(fixture.trace));

    const plain = await readPlaybackFiles(
      new BytesFile('golden.instance.json', instanceBytes),
      new BytesFile('golden.trace.json', traceBytes),
    );
    const gzipped = await readPlaybackFiles(
      new BytesFile('golden.instance.json', instanceBytes),
      new BytesFile('golden.trace.json.gz', new Uint8Array(gzipSync(traceBytes))),
    );

    expect(plain.actors.map((actor) => [actor.id, actor.catalogId, actor.modelBasis])).toEqual([
      ['bus', 'vehicle.bus', 'input-tag'],
      ['ego', 'vehicle.sedan', 'kind-default'],
    ]);
    expect(gzipped.actors).toEqual(plain.actors);
    expect(gzipped.startTime).toBe(0);
    expect(gzipped.endTime).toBe(1);
  });

  it('imports, validates, and samples export-ready physical signal state', () => {
    const documentInput = parseSimScenarioInput({
      ...input(),
      signalPrograms: [
        {
          id: 'signal:1542',
          phases: [
            { phase: 'red', durationS: 1 },
            { phase: 'green', durationS: 1 },
          ],
          stopLines: [],
          mapBinding: {
            junctionId: '134',
            controllerIds: ['1562'],
            headIds: ['1542'],
            timingSource: 'synthetic-default',
          },
        },
      ],
    });
    const baseTrace = trace(documentInput);
    const signalTrace: SimTrace = {
      ...baseTrace,
      ticks: {
        ...baseTrace.ticks,
        signals: { 'signal:1542': { phase: ['red', 'green'] } },
      },
    };
    const bundle = parsePlaybackPair(
      {
        kind: 'scenario-instance',
        version: 1,
        manifest: {
          instanceId: 'signalized#1',
          inputHash: contentHash(documentInput),
          replayKey: { mapId: 'yale-street', engineGraphDigest: 'graph-digest' },
          actors: [{ id: 'bus' }, { id: 'ego' }],
        },
        input: documentInput,
      },
      signalTrace,
      { instanceName: 'signal.instance.json', traceName: 'signal.trace.json' },
    );
    expect(bundle.signals).toEqual([
      {
        id: 'signal:1542',
        headIds: ['1542'],
        timingSource: 'synthetic-default',
      },
    ]);
    expect(samplePlaybackSignals(bundle, 0)).toEqual([
      expect.objectContaining({ id: 'signal:1542', phase: 'red', headIds: ['1542'] }),
    ]);
    expect(samplePlaybackSignals(bundle, 1)[0]?.phase).toBe('green');
  });

  it('evaluates authored clips and baseline gaps beyond a materialize-only t=0 preview', () => {
    const documentInput = parseSimScenarioInput({
      ...input(),
      clipSeconds: 6,
      signalPrograms: [
        {
          id: 'selected-stage', loop: false,
          phases: [
            { phase: 'red', durationS: 1 },
            { phase: 'green', durationS: 3 },
            { phase: 'red', durationS: 2 },
          ],
          stopLines: [],
          mapBinding: { junctionId: '590', controllerIds: ['2297'], headIds: ['2230', '2231'], timingSource: 'authored' },
        },
        {
          id: 'conflicting-stage', loop: false,
          phases: [{ phase: 'red', durationS: 6 }],
          stopLines: [],
          mapBinding: { junctionId: '590', controllerIds: ['other'], headIds: ['2240'], timingSource: 'authored' },
        },
      ],
    });
    const bundle = {
      instance: { input: documentInput },
      signals: documentInput.signalPrograms.map((program) => ({
        id: program.id,
        headIds: program.mapBinding?.headIds ?? [],
        timingSource: program.mapBinding?.timingSource ?? 'unbound',
      })),
      // The authoring worker's materialize-only trace ends at t=0.
      trace: { ticks: { t: [0], signals: {
        'selected-stage': { phase: ['red'] },
        'conflicting-stage': { phase: ['red'] },
      } } },
    } as unknown as PlaybackBundle;

    expect(samplePlaybackSignals(bundle, 2).map((signal) => signal.phase)).toEqual(['red', 'red']);
    expect(evaluatePlaybackSignalHeadStates(bundle, .999)).toEqual({ '2230': 'red', '2231': 'red', '2240': 'red' });
    expect(evaluatePlaybackSignalHeadStates(bundle, 1)).toEqual({ '2230': 'green', '2231': 'green', '2240': 'red' });
    expect(evaluatePlaybackSignalHeadStates(bundle, 3.999)).toEqual({ '2230': 'green', '2231': 'green', '2240': 'red' });
    expect(evaluatePlaybackSignalHeadStates(bundle, 4)).toEqual({ '2230': 'red', '2231': 'red', '2240': 'red' });
  });

  it('rejects input-hash, map, and actor identity mismatches with paths', () => {
    const fixture = pair();
    const broken = structuredClone(fixture.trace) as any;
    broken.header.inputHash = 'wrong-hash';
    broken.header.mapId = 'other-map';
    broken.header.actorIds = ['ego'];
    delete (broken.ticks.actors as Partial<typeof broken.ticks.actors>).bus;

    const error = message(() => parsePlaybackPair(fixture.instance, broken));
    expect(error).toContain('header.inputHash');
    expect(error).toContain('header.mapId');
    expect(error).toContain('actor ids differ');
    expect(error).toContain('ticks.actors.bus is missing');
  });

  it('rejects explicit topology and operational-condition closure mismatches', () => {
    const fixture = pair();
    const broken = structuredClone(fixture.trace) as any;
    broken.header.topologyDigest = 'different-topology';
    broken.header.operationalConditions.weather = 'snow';

    const error = message(() => parsePlaybackPair(fixture.instance, broken));
    expect(error).toContain('header.topologyDigest does not match manifest.replayKey.engineGraphDigest');
    expect(error).toContain('header.operationalConditions does not exactly match instance input.operationalConditions');
  });

  it('maps real actor ids and interpolates dynamic pose and wrapped heading', () => {
    const fixture = pair();
    const bundle = parsePlaybackPair(fixture.instance, fixture.trace);
    const sampled = samplePlaybackActors(bundle, 0.5);
    const bus = sampled.find((actor) => actor.id === 'bus')!;
    const ego = sampled.find((actor) => actor.id === 'ego')!;

    expect(bundle.actors).toHaveLength(2);
    expect(bus.static).toBe(true);
    expect(bus).toMatchObject({ x: 10, z: -20, headingRad: 0.25, present: true });
    expect(ego.static).toBe(false);
    expect(ego.motionDirection).toBe(-1);
    expect(ego.x).toBeCloseTo(5, 8);
    expect(ego.z).toBeCloseTo(0, 8);
    expect(Math.abs(ego.headingRad)).toBeGreaterThan(3.1);
  });

  it.each([60, 120])('samples a 20 Hz trace smoothly at %s Hz display cadence', (displayHz) => {
    const fixture = pair();
    const mutableTrace = fixture.trace as any;
    mutableTrace.ticks.t = Array.from({ length: 21 }, (_, index) => index / 20);
    for (const [id, trackValue] of Object.entries(mutableTrace.ticks.actors)) {
      const track = trackValue as any;
      const dynamic = id === 'ego';
      track.x = mutableTrace.ticks.t.map((t: number) => dynamic ? t * 10 : 10);
      track.y = mutableTrace.ticks.t.map(() => dynamic ? 0 : 20);
      track.headingRad = mutableTrace.ticks.t.map((t: number) => dynamic ? 3.1 + t * (2 * Math.PI - 6.2) : 0.25);
      track.speedMps = mutableTrace.ticks.t.map(() => dynamic ? 10 : 0);
      track.laneRsl = mutableTrace.ticks.t.map(() => null);
      track.s = mutableTrace.ticks.t.map((t: number) => dynamic ? t * 10 : 0);
      track.present = mutableTrace.ticks.t.map(() => 1);
      if (track.motionDirection) track.motionDirection = mutableTrace.ticks.t.map(() => -1);
    }
    const bundle = parsePlaybackPair(fixture.instance, fixture.trace);
    const xs = Array.from({ length: displayHz + 1 }, (_, frame) => (
      samplePlaybackActors(bundle, frame / displayHz).find((actor) => actor.id === 'ego')!.x
    ));
    const deltas = xs.slice(1).map((x, index) => x - xs[index]!);
    expect(Math.max(...deltas) - Math.min(...deltas)).toBeLessThan(1e-8);
  });

  it('holds collision discontinuities and clamps exactly at a stopped trace end', () => {
    const fixture = pair();
    const mutableTrace = fixture.trace as any;
    mutableTrace.events = [{ t: 1, kind: 'collision', a: 'ego', b: 'bus' }];
    mutableTrace.ticks.actors.ego.speedMps = [10, 0];
    const bundle = parsePlaybackPair(fixture.instance, fixture.trace);
    expect(samplePlaybackActors(bundle, 0.999).find((actor) => actor.id === 'ego')!.x).toBe(0);
    expect(samplePlaybackActors(bundle, 1).find((actor) => actor.id === 'ego')!.x).toBe(10);
    expect(samplePlaybackActors(bundle, 2).find((actor) => actor.id === 'ego')!.x).toBe(10);
  });

  it('keeps a static actor fixed while a dynamic actor moves across samples', () => {
    const fixture = pair();
    const bundle = parsePlaybackPair(fixture.instance, fixture.trace);
    const atStart = samplePlaybackActors(bundle, 0);
    const atEnd = samplePlaybackActors(bundle, 1);
    const startBus = atStart.find((actor) => actor.id === 'bus')!;
    const endBus = atEnd.find((actor) => actor.id === 'bus')!;
    const startEgo = atStart.find((actor) => actor.id === 'ego')!;
    const endEgo = atEnd.find((actor) => actor.id === 'ego')!;

    expect(endBus).toEqual(startBus);
    expect(endEgo.x - startEgo.x).toBe(10);
  });

  it('rejects changing static traces and malformed channel lengths', () => {
    const fixture = pair();
    const broken = structuredClone(fixture.trace) as any;
    broken.ticks.actors.bus.x[1] = 10.1;
    broken.ticks.actors.ego.present.pop();

    const error = message(() => parsePlaybackPair(fixture.instance, broken));
    expect(error).toContain('static actor bus changes in channel x');
    expect(error).toContain('ticks.actors.ego.present length 1 does not match ticks.t length 2');
  });

  it('strictly joins catalog slot provenance between instance and trace', () => {
    const fixture = catalogPair();
    const catalogSlot = fixture.instance.catalogSlot;

    expect(parsePlaybackPair(fixture.instance, fixture.trace).catalogSlot).toEqual(catalogSlot);

    (fixture.trace.header as any).catalogSlot = { ...catalogSlot, selectedMatcherSiteId: 'site-2' };
    expect(message(() => parsePlaybackPair(fixture.instance, fixture.trace))).toContain(
      'header.catalogSlot does not exactly match the instance catalogSlot closure',
    );
  });

  it.each([
    ['selected matcher site', (value: any) => { value.instance.manifest.replayKey.siteId = 'site-2'; }, 'catalogSlot.selectedMatcherSiteId'],
    ['attempt seed', (value: any) => { value.instance.manifest.replayKey.paramSeed = 'd'.repeat(64); }, 'catalogSlot.attemptSeed'],
    ['template id', (value: any) => { value.instance.manifest.replayKey.templateId = 'other-template'; }, 'catalogSlot.templateId'],
    ['matcher digest', (value: any) => { value.instance.manifest.replayKey.matcherIndexDigest = 'other-matcher'; }, 'catalogSlot.provenance.matcherIndexDigest'],
    ['engine digest', (value: any) => { value.instance.manifest.replayKey.engineGraphDigest = 'other-engine'; }, 'catalogSlot.provenance.engineGraphDigest'],
    ['template digest', (value: any) => { value.instance.manifest.replayKey.templateDigest = 'other-digest'; }, 'catalogSlot.provenance.templateDigest'],
    ['variant source', (value: any) => { value.instance.manifest.operationalVariant.weather = 'rain'; }, 'operationalVariant source fields'],
    ['variant concrete conditions', (value: any) => { value.instance.manifest.operationalVariant.concrete.weather = 'rain'; }, 'operationalVariant.concrete'],
  ])('rejects catalog %s mutations against the replay closure', (_label, mutate, diagnostic) => {
    const fixture = catalogPair();
    mutate(fixture);
    expect(message(() => parsePlaybackPair(fixture.instance, fixture.trace))).toContain(diagnostic);
  });

  it('loads fixed collidable props only when trace metadata closes over the exact prop', () => {
    const documentInput = parseSimScenarioInput({
      ...input(),
      props: [{
        id: 'workzone-barrier',
        catalogId: 'construction.jersey_barrier',
        pose: { x: 7, z: -3, headingRad: 0.4 },
        dims: { l: 2.4, w: 0.55, h: 0.85 },
        scale: 1.25,
        collidable: true,
        essentiality: 'required',
      }],
    });
    const propTrace = trace(documentInput);
    (propTrace.header as any).propMetadata = { 'workzone-barrier': documentInput.props[0]! };
    const instance = {
      kind: 'scenario-instance',
      version: 1,
      manifest: {
        instanceId: 'fixed-prop#1',
        inputHash: contentHash(documentInput),
        replayKey: { mapId: 'yale-street', engineGraphDigest: 'graph-digest' },
        actors: [{ id: 'bus' }, { id: 'ego' }],
      },
      input: documentInput,
    } as const;

    const bundle = parsePlaybackPair(instance, propTrace);
    expect(bundle.props).toEqual([
      expect.objectContaining({
        id: 'workzone-barrier',
        catalogId: 'construction.jersey_barrier',
        collidable: true,
        essentiality: 'required',
      }),
    ]);

    (propTrace.header as any).propMetadata = {};
    expect(message(() => parsePlaybackPair(instance, propTrace))).toContain('instance props=[workzone-barrier]');
  });

  it('rejects malformed reverse-motion channels and preserves body orientation while reversing', () => {
    const fixture = pair();
    const bundle = parsePlaybackPair(fixture.instance, fixture.trace);
    const start = samplePlaybackActors(bundle, 0).find((actor) => actor.id === 'ego')!;
    const end = samplePlaybackActors(bundle, 1).find((actor) => actor.id === 'ego')!;
    expect(start.motionDirection).toBe(-1);
    expect(end.motionDirection).toBe(-1);
    expect(end.headingRad).not.toBeCloseTo(start.headingRad + Math.PI);

    const broken = structuredClone(fixture.trace) as any;
    broken.ticks.actors.ego.motionDirection = [-1, 0];
    expect(message(() => parsePlaybackPair(fixture.instance, broken))).toContain(
      'motionDirection must contain only -1 or 1',
    );
  });

  it('rejects unknown actor model mappings instead of drawing a cosmetic box', () => {
    const fixture = pair();
    fixture.instance.input.actors[0]!.tags = ['catalog:vehicle.does-not-exist'];
    fixture.instance.manifest.inputHash = contentHash(fixture.instance.input);
    (fixture.trace.header as any).inputHash = fixture.instance.manifest.inputHash;

    expect(message(() => parsePlaybackPair(fixture.instance, fixture.trace))).toContain(
      'unknown Studio catalog model "vehicle.does-not-exist"',
    );
  });
});

const GOLDEN_ROOT = new URL('../../../../../fixtures/evidence/golden-yale-bus-stop/', import.meta.url);
const GOLDEN_INSTANCE = new URL('instance.json', GOLDEN_ROOT);
const GOLDEN_TRACE = new URL('trace.json.gz', GOLDEN_ROOT);

describe.skipIf(!existsSync(GOLDEN_INSTANCE) || !existsSync(GOLDEN_TRACE))('current-engine golden Yale pair', () => {
  it('loads three concrete actors and samples real static/dynamic motion', async () => {
    const bundle = await readPlaybackFiles(
      new BytesFile('instance.json', new Uint8Array(readFileSync(GOLDEN_INSTANCE))),
      new BytesFile('trace.json.gz', new Uint8Array(readFileSync(GOLDEN_TRACE))),
    );
    expect(bundle.instance.manifest.instanceId).toBe('fa9fa19457cf576f#8');
    expect(bundle.instance.manifest.inputHash).toBe(
      'e0538cb4b73547228248372bc6f2f606bbab8d3b97722b46789d41c229e70897',
    );
    expect(bundle.actors.map((actor) => actor.id)).toEqual(['bus', 'ego', 'ped']);

    const before = samplePlaybackActors(bundle, 0);
    const conflict = samplePlaybackActors(bundle, 6.9);
    const bus0 = before.find((actor) => actor.id === 'bus')!;
    const bus1 = conflict.find((actor) => actor.id === 'bus')!;
    const ego0 = before.find((actor) => actor.id === 'ego')!;
    const ego1 = conflict.find((actor) => actor.id === 'ego')!;
    expect(bus1).toEqual(bus0);
    expect(Math.hypot(ego1.x - ego0.x, ego1.z - ego0.z)).toBeGreaterThan(80);
  });
});
