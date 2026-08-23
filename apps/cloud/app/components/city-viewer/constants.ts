import type { LODLevelConfig } from './types';

export const DEFAULT_LOD_LEVELS: LODLevelConfig[] = [
  { ratio: 1.0, error: 0, maxTextureDim: 2048 },
  { ratio: 0.5, error: 0.005, maxTextureDim: 1024 },
  { ratio: 0.15, error: 0.02, maxTextureDim: 512 },
  { ratio: 0.04, error: 0.08, maxTextureDim: 256 },
];

export const DEFAULT_TARGET_TRIS_PER_TILE = 125_000;
export const MANIFEST_VERSION = '1.1.0';
export const DEFAULT_MEMORY_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_CONCURRENT_FETCHES = 6;
export const DEFAULT_FAR_PLANE = 20_000;
export const DEFAULT_NEAR_PLANE = 0.5;
export const DEFAULT_FOV = 60;

export const VEGETATION_INSTANCE_KEEP_RATES = [1.0, 1.0, 1.0, 1.0];
export const VEGETATION_LARGE_PROTOTYPE_RADIUS = 5.0;
export const VEGETATION_TARGET_INSTANCES_PER_TILE = 400;
export const VEGETATION_GEOMETRIC_ERROR_MULTIPLIER = 4.0;
