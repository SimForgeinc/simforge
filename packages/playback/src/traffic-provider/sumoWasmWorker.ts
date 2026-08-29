/// <reference lib="webworker" />

/* eslint-disable @next/next/no-assign-module-variable */

import { boundedTrafficActorCount, type ExternalTrafficActor, type NetworkWorldTransform, type SumoWorkerRequest, type SumoWorkerResponse, type TrafficNetworkPayload } from './protocol';
import { externalActorToNetwork, transformPackedStatesToWorld } from './coordinateTransform';
import { compileSumoRuntime, type InstantiateWasm } from './sumoRuntimeInstantiation';

interface SumoModule {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _us_sumo_start(net: number, netLength: number, routes: number, routesLength: number, step: number, seed: number): number;
  _us_sumo_step(deltaSeconds: number): number;
  _us_sumo_upsert_external(
    id: number,
    kind: number,
    routeId: number,
    x: number,
    y: number,
    heading: number,
    speed: number,
    length: number,
    width: number,
  ): number;
  _us_sumo_remove(id: number): number;
  _us_sumo_state_pointer(): number;
  _us_sumo_state_count(): number;
  _us_sumo_signal_state_pointer(): number;
  _us_sumo_signal_state_count(): number;
  _us_sumo_time(): number;
  _us_sumo_last_error(): number;
  _us_sumo_close(): void;
  UTF8ToString(pointer: number): string;
  stringToUTF8(value: string, pointer: number, maxBytes: number): void;
  lengthBytesUTF8(value: string): number;
}

type SumoFactory = (options?: {
  noInitialRun?: boolean;
  locateFile?: (file: string) => string;
  instantiateWasm?: InstantiateWasm;
  printErr?: (message: string) => void;
}) => Promise<SumoModule>;

let module: SumoModule | undefined;
let restartPayload: TrafficNetworkPayload | undefined;
let worldFromNetwork: NetworkWorldTransform | undefined;
let maxActorStates = Number.POSITIVE_INFINITY;
const mirroredActors = new Map<string, ExternalTrafficActor>();
const scope = self as DedicatedWorkerGlobalScope;
let commandChain = Promise.resolve();

scope.onmessage = (event: MessageEvent<SumoWorkerRequest>): void => {
  const message = event.data;
  // Imports and map startup are asynchronous. Serializing commands prevents a
  // quick map switch from executing close/step against a not-yet-created module.
  commandChain = commandChain.then(() => handle(message)).catch((error: unknown) => {
    post({ kind: 'error', id: message.id, message: error instanceof Error ? error.message : String(error) });
  });
};

async function handle(message: SumoWorkerRequest): Promise<void> {
  if (message.kind === 'init') {
    const started = performance.now();
    const moduleUrl = new URL(message.moduleUrl, scope.location.href).href;
    // Both ignore comments are required: the module URL is only known at
    // runtime, so a bundler that tries to resolve it statically fails with
    // "Cannot find module 'http://…'". Turbopack was already handled; a webpack
    // dev server (`next dev --webpack`) needs its own directive, which is why
    // SUMO worked on a Turbopack host and failed here.
    const imported = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ moduleUrl) as { default: SumoFactory };
    const instantiateWasm = await compileSumoRuntime(
      message.payload.wasmBinary,
      message.payload.wasmModule,
    );
    module = await imported.default({
      noInitialRun: true,
      // Emscripten otherwise downloads and streaming-compiles the binary from
      // inside this module worker. That path can remain pending indefinitely in
      // Chromium-family embedded browsers while the page is also streaming map
      // tiles. The page has already fetched and length-validated these bytes.
      instantiateWasm,
      // Do not leave the Emscripten runtime to infer the binary URL from the
      // worker bundle. In development that bundle is Vite-transformed, while
      // the packaged runtime lives under /dev-assets.
      locateFile: (file) => new URL(file, moduleUrl).href,
      // The lean browser build intentionally omits localized message catalogs.
      // SUMO reports that packaging choice on stderr even though it is harmless.
      printErr: (message) => {
        if (message.includes('SUMO_HOME is not set')) console.info(message);
        else console.error(message);
      },
    });
    // Retain only the immutable simulation inputs. The much larger WASM binary
    // is already compiled into `module` and need not be kept a second time.
    restartPayload = { ...message.payload, wasmBinary: undefined, wasmModule: undefined };
    startSimulation(module, restartPayload);
    post({ kind: 'ready', id: message.id, initMilliseconds: performance.now() - started, heapBytes: module.HEAPU8.buffer.byteLength });
    return;
  }

  if (message.kind === 'close') {
    module?._us_sumo_close();
    module = undefined;
    restartPayload = undefined;
    worldFromNetwork = undefined;
    maxActorStates = Number.POSITIVE_INFINITY;
    mirroredActors.clear();
    post({ kind: 'closed', id: message.id });
    return;
  }

  const sumo = requireModule();
  const started = performance.now();
  if (message.kind === 'reconfigure') {
    restartPayload = { ...message.payload, wasmBinary: undefined, wasmModule: undefined };
    startSimulation(sumo, restartPayload);
  } else if (message.kind === 'reset') startSimulation(sumo, requireRestartPayload());
  mirrorExternalActors(sumo, message.request.externalActors);
  assertOk(sumo._us_sumo_step(message.request.deltaSeconds));
  const simulatedCount = sumo._us_sumo_state_count();
  const count = boundedTrafficActorCount(simulatedCount, maxActorStates);
  const byteLength = count * 8 * Uint32Array.BYTES_PER_ELEMENT;
  const source = new Uint8Array(sumo.HEAPU8.buffer, sumo._us_sumo_state_pointer(), byteLength);
  const states = source.slice().buffer;
  const signalLinkCount = sumo._us_sumo_signal_state_count();
  const signalSource = new Uint8Array(sumo.HEAPU8.buffer, sumo._us_sumo_signal_state_pointer(), signalLinkCount * 8);
  const signalStates = signalSource.slice().buffer;
  transformPackedStatesToWorld(states, count, requireTransform());
  post({
    kind: 'state',
    id: message.id,
    generation: message.request.generation,
    sequence: message.request.sequence,
    simulationSeconds: sumo._us_sumo_time(),
    states,
    actorCount: count,
    simulatedActorCount: simulatedCount,
    signalStates,
    signalLinkCount,
    stepMilliseconds: performance.now() - started,
  }, [states, signalStates]);
}

function startSimulation(sumo: SumoModule, payload: TrafficNetworkPayload): void {
  worldFromNetwork = payload.worldFromNetwork;
  maxActorStates = payload.maxActorStates;
  mirroredActors.clear();
  const net = copyBytes(sumo, new Uint8Array(payload.network));
  const routes = copyBytes(sumo, new Uint8Array(payload.routes));
  try {
    // The bridge closes a currently loaded libsumo world before starting this
    // one. The Emscripten module and its compiled WASM heap stay alive.
    assertOk(sumo._us_sumo_start(net.pointer, net.length, routes.pointer, routes.length, payload.stepSeconds, payload.seed));
  } finally {
    sumo._free(net.pointer);
    sumo._free(routes.pointer);
  }
}

function mirrorExternalActors(sumo: SumoModule, actors: readonly ExternalTrafficActor[]): void {
  const transform = requireTransform();
  const current = new Set(actors.map((actor) => actor.id));
  for (const id of mirroredActors.keys()) {
    if (!current.has(id)) {
      withString(sumo, id, (idPointer) => assertOk(sumo._us_sumo_remove(idPointer)));
      mirroredActors.delete(id);
    }
  }
  for (const actor of actors) {
    // Fixed props and stopped authored vehicles dominate the external list.
    // Avoid repeatedly allocating their UTF-8 identifiers and asking libsumo
    // to apply an identical moveToXY on every 50 ms provider step.
    if (sameExternalActor(mirroredActors.get(actor.id), actor)) continue;
    const network = externalActorToNetwork({ x: actor.x, z: actor.z, headingDegrees: actor.headingDegrees }, transform);
    withString(sumo, actor.id, (idPointer) => withString(sumo, actor.routeId, (routePointer) => {
      assertOk(sumo._us_sumo_upsert_external(
        idPointer,
        kindCode(actor.kind),
        routePointer,
        network.x,
        network.y,
        network.headingDegrees,
        actor.speedMetersPerSecond,
        actor.lengthMeters,
        actor.widthMeters,
      ));
    }));
    mirroredActors.set(actor.id, actor);
  }
}

function sameExternalActor(
  previous: ExternalTrafficActor | undefined,
  next: ExternalTrafficActor,
): boolean {
  return previous !== undefined
    && previous.kind === next.kind
    && previous.routeId === next.routeId
    && previous.x === next.x
    && previous.z === next.z
    && previous.headingDegrees === next.headingDegrees
    && previous.speedMetersPerSecond === next.speedMetersPerSecond
    && previous.lengthMeters === next.lengthMeters
    && previous.widthMeters === next.widthMeters;
}

function withString<T>(sumo: SumoModule, value: string, callback: (pointer: number) => T): T {
  const size = sumo.lengthBytesUTF8(value) + 1;
  const pointer = sumo._malloc(size);
  try {
    sumo.stringToUTF8(value, pointer, size);
    return callback(pointer);
  } finally {
    sumo._free(pointer);
  }
}

function copyBytes(sumo: SumoModule, bytes: Uint8Array): { pointer: number; length: number } {
  const pointer = sumo._malloc(bytes.byteLength);
  sumo.HEAPU8.set(bytes, pointer);
  return { pointer, length: bytes.byteLength };
}

function kindCode(kind: ExternalTrafficActor['kind']): number {
  return kind === 'pedestrian' ? 1 : kind === 'bicycle' ? 2 : kind === 'obstacle' ? 3 : 0;
}

function requireModule(): SumoModule {
  if (!module) throw new Error('SUMO worker is not initialized');
  return module;
}

function requireTransform(): NetworkWorldTransform {
  if (!worldFromNetwork) throw new Error('SUMO coordinate transform is not initialized');
  return worldFromNetwork;
}

function requireRestartPayload(): TrafficNetworkPayload {
  if (!restartPayload) throw new Error('SUMO reset inputs are unavailable');
  return restartPayload;
}

function assertOk(code: number): void {
  if (code === 0) return;
  const sumo = requireModule();
  throw new Error(sumo.UTF8ToString(sumo._us_sumo_last_error()) || `SUMO failed (${code})`);
}

function post(message: SumoWorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}
