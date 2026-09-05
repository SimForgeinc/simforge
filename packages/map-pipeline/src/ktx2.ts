import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import sharp from 'sharp';

import { dilateRgba } from './alpha-dilate.js';
import { sha256 } from './closure.js';

/**
 * GPU texture encoding for the map master: one KTX2 (UASTC + zstd, full mip
 * chain) per distinct source image. This is the only lossy step in the
 * pipeline; both the native renderer (transcodes UASTC -> BC7 at load) and the
 * web tier sample these files, so no encoder generation is ever stacked on
 * another.
 *
 * Codec policy (measured against bevy_image 0.19.1 on this repo's lock):
 * - UASTC everywhere. Bevy rejects BasisLZ/ETC1S supercompression outright.
 * - `color` slots get sRGB transfer; `normal` and `data` stay linear.
 * - `normal` skips rate-distortion optimisation (directional artifacts);
 *   colour and packed data tolerate a mild RDO.
 * - Cutout textures are alpha-dilated before mip generation so invisible
 *   texels never bleed into visible edges at distance; the PNG in the master
 *   is never touched.
 * - Dimensions are aligned to 4 (BC7 block size); wgpu rejects unaligned
 *   base levels at texture creation.
 */

export type ImageClass = 'color' | 'normal' | 'data';

export const KTX_SOFTWARE_VERSION = '4.4.2';
export const KTX2_ENCODER_REVISION = 1;

const COLOR_EXTENSION_SLOTS = new Set(['specularColorTexture', 'sheenColorTexture', 'diffuseTexture']);
const TEXTURE_SOURCE_EXTENSIONS = ['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif'];

const execFileAsync = promisify(execFile);
const align4 = (n: number): number => (n + 3) & ~3;

type Json = Record<string, unknown>;

function textureImageIndex(texture: Json | undefined): number | null {
  for (const extension of TEXTURE_SOURCE_EXTENSIONS) {
    const source = ((texture?.['extensions'] as Json | undefined)?.[extension] as Json | undefined)?.['source'];
    if (Number.isInteger(source)) return source as number;
  }
  return Number.isInteger(texture?.['source']) ? (texture!['source'] as number) : null;
}

/**
 * Classify every image of a serialized glTF by material slot usage. An image
 * shared by colour and non-colour slots is rejected: KTX2 stores one transfer
 * function per image.
 */
export function classifyImages(json: Json): Map<number, ImageClass> {
  const roles = new Map<number, Set<ImageClass>>();
  const textures = (json['textures'] ?? []) as Json[];
  const mark = (info: unknown, role: ImageClass): void => {
    const index = (info as Json | undefined)?.['index'];
    if (!Number.isInteger(index)) return;
    const image = textureImageIndex(textures[index as number]);
    if (image === null) return;
    let set = roles.get(image);
    if (!set) roles.set(image, (set = new Set()));
    set.add(role);
  };
  for (const material of (json['materials'] ?? []) as Json[]) {
    const pbr = (material['pbrMetallicRoughness'] ?? {}) as Json;
    mark(pbr['baseColorTexture'], 'color');
    mark(material['emissiveTexture'], 'color');
    mark(pbr['metallicRoughnessTexture'], 'data');
    mark(material['occlusionTexture'], 'data');
    mark(material['normalTexture'], 'normal');
    for (const extension of Object.values((material['extensions'] ?? {}) as Record<string, Json>)) {
      for (const [key, value] of Object.entries(extension)) {
        if (!value || !Number.isInteger((value as Json)['index'])) continue;
        if (/normalTexture$/i.test(key)) mark(value, 'normal');
        else if (COLOR_EXTENSION_SLOTS.has(key)) mark(value, 'color');
        else if (/Texture$/i.test(key)) mark(value, 'data');
      }
    }
  }
  const classes = new Map<number, ImageClass>();
  const count = ((json['images'] ?? []) as unknown[]).length;
  for (let i = 0; i < count; i += 1) {
    const set = roles.get(i);
    if (set?.has('color') && (set.has('normal') || set.has('data'))) {
      throw new Error(`image ${i} is shared by color and non-color texture slots`);
    }
    if (!set || set.size === 0) classes.set(i, 'color');
    else if (set.has('normal')) classes.set(i, 'normal');
    else if (set.has('data')) classes.set(i, 'data');
    else classes.set(i, 'color');
  }
  return classes;
}

export interface Ktx2Options {
  ktxBinDir?: string;
  /** Longest-edge cap applied before encoding; authored size by default. */
  maxDimension?: number;
  uastcQuality?: number;
  uastcRdo?: number;
  zstdLevel?: number;
}

export function toktxArgs(cls: ImageClass, { uastcQuality = 2, uastcRdo = 1.0, zstdLevel = 9 }: Ktx2Options = {}): string[] {
  // One encoder thread per toktx: output is independent of the host's core
  // count, and parallelism comes from encoding many images at once instead.
  const args = ['--t2', '--genmipmap', '--assign_primaries', 'bt709', '--threads', '1', '--encode', 'uastc', '--uastc_quality', String(uastcQuality), '--zcmp', String(zstdLevel), '--assign_oetf', cls === 'color' ? 'srgb' : 'linear'];
  if (cls !== 'normal') args.push('--uastc_rdo_l', String(uastcRdo));
  return args;
}

export function resolveKtxBinDir(explicit?: string): string {
  const candidate = explicit
    ?? process.env['SIMFORGE_KTX_BIN_DIR']
    ?? path.join(os.homedir(), `simforge-assets/tools/KTX-Software-${KTX_SOFTWARE_VERSION}-Linux-x86_64/bin`);
  if (!existsSync(path.join(candidate, 'toktx'))) {
    throw new Error(`toktx not found in ${candidate}; install KTX-Software ${KTX_SOFTWARE_VERSION} or set SIMFORGE_KTX_BIN_DIR`);
  }
  return candidate;
}

/** Concurrent toktx processes; each is single-threaded. */
export function encodeConcurrency(): number {
  const requested = Number(process.env['SIMFORGE_KTX2_JOBS']);
  if (Number.isInteger(requested) && requested > 0) return requested;
  return Math.max(1, os.availableParallelism() - 2);
}

export function ktx2ToolFingerprint(options: Ktx2Options = {}): string {
  const { ktxBinDir: _dir, ...encoding } = options;
  return sha256(`ktx2\0${KTX2_ENCODER_REVISION}\0ktx-software=${KTX_SOFTWARE_VERSION}\0${JSON.stringify(encoding)}`);
}

export interface EncodedImage {
  bytes: Buffer;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  dilated: boolean;
}

/**
 * Encode one source image (PNG/JPEG/WebP bytes) as KTX2. Results are cached
 * under `SIMFORGE_KTX2_CACHE` by source digest, class and encoder settings, so
 * rebuilding a map or sharing images across maps never re-encodes.
 */
export async function encodeKtx2(sourceBytes: Uint8Array, cls: ImageClass, options: Ktx2Options = {}): Promise<EncodedImage> {
  const ktxBinDir = resolveKtxBinDir(options.ktxBinDir);
  const { ktxBinDir: _dir, ...encoding } = options;
  const image = sharp(Buffer.from(sourceBytes));
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error('could not read image dimensions');
  const cap = options.maxDimension;
  const scale = cap && Math.max(meta.width, meta.height) > cap ? cap / Math.max(meta.width, meta.height) : 1;
  const width = align4(Math.max(1, Math.round(meta.width * scale)));
  const height = align4(Math.max(1, Math.round(meta.height * scale)));
  const cacheKey = sha256(Buffer.concat([Buffer.from(sourceBytes), Buffer.from(`\0${cls}\0${ktx2ToolFingerprint(encoding)}`)]));
  const cacheDir = process.env['SIMFORGE_KTX2_CACHE'];
  const cachePath = cacheDir ? path.join(cacheDir, `${cacheKey}.ktx2`) : undefined;
  const result = (bytes: Buffer, dilated: boolean): EncodedImage => ({ bytes, width, height, sourceWidth: meta.width!, sourceHeight: meta.height!, dilated });
  if (cachePath && existsSync(cachePath)) {
    return result(await readFile(cachePath), meta.hasAlpha === true);
  }

  // Decode once; dilate cutout colour under invisible texels before mips are
  // generated; resize (aspect preserved) and pad to the 4x4 block grid.
  const decoded = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw = new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
  const dilated = meta.hasAlpha === true && dilateRgba(raw, decoded.info.width, decoded.info.height);
  let prepared = sharp(Buffer.from(raw), { raw: { width: decoded.info.width, height: decoded.info.height, channels: 4 } });
  if (width !== meta.width || height !== meta.height) {
    prepared = prepared.resize(width, height, { fit: 'fill', kernel: sharp.kernel.lanczos3 });
  }
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'simforge-ktx2-'));
  try {
    const pngPath = path.join(tmpDir, 'in.png');
    const ktxPath = path.join(tmpDir, 'out.ktx2');
    // Temporary toktx input: lossless at any level, so the cheapest deflate.
    await prepared.png({ compressionLevel: 1 }).toFile(pngPath);
    try {
      await execFileAsync(path.join(ktxBinDir, 'toktx'), [...toktxArgs(cls, encoding), ktxPath, pngPath], {
        encoding: 'utf8',
        env: { ...process.env, TOKTX_OPTIONS: '' },
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      const failure = error as { stderr?: string; stdout?: string; message: string };
      throw new Error(`toktx failed: ${failure.stderr || failure.stdout || failure.message}`);
    }
    const bytes = await readFile(ktxPath);
    if (cachePath) {
      await mkdir(cacheDir!, { recursive: true });
      const temporary = `${cachePath}.${process.pid}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, cachePath);
    }
    return result(bytes, dilated);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/** Run `work` over `items` with at most `limit` in flight; results keep input order. */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await work(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
