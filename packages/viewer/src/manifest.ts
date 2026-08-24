import { Box3, Vector3 } from 'three';
import type { CityManifest, ManifestBounds, ManifestLod } from './types';

export function boundsToBox3(b: ManifestBounds): Box3 {
  return new Box3(
    new Vector3(b.min[0] ?? 0, b.min[1] ?? 0, b.min[2] ?? 0),
    new Vector3(b.max[0] ?? 0, b.max[1] ?? 0, b.max[2] ?? 0),
  );
}

export function resolveUrl(baseUrl: string, file: string): string {
  if (/^(https?:)?\/\//.test(file) || file.startsWith('data:')) return file;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return base + file.replace(/^\.?\//, '');
}

/**
 * LOD lists sorted coarse-first (highest geometric error first) with duplicates
 * collapsed.
 *
 * The Yale Street vegetation tiles ship lod0 and lod1 as byte-identical files
 * (same triangles, same fileSize, same texture set) — keeping both would make
 * the selector re-download the same payload under a second URL as the camera
 * closes in. We drop the finer of any such pair and keep the coarser entry,
 * which carries the larger geometric error and therefore satisfies the same
 * quality at greater distance.
 */
export function normalizeLods(lods: ManifestLod[]): ManifestLod[] {
  const sorted = [...lods].sort((a, b) => b.geometricError - a.geometricError);
  const out: ManifestLod[] = [];
  for (const lod of sorted) {
    const dup = out.some((o) => o.fileSize === lod.fileSize && o.triangles === lod.triangles);
    if (!dup) out.push(lod);
  }
  return out;
}

export function sceneCenter(manifest: CityManifest): Vector3 {
  return boundsToBox3(manifest.scene.bounds).getCenter(new Vector3());
}

/** Ratio of estimated GPU bytes to compressed file bytes, per LOD index. */
const BYTES_PER_FILE_BYTE = [6.6, 3.3, 2.3, 2.0];

/**
 * Pre-load estimate of the GPU footprint of a LOD. The manifest only exposes
 * the compressed file size; these ratios were measured over the Yale Street
 * tiles (RGBA8 + mip chain, meshopt geometry expanded). The ledger is corrected
 * with the real number once the asset is built.
 */
export function estimateLodBytes(lod: ManifestLod): number {
  const ratio = BYTES_PER_FILE_BYTE[Math.min(lod.level, BYTES_PER_FILE_BYTE.length - 1)] ?? 2;
  return lod.fileSize * ratio;
}
