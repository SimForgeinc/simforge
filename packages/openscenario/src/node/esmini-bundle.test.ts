import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildLaneGraph,
  parseSimScenarioInput,
  runSimulation,
  type TopologyIndex,
} from '@simforge-oss/engine';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  analyzeEsminiCompatibility,
  exportOpenScenarioXml13Esmini,
} from '../export/index.js';
import {
  OFFICIAL_OPENSCENARIO_131_XSD,
  buildEsminiRunnableBundle,
  validateOpenScenarioXml13,
  type MapDependencyResolver,
} from './esmini-bundle.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const roadBytes = new TextEncoder().encode('<?xml version="1.0"?><OpenDRIVE><header revMajor="1" revMinor="4" name="fixture" version="1" date="1970-01-01T00:00:00" north="1" south="0" east="1" west="0"/></OpenDRIVE>\n');
const roadDigest = sha256(roadBytes);
const graph = buildLaneGraph({
  schemaVersion: 1,
  mapName: 'bundle-fixture',
  source: { xodrSha256: roadDigest },
  lanes: {},
  gates: [],
  junctions: {},
} satisfies TopologyIndex);

const input = parseSimScenarioInput({
  mapId: 'fixture-map',
  clipSeconds: 2,
  warmupSeconds: 0,
  dt: 0.1,
  actors: [{
    id: 'car',
    kind: 'car',
    initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 2 },
    behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 20, z: 0 }] } },
  }],
});
const trace = runSimulation(input, { graph, guards: 'skip' }).trace;
const resolver: MapDependencyResolver = {
  async resolveFullOpenDrive(mapId, expectedXodrSha256) {
    if (mapId !== input.mapId || expectedXodrSha256 !== roadDigest) throw new Error('dependency not found');
    return { mapId, xodrSha256: roadDigest, bytes: roadBytes, source: 'server-map-store' };
  },
};

let temp = '';
let officialXsd = '';

beforeAll(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'simforge-esmini-bundle-'));
  const response = await fetch(OFFICIAL_OPENSCENARIO_131_XSD.url);
  expect(response.ok).toBe(true);
  const archiveBytes = new Uint8Array(await response.arrayBuffer());
  expect(sha256(archiveBytes)).toBe(OFFICIAL_OPENSCENARIO_131_XSD.archiveSha256);
  const archive = path.join(temp, 'schema.zip');
  await writeFile(archive, archiveBytes);
  expect((await execa('unzip', ['-q', archive, '-d', temp], { reject: false })).exitCode).toBe(0);
  officialXsd = path.join(temp, 'OpenSCENARIO.xsd');
  expect(sha256(new Uint8Array(await readFile(officialXsd)))).toBe(OFFICIAL_OPENSCENARIO_131_XSD.xsdSha256);
});

afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});

describe('explicit esmini OpenSCENARIO 1.3.1 profile', () => {
  it('authors a real 1.3 trajectory document and validates it against the pinned official XSD', async () => {
    const result = exportOpenScenarioXml13Esmini(input, {
      graph,
      roadFile: 'maps/map.xodr',
      esminiMode: 'deterministic-trajectory',
    });
    expect(result.format).toBe('xosc-1.3-esmini');
    expect(result.content).toContain('revMajor="1" revMinor="3"');
    expect(result.content).not.toContain('revMinor="4"');
    expect(result.content).not.toContain('<Motion ');
    expect(result.content).not.toContain('<Interpolation/>');
    expect((await validateOpenScenarioXml13(result.content, officialXsd)).valid).toBe(true);

    const categoryInput = parseSimScenarioInput({
      ...input,
      actors: ['vehicle', 'truck', 'motorcycle', 'scooter'].map((kind, index) => ({
        id: kind,
        kind,
        initial: { pose: { x: 0, z: index * 3, headingRad: 0 }, speedMps: 1 },
        behavior: { route: { kind: 'polyline' as const, points: [{ x: 0, z: index * 3 }, { x: 20, z: index * 3 }] } },
      })),
    });
    const categoryXml = exportOpenScenarioXml13Esmini(categoryInput, { graph }).content;
    expect(categoryXml).toContain('vehicleCategory="truck"');
    expect(categoryXml).toContain('vehicleCategory="motorbike"');
    expect(categoryXml).not.toContain('heavyTruck');
    expect(categoryXml).not.toContain('standupScooter');
    expect((await validateOpenScenarioXml13(categoryXml, officialXsd)).valid).toBe(true);
  });

  it('keeps a separate fail-closed supported-actions profile for editable semantic interchange', async () => {
    const result = exportOpenScenarioXml13Esmini(input, {
      graph,
      roadFile: 'maps/map.xodr',
      esminiMode: 'supported-actions',
    });
    expect(result.profile).toBe('xml-1.3-esmini-actions');
    expect(result.intent).toBe('editable-semantic');
    expect(result.content).toContain('<AssignRouteAction>');
    expect(result.content).not.toContain('<FollowTrajectoryAction>');
    expect((await validateOpenScenarioXml13(result.content, officialXsd)).valid).toBe(true);
    const nonDefaultWeather = parseSimScenarioInput({
      ...input,
      operationalConditions: { ...input.operationalConditions, weather: 'rain' },
    });
    expect(() => exportOpenScenarioXml13Esmini(nonDefaultWeather, {
      graph,
      esminiMode: 'supported-actions',
    })).toThrow(/unsupported/);
  });

  it('reports presentation-only cues explicitly instead of silently claiming motion parity', async () => {
    const withIndicator = parseSimScenarioInput({
      ...input,
      interactions: [{
        id: 'indicator',
        actorId: 'car',
        trigger: { kind: 'at', t: 0.5 },
        verb: 'set',
        target: { key: 'lights.indicator', value: 'left' },
      }],
    });
    const report = analyzeEsminiCompatibility(withIndicator, 'deterministic-trajectory');
    expect(report.entries).toContainEqual(expect.objectContaining({
      path: 'interactions.indicator.target.key',
      disposition: 'lowered',
      blocking: false,
    }));
    const xml = exportOpenScenarioXml13Esmini(withIndicator, { graph }).content;
    expect(xml).toContain('indicatorLeft');
    expect((await validateOpenScenarioXml13(xml, officialXsd)).valid).toBe(true);
  });

  it('preserves speed, lane-change, indicator and pedestrian semantics in the actions profile', async () => {
    const representative = parseSimScenarioInput({
      ...input,
      actors: [
        input.actors[0],
        {
          id: 'pedestrian',
          kind: 'pedestrian',
          initial: { pose: { x: 12, z: 4, headingRad: -Math.PI / 2 }, speedMps: 1 },
          behavior: { route: { kind: 'polyline', points: [{ x: 12, z: 4 }, { x: 12, z: -4 }] } },
        },
      ],
      interactions: [
        { id: 'indicator-on', actorId: 'car', trigger: { kind: 'at', t: 0.1 }, verb: 'set', target: { key: 'lights.indicator', value: 'left' } },
        { id: 'change-lane', actorId: 'car', trigger: { kind: 'at', t: 0.2 }, verb: 'changeLane', target: { mode: 'left', count: 1 }, dynamics: { shape: 'sinusoidal', constraint: 'time', value: 0.8 } },
        { id: 'speed-up', actorId: 'car', trigger: { kind: 'at', t: 0.4 }, verb: 'speed', target: { mode: 'absolute', value: 4 }, dynamics: { shape: 'linear', constraint: 'time', value: 0.5 } },
        { id: 'indicator-off', actorId: 'car', trigger: { kind: 'at', t: 1.3 }, verb: 'set', target: { key: 'lights.indicator', value: 'off' } },
      ],
    });
    const exported = exportOpenScenarioXml13Esmini(representative, {
      graph,
      roadFile: 'maps/map.xodr',
      esminiMode: 'supported-actions',
    });
    expect(exported.content).toContain('<Pedestrian ');
    expect(exported.content).toContain('<RelativeTargetLane entityRef="actor_car" value="1"');
    expect(exported.content).toContain('indicatorLeft');
    expect(exported.content).toContain('<LightState mode="off"/>');
    expect(exported.content).toContain('<AbsoluteTargetSpeed value="4"');
    expect((await validateOpenScenarioXml13(exported.content, officialXsd)).valid).toBe(true);
  });

  it('blocks dynamic signal semantics in actions while retaining a trajectory-baked verdict', () => {
    const controlled = parseSimScenarioInput({
      ...input,
      signalPrograms: [{
        id: 'temporary-signal',
        phases: [{ phase: 'green', durationS: 1 }, { phase: 'red', durationS: 1 }],
        loop: true,
        mapBinding: {
          junctionId: 'junction-fixture',
          controllerIds: ['controller-fixture'],
          headIds: ['head-fixture'],
          controllerHeadGroups: [{ controllerId: 'controller-fixture', headIds: ['head-fixture'] }],
          timingSource: 'authored',
        },
      }],
    });
    expect(analyzeEsminiCompatibility(controlled, 'supported-actions').blocking).toContainEqual(expect.objectContaining({
      path: 'signalPrograms', disposition: 'unsupported-blocking', blocking: true,
    }));
    expect(analyzeEsminiCompatibility(controlled, 'deterministic-trajectory').entries).toContainEqual(expect.objectContaining({
      path: 'signalPrograms', disposition: 'trajectory-baked', blocking: false,
    }));
  });
});

describe('deterministic runnable bundle', () => {
  const request = () => ({
    instanceId: 'fixture-instance',
    input,
    inputHash: trace.header.inputHash,
    graph,
    canonicalTrace: trace,
    expectedXodrSha256: roadDigest,
    mapResolver: resolver,
    xsdPath: officialXsd,
    mode: 'deterministic-trajectory' as const,
  });

  it('is byte-idempotent and contains a complete hash-addressed dependency closure', async () => {
    const first = await buildEsminiRunnableBundle(request());
    const second = await buildEsminiRunnableBundle(request());
    expect(first.manifest).toEqual(second.manifest);
    expect([...first.files.keys()]).toEqual([...second.files.keys()]);
    for (const [file, bytes] of first.files) expect(bytes).toEqual(second.files.get(file));
    expect(first.manifest).toMatchObject({
      scenarioEntry: 'scenario.xosc',
      roadEntry: 'maps/map.xodr',
      canonicalTraceEntry: 'trace/canonical.trace.json',
      openScenarioVersion: '1.3.1',
      behaviorParityScope: 'motion-only',
    });
    expect(first.files.get('maps/map.xodr')).toEqual(roadBytes);
    expect(first.manifest.files.every((file) => file.sha256 === sha256(first.files.get(file.path)!))).toBe(true);
  });

  it('fails closed on missing, stale or identity-mismatched dependencies', async () => {
    await expect(buildEsminiRunnableBundle({ ...request(), mapResolver: {
      async resolveFullOpenDrive() { throw new Error('missing full map'); },
    } })).rejects.toThrow('missing full map');
    await expect(buildEsminiRunnableBundle({ ...request(), mapResolver: {
      async resolveFullOpenDrive(mapId) { return { mapId, xodrSha256: '0'.repeat(64), bytes: roadBytes, source: 'server-map-store' }; },
    } })).rejects.toThrow(/digest|dependency|map/i);
    await expect(buildEsminiRunnableBundle({ ...request(), inputHash: '0'.repeat(64) })).rejects.toThrow('inputHash');
    const staleXsd = path.join(temp, 'stale.xsd');
    await writeFile(staleXsd, '<xsd:schema/>');
    await expect(buildEsminiRunnableBundle({ ...request(), xsdPath: staleXsd })).rejects.toThrow('XSD digest mismatch');
  });
});
