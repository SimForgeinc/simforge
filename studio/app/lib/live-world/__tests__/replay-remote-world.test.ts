import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@simforge-oss/training-env/browser', () => ({
  TruthStreamClient: class {
    push(): never[] {
      return [];
    }
  },
}));

import {
  clampReplaySpeed,
  createRemoteWorldSource,
  normalizeReplayRequest,
  parseTwinClockMessage,
  REPLAY_WINDOW_MS,
} from '../remote-world-source';

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
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('replay request normalization', () => {
  it('accepts the exact 24-hour boundary, refuses either side, and clamps speed', () => {
    const now = Date.parse('2026-08-25T20:00:00.000Z');
    const boundary = new Date(now - REPLAY_WINDOW_MS).toISOString();

    expect(normalizeReplayRequest({ startIso: boundary, speed: 0 }, now)).toEqual({
      start: boundary,
      speed: 0.25,
    });
    expect(clampReplaySpeed(20)).toBe(8);
    expect(clampReplaySpeed(Number.NaN)).toBe(1);
    expect(() => normalizeReplayRequest({ startIso: new Date(now - REPLAY_WINDOW_MS - 1).toISOString() }, now))
      .toThrow('Replay start must be within the past 24 hours');
    expect(() => normalizeReplayRequest({ startIso: new Date(now + 1).toISOString() }, now))
      .toThrow('Replay start must be within the past 24 hours');
  });

  it('parses only authoritative twin clock and mode payloads', () => {
    expect(parseTwinClockMessage({
      type: 'twin_clock',
      mode: 'replay',
      replay_clock: '2026-08-25T19:12:13.456Z',
    }, 4)).toEqual({
      mode: 'replay',
      timeIso: '2026-08-25T19:12:13.456Z',
      speed: 4,
    });
    expect(parseTwinClockMessage({ type: 'twin_mode', mode: 'live', replay_clock: null }, 8))
      .toEqual({ mode: 'live', timeIso: null, speed: 1 });
    expect(parseTwinClockMessage({ type: 'twin_clock', mode: 'off', replay_clock: null })).toBeNull();
    expect(parseTwinClockMessage({ type: 'twin_clock', mode: 'replay', replay_clock: 'invalid' }))
      .toEqual({ mode: 'replay', timeIso: null, speed: 1 });
  });
});

describe('remote replay protocol', () => {
  it('maps replay/live to /twin without consuming unsolicited clocks', async () => {
    const { source, truth } = connectedSource();
    const clocks: Array<{ mode: string; timeIso: string | null; speed: number }> = [];
    source.subscribeClock!((clock) => clocks.push(clock));

    const replay = source.setReplay!({ startIso: new Date(Date.now() - 60_000).toISOString(), speed: 4 });
    expect(JSON.parse(truth.sent[0]!)).toEqual(expect.objectContaining({ type: 'twin_replay', speed: 4 }));

    truth.receive({ type: 'twin_clock', mode: 'live', replay_clock: null });
    truth.receive({ type: 'twin_mode', mode: 'replay', replay_clock: '2026-08-25T19:00:00Z' });
    await expect(replay).resolves.toBeUndefined();
    expect(clocks.at(-1)).toEqual({ mode: 'replay', timeIso: '2026-08-25T19:00:00.000Z', speed: 4 });

    const live = source.setLive!();
    expect(JSON.parse(truth.sent[1]!)).toEqual({ type: 'twin_live' });
    truth.receive({ type: 'twin_mode', mode: 'live', replay_clock: null });
    await expect(live).resolves.toBeUndefined();
    expect(clocks.at(-1)).toEqual({ mode: 'live', timeIso: null, speed: 1 });
    source.close();
  });

  it('propagates twin refusals and drive trajectory errors verbatim', async () => {
    const { source, truth, command } = connectedSource();
    const replay = source.setReplay!({ startIso: new Date(Date.now() - 60_000).toISOString() });
    truth.receive({ type: 'twin_error', message: 'End active Drive sessions before twin replay' });
    await expect(replay).rejects.toThrow('End active Drive sessions before twin replay');

    const trajectory = source.startTrajectory!('missing.json');
    expect(JSON.parse(command.sent[0]!)).toEqual({ type: 'start_trajectory', file: 'missing.json' });
    command.receive({ type: 'error', message: 'Trajectory not found: missing.json' });
    await expect(trajectory).rejects.toThrow('Trajectory not found: missing.json');
    source.close();
  });

  it('maps trajectory listing, start, status polling, and stop on /drive', async () => {
    vi.useFakeTimers();
    const { source, command } = connectedSource();
    const statuses: Array<{ active: boolean; name?: string; elapsed?: number }> = [];
    source.subscribeTrajectoryStatus!((status) => statuses.push(status));
    expect(JSON.parse(command.sent[0]!)).toEqual({ type: 'trajectory_status' });
    command.receive({ type: 'trajectory_status', active: false });
    await Promise.resolve();

    const listing = source.listTrajectories!();
    expect(JSON.parse(command.sent[1]!)).toEqual({ type: 'list_trajectories' });
    command.receive({
      type: 'trajectory_list',
      trajectories: [{ file: 'event1.json', waypoints: 8, duration: 12 }],
      status: { active: false },
    });
    await expect(listing).resolves.toEqual([{ file: 'event1.json' }]);

    const start = source.startTrajectory!('event1.json');
    command.receive({
      type: 'trajectory_started',
      name: 'event1.json',
      vehicle_id: 'trajectory:1',
      duration: 12,
      waypoints: 8,
    });
    await expect(start).resolves.toBeUndefined();
    expect(statuses.at(-1)).toEqual(expect.objectContaining({ active: true, name: 'event1.json', elapsed: 0 }));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(JSON.parse(command.sent.at(-1)!)).toEqual({ type: 'trajectory_status' });
    command.receive({ type: 'trajectory_status', active: true, name: 'event1.json', elapsed: 1, duration: 12 });
    await Promise.resolve();
    expect(statuses.at(-1)).toEqual(expect.objectContaining({ active: true, elapsed: 1 }));

    const stop = source.stopTrajectory!();
    command.receive({ type: 'trajectory_stopped', stopped: true });
    await expect(stop).resolves.toBeUndefined();
    expect(statuses.at(-1)).toEqual({ active: false });
    source.close();
  });

  it('rejects in-flight twin and drive requests when closed', async () => {
    const { source } = connectedSource();
    const replay = source.setReplay!({ startIso: new Date(Date.now() - 60_000).toISOString() });
    const trajectories = source.listTrajectories!();
    source.close();
    await expect(replay).rejects.toThrow('remote world source closed');
    await expect(trajectories).rejects.toThrow('remote world source closed');
  });
});

function connectedSource() {
  const source = createRemoteWorldSource({ truthUrl: 'ws://example/twin', commandUrl: 'ws://example/drive' });
  const [truth, command] = MockWebSocket.instances;
  truth!.open();
  command!.open();
  return { source, truth: truth!, command: command! };
}
