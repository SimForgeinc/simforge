import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import type { Material, Object3D, Scene, WebGLProgramParametersWithUniforms } from 'three';
import { classifySurface, type SurfaceLayer } from './surface-materials';
import type { ResolvedSnowCoverVariant } from './asset-variants';
import { patchMaterialWithBakedShadow, type ShadowPatchOptions } from './materials';

export const SNOW_COVER_OBJECT_NAME = 'city-snow-cover';

export interface SnowCoverAppearance {
  coverage: number;
  depthM?: number;
  compaction?: number;
}

export interface SnowDerivativeAsset {
  root: Object3D;
  bytes: number;
  dispose: () => void;
}

export interface SnowCoverControllerOptions {
  loadDerivative?: (
    derivative: ResolvedSnowCoverVariant,
    signal: AbortSignal,
  ) => Promise<SnowDerivativeAsset>;
  /** Shared viewer-memory admission. A rejection leaves the base material snow visible. */
  admit?: (bytes: number) => boolean;
  maxConcurrentDerivatives?: number;
}

export interface SnowCoverStats {
  active: boolean;
  coverage: number;
  depthM: number;
  compaction: number;
  registeredReceivers: number;
  shellMeshes: number;
  triangles: number;
  derivativeMeshes: number;
  fallbackMeshes: number;
  pendingDerivatives: number;
  derivativeLoads: number;
  derivativeFailures: number;
  fallbackFailures: number;
  residentBytes: number;
  pendingBytes: number;
  queuedDerivatives: number;
  queuedFallbacks: number;
  rejectedAssets: number;
  shaderOnlyReceivers: number;
  skippedInstancedMeshes: number;
}

interface ReceiverRecord {
  source: Object3D;
  layer: Exclude<SurfaceLayer, 'vegetation'>;
  slot: string | null;
  derivative: ResolvedSnowCoverVariant | null;
  shell: Group | null;
  fallbackGeometry: BufferGeometry | null;
  derivativeAsset: SnowDerivativeAsset | null;
  derivativeController: AbortController | null;
  derivativePendingBytes: number;
  derivativePendingGeneration: number;
  generation: number;
  fallbackTriangles: number;
  skippedInstancedMeshes: number;
  derivativeQueued: boolean;
  fallbackQueued: boolean;
  admissionRejected: boolean;
}

type SnowShader = WebGLProgramParametersWithUniforms;

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _ab = new Vector3();
const _ac = new Vector3();
const _normal = new Vector3();

const MIN_RECEIVER_NORMAL_Y = 0.28;
const MAX_SNOW_DEPTH_M = 1;
const MAX_SNOW_DRIFT_M = 0.018;
// Indexed ground sheets are dominated by one unindexed top (3 vertices x 8
// floats) plus sparse perimeter skirts. Exact post-build admission handles
// pathological disconnected triangles without rejecting normal grids 7x early.
const FALLBACK_BYTES_PER_SOURCE_TRIANGLE = 128;
const EXPLICIT_TERRAIN_RECEIVER = /(?:^|[^a-z])(terrain|ground|soil|earth|verge)(?:[^a-z]|$)/i;
const EXPLICIT_TERRAIN_EXCLUSION = /marking|lane[_ -]?mark|road[_ -]?line|crosswalk|decal|utility|crack|oilpath/i;

function isExplicitTerrainReceiver(mesh: Mesh, material: Material): boolean {
  const identity = `${mesh.name} ${material.name}`;
  return EXPLICIT_TERRAIN_RECEIVER.test(identity) && !EXPLICIT_TERRAIN_EXCLUSION.test(identity);
}

function clampUnit(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Legacy coverage-only weather maps onto the four authored accumulation tiers. */
export function defaultSnowDepthForCoverage(coverage: number): number {
  const normalized = clampUnit(coverage);
  if (normalized <= 0) return 0;
  if (normalized <= 1 / 3) return 0.015;
  if (normalized <= 2 / 3) return 0.075;
  return 0.18;
}

function normalizedAppearance(appearance: SnowCoverAppearance): Required<SnowCoverAppearance> {
  const coverage = clampUnit(appearance.coverage);
  const requestedDepth = appearance.depthM;
  const depthM = requestedDepth === undefined || !Number.isFinite(requestedDepth)
    ? defaultSnowDepthForCoverage(coverage)
    : Math.max(0, Math.min(MAX_SNOW_DEPTH_M, requestedDepth));
  return {
    coverage,
    depthM: coverage > 0 ? depthM : 0,
    compaction: clampUnit(appearance.compaction),
  };
}

function hasPhysicalBody(appearance: Required<SnowCoverAppearance>): boolean {
  return appearance.coverage > 0 && appearance.depthM > 0;
}

function geometryBytes(geometry: BufferGeometry): number {
  let bytes = geometry.index?.array.byteLength ?? 0;
  for (const attribute of Object.values(geometry.attributes)) bytes += attribute.array.byteLength;
  return bytes;
}

function isWorldVisible(source: Object3D): boolean {
  if (source.parent === null) return false;
  let current: Object3D | null = source;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

function vertexKey(value: Vector3): string {
  return `${Math.round(value.x * 10_000)},${Math.round(value.y * 10_000)},${Math.round(value.z * 10_000)}`;
}

interface BoundaryEdge {
  count: number;
  a: Vector3;
  b: Vector3;
}

function appendVertex(
  positions: number[],
  normals: number[],
  lifts: number[],
  tops: number[],
  point: Vector3,
  normal: Vector3,
  lift: number,
  top: number,
): void {
  positions.push(point.x, point.y, point.z);
  normals.push(normal.x, normal.y, normal.z);
  lifts.push(lift);
  tops.push(top);
}

function materialIndexAt(geometry: BufferGeometry, offset: number): number {
  for (const group of geometry.groups) {
    if (offset >= group.start && offset < group.start + group.count) return group.materialIndex ?? 0;
  }
  return 0;
}

/**
 * Builds an immutable world-space receiver shell from upward triangles. The
 * top uses a per-vertex lift attribute; boundary quads keep their lower edge on
 * the authored surface, producing visible snow depth at curbs and silhouettes.
 */
interface ShellGeometryBuild {
  geometry: BufferGeometry | null;
  triangles: number;
  skippedInstancedMeshes: number;
}

function estimateFallbackBytes(root: Object3D): number {
  let triangles = 0;
  root.traverse((object) => {
    const mesh = object as Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean };
    if (!mesh.isMesh || mesh.isInstancedMesh || mesh.isSkinnedMesh) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;
    triangles += Math.floor((mesh.geometry.index?.count ?? position.count) / 3);
  });
  return triangles * FALLBACK_BYTES_PER_SOURCE_TRIANGLE;
}

function buildShellGeometry(
  root: Object3D,
  layer: Exclude<SurfaceLayer, 'vegetation'>,
  trustedDerivative = false,
): ShellGeometryBuild {
  root.updateMatrixWorld(true);
  const positions: number[] = [];
  const normals: number[] = [];
  const lifts: number[] = [];
  const tops: number[] = [];
  let triangleCount = 0;
  let skippedInstancedMeshes = 0;
  // One root-wide edge ledger prevents skirts at seams between primitives or
  // sibling meshes that share the same authored world-space boundary.
  const boundary = new Map<string, BoundaryEdge>();

  root.traverse((object) => {
    const mesh = object as Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean };
    if (!mesh.isMesh) return;
    // Static instance transforms are not represented by matrixWorld. Cloning
    // the prototype once would put snow at the wrong instances, so retain the
    // material-only snow response until a derivative provides baked geometry.
    if (mesh.isInstancedMesh) {
      skippedInstancedMeshes++;
      return;
    }
    if (mesh.isSkinnedMesh) return;
    const source = mesh.geometry;
    const position = source.getAttribute('position');
    if (!position || position.itemSize < 3) return;
    const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).filter(
      (material): material is Material => Boolean(material),
    );
    if (materials.length === 0) return;
    const eligible = materials.map((material) => {
      if (trustedDerivative) return true;
      const kind = classifySurface(mesh, material, layer).kind;
      return kind === 'asphalt' || kind === 'grass' || kind === 'concrete' || kind === 'curb'
        || (kind === 'unknown' && isExplicitTerrainReceiver(mesh, material));
    });
    const count = source.index?.count ?? position.count;
    const start = Math.max(0, source.drawRange.start);
    const end = Math.min(count, Number.isFinite(source.drawRange.count) ? start + source.drawRange.count : count);
    const read = (vertex: number, target: Vector3): Vector3 => {
      target.set(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
      return target.applyMatrix4(mesh.matrixWorld);
    };
    const indexAt = (offset: number): number => source.index?.getX(offset) ?? offset;

    for (let offset = start; offset + 2 < end; offset += 3) {
      if (!eligible[materialIndexAt(source, offset)]) continue;
      read(indexAt(offset), _a);
      read(indexAt(offset + 1), _b);
      read(indexAt(offset + 2), _c);
      _ab.subVectors(_b, _a);
      _ac.subVectors(_c, _a);
      _normal.crossVectors(_ab, _ac);
      const lengthSq = _normal.lengthSq();
      if (lengthSq < 1e-12) continue;
      _normal.multiplyScalar(1 / Math.sqrt(lengthSq));
      if (_normal.y < MIN_RECEIVER_NORMAL_Y) continue;

      appendVertex(positions, normals, lifts, tops, _a, _normal, 1, 1);
      appendVertex(positions, normals, lifts, tops, _b, _normal, 1, 1);
      appendVertex(positions, normals, lifts, tops, _c, _normal, 1, 1);
      triangleCount++;

      const addEdge = (from: Vector3, to: Vector3): void => {
        const fromKey = vertexKey(from);
        const toKey = vertexKey(to);
        const key = fromKey < toKey ? `${fromKey}|${toKey}` : `${toKey}|${fromKey}`;
        const found = boundary.get(key);
        if (found) found.count++;
        else boundary.set(key, { count: 1, a: from.clone(), b: to.clone() });
      };
      addEdge(_a, _b);
      addEdge(_b, _c);
      addEdge(_c, _a);
    }

  });

  for (const edge of boundary.values()) {
    if (edge.count !== 1) continue;
    const direction = _ab.subVectors(edge.b, edge.a);
    _normal.set(direction.z, 0, -direction.x).normalize();
    // bottom A, bottom B, top B / bottom A, top B, top A
    appendVertex(positions, normals, lifts, tops, edge.a, _normal, 0, 0);
    appendVertex(positions, normals, lifts, tops, edge.b, _normal, 0, 0);
    appendVertex(positions, normals, lifts, tops, edge.b, _normal, 1, 0);
    appendVertex(positions, normals, lifts, tops, edge.a, _normal, 0, 0);
    appendVertex(positions, normals, lifts, tops, edge.b, _normal, 1, 0);
    appendVertex(positions, normals, lifts, tops, edge.a, _normal, 1, 0);
    triangleCount += 2;
  }

  if (positions.length === 0) return { geometry: null, triangles: 0, skippedInstancedMeshes };
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('snowLift', new Float32BufferAttribute(lifts, 1));
  geometry.setAttribute('snowTopSurface', new Float32BufferAttribute(tops, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  if (geometry.boundingBox) geometry.boundingBox.max.y += MAX_SNOW_DEPTH_M + MAX_SNOW_DRIFT_M;
  if (geometry.boundingSphere) geometry.boundingSphere.radius += MAX_SNOW_DEPTH_M + MAX_SNOW_DRIFT_M;
  return { geometry, triangles: triangleCount, skippedInstancedMeshes };
}

function createSnowMaterial(
  coverageUniform: { value: number },
  depthUniform: { value: number },
  compactionUniform: { value: number },
  liftsVertices: boolean,
): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: new Color(0xe9f0f5),
    roughness: 0.97,
    metalness: 0,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  material.name = liftsVertices ? 'city-snow-fallback-material' : 'city-snow-derivative-material';
  installSnowShader(material, coverageUniform, depthUniform, compactionUniform, liftsVertices);
  return material;
}

function installSnowShader(
  material: MeshStandardMaterial,
  coverageUniform: { value: number },
  depthUniform: { value: number },
  compactionUniform: { value: number },
  liftsVertices: boolean,
): void {
  const baseCompile = material.onBeforeCompile;
  const baseKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader: SnowShader, renderer) => {
    baseCompile.call(material, shader, renderer);
    shader.uniforms.snowCoverage = coverageUniform;
    shader.uniforms.snowDepthM = depthUniform;
    shader.uniforms.snowCompaction = compactionUniform;
    const liftDeclaration = liftsVertices ? /* glsl */ `
attribute float snowLift;
attribute float snowTopSurface;
float snowVertexHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float snowVertexNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  local = local * local * (3.0 - 2.0 * local);
  return mix(mix(snowVertexHash(cell), snowVertexHash(cell + vec2(1.0, 0.0)), local.x),
             mix(snowVertexHash(cell + vec2(0.0, 1.0)), snowVertexHash(cell + 1.0), local.x), local.y);
}
` : '';
    const liftBody = liftsVertices
      ? /* glsl */ `
vec2 snowVertexWorldXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
float snowVertexDrift = snowVertexNoise(snowVertexWorldXZ * 0.19) * 0.72
  + snowVertexNoise(snowVertexWorldXZ * 0.71 + 23.0) * 0.28;
float snowVertexAmplitude = min(0.018, snowDepthM * 0.12) * mix(1.0, 0.35, snowCompaction);
float snowVertexHeight = max(0.0, snowDepthM + (snowVertexDrift - 0.5) * 2.0 * snowVertexAmplitude);
transformed.y += snowVertexHeight * snowLift;
vSnowTopSurface = snowTopSurface;
`
      : 'vSnowTopSurface = 1.0;\n';
    shader.vertexShader = `${liftDeclaration}uniform float snowDepthM;\nuniform float snowCompaction;\nvarying vec3 vSnowWorldPosition;\nvarying float vSnowTopSurface;\n${shader.vertexShader}`
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${liftBody}vSnowWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = /* glsl */ `
uniform float snowCoverage;
uniform float snowCompaction;
varying vec3 vSnowWorldPosition;
varying float vSnowTopSurface;
float snowHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float snowNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  local = local * local * (3.0 - 2.0 * local);
  return mix(mix(snowHash(cell), snowHash(cell + vec2(1.0, 0.0)), local.x),
             mix(snowHash(cell + vec2(0.0, 1.0)), snowHash(cell + 1.0), local.x), local.y);
}
float snowNormalHeight(vec2 p) {
  return snowNoise(p * 3.4) * 0.68 + snowNoise(p * 14.0 + 31.0) * 0.32;
}
${shader.fragmentShader}`.replace(
      '#include <clipping_planes_fragment>',
      /* glsl */ `#include <clipping_planes_fragment>
float snowFine = snowHash(floor(vSnowWorldPosition.xz * 2.7));
float snowBroad = snowHash(floor(vSnowWorldPosition.xz * 0.31 + 19.0));
float snowMask = snowFine * 0.38 + snowBroad * 0.62;
// The same world-XZ mask reaches the skirt. A small continuity bias prevents
// hairline cracks without turning a dusting into a continuous white wall.
float snowCoverageWithSkirtBias = min(1.0, snowCoverage + (1.0 - vSnowTopSurface) * 0.08);
if (snowMask < 1.0 - snowCoverageWithSkirtBias) discard;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.98, 0.80, snowCompaction);',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `#include <normal_fragment_maps>
float snowNormalStep = 0.035;
float snowNormalCenter = snowNormalHeight(vSnowWorldPosition.xz);
float snowNormalX = snowNormalHeight(vSnowWorldPosition.xz + vec2(snowNormalStep, 0.0));
float snowNormalZ = snowNormalHeight(vSnowWorldPosition.xz + vec2(0.0, snowNormalStep));
float snowNormalStrength = mix(0.22, 0.07, snowCompaction);
vec3 snowWorldNormal = normalize(vec3(
  (snowNormalCenter - snowNormalX) * snowNormalStrength,
  snowNormalStep,
  (snowNormalCenter - snowNormalZ) * snowNormalStrength
));
vec3 snowViewNormal = normalize(mat3(viewMatrix) * snowWorldNormal);
normal = normalize(mix(normal, snowViewNormal, vSnowTopSurface * 0.62));`,
    );
  };
  material.customProgramCacheKey = () => `${baseKey.call(material)}|${liftsVertices ? 'city-snow-shell-v2-lift' : 'city-snow-shell-v2-static'}`;
  material.needsUpdate = true;
}

/** Backend-neutral snow body controller for streamed, static map geometry. */
export class SnowCoverController {
  readonly group = new Group();

  private readonly scene: Scene;
  private readonly options: SnowCoverControllerOptions;
  private readonly receivers = new Map<Object3D, ReceiverRecord>();
  private readonly slots = new Map<string, Set<Object3D>>();
  private readonly derivativeQueue: ReceiverRecord[] = [];
  private readonly fallbackQueue: ReceiverRecord[] = [];
  private readonly coverageUniform = { value: 0 };
  private readonly depthUniform = { value: 0 };
  private readonly compactionUniform = { value: 0 };
  private readonly fallbackMaterial = createSnowMaterial(
    this.coverageUniform, this.depthUniform, this.compactionUniform, true,
  );
  private appearance = normalizedAppearance({ coverage: 0 });
  private disposed = false;
  private pendingDerivatives = 0;
  private pendingBytes = 0;
  private derivativeLoads = 0;
  private derivativeFailures = 0;
  private fallbackFailures = 0;
  private rejectedAssets = 0;
  private activeDerivativeLoads = 0;

  constructor(scene: Scene, options: SnowCoverControllerOptions = {}) {
    this.scene = scene;
    this.options = options;
    this.group.name = SNOW_COVER_OBJECT_NAME;
    this.group.userData.simforgeRole = 'city-snow-cover';
    this.group.renderOrder = 4;
    scene.add(this.group);
  }

  /** Compose the map's baked atlas before snow displacement/microdetail. */
  setShadowOptions(options: ShadowPatchOptions | null): void {
    // Reset to a clean base so map reloads never retain a disposed atlas or
    // recursively wrap the previous snow shader.
    this.fallbackMaterial.onBeforeCompile = () => undefined;
    this.fallbackMaterial.customProgramCacheKey = () => '';
    delete this.fallbackMaterial.userData.cityShadow;
    if (options) patchMaterialWithBakedShadow(this.fallbackMaterial, options);
    installSnowShader(
      this.fallbackMaterial,
      this.coverageUniform,
      this.depthUniform,
      this.compactionUniform,
      true,
    );
    this.fallbackMaterial.userData.citySnowShaderOrder = options
      ? ['baked-shadow', 'snow-microdetail']
      : ['snow-microdetail'];
  }

  registerTree(
    source: Object3D,
    layer: Exclude<SurfaceLayer, 'vegetation'>,
    derivative: ResolvedSnowCoverVariant | null = null,
    slot: string | null = null,
  ): void {
    if (this.disposed || this.receivers.has(source)) return;
    const record: ReceiverRecord = {
      source,
      layer,
      slot,
      derivative,
      shell: null,
      fallbackGeometry: null,
      derivativeAsset: null,
      derivativeController: null,
      derivativePendingBytes: 0,
      derivativePendingGeneration: 0,
      generation: 0,
      fallbackTriangles: 0,
      skippedInstancedMeshes: 0,
      derivativeQueued: false,
      fallbackQueued: false,
      admissionRejected: false,
    };
    this.receivers.set(source, record);
    if (slot) {
      const candidates = this.slots.get(slot) ?? new Set<Object3D>();
      candidates.add(source);
      this.slots.set(slot, candidates);
      if (hasPhysicalBody(this.appearance)) this.syncSlot(slot);
    } else if (hasPhysicalBody(this.appearance)) this.activate(record);
  }

  unregisterTree(source: Object3D): void {
    const record = this.receivers.get(source);
    if (!record) return;
    this.clearRecord(record);
    this.receivers.delete(source);
    if (record.slot) {
      const candidates = this.slots.get(record.slot);
      candidates?.delete(source);
      if (candidates?.size === 0) this.slots.delete(record.slot);
      else if (hasPhysicalBody(this.appearance)) this.syncSlot(record.slot);
    }
  }

  setAppearance(next: SnowCoverAppearance): SnowCoverStats {
    if (this.disposed) return this.stats();
    const normalized = normalizedAppearance(next);
    const wasActive = hasPhysicalBody(this.appearance);
    this.appearance = normalized;
    this.coverageUniform.value = normalized.coverage;
    this.depthUniform.value = normalized.depthM;
    this.compactionUniform.value = normalized.compaction;
    this.fallbackMaterial.color.setHex(normalized.compaction > 0.65 ? 0xdce7ef : 0xe9f0f5);
    if (!hasPhysicalBody(normalized)) {
      for (const record of this.receivers.values()) this.clearRecord(record);
      this.derivativeQueue.length = 0;
      this.fallbackQueue.length = 0;
    } else if (!wasActive) {
      for (const record of this.receivers.values()) if (!record.slot) this.activate(record);
      for (const slot of this.slots.keys()) this.syncSlot(slot);
    }
    return this.stats();
  }

  /** Retry shader-only receivers after the viewer raises its shared byte budget. */
  retryRejected(): void {
    if (!hasPhysicalBody(this.appearance)) return;
    for (const record of this.receivers.values()) {
      if (!record.admissionRejected || !record.shell) continue;
      record.admissionRejected = false;
      if (record.derivative && this.options.loadDerivative) this.enqueueDerivative(record);
      else this.enqueueFallback(record);
    }
    this.pumpDerivativeQueue();
  }

  /** Mirrors source LOD visibility without putting shells under pickable map groups. */
  tick(): void {
    if (!hasPhysicalBody(this.appearance)) return;
    for (const slot of this.slots.keys()) this.syncSlot(slot);
    this.pumpDerivativeQueue();
    this.buildOneFallback();
    for (const record of this.receivers.values()) {
      if (record.shell) record.shell.visible = isWorldVisible(record.source);
    }
  }

  private syncSlot(slot: string): void {
    const candidates = this.slots.get(slot);
    if (!candidates) return;
    let displayed: Object3D | null = null;
    for (const source of candidates) {
      if (isWorldVisible(source)) displayed = source;
    }
    for (const source of candidates) {
      const record = this.receivers.get(source);
      if (!record) continue;
      if (source === displayed) this.activate(record);
      else if (record.shell) this.clearRecord(record);
    }
  }

  private activate(record: ReceiverRecord): void {
    if (record.shell) return;
    const shell = new Group();
    shell.name = `${record.source.name || 'receiver'}.snow`;
    shell.userData.simforgeRole = 'city-snow-cover';
    shell.userData.sourceObject = record.source.name;
    record.shell = shell;
    this.group.add(shell);
    shell.visible = isWorldVisible(record.source);
    if (record.derivative && this.options.loadDerivative) this.enqueueDerivative(record);
    else this.enqueueFallback(record);
    this.pumpDerivativeQueue();
  }

  private enqueueDerivative(record: ReceiverRecord): void {
    if (record.derivativeQueued || record.derivativeController || record.derivativeAsset || !record.shell) return;
    record.derivativeQueued = true;
    this.derivativeQueue.push(record);
  }

  private enqueueFallback(record: ReceiverRecord): void {
    if (record.fallbackQueued || record.fallbackGeometry || !record.shell) return;
    record.fallbackQueued = true;
    this.fallbackQueue.push(record);
  }

  private pumpDerivativeQueue(): void {
    const cap = Math.max(1, Math.min(8, this.options.maxConcurrentDerivatives ?? 2));
    while (this.activeDerivativeLoads < cap && this.derivativeQueue.length > 0) {
      const record = this.derivativeQueue.shift()!;
      record.derivativeQueued = false;
      if (!record.shell || !record.derivative || record.derivativeController || record.derivativeAsset) continue;
      const estimate = record.derivative.estimatedBytes ?? record.derivative.bytes;
      if (!Number.isFinite(estimate) || estimate <= 0) {
        this.rejectRecord(record);
        this.enqueueFallback(record);
        continue;
      }
      if (this.options.admit && !this.options.admit(estimate)) {
        this.rejectRecord(record);
        this.enqueueFallback(record);
        continue;
      }
      this.loadDerivative(record);
    }
  }

  private buildOneFallback(): void {
    while (this.fallbackQueue.length > 0) {
      const record = this.fallbackQueue.shift()!;
      record.fallbackQueued = false;
      if (!record.shell || record.fallbackGeometry || record.derivativeAsset) continue;
      let estimate: number;
      try {
        estimate = estimateFallbackBytes(record.source);
      } catch {
        this.fallbackFailures++;
        this.rejectRecord(record);
        return;
      }
      if (!Number.isFinite(estimate)) {
        this.rejectRecord(record);
        return;
      }
      if (estimate <= 0) {
        try {
          const empty = buildShellGeometry(record.source, record.layer);
          record.skippedInstancedMeshes += empty.skippedInstancedMeshes;
          empty.geometry?.dispose();
          record.admissionRejected = true;
        } catch {
          this.fallbackFailures++;
          this.rejectRecord(record);
        }
        return;
      }
      if (this.options.admit && !this.options.admit(estimate)) {
        this.rejectRecord(record);
        return;
      }
      this.pendingBytes += estimate;
      try {
        const fallback = buildShellGeometry(record.source, record.layer);
        record.skippedInstancedMeshes += fallback.skippedInstancedMeshes;
        if (!fallback.geometry) {
          record.admissionRejected = true;
          return;
        }
        const actualBytes = geometryBytes(fallback.geometry);
        // The estimate remains on the pending ledger during this call, so the
        // shared governor evaluates exactly T + estimate + excess == T + actual.
        if (actualBytes > estimate && this.options.admit && !this.options.admit(actualBytes - estimate)) {
          fallback.geometry.dispose();
          this.rejectRecord(record);
          return;
        }
        const mesh = new Mesh(fallback.geometry, this.fallbackMaterial);
        mesh.name = `${record.source.name || 'receiver'}.snow-fallback`;
        mesh.frustumCulled = true;
        mesh.renderOrder = 4;
        mesh.userData.simforgeRole = 'city-snow-cover';
        mesh.raycast = () => undefined;
        record.shell.add(mesh);
        record.fallbackGeometry = fallback.geometry;
        record.fallbackTriangles = fallback.triangles;
        record.admissionRejected = false;
        return;
      } catch {
        this.fallbackFailures++;
        this.rejectRecord(record);
        return;
      } finally {
        this.pendingBytes = Math.max(0, this.pendingBytes - estimate);
      }
    }
  }

  private rejectRecord(record: ReceiverRecord): void {
    if (!record.admissionRejected) this.rejectedAssets++;
    record.admissionRejected = true;
  }

  private loadDerivative(record: ReceiverRecord): void {
    const derivative = record.derivative;
    const loader = this.options.loadDerivative;
    if (!derivative || !loader || record.derivativeController) return;
    const controller = new AbortController();
    const generation = ++record.generation;
    record.derivativeController = controller;
    this.activeDerivativeLoads++;
    this.pendingDerivatives++;
    const estimate = derivative.estimatedBytes ?? derivative.bytes;
    this.pendingBytes += estimate;
    record.derivativePendingBytes = estimate;
    record.derivativePendingGeneration = generation;
    let loadPromise: Promise<SnowDerivativeAsset>;
    try {
      loadPromise = loader(derivative, controller.signal);
    } catch (error) {
      loadPromise = Promise.reject(error);
    }
    void loadPromise.then((asset) => {
      if (this.disposed || controller.signal.aborted || record.generation !== generation || !record.shell) {
        asset.dispose();
        return;
      }
      record.derivativeController = null;
      // Derivatives intentionally carry top receivers only. Rebuild them into
      // the same lifted-top/pinned-bottom representation as the runtime path,
      // which closes silhouettes and primitive boundaries at any live depth.
      let closed: ShellGeometryBuild;
      try {
        closed = buildShellGeometry(asset.root, record.layer, true);
      } finally {
        // Parsed GLTF resources are temporary even when malformed geometry
        // throws during closed-shell construction.
        asset.dispose();
      }
      if (!closed.geometry) throw new Error(`snow derivative contains no upward receivers: ${derivative.file}`);
      const closedGeometry = closed.geometry;
      const actualBytes = geometryBytes(closedGeometry);
      const additionalBytes = Math.max(0, actualBytes - estimate);
      if (additionalBytes > 0 && this.options.admit && !this.options.admit(additionalBytes)) {
        closedGeometry.dispose();
        this.rejectRecord(record);
        return;
      }
      const derivativeRoot = new Group();
      derivativeRoot.name = `${record.source.name || 'receiver'}.snow-derivative`;
      derivativeRoot.position.y = -derivative.baseShellOffsetM;
      derivativeRoot.userData.simforgeRole = 'city-snow-cover';
      const derivativeMesh = new Mesh(closedGeometry, this.fallbackMaterial);
      derivativeMesh.name = `${derivativeRoot.name}.closed-shell`;
      derivativeMesh.raycast = () => undefined;
      derivativeMesh.renderOrder = 4;
      derivativeRoot.add(derivativeMesh);
      const closedAsset: SnowDerivativeAsset = {
        root: derivativeRoot,
        bytes: actualBytes,
        dispose: () => closedGeometry.dispose(),
      };
      record.derivativeAsset = closedAsset;
      record.admissionRejected = false;
      record.skippedInstancedMeshes += closed.skippedInstancedMeshes;
      record.shell.add(derivativeRoot);
      if (record.fallbackGeometry) {
        record.shell.children.find((child) => child.name.endsWith('.snow-fallback'))?.removeFromParent();
        record.fallbackGeometry.dispose();
        record.fallbackGeometry = null;
        record.fallbackTriangles = 0;
      }
      this.derivativeLoads++;
    }).catch((error: unknown) => {
      if ((error as { name?: string } | null)?.name !== 'AbortError' && !controller.signal.aborted) {
        this.derivativeFailures++;
        if (record.shell) this.enqueueFallback(record);
      }
      if (record.generation === generation) record.derivativeController = null;
    }).finally(() => {
      this.activeDerivativeLoads = Math.max(0, this.activeDerivativeLoads - 1);
      this.releasePending(record, generation);
      this.pumpDerivativeQueue();
    });
  }

  private releasePending(record: ReceiverRecord, generation?: number): void {
    if (generation !== undefined && record.derivativePendingGeneration !== generation) return;
    if (record.derivativePendingGeneration === 0) return;
    this.pendingDerivatives = Math.max(0, this.pendingDerivatives - 1);
    this.pendingBytes = Math.max(0, this.pendingBytes - Math.max(0, record.derivativePendingBytes));
    record.derivativePendingBytes = 0;
    record.derivativePendingGeneration = 0;
  }

  private clearRecord(record: ReceiverRecord): void {
    record.generation++;
    record.derivativeController?.abort();
    record.derivativeController = null;
    record.derivativeQueued = false;
    record.fallbackQueued = false;
    this.releasePending(record);
    record.shell?.removeFromParent();
    record.shell = null;
    record.fallbackGeometry?.dispose();
    record.fallbackGeometry = null;
    record.fallbackTriangles = 0;
    record.skippedInstancedMeshes = 0;
    record.admissionRejected = false;
    record.derivativeAsset?.dispose();
    record.derivativeAsset = null;
  }

  stats(): SnowCoverStats {
    let fallbackMeshes = 0;
    let derivativeMeshes = 0;
    let triangles = 0;
    let residentBytes = 0;
    let queuedDerivatives = 0;
    let queuedFallbacks = 0;
    let shaderOnlyReceivers = 0;
    let skippedInstancedMeshes = 0;
    for (const record of this.receivers.values()) {
      if (record.derivativeQueued) queuedDerivatives++;
      if (record.fallbackQueued) queuedFallbacks++;
      if (record.admissionRejected && record.shell) shaderOnlyReceivers++;
      skippedInstancedMeshes += record.skippedInstancedMeshes;
      if (record.fallbackGeometry) {
        fallbackMeshes++;
        triangles += record.fallbackTriangles;
        residentBytes += geometryBytes(record.fallbackGeometry);
      }
      if (record.derivativeAsset) {
        residentBytes += record.derivativeAsset.bytes;
        record.derivativeAsset.root.traverse((object) => {
          const mesh = object as Mesh;
          if (!mesh.isMesh) return;
          derivativeMeshes++;
          triangles += (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position')?.count ?? 0) / 3;
        });
      }
    }
    return {
      active: hasPhysicalBody(this.appearance),
      coverage: this.appearance.coverage,
      depthM: this.appearance.depthM,
      compaction: this.appearance.compaction,
      registeredReceivers: this.receivers.size,
      shellMeshes: fallbackMeshes + derivativeMeshes,
      triangles: Math.round(triangles),
      derivativeMeshes,
      fallbackMeshes,
      pendingDerivatives: this.pendingDerivatives,
      derivativeLoads: this.derivativeLoads,
      derivativeFailures: this.derivativeFailures,
      fallbackFailures: this.fallbackFailures,
      residentBytes,
      pendingBytes: this.pendingBytes,
      queuedDerivatives,
      queuedFallbacks,
      rejectedAssets: this.rejectedAssets,
      shaderOnlyReceivers,
      skippedInstancedMeshes,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.receivers.values()) this.clearRecord(record);
    this.receivers.clear();
    this.slots.clear();
    this.derivativeQueue.length = 0;
    this.fallbackQueue.length = 0;
    this.group.removeFromParent();
    this.fallbackMaterial.dispose();
  }
}
