import {
  buildSumoRoadOccupancyIndex,
  buildSumoRouteDocument as buildSharedSumoRouteDocument,
  sumoNumericSeed,
  validateSumoNetworkManifest,
  validateSumoRuntimeManifest,
  type ResolvedAmbientTrafficProfile,
  type SumoNetworkManifest,
  type SumoRuntimeManifest,
  type SumoRoadOccupancyIndex,
} from "@simforge-oss/engine";
import type { ActorView } from "@simforge-oss/viewer";
import type { MapEntry } from "../maps";
import type {
  NetworkWorldTransform,
  TrafficNetworkPayload,
  TrafficStepResult,
} from "@simforge-oss/playback";
import { toNetwork } from "@simforge-oss/playback";
import {
  fitSumoSignalProgramsToScenario,
  parseSumoSignalTopology,
  type SumoSignalTopology,
} from "@simforge-oss/playback";
import {
  SUMO_RUNTIME_MANIFEST_URL,
  SUMO_RUNTIME_MODULE_URL,
  SUMO_RUNTIME_WASM_URL,
} from "@/app/lib/scenario/sumo-runtime";

export {
  SUMO_RUNTIME_MANIFEST_URL,
  SUMO_RUNTIME_MODULE_URL,
  SUMO_RUNTIME_WASM_URL,
};

export type SumoMapManifest = SumoNetworkManifest & {
  readonly mapVersionId: string;
  readonly sourceMapId: string;
};
export type { SumoRuntimeManifest };

export interface LoadedSumoAssets {
  readonly payload: TrafficNetworkPayload;
  readonly runtime: SumoRuntimeManifest;
  readonly demand: SumoDemandSummary;
  readonly signalTopology: SumoSignalTopology;
  readonly adjustedSignalControllers: number;
  readonly occupancyRoads: SumoRoadOccupancyIndex;
  /** Original map network, retained for deterministic in-worker signal-mode switches. */
  readonly rawNetworkXml: string;
}

export interface SumoDemandFocus {
  readonly x: number;
  readonly z: number;
}
export interface SumoDemandSummary {
  readonly requestedActors: number;
  readonly selectedRoutes: number;
  readonly focus: SumoDemandFocus | null;
  readonly focusCount: number;
  readonly nearbyRouteStarts: number;
  readonly replenishmentPeriodSeconds: number;
  readonly warmupSeconds: number;
}

interface CachedSumoRuntimeAssets {
  readonly runtime: SumoRuntimeManifest;
  readonly wasmBinary: ArrayBuffer;
  readonly wasmModule?: WebAssembly.Module;
}

interface CachedSumoMapAssets {
  readonly manifest: SumoMapManifest;
  readonly networkXml: string;
  readonly signalTopology: SumoSignalTopology;
  readonly occupancyRoads: SumoRoadOccupancyIndex;
}

let cachedRuntimeAssets: CachedSumoRuntimeAssets | null = null;
const cachedMapAssets = new Map<string, CachedSumoMapAssets>();

export async function loadSumoAssets(
  map: MapEntry,
  profile: ResolvedAmbientTrafficProfile,
  fetcher: typeof fetch = fetch,
  focuses: readonly SumoDemandFocus[] = [],
  acceleratedSignalCycles = false,
  signal?: AbortSignal,
  fixedStepSeconds = .05,
  allSignalsGreen = false,
): Promise<LoadedSumoAssets> {
  if (!(fixedStepSeconds > 0) || !Number.isFinite(fixedStepSeconds)) {
    throw new Error("SUMO fixed step must be finite and positive");
  }
  if (!map.sumoManifest || !map.sumoNetworkSha256) {
    throw new Error(`SUMO is not published for ${map.label}`);
  }
  const cacheEnabled = fetcher === globalThis.fetch;
  const mapCacheKey = `${map.mapVersionId}:${map.sourceMapId}:${map.sumoNetworkSha256}`;
  const cachedMap = cacheEnabled ? cachedMapAssets.get(mapCacheKey) : undefined;
  const cachedRuntime = cacheEnabled ? cachedRuntimeAssets : null;
  const request = (input: RequestInfo | URL) =>
    fetcher(input, signal ? { signal } : undefined);
  let runtimeAssets = cachedRuntime;
  let mapAssets = cachedMap;
  if (!runtimeAssets || !mapAssets) {
    const [mapResponse, runtimeResponse, wasmResponse] = await Promise.all([
      request(map.sumoManifest),
      request(SUMO_RUNTIME_MANIFEST_URL),
      request(SUMO_RUNTIME_WASM_URL),
    ]);
    if (!mapResponse.ok)
      throw new Error(
        `SUMO is unavailable for ${map.label} (map sidecar ${mapResponse.status})`,
      );
    if (!runtimeResponse.ok)
      throw new Error(`SUMO runtime is unavailable (${runtimeResponse.status})`);
    if (!wasmResponse.ok)
      throw new Error(
        `SUMO runtime binary is unavailable (${wasmResponse.status})`,
      );
    const manifest = (await mapResponse.json()) as SumoMapManifest;
    const runtime = (await runtimeResponse.json()) as SumoRuntimeManifest;
    // The shared validator owns the logical map slug. Runtime identity is
    // independently bound to the immutable DB version and timestamped source.
    validateSumoNetworkManifest(manifest, manifest.mapId);
    if (manifest.sourceMapId !== map.sourceMapId) {
      throw new Error(
        `SUMO sidecar targets source map ${manifest.sourceMapId}, not ${map.sourceMapId}`,
      );
    }
    if (manifest.sha256 !== map.sumoNetworkSha256) {
      throw new Error(
        `SUMO sidecar network digest does not match map version ${map.mapVersionId}`,
      );
    }
    // A browser-only republish can create a new immutable map-version row
    // without changing the timestamped source map or its SUMO network bytes.
    // The source identity plus verified content digest are the authoritative
    // compatibility boundary; the producing version remains provenance only.
    validateSumoRuntimeManifest(runtime);
    const wasmBinary = validateSumoRuntimeBinary(
      await wasmResponse.arrayBuffer(),
      runtime,
    );
    const manifestUrl = new URL(
      map.sumoManifest,
      globalThis.location?.href ?? "http://localhost/",
    );
    const networkResponse = await request(
      new URL(manifest.networkFile, manifestUrl).toString(),
    );
    if (!networkResponse.ok)
      throw new Error(
        `SUMO network is unavailable for ${map.label} (${networkResponse.status})`,
      );
    const rawNetwork = await networkResponse.arrayBuffer();
    if (rawNetwork.byteLength === 0)
      throw new Error(`SUMO network is empty for ${map.label}`);
    if ((await sha256Hex(rawNetwork)) !== map.sumoNetworkSha256) {
      throw new Error(`SUMO network checksum mismatch for ${map.label}`);
    }
    const networkXml = new TextDecoder().decode(rawNetwork);
    const signalTopology = parseSumoSignalTopology(networkXml);
    // Some published networks retain inactive or internal controlled links
    // without physical-head provenance. SUMO can still simulate those links;
    // the presentation layer simply omits states it cannot bind to a head.
    // WebAssembly.Module is structured-cloneable in modern browsers. Compile
    // while the scenario worker and map are preparing so the traffic worker
    // can instantiate immediately instead of spending ~400 ms compiling after
    // the user presses Play.
    const wasmModule = cacheEnabled ? await WebAssembly.compile(wasmBinary) : undefined;
    runtimeAssets = { runtime, wasmBinary, wasmModule };
    mapAssets = {
      manifest,
      networkXml,
      signalTopology,
      occupancyRoads: buildSumoRoadOccupancyIndex(networkXml, manifest.worldFromNetwork),
    };
    if (cacheEnabled) {
      cachedRuntimeAssets = runtimeAssets;
      cachedMapAssets.set(mapCacheKey, mapAssets);
    }
  }
  const { runtime, wasmBinary, wasmModule } = runtimeAssets;
  const { manifest, networkXml, signalTopology, occupancyRoads } = mapAssets;
  // Real map timing is authoritative by default. Authors can explicitly opt
  // into a fitted preview cycle without changing link topology.
  const synchronized = signalNetworkForScenario(
    networkXml,
    acceleratedSignalCycles,
    20,
    allSignalsGreen,
  );
  const network = new TextEncoder().encode(synchronized.xml).buffer;
  const localized = localizeSumoRouteCandidates(
    manifest.routeCandidates,
    networkXml,
    manifest.worldFromNetwork,
    focuses,
  );
  // Reserve most demand for the authored action, some for approaching roads,
  // and a small background share so the visible world still feels connected.
  const demandCandidates = focuses.length > 0
    ? selectActorCenteredSumoDemand(localized, profile.maxActors)
    : localized.candidates;
  const routeDocument = buildSumoRouteDocument(demandCandidates, profile);
  const selectedRoutes = Math.max(
    0,
    Math.min(profile.maxActors, demandCandidates.length),
  );
  return {
    payload: {
      network,
      routes: new TextEncoder().encode(routeDocument).buffer,
      wasmBinary,
      wasmModule,
      seed: sumoNumericSeed(profile.seed),
      stepSeconds: fixedStepSeconds,
      worldFromNetwork: manifest.worldFromNetwork,
      maxActorStates: profile.maxActors,
    },
    runtime,
    demand: {
      requestedActors: profile.maxActors,
      selectedRoutes,
      focus: focuses[0] ?? null,
      focusCount: focuses.length,
      nearbyRouteStarts: localized.nearbyRouteStarts,
      replenishmentPeriodSeconds: SUMO_REPLENISHMENT_PERIOD_SECONDS,
      warmupSeconds: SUMO_DEMAND_WARMUP_SECONDS,
    },
    signalTopology,
    adjustedSignalControllers: synchronized.adjustedControllers,
    occupancyRoads,
    rawNetworkXml: networkXml,
  };
}

export function signalNetworkForScenario(
  networkXml: string,
  acceleratedSignalCycles: boolean,
  scenarioSeconds = 20,
  allSignalsGreen = false,
): { readonly xml: string; readonly adjustedControllers: number } {
  const synchronized = acceleratedSignalCycles
    ? fitSumoSignalProgramsToScenario(networkXml, scenarioSeconds)
    : { xml: networkXml, adjustedControllers: 0 };
  return allSignalsGreen
    ? { ...synchronized, xml: setSumoSignalProgramsAllGreen(synchronized.xml) }
    : synchronized;
}

export function setSumoSignalProgramsAllGreen(networkXml: string): string {
  return networkXml.replace(
    /(<phase\b[^>]*\bstate=")([^"]*)(")/g,
    (_match, prefix: string, state: string, suffix: string) =>
      `${prefix}${"G".repeat(state.length)}${suffix}`,
  );
}

export function validateSumoRuntimeBinary(
  binary: ArrayBuffer,
  runtime: Pick<SumoRuntimeManifest, "wasmBytes">,
): ArrayBuffer {
  if (binary.byteLength !== runtime.wasmBytes) {
    throw new Error(
      `SUMO runtime binary is incomplete (${binary.byteLength}/${runtime.wasmBytes} bytes)`,
    );
  }
  return binary;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const SUMO_REPLENISHMENT_PERIOD_SECONDS = 40;
const SUMO_DEPARTURE_WINDOW_SECONDS = 30;
export const SUMO_DEMAND_WARMUP_SECONDS = 60;
const SUMO_LOCAL_RADIUS_METERS = 300;
const SUMO_APPROACH_RADIUS_METERS = 700;

export function buildSumoRouteDocument(
  candidates: readonly (readonly string[])[],
  profile: ResolvedAmbientTrafficProfile,
): string {
  return buildSharedSumoRouteDocument(candidates, profile, {
    departureWindowSeconds: SUMO_DEPARTURE_WINDOW_SECONDS,
    replenishmentPeriodSeconds: SUMO_REPLENISHMENT_PERIOD_SECONDS,
    replenishmentStride: 4,
    flowEndSeconds: 3600,
  });
}

/**
 * Prefer routes whose departure edge is close to the authored action/camera.
 * This is intentionally an offline XML scan during provider initialization;
 * no network conversion or route finding is moved onto the main frame loop.
 */
export function localizeSumoRouteCandidates(
  candidates: readonly (readonly string[])[],
  networkXml: string,
  transform: NetworkWorldTransform,
  focuses: readonly SumoDemandFocus[],
): LocalizedSumoRouteCandidates {
  const geometry = parseEdgeGeometry(networkXml);
  if (focuses.length === 0) {
    return {
      candidates,
      nearbyCandidates: [],
      approachCandidates: [],
      backgroundCandidates: candidates,
      nearbyRouteStarts: 0,
    };
  }
  const networkFocuses = focuses.map((focus) =>
    toNetwork(focus.x, focus.z, transform),
  );
  const ranked = candidates
    .map((candidate, ordinal) => {
      const point = geometry.centers.get(candidate[0] ?? "");
      const distances = point
        ? networkFocuses.map(
            (focus) =>
              Math.hypot(point.x - focus.x, point.y - focus.y) * transform.scale,
          )
        : [];
      const distance = distances.length > 0 ? Math.min(...distances) : Number.POSITIVE_INFINITY;
      const focusIndex = distances.indexOf(distance);
      return { candidate, ordinal, distance, focusIndex };
    })
    .sort(
      (left, right) =>
        left.distance - right.distance || left.ordinal - right.ordinal,
    );
  const nearby = balanceSumoCandidatesAcrossFocuses(
    ranked.filter((item) => item.distance <= SUMO_LOCAL_RADIUS_METERS),
    focuses.length,
  );
  const approach = balanceSumoCandidatesAcrossFocuses(
    ranked.filter(
      (item) =>
        item.distance > SUMO_LOCAL_RADIUS_METERS &&
        item.distance <= SUMO_APPROACH_RADIUS_METERS,
    ),
    focuses.length,
  );
  const background = balanceSumoCandidatesAcrossFocuses(
    ranked.filter((item) => item.distance > SUMO_APPROACH_RADIUS_METERS),
    focuses.length,
  );
  return {
    candidates: [...nearby, ...approach, ...background],
    nearbyCandidates: nearby,
    approachCandidates: approach,
    backgroundCandidates: background,
    nearbyRouteStarts: nearby.length,
  };
}

export interface LocalizedSumoRouteCandidates {
  readonly candidates: readonly (readonly string[])[];
  readonly nearbyCandidates: readonly (readonly string[])[];
  readonly approachCandidates: readonly (readonly string[])[];
  readonly backgroundCandidates: readonly (readonly string[])[];
  readonly nearbyRouteStarts: number;
}

/** Select a deterministic 70/20/10 local/approach/background population. */
export function selectActorCenteredSumoDemand(
  localized: LocalizedSumoRouteCandidates,
  maxActors: number,
): readonly (readonly string[])[] {
  const target = Math.min(Math.max(0, maxActors), localized.candidates.length);
  const nearbyTarget = Math.ceil(target * 0.7);
  const approachTarget = Math.floor(target * 0.2);
  const backgroundTarget = Math.max(0, target - nearbyTarget - approachTarget);
  const selected = [
    ...localized.nearbyCandidates.slice(0, nearbyTarget),
    ...localized.approachCandidates.slice(0, approachTarget),
    ...localized.backgroundCandidates.slice(0, backgroundTarget),
  ];
  if (selected.length === target) return selected;
  const used = new Set(selected);
  for (const candidate of localized.candidates) {
    if (selected.length >= target) break;
    if (!used.has(candidate)) {
      selected.push(candidate);
      used.add(candidate);
    }
  }
  return selected;
}

function balanceSumoCandidatesAcrossFocuses<T extends {
  readonly candidate: readonly string[];
  readonly focusIndex: number;
}>(ranked: readonly T[], focusCount: number): readonly (readonly string[])[] {
  const queues = Array.from({ length: focusCount }, () => [] as T[]);
  const unassigned: T[] = [];
  for (const item of ranked) {
    const queue = queues[item.focusIndex];
    if (queue) queue.push(item);
    else unassigned.push(item);
  }
  const balanced: (readonly string[])[] = [];
  let offset = 0;
  while (balanced.length < ranked.length - unassigned.length) {
    for (const queue of queues) {
      const item = queue[offset];
      if (item) balanced.push(item.candidate);
    }
    offset += 1;
  }
  return [...balanced, ...unassigned.map((item) => item.candidate)];
}

function parseEdgeGeometry(networkXml: string): {
  centers: Map<string, { x: number; y: number }>;
} {
  const centers = new Map<string, { x: number; y: number }>();
  const edgePattern = /<edge\b[^>]*\bid="([^"]+)"[^>]*\bshape="([^"]+)"[^>]*>/g;
  for (const match of networkXml.matchAll(edgePattern)) {
    if (match[1]!.startsWith(":")) continue;
    const coordinates = match[2]!
      .trim()
      .split(/\s+/)
      .map((entry) => entry.split(",").map(Number));
    const valid = coordinates.filter(
      (point) => Number.isFinite(point[0]) && Number.isFinite(point[1]),
    );
    if (valid.length === 0) continue;
    centers.set(match[1]!, {
      x: valid.reduce((sum, point) => sum + point[0]!, 0) / valid.length,
      y: valid.reduce((sum, point) => sum + point[1]!, 0) / valid.length,
    });
  }
  return { centers };
}

export function decodeSumoActorViews(
  result: TrafficStepResult,
  sampleHeight: (x: number, z: number) => number | null,
): readonly ActorView[] {
  const view = new DataView(result.states);
  const actors: ActorView[] = [];
  for (let offset = 0; offset < result.actorCount * 32; offset += 32) {
    const idHash = view.getUint32(offset, true).toString(16).padStart(8, "0");
    const x = view.getFloat32(offset + 4, true);
    const z = view.getFloat32(offset + 8, true);
    const angle = view.getFloat32(offset + 12, true);
    const speed = view.getFloat32(offset + 16, true);
    const signals = view.getUint32(offset + 28, true);
    actors.push({
      id: `sumo:${idHash}`,
      catalogId: "vehicle.sedan",
      catalogIdAuthored: true,
      kind: "car",
      dims: { l: 4.55, w: 1.82, h: 1.48 },
      x,
      y: sampleHeight(x, z) ?? 0,
      z,
      headingRad: normalizeRadians(((angle - 90) * Math.PI) / 180),
      speedMps: speed,
      indicator:
        (signals & 3) === 3
          ? "hazard"
          : (signals & 1) !== 0
            ? "right"
            : (signals & 2) !== 0
              ? "left"
              : "off",
    });
  }
  return actors;
}

function normalizeRadians(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}
