export interface AABB {
  min: [number, number, number];
  max: [number, number, number];
}

export type Vec3 = [number, number, number];

export interface LODLevelConfig {
  ratio: number;
  error: number;
  maxTextureDim: number;
}

export interface LODLevelInfo {
  level: number;
  file: string;
  triangles: number;
  fileSize: number;
  geometricError: number;
}

export interface TileDescriptor {
  id: string;
  gridX: number;
  gridZ: number;
  bounds: AABB;
  lods: LODLevelInfo[];
  /** v1.2.0+ per-tile shadow lightmap metadata. Opaque to the viewer. */
  shadowLightmaps?: unknown;
}

export interface SceneInfo {
  bounds: AABB;
  totalTriangles: number;
  gridDimensions: [number, number];
  cellSize: [number, number];
  origin: Vec3;
  lodLevels: number;
  coordinateSystem: 'y-up' | 'z-up';
}

/** A static layer that is always loaded and never culled (e.g. roads) */
export interface StaticLayer {
  id: string;
  file: string;
  triangles: number;
  fileSize: number;
}

export interface StaticSemanticsReference {
  file: string;
}

/** A single vegetation prototype (unique mesh) within a tile */
export interface VegetationPrototype {
  meshName: string;
  triangles: number;
  instanceCount: number;
}

/** A vegetation tile descriptor — extends TileDescriptor */
export interface VegetationTileDescriptor extends TileDescriptor {
  prototypes: VegetationPrototype[];
  instanceFile: string;
}

/** Baked shadow map metadata */
export interface ShadowMapInfo {
  file: string;
  resolution: number;
  sunDirection: Vec3;
  bounds: AABB;
  viewMatrix: number[];
  projectionMatrix: number[];
}

export interface Manifest {
  version: string;
  generator: string;
  created: string;
  scene: SceneInfo;
  tiles: TileDescriptor[];
  /** Layers always loaded and never culled/LOD-switched */
  staticLayers: StaticLayer[];
  vegetationTiles?: VegetationTileDescriptor[];
  shadowMap?: ShadowMapInfo;
  /** v1.2.0+ scene-level shadow lightmap metadata. Opaque to the viewer. */
  shadowLightmap?: unknown;
  /** Optional digest-bound static semantic metadata for browser sensor passes. */
  staticSemantics?: StaticSemanticsReference;
}

/** Per-map entry in the map index */
export interface MapEntry {
  id: string;
  name: string;
  path: string;
  defaultCamera?: {
    position: [number, number, number];
    target: [number, number, number];
  };
}

/** Top-level map index (data/maps/index.json) */
export interface MapIndex {
  maps: MapEntry[];
  defaultMap: string;
}
