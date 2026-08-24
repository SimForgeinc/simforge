/**
 * `uniscenarios corpus` — the sensor-corpus pipeline (native renderer, WSB1).
 *
 * `corpus build --map <id>` decodes the dev-assets 3D tile set into a
 * deterministic, checksummed "sensor corpus" that the native (Bevy) engine
 * loads directly:
 *
 * - EXT_meshopt_compression is decoded at read time and KHR_mesh_quantization
 *   accessors are dequantized to float32 (both rejected by Bevy's GLB loader;
 *   proven in scripts/renderer-spike, FINDINGS.md §1).
 * - `image/webp` textures are re-encoded as PNG (Bevy has no WebP decoder).
 *   Everything else — geometry topology, alpha-cutout materials (`alphaMode:
 *   MASK`, `alphaCutoff`), scene/node structure — is preserved untouched; no
 *   joining/instancing/welding passes run, because gltf-transform's instancing
 *   pass merges meshes into EXT_mesh_gpu_instancing, which Bevy chokes on.
 * - Vegetation sidecar instance matrices (`veg_*.instances.json`) are copied
 *   verbatim into the corpus and checksummed.
 *
 * The manifest carries per-file sha256 of both the decoded output and its
 * source, plus tool versions. It contains NO timestamps or other volatile
 * fields: building the same map twice from clean state must produce a
 * byte-identical manifest.
 *
 * `corpus prewarm --map <id> --route <poses.json>` computes the tile subset a
 * camera route touches (grid intersection over the tile manifest), so renderers
 * load only what a route can see.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import type { Document } from '@gltf-transform/core';
import { dequantize } from '@gltf-transform/functions';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

import { CliError, EXIT } from '../errors.js';
import { DEV_ASSETS, REPO_ROOT } from '@simforge/compiler/node';
import { emit } from '../output.js';

export const CORPUS_SCHEMA = 'sensor-corpus.v1';

/** Corpus root override (`SCEN_SENSOR_CORPUS`), default `<repo>/.corpus`. */
export function corpusRoot(outRoot?: string): string {
  if (outRoot !== undefined) return path.resolve(outRoot);
  const envRoot = process.env['SCEN_SENSOR_CORPUS'];
  if (envRoot !== undefined && envRoot.length > 0) return path.resolve(envRoot);
  return path.join(REPO_ROOT, '.corpus');
}

/** Tiles root for one map: `<dev-assets>/<mapId>/browser/3d`. */
export function mapSceneDir(mapId: string, sourceRoot?: string): string {
  if (sourceRoot !== undefined) return path.resolve(sourceRoot);
  return path.join(DEV_ASSETS, mapId, 'browser', '3d');
}

// ---------------------------------------------------------------------------
// Tool versions (recorded in the manifest so cache reuse can detect drift)
// ---------------------------------------------------------------------------

const require_ = createRequire(import.meta.url);

function pkgVersion(name: string): string {
  try {
    const pkg = require_(`${name}/package.json`) as unknown;
    if (isPackageJson(pkg, name)) return pkg.version;
  } catch {
    // `exports` maps may hide package.json — fall through and walk up from the entry.
  }
  let dir = path.dirname(require_.resolve(name));
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
      if (isPackageJson(pkg, name)) return pkg.version;
    }
    dir = path.dirname(dir);
  }
  throw new CliError('internal_error', `cannot determine version of ${name}`);
}

/** Narrow parsed JSON to a package.json shape for exactly this package. */
function isPackageJson(value: unknown, name: string): value is { version: string } {
  if (value === null || typeof value !== 'object') return false;
  if ('name' in value && (value as Record<string, unknown>)['name'] !== name) return false;
  return 'version' in value && typeof (value as Record<string, unknown>)['version'] === 'string';
}

interface CorpusTools {
  node: string;
  gltfTransform: string;
  meshoptimizer: string;
  sharp: string;
}

export function corpusTools(): CorpusTools {
  return {
    node: process.version,
    gltfTransform: pkgVersion('@gltf-transform/core'),
    meshoptimizer: pkgVersion('meshoptimizer'),
    sharp: pkgVersion('sharp'),
  };
}

// ---------------------------------------------------------------------------
// Scene-manifest types (loose — the producer is the city asset pipeline)
// ---------------------------------------------------------------------------

interface Bounds {
  min: number[];
  max: number[];
}
interface LodEntry {
  file: string;
}
interface TileEntry {
  id: string;
  gridX?: number;
  file?: string;
  bounds?: Bounds;
  lods?: LodEntry[];
  instanceFile?: string;
}
interface SceneManifest {
  version?: string;
  scene?: {
    origin?: number[];
    cellSize?: number[];
    gridDimensions?: number[];
  };
  tiles?: TileEntry[];
  vegetationTiles?: TileEntry[];
  staticLayers?: TileEntry[];
}

export function loadSceneManifest(sceneDir: string): SceneManifest {
  const p = path.join(sceneDir, 'manifest.json');
  if (!existsSync(p)) {
    throw new CliError('not_found', `no 3D scene manifest at ${p}`, { path: p });
  }
  return JSON.parse(readFileSync(p, 'utf8')) as SceneManifest;
}

// ---------------------------------------------------------------------------
// Route prewarm (pure, unit-tested without any built corpus)
// ---------------------------------------------------------------------------

interface RoutePose {
  x: number;
  y: number;
  z: number;
}

/** Accept `[x,y,z]`, `{x,y,z}`, `{pose:{x,y,z}}` shapes; anything else is a bad value. */
export function parsePoses(raw: unknown, label = '--route'): RoutePose[] {
  let list: unknown = raw;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    // Route files are outside-controlled JSON; shape is validated below before use.
    const obj = raw as Record<string, unknown>;
    list = obj['poses'] ?? obj['route'];
  }
  if (!Array.isArray(list)) {
    throw new CliError('bad_value', `${label} must be an array of poses or {poses:[...]}`, { path: label });
  }
  return list.flatMap((entry, i): RoutePose[] => parsePose(entry, label, i));
}

function parseVecN(value: unknown[], finiteAt: (v: unknown) => number): RoutePose {
  return { x: finiteAt(value[0]), y: finiteAt(value[1] ?? 0), z: finiteAt(value[2] ?? 0) };
}

/** One route entry → one or two poses (a camera {eye,target} contributes both). */
function parsePose(entry: unknown, label: string, index: number): RoutePose[] {
  const finiteAt = (value: unknown): number => {
    const v = Number(value);
    if (!Number.isFinite(v)) {
      throw new CliError('bad_value', `${label}[${index}] contains a non-finite coordinate`, { path: label });
    }
    return v;
  };
  if (Array.isArray(entry) && entry.length >= 2 && entry.length <= 3) {
    return [parseVecN(entry, finiteAt)];
  }
  if (entry !== null && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    // Camera-route convention: {eye:[x,y,z], target:[x,y,z]}. The look-at
    // point matters for tile selection too — the frustum reaches it.
    if ('eye' in obj && Array.isArray(obj['eye'])) {
      const poses = [parseVecN(obj['eye'], finiteAt)];
      if ('target' in obj && Array.isArray(obj['target'])) {
        poses.push(parseVecN(obj['target'], finiteAt));
      }
      return poses;
    }
    let inner = obj;
    if ('pose' in obj && obj['pose'] !== null && typeof obj['pose'] === 'object') {
      inner = obj['pose'] as Record<string, unknown>;
    }
    if ('x' in inner && 'z' in inner) {
      return [{ x: finiteAt(inner['x']), y: finiteAt(inner['y'] ?? 0), z: finiteAt(inner['z']) }];
    }
  }
  throw new CliError('bad_value', `${label}[${index}] is not a [x,y,z] or {x,y,z} pose`, { path: label });
}

interface PrewarmResult {
  schema: 'sensor-corpus.prewarm.v1';
  mapId: string;
  /** Grid cells (gridX, gridZ) whose tiles the route can touch. */
  cells: Array<[number, number]>;
  /** Static tile ids (`tile_X_Z`); road always included via files. */
  staticTiles: string[];
  /** Vegetation tile ids (`veg_X_Z`) for the same cells. */
  vegTiles: string[];
  /** Corpus-relative files (same layout under dev-assets …/3d and the corpus root). */
  files: string[];
}

/**
 * Tile-grid intersection for one camera route.
 *
 * A pose at (x, z) with reach r selects every cell whose footprint intersects
 * the square [x−r, x+r] × [z−r, z+r]. Y is ignored: the grid is a 2D footprint.
 */
export function selectRouteTiles(
  sceneManifest: SceneManifest,
  mapId: string,
  poses: readonly RoutePose[],
  radiusMeters = 0,
): PrewarmResult {
  const scene = sceneManifest.scene;
  const origin = scene?.origin;
  const cellSize = scene?.cellSize;
  const dims = scene?.gridDimensions;
  if (
    origin === undefined ||
    cellSize === undefined ||
    dims === undefined ||
    origin.length < 3 ||
    cellSize.length < 2 ||
    dims.length < 2
  ) {
    throw new CliError('bad_value', `scene manifest for ${mapId} lacks grid origin/cellSize/gridDimensions`, {
      path: 'manifest.json',
    });
  }
  if (!(radiusMeters >= 0) || !Number.isFinite(radiusMeters)) {
    throw new CliError('bad_value', '--radius must be a non-negative number', { path: '--radius' });
  }
  if (poses.length === 0) {
    throw new CliError('validation_findings', 'route has no poses', {
      exitCode: EXIT.validationFindings,
    });
  }

  // Cell ids that exist as tiles / vegetation in this map.
  const staticIds = new Set((sceneManifest.tiles ?? []).map((t) => t.id));
  const vegIds = new Set((sceneManifest.vegetationTiles ?? []).map((t) => t.id));

  const cells = new Map<string, [number, number]>();
  for (const pose of poses) {
    const minX = clampCell(Math.floor((pose.x - radiusMeters - origin[0]!) / cellSize[0]!), 0, dims[0]! - 1);
    const maxX = clampCell(Math.floor((pose.x + radiusMeters - origin[0]!) / cellSize[0]!), 0, dims[0]! - 1);
    const minZ = clampCell(Math.floor((pose.z - radiusMeters - origin[2]!) / cellSize[1]!), 0, dims[1]! - 1);
    const maxZ = clampCell(Math.floor((pose.z + radiusMeters - origin[2]!) / cellSize[1]!), 0, dims[1]! - 1);
    for (let gx = minX; gx <= maxX; gx += 1) {
      for (let gz = minZ; gz <= maxZ; gz += 1) {
        cells.set(`${gx}_${gz}`, [gx, gz]);
      }
    }
  }

  const sorted = [...cells.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const staticTiles: string[] = [];
  const vegTiles: string[] = [];
  const files = new Set<string>();
  for (const layer of sceneManifest.staticLayers ?? []) {
    if (layer.file !== undefined) files.add(layer.file);
  }
  for (const [gx, gz] of sorted) {
    const tileId = `tile_${gx}_${gz}`;
    const vegId = `veg_${gx}_${gz}`;
    if (staticIds.has(tileId)) {
      staticTiles.push(tileId);
      addTileFiles(sceneManifest.tiles, tileId, files);
    }
    if (vegIds.has(vegId)) {
      vegTiles.push(vegId);
      addTileFiles(sceneManifest.vegetationTiles, vegId, files);
    }
  }
  files.add('tiles/road.glb'); // static layer spans the whole map
  return {
    schema: 'sensor-corpus.prewarm.v1',
    mapId,
    cells: sorted,
    staticTiles,
    vegTiles,
    files: [...files].sort(),
  };
}

function clampCell(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function addTileFiles(tiles: TileEntry[] | undefined, id: string, out: Set<string>): void {
  for (const tile of tiles ?? []) {
    if (tile.id !== id) continue;
    for (const lod of tile.lods ?? []) out.add(lod.file);
    if (tile.instanceFile !== undefined) out.add(tile.instanceFile);
  }
}

export interface PrewarmOptions {
  mapId: string;
  routePath: string;
  radius: number;
  /** Optional built-corpus manifest to join sha256s onto the file list. */
  manifestPath?: string;
  pretty: boolean;
}

interface CorpusManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

export async function corpusPrewarm(options: PrewarmOptions): Promise<number> {
  const selection = selectRouteTiles(
    loadSceneManifest(mapSceneDir(options.mapId)),
    options.mapId,
    parsePoses(JSON.parse(readFileSync(options.routePath, 'utf8'))),
    options.radius,
  );

  // Join checksums when the corpus for this map is already built.
  const manifestPath = options.manifestPath ?? path.join(corpusRoot(), options.mapId, 'manifest.json');
  const byPath = new Map<string, CorpusManifestFile>();
  if (existsSync(manifestPath)) {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && 'files' in parsed) {
      for (const file of (parsed as { files: unknown }).files as unknown[]) {
        if (isCorpusManifestFile(file)) byPath.set(file.path, file);
      }
    }
  }
  const payload = {
    ...selection,
    corpusAvailable: byPath.size > 0,
    manifestPath,
    files: selection.files.map((p) => byPath.get(p) ?? { path: p }),
  };
  emit(payload, { pretty: options.pretty });
  return EXIT.ok;
}

function isCorpusManifestFile(value: unknown): value is CorpusManifestFile {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['path'] === 'string' &&
    typeof (value as Record<string, unknown>)['sha256'] === 'string' &&
    typeof (value as Record<string, unknown>)['bytes'] === 'number'
  );
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

interface CorpusFileEntry {
  path: string;
  bytes: number;
  sha256: string;
  srcPath: string;
  srcSha256: string;
  kind: 'glb' | 'sidecar' | 'scene';
  texturesConverted?: number;
}

interface CorpusManifest {
  schema: typeof CORPUS_SCHEMA;
  mapId: string;
  sourceRoot: string;
  tools: CorpusTools;
  counts: CorpusCounts;
  totalBytes: number;
  files: CorpusFileEntry[];
}

interface CorpusCounts {
  glbFiles: number;
  staticGlbs: number;
  vegGlbs: number;
  vegSidecars: number;
  sceneManifests: number;
}

export interface CorpusBuildOptions {
  mapId: string;
  outRoot?: string;
  sourceRoot?: string;
  /** Re-decode even when the cached output matches the current source+tools. */
  force?: boolean;
  quiet?: boolean;
}

export interface CorpusBuildResult {
  mapId: string;
  corpusDir: string;
  files: number;
  staticGlbs: number;
  vegGlbs: number;
  vegSidecars: number;
  totalBytes: number;
  sourceBytes: number;
  texturesConverted: number;
  reusedFiles: number;
  durationMs: number;
  tools: CorpusTools;
}

const TILE_GLB = /^tile_\d+_\d+(?:\.lod\d)?\.glb$/;
const ROAD_GLB = /^road\.glb$/;
const VEG_GLB = /^veg_\d+_\d+(?:\.lod\d)?\.glb$/;
const VEG_SIDECAR = /^veg_\d+_\d+\.instances\.json$/;

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
/** Decode meshopt + dequantize + WebP→PNG for one GLB. Returns #converted textures. */
async function decodeGlb(input: Buffer, io: NodeIO): Promise<{ doc: Document; converted: number }> {
  const doc = await io.readBinary(input);
  await doc.transform(dequantize());
  // Buffers are decoded; drop the compression extension so the writer emits
  // plain buffer views instead of re-compressing (Bevy loads neither variant
  // of EXT_meshopt_compression output here).
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'EXT_meshopt_compression') ext.dispose();
  }

  let converted = 0;
  for (const texture of doc.getRoot().listTextures()) {
    if (texture.getMimeType() !== 'image/webp') continue;
    const image = texture.getImage();
    if (image === null) continue;
    const png = await sharp(image).png({ compressionLevel: 9 }).toBuffer();
    texture.setImage(png);
    texture.setMimeType('image/png');
    converted += 1;
  }
  return { doc, converted };
}

/**
 * Build the sensor corpus for one map. Idempotent: with an existing manifest
 * whose recorded source sha256s and tool versions match, unchanged files are
 * reused byte-for-byte instead of re-encoded (`--force` overrides). The write
 * order and manifest field order are fixed, and no timestamps are emitted, so
 * two clean builds produce identical manifests.
 */
export async function corpusBuild(options: CorpusBuildOptions): Promise<CorpusBuildResult> {
  const started = Date.now();
  const sceneDir = mapSceneDir(options.mapId, options.sourceRoot);
  const tilesDir = path.join(sceneDir, 'tiles');
  if (!existsSync(tilesDir)) {
    throw new CliError('not_found', `no tiles directory for map "${options.mapId}" at ${tilesDir}`, {
      path: tilesDir,
    });
  }
  const sceneManifest = loadSceneManifest(sceneDir);

  const outDir = path.join(corpusRoot(options.outRoot), options.mapId);
  await mkdir(path.join(outDir, 'tiles'), { recursive: true });

  // Enumerate sources deterministically; shadow lightmap PNGs stay behind — they
  // are baked three.js presentation data, not part of the native sensor surface.
  const names = readdirSync(tilesDir)
    .sort()
    .filter((name) => TILE_GLB.test(name) || ROAD_GLB.test(name) || VEG_GLB.test(name) || VEG_SIDECAR.test(name));
  if (!names.includes('road.glb')) {
    throw new CliError('not_found', `map "${options.mapId}" has no tiles/road.glb static layer`, {
      path: path.join(tilesDir, 'road.glb'),
    });
  }

  // Cache: previous manifest entries keyed by corpus path; valid only when the
  // toolchain fingerprint matches, so upgraded decoders re-encode everything.
  const tools = corpusTools();
  const manifestPath = path.join(outDir, 'manifest.json');
  const previous = new Map<string, CorpusFileEntry>();
  if (!options.force && existsSync(manifestPath)) {
    const old: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (isCorpusManifest(old) && sameTools(old.tools, tools)) {
      for (const entry of old.files) previous.set(entry.path, entry);
    }
  }

  // MeshoptDecoder's WASM instance is created lazily; decoding before `ready`
  // resolves fails with an unbound instance.
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    // Decoder only: with an encoder registered the writer re-compresses buffer
    // views to EXT_meshopt_compression, which Bevy cannot load.
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
    });

  const files: CorpusFileEntry[] = [];
  let texturesConverted = 0;
  let reusedFiles = 0;
  let sourceBytes = 0;

  for (let i = 0; i < names.length; i += 1) {
    const name = names[i]!;
    const srcPath = path.join(tilesDir, name);
    const srcBytes = readFileSync(srcPath);
    const srcSha = sha256(srcBytes);
    sourceBytes += srcBytes.byteLength;
    const relPath = `tiles/${name}`;
    const cached = previous.get(relPath);

    if (cached !== undefined && cached.srcSha256 === srcSha && existsSync(path.join(outDir, relPath))) {
      files.push({ ...cached });
      reusedFiles += 1;
      texturesConverted += cached.texturesConverted ?? 0;
      continue;
    }

    if (!options.quiet && i % 50 === 0) {
      process.stderr.write(`[corpus] ${options.mapId}: ${i}/${names.length}\n`);
    }

    let entry: CorpusFileEntry;
    if (VEG_SIDECAR.test(name)) {
      // Vegetation instance matrices are authoritative authored data: copy verbatim.
      await copyFile(srcPath, path.join(outDir, relPath));
      entry = {
        path: relPath,
        bytes: srcBytes.byteLength,
        sha256: srcSha,
        srcPath: relativeSource(srcPath),
        srcSha256: srcSha,
        kind: 'sidecar',
      };
    } else {
      const { doc, converted } = await decodeGlb(srcBytes, io);
      texturesConverted += converted;
      const outFile = path.join(outDir, relPath);
      const glb = await io.writeBinary(doc);
      await writeFile(outFile, glb);
      entry = {
        path: relPath,
        bytes: glb.byteLength,
        sha256: sha256(glb),
        srcPath: relativeSource(srcPath),
        srcSha256: srcSha,
        kind: 'glb',
        ...(converted > 0 ? { texturesConverted: converted } : {}),
      };
    }
    files.push(entry);
  }

  // The 3D scene manifest travels with the corpus: tile bounds, LOD ladders,
  // grid geometry — everything route-prewarm and the renderer need.
  const sceneSrc = path.join(sceneDir, 'manifest.json');
  const sceneBytes = readFileSync(sceneSrc);
  const sceneRel = 'scene-manifest.json';
  const sceneCached = previous.get(sceneRel);
  const sceneReuse = sceneCached !== undefined && sceneCached.srcSha256 === sha256(sceneBytes);
  const sceneEntry: CorpusFileEntry =
    sceneReuse && sceneCached !== undefined
      ? { ...sceneCached }
      : {
          path: sceneRel,
          bytes: sceneBytes.byteLength,
          sha256: sha256(sceneBytes),
          srcPath: relativeSource(sceneSrc),
          srcSha256: sha256(sceneBytes),
          kind: 'scene',
        };
  if (!sceneReuse) await writeFile(path.join(outDir, sceneRel), sceneBytes);
  files.push(sceneEntry);
  sourceBytes += sceneBytes.byteLength;

  files.sort((a, b) => comparePaths(a.path, b.path));

  const counts: CorpusCounts = {
    glbFiles: names.filter((n) => n.endsWith('.glb')).length,
    staticGlbs: names.filter((n) => TILE_GLB.test(n) || ROAD_GLB.test(n)).length,
    vegGlbs: names.filter((n) => VEG_GLB.test(n)).length,
    vegSidecars: names.filter((n) => VEG_SIDECAR.test(n)).length,
    sceneManifests: 1,
  };
  const manifest: CorpusManifest = {
    schema: CORPUS_SCHEMA,
    mapId: options.mapId,
    sourceRoot: relativeSource(sceneDir),
    tools,
    counts,
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
    files,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    mapId: options.mapId,
    corpusDir: outDir,
    files: files.length,
    staticGlbs: counts.staticGlbs,
    vegGlbs: counts.vegGlbs,
    vegSidecars: counts.vegSidecars,
    totalBytes: manifest.totalBytes,
    sourceBytes,
    texturesConverted,
    reusedFiles,
    durationMs: Date.now() - started,
    tools,
  };
}

function isCorpusManifest(value: unknown): value is CorpusManifest {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)['schema'] === CORPUS_SCHEMA &&
    Array.isArray((value as Record<string, unknown>)['files']) &&
    typeof (value as Record<string, unknown>)['tools'] === 'object'
  );
}

function sameTools(a: CorpusTools, b: CorpusTools): boolean {
  return (
    a.node === b.node &&
    a.gltfTransform === b.gltfTransform &&
    a.meshoptimizer === b.meshoptimizer &&
    a.sharp === b.sharp
  );
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function relativeSource(p: string): string {
  return path.relative(REPO_ROOT, p);
}

/** Build several maps sequentially (CPU-bound, no GPU involved). */
export async function corpusBuildAll(
  maps: readonly string[],
  options: Omit<CorpusBuildOptions, 'mapId'>,
): Promise<CorpusBuildResult[]> {
  const results: CorpusBuildResult[] = [];
  for (const mapId of maps) {
    results.push(await corpusBuild({ ...options, mapId }));
  }
  return results;
}

/** CLI entry: emit the result payload. */
export async function corpusBuildCommand(
  options: Omit<CorpusBuildOptions, 'mapId'> & { maps: readonly string[]; pretty: boolean },
): Promise<number> {
  const payload =
    options.maps.length === 1
      ? await corpusBuild({ ...options, mapId: options.maps[0]! })
      : { builds: await corpusBuildAll(options.maps, options) };
  emit(payload, { pretty: options.pretty });
  return EXIT.ok;
}
