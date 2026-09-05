import { cp, link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { buildStaticColliderArtifact, serializeStaticColliderArtifact } from '@simforge-oss/maps/ingest';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

import { buildClosure, canonicalJson, closureDigest, filesUnder, hashFile, hashTree, sha256, writeClosure } from './closure.js';
import type { MapClosure } from './closure.js';
import { buildMaster, masterToolFingerprint } from './master.js';
import type { MasterReport } from './master.js';
import { ROAD_SIDECAR_REVISION, writeRoadSidecars } from './sidecars.js';
import { buildWebTier, webTierToolFingerprint } from './web-tier.js';
import type { WebTierReport } from './web-tier.js';
import type { Ktx2Options } from './ktx2.js';
import { donorLibraryDigest, resolveMapSource, sceneSourceDigest, semanticSourceDigest } from './source.js';
import { withStageLock } from './stage-lock.js';

export { resolveMapSource } from './source.js';
export type { MapSourceManifest, ResolvedMapSource } from './source.js';

export { buildMaster, masterToolFingerprint, MASTER_BUILDER_REVISION } from './master.js';
export type { BuildMasterOptions, MasterBuildResult, MasterReport } from './master.js';
export { buildWebTier, webTierToolFingerprint, WEB_TIER_REVISION } from './web-tier.js';
export type { WebTierOptions, WebTierReport } from './web-tier.js';
export { encodeKtx2, ktx2ToolFingerprint } from './ktx2.js';
export type { Ktx2Options } from './ktx2.js';
export { clampPbrFactors } from './material-ranges.js';
export type { MaterialRangeReport } from './material-ranges.js';
export { borrowTerrainLayerTextures, collectLibraryDonors, terrainDonorLibrary, terrainDonorPoolDigest, terrainLayerBase } from './terrain-layer-textures.js';
export type { TerrainDonor, TerrainDonorPool, TerrainLayerReport } from './terrain-layer-textures.js';
export { DEFAULT_SKY_PATH, resolveXodrPath, writeRoadSidecars, writeSky } from './sidecars.js';
export { canonicalJson, closureBytes, closureDigest, sha256 } from './closure.js';
export type { ClosureKind, ClosureMember, MapClosure } from './closure.js';
export {
  ROADWAY_CONSISTENCY_SCHEMA_VERSION,
  ROADWAY_CONSISTENCY_VALIDATOR_VERSION,
  assertRoadwayConsistencyPreparation,
  buildRoadwayConsistencyReport,
  parseRoadwayConsistencyReport,
  roadwayConsistencyDigest,
  serializeRoadwayConsistencyReport,
  validateRoadwayConsistencyReport,
} from './roadway-consistency.js';
export type {
  BuildRoadwayConsistencyReportInput,
  ExpectedRoadwayConsistencyReport,
  RoadwayConsistencyCoreOptions,
  RoadwayConsistencyCoreReport,
  RoadwayConsistencyInterval,
  RoadwayConsistencyIssue,
  RoadwayConsistencyReport,
  RoadwayConsistencySourceDigests,
  RoadwayConsistencyStats,
  RoadwayConsistencyValidator,
} from './roadway-consistency.js';

export interface RunMapPipelineOptions {
  /** Directory holding exactly one RoadRunner/Unreal GLB (or glTF) export, optionally its .xodr. */
  sourceDir: string;
  xodrPath?: string;
  sourcePath?: string;
  sourceManifest?: string;
  /** Reuse an explicitly selected, source-matching master without decoding/re-encoding its scene. */
  reuseMasterDir?: string;
  name: string;
  workDir: string;
  /** Web tier cell size in metres (default 100). */
  cellSize?: number;
  ktx2?: Ktx2Options;
  /** `master.gltf` files of other maps consulted as terrain-texture donors. */
  donorLibrary?: readonly string[];
  /** Build only the master (no web tier). */
  derived?: boolean;
}

export interface RegistryClosureArtifact {
  kind: MapClosure['kind'];
  fingerprint?: string;
  registryPath: string;
  digest: string;
  closure: MapClosure;
  contentDir: string;
}

/** A cached stage: content directory plus the closure that describes it. */
export interface ClosureStageResult {
  inputDigest: string;
  toolFingerprint: string;
  outputDigest: string;
  /** Content directory (what the closure members enumerate). */
  outputDir: string;
  cacheKey: string;
  closure: MapClosure;
  closureDigest: string;
  viewerOnly: boolean;
}

export interface MasterStageResult extends ClosureStageResult {
  report: MasterReport;
}

export interface WebStageResult extends ClosureStageResult {
  report: WebTierReport;
}

export interface MapPipelineResult {
  name: string;
  canonical: RegistryClosureArtifact;
  derived: RegistryClosureArtifact[];
  stages: {
    master: MasterStageResult;
    web?: WebStageResult;
  };
}

export interface DeriveClosuresOptions {
  name: string;
  workDir: string;
  cellSize?: number;
}

function registryArtifact(stage: ClosureStageResult): RegistryClosureArtifact {
  const fingerprint = stage.closure.toolFingerprint;
  return {
    kind: stage.closure.kind,
    ...(fingerprint ? { fingerprint } : {}),
    registryPath: stage.closure.kind === 'canonical'
      ? 'closure.json'
      : `derived/${stage.closure.kind}-${fingerprint}.json`,
    digest: stage.closureDigest,
    closure: stage.closure,
    contentDir: stage.outputDir,
  };
}

function treeDigest(closure: MapClosure): string {
  return sha256(Object.entries(closure.members).sort(([a], [b]) => a.localeCompare(b)).map(([file, member]) => `${file}\0${member.sha256}`).join('\n'));
}

async function cachedStage(outputDir: string): Promise<{ closure: MapClosure; closureDigest: string; outputDigest: string } | undefined> {
  try {
    const closure = JSON.parse(await readFile(path.join(outputDir, 'closure.json'), 'utf8')) as MapClosure;
    const outputDigest = await hashTree(path.join(outputDir, 'content'));
    if (outputDigest !== treeDigest(closure)) return undefined;
    return { closure, closureDigest: closureDigest(closure), outputDigest };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function finishStage(
  stage: string,
  outputDir: string,
  kind: MapClosure['kind'],
  keys: { inputDigest: string; toolFingerprint: string; cacheKey: string },
  closureOptions: { toolFingerprint?: string; viewerOnly?: boolean; master?: boolean },
): Promise<ClosureStageResult> {
  const contentDir = path.join(outputDir, 'content');
  const closure = await buildClosure(contentDir, kind, closureOptions);
  const written = await writeClosure(outputDir, closure);
  const outputDigest = treeDigest(closure);
  const stagePath = path.join(outputDir, 'stage.json');
  await writeFile(`${stagePath}.tmp`, `${JSON.stringify({ schema: 'simforge.map-pipeline-stage.v1', stage, inputDigest: keys.inputDigest, toolFingerprint: keys.toolFingerprint, outputDigest, closureDigest: written.digest })}\n`);
  await rename(`${stagePath}.tmp`, stagePath);
  return { ...keys, outputDigest, outputDir: contentDir, closure, closureDigest: written.digest, viewerOnly: closure.metadata?.viewerOnly === true };
}

const sceneMember = (file: string): boolean => file === 'master.gltf' || file === 'geometry.bin' || file === 'master-report.json' || file.startsWith('images/');

async function copyMembers(source: string, destination: string, members: readonly string[]): Promise<void> {
  for (const file of members) {
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await linkOrCopy(path.join(source, file), target);
  }
}

async function resetStageContent(outputDir: string): Promise<string> {
  const contentDir = path.join(outputDir, 'content');
  await rm(path.join(outputDir, 'closure.json'), { force: true });
  await rm(contentDir, { recursive: true, force: true });
  await mkdir(contentDir, { recursive: true });
  return contentDir;
}

/**
 * The master stage: the canonical closure. Content is
 * `master.gltf` + `geometry.bin` + `images/<sha>.{png,ktx2}` +
 * `master-report.json` + `env/sky.hdr` + road sidecars (when an XODR exists).
 */
export async function masterStage(options: RunMapPipelineOptions): Promise<MasterStageResult> {
  const source = await resolveMapSource(options);
  const sceneSource = await sceneSourceDigest(source.sourcePath);
  const sceneTool = masterToolFingerprint(options.ktx2);
  let reused: { directory: string; closure: MapClosure; report: MasterReport } | undefined;
  if (options.reuseMasterDir) {
    if (options.ktx2 || options.donorLibrary || source.donorLibrary.length) throw new Error('--reuse-master cannot change encoder settings or donor selection');
    const directory = path.resolve(options.reuseMasterDir);
    const report = JSON.parse(await readFile(path.join(directory, 'master-report.json'), 'utf8')) as MasterReport;
    const original = await hashFile(source.sourcePath);
    if (report.sources.length !== 1 || report.sources[0]!.sha256 !== original.sha256) throw new Error('reused master does not match the selected scene source');
    if (path.extname(source.sourcePath).toLowerCase() === '.gltf') {
      // Hashing only a glTF JSON document does not prove its external buffers
      // and textures. Older masters without a complete source receipt cannot
      // safely seed a scene cache after any referenced file has changed.
      const receipt = JSON.parse(await readFile(path.join(directory, 'source-manifest.json'), 'utf8')) as { sceneSourceDigest?: string };
      if (receipt.sceneSourceDigest !== sceneSource) throw new Error('reused master does not match the complete glTF source resource closure');
    }
    const closure = await buildClosure(directory, 'canonical', { master: true });
    reused = { directory, closure, report };
  }
  const donorKey = reused ? closureDigest({ ...reused.closure, members: Object.fromEntries(Object.entries(reused.closure.members).filter(([file]) => sceneMember(file))) }) : await donorLibraryDigest(source.donorLibrary);
  const sceneKey = sha256(`${sceneSource}\0${sceneTool}\0${donorKey}`);
  const sceneDir = path.resolve(options.workDir, 'scene', sceneKey);
  const scene = await withStageLock(sceneDir, async () => {
    const cached = await cachedStage(sceneDir);
    if (cached) return { ...cached, outputDir: path.join(sceneDir, 'content') };
    const contentDir = await resetStageContent(sceneDir);
    if (reused) {
      await copyMembers(reused.directory, contentDir, Object.keys(reused.closure.members).filter(sceneMember));
    } else {
      await buildMaster({
        sourceDir: source.sourceDir,
        sourcePath: source.sourcePath,
        outputDir: contentDir,
        ...(options.ktx2 ? { ktx2: options.ktx2 } : {}),
        donorLibrary: source.donorLibrary,
      });
    }
    return finishStage('scene', sceneDir, 'canonical', { inputDigest: sceneSource, toolFingerprint: sceneTool, cacheKey: sceneKey }, { master: true });
  });
  const semanticDigest = await semanticSourceDigest(source, options.name);
  const toolFingerprint = sha256(`${sceneTool}\0sidecars=${ROAD_SIDECAR_REVISION}`);
  const inputDigest = sha256(`${scene.closureDigest}\0${semanticDigest}`);
  const cacheKey = sha256(`${inputDigest}\0${toolFingerprint}`);
  const outputDir = path.resolve(options.workDir, 'master', cacheKey);
  const keys = { inputDigest, toolFingerprint, cacheKey };
  return withStageLock(outputDir, async () => {
    const cached = await cachedStage(outputDir);
    if (cached) {
      const report = JSON.parse(await readFile(path.join(outputDir, 'content', 'master-report.json'), 'utf8')) as MasterReport;
      return { ...keys, ...cached, outputDir: path.join(outputDir, 'content'), viewerOnly: !source.xodrPath, report };
    }
    const contentDir = await resetStageContent(outputDir);
    await copyMembers(scene.outputDir, contentDir, Object.keys(scene.closure.members));
    await mkdir(path.join(contentDir, 'env'), { recursive: true });
    await linkOrCopy(source.skyPath, path.join(contentDir, 'env', 'sky.hdr'));
    if (source.xodrPath) await writeRoadSidecars(contentDir, source.xodrPath, options.name, { sourceDir: source.sourceDir, masterPath: path.join(contentDir, 'master.gltf') });
    await writeFile(path.join(contentDir, 'source-manifest.json'), `${canonicalJson({ schema: 'simforge.map-source-receipt.v1', name: options.name, sceneSourceDigest: sceneSource, semanticSourceDigest: semanticDigest, sceneClosureDigest: scene.closureDigest, donorDigest: donorKey, toolFingerprint })}\n`);
    const stage = await finishStage('master', outputDir, 'canonical', keys, { master: true, viewerOnly: !source.xodrPath });
    const report = JSON.parse(await readFile(path.join(contentDir, 'master-report.json'), 'utf8')) as MasterReport;
    return { ...stage, report };
  });
}

/**
 * The web stage: 100 m cells (meshopt + EXT_mesh_gpu_instancing) derived
 * from the master, referencing the master's KTX2 images. The stage content
 * carries those images (hardlinked) so the closure is self-contained.
 */
export async function webStage(master: MasterStageResult, options: DeriveClosuresOptions): Promise<WebStageResult> {
  const cellSize = options.cellSize ?? 100;
  const require = createRequire(import.meta.url);
  const decoderJs = require.resolve('three/examples/jsm/libs/basis/basis_transcoder.js');
  const decoderWasm = require.resolve('three/examples/jsm/libs/basis/basis_transcoder.wasm');
  const decoderDigest = sha256(`${(await hashFile(decoderJs)).sha256}\0${(await hashFile(decoderWasm)).sha256}`);
  const toolFingerprint = sha256(`${webTierToolFingerprint(cellSize)}\0decoder=${decoderDigest}`);
  // XODR, location catalogs, reports and map aliases cannot invalidate identical render cells.
  const members = Object.fromEntries(Object.entries(master.closure.members).filter(([file]) => (sceneMember(file) && file !== 'master-report.json') || file === 'env/sky.hdr'));
  const inputDigest = sha256(canonicalJson(members));
  const cacheKey = sha256(`${inputDigest}\0${toolFingerprint}`);
  const outputDir = path.resolve(options.workDir, 'web', cacheKey);
  const keys = { inputDigest, toolFingerprint, cacheKey };
  const geometry = await withStageLock(outputDir, async () => {
    const cached = await cachedStage(outputDir);
    if (cached) {
      const report = JSON.parse(await readFile(path.join(outputDir, 'content', 'web-tier-report.json'), 'utf8')) as WebTierReport;
      return { ...keys, ...cached, outputDir: path.join(outputDir, 'content'), viewerOnly: master.viewerOnly, report };
    }
    const contentDir = await resetStageContent(outputDir);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const document = await io.read(path.join(master.outputDir, 'master.gltf'));
    const report = await buildWebTier(document, contentDir, { cellSize });
    await mkdir(path.join(contentDir, '3d', 'env'), { recursive: true });
    await linkOrCopy(path.join(master.outputDir, 'env', 'sky.hdr'), path.join(contentDir, '3d', 'env', 'sky.hdr'));
    await copyMembers(master.outputDir, contentDir, Object.keys(master.closure.members).filter((file) => /^images\/[^/]+\.ktx2$/.test(file)));
    await mkdir(path.join(contentDir, '3d', 'runtime'), { recursive: true });
    await cp(decoderJs, path.join(contentDir, '3d', 'runtime', 'basis_transcoder.js'));
    await cp(decoderWasm, path.join(contentDir, '3d', 'runtime', 'basis_transcoder.wasm'));
    const stage = await finishStage('web', outputDir, 'web', keys, { toolFingerprint, viewerOnly: master.viewerOnly });
    return { ...stage, report };
  });
  return webRuntimeStage(master, geometry, options);
}

/** Physics derivatives depend on topology, without invalidating render-cell encoding. */
async function webRuntimeStage(master: MasterStageResult, geometry: WebStageResult, options: DeriveClosuresOptions): Promise<WebStageResult> {
  if (master.viewerOnly) return geometry;
  const topologyMember = master.closure.members['topology-index.json.gz'];
  const masterMember = master.closure.members['master.gltf'];
  if (!topologyMember || !masterMember) throw new Error('Scenario-ready web maps require canonical geometry and topology');
  const toolFingerprint = sha256(`${geometry.toolFingerprint}\0canonical-static-colliders-v1`);
  const inputDigest = sha256(canonicalJson({ mapId: options.name, geometry: geometry.closureDigest, master: masterMember.sha256, topology: topologyMember.sha256 }));
  const cacheKey = sha256(`${inputDigest}\0${toolFingerprint}`);
  const outputDir = path.resolve(options.workDir, 'web-runtime', cacheKey);
  const keys = { inputDigest, toolFingerprint, cacheKey };
  return withStageLock(outputDir, async () => {
    const cached = await cachedStage(outputDir);
    if (cached) return { ...keys, ...cached, outputDir: path.join(outputDir, 'content'), viewerOnly: false, report: geometry.report };
    const [manifestBytes, masterBytes, topologyBytes] = await Promise.all([
      readFile(path.join(geometry.outputDir, '3d', 'manifest.json')),
      readFile(path.join(master.outputDir, 'master.gltf')),
      readFile(path.join(master.outputDir, 'topology-index.json.gz')),
    ]);
    const sourceManifestSha256 = sha256(manifestBytes);
    const artifact = buildStaticColliderArtifact({
      mapId: options.name,
      sourceManifestSha256,
      manifest: JSON.parse(manifestBytes.toString('utf8')),
      topology: JSON.parse(gunzipSync(topologyBytes).toString('utf8')),
      canonicalGltf: { file: 'master.gltf', bytes: masterBytes },
    });
    const colliderBytes = Buffer.from(serializeStaticColliderArtifact(artifact));
    const contentDir = await resetStageContent(outputDir);
    await copyMembers(geometry.outputDir, contentDir, Object.keys(geometry.closure.members));
    const variantsDir = path.join(contentDir, '3d', 'variants');
    await mkdir(variantsDir, { recursive: true });
    await writeFile(path.join(variantsDir, 'static-colliders-v1.json'), colliderBytes);
    await writeFile(path.join(variantsDir, 'manifest.json'), `${canonicalJson({
      schemaVersion: 1,
      sourceManifestSha256,
      variants: { 'static-colliders': {
        id: 'static-colliders', schemaVersion: 1, file: 'static-colliders-v1.json',
        digest: artifact.digest, outputSha256: sha256(colliderBytes), bytes: colliderBytes.length,
        sourceTiles: artifact.statistics.sourceTiles, accepted: artifact.statistics.accepted,
      } },
    })}\n`);
    const stage = await finishStage('web-runtime', outputDir, 'web', keys, { toolFingerprint });
    return { ...stage, report: geometry.report };
  });
}

async function linkOrCopy(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination);
  } catch {
    await cp(source, destination);
  }
}

export async function runMapPipeline(options: RunMapPipelineOptions): Promise<MapPipelineResult> {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(options.name)) {
    throw new Error(`map name must be a lowercase registry slug: ${options.name}`);
  }
  const master = await masterStage(options);
  if (options.derived === false) {
    return { name: options.name, canonical: registryArtifact(master), derived: [], stages: { master } };
  }
  return deriveClosures(master, { name: options.name, workDir: options.workDir, ...(options.cellSize ? { cellSize: options.cellSize } : {}) });
}

/** The web tier for a master stage - whether just built or materialized from a registry. */
export async function deriveClosures(master: MasterStageResult, options: DeriveClosuresOptions): Promise<MapPipelineResult> {
  const web = await webStage(master, options);
  return {
    name: options.name,
    canonical: registryArtifact(master),
    derived: [registryArtifact(web)],
    stages: { master, web },
  };
}

/**
 * Master stage for a closure whose content already sits in `contentDir`
 * (a registry pull). `closureDigest` must be the registry's digest so derived
 * cache keys and published derived closures line up with pipeline-built runs.
 */
export async function masterStageFromDirectory(closure: MapClosure, contentDir: string, closureDigest: string): Promise<MasterStageResult> {
  if (closure.kind !== 'canonical' || closure.metadata?.master !== true) throw new Error(`expected a master closure, got ${closure.kind}`);
  const report = JSON.parse(await readFile(path.join(contentDir, 'master-report.json'), 'utf8')) as MasterReport;
  return { inputDigest: closureDigest, toolFingerprint: closure.toolFingerprint ?? '', outputDigest: closureDigest, outputDir: contentDir, cacheKey: closureDigest, closure, closureDigest, viewerOnly: closure.metadata?.viewerOnly === true, report };
}

/**
 * Materialize a pipeline result as content-addressed blobs plus registry closure
 * descriptors. Registry publishers can upload this directory without opening or
 * rewriting any content bytes.
 */
export async function materializeRegistryPayload(result: MapPipelineResult, outputDir: string): Promise<void> {
  const artifacts = [result.canonical, ...result.derived];
  await mkdir(outputDir, { recursive: true });
  for (const artifact of artifacts) {
    for (const relativePath of await filesUnder(artifact.contentDir)) {
      const member = artifact.closure.members[relativePath];
      if (!member) throw new Error(`${artifact.kind} closure omits ${relativePath}`);
      const destination = path.join(outputDir, 'blobs', 'sha256', member.sha256.slice(0, 2), member.sha256);
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await stat(destination);
        continue;
      } catch {
        // Blob absent; materialize it below.
      }
      // Blobs are immutable and content-addressed: hardlink when the work
      // directory shares a filesystem, copy otherwise.
      try {
        await link(path.join(artifact.contentDir, relativePath), destination);
      } catch {
        await cp(path.join(artifact.contentDir, relativePath), destination);
      }
    }
    const descriptor = path.join(outputDir, artifact.registryPath);
    await mkdir(path.dirname(descriptor), { recursive: true });
    await writeFile(descriptor, canonicalJson(artifact.closure));
  }
}
