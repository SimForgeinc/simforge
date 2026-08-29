import {
  createFixedStepSimulation,
  sha256Bytes,
  type LaneGraph,
  type SimScenarioInput,
  type StaticColliderClass,
  type StaticMapCollider,
} from '@simforge-oss/engine';

const SCHEMA = 'uniscenarios.static-map-colliders/v1';
const CLASSES = new Set<StaticColliderClass>(['building', 'wall', 'barrier', 'prop', 'road-boundary']);

interface DerivativeManifest {
  readonly sourceManifestSha256?: string;
  readonly variants?: {
    readonly 'static-colliders'?: {
      readonly schemaVersion?: number;
      readonly file?: string;
      readonly digest?: string;
      readonly outputSha256?: string;
    };
  };
}

interface StaticColliderArtifact {
  readonly schema: string;
  readonly mapId: string;
  readonly sourceManifestSha256: string;
  readonly sources: readonly { readonly id: string; readonly file: string; readonly declaredBytes: number | null }[];
  readonly colliders: readonly StaticMapCollider[];
  readonly statistics: Omit<StaticColliderDiagnostics, 'digest' | 'status' | 'warning'>;
  readonly digest: string;
}

export interface StaticColliderDiagnostics {
  readonly digest: string;
  readonly status: 'ready' | 'unavailable' | 'skipped';
  readonly warning?: string;
  readonly sourceTiles: number;
  readonly accepted: number;
  readonly rejectedRoadOverlap: number;
  readonly ignored: number;
  readonly classes: Readonly<Record<StaticColliderClass, number>>;
}

export interface StaticColliderBundle {
  readonly colliders: readonly StaticMapCollider[];
  readonly diagnostics: StaticColliderDiagnostics;
}

export function emptyStaticColliderBundle(
  status: 'unavailable' | 'skipped',
  warning: string,
): StaticColliderBundle {
  return {
    colliders: [],
    diagnostics: {
      digest: `static-colliders-v1-${status}`,
      status,
      warning,
      sourceTiles: 0,
      accepted: 0,
      rejectedRoadOverlap: 0,
      ignored: 0,
      classes: { building: 0, wall: 0, barrier: 0, prop: 0, 'road-boundary': 0 },
    },
  };
}

const cache = new Map<string, Promise<StaticColliderBundle>>();

/**
 * Load one precomputed collider artifact per map worker. Missing or malformed
 * derivatives resolve immediately to diagnostics; runtime GLB inspection is
 * deliberately not a fallback.
 */
export function loadStaticMapColliders(
  manifestUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<StaticColliderBundle> {
  const key = absoluteUrl(manifestUrl);
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = loadArtifact(key, fetcher).catch((error: unknown) => emptyStaticColliderBundle(
    'unavailable',
    error instanceof Error ? error.message : String(error),
  ));
  cache.set(key, pending);
  return pending;
}

/** Kept as a compatibility alias; artifact loading has no extraction timeout. */
export function loadStaticMapCollidersBounded(
  manifestUrl: string,
  _topology?: unknown,
  _timeoutMs?: number,
  fetcher: typeof fetch = fetch,
): Promise<StaticColliderBundle> {
  return loadStaticMapColliders(manifestUrl, fetcher);
}

async function loadArtifact(manifestUrl: string, fetcher: typeof fetch): Promise<StaticColliderBundle> {
  const derivativeUrl = new URL('variants/manifest.json', new URL('.', manifestUrl)).toString();
  const [sourceResponse, manifestResponse] = await Promise.all([fetcher(manifestUrl), fetcher(derivativeUrl)]);
  if (!sourceResponse.ok) throw new Error(`Map bundle manifest unavailable (${sourceResponse.status})`);
  if (!manifestResponse.ok) throw new Error(`Static collision derivative manifest unavailable (${manifestResponse.status})`);
  const sourceBytes = await sourceResponse.arrayBuffer();
  const manifest = await manifestResponse.json() as DerivativeManifest;
  if (!isSha256(manifest.sourceManifestSha256) || await sha256Hex(sourceBytes) !== manifest.sourceManifestSha256) {
    throw new Error('Static collision derivative targets a stale map bundle');
  }
  const variant = manifest.variants?.['static-colliders'];
  if (variant?.schemaVersion !== 1 || typeof variant.file !== 'string' || !isSha256(variant.outputSha256)) {
    throw new Error('Static collision derivative is not published for this map');
  }
  const artifactUrl = new URL(variant.file, new URL('.', derivativeUrl)).toString();
  const artifactResponse = await fetcher(artifactUrl);
  if (!artifactResponse.ok) throw new Error(`Static collision artifact unavailable (${artifactResponse.status})`);
  const bytes = await artifactResponse.arrayBuffer();
  if (await sha256Hex(bytes) !== variant.outputSha256) throw new Error('Static collision artifact checksum mismatch');
  const artifact = JSON.parse(new TextDecoder().decode(bytes)) as StaticColliderArtifact;
  validateArtifact(artifact, manifest, variant.digest);
  return {
    colliders: artifact.colliders,
    diagnostics: { digest: artifact.digest, status: 'ready', ...artifact.statistics },
  };
}

function validateArtifact(artifact: StaticColliderArtifact, manifest: DerivativeManifest, expectedDigest?: string): void {
  if (!artifact || artifact.schema !== SCHEMA || typeof artifact.mapId !== 'string') throw new Error('Static collision artifact has an unsupported schema');
  if (!isSha256(artifact.sourceManifestSha256) || artifact.sourceManifestSha256 !== manifest.sourceManifestSha256) {
    throw new Error('Static collision artifact targets a different map bundle');
  }
  if (!Array.isArray(artifact.sources) || !Array.isArray(artifact.colliders)) throw new Error('Static collision artifact has malformed collections');
  if (!artifact.statistics || artifact.statistics.accepted !== artifact.colliders.length || artifact.statistics.sourceTiles !== artifact.sources.length) {
    throw new Error('Static collision artifact statistics do not match its contents');
  }
  for (const value of [artifact.statistics.accepted, artifact.statistics.sourceTiles, artifact.statistics.rejectedRoadOverlap, artifact.statistics.ignored]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Static collision artifact statistics are malformed');
  }
  for (const name of CLASSES) {
    if (!Number.isSafeInteger(artifact.statistics.classes?.[name]) || artifact.statistics.classes[name] < 0) {
      throw new Error('Static collision artifact class statistics are malformed');
    }
  }
  let previousId = '';
  const seen = new Set<string>();
  for (const collider of artifact.colliders) {
    if (!collider || typeof collider.id !== 'string' || seen.has(collider.id) || collider.id.localeCompare(previousId) < 0) {
      throw new Error('Static collision artifact collider ids are invalid or non-deterministic');
    }
    seen.add(collider.id);
    previousId = collider.id;
    if (!CLASSES.has(collider.class) || !validObb(collider.obb)) throw new Error(`Static collision artifact has malformed collider ${collider.id}`);
  }
  if (!isSha256Digest(artifact.digest) || artifact.digest !== expectedDigest) throw new Error('Static collision artifact digest does not match its map bundle');
}

function validObb(obb: StaticMapCollider['obb'] | undefined): boolean {
  return Boolean(obb
    && Number.isFinite(obb.center?.x) && Number.isFinite(obb.center?.z)
    && Number.isFinite(obb.lengthM) && obb.lengthM > 0
    && Number.isFinite(obb.widthM) && obb.widthM > 0
    && Number.isFinite(obb.headingRad));
}

/**
 * Digest collider bytes with the engine's pure-TS SHA-256, never `crypto.subtle`.
 *
 * `crypto.subtle` exists only in a secure context, so on a plain-HTTP origin
 * that is not `localhost` — any LAN address or tunnelled host — it is
 * `undefined` and this threw "Cannot read properties of undefined (reading
 * 'digest')". The loader then reported the collider bundle as unavailable, the
 * compile failed closed, and the editor could never start a world. Serving over
 * HTTPS would also fix it, but requiring TLS to open a dev map is the wrong
 * constraint, and `packages/engine/src/core/hash.ts` was written for exactly
 * this reason: identical digests in the browser and in headless Node with no
 * platform branch.
 */
async function sha256Hex(data: ArrayBuffer): Promise<string> {
  return sha256Bytes(new Uint8Array(data));
}

function absoluteUrl(url: string): string {
  return new URL(url, globalThis.location?.href ?? 'http://localhost/').toString();
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256-[a-f0-9]{64}$/.test(value);
}

/** Test-only reset; production retains fulfilled and failed map lookups. */
export function resetStaticColliderCacheForTests(): void {
  cache.clear();
}

const TRAVEL_LANE_TYPES = new Set(['driving', 'biking', 'parking', 'shoulder']);
const ROAD_INDEX_CELL_M = 20;
const ROAD_EDGE_CLEARANCE_M = 0.75;
const MIN_LEGACY_FRAGMENT_EDGE_M = 3;
const MAX_LEGACY_FRAGMENTS_PER_COLLIDER = 4_096;

type StaticObb = StaticMapCollider['obb'];

interface TravelLaneSample {
  readonly x: number;
  readonly z: number;
  readonly clearanceM: number;
}

interface TravelLaneIndex {
  readonly buckets: ReadonlyMap<string, readonly TravelLaneSample[]>;
}

/** Fail closed when a requested map has no verified static collision artifact. */
export function requireReadyStaticColliderBundle(
  bundle: StaticColliderBundle,
  graph: LaneGraph,
): StaticColliderBundle {
  if (bundle.diagnostics.status === 'ready') return alignLegacyStaticCollidersToScene(bundle, graph);
  const detail = bundle.diagnostics.warning?.trim();
  throw new Error(`Static map collision data is ${bundle.diagnostics.status}${detail ? `: ${detail}` : '.'}`);
}

/**
 * Repair v1 collider artifacts emitted before GLB z coordinates were mapped to
 * scene coordinates, then remove coarse proxy fragments covering travel lanes.
 */
export function alignLegacyStaticCollidersToScene(
  bundle: StaticColliderBundle,
  graph: LaneGraph,
): StaticColliderBundle {
  if (bundle.colliders.length === 0) return bundle;
  const points = graph.laneRsls().flatMap((rsl) => graph.geometry(rsl)?.points ?? []);
  if (points.length === 0) return bundle;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const sceneZ = -point.y;
    minZ = Math.min(minZ, sceneZ);
    maxZ = Math.max(maxZ, sceneZ);
  }
  const distanceToRange = (value: number): number =>
    value < minZ ? minZ - value : value > maxZ ? value - maxZ : 0;
  const publishedScore = bundle.colliders.reduce(
    (sum, collider) => sum + distanceToRange(collider.obb.center.z) ** 2,
    0,
  );
  const mirroredScore = bundle.colliders.reduce(
    (sum, collider) => sum + distanceToRange(-collider.obb.center.z) ** 2,
    0,
  );
  if (!(mirroredScore + 1e-6 < publishedScore)) return bundle;
  const mirrored = bundle.colliders.map((collider) => ({
    ...collider,
    obb: {
      ...collider.obb,
      center: { ...collider.obb.center, z: -collider.obb.center.z },
      headingRad: -collider.obb.headingRad,
    },
  }));
  return { ...bundle, colliders: carveLegacyTravelCorridors(mirrored, graph) };
}

/** Split legacy proxy OBBs and retain only fragments outside travelled lanes. */
export function carveLegacyTravelCorridors(
  colliders: readonly StaticMapCollider[],
  graph: LaneGraph,
): StaticMapCollider[] {
  const index = buildTravelLaneIndex(graph);
  if (index.buckets.size === 0) return [...colliders];
  return colliders.flatMap((collider) => {
    const fragments: StaticMapCollider[] = [];
    splitOutsideTravelLanes(collider, collider.obb, '', index, fragments);
    return fragments;
  });
}

function buildTravelLaneIndex(graph: LaneGraph): TravelLaneIndex {
  const mutable = new Map<string, TravelLaneSample[]>();
  for (const rsl of graph.laneRsls()) {
    const geometry = graph.geometry(rsl);
    if (!geometry) continue;
    const laneType = geometry.lane?.laneType;
    if (laneType !== undefined && !TRAVEL_LANE_TYPES.has(laneType)) continue;
    const clearanceM = Math.max(
      1,
      (Number.isFinite(geometry.widthM) ? geometry.widthM : 3.5) / 2 + ROAD_EDGE_CLEARANCE_M,
    );
    for (const point of geometry.points) {
      const sample = { x: point.x, z: -point.y, clearanceM };
      const key = roadCell(sample.x, sample.z);
      const bucket = mutable.get(key) ?? [];
      bucket.push(sample);
      mutable.set(key, bucket);
    }
  }
  return { buckets: mutable };
}

function splitOutsideTravelLanes(
  collider: StaticMapCollider,
  obb: StaticObb,
  suffix: string,
  index: TravelLaneIndex,
  output: StaticMapCollider[],
): void {
  if (!overlapsTravelLane(obb, index)) {
    output.push({ ...collider, id: suffix ? `${collider.id}#${suffix}` : collider.id, obb });
    return;
  }
  if (
    Math.max(obb.lengthM, obb.widthM) <= MIN_LEGACY_FRAGMENT_EDGE_M
    || output.length >= MAX_LEGACY_FRAGMENTS_PER_COLLIDER
  ) return;

  const cos = Math.cos(obb.headingRad);
  const sin = Math.sin(obb.headingRad);
  if (obb.lengthM >= obb.widthM) {
    const lengthM = obb.lengthM / 2;
    const offsetM = obb.lengthM / 4;
    splitOutsideTravelLanes(collider, {
      ...obb,
      center: { x: obb.center.x - offsetM * cos, z: obb.center.z - offsetM * sin },
      lengthM,
    }, `${suffix}a`, index, output);
    splitOutsideTravelLanes(collider, {
      ...obb,
      center: { x: obb.center.x + offsetM * cos, z: obb.center.z + offsetM * sin },
      lengthM,
    }, `${suffix}b`, index, output);
    return;
  }

  const widthM = obb.widthM / 2;
  const offsetM = obb.widthM / 4;
  splitOutsideTravelLanes(collider, {
    ...obb,
    center: { x: obb.center.x + offsetM * sin, z: obb.center.z - offsetM * cos },
    widthM,
  }, `${suffix}a`, index, output);
  splitOutsideTravelLanes(collider, {
    ...obb,
    center: { x: obb.center.x - offsetM * sin, z: obb.center.z + offsetM * cos },
    widthM,
  }, `${suffix}b`, index, output);
}

function overlapsTravelLane(obb: StaticObb, index: TravelLaneIndex): boolean {
  const radiusM = Math.hypot(obb.lengthM, obb.widthM) / 2 + 4;
  const x0 = Math.floor((obb.center.x - radiusM) / ROAD_INDEX_CELL_M);
  const x1 = Math.floor((obb.center.x + radiusM) / ROAD_INDEX_CELL_M);
  const z0 = Math.floor((obb.center.z - radiusM) / ROAD_INDEX_CELL_M);
  const z1 = Math.floor((obb.center.z + radiusM) / ROAD_INDEX_CELL_M);
  const cos = Math.cos(obb.headingRad);
  const sin = Math.sin(obb.headingRad);
  for (let x = x0; x <= x1; x += 1) {
    for (let z = z0; z <= z1; z += 1) {
      for (const sample of index.buckets.get(`${x},${z}`) ?? []) {
        const dx = sample.x - obb.center.x;
        const dz = sample.z - obb.center.z;
        const longitudinalM = dx * cos + dz * sin;
        const lateralM = -dx * sin + dz * cos;
        if (
          Math.abs(longitudinalM) <= obb.lengthM / 2 + sample.clearanceM
          && Math.abs(lateralM) <= obb.widthM / 2 + sample.clearanceM
        ) return true;
      }
    }
  }
  return false;
}

function roadCell(x: number, z: number): string {
  return `${Math.floor(x / ROAD_INDEX_CELL_M)},${Math.floor(z / ROAD_INDEX_CELL_M)}`;
}

/** Create the strict fixed-step runtime used by collision-aware playback. */
export function createCollisionAwareFixedStepSimulation(
  input: SimScenarioInput,
  graph: LaneGraph,
  staticColliders: readonly StaticMapCollider[] | undefined,
) {
  return createFixedStepSimulation(input, {
    graph,
    guards: 'throw',
    staticColliders: staticColliders ?? [],
  });
}
