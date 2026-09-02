import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import type { Transform } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, dequantize, meshopt, prune, reorder, tangents, textureCompress, unweld, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { generateTangents } from 'mikktspace';
import sharp from 'sharp';

import { repackGlb } from '../../../tools/glb-ktx2-repack/src/repack.mjs';

import { dilateAlphaEdges } from './alpha-dilate.js';
import { buildClosure, filesUnder, hashTree, readWholeFile, sha256, writeClosure } from './closure.js';
import { neutralizeExportErrorMaterials } from './export-error-materials.js';
import { assertBevyRepresentableSampling, bakeDivergentTextureTransforms } from './uv-transform-bake.js';
import type { ClosureKind, MapClosure } from './closure.js';
import type { ClosureStageResult } from './assemble.js';
import type { StageResult } from './tiling.js';

const BROWSER_OPTIMIZER_REVISION = 5;
const KTX2_REPACK_REVISION = 7;
const NATIVE_CORPUS_DECODER_REVISION = 6;
const GLTF_TRANSFORM_VERSION = '4.4.2';
const SHARP_VERSION = '0.34.5';
const MESHOPTIMIZER_VERSION = '1.2.0';
const MIKKTSPACE_VERSION = '1.1.1';
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
    await writeFile(absolute, await transformGlb(await readWholeFile(absolute)));
  }
  const closure = await buildClosure(contentDir, kind, { toolFingerprint, viewerOnly: source.closure.metadata?.viewerOnly === true });
  const written = await writeClosure(stageRoot, closure);
  const outputDigest = await hashTree(contentDir);
  await writeFile(path.join(stageRoot, 'stage.json'), `${JSON.stringify({ schema: 'simforge.map-pipeline-stage.v1', stage: kind, inputDigest, toolFingerprint, outputDigest, closureDigest: written.digest })}\n`);
  return { inputDigest, toolFingerprint, outputDigest, outputDir: contentDir, cacheKey, closure, closureDigest: written.digest };
}

/**
 * Color-encoded (sRGB) material slots. Every other slot carries channel-packed
 * data (normals, roughness/metalness, occlusion, clearcoat, specular strength,
 * transmission, thickness) that lossy chroma-subsampled encoders visibly
 * corrupt, so those slots only ever get lossless encodings.
 */
const COLOR_SLOTS = /^(baseColorTexture|emissiveTexture|specularColorTexture|sheenColorTexture|diffuseTexture)$/;
const DATA_SLOTS = /^(?!(baseColorTexture|emissiveTexture|specularColorTexture|sheenColorTexture|diffuseTexture)$)/;
const MAX_TEXTURE_DIMENSION = 8192;

function geometryTransforms(): Transform[] {
  return [dedup(), prune(), weld(), reorder({ encoder: MeshoptEncoder }), meshopt({ encoder: MeshoptEncoder, level: 'high' })];
}

function optimizerIo(): NodeIO {
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
}

export function browserToolFingerprint(): string {
  return sha256(`browser-optimize\0${BROWSER_OPTIMIZER_REVISION}\0gltf-transform=${GLTF_TRANSFORM_VERSION}\0sharp=${SHARP_VERSION}\0meshoptimizer=${MESHOPTIMIZER_VERSION}`);
}
export async function browserOptimize(source: ClosureStageResult, workDir: string): Promise<DerivedStageResult> {
  await MeshoptEncoder.ready;
  const io = optimizerIo();
  return deriveClosure(source, workDir, 'browser-optimized', browserToolFingerprint(), async (input) => {
    const document = await io.readBinary(input);
    neutralizeExportErrorMaterials(document);
    await dilateAlphaEdges(document);
    await document.transform(
      ...geometryTransforms(),
      textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 90, resize: [MAX_TEXTURE_DIMENSION, MAX_TEXTURE_DIMENSION], slots: COLOR_SLOTS }),
      textureCompress({ encoder: sharp, targetFormat: 'webp', lossless: true, resize: [MAX_TEXTURE_DIMENSION, MAX_TEXTURE_DIMENSION], slots: DATA_SLOTS }),
    );
    return Buffer.from(await io.writeBinary(document));
  });
}

export function ktx2ToolFingerprint(): string {
  return sha256(`ktx2\0${KTX2_REPACK_REVISION}\0gltf-transform=${GLTF_TRANSFORM_VERSION}\0meshoptimizer=${MESHOPTIMIZER_VERSION}\0ktx-software=${KTX_SOFTWARE_VERSION}\0repack=0.1.0`);
}

/**
 * KTX2 derives from the canonical closure, never from the WebP browser
 * variant: UASTC is itself lossy, and stacking it on a lossy WebP generation
 * bakes two encoders' artifacts into the GPU textures. Geometry gets the same
 * deterministic optimizer pass as the browser variant; images enter toktx as
 * the authored PNG/JPEG bytes.
 */
export async function ktx2Variant(source: ClosureStageResult, workDir: string, ktxBinDir?: string): Promise<DerivedStageResult> {
  await MeshoptEncoder.ready;
  const io = optimizerIo();
  return deriveClosure(source, workDir, 'ktx2', ktx2ToolFingerprint(), async (input) => {
    const document = await io.readBinary(input);
    neutralizeExportErrorMaterials(document);
    await dilateAlphaEdges(document);
    await document.transform(...geometryTransforms());
    const result = await repackGlb(Buffer.from(await io.writeBinary(document)), { ktxBinDir, maxDimension: MAX_TEXTURE_DIMENSION });
    return result.glb;
  });
}

export function nativeCorpusToolFingerprint(): string {
  return sha256(`native-corpus\0${NATIVE_CORPUS_DECODER_REVISION}\0gltf-transform=${GLTF_TRANSFORM_VERSION}\0sharp=${SHARP_VERSION}\0meshoptimizer=${MESHOPTIMIZER_VERSION}\0mikktspace=${MIKKTSPACE_VERSION}`);
}

export async function nativeCorpus(source: DerivedStageResult, workDir: string): Promise<DerivedStageResult> {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  return deriveClosure(source, workDir, 'native-corpus', nativeCorpusToolFingerprint(), async (input) => {
    const document = await io.readBinary(input);
    await document.transform(dequantize());
    // Bevy's StandardMaterial has a single material-level uv_transform; bake
    // per-slot-divergent KHR_texture_transform usage into UV0/UV1 so no
    // material depends on per-slot transforms Bevy cannot represent, then
    // fail loudly if anything unrepresentable remains.
    bakeDivergentTextureTransforms(document);
    assertBevyRepresentableSampling(document);
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
    // Unweld so MikkTSpace can split vertices at tangent discontinuities,
    // author the normative basis, then re-index only truly identical vertices.
    // This avoids renderer-specific generation without retaining triangle soup.
    await document.transform(unweld(), tangents({ generateTangents }), weld());
    // Native corpus keeps standards-compliant KHR_texture_basisu references
    // and KTX2/UASTC images with full mip chains. The renderer's vendored
    // bevy_gltf (renderer/vendor/bevy_gltf) loads this syntax natively; no
    // flattened cache copy exists anymore.
    return Buffer.from(await io.writeBinary(document));
  });
}
