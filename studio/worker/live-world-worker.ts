/// <reference lib="webworker" />

import {
  buildLaneGraph,
  parseSimScenarioInput,
  type ActorKind,
  type TopologyIndex,
} from '@simforge/engine';
import { WorldSession, type TruthSubscription } from '@simforge/training-env/browser';

import type {
  LiveWorldWorkerRequest,
  LiveWorldWorkerResponse,
} from '../app/lib/live-world/worker-protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

let world: WorldSession | null = null;
let truth: TruthSubscription | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let commandSequence = 0;
let closed = false;

scope.onmessage = (event: MessageEvent<LiveWorldWorkerRequest>): void => {
  const message = event.data;
  if (message.type === 'init') {
    void initialize(message).catch((error: unknown) => fail(error));
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

  if (message.type === 'control') {
    const outcome = world.applyCommand('drive-worker', commandSequence++, {
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
    if (!outcome.ok) fail(new Error(outcome.error ?? 'control failed'));
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

  const outcome = world.applyCommand('drive-worker', commandSequence++, {
    kind: 'despawn',
    actorId: message.actorId,
  });
  if (!outcome.ok) {
    fail(new Error(outcome.error ?? 'despawn failed'), message.requestId);
    return;
  }
  post({ type: 'result', requestId: message.requestId });
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

function tick(): void {
  if (!world || !truth || closed) return;
  try {
    world.advance(1);
    for (const frame of truth.drain()) {
      const bytes = frame.slice().buffer;
      scope.postMessage({ type: 'frame', bytes } satisfies LiveWorldWorkerResponse, [bytes]);
    }
  } catch (error) {
    fail(error);
    shutdown();
  }
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
