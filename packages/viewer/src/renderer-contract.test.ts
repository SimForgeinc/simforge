/**
 * Parity-fixture conformance of the packaged Three WebGL viewer against
 * simforge.renderer-contract/v1.
 *
 * The fixture (fixtures/renderer-contract/basic-intersection.v1.json) is the
 * cross-renderer truth: given its scene-state.v1 document at tick T, any
 * conforming renderer must reproduce the expected actor transforms, light-on
 * states, semantic legend, camera matrices, pick results, and capture
 * schedule within the documented tolerances. This suite proves the existing
 * Three viewer (via ThreeRendererAdapter) satisfies it.
 *
 * Regenerate after an intentional behaviour change:
 *   REGEN_RENDERER_CONTRACT_FIXTURE=1 pnpm vitest run src/renderer-contract.test.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InstancedMesh, PerspectiveCamera, Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { getEntry } from '@simforge/asset-catalog';
import { actorClassSchema, sceneStateSchema, yawToQuaternion, type SceneState } from '@simforge/engine/scene-state';
import { MAX_PROJECTED_HEADLIGHTS } from './actorRenderer';
import { DEFAULT_ACTIVE_LUMINAIRE_LIMIT } from './luminaire-lighting';
import {
  ThreeRendererAdapter,
  contractActorToView,
  type ThreeAdapterHost,
} from './renderer-contract-adapter';
import {
  ACTOR_CLASS_LEGEND,
  PARITY_FIXTURE_VERSION,
  PROJECTED_HEADLIGHT_LIMIT,
  RENDERER_CONTRACT_VERSION,
  STATIC_SEMANTICS_SCHEMA_ID,
  STATIC_SEMANTIC_CLASS_LEGEND,
  STREET_LUMINAIRE_ACTIVE_LIMIT,
  actorInstanceLegend,
  actorRenderStateFromSceneState,
  deriveVehicleLightStates,
  scheduleTimestampsMicros,
  validateParityFixture,
  type ActorRenderState,
  type FixtureCameraCase,
  type FixturePickCase,
  type Mat4,
  type ParityFixture,
} from './renderer-contract';
import { STATIC_SEMANTICS_SCHEMA, STATIC_SEMANTIC_CLASSES } from './static-semantics';

const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/renderer-contract/basic-intersection.v1.json', import.meta.url),
);
const REGEN = process.env.REGEN_RENDERER_CONTRACT_FIXTURE === '1';

// The fixture (and its regeneration) is loaded at collection time, so the
// canvas stub the ActorRenderer needs must exist before any hook runs.
if (!('document' in globalThis)) {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ width: 0, height: 0, getContext: () => null }) },
  });
}

const adapters: ThreeRendererAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
});

/**
 * Headless stand-in for the CityViewer camera surface, with CameraRig's
 * applyView semantics (place eye, look at target). The adapter accepts it and
 * the real CityViewer interchangeably — see `cityViewerAsAdapterHost`.
 */
function headlessHost(): ThreeAdapterHost {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 4000);
  const target = new Vector3();
  return {
    camera,
    controls: {
      getView: () => ({
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: [target.x, target.y, target.z],
        fov: camera.fov,
      }),
      applyView: (view) => {
        camera.fov = view.fov;
        camera.updateProjectionMatrix();
        camera.position.set(view.position[0], view.position[1], view.position[2]);
        target.set(view.target[0], view.target[1], view.target[2]);
        camera.up.set(0, 1, 0);
        camera.lookAt(target);
        camera.updateMatrixWorld(true);
      },
      setEnabled: () => {},
    },
    setCameraPoseConstraintsEnabled: () => {},
  };
}

/** Scene-state actor frame at `fixture.tick` mapped by the normative rule. */
function frameActorStates(fixture: Pick<ParityFixture, 'sceneState' | 'tick' | 'renderCues'>): ActorRenderState[] {
  const frame = fixture.sceneState.frames.find((entry) => entry.tick === fixture.tick);
  if (!frame) throw new Error(`fixture tick ${fixture.tick} missing from sceneState.frames`);
  return frame.actors
    .filter((record) => record.kind !== 'despawn')
    .map((record) => {
      const desc = fixture.sceneState.actors.find((actor) => actor.id === record.id);
      if (!desc) throw new Error(`actor ${record.id} missing static description`);
      return actorRenderStateFromSceneState(
        desc,
        record,
        frame.t,
        getEntry(desc.catalogId).dims,
        fixture.renderCues[record.id],
      );
    });
}

/** Observed world transform of an actor's body instance in the real renderer. */
function observedActorMatrix(adapter: ThreeRendererAdapter, actorId: string): Mat4 {
  const meshes: InstancedMesh[] = [];
  adapter.actors.group.traverse((object) => {
    if (object instanceof InstancedMesh && object.userData.renderIdentity !== undefined) meshes.push(object);
  });
  for (const mesh of meshes) {
    const ids = mesh.userData.actorIds as string[] | undefined;
    const index = ids?.indexOf(actorId) ?? -1;
    if (index < 0 || index >= mesh.count) continue;
    const out = new Array<number>(16);
    for (let i = 0; i < 16; i++) out[i] = mesh.instanceMatrix.array[index * 16 + i] as number;
    return out;
  }
  throw new Error(`no body instance found for actor ${actorId}`);
}

function buildAdapterAtFixtureTick(
  fixture: Pick<ParityFixture, 'sceneState' | 'tick' | 'renderCues' | 'globalLowBeams'>,
  host: ThreeAdapterHost = headlessHost(),
): ThreeRendererAdapter {
  const adapter = new ThreeRendererAdapter(host);
  adapters.push(adapter);
  adapter.setGlobalLowBeams(fixture.globalLowBeams);
  adapter.applyActorFrame({
    contractVersion: RENDERER_CONTRACT_VERSION,
    layer: 'editor',
    tick: fixture.tick,
    timeS: fixture.tick * fixture.sceneState.dt,
    actors: frameActorStates(fixture),
  });
  return adapter;
}

function applyCameraCase(adapter: ThreeRendererAdapter, cameraCase: Pick<FixtureCameraCase, 'command' | 'intrinsics'>): void {
  adapter.applyCameraCommand({ kind: 'set-intrinsics', intrinsics: cameraCase.intrinsics });
  adapter.applyCameraCommand(cameraCase.command);
}

function expectMat4Close(actual: Mat4, expected: Mat4, tolerance: number, label: string): void {
  expect(actual.length, label).toBe(16);
  for (let i = 0; i < 16; i++) {
    expect(Math.abs(actual[i]! - expected[i]!), `${label}[${i}] actual=${actual[i]} expected=${expected[i]}`)
      .toBeLessThanOrEqual(tolerance);
  }
}

// ---------------------------------------------------------------------------
// Fixture (re)generation — inputs are authored here; expecteds are captured
// from the adapter so the fixture pins today's proven behaviour.
// ---------------------------------------------------------------------------

function authoredSceneState(): SceneState {
  const dims = (catalogId: string) => getEntry(catalogId).dims;
  const record = (
    id: string,
    kind: 'spawn' | 'update',
    position: readonly [number, number, number],
    yawRad: number,
    velocity: readonly [number, number, number],
  ) => ({ id, kind, position, rotation: yawToQuaternion(yawRad), yawRad, velocity });
  const frame = (tick: number) => ({
    tick,
    t: tick * 0.02,
    actors: [
      record('ego', tick === 0 ? 'spawn' : 'update', [tick * 0.25, 0, 0], 0, [12.5, 0, 0]),
      record('ped-1', tick === 0 ? 'spawn' : 'update', [3, 0, -5 + tick * 0.03], -Math.PI / 2, [0, 0, 1.5]),
      record('pol-1', tick === 0 ? 'spawn' : 'update', [-6, 0, 4], Math.PI / 2, [0, 0, 0]),
      record('van-1', tick === 0 ? 'spawn' : 'update', [8, 0, 6], Math.PI, [-0.8, 0, 0]),
    ],
  });
  return sceneStateSchema.parse({
    version: 'scene-state.v1',
    mapId: 'yale-street',
    frame: 'scene-yup',
    dt: 0.02,
    tickHz: 50,
    tickCount: 3,
    weather: { preset: 'clear', fogDensity: 0, rainIntensity: 0, wetness: 0 },
    timeOfDay: 21.5,
    profile: 'sensor',
    groundY: 0,
    actors: [
      { id: 'ego', catalogId: 'vehicle.sedan', actorClass: 'car', dims: dims('vehicle.sedan') },
      { id: 'ped-1', catalogId: 'pedestrian.adult', actorClass: 'pedestrian', dims: dims('pedestrian.adult') },
      { id: 'pol-1', catalogId: 'vehicle.police_cruiser', actorClass: 'car', dims: dims('vehicle.police_cruiser') },
      { id: 'van-1', catalogId: 'vehicle.van', actorClass: 'car', dims: dims('vehicle.van'), color: '#e8e9ea' },
    ],
    frames: [frame(0), frame(1), frame(2)],
  });
}

function regenerateFixture(): ParityFixture {
  const sceneState = authoredSceneState();
  const base = {
    fixtureVersion: PARITY_FIXTURE_VERSION,
    contractVersion: RENDERER_CONTRACT_VERSION,
    tolerances: { matrixAbs: 1e-6, pointAbs: 1e-4 },
    sceneState,
    tick: 2,
    renderCues: {
      'pol-1': { emergency: 'flashing' as const },
      'van-1': { reversing: true, indicator: 'left' as const },
    },
    globalLowBeams: true,
    schedule: { tickHz: 50, startTick: 0, frameCount: 3, width: 1280, height: 720 },
  };

  const intrinsics = { fovYDeg: 60, aspect: 16 / 9, near: 0.1, far: 4000 };
  const cameraCommands: (Pick<FixtureCameraCase, 'id' | 'command' | 'intrinsics'>)[] = [
    {
      id: 'editor-orbit',
      command: { kind: 'set-pose', pose: { position: [18, 12, 18], target: [0, 0, 0] } },
      intrinsics,
    },
    {
      id: 'frame-all',
      command: { kind: 'frame', bounds: { center: [0, 0, 0], radius: 30 } },
      intrinsics,
    },
  ];

  const host = headlessHost();
  const adapter = buildAdapterAtFixtureTick(base, host);

  const cameras: FixtureCameraCase[] = cameraCommands.map((entry) => {
    applyCameraCase(adapter, entry);
    const state = adapter.cameraState();
    return { ...entry, expected: { viewMatrix: state.viewMatrix, projectionMatrix: state.projectionMatrix } };
  });

  // Picks are authored against the editor-orbit camera: project each target
  // actor's body centre to NDC, then record what the real raycast returns.
  applyCameraCase(adapter, cameraCommands[0]!);
  const states = frameActorStates(base);
  const picks: FixturePickCase[] = [];
  for (const actorId of ['ego', 'ped-1'] as const) {
    const state = states.find((entry) => entry.id === actorId)!;
    const centre = new Vector3(state.x, state.y + state.dims.h / 2, state.z);
    const ndc = centre.clone().project(host.camera);
    const request = { ndc: { x: ndc.x, y: ndc.y }, maxHits: 4 };
    const result = adapter.pick(request);
    const hit = result.hits.find((entry) => entry.id === actorId);
    if (!hit) throw new Error(`fixture pick for ${actorId} did not hit it (got ${JSON.stringify(result.hits)})`);
    picks.push({ cameraId: 'editor-orbit', request, expected: { actorId, distanceM: hit.distanceM } });
  }
  picks.push({
    cameraId: 'editor-orbit',
    request: { ndc: { x: 0.95, y: 0.95 }, maxHits: 4 },
    expected: { actorId: null },
  });

  const expectedActorMatrices: Record<string, Mat4> = {};
  for (const state of states) expectedActorMatrices[state.id] = observedActorMatrix(adapter, state.id);

  const fixture: ParityFixture = {
    ...base,
    cameras,
    expectedActorMatrices,
    expectedLights: adapter.lightStates(),
    expectedSemantics: {
      legend: {
        contractVersion: RENDERER_CONTRACT_VERSION,
        staticSchema: STATIC_SEMANTICS_SCHEMA_ID,
        staticClasses: [...STATIC_SEMANTIC_CLASS_LEGEND],
        actorClasses: [...ACTOR_CLASS_LEGEND],
        actorInstanceIds: actorInstanceLegend(states.map((entry) => entry.id)),
      },
    },
    picks,
    expectedScheduleTimestampsMicros: scheduleTimestampsMicros(base.schedule),
  };
  mkdirSync(fileURLToPath(new URL('../fixtures/renderer-contract', import.meta.url)), { recursive: true });
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  return fixture;
}

function loadFixture(): ParityFixture {
  if (REGEN) return regenerateFixture();
  return validateParityFixture(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')));
}

// ---------------------------------------------------------------------------

describe('renderer contract v1 — Three viewer conformance', () => {
  const fixture = loadFixture();

  it('fixture validates and embeds a valid scene-state.v1 document', () => {
    const validated = validateParityFixture(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')));
    expect(() => sceneStateSchema.parse(validated.sceneState)).not.toThrow();
    expect(validated.tick).toBeLessThan(validated.sceneState.tickCount);
  });

  it('pins contract constants and legends to the renderer implementations', () => {
    expect(PROJECTED_HEADLIGHT_LIMIT).toBe(MAX_PROJECTED_HEADLIGHTS);
    expect(STREET_LUMINAIRE_ACTIVE_LIMIT).toBe(DEFAULT_ACTIVE_LUMINAIRE_LIMIT);
    expect(STATIC_SEMANTICS_SCHEMA_ID).toBe(STATIC_SEMANTICS_SCHEMA);
    expect([...STATIC_SEMANTIC_CLASS_LEGEND]).toEqual([...STATIC_SEMANTIC_CLASSES]);
    expect([...ACTOR_CLASS_LEGEND]).toEqual(actorClassSchema.options);
  });

  it('reproduces the expected camera matrices for every camera case', () => {
    const adapter = buildAdapterAtFixtureTick(fixture);
    for (const cameraCase of fixture.cameras) {
      applyCameraCase(adapter, cameraCase);
      const state = adapter.cameraState();
      expectMat4Close(state.viewMatrix, cameraCase.expected.viewMatrix, fixture.tolerances.matrixAbs, `${cameraCase.id}.view`);
      expectMat4Close(state.projectionMatrix, cameraCase.expected.projectionMatrix, fixture.tolerances.matrixAbs, `${cameraCase.id}.projection`);
    }
  });

  it('reproduces the expected actor transforms at the fixture tick', () => {
    const adapter = buildAdapterAtFixtureTick(fixture);
    for (const [actorId, expected] of Object.entries(fixture.expectedActorMatrices)) {
      expectMat4Close(observedActorMatrix(adapter, actorId), expected, fixture.tolerances.matrixAbs, `actor ${actorId}`);
    }
  });

  it('reproduces the expected light-on states, matching the normative derivation', () => {
    const adapter = buildAdapterAtFixtureTick(fixture);
    const observed = adapter.lightStates();
    expect(observed).toEqual(fixture.expectedLights);

    const derived = deriveVehicleLightStates(
      frameActorStates(fixture),
      fixture.globalLowBeams,
      (actor) => {
        try {
          return getEntry(actor.catalogId).class === 'vehicle';
        } catch {
          return false;
        }
      },
    );
    expect(observed.vehicles).toEqual(derived);
  });

  it('resolves picks to stable actor ids without leaking renderer objects', () => {
    const adapter = buildAdapterAtFixtureTick(fixture);
    for (const pick of fixture.picks) {
      const cameraCase = fixture.cameras.find((entry) => entry.id === pick.cameraId)!;
      applyCameraCase(adapter, cameraCase);
      const result = adapter.pick(pick.request);
      if (pick.expected.actorId === null) {
        expect(result.hits.filter((hit) => hit.id !== null)).toHaveLength(0);
        continue;
      }
      const hit = result.hits.find((entry) => entry.id === pick.expected.actorId);
      expect(hit, `pick ${pick.expected.actorId} at ndc ${JSON.stringify(pick.request.ndc)}`).toBeDefined();
      if (pick.expected.distanceM !== undefined) {
        expect(Math.abs(hit!.distanceM - pick.expected.distanceM)).toBeLessThanOrEqual(fixture.tolerances.pointAbs);
      }
      for (const entry of result.hits) {
        expect(entry.id === null || typeof entry.id === 'string').toBe(true);
        expect(Array.isArray(entry.point)).toBe(true);
      }
    }
  });

  it('reproduces the semantic legend and capture schedule deterministically', () => {
    const states = frameActorStates(fixture);
    expect(actorInstanceLegend(states.map((entry) => entry.id)))
      .toEqual(fixture.expectedSemantics.legend.actorInstanceIds);
    expect(scheduleTimestampsMicros(fixture.schedule)).toEqual([...fixture.expectedScheduleTimestampsMicros]);
  });

  it('contract actor states drive the renderer without a mapping layer', () => {
    const states = frameActorStates(fixture);
    // Compile-level assignability is proven in the adapter; spot-check runtime identity.
    expect(contractActorToView(states[0]!)).toBe(states[0]);
  });
});
