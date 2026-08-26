import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSimScenarioInput, type SimScenarioInput } from '@simforge/engine';
import { EditorDocument, TEST_MAP } from '@simforge/editor';
import { MemoryStorage, WebTemplateFileStore } from '@simforge/scenario';

const compilerMocks = vi.hoisted(() => ({
  input: null as SimScenarioInput | null,
  prepareArgs: null as unknown[] | null,
  disposeCount: 0,
}));

vi.mock('../../scenario/playback/scenarioWorkerClient', () => ({
  ScenarioWorkerClient: class {
    async prepare(...args: unknown[]) {
      compilerMocks.prepareArgs = args;
      return { instance: { input: compilerMocks.input } };
    }
    dispose() { compilerMocks.disposeCount++; }
  },
}));

vi.mock('@simforge/training-env/browser', () => ({
  TruthStreamClient: class {
    push() { return []; }
  },
}));

import { createAuthoredWorldSource } from '../authored-world-source';
import type { LiveWorldWorkerRequest, LiveWorldWorkerResponse } from '../worker-protocol';

class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly sent: LiveWorldWorkerRequest[] = [];
  onmessage: ((event: MessageEvent<LiveWorldWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  playing = false;
  inspecting = false;
  time = 0;
  duration = 20;

  constructor() { FakeWorker.instances.push(this); }

  postMessage(message: LiveWorldWorkerRequest) {
    this.sent.push(message);
    if (message.type === 'init-authored') {
      this.duration = message.input.clipSeconds;
      this.emit({ type: 'ready' });
      this.emitTransport();
      return;
    }
    if (message.type !== 'transport') return;
    if (message.action === 'play') this.playing = true;
    if (message.action === 'stop') this.playing = false;
    if (message.action === 'playPause') this.playing = !this.playing;
    if (message.action === 'seek') {
      this.playing = false;
      this.inspecting = true;
      this.time = message.seconds ?? this.time;
    }
    if (message.action === 'exitInspection') this.inspecting = false;
    if (message.action === 'reset') {
      this.playing = false;
      this.inspecting = false;
      this.time = 0;
    }
    this.emitTransport();
  }

  terminate() {}

  private emit(message: LiveWorldWorkerResponse) {
    this.onmessage?.({ data: message } as MessageEvent<LiveWorldWorkerResponse>);
  }

  private emitTransport() {
    this.emit({
      type: 'transport',
      playing: this.playing,
      inspecting: this.inspecting,
      time: this.time,
      duration: this.duration,
    });
  }
}

beforeEach(() => {
  FakeWorker.instances = [];
  compilerMocks.prepareArgs = null;
  compilerMocks.disposeCount = 0;
  compilerMocks.input = fixtureInput();
  vi.stubGlobal('Worker', FakeWorker);
});

describe('authored world source', () => {
  it('compiles the EditorDocument and starts the worker from PlaybackBundle.instance.input at 20 Hz', async () => {
    const document = await fixtureDocument();
    const source = await createAuthoredWorldSource({ document, map: TEST_MAP });
    const worker = FakeWorker.instances[0]!;

    expect(compilerMocks.prepareArgs?.[0]).toBe(document.data);
    expect(compilerMocks.prepareArgs?.[1]).toMatchObject({ sourceMapId: TEST_MAP.sourceMapId });
    expect(compilerMocks.prepareArgs?.[4]).toEqual({ materializeOnly: true });
    expect(compilerMocks.disposeCount).toBe(1);
    expect(worker.sent[0]).toMatchObject({
      type: 'init-authored',
      input: compilerMocks.input,
      laneGraphUrl: TEST_MAP.topologyUrl,
      tickHz: 20,
    });
    expect(source.transport.duration).toBe(20);
    expect(source.status).toBe('running');
    source.close();
    document.dispose();
  });

  it('designates an authored ego and routes every control packet to it', async () => {
    const { source, document, worker } = await createFixtureSource();
    source.setEgo('ego');
    source.control({ actorId: 'other', steer: 0.2, throttle: 0.7, brake: 0 });

    expect(source.egoActorId).toBe('ego');
    expect(worker.sent).toContainEqual({ type: 'set-ego', actorId: 'ego' });
    expect(worker.sent).toContainEqual({
      type: 'control',
      input: { actorId: 'ego', steer: 0.2, throttle: 0.7, brake: 0 },
    });
    source.close();
    document.dispose();
  });

  it('reports truthful play, pause, forward inspection, exit, and reset transitions', async () => {
    const { source, document } = await createFixtureSource();
    const observed: Array<{ playing: boolean; inspecting: boolean; time: number }> = [];
    source.subscribeTransport((transport) => observed.push({
      playing: transport.playing,
      inspecting: transport.inspecting,
      time: transport.time,
    }));

    source.transport.play();
    expect(source.transport.playing).toBe(true);
    source.transport.playPause();
    expect(source.transport.playing).toBe(false);
    source.transport.seek(7.5);
    expect(source.transport).toMatchObject({ playing: false, inspecting: true, time: 7.5 });
    source.transport.exitInspection();
    expect(source.transport.inspecting).toBe(false);
    source.transport.reset();
    expect(source.transport).toMatchObject({ playing: false, inspecting: false, time: 0 });
    expect(observed).toHaveLength(6);
    source.close();
    document.dispose();
  });

  it('rejects backwards seek instead of pretending the live world rewound', async () => {
    const { source, document } = await createFixtureSource();
    source.transport.seek(8);
    expect(() => source.transport.seek(3)).toThrow('cannot seek backwards');
    expect(source.transport.time).toBe(8);
    source.close();
    document.dispose();
  });

  it('fails loudly when the selected actor is absent, non-road, static, or lacks dynamic physics', async () => {
    const { source, document } = await createFixtureSource();
    expect(() => source.setEgo('missing')).toThrow('unknown authored actor');
    expect(() => source.setEgo('walker')).toThrow('not a controllable road vehicle');
    expect(() => source.setEgo('parked')).toThrow('static and has no controllable dynamics');

    source.close();
    document.dispose();
    compilerMocks.input = fixtureInput({ mode: 'kinematic-v1' });
    const kinematic = await createFixtureSource();
    expect(() => kinematic.source.setEgo('ego')).toThrow('does not use dynamic-v1 physics');
    kinematic.source.close();
    kinematic.document.dispose();
  });
});

async function createFixtureSource() {
  const document = await fixtureDocument();
  const source = await createAuthoredWorldSource({ document, map: TEST_MAP });
  return { source, document, worker: FakeWorker.instances.at(-1)! };
}

async function fixtureDocument() {
  return EditorDocument.openBlank(TEST_MAP, {
    store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
    autosaveMs: 60_000,
  });
}
function fixtureInput(physics: { mode: 'dynamic-v1' | 'kinematic-v1' } = { mode: 'dynamic-v1' }) {

  const actor = (id: string, kind: 'car' | 'pedestrian', x: number, isStatic = false) => ({
    id,
    kind,
    initial: { pose: { x, z: 0, headingRad: 0 }, speedMps: 0 },
    behavior: { route: { kind: 'polyline' as const, points: [{ x, z: 0 }, { x: x + 100, z: 0 }] } },
    static: isStatic,
  });
  return parseSimScenarioInput({
    mapId: TEST_MAP.sourceMapId,
    clipSeconds: 20,
    warmupSeconds: 0,
    dt: 0.02,
    physics,
    actors: [
      actor('ego', 'car', 0),
      actor('other', 'car', 20),
      actor('walker', 'pedestrian', 40),
      actor('parked', 'car', 60, true),
    ],
  });
}
