/// <reference lib="webworker" />

import {
  buildLaneGraph,
  parseSimScenarioInput,
  type ActorKind,
  type LaneGraph,
  type SimScenarioInput,
  type TopologyIndex,
} from '@simforge-oss/engine';
import { WorldSession, type TruthSubscription } from '@simforge-oss/training-env/browser';

import type {
  LiveWorldWorkerRequest,
  LiveWorldWorkerResponse,
} from '../app/lib/live-world/worker-protocol';
import {
  applyEgoControl,
  assertControllableActor,
  authoredPlaybackBudget,
  authoredClipCompleted,
  authoredPlaybackRequiresReset,
  createAuthoredWorldSession,
} from '../app/lib/live-world/authored-world-session';

const scope = self as unknown as DedicatedWorkerGlobalScope;

let world: WorldSession | null = null;
let truth: TruthSubscription | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let commandSequence = 0;
let closed = false;
let authoredInput: SimScenarioInput | null = null;
let authoredGraph: LaneGraph | null = null;
let egoActorId: string | null = null;
let playing = true;
let inspecting = false;
let completed = false;
let authoredTickHz = 20;
let authoredClockLastWallTimeMs: number | null = null;
let authoredClockRemainderS = 0;
let lastAuthoredLagWarningMs = Number.NEGATIVE_INFINITY;

const AUTHORED_CATCH_UP_INTERVALS = 1.5;
const AUTHORED_LAG_WARNING_INTERVAL_MS = 5_000;


scope.onmessage = (event: MessageEvent<LiveWorldWorkerRequest>): void => {
  const message = event.data;
  if (message.type === 'init') {
    void initialize(message).catch((error: unknown) => fail(error));
    return;
  }
  if (message.type === 'init-authored') {
    void initializeAuthored(message).catch((error: unknown) => fail(error));
    return;
  }
  if (message.type === 'close') {
    shutdown();
    return;
  }
  if (!world || closed) {
    fail(new Error('live world is not running'), 'requestId' in message ? message.requestId : undefined);
    return;
  }

  if (message.type === 'set-ego') {
    try {
      if (!authoredInput) throw new Error('ego designation is only available for authored worlds');
      if (message.actorId !== null) assertControllableActor(authoredInput, message.actorId);
      egoActorId = message.actorId;
      playing = false;
      inspecting = false;
      resetAuthoredClock();
      postTransport();
    } catch (error) {
      fail(error);
    }
    return;
  }

  if (message.type === 'transport') {
    try {
      applyTransport(message);
    } catch (error) {
      fail(error);
    }
    return;
  }

  if (message.type === 'control') {
    // A completed authored clip is a healthy, parked world. Keyboard control
    // continues at 20 Hz while Drive is mounted, so ignore it until replay
    // instead of asking a finished WorldSession to accept another act command.
    if (authoredInput && (completed || authoredClipCompleted(world.time(), authoredInput.clipSeconds))) {
      completed = true;
      playing = false;
      postTransport();
      return;
    }
    const outcome = authoredInput
      ? egoActorId === null
        ? { ok: false, error: 'No authored ego vehicle is selected' }
        : applyEgoControl(world, egoActorId, message.input, commandSequence++)
      : world.applyCommand('drive-worker', commandSequence++, {
          kind: 'act',
          actorId: message.input.actorId,
          action: {
            motionDirection: message.input.reverse ? -1 : 1,
            control: {
              steer: message.input.steer,
              throttle: message.input.throttle,
              brake: message.input.brake,
            },
          },
        });

    if (!outcome.ok) {
      if (authoredInput && /not running/i.test(outcome.error ?? '')) {
        completed = true;
        playing = false;
        postTransport();
        return;
      }
      fail(new Error(outcome.error ?? 'control failed'));
    }
    return;
  }

  if (message.type === 'spawn') {
    const outcome = world.applyCommand('drive-worker', commandSequence++, {
      kind: 'spawn',
      spawn: {
        kind: actorKind(message.request.blueprint),
        pose: {
          x: message.request.position.x,
          z: message.request.position.y,
          ...(message.request.headingRad === undefined
            ? {}
            : { headingRad: message.request.headingRad }),
        },
        ...(message.request.speedMps === undefined ? {} : { speedMps: message.request.speedMps }),
      },
    });
    if (!outcome.ok || !outcome.actorIds?.[0]) {
      fail(new Error(outcome.error ?? 'spawn failed'), message.requestId);
      return;
    }
    post({ type: 'result', requestId: message.requestId, actorId: outcome.actorIds[0] });
    return;
  }

  if (message.type === 'despawn') {
    const outcome = world.applyCommand('drive-worker', commandSequence++, {
      kind: 'despawn',
      actorId: message.actorId,
    });
    if (!outcome.ok) {
      fail(new Error(outcome.error ?? 'despawn failed'), message.requestId);
      return;
    }
    post({ type: 'result', requestId: message.requestId });
  }
};

async function initialize(message: Extract<LiveWorldWorkerRequest, { type: 'init' }>): Promise<void> {
  if (world || closed) throw new Error('live world worker can only be initialized once');
  if (!Number.isFinite(message.tickHz) || message.tickHz <= 0) {
    throw new Error(`tickHz must be positive, got ${String(message.tickHz)}`);
  }

  const manifestResponse = await fetch(message.mapManifestUrl);
  if (!manifestResponse.ok) {
    throw new Error(`map manifest request failed (${manifestResponse.status})`);
  }
  const manifest = await manifestResponse.json() as Record<string, unknown>;
  const mapId = typeof manifest.mapId === 'string' ? manifest.mapId : message.mapManifestUrl;

  const topology = message.laneGraphUrl
    ? await fetchTopology(message.laneGraphUrl)
    : emptyTopology();
  const graph = buildLaneGraph(topology);
  // A world with no lane graph starts and advances perfectly happily, but every
  // road actor is then rejected with "no drivable lane", which reads as a
  // placement bug rather than a missing input. Say so once, up front.
  if (Object.keys(topology.lanes).length === 0) {
    post({
      type: 'warning',
      message: message.laneGraphUrl
        ? `lane graph at ${message.laneGraphUrl} contains no lanes; road actors cannot be placed`
        : 'no lane graph was supplied; road actors cannot be placed',
    });
  }
  const input = parseSimScenarioInput({
    mapId,
    clipSeconds: 120,
    warmupSeconds: 0,
    dt: 1 / message.tickHz,
    actors: [],
    physics: { mode: 'dynamic-v1' },
  });

  world = new WorldSession({ input, graph, mode: 'live' });
  truth = world.subscribeTruth();
  timer = setInterval(tick, 1000 / message.tickHz);
  post({ type: 'ready' });
}

async function initializeAuthored(
  message: Extract<LiveWorldWorkerRequest, { type: 'init-authored' }>,
): Promise<void> {
  if (world || closed) throw new Error('live world worker can only be initialized once');
  if (!Number.isFinite(message.tickHz) || message.tickHz <= 0) {
    throw new Error(`tickHz must be positive, got ${String(message.tickHz)}`);
  }
  authoredInput = parseSimScenarioInput(message.input);
  authoredGraph = buildLaneGraph(await fetchTopology(message.laneGraphUrl));
  authoredTickHz = message.tickHz;
  playing = false;
  inspecting = false;
  completed = false;
  rebuildAuthoredWorld();
  timer = setInterval(tick, 1000 / authoredTickHz);
  post({ type: 'ready' });
  postTransport();
}

function rebuildAuthoredWorld(): void {
  if (!authoredInput || !authoredGraph) throw new Error('authored world inputs are unavailable');
  truth?.unsubscribe();
  world = createAuthoredWorldSession(authoredInput, authoredGraph);
  truth = world.subscribeTruth();
  commandSequence = 0;
  completed = false;
  resetAuthoredClock();
}

function applyTransport(message: Extract<LiveWorldWorkerRequest, { type: 'transport' }>): void {
  if (!authoredInput || !world) throw new Error('transport is only available for authored worlds');
  if (message.action === 'reset') {
    playing = false;
    inspecting = false;
    rebuildAuthoredWorld();
    postTransport();
    return;
  }
  if (message.action === 'seek') {
    const seconds = message.seconds;
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0 || seconds > authoredInput.clipSeconds) {
      throw new RangeError(`seek time must be within 0..${authoredInput.clipSeconds} seconds`);
    }
    if (seconds + 1e-9 < world.time()) rebuildAuthoredWorld();
    playing = false;
    resetAuthoredClock();
    inspecting = true;
    advanceAuthoredTo(seconds, false);
    completed = authoredClipCompleted(world.time(), authoredInput.clipSeconds);
    postTransport();
    return;
  }
  if (message.action === 'exitInspection') {
    inspecting = false;
    postTransport();
    return;
  }
  if (message.action === 'stop') {
    playing = false;
    resetAuthoredClock();
    postTransport();
    return;
  }
  if (message.action === 'playPause' && playing) {
    playing = false;
    resetAuthoredClock();
  } else {
    // Play from the parked end state means replay, matching media controls.
    if (authoredPlaybackRequiresReset(completed, world.time(), authoredInput.clipSeconds)) {
      rebuildAuthoredWorld();
    }
    playing = true;
    beginAuthoredClock();
  }
  inspecting = false;
  completed = false;
  postTransport();
}


function tick(): void {
  if (!world || !truth || closed || !playing) return;
  try {
    if (authoredInput) {
      const nowMs = performance.now();
      if (authoredClockLastWallTimeMs === null) {
        authoredClockLastWallTimeMs = nowMs;
        postTransport();
        return;
      }

      const elapsedWallS = Math.max(0, (nowMs - authoredClockLastWallTimeMs) / 1_000);
      authoredClockLastWallTimeMs = nowMs;
      const maxTicks = Math.max(
        1,
        Math.ceil(AUTHORED_CATCH_UP_INTERVALS / authoredTickHz / authoredInput.dt),
      );
      const budget = authoredPlaybackBudget(
        elapsedWallS,
        authoredClockRemainderS,
        authoredInput.dt,
        maxTicks,
      );
      authoredClockRemainderS = budget.remainderS;

      if (budget.lagS > 0 && nowMs - lastAuthoredLagWarningMs >= AUTHORED_LAG_WARNING_INTERVAL_MS) {
        post({
          type: 'warning',
          message: `Authored playback is ${(budget.lagS * 1_000).toFixed(0)} ms behind wall clock; `
            + `catch-up is capped at ${maxTicks} fixed steps per worker interval`,
        });
        lastAuthoredLagWarningMs = nowMs;
      }

      if (budget.ticks > 0) {
        const remainingS = Math.max(0, authoredInput.clipSeconds - world.time());
        const remainingTicks = Math.ceil(remainingS / authoredInput.dt - 1e-9);
        const ticks = Math.min(budget.ticks, remainingTicks);
        if (ticks > 0) world.advance(ticks);
        postTruthFrames(truth.drain(), true);
      }
      completed = authoredClipCompleted(world.time(), authoredInput.clipSeconds);

      if (completed) {
        playing = false;
        resetAuthoredClock();
      }
      postTransport();
      return;
    }
    world.advance(1);
    postTruthFrames(truth.drain(), true);
  } catch (error) {
    fail(error);
    shutdown();
  }
}

function beginAuthoredClock(): void {
  authoredClockLastWallTimeMs = performance.now();
  authoredClockRemainderS = 0;
  lastAuthoredLagWarningMs = Number.NEGATIVE_INFINITY;
}

function resetAuthoredClock(): void {
  authoredClockLastWallTimeMs = null;
  authoredClockRemainderS = 0;
}

function advanceAuthoredTo(seconds: number, emitAll: boolean): void {
  if (!world || !truth || !authoredInput) return;
  const remaining = Math.max(0, seconds - world.time());
  const ticks = Math.ceil(remaining / authoredInput.dt - 1e-9);
  if (ticks > 0) world.advance(ticks);
  postTruthFrames(truth.drain(), emitAll);
}

function postTruthFrames(frames: Uint8Array[], emitAll: boolean): void {
  const selected = emitAll ? frames : frames.slice(-1);
  for (const frame of selected) {
    const bytes = frame.slice().buffer;
    scope.postMessage({ type: 'frame', bytes } satisfies LiveWorldWorkerResponse, [bytes]);
  }
}

function postTransport(): void {
  if (!world || !authoredInput) return;
  post({
    type: 'transport',
    playing,
    completed,
    inspecting,
    time: completed ? authoredInput.clipSeconds : Math.min(authoredInput.clipSeconds, Math.max(0, world.time())),
    duration: authoredInput.clipSeconds,
  });
}

async function fetchTopology(url: string): Promise<TopologyIndex> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`lane graph request failed (${response.status})`);
  const raw = new Uint8Array(await response.arrayBuffer());
  // Map bundles ship sidecars gzipped. A static file server usually serves
  // `.json.gz` as an opaque body with no `Content-Encoding`, so fetch does not
  // decompress it and `response.json()` chokes on the 0x1f8b magic. Sniff the
  // bytes rather than trusting the extension or the server's headers.
  const gzipped = raw.length > 1 && raw[0] === 0x1f && raw[1] === 0x8b;
  const bytes = gzipped ? await gunzip(raw) : raw;
  return JSON.parse(new TextDecoder().decode(bytes)) as TopologyIndex;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function emptyTopology(): TopologyIndex {
  return {
    source: { xodrSha256: '' },
    lanes: {},
    gates: [],
    junctions: {},
  };
}

function actorKind(blueprint: string): ActorKind {
  const normalized = blueprint.toLowerCase();
  if (normalized.includes('pedestrian') || normalized.startsWith('walker.')) return 'pedestrian';
  if (normalized.includes('motorcycle')) return 'motorcycle';
  if (normalized.includes('bicycle') || normalized.includes('bike')) return 'bicycle';
  if (normalized.includes('truck') || normalized.includes('firetruck')) return 'truck';
  if (normalized.includes('bus')) return 'bus';
  if (normalized.includes('van')) return 'van';
  if (normalized.startsWith('static.') || normalized.includes('prop')) return 'static_object';
  if (normalized.startsWith('vehicle.')) return 'car';
  throw new Error(`unsupported actor blueprint: ${blueprint}`);
}

function post(message: LiveWorldWorkerResponse): void {
  if (!closed) scope.postMessage(message);
}

function fail(reason: unknown, requestId?: number): void {
  const message = reason instanceof Error ? reason.message : String(reason);
  post({ type: 'error', message, ...(requestId === undefined ? {} : { requestId }) });
}

function shutdown(): void {
  if (closed) return;
  closed = true;
  if (timer) clearInterval(timer);
  timer = null;
  truth?.unsubscribe();
  truth = null;
  world = null;
  scope.close();
}
