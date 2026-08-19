import {
  AgXToneMapping,
  Box3,
  Color,
  DirectionalLight,
  Group,
  MathUtils,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Material, Texture } from 'three';
import { CameraRig, type CameraMode } from './camera-controls';
import type { CameraView } from './camera-controls';
import type { CameraControlPreferences } from './camera-drag';
import { cameraEnvelopeFromBounds, constrainCameraToEnvelope, initialEditorCameraPose } from './camera-envelope';
import { FrameStats, jsHeapMB } from './frame-stats';
import {
  collectResources,
  estimateResourceBytes,
  getGLTFLoader,
} from './gltf';
import { createSun, loadEnvironment } from './environment';
import { GroundIndex, type GroundIndexOptions } from './ground-index';
import { isLowFidelityHiddenHelper, keepInRoadsOnly } from './roads-only';
import { boundsToBox3, normalizeLods, resolveUrl } from './manifest';
import { patchTree, type ShadowPatchOptions } from './materials';
import { SurfaceMaterialRegistry, type SurfaceMaterialProfile } from './surface-materials';
import { UltraLowMaterialCache, type UltraLowLayer } from './ultra-low-materials';
import { ShadowAtlas } from './shadow-atlas';
import { allowsSourceAssetFallback, isCityAssetVariantManifest, selectAssetVariant, type CityAssetVariantManifest } from './asset-variants';
import {
  TileStreamLayer,
  boxOf,
  type EvictionCandidate,
  type PreparedAsset,
  type StreamTileDef,
} from './streaming';
import { buildVegetation, type VegPrototypeGroup } from './vegetation';
import type {
  BenchResult,
  CameraDiagnostics,
  CityManifest,
  CityViewerLiveQuality,
  CityViewerOptions,
  CityViewerStats,
  FramePhaseStats,
  FrameTimeCounts,
  RendererCapability,
  VegetationInstanceFile,
} from './types';

export interface CityViewerLayers {
  city: boolean;
  vegetation: boolean;
}

const DEFAULTS = {
  maxPixelRatio: 2,
  antialias: true,
  /**
   * Pixel threshold for the LOD selector. The Yale Street geometric errors are
   * a 4x chain (4.6 / 18.2 / 72.9 m for a 76 m cell), so at a 1600 px tall
   * buffer this puts LOD0 inside ~23 m, LOD1 inside ~93 m and LOD2 inside
   * ~370 m — which is what keeps the resident set near the byte budget, since
   * LOD here is really texture resolution (2048 -> 256 px) and one LOD0 tile
   * can cost 900 MB of RGBA.
   */
  maxScreenSpaceError: 300,
  /**
   * Vegetation errors in this manifest are ~16x the city's for the same cell,
   * so they need their own threshold or every tree tile would pin to LOD0.
   */
  vegetationScreenSpaceError: 2000,
  /**
   * Estimated GPU bytes. 1.5 GB, not the 2.5 GB the textures would happily
   * fill: Chrome's GPU process on an M-series MacBook kills the tab somewhere
   * above ~2 GB of live RGBA8 + mips, and the in-flight decode queue adds its
   * own copy on top of whatever is already resident.
   */
  byteBudget: 1.5 * 1024 * 1024 * 1024,
  maxConcurrentLoads: 2,
  uploadBudgetMs: 5,
  /** ~one 2048px texture per frame; the pacer stops as soon as this is spent. */
  uploadPixelsPerFrame: 4.2e6,
  environmentUrl: 'env/sky.hdr',
  /**
   * Sun vs sky balance. The baked lightmap only removes *direct* light, so a
   * sky-dominant balance makes the shadows invisible; 5.0 / 0.6 is where the
   * path-traced shadows read at street level without crushing the ambient.
   */
  sunIntensity: 5,
  environmentIntensity: 0.6,
  exposure: 1,
  vegetationMaxDistance: 260,
  shadowAtlasCellSize: 512,
  shadowStrength: 1,
  debugShadowProjection: false,
  cameraBoundsInset: 2,
  assetVariant: 'auto' as const,
  ultraLowFidelity: false,
  roadsOnlyFidelity: false,
  variantManifestUrl: '',
  ktx2TranscoderPath: '',
};

/**
 * Distance bands for vegetation density, and the `lodKeepCounts` row each band
 * uses. Row 1 is skipped on purpose: this dataset ships it identical to row 0,
 * so bands map to rows 0 / 2 / 3 to actually thin the instances out.
 */
const VEG_BAND_DISTANCES = [80, 170];
const VEG_BAND_KEEP_ROW = [0, 2, 3];

const _rayOrigin = new Vector3();
const _down = new Vector3(0, -1, 0);
const _cameraPos = new Vector3();

function smoothStep(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

/** A reversible, multi-angle orbit path expressed in map-span units. */
function benchmarkOrbitPose(progress: number): { angle: number; radius: number; height: number } {
  if (progress < 0.4) {
    const t = smoothStep(progress / 0.4);
    return {
      angle: (-120 + 240 * t) * Math.PI / 180,
      radius: 0.62 - 0.06 * Math.sin(Math.PI * t),
      height: 0.32,
    };
  }
  if (progress < 0.75) {
    const t = smoothStep((progress - 0.4) / 0.35);
    return {
      angle: (120 - 200 * t) * Math.PI / 180,
      radius: 0.5,
      height: 0.22 + 0.2 * Math.sin(Math.PI * t),
    };
  }
  const t = smoothStep((progress - 0.75) / 0.25);
  return {
    angle: (-80 + 115 * t) * Math.PI / 180,
    radius: 0.38 + 0.17 * t,
    height: 0.2 + 0.08 * t,
  };
}

/**
 * Streaming 3D city viewer.
 *
 * Owns the renderer, the scene, both streaming layers (city tiles + vegetation)
 * and the camera rig. Framework free — see `./react` for the React wrapper.
 */
export class CityViewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: CameraRig;

  /** Static road/ground layer, also the ground-sampling target. */
  readonly roadGroup = new Group();
  readonly cityGroup = new Group();
  readonly vegetationGroup = new Group();

  private readonly canvas: HTMLCanvasElement;
  private readonly options: Required<CityViewerOptions>;
  private readonly frameStats = new FrameStats(150);
  private readonly phaseStats = {
    controls: new FrameStats(150),
    streaming: new FrameStats(150),
    uploads: new FrameStats(150),
    render: new FrameStats(150),
    integration: new FrameStats(150),
  };
  private readonly raycaster = new Raycaster();
  private readonly abort = new AbortController();
  private mapLoadQueue: Promise<void> = Promise.resolve();
  private mapLoaded = false;

  private manifest: CityManifest | null = null;
  private variantManifest: CityAssetVariantManifest | null = null;
  private assetBase = '';
  private atlas: ShadowAtlas | null = null;
  private cityLayer: TileStreamLayer | null = null;
  private vegLayer: TileStreamLayer | null = null;
  private roadLayer: TileStreamLayer | null = null;
  private sun: DirectionalLight | null = null;
  private disposeEnvironment: (() => void) | null = null;
  private visualResourcesPromise: Promise<void> | null = null;
  private visualResourcesStarted = false;
  private vegetationData = new Map<string, VegetationInstanceFile>();
  private sceneBox = new Box3();
  private cameraGroundIndex: GroundIndex | null = null;
  private cameraConstraintRefresh = 0;
  private localEnvelopeBounds: Box3 | null = null;
  private localBuildingMax = 0;
  private localGroundY = 0;
  private localHeadroom = 0;
  private localMaxAltitude = 0;
  private readonly cameraClampFlags = {
    eyeX: false, eyeY: false, eyeZ: false,
    targetX: false, targetY: false, targetZ: false,
  };

  private rafHandle = 0;
  private lastFrameTime = 0;
  private lastStreamUpdate = 0;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private benchmarkActive = false;
  private uploadSkips = 0;
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  private fps = 0;
  private renderingSuspended = false;
  private canvasVisibility = '';
  private benchmarkFrameHook: (() => void) | null = null;
  private ultraLowFidelity = false;
  private roadsOnlyFidelity = false;
  private readonly originalMaterials = new Map<Object3D, Material | Material[]>();
  private readonly roadsOnlyVisibility = new Map<Object3D, boolean>();
  private readonly ultraLowVisibility = new Map<Object3D, boolean>();
  private readonly ultraLowMaterials = new UltraLowMaterialCache();
  private savedEnvironment: Scene['environment'] = null;
  private savedBackground: Scene['background'] = null;
  private ultraRefreshCounter = 0;
  private readonly surfaceMaterials = new SurfaceMaterialRegistry();
  private readonly variantLoads = { original: 0, 'geometry-only': 0, 'roads-only': 0, ktx2: 0 };
  private variantFallbacks = 0;
  private assetVariantReloadGeneration = 0;
  private streamingError: string | null = null;
  private mapLoadActive = false;
  private presetTransitions = 0;
  private auxiliaryLoads = 0;
  /**
   * Pending {@link captureReady} calls. Their presence also forces the streaming
   * decision every frame instead of at 10 Hz, so a caller that just moved the
   * camera is never answered from the previous viewpoint's residency.
   */
  private readonly captureWaiters: {
    resolve: () => void;
    reject: (error: Error) => void;
    deadline: number;
  }[] = [];
  /** Consecutive drawn frames that found the scene fully resident. */
  private captureReadyDraws = 0;

  private phaseSnapshot(): FramePhaseStats {
    return {
      controlsMsAvg: this.phaseStats.controls.avg(),
      streamingMsAvg: this.phaseStats.streaming.avg(),
      uploadsMsAvg: this.phaseStats.uploads.avg(),
      renderMsAvg: this.phaseStats.render.avg(),
      integrationMsAvg: this.phaseStats.integration.avg(),
    };
  }

  private frameTimeCounts(stats = this.frameStats): FrameTimeCounts {
    return {
      over16_7: stats.countAbove(16.7),
      over25: stats.countAbove(25),
      over33_3: stats.countAbove(33.3),
      over50: stats.countAbove(50),
    };
  }

  constructor(canvas: HTMLCanvasElement, options: CityViewerOptions = {}) {
    this.canvas = canvas;
    // Explicit undefined must not clobber a default (callers routinely spread
    // partially-filled option objects).
    const provided = Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined),
    ) as CityViewerOptions;
    this.options = { ...DEFAULTS, baseUrl: '', ...provided };
    this.roadsOnlyFidelity = this.options.roadsOnlyFidelity;
    this.ultraLowFidelity = this.options.ultraLowFidelity || this.roadsOnlyFidelity;

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: this.options.antialias,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.options.maxPixelRatio));
    this.renderer.toneMapping = AgXToneMapping;
    this.renderer.toneMappingExposure = this.options.exposure;
    this.renderer.shadowMap.enabled = false; // the city ships baked shadows
    this.renderer.info.autoReset = false;

    this.scene.name = 'city';
    this.scene.background = new Color(0x14181e);
    this.scene.environmentIntensity = this.options.environmentIntensity;
    this.cityGroup.name = 'city-tiles';
    this.vegetationGroup.name = 'vegetation';
    this.roadGroup.name = 'road';
    this.scene.add(this.roadGroup, this.cityGroup, this.vegetationGroup);

    this.camera = new PerspectiveCamera(55, this.aspect(), 0.5, 6000);
    this.camera.position.set(0, 200, 400);
    this.controls = new CameraRig(this.camera, canvas);
    this.controls.setPoseConstraint((camera, target) => this.constrainCameraPose(camera, target));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    this.lastFrameTime = performance.now();
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  private aspect(): number {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    return w / h;
  }

  /** Stable viewpoint API for editors; callers never retain mutable Three.js vectors. */
  captureView(): CameraView {
    return this.controls.getView();
  }

  applyView(view: CameraView): void {
    this.controls.applyView(view);
  }

  private resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.options.maxPixelRatio));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- loading

  loadMap(manifestUrl: string): Promise<void> {
    const load = this.mapLoadQueue.catch(() => undefined).then(async () => {
      if (this.disposed) return;
      if (this.mapLoaded) this.releaseMapResources();
      this.mapLoaded = true;
      this.mapLoadActive = true;
      try {
        await this.loadMapInner(manifestUrl);
      } catch (err) {
        // dispose() aborts every in-flight request; that is not a failure.
        if (this.disposed || (err as { name?: string } | null)?.name === 'AbortError') return;
        throw err;
      } finally {
        this.mapLoadActive = false;
      }
    });
    this.mapLoadQueue = load;
    return load;
  }

  private async loadMapInner(manifestUrl: string): Promise<void> {
    const url = this.options.baseUrl ? resolveUrl(this.options.baseUrl, manifestUrl) : manifestUrl;
    this.assetBase = url.replace(/[^/]*$/, '');
    const manifest = (await fetch(url, { signal: this.abort.signal }).then((r) => {
      if (!r.ok) throw new Error(`manifest ${r.status} ${url}`);
      return r.json();
    })) as CityManifest;
    if (this.disposed) return;
    this.manifest = manifest;
    this.variantManifest = await this.loadVariantManifest();
    if (this.disposed) return;

    this.sceneBox = boundsToBox3(manifest.scene.bounds);
    const center = this.sceneBox.getCenter(new Vector3());
    const size = this.sceneBox.getSize(new Vector3());
    this.frameCamera(center, size);

    const sunDir = manifest.shadowLightmap?.sunDirection ?? [-0.5, -0.6, -0.6];
    this.sun = createSun({
      direction: new Vector3(sunDir[0] ?? -0.5, sunDir[1] ?? -0.6, sunDir[2] ?? -0.6),
      intensity: this.options.sunIntensity,
      target: center,
    });
    this.scene.add(this.sun, this.sun.target);

    this.atlas = new ShadowAtlas(manifest, this.options.shadowAtlasCellSize);

    const visualResourcesPromise = this.ultraLowFidelity ? Promise.resolve() : this.ensureVisualResources();
    if (this.sun) this.sun.visible = !this.ultraLowFidelity;
    // A zero vegetation distance is the preset-level contract for Minimal and
    // Ultra Low. Do not download every instance sidecar merely to hide the
    // resulting layer after the React settings effect runs.
    const vegetationPromise = this.roadsOnlyFidelity || this.options.vegetationMaxDistance <= 0
      ? Promise.resolve()
      : this.loadVegetationInstances(manifest);

    this.createRoadLayer(manifest);
    this.createCityLayer(manifest);
    await vegetationPromise;
    if (this.disposed) return;
    if (!this.roadsOnlyFidelity && this.options.vegetationMaxDistance > 0) this.createVegetationLayer(manifest);

    await visualResourcesPromise;
  }

  private ensureVisualResources(): Promise<void> {
    if (this.visualResourcesPromise) return this.visualResourcesPromise;
    const manifest = this.manifest;
    const atlas = this.atlas;
    if (!manifest || !atlas) return Promise.resolve();
    this.visualResourcesStarted = true;
    const environmentUrl = resolveUrl(this.assetBase, this.options.environmentUrl);
    const environmentPromise = loadEnvironment(this.renderer, this.scene, environmentUrl)
      .then((dispose) => {
        if (this.disposed) dispose();
        else {
          this.disposeEnvironment = dispose;
          if (this.ultraLowFidelity) this.disableEnvironment();
        }
      })
      .catch((err: unknown) => console.error('[city-renderer] environment failed', err));
    this.visualResourcesPromise = Promise.all([
      environmentPromise,
      atlas.load(manifest, this.assetBase, this.abort.signal),
    ]).then(() => undefined);
    return this.visualResourcesPromise;
  }

  /** Neighborhood framing close enough to read houses, roads and actors. */
  private frameCamera(center: Vector3, size: Vector3): void {
    this.updateLocalCameraEnvelope(center.x, center.z);
    const pose = initialEditorCameraPose(
      center,
      size,
      this.localGroundY,
      this.localBuildingMax,
      this.localMaxAltitude || center.y + 45,
    );
    this.controls.minDistance = 3;
    this.controls.maxDistance = pose.maxDistance;
    this.controls.setView(pose.position, pose.target);
  }

  private updateLocalCameraEnvelope(x: number, z: number): void {
    const cached = this.localEnvelopeBounds;
    if (!cached || x < cached.min.x || x > cached.max.x || z < cached.min.z || z > cached.max.z) {
      const tile = this.manifest?.tiles.find((candidate) => {
        const bounds = candidate.bounds;
        return x >= (bounds.min[0] ?? -Infinity) && x <= (bounds.max[0] ?? Infinity)
          && z >= (bounds.min[2] ?? -Infinity) && z <= (bounds.max[2] ?? Infinity);
      });
      this.localEnvelopeBounds = tile ? boundsToBox3(tile.bounds) : this.sceneBox.clone();
    }
    this.localGroundY = this.cameraGroundIndex?.sample(x, z) ?? this.sceneBox.min.y;
    this.localBuildingMax = Math.max(this.localGroundY, this.localEnvelopeBounds?.max.y ?? this.sceneBox.max.y);
    const localHeight = Math.max(0, this.localBuildingMax - this.localGroundY);
    this.localHeadroom = Math.max(6, Math.min(20, localHeight * 0.15));
    this.localMaxAltitude = Math.max(this.localGroundY + 12, this.localBuildingMax + this.localHeadroom);
  }

  private constrainCameraPose(camera: PerspectiveCamera, target: Vector3): void {
    if (!this.cameraPoseConstraintsEnabled) return;
    if (!this.manifest || this.sceneBox.isEmpty()) return;
    // First bring an arbitrary/imported target into the global footprint. This
    // must happen before selecting its local tile envelope; otherwise an
    // out-of-bounds target would cache the whole-city height range forever.
    const coarseFlags = constrainCameraToEnvelope(
      camera,
      target,
      cameraEnvelopeFromBounds(
        this.sceneBox,
        this.options.cameraBoundsInset,
        -Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      ),
    );
    this.updateLocalCameraEnvelope(target.x, target.z);
    const localFlags = constrainCameraToEnvelope(
      camera,
      target,
      cameraEnvelopeFromBounds(
        this.sceneBox,
        this.options.cameraBoundsInset,
        this.localGroundY,
        this.localMaxAltitude,
      ),
    );
    for (const key of Object.keys(this.cameraClampFlags) as (keyof typeof this.cameraClampFlags)[]) {
      this.cameraClampFlags[key] = coarseFlags[key] || localFlags[key];
    }
  }

  private cameraPoseConstraintsEnabled = true;

  /** Sensor rigs may temporarily own the exact physical eye pose below editor navigation limits. */
  setCameraPoseConstraintsEnabled(enabled: boolean): void {
    this.cameraPoseConstraintsEnabled = enabled;
    if (!enabled) {
      for (const key of Object.keys(this.cameraClampFlags) as (keyof typeof this.cameraClampFlags)[]) {
        this.cameraClampFlags[key] = false;
      }
    }
  }

  resetCamera(): void {
    if (!this.manifest || this.sceneBox.isEmpty()) return;
    this.frameCamera(this.sceneBox.getCenter(new Vector3()), this.sceneBox.getSize(new Vector3()));
  }

  getCameraDiagnostics(): CameraDiagnostics {
    const ready = Boolean(this.manifest) && !this.sceneBox.isEmpty();
    const position: [number, number, number] = [this.camera.position.x, this.camera.position.y, this.camera.position.z];
    const target: [number, number, number] = [this.controls.target.x, this.controls.target.y, this.controls.target.z];
    const viewDistance = this.camera.position.distanceTo(this.controls.target);
    if (!ready) {
      return { ready: false, position, target, groundY: null, altitudeAgl: null, minAltitude: null, maxAltitude: null,
        viewDistance, fov: this.camera.fov, bounds: null, localBuildingMax: null, headroom: null,
        clamps: { ...this.cameraClampFlags } };
    }
    this.updateLocalCameraEnvelope(this.controls.target.x, this.controls.target.z);
    return {
      ready: true, position, target,
      groundY: this.localGroundY,
      altitudeAgl: this.camera.position.y - this.localGroundY,
      minAltitude: this.localGroundY + 2,
      maxAltitude: this.localMaxAltitude,
      viewDistance,
      fov: this.camera.fov,
      bounds: { minX: this.sceneBox.min.x, maxX: this.sceneBox.max.x, minZ: this.sceneBox.min.z,
        maxZ: this.sceneBox.max.z, width: this.sceneBox.max.x - this.sceneBox.min.x,
        height: this.sceneBox.max.z - this.sceneBox.min.z },
      localBuildingMax: this.localBuildingMax,
      headroom: this.localHeadroom,
      clamps: { ...this.cameraClampFlags },
    };
  }

  private shadowOptions(box: Box3, fadeFrom: number, fadeTo: number): ShadowPatchOptions {
    const atlas = this.atlas;
    if (!atlas) throw new Error('shadow atlas not ready');
    return {
      atlas: atlas.texture,
      rect: atlas.rect,
      strength: this.options.shadowStrength,
      wallWeight: 0.5,
      debug: this.options.debugShadowProjection,
      fadeStartY: box.min.y + fadeFrom,
      fadeEndY: box.min.y + fadeTo,
    };
  }

  private async fetchBuffer(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.arrayBuffer();
  }

  private async loadVariantManifest(): Promise<CityAssetVariantManifest | null> {
    const relative = this.options.variantManifestUrl || 'variants/manifest.json';
    try {
      const response = await fetch(resolveUrl(this.assetBase, relative), { signal: this.abort.signal });
      if (!response.ok) return null;
      const value: unknown = await response.json();
      return isCityAssetVariantManifest(value) ? value : null;
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
      return null;
    }
  }

  /** Parse an optimized local derivative, then retry source unless Ultra Low forbids textures. */
  private async parseAsset(sourceFile: string, signal: AbortSignal) {
    const declaredKtxPath = this.variantManifest?.variants.ktx2?.runtime?.ktx2TranscoderPath ?? '';
    const ktx2TranscoderPath = this.options.ktx2TranscoderPath
      || (declaredKtxPath ? resolveUrl(this.assetBase, declaredKtxPath) : '');
    const selected = selectAssetVariant(this.variantManifest, sourceFile, this.options.assetVariant, {
      ultraLow: this.ultraLowFidelity,
      roadsOnly: this.roadsOnlyFidelity,
      ktx2Ready: Boolean(ktx2TranscoderPath),
    });
    const requiredVariant = this.roadsOnlyFidelity ? 'roads-only' : this.ultraLowFidelity ? 'geometry-only' : null;
    if (requiredVariant && selected.variant !== requiredVariant) {
      this.canvas.dataset.assetVariant = `${requiredVariant}-unavailable`;
      throw new Error(`${this.roadsOnlyFidelity ? 'Roads Only' : 'Ultra Low'} requires a ${requiredVariant} derivative for ${sourceFile}`);
    }
    const loader = getGLTFLoader(this.renderer, ktx2TranscoderPath);
    try {
      const buffer = await this.fetchBuffer(resolveUrl(this.assetBase, selected.file), signal);
      const parsed = await loader.parseAsync(buffer, '');
      this.variantLoads[selected.variant]++;
      this.canvas.dataset.assetVariant = selected.variant;
      return parsed;
    } catch (error) {
      if (selected.variant === 'roads-only' && selected.fallbackFile
        && (error as { name?: string } | null)?.name !== 'AbortError') {
        const fallback = await this.fetchBuffer(resolveUrl(this.assetBase, selected.fallbackFile), signal);
        const parsed = await loader.parseAsync(fallback, '');
        this.variantFallbacks++;
        this.variantLoads['roads-only']++;
        this.canvas.dataset.assetVariant = 'roads-only-v1-fallback';
        return parsed;
      }
      if (!allowsSourceAssetFallback(selected.variant, this.ultraLowFidelity)
        || (error as { name?: string } | null)?.name === 'AbortError') throw error;
      this.variantFallbacks++;
      const source = await this.fetchBuffer(resolveUrl(this.assetBase, sourceFile), signal);
      const parsed = await loader.parseAsync(source, '');
      this.variantLoads.original++;
      this.canvas.dataset.assetVariant = 'original-fallback';
      return parsed;
    }
  }

  /** Parse a manifest-resolved derivative without running variant selection twice. */
  private async parseResolvedAsset(
    file: string,
    signal: AbortSignal,
    variant: 'geometry-only' | 'roads-only' | 'ktx2',
  ) {
    const declaredKtxPath = this.variantManifest?.variants.ktx2?.runtime?.ktx2TranscoderPath ?? '';
    const ktx2TranscoderPath = this.options.ktx2TranscoderPath
      || (declaredKtxPath ? resolveUrl(this.assetBase, declaredKtxPath) : '');
    const loader = getGLTFLoader(this.renderer, ktx2TranscoderPath);
    const buffer = await this.fetchBuffer(resolveUrl(this.assetBase, file), signal);
    const parsed = await loader.parseAsync(buffer, '');
    this.variantLoads[variant]++;
    this.canvas.dataset.assetVariant = variant;
    return parsed;
  }

  /** Shared per-asset preparation: static matrices, bounds, anisotropy. */
  private prepareTree(root: Object3D): void {
    const maxAnisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    root.matrixAutoUpdate = false;
    root.traverse((obj) => {
      obj.matrixAutoUpdate = false;
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        for (const value of Object.values(mat as unknown as Record<string, unknown>)) {
          const tex = value as Texture | null;
          if (tex && (tex as unknown as { isTexture?: boolean }).isTexture) {
            tex.anisotropy = maxAnisotropy;
          }
        }
      }
    });
    root.updateMatrixWorld(true);
  }

  private createRoadLayer(manifest: CityManifest): void {
    const road = manifest.staticLayers?.find((layer) => layer.id === 'road');
    if (!road) return;
    const geometryBootstrap = selectAssetVariant(this.variantManifest, road.file, 'geometry-only', {
      ultraLow: false, roadsOnly: false, ktx2Ready: false,
    });
    const geometryVariantFile = geometryBootstrap?.variant === 'geometry-only'
      ? this.variantManifest?.variants['geometry-only']?.files[road.file]
      : undefined;
    const progressiveRoad = geometryBootstrap?.variant === 'geometry-only' && geometryVariantFile
      ? [{
          // A texture-free, geometry-identical road is the usable bootstrap.
          // Its deliberately huge error makes the source road the desired
          // refinement as soon as the bootstrap is visible.
          level: -1,
          file: geometryBootstrap.file,
          triangles: road.triangles,
          fileSize: geometryVariantFile.bytes,
          geometricError: Number.MAX_SAFE_INTEGER,
        }, {
          level: 0,
          file: road.file,
          triangles: road.triangles,
          fileSize: road.fileSize,
          geometricError: 0,
        }]
      : [{
          level: 0,
          file: road.file,
          triangles: road.triangles,
          fileSize: road.fileSize,
          geometricError: 0,
        }];
    const def: StreamTileDef = {
      id: 'road',
      box: this.sceneBox.clone(),
      lods: progressiveRoad,
    };
    this.roadLayer = new TileStreamLayer({
      name: 'road-layer',
      renderer: this.renderer,
      scene: this.scene,
      defs: [def],
      maxConcurrent: 1,
      memory: this.memory,
      pinCoarsest: true,
      essentialCoarsest: true,
      essentialAll: true,
      maxDesiredIndex: () => this.ultraLowFidelity ? 0 : progressiveRoad.length - 1,
      build: async (tileDef, lod, signal) => {
        const gltf = lod.level === -1 && !this.ultraLowFidelity
          ? await this.parseResolvedAsset(lod.file, signal, 'geometry-only')
          : await this.parseAsset(road.file, signal);
        const root = gltf.scene;
        root.name = tileDef.id;
        this.prepareTree(root);
        const box = new Box3().setFromObject(root);
        // The road is the ground: it takes the shadow term everywhere, and only
        // the electric towers reaching above ~20 m fade out of it.
        if (this.visualResourcesStarted && !this.ultraLowFidelity) patchTree(root, this.shadowOptions(box, 20, 40));
        this.surfaceMaterials.registerTree(root, 'road');
        const resources = collectResources(root);
        if (this.ultraLowFidelity) this.simplifyTree(root, 'road');
        if (this.roadsOnlyFidelity) this.applyRoadsOnlyVisibility(root);
        return {
          object: root,
          resources,
          bytes: estimateResourceBytes(resources),
          pendingTextures: this.ultraLowFidelity ? [] : [...resources.textures],
          dispose: () => {
            this.surfaceMaterials.unregisterTree(root);
            this.releaseSimplifiedTree(root);
          },
        } satisfies PreparedAsset;
      },
    });
    this.roadGroup.add(this.roadLayer.group);
  }

  private createCityLayer(manifest: CityManifest): void {
    const defs: StreamTileDef[] = manifest.tiles.map((tile) => ({
      id: tile.id,
      box: boxOf(tile.bounds.min, tile.bounds.max),
      lods: normalizeLods(tile.lods),
    }));
    this.cityLayer = new TileStreamLayer({
      name: 'city-layer',
      renderer: this.renderer,
      scene: this.scene,
      defs,
      maxConcurrent: this.options.maxConcurrentLoads,
      memory: this.memory,
      pinCoarsest: true,
      want: () => !this.roadsOnlyFidelity,
      build: async (def, lod, signal) => {
        const gltf = await this.parseAsset(lod.file, signal);
        const root = gltf.scene;
        root.name = `${def.id}.lod${lod.level}`;
        this.prepareTree(root);
        const box = new Box3().setFromObject(root);
        if (this.visualResourcesStarted && !this.ultraLowFidelity) patchTree(root, this.shadowOptions(box, 20, 40));
        this.surfaceMaterials.registerTree(root, 'city');
        const resources = collectResources(root);
        if (this.ultraLowFidelity) this.simplifyTree(root, 'city');
        return {
          object: root,
          resources,
          bytes: estimateResourceBytes(resources),
          pendingTextures: this.ultraLowFidelity ? [] : [...resources.textures],
          dispose: () => {
            this.surfaceMaterials.unregisterTree(root);
            this.releaseSimplifiedTree(root);
          },
        } satisfies PreparedAsset;
      },
    });
    this.cityGroup.add(this.cityLayer.group);
  }

  private async loadVegetationInstances(manifest: CityManifest): Promise<void> {
    const tiles = manifest.vegetationTiles ?? [];
    await Promise.all(
      tiles.map(async (tile) => {
        try {
          const res = await fetch(resolveUrl(this.assetBase, tile.instanceFile), {
            signal: this.abort.signal,
          });
          if (!res.ok) return;
          this.vegetationData.set(tile.id, (await res.json()) as VegetationInstanceFile);
        } catch {
          /* a tile without instance data simply renders no vegetation */
        }
      }),
    );
  }

  private createVegetationLayer(manifest: CityManifest): void {
    if (this.vegLayer) return;
    const tiles = manifest.vegetationTiles ?? [];
    if (tiles.length === 0) return;
    const defs: StreamTileDef[] = tiles
      .filter((tile) => this.vegetationData.has(tile.id))
      .map((tile) => ({
        id: tile.id,
        box: boxOf(tile.bounds.min, tile.bounds.max),
        lods: normalizeLods(tile.lods),
      }));

    this.vegLayer = new TileStreamLayer({
      name: 'vegetation-layer',
      renderer: this.renderer,
      scene: this.scene,
      defs,
      maxConcurrent: 2,
      memory: this.memory,
      pinCoarsest: false,
      want: (_def, distance) => !this.roadsOnlyFidelity && distance <= this.options.vegetationMaxDistance,
      build: async (def, lod, signal) => {
        const data = this.vegetationData.get(def.id);
        if (!data) throw new Error(`no instance data for ${def.id}`);
        const gltf = await this.parseAsset(lod.file, signal);
        this.prepareTree(gltf.scene);
        const built = buildVegetation(gltf.scene, data, VEG_BAND_KEEP_ROW);
        built.object.name = `${def.id}.lod${lod.level}`;
        built.object.userData.prototypes = built.prototypes;
        if (this.visualResourcesStarted && !this.ultraLowFidelity) patchTree(built.object, this.shadowOptions(def.box, 6, 14));
        this.surfaceMaterials.registerTree(built.object, 'vegetation');
        const resources = collectResources(built.object);
        if (this.ultraLowFidelity) this.simplifyTree(built.object, 'vegetation');
        return {
          object: built.object,
          resources,
          bytes: estimateResourceBytes(resources),
          pendingTextures: this.ultraLowFidelity ? [] : [...resources.textures],
          dispose: () => {
            this.surfaceMaterials.unregisterTree(built.object);
            this.releaseSimplifiedTree(built.object);
            for (const proto of built.prototypes) for (const mesh of proto.meshes) mesh.dispose();
            built.object.clear();
          },
        } satisfies PreparedAsset;
      },
      onTick: (_def, asset, distance) => {
        const prototypes = (asset.object.userData.prototypes ?? null) as VegPrototypeGroup[] | null;
        if (!prototypes) return;
        let band = VEG_BAND_DISTANCES.length;
        for (let i = 0; i < VEG_BAND_DISTANCES.length; i++) {
          if (distance <= (VEG_BAND_DISTANCES[i] ?? 0)) {
            band = i;
            break;
          }
        }
        const visible = distance <= this.options.vegetationMaxDistance;
        asset.object.visible = visible;
        if (!visible) return;
        for (const proto of prototypes) {
          const count = proto.keepPerBand[band] ?? proto.keepPerBand[proto.keepPerBand.length - 1];
          for (const mesh of proto.meshes) mesh.count = count ?? mesh.instanceMatrix.count;
        }
      },
    });
    this.vegetationGroup.add(this.vegLayer.group);
  }

  // ------------------------------------------------------------------ frame

  private tick = (): void => {
    if (this.disposed) return;
    this.rafHandle = requestAnimationFrame(this.tick);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    if (!this.cameraGroundIndex && ++this.cameraConstraintRefresh % 60 === 0 && this.roadReady) {
      this.cameraGroundIndex = this.buildGroundIndex();
      this.localEnvelopeBounds = null;
    }

    if (this.ultraLowFidelity && ++this.ultraRefreshCounter % 60 === 0) {
      for (const child of this.scene.children) {
        if (child !== this.cityGroup && child !== this.roadGroup && child !== this.vegetationGroup) {
          this.simplifyTree(child, 'actor');
        }
      }
    }

    let phaseStart = performance.now();
    if (!this.renderingSuspended && !this.benchmarkActive) this.controls.update(dt);
    this.phaseStats.controls.push(performance.now() - phaseStart);

    if (!this.renderingSuspended) {
      this.camera.updateMatrixWorld();
      this.camera.getWorldPosition(_cameraPos);
    }

    // Streaming decisions are cheap but not free: 10 Hz is plenty responsive for
    // interactive navigation. A pending captureReady() needs the decision for the
    // camera as it stands *now*, so it lifts the throttle: otherwise residency
    // counters can still describe the viewpoint of up to 100 ms ago.
    if (!this.renderingSuspended && (this.captureWaiters.length > 0 || now - this.lastStreamUpdate > 100)) {
      phaseStart = performance.now();
      this.lastStreamUpdate = now;
      this.updateStreaming(_cameraPos);
      this.phaseStats.streaming.push(performance.now() - phaseStart);
    } else {
      this.phaseStats.streaming.push(0);
    }
    if (!this.renderingSuspended) this.vegLayer?.tickDisplayed();

    // Adaptive upload backoff: a 2048px texture costs ~30 ms of GPU time on
    // this class of machine, so after a frame that already ran long we skip the
    // pacer entirely and let the pipeline drain instead of stacking stalls.
    // The counter guarantees forward progress if frames stay heavy.
    const ceiling = Math.max(14, this.frameStats.percentile(0.5) * 2);
    phaseStart = performance.now();
    if (!this.renderingSuspended && (dt * 1000 <= ceiling || this.uploadSkips >= 4)) {
      this.uploadSkips = 0;
      const deadline = now + this.options.uploadBudgetMs;
      const pixelBudget = { remaining: this.options.uploadPixelsPerFrame };
      this.roadLayer?.pumpUploads(deadline, pixelBudget, this.camera);
      this.cityLayer?.pumpUploads(deadline, pixelBudget, this.camera);
      this.vegLayer?.pumpUploads(deadline, pixelBudget, this.camera);
    } else {
      this.uploadSkips++;
    }
    this.phaseStats.uploads.push(performance.now() - phaseStart);

    if (!this.renderingSuspended) {
      this.renderer.info.reset();
      phaseStart = performance.now();
      this.renderer.render(this.scene, this.camera);
      this.phaseStats.render.push(performance.now() - phaseStart);
      this.lastDrawCalls = this.renderer.info.render.calls;
      this.lastTriangles = this.renderer.info.render.triangles;
    } else {
      this.phaseStats.render.push(0);
      this.lastDrawCalls = 0;
      this.lastTriangles = 0;
    }

    // Wall-clock frame delta (not just our CPU slice) so the HUD reports what
    // the display actually did, including time lost to the compositor.
    this.frameStats.push(Math.min(1000, dt * 1000));
    this.fps = 1000 / Math.max(0.001, this.frameStats.avg());
    phaseStart = performance.now();
    this.onFrame?.(dt);
    this.phaseStats.integration.push(performance.now() - phaseStart);
    this.benchmarkFrameHook?.();
    if (this.captureWaiters.length > 0) this.settleCaptureWaiters(now);
  };

  /** Optional per-frame hook (used by the benchmark and by integrations). */
  onFrame: ((dt: number) => void) | null = null;

  /**
   * Resolves once every asset the current viewpoint needs is resident and a frame
   * has been drawn from it.
   *
   * This is the whole readiness contract for anything that captures pixels. It
   * exists because every proxy for it is wrong in a way that yields a
   * plausible-looking but wrong artifact:
   *
   * - Tile-layer counters alone miss the map load, which owns the environment IBL
   *   and the baked shadow atlas: a frame drawn before those land shows the whole
   *   city unlit against the clear colour. {@link residency} counts them.
   * - `loading === 0 && uploading === 0` without `queued` reports idle while the
   *   streamer still wants LODs it has not requested yet, and the streaming
   *   decision itself is throttled to 10 Hz, so it can describe the viewpoint of
   *   100 ms ago. A pending call lifts that throttle.
   * - Counting animation frames measures elapsed frames, not delivered assets.
   * - A lost WebGL context leaves every residency counter healthy — resident
   *   tiles, no pending work, no streaming error — while the renderer draws
   *   nothing at all, so only the context itself can report it.
   *
   * Readiness is asserted on two consecutive drawn frames. The first proves the
   * scene was complete when it was drawn; the second proves that frame reached
   * the compositor, which is what a screenshot reads.
   *
   * Rejects with the blocking reason if the deadline passes, so a caller reports
   * the cause instead of a byte count.
   */
  captureReady(timeoutMs = 120_000): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('renderer is not capture-ready: viewer disposed'));
    // Frames drawn before this call saw the caller's previous scene mutation, so
    // they cannot count towards this request.
    this.captureReadyDraws = 0;
    // Executor form: the project's TypeScript lib target predates
    // Promise.withResolvers, and the resolvers must outlive this call.
    return new Promise<void>((resolve, reject) => {
      this.captureWaiters.push({ resolve, reject, deadline: performance.now() + timeoutMs });
    });
  }

  /** Why the scene cannot be captured right now, or `null` when it can. */
  private captureBlocker(): string | null {
    if (this.renderingSuspended) return 'rendering is suspended';
    if (this.renderer.getContext().isContextLost()) return 'WebGL context is lost';
    if (this.streamingError) return `streaming failed: ${this.streamingError}`;
    if (!this.roadReady) return 'road layer has no geometry';
    const { residentTiles, loading, queued, uploading } = this.residency();
    if (residentTiles === 0) return 'no tiles are resident';
    if (loading + queued + uploading > 0) {
      return `renderer is still loading (${loading} loading, ${queued} queued, ${uploading} uploading)`;
    }
    return null;
  }

  private settleCaptureWaiters(now: number): void {
    const blocker = this.captureBlocker();
    if (blocker === null) {
      this.captureReadyDraws += 1;
      if (this.captureReadyDraws < 2) return;
      for (const waiter of this.captureWaiters.splice(0, this.captureWaiters.length)) waiter.resolve();
      return;
    }
    this.captureReadyDraws = 0;
    for (let i = this.captureWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.captureWaiters[i]!;
      if (now < waiter.deadline) continue;
      this.captureWaiters.splice(i, 1);
      waiter.reject(new Error(`renderer is not capture-ready: ${blocker}`));
    }
  }

  private updateStreaming(cameraPos: Vector3): void {
    const height = this.renderer.domElement.height || 1;
    const sseScale = height / (2 * Math.tan(MathUtils.degToRad(this.camera.fov) / 2));
    this.roadLayer?.update(cameraPos, sseScale, this.options.maxScreenSpaceError);
    this.cityLayer?.update(cameraPos, sseScale, this.options.maxScreenSpaceError);
    this.vegLayer?.update(cameraPos, sseScale, this.options.vegetationScreenSpaceError);
    this.enforceBudget();
  }

  /**
   * Shared ledger for both layers. In-flight decodes count against the budget
   * too — a parsed-but-not-yet-uploaded LOD0 tile holds its whole texture set
   * as ImageBitmaps, and three concurrent ones are what took the tab down
   * before this existed.
   */
  private readonly memory = {
    admit: (bytes: number, priority: number): boolean => {
      const budget = this.options.byteBudget;
      if (this.totalBytes() + bytes <= budget) return true;
      return this.freeSpace(budget - bytes, priority);
    },
    maxAssetBytes: (): number => this.options.byteBudget * 0.45,
  };

  private enforceBudget(): void {
    this.freeSpace(this.options.byteBudget, Infinity);
  }

  /**
   * Evicts until `this.totalBytes() <= limit`, touching only assets that score
   * worse than `priority`. Returns whether the limit was reached.
   */
  private freeSpace(limit: number, priority: number): boolean {
    let total = this.totalBytes();
    if (total <= limit) return true;
    const candidates: EvictionCandidate[] = [];
    this.cityLayer?.evictionCandidates(candidates);
    this.vegLayer?.evictionCandidates(candidates);
    // Worst score first: out-of-range tiles, then overshoot, then distance.
    candidates.sort((a, b) => b.score - a.score);
    for (const candidate of candidates) {
      if (total <= limit) break;
      if (candidate.score <= priority) break; // nothing cheaper left to give up
      total -= candidate.layer.evict(candidate);
    }
    return total <= limit;
  }

  private residentBytes(): number {
    return (
      (this.cityLayer?.residentBytes ?? 0) +
      (this.vegLayer?.residentBytes ?? 0) +
      (this.roadLayer?.residentBytes ?? 0)
    );
  }

  private totalBytes(): number {
    return (
      this.residentBytes() +
      (this.cityLayer?.pendingBytes ?? 0) +
      (this.vegLayer?.pendingBytes ?? 0) +
      (this.roadLayer?.pendingBytes ?? 0)
    );
  }

  /**
   * Streaming residency, summed over the tile layers in one pass. The single
   * definition of "work still in flight": `loading` deliberately counts the map
   * load itself, which owns the environment IBL and the baked shadow atlas that
   * no tile-layer counter sees, and a frame drawn before those land renders the
   * whole city unlit.
   */
  private residency(): {
    residentTiles: number;
    residentAssets: number;
    loading: number;
    queued: number;
    uploading: number;
  } {
    let residentTiles = 0;
    let residentAssets = 0;
    let loading = Number(this.mapLoadActive) + this.presetTransitions + this.auxiliaryLoads;
    let queued = 0;
    let uploading = 0;
    for (const layer of [this.cityLayer, this.vegLayer, this.roadLayer]) {
      if (!layer) continue;
      const stats = layer.stats();
      residentTiles += stats.residentTiles;
      residentAssets += stats.residentAssets;
      loading += stats.loading;
      queued += stats.queued;
      uploading += stats.uploading;
    }
    return { residentTiles, residentAssets, loading, queued, uploading };
  }

  // ------------------------------------------------------------- public API

  getStats(): CityViewerStats {
    return {
      fps: this.fps,
      frameMsAvg: this.frameStats.avg(),
      frameMsP50: this.frameStats.percentile(0.5),
      frameMsP95: this.frameStats.percentile(0.95),
      frameMsP99: this.frameStats.percentile(0.99),
      frameMsMax: this.frameStats.max(),
      frameTimeCounts: this.frameTimeCounts(),
      phases: this.phaseSnapshot(),
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
      programs: this.renderer.info.programs?.length ?? 0,
      ...this.residency(),
      residentBytes: this.residentBytes(),
      pendingBytes: this.totalBytes() - this.residentBytes(),
      byteBudget: this.options.byteBudget,
      jsHeapMB: jsHeapMB(),
      cameraMode: this.controls.mode,
      renderingSuspended: this.renderingSuspended,
      ultraLowFidelity: this.ultraLowFidelity,
      roadsOnlyFidelity: this.roadsOnlyFidelity,
      roadVisible: this.roadReady && this.roadGroup.visible,
      streamingError: this.streamingError,
      uiTicksPerSecond: this.fps,
      surfaceMaterials: this.surfaceMaterials.report(),
      assetVariants: { manifest: Boolean(this.variantManifest), loaded: { ...this.variantLoads }, fallbacks: this.variantFallbacks },
    };
  }

  /**
   * Suspend the complete visual pipeline while keeping requestAnimationFrame and
   * `onFrame` alive for simulation, timeline and metrics consumers.
   */
  setRenderingSuspended(suspended: boolean): void {
    if (suspended === this.renderingSuspended) return;
    this.renderingSuspended = suspended;
    if (suspended) {
      this.canvasVisibility = this.canvas.style.visibility;
      this.canvas.style.visibility = 'hidden';
      this.controls.setEnabled(false);
      this.lastDrawCalls = 0;
      this.lastTriangles = 0;
    } else {
      this.canvas.style.visibility = this.canvasVisibility;
      this.controls.setEnabled(true);
      this.lastStreamUpdate = 0;
      this.frameStats.reset();
    }
  }

  get isRenderingSuspended(): boolean {
    return this.renderingSuspended;
  }

  getLiveQuality(): CityViewerLiveQuality {
    const {
      maxPixelRatio,
      maxScreenSpaceError,
      vegetationScreenSpaceError,
      byteBudget,
      uploadBudgetMs,
      uploadPixelsPerFrame,
      vegetationMaxDistance,
      exposure,
    } = this.options;
    return {
      maxPixelRatio,
      maxScreenSpaceError,
      vegetationScreenSpaceError,
      byteBudget,
      uploadBudgetMs,
      uploadPixelsPerFrame,
      vegetationMaxDistance,
      exposure,
    };
  }

  getRendererCapability(): RendererCapability {
    const gl = this.renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number; UNMASKED_VENDOR_WEBGL: number } | null;
    const renderer = String(gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) ?? 'unknown');
    const vendor = String(gl.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR) ?? 'unknown');
    const identity = `${renderer} ${vendor}`.toLowerCase();
    return {
      renderer,
      vendor,
      webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
      software: /swiftshader|llvmpipe|software|basic render|mesa offscreen/.test(identity),
    };
  }

  /** Swap expensive PBR/textured materials for shared unlit colors, reversibly. */
  setUltraLowFidelity(enabled: boolean): void {
    this.setFidelityModes(enabled, this.roadsOnlyFidelity);
  }

  /**
   * Keep only authoring-critical roads, signal infrastructure and editor content.
   * Roads Only implies the existing texture-free Ultra Low treatment, but is a
   * distinct persisted preset and never changes saved Ultra Low preferences.
   */
  setRoadsOnlyFidelity(enabled: boolean): void {
    this.setFidelityModes(this.ultraLowFidelity, enabled);
  }

  /** Atomically change related modes so one preference switch causes one asset reset. */
  setAuthoringFidelity(modes: { ultraLow: boolean; roadsOnly: boolean }): void {
    this.setFidelityModes(modes.ultraLow, modes.roadsOnly);
  }

  private setFidelityModes(requestedUltraLow: boolean, roadsOnly: boolean): void {
    const enabled = requestedUltraLow || roadsOnly;
    const ultraChanged = enabled !== this.ultraLowFidelity;
    const roadsChanged = roadsOnly !== this.roadsOnlyFidelity;
    if (!ultraChanged && !roadsChanged) return;
    this.ultraLowFidelity = enabled;
    this.roadsOnlyFidelity = roadsOnly;
    this.streamingError = null;
    if (ultraChanged && enabled) {
      this.simplifyTree(this.cityGroup, 'city');
      this.simplifyTree(this.roadGroup, 'road');
      // Actors and editor helpers are scene children outside the map groups.
      for (const child of this.scene.children) {
        if (child !== this.cityGroup && child !== this.roadGroup && child !== this.vegetationGroup) {
          this.simplifyTree(child, 'actor');
        }
      }
      this.disableEnvironment();
      if (this.sun) this.sun.visible = false;
      this.vegetationGroup.visible = false;
    } else if (ultraChanged) {
      for (const [object, material] of this.originalMaterials) {
        const mesh = object as Mesh;
        if (mesh.isMesh) mesh.material = material;
      }
      this.originalMaterials.clear();
      for (const [object, visible] of this.ultraLowVisibility) object.visible = visible;
      this.ultraLowVisibility.clear();
      this.scene.environment = this.savedEnvironment;
      this.scene.background = this.savedBackground ?? new Color(0x14181e);
      if (this.sun) this.sun.visible = true;
      if (!this.visualResourcesStarted) {
        void this.ensureVisualResources().then(() => {
          if (!this.disposed && !this.ultraLowFidelity && this.variantManifest?.variants['geometry-only']) {
            void this.runPresetTransition(() => this.reloadAssetVariant());
          }
        });
        // The pending visual-resource callback performs the variant reload.
        this.applyRoadsOnlyMode();
        return;
      }
    }
    this.applyRoadsOnlyMode();
    if (ultraChanged && this.variantManifest?.variants['geometry-only']) {
      void this.runPresetTransition(() => this.reloadAssetVariant());
    } else if (roadsChanged) {
      void this.runPresetTransition(() => this.reloadRoadsOnlyLayers());
    }
  }

  private async runPresetTransition(operation: () => Promise<void>): Promise<void> {
    this.presetTransitions++;
    try {
      await operation();
    } catch (error) {
      this.recordStreamingError(error);
    } finally {
      this.presetTransitions = Math.max(0, this.presetTransitions - 1);
    }
  }

  private recordStreamingError(error: unknown): void {
    if (this.disposed || (error as { name?: string } | null)?.name === 'AbortError') return;
    this.streamingError = error instanceof Error ? error.message : String(error);
    console.error('[city-renderer] preset transition failed', error);
  }

  private applyRoadsOnlyMode(): void {
    if (this.roadsOnlyFidelity) {
      this.cityGroup.visible = false;
      this.vegetationGroup.visible = false;
      this.applyRoadsOnlyVisibility(this.roadGroup);
      return;
    }
    for (const [object, visible] of this.roadsOnlyVisibility) object.visible = visible;
    this.roadsOnlyVisibility.clear();
    this.cityGroup.visible = true;
    void this.ensureVegetationLayer();
  }

  private async ensureVegetationLayer(): Promise<void> {
    if (this.vegLayer || !this.manifest || this.roadsOnlyFidelity || this.disposed
      || this.options.vegetationMaxDistance <= 0) return;
    this.auxiliaryLoads++;
    try {
      await this.loadVegetationInstances(this.manifest);
      if (this.vegLayer || this.roadsOnlyFidelity || this.disposed) return;
      this.createVegetationLayer(this.manifest);
      this.lastStreamUpdate = 0;
    } finally {
      this.auxiliaryLoads = Math.max(0, this.auxiliaryLoads - 1);
    }
  }

  private applyRoadsOnlyVisibility(root: Object3D): void {
    root.traverse((object) => {
      const mesh = object as Mesh;
      const hide = mesh.isMesh && !keepInRoadsOnly(mesh);
      if (!hide) return;
      if (!this.roadsOnlyVisibility.has(object)) this.roadsOnlyVisibility.set(object, object.visible);
      object.visible = false;
    });
  }

  private async reloadRoadsOnlyLayers(): Promise<void> {
    const generation = ++this.assetVariantReloadGeneration;
    const view = this.captureView();
    // The road itself switches between geometry-only and the pruned roads-only
    // derivative, so reset it alongside excluded optional layers.
    const layers = [this.roadLayer, this.cityLayer, this.vegLayer].filter(
      (layer): layer is TileStreamLayer => layer !== null,
    );
    await Promise.all(layers.map((layer) => layer.resetAssets()));
    if (this.disposed || generation !== this.assetVariantReloadGeneration) return;
    this.applyView(view);
    this.lastStreamUpdate = 0;
    this.camera.getWorldPosition(_cameraPos);
    this.updateStreaming(_cameraPos);
  }

  private async reloadAssetVariant(): Promise<void> {
    const generation = ++this.assetVariantReloadGeneration;
    const view = this.captureView();
    const layers = [this.roadLayer, this.cityLayer, this.vegLayer].filter(
      (layer): layer is TileStreamLayer => layer !== null,
    );
    await Promise.all(layers.map((layer) => layer.resetAssets()));
    if (this.disposed || generation !== this.assetVariantReloadGeneration) return;
    // Asset variants are a rendering-quality choice. Keep the editor viewpoint
    // byte-for-byte stable while the streamed scene graph is rebuilt.
    this.applyView(view);
    this.lastStreamUpdate = 0;
    this.camera.getWorldPosition(_cameraPos);
    this.updateStreaming(_cameraPos);
  }

  get isUltraLowFidelity(): boolean {
    return this.ultraLowFidelity;
  }

  get isRoadsOnlyFidelity(): boolean {
    return this.roadsOnlyFidelity;
  }

  /** Select a reversible, visual-only material treatment for streamed map surfaces. */
  setSurfaceMaterialProfile(profile: SurfaceMaterialProfile): ReturnType<SurfaceMaterialRegistry['report']> {
    return this.surfaceMaterials.apply(profile);
  }

  getSurfaceMaterialReport(): ReturnType<SurfaceMaterialRegistry['report']> {
    return this.surfaceMaterials.report();
  }

  private simplifyTree(root: Object3D, layer: UltraLowLayer): void {
    if (layer === 'actor') {
      root.traverse((object) => {
        if (!isLowFidelityHiddenHelper(object)) return;
        if (!this.ultraLowVisibility.has(object)) this.ultraLowVisibility.set(object, object.visible);
        object.visible = false;
      });
    }
    this.ultraLowMaterials.apply(root, layer, this.originalMaterials);
  }

  private releaseSimplifiedTree(root: Object3D): void {
    root.traverse((object) => {
      this.originalMaterials.delete(object);
      this.roadsOnlyVisibility.delete(object);
      this.ultraLowVisibility.delete(object);
    });
  }

  private disableEnvironment(): void {
    if (this.scene.environment) this.savedEnvironment = this.scene.environment;
    if (this.scene.background) this.savedBackground = this.scene.background;
    this.scene.environment = null;
    this.scene.background = new Color(0x171c22);
  }

  /** Apply authoring quality without rebuilding the renderer or reloading the map. */
  setLiveQuality(next: Partial<CityViewerLiveQuality>): CityViewerLiveQuality {
    const finite = (value: number | undefined, fallback: number, min: number, max: number) =>
      value === undefined || !Number.isFinite(value)
        ? fallback
        : Math.min(max, Math.max(min, value));
    this.options.maxPixelRatio = finite(next.maxPixelRatio, this.options.maxPixelRatio, 0.5, 3);
    this.options.maxScreenSpaceError = finite(
      next.maxScreenSpaceError,
      this.options.maxScreenSpaceError,
      25,
      5000,
    );
    this.options.vegetationScreenSpaceError = finite(
      next.vegetationScreenSpaceError,
      this.options.vegetationScreenSpaceError,
      100,
      10000,
    );
    const previousByteBudget = this.options.byteBudget;
    const previousVegetationDistance = this.options.vegetationMaxDistance;
    this.options.byteBudget = finite(next.byteBudget, this.options.byteBudget, 256e6, 4e9);
    this.options.uploadBudgetMs = finite(
      next.uploadBudgetMs,
      this.options.uploadBudgetMs,
      0.25,
      20,
    );
    this.options.uploadPixelsPerFrame = finite(
      next.uploadPixelsPerFrame,
      this.options.uploadPixelsPerFrame,
      128e3,
      16.8e6,
    );
    this.options.vegetationMaxDistance = finite(
      next.vegetationMaxDistance,
      this.options.vegetationMaxDistance,
      0,
      2000,
    );
    this.options.exposure = finite(next.exposure, this.options.exposure, 0.1, 4);
    if (this.options.byteBudget !== previousByteBudget) {
      this.roadLayer?.clearBudgetBlocks();
      this.cityLayer?.clearBudgetBlocks();
      this.vegLayer?.clearBudgetBlocks();
    }
    if (previousVegetationDistance <= 0 && this.options.vegetationMaxDistance > 0) {
      void this.ensureVegetationLayer();
    }
    this.renderer.toneMappingExposure = this.options.exposure;
    this.resize();
    this.camera.getWorldPosition(_cameraPos);
    this.updateStreaming(_cameraPos);
    return this.getLiveQuality();
  }

  setCameraMode(mode: CameraMode): void {
    this.controls.setMode(mode);
  }

  setCameraControlPreferences(preferences: CameraControlPreferences): void {
    this.controls.setControlPreferences(preferences);
  }

  toggleCameraMode(): CameraMode {
    return this.controls.toggleMode();
  }

  setLayerVisible(layer: keyof CityViewerLayers | 'road', visible: boolean): void {
    if (layer === 'city') this.cityGroup.visible = this.roadsOnlyFidelity ? false : visible;
    else if (layer === 'vegetation') this.vegetationGroup.visible = this.roadsOnlyFidelity ? false : visible;
    else this.roadGroup.visible = visible;
  }

  setExposure(exposure: number): void {
    this.options.exposure = exposure;
    this.renderer.toneMappingExposure = exposure;
  }

  /**
   * Ground height under a world XZ, or null if nothing is there.
   *
   * Rays are cast downward against the road layer first (it is the actual
   * ground surface and always resident) and fall back to the city tiles for
   * points that sit on a plaza or a building. This is the hook lane overlays
   * will drape on.
   */
  sampleGroundHeight(x: number, z: number): number | null {
    const top = this.sceneBox.max.y + 50;
    _rayOrigin.set(x, top, z);
    this.raycaster.set(_rayOrigin, _down);
    this.raycaster.far = top - this.sceneBox.min.y + 200;
    const targets: Object3D[] = [];
    if (this.roadLayer) targets.push(this.roadLayer.group);
    if (this.cityLayer) targets.push(this.cityLayer.group);
    if (targets.length === 0) return null;
    const hits = this.raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
      if (hit.object.visible) return hit.point.y;
    }
    return null;
  }

  /** True once the road layer has geometry, i.e. ground sampling can work. */
  get roadReady(): boolean {
    let found = false;
    this.roadGroup.traverse((obj) => {
      if (!found && (obj as Mesh).isMesh) found = true;
    });
    return found;
  }

  /**
   * Bake the road layer into a {@link GroundIndex} for bulk height queries.
   *
   * {@link sampleGroundHeight} is the right tool for one-off picks; it is ~9.5 ms
   * a call on Yale Street, so anything draping thousands of points (lane
   * overlays, actor placement, path snapping) wants this instead — ~30 ms to
   * build, ~0.2 µs a query, and identical answers over the road surface.
   *
   * The result is a snapshot. The road layer is pinned with a single LOD so it
   * never changes after load, but callers must wait for {@link roadReady};
   * building early returns `null`.
   *
   * Street furniture baked into the road glTF (mast arms, lamp posts, signal
   * heads, insulators — 783 of Yale Street's 807 road meshes) is filtered out
   * by `isGroundSurfaceMesh`; without that, anything draped under a lamp post
   * drapes onto the lamp. Pass `meshFilter` to override.
   */
  buildGroundIndex(options?: GroundIndexOptions): GroundIndex | null {
    const index = GroundIndex.build(this.roadGroup, options);
    if (index) return index;
    // The filter matched nothing. That means this map does not export its
    // ground as large sheets, not that it has no ground — an unfiltered index
    // is far better than none.
    return GroundIndex.build(this.roadGroup, { ...options, meshFilter: () => true });
  }

  /**
   * Return the reusable road/ground height index, building it once on demand.
   * Editor overlays and actor placement use this instead of repeating expensive
   * whole-scene raycasts for every sampled point.
   */
  getGroundIndex(): GroundIndex | null {
    if (this.cameraGroundIndex) return this.cameraGroundIndex;
    this.cameraGroundIndex = this.buildGroundIndex();
    if (this.cameraGroundIndex) this.localEnvelopeBounds = null;
    return this.cameraGroundIndex;
  }

  /** Exercise reversible multi-angle editor orbits and report frame pacing. */
  async runBenchmark(durationMs = 15000): Promise<BenchResult> {
    const center = this.sceneBox.getCenter(new Vector3());
    const size = this.sceneBox.getSize(new Vector3());
    const span = Math.max(size.x, size.z);
    const savedPosition = this.camera.position.clone();
    const savedTarget = this.controls.target.clone();
    const savedMode = this.controls.mode;
    const benchmarkPosition = new Vector3();

    this.benchmarkActive = true;
    this.controls.setEnabled(false);
    for (const phase of Object.values(this.phaseStats)) phase.reset();
    const stats = new FrameStats(Math.ceil(durationMs / 4));
    const start = performance.now();
    let frames = 0;
    let worstFrameMs = 0;
    let drawCallTotal = 0;
    let last = start;

    await new Promise<void>((resolve) => {
      this.benchmarkFrameHook = () => {
        const now = performance.now();
        const elapsed = now - start;
        const frameMs = now - last;
        last = now;
        if (frames > 2) {
          stats.push(frameMs);
          worstFrameMs = Math.max(worstFrameMs, frameMs);
          drawCallTotal += this.lastDrawCalls;
        }
        frames++;

        const t = Math.min(1, elapsed / durationMs);
        const pose = benchmarkOrbitPose(t);
        benchmarkPosition.set(
          center.x + Math.cos(pose.angle) * span * pose.radius,
          center.y + span * pose.height,
          center.z + Math.sin(pose.angle) * span * pose.radius,
        );
        this.controls.setView(benchmarkPosition, center);
        if (elapsed >= durationMs) resolve();
      };
    });

    this.benchmarkFrameHook = null;
    this.benchmarkActive = false;
    this.controls.setEnabled(!this.renderingSuspended);
    this.controls.setMode(savedMode);
    this.controls.setView(savedPosition, savedTarget);

    const durationSeconds = (performance.now() - start) / 1000;
    const phases = this.phaseSnapshot();
    const phaseMs = phases.controlsMsAvg + phases.streamingMsAvg + phases.uploadsMsAvg + phases.renderMsAvg + phases.integrationMsAvg;
    return {
      avgFps: frames / durationSeconds,
      p50FrameMs: stats.percentile(0.5),
      p95FrameMs: stats.percentile(0.95),
      p99FrameMs: stats.percentile(0.99),
      maxFrameMs: worstFrameMs,
      minFps: worstFrameMs > 0 ? 1000 / worstFrameMs : 0,
      drawCalls: frames > 3 ? Math.round(drawCallTotal / (frames - 3)) : this.lastDrawCalls,
      residentBytes: this.residentBytes(),
      frames,
      durationMs: durationSeconds * 1000,
      frameTimeCounts: this.frameTimeCounts(stats),
      orbit: {
        frames: stats.count,
        durationMs: durationSeconds * 1000,
        p50FrameMs: stats.percentile(0.5),
        p95FrameMs: stats.percentile(0.95),
        p99FrameMs: stats.percentile(0.99),
        maxFrameMs: stats.max(),
        over33_3: stats.countAbove(33.3),
        over50: stats.countAbove(50),
      },
      phases,
      capturedAt: new Date().toISOString(),
      renderingSuspended: this.renderingSuspended,
      displayFps: frames / durationSeconds,
      uiFrameP95Ms: stats.percentile(0.95),
      simulationTicksPerSecond: null,
      cpuUtilizationProxy: Math.min(100, 100 * phaseMs / Math.max(0.001, stats.avg())),
      ultraLowFidelity: this.ultraLowFidelity,
      roadsOnlyFidelity: this.roadsOnlyFidelity,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafHandle);
    // The frame loop is gone, so nothing would ever settle a pending capture.
    for (const waiter of this.captureWaiters.splice(0, this.captureWaiters.length)) {
      waiter.reject(new Error('renderer is not capture-ready: viewer disposed'));
    }
    this.abort.abort();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.controls.dispose();
    this.canvas.style.visibility = this.canvasVisibility;
    const layers = [this.cityLayer, this.vegLayer, this.roadLayer].filter(
      (layer): layer is TileStreamLayer => layer !== null,
    );
    for (const layer of layers) layer.dispose();
    this.atlas?.dispose();
    this.disposeEnvironment?.();
    this.vegetationData.clear();
    this.surfaceMaterials.dispose();
    if (this.sun) this.scene.remove(this.sun, this.sun.target);
    this.scene.clear();
    // Three's compileAsync() owns an internal requestAnimationFrame readiness
    // poll and offers no cancellation API. Disposing WebGLRenderer first clears
    // the material program table underneath that poll, producing
    // `currentProgram is undefined` / `isReady` page errors on cross-map swaps.
    // The stream layers already refuse all new work once disposed, so keep only
    // the old renderer alive until the finite set of in-flight polls settles.
    void Promise.all(layers.map((layer) => layer.whenCompilationIdle())).then(() => {
      this.renderer.dispose();
      this.ultraLowMaterials.dispose();
    });
  }

  private releaseMapResources(): void {
    const layers = [this.cityLayer, this.vegLayer, this.roadLayer].filter(
      (layer): layer is TileStreamLayer => layer !== null,
    );
    for (const layer of layers) layer.dispose();
    this.cityLayer = null;
    this.vegLayer = null;
    this.roadLayer = null;
    this.cityGroup.clear();
    this.vegetationGroup.clear();
    this.roadGroup.clear();
    this.atlas?.dispose();
    this.atlas = null;
    this.disposeEnvironment?.();
    this.disposeEnvironment = null;
    this.visualResourcesPromise = null;
    this.visualResourcesStarted = false;
    if (this.sun) this.scene.remove(this.sun, this.sun.target);
    this.sun = null;
    this.vegetationData.clear();
    this.manifest = null;
    this.variantManifest = null;
    this.cameraGroundIndex = null;
    this.localEnvelopeBounds = null;
    this.lastStreamUpdate = 0;
  }
}
