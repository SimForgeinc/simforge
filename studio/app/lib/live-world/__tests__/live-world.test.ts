import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TruthFrame } from '@simforge/training-env';

const viewerMocks = vi.hoisted(() => ({
  batches: [] as Array<{ layer: string; actors: Array<Record<string, unknown>> }>,
  followed: [] as Array<{ actor: Record<string, unknown>; mode: string }>,
}));

vi.mock('@simforge/viewer', () => ({
  ThreeRendererAdapter: class {
    actors = {
      group: {},
      clearLayer: vi.fn(),
      dispose: vi.fn(),
    };
    applyActorFrame(batch: { layer: string; actors: Array<Record<string, unknown>> }) {
      viewerMocks.batches.push(batch);
    }
  },
  indexedWorldHeightSampler: () => (_x: number, _z: number) => 12,
  followCameraPose: (actor: Record<string, unknown>, mode: string) => {
    viewerMocks.followed.push({ actor, mode });
    return { position: [1, 2, 3], target: [4, 5, 6] };
  },
}));

vi.mock('@simforge/training-env', () => ({
  TruthStreamClient: class {
    push(): TruthFrame[] {
      return [];
    }
  },
}));

import { createRemoteWorldSource } from '../remote-world-source';
import { createTruthViewerBridge } from '../truth-viewer-bridge';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = MockWebSocket.CONNECTING;
  binaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new Event('close') as CloseEvent);
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  viewerMocks.batches.length = 0;
  viewerMocks.followed.length = 0;
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('remote world source', () => {
  it('maps commands and reconnects with pending rejection and bounded backoff', async () => {
    vi.useFakeTimers();
    const source = createRemoteWorldSource({ truthUrl: 'ws://example/twin', commandUrl: 'ws://example/drive' });
    const statuses: string[] = [];
    source.subscribeStatus((status) => statuses.push(status));

    const [truth, command] = MockWebSocket.instances;
    expect([truth!.url, command!.url]).toEqual(['ws://example/twin', 'ws://example/drive']);
    truth!.open();
    command!.open();
    expect(source.status).toBe('running');

    const spawned = source.spawn({
      blueprint: 'vehicle.car',
      position: { x: 10, y: -4, z: 2 },
      headingRad: Math.PI / 2,
      controlled: true,
    });
    expect(JSON.parse(command!.sent[0]!)).toMatchObject({ type: 'start_session', vehicle: 'vehicle.car' });
    command!.receive({ type: 'session_ready', vehicle_id: 'ws:1' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse(command!.sent[1]!)).toEqual(expect.objectContaining({
      type: 'teleport', x: 10, y: -4, z: 2, yaw: 90,
    }));
    command!.receive({ type: 'teleported', success: true, vehicle_id: 'ws:2' });
    await expect(spawned).resolves.toEqual({ actorId: 'ws:2' });

    source.control({ actorId: 'ws:2', steer: -0.25, throttle: 0.7, brake: 0.1, reverse: true });
    expect(JSON.parse(command!.sent[2]!)).toEqual({ type: 'control', s: -0.25, t: 0.7, b: 0.1, r: true });
    command!.receive({ type: 'telemetry' });

    const pending = source.spawn({ blueprint: 'vehicle.truck', position: { x: 0, y: 0 } });
    await Promise.resolve();
    expect(JSON.parse(command!.sent[3]!)).toEqual({ type: 'spawn_dynamic_actor', blueprint: 'vehicle.truck' });
    command!.close();
    await expect(pending).rejects.toThrow('command socket closed');
    expect(source.status).toBe('error');

    await vi.advanceTimersByTimeAsync(249);
    expect(MockWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(4);
    expect(statuses).toEqual(['connecting', 'running', 'error', 'connecting']);
    source.close();
  });
});

describe('truth viewer bridge', () => {
  it('interpolates at render rate, lifts through the ground index, follows, and stops after dispose', () => {
    const controls = { applyView: vi.fn(), setEnabled: vi.fn() };
    const viewer = {
      scene: { add: vi.fn() },
      controls,
      camera: { fov: 55 },
      onFrame: null as ((dt: number) => void) | null,
      getGroundIndex: vi.fn(() => ({ sample: vi.fn(), sampleNear: vi.fn(), bounds: vi.fn() })),
    };
    const bridge = createTruthViewerBridge(viewer as never, { groundLift: true, layer: 'drive' });
    bridge.apply(frame(1, 0, 0));
    bridge.apply(frame(2, 0.05, 10));
    viewer.onFrame?.(0.025);

    const actor = viewerMocks.batches.at(-1)!.actors[0]!;
    expect(actor).toEqual(expect.objectContaining({ x: 5, y: 12, z: 0, headingRad: Math.PI / 4 }));
    expect(viewer.getGroundIndex).toHaveBeenCalled();

    bridge.setFollow('ego', 'dash');
    expect(viewerMocks.followed.at(-1)?.mode).toBe('dash');
    expect(controls.applyView).toHaveBeenCalledWith({ position: [1, 2, 3], target: [4, 5, 6], fov: 55 });
    expect(controls.setEnabled).toHaveBeenLastCalledWith(false);

    const writes = viewerMocks.batches.length;
    bridge.dispose();
    bridge.apply(frame(3, 0.1, 20));
    viewer.onFrame?.(0.05);
    expect(viewerMocks.batches).toHaveLength(writes);
    expect(controls.setEnabled).toHaveBeenLastCalledWith(true);
  });
});

function frame(tick: number, timeSec: number, x: number): TruthFrame {
  return {
    tick,
    timeSec,
    scene: {
      tick,
      t: timeSec,
      actors: [{
        id: 'ego',
        kind: tick === 1 ? 'spawn' : 'update',
        position: [x, 0, 0],
        rotation: [0, 0, 0, 1],
        yawRad: tick === 1 ? 0 : Math.PI / 2,
        velocity: [2, 0, 0],
        acceleration: [0, 0, 0],
      }],
    },
    signals: [],
    actors: [{ id: 'ego', class: 'car', dims: { l: 4.5, w: 1.9, h: 1.5 }, accel: { ax: 0, ay: 0 } }],
  };
}
