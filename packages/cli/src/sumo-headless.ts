import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  buildSumoRoadOccupancyIndex,
  buildSumoRouteDocument,
  resolveAmbientTrafficProfile,
  sumoAuthoredOccupanciesAt,
  sumoAuthoredOccupancySourcesAt,
  sumoActorIdHash,
  sumoNetworkHeadingToScene,
  sumoNetworkToScene,
  sumoNumericSeed,
  sumoSceneHeadingToNetwork,
  sumoSceneToNetwork,
  sumoVehicleId,
  validateSumoNetworkManifest,
  validateSumoRuntimeManifest,
  type SceneTrace,
  type SumoNetworkManifest,
  type SumoNetworkWorldTransform,
  type SumoRuntimeManifest,
  type SumoRoadOccupancyIndex,
} from '@uniscenarios/sim-engine';

import { CliError } from './errors.js';
import { DEV_ASSETS } from '@uniscenarios/scenario-materializer';

interface SumoModule {
  readonly HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _us_sumo_start(net: number, netLength: number, routes: number, routesLength: number, step: number, seed: number): number;
  _us_sumo_step(deltaSeconds: number): number;
  _us_sumo_upsert_external(id: number, kind: number, routeId: number, x: number, y: number, heading: number, speed: number, length: number, width: number): number;
  _us_sumo_remove(id: number): number;
  _us_sumo_state_pointer(): number;
  _us_sumo_state_count(): number;
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
  printErr?: (message: string) => void;
}) => Promise<SumoModule>;

export interface HeadlessSumoSample {
  readonly t: number;
  readonly x: number;
  readonly z: number;
  readonly headingRad: number;
  readonly speedMps: number;
  readonly accelerationMps2: number;
  readonly lanePositionM: number;
  readonly signals: number;
}

export interface HeadlessSumoResult {
  readonly runtime: {
    readonly version: string;
    readonly commit: string;
    readonly heapBytes: number;
    readonly initMilliseconds: number;
    readonly stepMilliseconds: { readonly p50: number; readonly p95: number; readonly p99: number; readonly max: number; readonly total: number };
    /** Exact SUMO stderr diagnostics retained for headless acceptance checks. */
    readonly warnings: readonly string[];
  };
  readonly requestedActors: number;
  readonly peakActors: number;
  readonly finalActors: number;
  readonly paths: Record<string, readonly HeadlessSumoSample[]>;
  readonly limitations: readonly string[];
}

export async function runHeadlessSumo(options: {
  readonly mapId: string;
  readonly durationSeconds: number;
  readonly sampleSeconds: number;
  readonly actorCount: number;
  readonly seed: string | number;
  readonly authoredTrace: SceneTrace;
}): Promise<HeadlessSumoResult> {
  const runtimeDir = path.join(DEV_ASSETS, 'sumo-runtime');
  const moduleFile = path.join(runtimeDir, 'sumo.mjs');
  const wasmFile = path.join(runtimeDir, 'sumo.wasm');
  const runtimeManifestFile = path.join(runtimeDir, 'runtime-manifest.json');
  const mapManifestFile = path.join(DEV_ASSETS, options.mapId, 'derived', 'sumo', 'sumo-network-manifest.json');
  for (const [file, purpose] of [[moduleFile, 'SUMO JavaScript module'], [wasmFile, 'SUMO Wasm module'], [runtimeManifestFile, 'SUMO runtime manifest'], [mapManifestFile, 'map SUMO sidecar']] as const) {
    if (!existsSync(file)) {
      throw new CliError('sumo_unavailable', `${purpose} is not available`, {
        path: file,
        detail: {
          hint: purpose === 'map SUMO sidecar'
            ? `build the ${options.mapId} SUMO derivative, or run with --provider native`
            : 'install/build dev-assets/sumo-runtime, or run with --provider native',
          devAssets: DEV_ASSETS,
        },
      });
    }
  }

  const runtime = JSON.parse(await readFile(runtimeManifestFile, 'utf8')) as SumoRuntimeManifest;
  const manifest = JSON.parse(await readFile(mapManifestFile, 'utf8')) as SumoNetworkManifest;
  try {
    validateSumoRuntimeManifest(runtime);
    validateSumoNetworkManifest(manifest, options.mapId);
  } catch (error) {
    throw new CliError('sumo_unavailable', error instanceof Error ? error.message : String(error), {
      path: mapManifestFile,
      detail: { hint: 'regenerate the pinned SUMO runtime and map sidecar' },
    });
  }
  const networkFile = path.resolve(path.dirname(mapManifestFile), manifest.networkFile);
  if (!existsSync(networkFile)) {
    throw new CliError('sumo_unavailable', 'SUMO network declared by the map sidecar is missing', {
      path: networkFile,
      detail: { hint: `regenerate the ${options.mapId} SUMO derivative` },
    });
  }

  const profile = resolveAmbientTrafficProfile({
    version: 1,
    preset: 'city',
    maxActors: options.actorCount,
    seed: options.seed,
  });
  const routes = new TextEncoder().encode(buildSumoRouteDocument(manifest.routeCandidates, profile));
  const network = await readFile(networkFile);
  const occupancyRoads = buildSumoRoadOccupancyIndex(new TextDecoder().decode(network), manifest.worldFromNetwork);
  const importedAt = performance.now();
  const imported = await import(pathToFileURL(moduleFile).href) as { default: SumoFactory };
  const warnings: string[] = [];
  const sumo = await imported.default({
    noInitialRun: true,
    locateFile: (file) => file.endsWith('.wasm') ? wasmFile : path.join(runtimeDir, file),
    printErr: (message) => {
      const normalized = message.trim();
      if (normalized) warnings.push(normalized);
    },
  });
  const factoryMilliseconds = performance.now() - importedAt;
  const netPointer = copyBytes(sumo, network);
  const routesPointer = copyBytes(sumo, routes);
  const startAt = performance.now();
  try {
    assertSumoOk(sumo, sumo._us_sumo_start(
      netPointer.pointer,
      netPointer.length,
      routesPointer.pointer,
      routesPointer.length,
      options.sampleSeconds,
      sumoNumericSeed(options.seed),
    ));
  } finally {
    sumo._free(netPointer.pointer);
    sumo._free(routesPointer.pointer);
  }
  const initMilliseconds = factoryMilliseconds + performance.now() - startAt;

  const generatedIds = new Map<number, string>();
  for (let index = 0; index < Math.min(options.actorCount, manifest.routeCandidates.length); index += 1) {
    const id = sumoVehicleId(options.seed, index);
    generatedIds.set(sumoActorIdHash(id), id);
  }
  const paths: Record<string, HeadlessSumoSample[]> = Object.fromEntries([...generatedIds.values()].map((id) => [id, []]));
  const stepMilliseconds: number[] = [];
  let peakActors = 0;
  let finalActors = 0;
  const steps = Math.ceil(options.durationSeconds / options.sampleSeconds);
  try {
    mirrorAuthoredActors(sumo, options.authoredTrace, 0, manifest.worldFromNetwork, occupancyRoads);
    for (let sequence = 0; sequence <= steps; sequence += 1) {
      const t = Math.min(options.durationSeconds, sequence * options.sampleSeconds);
      if (sequence > 0) {
        mirrorAuthoredActors(sumo, options.authoredTrace, t, manifest.worldFromNetwork, occupancyRoads);
        const before = performance.now();
        assertSumoOk(sumo, sumo._us_sumo_step(options.sampleSeconds));
        stepMilliseconds.push(performance.now() - before);
      }
      const count = sumo._us_sumo_state_count();
      peakActors = Math.max(peakActors, count);
      finalActors = count;
      const view = new DataView(sumo.HEAPU8.buffer, sumo._us_sumo_state_pointer(), count * 32);
      for (let offset = 0; offset < view.byteLength; offset += 32) {
        const id = generatedIds.get(view.getUint32(offset, true));
        if (!id) continue;
        const scene = sumoNetworkToScene({
          x: view.getFloat32(offset + 4, true),
          y: view.getFloat32(offset + 8, true),
        }, manifest.worldFromNetwork);
        const networkHeading = view.getFloat32(offset + 12, true);
        const headingDegrees = sumoNetworkHeadingToScene(networkHeading, manifest.worldFromNetwork);
        paths[id]!.push({
          t: round(t),
          x: round(scene.x),
          z: round(scene.z),
          headingRad: round(normalizeRadians((headingDegrees - 90) * Math.PI / 180)),
          speedMps: round(view.getFloat32(offset + 16, true)),
          accelerationMps2: round(view.getFloat32(offset + 20, true)),
          lanePositionM: round(view.getFloat32(offset + 24, true)),
          signals: view.getUint32(offset + 28, true),
        });
      }
      if (t >= options.durationSeconds) break;
    }
  } finally {
    sumo._us_sumo_close();
  }

  return {
    runtime: {
      version: runtime.sumoVersion,
      commit: runtime.sumoCommit,
      heapBytes: sumo.HEAPU8.buffer.byteLength,
      initMilliseconds: round(initMilliseconds),
      stepMilliseconds: summarizeTimes(stepMilliseconds),
      warnings: [...new Set(warnings)],
    },
    requestedActors: options.actorCount,
    peakActors,
    finalActors,
    paths: Object.fromEntries(Object.entries(paths).filter(([, samples]) => samples.length > 0)),
    limitations: [
      'The lean SUMO bridge exposes lane position but not the current lane/road identifier.',
      'SUMO internal traffic-light phases are not exposed by the current bridge; report signal tracks come from the canonical UniScenarios simulation.',
    ],
  };
}

function mirrorAuthoredActors(
  sumo: SumoModule,
  trace: SceneTrace,
  t: number,
  transform: SumoNetworkWorldTransform,
  roads: SumoRoadOccupancyIndex,
): void {
  const sources = sumoAuthoredOccupancySourcesAt(trace, t);
  const occupancies = sumoAuthoredOccupanciesAt(trace, t, roads);
  const activeIds = new Set(occupancies.map((occupancy) => occupancy.id));
  for (const source of sources) {
    if (activeIds.has(source.id)) continue;
    withString(sumo, `authored:${source.id}`, (id) => assertSumoOk(sumo, sumo._us_sumo_remove(id)));
  }
  for (const occupancy of occupancies) {
    const network = sumoSceneToNetwork({ x: occupancy.x, z: occupancy.z }, transform);
    const sceneHeadingDegrees = occupancy.headingRad * 180 / Math.PI + 90;
    const networkHeading = sumoSceneHeadingToNetwork(sceneHeadingDegrees, transform);
    withString(sumo, `authored:${occupancy.id}`, (id) => withString(sumo, 'proxy-route', (route) => {
      assertSumoOk(sumo, sumo._us_sumo_upsert_external(
        id,
        occupancyKindCode(occupancy.kind),
        route,
        network.x,
        network.y,
        networkHeading,
        occupancy.speedMps,
        occupancy.lengthM,
        occupancy.widthM,
      ));
    }));
  }
}

function occupancyKindCode(kind: 'vehicle' | 'pedestrian' | 'bicycle' | 'obstacle'): number {
  return kind === 'pedestrian' ? 1 : kind === 'bicycle' ? 2 : kind === 'obstacle' ? 3 : 0;
}

function copyBytes(sumo: SumoModule, bytes: Uint8Array): { pointer: number; length: number } {
  const pointer = sumo._malloc(bytes.byteLength);
  sumo.HEAPU8.set(bytes, pointer);
  return { pointer, length: bytes.byteLength };
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

function assertSumoOk(sumo: SumoModule, code: number): void {
  if (code === 0) return;
  throw new CliError('sumo_runtime_failed', sumo.UTF8ToString(sumo._us_sumo_last_error()) || `SUMO failed (${code})`);
}

function summarizeTimes(values: readonly number[]): { p50: number; p95: number; p99: number; max: number; total: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  return {
    p50: round(percentile(0.5)),
    p95: round(percentile(0.95)),
    p99: round(percentile(0.99)),
    max: round(sorted.at(-1) ?? 0),
    total: round(values.reduce((sum, value) => sum + value, 0)),
  };
}

function normalizeRadians(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
