import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, dequantize, meshopt, prune, reorder, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

import { repackGlb } from '../../../tools/glb-ktx2-repack/src/repack.mjs';

import { buildClosure, filesUnder, hashTree, sha256, writeClosure } from './closure.js';
import type { ClosureKind, MapClosure } from './closure.js';
import type { ClosureStageResult } from './assemble.js';
import type { StageResult } from './tiling.js';

const BROWSER_OPTIMIZER_REVISION = 2;
const KTX2_REPACK_REVISION = 2;
const NATIVE_CORPUS_DECODER_REVISION = 4;
const GLTF_TRANSFORM_VERSION = '4.4.2';
const SHARP_VERSION = '0.34.5';
const MESHOPTIMIZER_VERSION = '1.2.0';
const KTX_SOFTWARE_VERSION = '4.4.2';

export interface DerivedStageResult extends StageResult {
  closure: MapClosure;
  closureDigest: string;
}

type GlbTransform = (input: Buffer) => Promise<Buffer>;

async function deriveClosure(
  source: ClosureStageResult | DerivedStageResult,
  workDir: string,
  kind: Exclude<ClosureKind, 'canonical'>,
  toolFingerprint: string,
  transformGlb: GlbTransform,
): Promise<DerivedStageResult> {
  const inputDigest = source.closureDigest;
  const cacheKey = sha256(`${inputDigest}\0${toolFingerprint}`);
  const stageRoot = path.resolve(workDir, kind, cacheKey);
  const contentDir = path.join(stageRoot, 'content');
  const closurePath = path.join(stageRoot, 'closure.json');
  try {
    const closure = JSON.parse(await readFile(closurePath, 'utf8')) as MapClosure;
    return { inputDigest, toolFingerprint, outputDigest: await hashTree(contentDir), outputDir: contentDir, cacheKey, closure, closureDigest: sha256(await readFile(closurePath)) };
  } catch {
    // Rebuild absent or incomplete output.
  }

  await mkdir(contentDir, { recursive: true });
  await cp(source.outputDir, contentDir, { recursive: true });
  for (const relativePath of await filesUnder(contentDir)) {
    if (!relativePath.toLowerCase().endsWith('.glb')) continue;
    const absolute = path.join(contentDir, relativePath);
    await writeFile(absolute, await transformGlb(await readFile(absolute)));
  }
  const closure = await buildClosure(contentDir, kind, { toolFingerprint, viewerOnly: source.closure.metadata?.viewerOnly === true });
  const written = await writeClosure(stageRoot, closure);
  const outputDigest = await hashTree(contentDir);
  await writeFile(path.join(stageRoot, 'stage.json'), `${JSON.stringify({ schema: 'simforge.map-pipeline-stage.v1', stage: kind, inputDigest, toolFingerprint, outputDigest, closureDigest: written.digest })}\n`);
  return { inputDigest, toolFingerprint, outputDigest, outputDir: contentDir, cacheKey, closure, closureDigest: written.digest };
}

export function browserToolFingerprint(): string {
  return sha256(`browser-optimize\0${BROWSER_OPTIMIZER_REVISION}\0gltf-transform=${GLTF_TRANSFORM_VERSION}\0sharp=${SHARP_VERSION}\0meshoptimizer=${MESHOPTIMIZER_VERSION}`);
}
export async function browserOptimize(source: ClosureStageResult, workDir: string): Promise<DerivedStageResult> {
  await MeshoptEncoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  return deriveClosure(source, workDir, 'browser-optimized', browserToolFingerprint(), async (input) => {
    const document = await io.readBinary(input);
    await document.transform(
      dedup(),
      prune(),
      weld(),
      textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 90, resize: [8192, 8192] }),
      reorder({ encoder: MeshoptEncoder }),
      meshopt({ encoder: MeshoptEncoder, level: 'high' }),
    );
    return Buffer.from(await io.writeBinary(document));
  });
}

export function ktx2ToolFingerprint(): string {
  return sha256(`ktx2\0${KTX2_REPACK_REVISION}\0ktx-software=${KTX_SOFTWARE_VERSION}\0repack=0.1.0`);
}

export async function ktx2Variant(source: DerivedStageResult, workDir: string, ktxBinDir?: string): Promise<DerivedStageResult> {
  return deriveClosure(source, workDir, 'ktx2', ktx2ToolFingerprint(), async (input) => {
    const result = await repackGlb(input, { ktxBinDir, keepCoreSource: true });
    return result.glb;
  });
}

export function nativeCorpusToolFingerprint(): string {
  return sha256(`native-corpus\0${NATIVE_CORPUS_DECODER_REVISION}\0gltf-transform=${GLTF_TRANSFORM_VERSION}\0sharp=${SHARP_VERSION}\0meshoptimizer=${MESHOPTIMIZER_VERSION}`);
}

export async function nativeCorpus(source: DerivedStageResult, workDir: string): Promise<DerivedStageResult> {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  return deriveClosure(source, workDir, 'native-corpus', nativeCorpusToolFingerprint(), async (input) => {
    const document = await io.readBinary(input);
    await document.transform(dequantize());
    for (const extension of document.getRoot().listExtensionsUsed()) {
      if (extension.extensionName === 'EXT_meshopt_compression' || extension.extensionName === 'EXT_texture_webp') {
        extension.dispose();
      }
    }
    for (const mesh of document.getRoot().listMeshes()) {
      for (const primitive of mesh.listPrimitives()) {
        const position = primitive.getAttribute('POSITION');
        if (position !== null && position.getCount() > 0) continue;
        mesh.removePrimitive(primitive);
        primitive.dispose();
      }
      if (mesh.listPrimitives().length === 0) mesh.dispose();
    }
    // Native corpus keeps KTX2/UASTC images with full mip chains. Bevy
    // transcodes these on load to the GPU's native BC format instead of
    // expanding WebP/PNG to mipless RGBA8.
    return Buffer.from(await io.writeBinary(document));
  });
}
