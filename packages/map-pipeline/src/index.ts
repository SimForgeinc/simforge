import { cp, link, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assembleClosure } from './assemble.js';
import type { ClosureStageResult } from './assemble.js';
import { canonicalJson, filesUnder } from './closure.js';
import type { MapClosure } from './closure.js';
import { browserOptimize, ktx2Variant, nativeCorpus } from './derived.js';
import type { DerivedStageResult } from './derived.js';
import { sourceToTiles } from './tiling.js';
import type { FbxToTilesOptions, GridCell, GridDefinition, StageResult } from './tiling.js';

export { assembleClosure } from './assemble.js';
export { clampPbrFactors } from './material-ranges.js';
export type { MaterialRangeReport } from './material-ranges.js';
export { borrowTerrainLayerTextures, collectTerrainLayerDonors, terrainDonorLibraryDirs, terrainDonorPoolDigest, terrainLayerBase } from './terrain-layer-textures.js';
export type { TerrainDonor, TerrainDonorPool, TerrainLayerReport } from './terrain-layer-textures.js';
export { writeRoadSidecars } from './assemble.js';
export type { AssembleClosureOptions, ClosureStageResult } from './assemble.js';
export { canonicalJson, closureBytes, closureDigest, sha256 } from './closure.js';
export type { ClosureKind, ClosureMember, MapClosure } from './closure.js';
export {
  buildMaterialBindingPlan,
  classifyTextureRole,
  matchMaterialName,
  normalizeFbxMaterialName,
  renderBinding,
  ueAssetLeaf,
} from './material-binding.js';
export type { MaterialBinding, MaterialBindingPlan, SourceMaterialContract, TextureBinding, TextureRole } from './material-binding.js';
export {
  browserOptimize,
  browserToolFingerprint,
  ktx2ToolFingerprint,
  ktx2Variant,
  nativeCorpus,
  nativeCorpusToolFingerprint,
} from './derived.js';
export type { DerivedStageResult } from './derived.js';
export { FBX_TILER_REVISION, assignGridCell, fbxToTiles, sourceToTiles } from './tiling.js';
export type { FbxToTilesOptions, GridCell, GridDefinition, StageResult } from './tiling.js';
export { GLTF_TILER_REVISION, gltfToTiles } from './gltf-tiling.js';
export type { GltfTilingReport, GltfToTilesOptions } from './gltf-tiling.js';
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
  sourceDir: string;
  xodrPath?: string;
  name: string;
  workDir: string;
  blender?: string;
  cellSize?: number;
  ktxBinDir?: string;
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

export interface MapPipelineResult {
  name: string;
  canonical: RegistryClosureArtifact;
  derived: RegistryClosureArtifact[];
  stages: {
    /** Absent when the canonical closure came from a registry, not a tiler. */
    tiles?: StageResult;
    canonical: ClosureStageResult;
    browser?: DerivedStageResult;
    ktx2?: DerivedStageResult;
    nativeCorpus?: DerivedStageResult;
  };
}

export interface DeriveClosuresOptions {
  name: string;
  workDir: string;
  ktxBinDir?: string;
}

function registryArtifact(stage: ClosureStageResult | DerivedStageResult): RegistryClosureArtifact {
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

export async function runMapPipeline(options: RunMapPipelineOptions): Promise<MapPipelineResult> {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(options.name)) {
    throw new Error(`map name must be a lowercase registry slug: ${options.name}`);
  }
  const tiles = await sourceToTiles({
    sourceDir: options.sourceDir,
    workDir: options.workDir,
    ...(options.blender ? { blender: options.blender } : {}),
    ...(options.cellSize ? { cellSize: options.cellSize } : {}),
  });
  const canonical = await assembleClosure({
    tiles,
    mapName: options.name,
    sourceDir: options.sourceDir,
    ...(options.xodrPath ? { xodrPath: options.xodrPath } : {}),
    workDir: options.workDir,
  });
  if (options.derived === false) {
    return { name: options.name, canonical: registryArtifact(canonical), derived: [], stages: { tiles, canonical } };
  }
  const result = await deriveClosures(canonical, { name: options.name, workDir: options.workDir, ...(options.ktxBinDir ? { ktxBinDir: options.ktxBinDir } : {}) });
  result.stages.tiles = tiles;
  return result;
}

/**
 * Presentation derivatives (browser, KTX2, native corpus) for a canonical
 * closure stage - whether it was just tiled or materialized from a registry.
 */
export async function deriveClosures(canonical: ClosureStageResult, options: DeriveClosuresOptions): Promise<MapPipelineResult> {
  const browser = await browserOptimize(canonical, options.workDir);
  const ktx2 = await ktx2Variant(canonical, options.workDir, options.ktxBinDir);
  const corpus = await nativeCorpus(ktx2, options.workDir);
  return {
    name: options.name,
    canonical: registryArtifact(canonical),
    derived: [registryArtifact(browser), registryArtifact(ktx2), registryArtifact(corpus)],
    stages: { canonical, browser, ktx2, nativeCorpus: corpus },
  };
}

/**
 * Canonical stage for a closure whose content already sits in `contentDir`
 * (a registry pull). `closureDigest` must be the registry's digest so derived
 * cache keys and published derived closures line up with tiler-built runs.
 */
export function canonicalStageFromDirectory(closure: MapClosure, contentDir: string, closureDigest: string): ClosureStageResult {
  if (closure.kind !== 'canonical') throw new Error(`expected a canonical closure, got ${closure.kind}`);
  return { inputDigest: closureDigest, toolFingerprint: closure.toolFingerprint ?? '', outputDigest: closureDigest, outputDir: contentDir, cacheKey: closureDigest, closure, closureDigest, viewerOnly: closure.metadata?.viewerOnly === true };
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
