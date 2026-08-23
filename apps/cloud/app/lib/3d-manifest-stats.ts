/**
 * Pure functions to parse a 3D digital twin manifest.json and compute
 * aggregate statistics for the attribute panel.
 *
 * All S3 / HTTP concerns live in the API route — this module is purely
 * computational so it can be unit-tested without mocking infrastructure.
 */

// ---------------------------------------------------------------------------
// Manifest types (matches the city-preprocess output)
// ---------------------------------------------------------------------------

export interface ManifestLod {
  level: number;
  file: string;
  triangles: number;
  fileSize: number;
  geometricError: number;
}

export interface ManifestTile {
  id: string;
  gridX: number;
  gridZ: number;
  bounds: { min: number[]; max: number[] };
  lods: ManifestLod[];
}

export interface ManifestStaticLayer {
  id: string;
  file: string;
  triangles: number;
  fileSize: number;
}

export interface ManifestVegPrototype {
  meshName: string;
  triangles: number;
  instanceCount: number;
}

export interface ManifestVegetationTile extends ManifestTile {
  prototypes: ManifestVegPrototype[];
  instanceFile: string;
}

export interface Manifest {
  version: string;
  generator: string;
  created: string;
  scene: {
    bounds: { min: number[]; max: number[] };
    totalTriangles: number;
    gridDimensions: [number, number];
    cellSize: [number, number];
    origin: number[];
    lodLevels: number;
    coordinateSystem: string;
  };
  tiles: ManifestTile[];
  staticLayers?: ManifestStaticLayer[];
  vegetationTiles?: ManifestVegetationTile[];
}

// ---------------------------------------------------------------------------
// Computed stats response shape
// ---------------------------------------------------------------------------

export interface ThreeDStats {
  // Manifest metadata
  version: string;
  generator: string;
  created: string;

  // Scene overview (hero stats)
  totalTriangles: number;
  gridDimensions: [number, number];
  lodLevels: number;
  tileCount: number;
  coordinateSystem: string;

  // Bounds & footprint
  bounds: { min: number[]; max: number[] };
  cellSize: [number, number];
  sceneDimensions: { widthM: number; depthM: number; heightM: number };

  // Static layers
  staticLayers: { id: string; triangles: number; fileSize: number }[];
  staticLayerTotalSize: number;

  // Per-tile summary (for analytics)
  tiles: {
    id: string;
    gridX: number;
    gridZ: number;
    lod0Triangles: number;
    lod0FileSize: number;
  }[];
  avgTrianglesPerTile: number;
  maxTileTriangles: number;
  minTileTriangles: number;

  // Per-LOD summaries
  lodSummaries: {
    level: number;
    totalTriangles: number;
    totalFileSize: number;
    avgGeometricError: number;
  }[];

  // Total file size (LOD0 tiles + static layers + veg LOD0)
  totalFileSize: number;

  // Vegetation
  hasVegetation: boolean;
  vegetationTileCount: number;
  totalVegetationInstances: number;
  vegetationPrototypes: { meshName: string; totalInstances: number }[];
  avgVegetationInstancesPerTile: number;
}

// ---------------------------------------------------------------------------
// Computation helpers
// ---------------------------------------------------------------------------

/** Get the LOD0 triangle count from a tile, defaulting to 0. */
function lod0Triangles(tile: ManifestTile): number {
  return tile.lods.find((l) => l.level === 0)?.triangles ?? 0;
}

/** Get the LOD0 file size from a tile, defaulting to 0. */
function lod0FileSize(tile: ManifestTile): number {
  return tile.lods.find((l) => l.level === 0)?.fileSize ?? 0;
}

/** Aggregate per-LOD statistics across all tiles. */
export function computeLodSummaries(
  tiles: ManifestTile[],
  lodLevels: number,
): ThreeDStats["lodSummaries"] {
  const summaries: ThreeDStats["lodSummaries"] = [];
  for (let level = 0; level < lodLevels; level++) {
    let totalTriangles = 0;
    let totalFileSize = 0;
    let totalGeometricError = 0;
    let count = 0;
    for (const tile of tiles) {
      const lod = tile.lods.find((l) => l.level === level);
      if (lod) {
        totalTriangles += lod.triangles;
        totalFileSize += lod.fileSize;
        totalGeometricError += lod.geometricError;
        count++;
      }
    }
    summaries.push({
      level,
      totalTriangles,
      totalFileSize,
      avgGeometricError: count > 0 ? totalGeometricError / count : 0,
    });
  }
  return summaries;
}

/** Aggregate vegetation prototype instance counts across all vegetation tiles. */
export function aggregateVegetationPrototypes(
  vegetationTiles: ManifestVegetationTile[],
): { meshName: string; totalInstances: number }[] {
  const protoMap = new Map<string, number>();
  for (const vt of vegetationTiles) {
    for (const p of vt.prototypes) {
      protoMap.set(p.meshName, (protoMap.get(p.meshName) ?? 0) + p.instanceCount);
    }
  }
  return [...protoMap.entries()].map(([meshName, totalInstances]) => ({
    meshName,
    totalInstances,
  }));
}

/** Compute scene physical dimensions from the bounding box. */
export function computeSceneDimensions(
  bounds: { min: number[]; max: number[] },
): { widthM: number; depthM: number; heightM: number } {
  return {
    widthM: Math.abs((bounds.max[0] ?? 0) - (bounds.min[0] ?? 0)),
    heightM: Math.abs((bounds.max[1] ?? 0) - (bounds.min[1] ?? 0)),
    depthM: Math.abs((bounds.max[2] ?? 0) - (bounds.min[2] ?? 0)),
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Compute 3D digital twin statistics from a parsed manifest.
 * Pure function — no I/O.
 */
export function computeThreeDStats(manifest: Manifest): ThreeDStats {
  const { scene, tiles, staticLayers = [], vegetationTiles = [] } = manifest;

  const tileLod0Triangles = tiles.map(lod0Triangles);
  const tileCount = tiles.length;

  const sceneDimensions = computeSceneDimensions(scene.bounds);

  const staticLayerTotalSize = staticLayers.reduce((s, l) => s + l.fileSize, 0);

  const lodSummaries = computeLodSummaries(tiles, scene.lodLevels);

  // Total file size: LOD0 tiles + static layers + vegetation LOD0
  const tilesLod0Size = tiles.reduce((s, t) => s + lod0FileSize(t), 0);
  const vegLod0Size = vegetationTiles.reduce((s, t) => s + lod0FileSize(t), 0);
  const totalFileSize = tilesLod0Size + staticLayerTotalSize + vegLod0Size;

  // Vegetation aggregation
  const totalVegetationInstances = vegetationTiles.reduce(
    (s, t) => s + t.prototypes.reduce((ps, p) => ps + p.instanceCount, 0),
    0,
  );
  const vegetationPrototypes = aggregateVegetationPrototypes(vegetationTiles);

  return {
    version: manifest.version,
    generator: manifest.generator,
    created: manifest.created,

    totalTriangles: scene.totalTriangles,
    gridDimensions: scene.gridDimensions,
    lodLevels: scene.lodLevels,
    tileCount,
    coordinateSystem: scene.coordinateSystem,

    bounds: scene.bounds,
    cellSize: scene.cellSize,
    sceneDimensions,

    staticLayers: staticLayers.map((l) => ({
      id: l.id,
      triangles: l.triangles,
      fileSize: l.fileSize,
    })),
    staticLayerTotalSize,

    tiles: tiles.map((t) => ({
      id: t.id,
      gridX: t.gridX,
      gridZ: t.gridZ,
      lod0Triangles: lod0Triangles(t),
      lod0FileSize: lod0FileSize(t),
    })),
    avgTrianglesPerTile: tileCount > 0
      ? Math.round(tileLod0Triangles.reduce((a, b) => a + b, 0) / tileCount)
      : 0,
    maxTileTriangles: tileLod0Triangles.length > 0 ? Math.max(...tileLod0Triangles) : 0,
    minTileTriangles: tileLod0Triangles.length > 0 ? Math.min(...tileLod0Triangles) : 0,

    lodSummaries,
    totalFileSize,

    hasVegetation: vegetationTiles.length > 0,
    vegetationTileCount: vegetationTiles.length,
    totalVegetationInstances,
    vegetationPrototypes,
    avgVegetationInstancesPerTile:
      vegetationTiles.length > 0
        ? Math.round(totalVegetationInstances / vegetationTiles.length)
        : 0,
  };
}
