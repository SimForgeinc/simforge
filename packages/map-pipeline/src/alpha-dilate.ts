import type { Document } from '@gltf-transform/core';
import sharp from 'sharp';

/**
 * Authored cutout textures (leaf cards, fences, signs) often carry garbage
 * RGB under fully transparent texels — RoadRunner/Unreal leave them white or
 * black. Every mip generated later (toktx for the native corpus, the GPU for
 * the browser) box-filters those texels into the visible edge, so foliage
 * grows white or dark halos at distance. Flood the nearest opaque colour into
 * the invisible texels first; alpha and every visible texel stay byte-exact.
 */

/** Texels at or below this alpha are invisible under MASK and BLEND alike. */
const INVISIBLE_ALPHA = 8;

export interface AlphaDilateReport {
  textures: number;
}

/** Jump-flood nearest-seed propagation; returns per-texel seed index or -1. */
function nearestOpaque(width: number, height: number, opaque: Uint8Array): Int32Array {
  const count = width * height;
  let seeds = new Int32Array(count);
  let next = new Int32Array(count);
  for (let i = 0; i < count; i += 1) seeds[i] = opaque[i]! ? i : -1;
  let step = 1;
  while (step * 2 < Math.max(width, height)) step *= 2;
  for (; step >= 1; step = Math.floor(step / 2)) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const self = y * width + x;
        let best = seeds[self]!;
        let bestDist = best < 0 ? Number.POSITIVE_INFINITY : squaredDistance(best, self, width);
        for (let dy = -step; dy <= step; dy += step) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -step; dx <= step; dx += step) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const candidate = seeds[ny * width + nx]!;
            if (candidate < 0) continue;
            const dist = squaredDistance(candidate, self, width);
            if (dist < bestDist) {
              best = candidate;
              bestDist = dist;
            }
          }
        }
        next[self] = best;
      }
    }
    [seeds, next] = [next, seeds];
  }
  return seeds;
}

function squaredDistance(a: number, b: number, width: number): number {
  const dx = (a % width) - (b % width);
  const dy = Math.floor(a / width) - Math.floor(b / width);
  return dx * dx + dy * dy;
}

/** Dilate one RGBA buffer in place; returns whether anything changed. */
export function dilateRgba(data: Uint8Array, width: number, height: number): boolean {
  const count = width * height;
  const opaque = new Uint8Array(count);
  let invisible = 0;
  for (let i = 0; i < count; i += 1) {
    const visible = data[i * 4 + 3]! > INVISIBLE_ALPHA;
    opaque[i] = visible ? 1 : 0;
    if (!visible) invisible += 1;
  }
  if (invisible === 0 || invisible === count) return false;
  const seeds = nearestOpaque(width, height, opaque);
  for (let i = 0; i < count; i += 1) {
    if (opaque[i]!) continue;
    const source = seeds[i]!;
    if (source < 0) continue;
    data[i * 4] = data[source * 4]!;
    data[i * 4 + 1] = data[source * 4 + 1]!;
    data[i * 4 + 2] = data[source * 4 + 2]!;
  }
  return true;
}

/** Rewrites every PNG texture with invisible texels; alpha is untouched. */
export async function dilateAlphaEdges(document: Document): Promise<AlphaDilateReport> {
  const report: AlphaDilateReport = { textures: 0 };
  for (const texture of document.getRoot().listTextures()) {
    if (texture.getMimeType() !== 'image/png') continue;
    const image = texture.getImage();
    if (image === null) continue;
    const decoded = await sharp(Buffer.from(image)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = decoded.info;
    if (channels !== 4) continue;
    const data = new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
    if (!dilateRgba(data, width, height)) continue;
    const encoded = await sharp(Buffer.from(data), { raw: { width, height, channels: 4 } }).png().toBuffer();
    texture.setImage(new Uint8Array(encoded));
    report.textures += 1;
  }
  return report;
}
