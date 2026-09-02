/**
 * Image-only PNG/JPEG/WebP -> KTX2 repacker core.
 *
 * Contract (docs/product/runtime-surface-materials.md, asset-gap-analysis §4/§6):
 * decode each embedded raster image, encode KTX2 via the pinned KTX-Software
 * toktx, rewrite ONLY texture/image references, and rebuild the BIN chunk so
 * that every non-image byte range (plain geometry bufferViews AND
 * EXT_meshopt_compression streams) is byte-identical to the source. Accessors,
 * meshes, and geometry bufferView definitions are never edited; the only JSON
 * mutation on geometry is the byteOffset shift caused by resized image
 * payloads, which `verifyGeometryIdentity` proves is content-preserving.
 *
 * Feed it the authored PNG/JPEG bytes (canonical closure), not a lossy WebP
 * derivative: UASTC is lossy on its own and should be the only lossy step.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseGlb, writeGlb } from './glb.mjs';

const TEXTURE_SOURCE_EXTENSIONS = [
  'KHR_texture_basisu',
  'EXT_texture_webp',
  'EXT_texture_avif',
];
const ENCODABLE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
/**
 * Extension texture slots that carry sRGB-encoded color. Every other
 * extension slot (specularTexture, clearcoat*, transmission, thickness,
 * anisotropy, iridescence, sheenRoughness) is linear data.
 */
const COLOR_EXTENSION_SLOTS = new Set(['specularColorTexture', 'sheenColorTexture', 'diffuseTexture']);

const execFileAsync = promisify(execFile);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const align4 = (n) => (n + 3) & ~3;

/** Resolve the image index a texture actually samples from. */
function textureImageIndex(texture) {
  for (const ext of TEXTURE_SOURCE_EXTENSIONS) {
    const source = texture?.extensions?.[ext]?.source;
    if (Number.isInteger(source)) return source;
  }
  return Number.isInteger(texture?.source) ? texture.source : null;
}

/**
 * Classify every image by material slot usage.
 *
 * - `color`  (sRGB): baseColorTexture, emissiveTexture, and the color-valued
 *   extension slots (KHR_materials_specular.specularColorTexture,
 *   KHR_materials_sheen.sheenColorTexture, pbrSpecularGlossiness.diffuseTexture).
 * - `normal` (linear): normalTexture and clearcoatNormalTexture.
 * - `data`   (linear): occlusionTexture, metallicRoughnessTexture, and every
 *   other extension slot — channel-packed non-color data.
 *
 * An image cannot safely serve both color and non-color slots because KTX2
 * stores one transfer function per image. Such input is rejected so the
 * exporter can duplicate the image with the correct semantics.
 */
export function classifyImages(json) {
  const roles = new Map(); // image index -> Set<'color'|'normal'|'data'>
  const mark = (textureInfo, role) => {
    if (!textureInfo || !Number.isInteger(textureInfo.index)) return;
    const image = textureImageIndex(json.textures?.[textureInfo.index]);
    if (image === null) return;
    if (!roles.has(image)) roles.set(image, new Set());
    roles.get(image).add(role);
  };
  for (const material of json.materials ?? []) {
    const pbr = material.pbrMetallicRoughness ?? {};
    mark(pbr.baseColorTexture, 'color');
    mark(material.emissiveTexture, 'color');
    mark(pbr.metallicRoughnessTexture, 'data');
    mark(material.occlusionTexture, 'data');
    mark(material.normalTexture, 'normal');
    for (const ext of Object.values(material.extensions ?? {})) {
      for (const [key, value] of Object.entries(ext)) {
        if (!value || !Number.isInteger(value.index)) continue;
        if (/normalTexture$/i.test(key)) mark(value, 'normal');
        else if (COLOR_EXTENSION_SLOTS.has(key)) mark(value, 'color');
        else if (/Texture$/i.test(key)) mark(value, 'data');
      }
    }
  }
  const classes = new Map();
  for (let i = 0; i < (json.images?.length ?? 0); i++) {
    const set = roles.get(i);
    if (set?.has('color') && (set.has('normal') || set.has('data'))) {
      throw new Error(`image ${i} is shared by color and non-color texture slots`);
    }
    if (!set || set.size === 0) classes.set(i, 'color'); // unreferenced: safe default
    else if (set.has('normal')) classes.set(i, 'normal');
    else if (set.has('data')) classes.set(i, 'data');
    else classes.set(i, 'color');
  }
  return classes;
}

/**
 * Every byte range of buffer 0 that is NOT an embedded image payload:
 * plain bufferView ranges plus EXT_meshopt_compression stream ranges.
 * Views on `fallback: true` buffers carry no bytes and are skipped.
 */
export function geometryRanges(json, imageViewIndices) {
  const fallbackBuffers = new Set(
    (json.buffers ?? []).flatMap((b, i) =>
      b.extensions?.EXT_meshopt_compression?.fallback ? [i] : [],
    ),
  );
  const ranges = [];
  (json.bufferViews ?? []).forEach((view, i) => {
    const meshopt = view.extensions?.EXT_meshopt_compression;
    if (meshopt && (meshopt.buffer ?? 0) === 0) {
      ranges.push({
        view: i,
        kind: 'meshopt',
        offset: meshopt.byteOffset ?? 0,
        length: meshopt.byteLength,
      });
    }
    if (imageViewIndices.has(i)) return;
    if ((view.buffer ?? 0) !== 0 || fallbackBuffers.has(view.buffer ?? 0)) return;
    ranges.push({
      view: i,
      kind: 'view',
      offset: view.byteOffset ?? 0,
      length: view.byteLength,
    });
  });
  return ranges.sort((a, b) => a.offset - b.offset || a.length - b.length);
}

function digestRanges(json, bin, imageViewIndices) {
  return geometryRanges(json, imageViewIndices).map((r) => ({
    ...r,
    sha256: sha256(bin.subarray(r.offset, r.offset + r.length)),
  }));
}

function imageViewSet(json) {
  return new Set(
    (json.images ?? []).flatMap((img) =>
      Number.isInteger(img.bufferView) ? [img.bufferView] : [],
    ),
  );
}

/**
 * toktx argv for one image, by classification.
 *
 * Codec policy (measured against bevy_image 0.19.1 src/ktx2.rs on this repo's
 * lock):
 * - UASTC (+zstd) everywhere by default. Bevy 0.19 rejects BasisLZ
 *   supercompression outright ("Unsupported supercompression scheme") — its
 *   ETC1S arm is an ETC2 passthrough stub that desktop GPUs cannot sample —
 *   so ETC1S textures would kill native decode, which is the point of L5.
 *   UASTC transcodes to BC7 via the `basis-universal` feature.
 * - `color` gets sRGB transfer + UASTC RDO (albedo tolerates rate-distortion;
 *   claws back most of the ETC1S size gap after zstd).
 * - `normal` skips RDO (directional artifacts — runtime-surface-materials.md)
 *   and stays linear.
 * - `data` (ORM & friends) is linear UASTC with RDO; ETC1S endpoint sharing
 *   would cross-contaminate its independent channels.
 * - `colorCodec: 'etc1s'` remains available for web-only derivatives: Three's
 *   KTX2Loader transcodes BasisLZ fine and transfer size is ~4x smaller.
 */
export function toktxArgs(cls, { colorCodec = 'uastc', etc1sQuality = 160, uastcQuality = 2, uastcRdo = 1.0, zstdLevel = 9 } = {}) {
  // One encoder thread per toktx: output is independent of the host's core
  // count, and parallelism comes from encoding many images at once instead.
  const common = ['--t2', '--genmipmap', '--assign_primaries', 'bt709', '--threads', '1'];
  if (cls === 'color' && colorCodec === 'etc1s') {
    return [...common, '--encode', 'etc1s', '--clevel', '2', '--qlevel', String(etc1sQuality), '--assign_oetf', 'srgb'];
  }
  const uastc = [...common, '--encode', 'uastc', '--uastc_quality', String(uastcQuality), '--zcmp', String(zstdLevel), '--assign_oetf', cls === 'color' ? 'srgb' : 'linear'];
  if (cls !== 'normal') uastc.push('--uastc_rdo_l', String(uastcRdo));
  return uastc;
}

export function resolveKtxBinDir(explicit) {
  const candidate =
    explicit ??
    process.env.SIMFORGE_KTX_BIN_DIR ??
    path.join(os.homedir(), 'simforge-assets/tools/KTX-Software-4.4.2-Linux-x86_64/bin');
  if (!fs.existsSync(path.join(candidate, 'toktx'))) {
    throw new Error(
      `toktx not found in ${candidate} — install KTX-Software 4.4.2 (see tools/glb-ktx2-repack/README.md) or set SIMFORGE_KTX_BIN_DIR`,
    );
  }
  return candidate;
}

/** Concurrent toktx processes per repack; each is single-threaded. */
export function encodeConcurrency() {
  const requested = Number(process.env.SIMFORGE_KTX2_JOBS);
  if (Number.isInteger(requested) && requested > 0) return requested;
  return Math.max(1, os.availableParallelism() - 2);
}

async function encodeKtx2(sourceBytes, cls, name, { ktxBinDir, tmpDir, options }) {
  const sharp = (await import('sharp')).default;
  const image = sharp(sourceBytes);
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error(`could not read dimensions for ${name}`);
  // Bevy transcodes UASTC to BC7. wgpu requires every BC7 base dimension to
  // align to its 4x4 block, so normalize NPOT source dimensions before
  // encoding instead of producing a KTX2 that passes repack validation but
  // fails Device::create_texture at runtime. `maxDimension` caps oversized
  // authored textures (aspect preserved) before alignment.
  const cap = options?.maxDimension;
  const scale = cap && Math.max(meta.width, meta.height) > cap ? cap / Math.max(meta.width, meta.height) : 1;
  const width = align4(Math.max(1, Math.round(meta.width * scale)));
  const height = align4(Math.max(1, Math.round(meta.height * scale)));
  const cacheDir = process.env.SIMFORGE_KTX2_CACHE;
  const cacheKey = sha256(Buffer.concat([
    sourceBytes,
    Buffer.from(`\0${cls}\0uastc2-rdo1-zstd9-block4-threads1-v3\0${JSON.stringify(options ?? {})}`),
  ]));
  const cachePath = cacheDir ? path.join(cacheDir, `${cacheKey}.ktx2`) : undefined;
  if (cachePath && fs.existsSync(cachePath)) {
    return {
      ktx2: fs.readFileSync(cachePath),
      width,
      height,
      sourceWidth: meta.width,
      sourceHeight: meta.height,
      hasAlpha: meta.hasAlpha ?? false,
    };
  }
  // Names collide (RoadRunner reuses them); key temp files by cache digest.
  const pngPath = path.join(tmpDir, `${cacheKey}.png`);
  const ktxPath = path.join(tmpDir, `${cacheKey}.ktx2`);
  const prepared = width === meta.width && height === meta.height
    ? image
    : image.resize(width, height, { fit: 'fill', kernel: sharp.kernel.lanczos3 });
  await prepared.png().toFile(pngPath);
  const args = [...toktxArgs(cls, options), ktxPath, pngPath];
  try {
    await execFileAsync(path.join(ktxBinDir, 'toktx'), args, {
      encoding: 'utf8',
      env: { ...process.env, TOKTX_OPTIONS: '' },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`toktx failed for ${name}: ${error.stderr || error.stdout || error.message}`);
  }
  const ktx2 = fs.readFileSync(ktxPath);
  if (cachePath) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const temporaryCachePath = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryCachePath, ktx2);
    fs.renameSync(temporaryCachePath, cachePath);
  }
  fs.rmSync(pngPath, { force: true });
  fs.rmSync(ktxPath, { force: true });
  return {
    ktx2,
    width,
    height,
    sourceWidth: meta.width,
    sourceHeight: meta.height,
    hasAlpha: meta.hasAlpha ?? false,
  };
}

/**
 * Repack one GLB: embedded PNG/JPEG/WebP images -> KTX2, geometry bytes untouched.
 *
 * Output is standards-compliant glTF: textures reference their KTX2 image
 * exclusively through `extensions.KHR_texture_basisu.source` (the renderer's
 * vendored bevy_gltf loads that syntax natively).
 *
 * @param {Buffer} srcBuf source GLB bytes
 * @param {object} opts
 * @param {string} [opts.ktxBinDir]
 * @param {number} [opts.maxDimension] longest-edge cap applied before encoding
 * @returns {Promise<{ glb: Buffer, report: object }>}
 */
export async function repackGlb(srcBuf, opts = {}) {
  const ktxBinDir = resolveKtxBinDir(opts.ktxBinDir);
  const { json: srcJson, bin: srcBin } = parseGlb(srcBuf);
  const json = structuredClone(srcJson);

  const images = json.images ?? [];
  const rasterImages = images.flatMap((img, i) =>
    ENCODABLE_MIME_TYPES.has(img.mimeType) && Number.isInteger(img.bufferView) ? [i] : [],
  );
  if (rasterImages.length === 0) {
    return { glb: srcBuf, report: { skipped: true, reason: 'no embedded PNG, JPEG, or WebP images' } };
  }
  const srcImageViews = imageViewSet(srcJson);
  const preDigests = digestRanges(srcJson, srcBin, srcImageViews);
  const classes = classifyImages(srcJson);

  // Encode every raster image, `encodeConcurrency()` toktx processes at a
  // time. Results are keyed by image index so the report order is stable.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-ktx2-'));
  const encoded = new Map(); // image index -> { ktx2, ... }
  const textureRows = [];
  try {
    const queue = [...rasterImages];
    const worker = async () => {
      for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
        const view = srcJson.bufferViews[images[i].bufferView];
        const sourceBytes = srcBin.subarray(
          view.byteOffset ?? 0,
          (view.byteOffset ?? 0) + view.byteLength,
        );
        encoded.set(i, await encodeKtx2(sourceBytes, classes.get(i), images[i].name ?? `image_${i}`, {
          ktxBinDir,
          tmpDir,
          options: opts,
        }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(encodeConcurrency(), queue.length) }, worker));
    for (const i of rasterImages) {
      const view = srcJson.bufferViews[images[i].bufferView];
      const cls = classes.get(i);
      const result = encoded.get(i);
      textureRows.push({
        image: i,
        name: images[i].name ?? null,
        class: cls,
        codec: cls === 'color' && opts.colorCodec === 'etc1s' ? 'etc1s' : 'uastc+zstd',
        sourceMimeType: images[i].mimeType,
        width: result.width,
        height: result.height,
        sourceWidth: result.sourceWidth,
        sourceHeight: result.sourceHeight,
        sourceBytes: view.byteLength,
        ktx2Bytes: result.ktx2.length,
      });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Rebuild buffer 0: walk every byte-carrying range in original offset order;
  // image views get their new KTX2 payload, everything else is copied verbatim.
  const convertedViews = new Map(); // view index -> image index
  for (const i of rasterImages) convertedViews.set(images[i].bufferView, i);
  const segments = [];
  (srcJson.bufferViews ?? []).forEach((view, i) => {
    const meshopt = view.extensions?.EXT_meshopt_compression;
    if (meshopt && (meshopt.buffer ?? 0) === 0) {
      segments.push({ view: i, kind: 'meshopt', offset: meshopt.byteOffset ?? 0, length: meshopt.byteLength });
    }
    if ((view.buffer ?? 0) !== 0 || (meshopt && (view.buffer ?? 0) !== 0)) return;
    if (json.buffers?.[view.buffer ?? 0]?.extensions?.EXT_meshopt_compression?.fallback) return;
    segments.push({ view: i, kind: convertedViews.has(i) ? 'image' : 'view', offset: view.byteOffset ?? 0, length: view.byteLength });
  });
  segments.sort((a, b) => a.offset - b.offset || a.length - b.length);
  // Reject partially-overlapping ranges (aliased views are fine only if identical).
  for (let s = 1; s < segments.length; s++) {
    const prev = segments[s - 1];
    const cur = segments[s];
    if (cur.offset < prev.offset + prev.length && !(cur.offset === prev.offset && cur.length === prev.length)) {
      throw new Error(`overlapping bufferView ranges (views ${prev.view}/${cur.view}) — refusing to repack`);
    }
  }

  const parts = [];
  let cursor = 0;
  for (const seg of segments) {
    const bytes =
      seg.kind === 'image'
        ? encoded.get(convertedViews.get(seg.view)).ktx2
        : srcBin.subarray(seg.offset, seg.offset + seg.length);
    const start = align4(cursor);
    if (start > cursor) parts.push(Buffer.alloc(start - cursor));
    parts.push(bytes);
    cursor = start + bytes.length;
    const target = json.bufferViews[seg.view];
    if (seg.kind === 'meshopt') {
      target.extensions.EXT_meshopt_compression.byteOffset = start;
    } else {
      target.byteOffset = start;
      if (seg.kind === 'image') target.byteLength = bytes.length;
    }
  }
  const newBin = Buffer.concat(parts);
  json.buffers[0].byteLength = newBin.length;

  // Rewrite image + texture references.
  for (const i of rasterImages) {
    json.images[i].mimeType = 'image/ktx2';
  }
  const convertedImages = new Set(rasterImages);
  for (const texture of json.textures ?? []) {
    const image = textureImageIndex(texture);
    if (image === null || !convertedImages.has(image)) continue;
    delete texture.extensions?.EXT_texture_webp;
    delete texture.extensions?.EXT_texture_avif;
    texture.extensions = { ...texture.extensions, KHR_texture_basisu: { source: image } };
    delete texture.source;
  }
  const dropExts = new Set(['EXT_texture_webp', 'EXT_texture_avif']);
  json.extensionsUsed = [
    ...new Set([...(json.extensionsUsed ?? []).filter((e) => !dropExts.has(e)), 'KHR_texture_basisu']),
  ];
  json.extensionsRequired = [
    ...new Set([...(json.extensionsRequired ?? []).filter((e) => !dropExts.has(e)), 'KHR_texture_basisu']),
  ];

  const glb = writeGlb(json, newBin);

  // Prove geometry identity on the actual output bytes.
  const identity = verifyGeometryIdentity(srcBuf, glb);
  if (!identity.ok) {
    throw new Error(`geometry identity broken: ${identity.failures.map((f) => `view ${f.view} (${f.kind})`).join(', ')}`);
  }

  const report = {
    images: textureRows,
    geometry: {
      ranges: preDigests.length,
      identical: identity.ok,
    },
    bytes: { src: srcBuf.length, out: glb.length },
  };
  return { glb, report };
}

/**
 * Prove that every non-image byte range and all geometry-bearing JSON of `out`
 * match `src`. Returns per-range digests for reporting.
 */
export function verifyGeometryIdentity(srcBuf, outBuf) {
  const src = parseGlb(srcBuf);
  const out = parseGlb(outBuf);
  const srcRanges = digestRanges(src.json, src.bin, imageViewSet(src.json));
  const outRanges = digestRanges(out.json, out.bin, imageViewSet(out.json));
  const failures = [];
  if (srcRanges.length !== outRanges.length) {
    failures.push({ view: -1, kind: 'count', src: srcRanges.length, out: outRanges.length });
  }
  const byKey = new Map(outRanges.map((r) => [`${r.view}:${r.kind}`, r]));
  for (const range of srcRanges) {
    const other = byKey.get(`${range.view}:${range.kind}`);
    if (!other || other.sha256 !== range.sha256 || other.length !== range.length) {
      failures.push({ view: range.view, kind: range.kind, src: range.sha256, out: other?.sha256 ?? null });
    }
  }
  // JSON invariants: accessors and meshes byte-identical; geometry bufferViews
  // identical except byteOffset (+ meshopt byteOffset).
  const stable = (v) => JSON.stringify(v ?? null);
  if (stable(src.json.accessors) !== stable(out.json.accessors)) {
    failures.push({ view: -1, kind: 'accessors-json' });
  }
  if (stable(src.json.meshes) !== stable(out.json.meshes)) {
    failures.push({ view: -1, kind: 'meshes-json' });
  }
  const srcImgViews = imageViewSet(src.json);
  (src.json.bufferViews ?? []).forEach((view, i) => {
    if (srcImgViews.has(i)) return;
    const a = structuredClone(view);
    const b = structuredClone(out.json.bufferViews?.[i] ?? null);
    if (!b) return failures.push({ view: i, kind: 'view-json-missing' });
    delete a.byteOffset;
    delete b.byteOffset;
    if (a.extensions?.EXT_meshopt_compression) delete a.extensions.EXT_meshopt_compression.byteOffset;
    if (b.extensions?.EXT_meshopt_compression) delete b.extensions.EXT_meshopt_compression.byteOffset;
    if (stable(a) !== stable(b)) failures.push({ view: i, kind: 'view-json' });
  });
  return { ok: failures.length === 0, failures, ranges: srcRanges };
}
