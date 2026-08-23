import type { ResolvedAmbientTrafficProfile } from './traffic.js';

/** Browser/CLI-neutral transform published by a generated SUMO map sidecar. */
export interface SumoNetworkWorldTransform {
  readonly translationX: number;
  readonly translationY: number;
  readonly rotationDegrees: number;
  readonly scale: number;
  readonly invertY: boolean;
}

/**
 * Provider-neutral scene coordinates used by the simulator, CLI and Studio.
 *
 * `x` is scene east/right and `z` is scene south/forward.  In particular this
 * is *not* an intermediate mathematical `y`: callers must never negate `z`
 * before or after these functions.  `invertY` in the generated sidecar is the
 * single place where SUMO/OpenDRIVE +y is reflected into scene +z.
 */
export interface SumoScenePoint {
  readonly x: number;
  readonly z: number;
}

export interface SumoNetworkPoint {
  readonly x: number;
  readonly y: number;
}

export function sumoNetworkToScene(
  point: SumoNetworkPoint,
  transform: SumoNetworkWorldTransform,
): SumoScenePoint {
  assertUsableTransform(transform);
  const radians = transform.rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const reflectedY = transform.invertY ? -point.y : point.y;
  return {
    x: (point.x * cosine - reflectedY * sine) * transform.scale + transform.translationX,
    z: (point.x * sine + reflectedY * cosine) * transform.scale + transform.translationY,
  };
}

export function sumoSceneToNetwork(
  point: SumoScenePoint,
  transform: SumoNetworkWorldTransform,
): SumoNetworkPoint {
  assertUsableTransform(transform);
  const radians = -transform.rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const translatedX = (point.x - transform.translationX) / transform.scale;
  const translatedZ = (point.z - transform.translationY) / transform.scale;
  return {
    x: translatedX * cosine - translatedZ * sine,
    y: (translatedX * sine + translatedZ * cosine) * (transform.invertY ? -1 : 1),
  };
}

/** SUMO navigation degrees -> scene navigation degrees. */
export function sumoNetworkHeadingToScene(
  headingDegrees: number,
  transform: SumoNetworkWorldTransform,
): number {
  return (transform.invertY ? 180 - headingDegrees : headingDegrees) + transform.rotationDegrees;
}

/** Scene navigation degrees -> SUMO navigation degrees. */
export function sumoSceneHeadingToNetwork(
  headingDegrees: number,
  transform: SumoNetworkWorldTransform,
): number {
  const relative = headingDegrees - transform.rotationDegrees;
  return transform.invertY ? 180 - relative : relative;
}

function assertUsableTransform(transform: SumoNetworkWorldTransform): void {
  if (!Number.isFinite(transform.scale) || transform.scale === 0) {
    throw new RangeError('SUMO scene transform scale must be finite and non-zero');
  }
}

/** Versioned generated sidecar consumed by every SUMO runtime surface. */
export interface SumoNetworkManifest {
  readonly schema: 'uniscenarios.sumo-network.v1';
  readonly mapId: string;
  readonly networkFile: string;
  readonly sha256: string;
  readonly worldFromNetwork: SumoNetworkWorldTransform;
  readonly routeCandidates: readonly (readonly string[])[];
}

/** Compliance/provenance envelope next to the packaged Wasm module. */
export interface SumoRuntimeManifest {
  readonly schema: 'uniscenarios.sumo-runtime.v1';
  readonly sumoVersion: string;
  readonly sumoCommit: string;
  readonly wasmBytes: number;
  readonly wasmGzipBytes: number;
  readonly licenseNotice: string;
  readonly sourceOffer: string;
}

/** Deterministic SUMO route XML shared by the editor and headless debugger. */
export interface SumoRouteDocumentOptions {
  /** Spread initial departures over this window. The CLI defaults to t=0. */
  readonly departureWindowSeconds?: number;
  /** Replenish every Nth population slot at this cadence. Omit for one-shot CLI runs. */
  readonly replenishmentPeriodSeconds?: number;
  readonly replenishmentStride?: number;
  readonly flowEndSeconds?: number;
}

export function buildSumoRouteDocument(
  candidates: readonly (readonly string[])[],
  profile: ResolvedAmbientTrafficProfile,
  options: SumoRouteDocumentOptions = {},
): string {
  if (candidates.length === 0) throw new Error('SUMO map has no usable traffic routes');
  const shuffled = deterministicShuffle(candidates, sumoNumericSeed(profile.seed));
  const count = Math.max(0, Math.min(profile.maxActors, shuffled.length));
  const aggression = clamp(profile.aggressiveness, 0, 1);
  const tau = (1.45 - aggression * 0.65).toFixed(2);
  const accel = (2.0 + aggression * 1.2).toFixed(2);
  const sigma = (0.15 + aggression * 0.45).toFixed(2);
  const speedDev = clamp(profile.speedVariance, 0, 0.8).toFixed(2);
  const proxyEdges = candidates[0]!.map(xml).join(' ');
  const departureWindowSeconds = Math.max(0, options.departureWindowSeconds ?? 0);
  const replenishmentPeriodSeconds = options.replenishmentPeriodSeconds;
  const replenishmentStride = Math.max(1, Math.trunc(options.replenishmentStride ?? 4));
  const flowEndSeconds = Math.max(departureWindowSeconds, options.flowEndSeconds ?? 3600);
  const vehicles = shuffled.slice(0, count).map((edges, index) => {
    const depart = count <= 1 ? 0 : index / (count - 1) * departureWindowSeconds;
    const id = sumoVehicleId(profile.seed, index);
    const route = edges.map(xml).join(' ');
    return replenishmentPeriodSeconds !== undefined && replenishmentPeriodSeconds > 0 && index % replenishmentStride === 0
      ? `  <flow id="${id}" type="ambient" begin="${depart.toFixed(2)}" end="${flowEndSeconds}" period="${replenishmentPeriodSeconds}" departLane="best" departPos="random_free" departSpeed="max"><route edges="${route}"/></flow>`
      : `  <vehicle id="${id}" type="ambient" depart="${departureWindowSeconds > 0 ? depart.toFixed(2) : '0'}" departLane="best" departPos="random_free" departSpeed="max"><route edges="${route}"/></vehicle>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<routes>
  <vType id="ambient" carFollowModel="EIDM" laneChangeModel="SL2015" accel="${accel}" decel="4.5" emergencyDecel="9" sigma="${sigma}" tau="${tau}" speedFactor="1" speedDev="${speedDev}"/>
  <route id="proxy-route" edges="${proxyEdges}"/>
${vehicles}
</routes>`;
}

export function sumoNumericSeed(seed: string | number): number {
  const source = String(seed);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function sumoVehicleId(seed: string | number, index: number): string {
  return `sumo-${sumoNumericSeed(seed).toString(16)}-${index}`;
}

/** Hash stored by the lean SUMO bridge in lieu of allocating actor-id strings. */
export function sumoActorIdHash(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function validateSumoNetworkManifest(manifest: SumoNetworkManifest, mapId: string): void {
  if (manifest.schema !== 'uniscenarios.sumo-network.v1') throw new Error('Unsupported SUMO map sidecar');
  if (manifest.mapId !== mapId) throw new Error(`SUMO sidecar belongs to ${manifest.mapId}, not ${mapId}`);
  if (!manifest.networkFile || !manifest.sha256 || manifest.routeCandidates.length === 0) {
    throw new Error(`SUMO sidecar for ${mapId} is incomplete`);
  }
}

export function validateSumoRuntimeManifest(manifest: SumoRuntimeManifest): void {
  if (manifest.schema !== 'uniscenarios.sumo-runtime.v1' || manifest.sumoVersion !== '1.27.1') {
    throw new Error('Unsupported SUMO browser runtime');
  }
  if (!manifest.licenseNotice || !manifest.sourceOffer || !(manifest.wasmBytes > 0)) {
    throw new Error('SUMO runtime compliance metadata is incomplete');
  }
}

function deterministicShuffle<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  let state = seed || 1;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = Math.imul(state ^ state >>> 15, 1 | state);
    state ^= state + Math.imul(state ^ state >>> 7, 61 | state);
    const next = ((state ^ state >>> 14) >>> 0) % (index + 1);
    [copy[index], copy[next]] = [copy[next]!, copy[index]!];
  }
  return copy;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
