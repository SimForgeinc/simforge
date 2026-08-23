import type { GroundIndex } from './ground-index';

export type GroundHeightSampler = (x: number, z: number) => number | null;

type IndexedHeightViewer = {
  getGroundIndex(): Pick<GroundIndex, 'bounds' | 'sample' | 'sampleNear'> | null;
  sampleGroundHeight(x: number, z: number): number | null;
};

/**
 * Resolve repeated world-height queries through the spatial index, retaining
 * raycasting only for index warmup and one stable map datum.
 */
export function indexedWorldHeightSampler(
  viewer: IndexedHeightViewer,
): GroundHeightSampler {
  let indexed: GroundHeightSampler | null = null;

  return (x, z) => {
    if (!indexed) {
      const index = viewer.getGroundIndex();
      if (!index) return viewer.sampleGroundHeight(x, z);

      const bounds = index.bounds();
      const centerX = (bounds.min.x + bounds.max.x) / 2;
      const centerZ = (bounds.min.z + bounds.max.z) / 2;
      const datum = index.sampleNear(centerX, centerZ, 400)
        ?? viewer.sampleGroundHeight(centerX, centerZ)
        ?? 0;

      indexed = (sampleX, sampleZ) => index.sample(sampleX, sampleZ)
        ?? index.sampleNear(sampleX, sampleZ, 8)
        ?? datum;
    }

    return indexed(x, z);
  };
}
