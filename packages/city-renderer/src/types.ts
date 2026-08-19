/**
 * Types for the tiled 3D city manifest (schema version 1.x) plus the public
 * option/stat shapes of {@link CityViewer}.
 */

export interface ManifestBounds {
  min: number[];
  max: number[];
}

export interface ManifestLod {
  level: number;
  file: string;
  triangles: number;
  fileSize: number;
  /** Object-space error in metres this LOD introduces vs. LOD0. LOD0 is always 0. */
  geometricError: number;
}

export interface ManifestShadowLightmap {
  lod: number;
  file: string;
}

export interface ManifestTile {
  id: string;
  gridX: number;
  gridZ: number;
  bounds: ManifestBounds;
  lods: ManifestLod[];
  shadowLightmaps?: ManifestShadowLightmap[];
}

export interface ManifestVegPrototype {
  meshName: string;
  triangles: number;
  instanceCount: number;
}

export interface ManifestVegetationTile {
  id: string;
  gridX: number;
  gridZ: number;
  bounds: ManifestBounds;
  lods: ManifestLod[];
  prototypes: ManifestVegPrototype[];
  instanceFile: string;
}

export interface ManifestStaticLayer {
  id: string;
  file: string;
  triangles: number;
  fileSize: number;
}

export interface ManifestScene {
  bounds: ManifestBounds;
  totalTriangles: number;
  gridDimensions: number[];
  cellSize: number[];
  origin: number[];
  lodLevels: number;
  coordinateSystem: string;
}

export interface CityManifest {
  version: string;
  scene: ManifestScene;
  tiles: ManifestTile[];
  staticLayers?: ManifestStaticLayer[];
  vegetationTiles?: ManifestVegetationTile[];
  shadowLightmap?: {
    /** Direction the sunlight *travels* (i.e. points away from the sun). */
    sunDirection: number[];
    bakedAt?: string;
    method?: string;
  };
  actorCounts?: Record<string, number>;
}

/**
 * Payload of `tiles/veg_X_Z.instances.json`.
 *
 * `transforms` is a flat run of 16-float column-major matrices (translation at
 * offsets 12/13/14 — verified against the Yale Street data), grouped by
 * prototype in `prototypes` order with `counts[i]` entries per group.
 * `lodKeepCounts[lod][i]` is how many of group `i` to draw at that LOD.
 */
export interface VegetationInstanceFile {
  prototypes: string[];
  counts: number[];
  transforms: number[];
  lodKeepCounts?: number[][];
}

export interface CityViewerOptions {
  /** Base URL that manifest-relative asset paths resolve against. */
  baseUrl?: string;
  /** Device pixel ratio cap. Retina at 2.0 is ~4x the fill cost of 1.0. */
  maxPixelRatio?: number;
  /** WebGL multisample antialiasing. Requires a renderer recreation to change. */
  antialias?: boolean;
  /** Screen-space-error threshold in pixels; smaller = more aggressive streaming. */
  maxScreenSpaceError?: number;
  /** Separate threshold for vegetation tiles (their errors use a different scale). */
  vegetationScreenSpaceError?: number;
  /** Resident geometry+texture budget in bytes (estimated GPU footprint). */
  byteBudget?: number;
  /** Concurrent tile fetch/parse slots. */
  maxConcurrentLoads?: number;
  /** Per-frame milliseconds spent pushing new textures to the GPU. */
  uploadBudgetMs?: number;
  /** Per-frame texel budget for GPU uploads. */
  uploadPixelsPerFrame?: number;
  /** HDRI environment, relative to baseUrl. */
  environmentUrl?: string;
  /** Directional light intensity. */
  sunIntensity?: number;
  /** Environment (IBL) intensity. */
  environmentIntensity?: number;
  /** Tone mapping exposure. */
  exposure?: number;
  /** Max distance (m) at which vegetation tiles are drawn. */
  vegetationMaxDistance?: number;
  /** Resolution (px) of one grid cell inside the stitched shadow atlas. */
  shadowAtlasCellSize?: number;
  /** 0 disables the baked shadow term entirely. */
  shadowStrength?: number;
  /** Render the baked shadow term instead of shading (projection QA). */
  debugShadowProjection?: boolean;
  /** Horizontal metres kept between the camera and the map footprint edge. */
  cameraBoundsInset?: number;
  /** Local optimized asset preference. Ultra Low fails closed rather than fetching textured source. */
  assetVariant?: import('./asset-variants').CityAssetVariantPreference;
  /** Start texture-free before map loading; unlike a later toggle this also skips visual texture setup. */
  ultraLowFidelity?: boolean;
  /** Authoring-only view: load roads but skip city and vegetation assets. Implies Ultra Low materials. */
  roadsOnlyFidelity?: boolean;
  /** Variant manifest URL; defaults to `variants/manifest.json` beside the source manifest. */
  variantManifestUrl?: string;
  /** Required before KTX2 variants can be selected (for example `/basis/`). */
  ktx2TranscoderPath?: string;
}

export interface CameraDiagnostics {
  ready: boolean;
  position: [number, number, number];
  target: [number, number, number];
  groundY: number | null;
  altitudeAgl: number | null;
  minAltitude: number | null;
  maxAltitude: number | null;
  viewDistance: number;
  fov: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; width: number; height: number } | null;
  localBuildingMax: number | null;
  headroom: number | null;
  clamps: { eyeX: boolean; eyeY: boolean; eyeZ: boolean; targetX: boolean; targetY: boolean; targetZ: boolean };
}

export interface FrameTimeCounts {
  over16_7: number;
  over25: number;
  over33_3: number;
  over50: number;
}

export interface FramePhaseStats {
  controlsMsAvg: number;
  streamingMsAvg: number;
  uploadsMsAvg: number;
  renderMsAvg: number;
  integrationMsAvg: number;
}

/** Quality controls that are safe to tune while a map remains loaded. */
export interface CityViewerLiveQuality {
  maxPixelRatio: number;
  maxScreenSpaceError: number;
  vegetationScreenSpaceError: number;
  byteBudget: number;
  uploadBudgetMs: number;
  uploadPixelsPerFrame: number;
  vegetationMaxDistance: number;
  exposure: number;
}

export interface CityViewerStats {
  fps: number;
  frameMsAvg: number;
  frameMsP50: number;
  frameMsP95: number;
  frameMsP99: number;
  frameMsMax: number;
  frameTimeCounts: FrameTimeCounts;
  phases: FramePhaseStats;
  drawCalls: number;
  triangles: number;
  programs: number;
  /** Tiles with at least one resident LOD. */
  residentTiles: number;
  /** Resident (tile, lod) assets across city + vegetation. */
  residentAssets: number;
  residentBytes: number;
  /** Decoded but not yet uploaded/swapped bytes; counts against the budget. */
  pendingBytes: number;
  byteBudget: number;
  /**
   * Outstanding work of any kind: tile fetches, a map load, a preset transition,
   * and the rebuild that follows a lost GPU context. Zero means the scene on
   * screen is the whole scene, which is what capture gates wait for.
   */
  loading: number;
  queued: number;
  /** Assets parsed and waiting on the paced GPU upload. */
  uploading: number;
  jsHeapMB: number | null;
  cameraMode: 'orbit' | 'fly';
  /** True when GPU rendering and scene streaming are bypassed but integrations still tick. */
  renderingSuspended: boolean;
  ultraLowFidelity: boolean;
  roadsOnlyFidelity: boolean;
  /** Road/ground geometry is resident and its layer is visible. */
  roadVisible: boolean;
  /** Latest map/preset streaming failure, including asynchronous mode switches. */
  streamingError: string | null;
  /** Browser UI loop frequency; deliberately not the simulation engine throughput. */
  uiTicksPerSecond: number;
  /** Runtime semantic material classification and shader-application telemetry. */
  surfaceMaterials: import('./surface-materials').SurfaceMaterialReport;
  assetVariants: {
    manifest: boolean;
    loaded: Record<'original' | 'geometry-only' | 'roads-only' | 'ktx2', number>;
    fallbacks: number;
  };
}

export interface BenchResult {
  avgFps: number;
  p50FrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  maxFrameMs: number;
  minFps: number;
  drawCalls: number;
  residentBytes: number;
  frames: number;
  durationMs: number;
  frameTimeCounts: FrameTimeCounts;
  /** Frame pacing while the camera reverses direction and changes pitch/radius. */
  orbit: {
    frames: number;
    durationMs: number;
    p50FrameMs: number;
    p95FrameMs: number;
    p99FrameMs: number;
    maxFrameMs: number;
    over33_3: number;
    over50: number;
  };
  phases: FramePhaseStats;
  /** ISO timestamp makes downloaded benchmark snapshots self-identifying. */
  capturedAt: string;
  renderingSuspended: boolean;
  displayFps: number;
  uiFrameP95Ms: number;
  /** Supplied by an integration benchmark; renderer-only benchmarks leave this null. */
  simulationTicksPerSecond: number | null;
  cpuUtilizationProxy: number;
  ultraLowFidelity: boolean;
  roadsOnlyFidelity: boolean;
}

export interface RendererCapability {
  readonly renderer: string;
  readonly vendor: string;
  readonly webgl2: boolean;
  readonly software: boolean;
}
