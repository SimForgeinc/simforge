import * as THREE from 'three/webgpu';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { pass } from 'three/tsl';
import GTAONode from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { DEFAULT_FOV, DEFAULT_NEAR_PLANE, DEFAULT_FAR_PLANE } from '../constants';
import type { QualitySettings } from '../quality';
import { loadVisualConfig, type ToneMappingAlgorithm } from '../visual-config';
import { sunPositionFrom } from './sun-position';
import type { BudgetLedger } from '../streaming/budget-ledger';

// PMREMGenerator output: 128×128×6 cubemap + mipmap chain at RGBA HalfFloat
// (8 bytes/pixel). 128² × 6 × 8 × 4/3 ≈ 1.05 MB. Three.js does not expose the
// exact figure, so this is a fixed estimate good to a few hundred KB.
const IBL_PMREM_BYTES_ESTIMATE = Math.round(128 * 128 * 6 * 8 * (4 / 3));

// Per-pixel cost of the post-processing render-target chain at the current
// drawing-buffer size. Mirrors the per-frame estimate in
// `estimateRenderTargetBytes` and `memory-profiler` so the ledger and the
// profiler agree on what the post-processing pipeline costs.
const POST_PROCESSING_BYTES_PER_PIXEL = 21;

const LEDGER_KEY_SHADOW = 'shadow:directional';
const LEDGER_KEY_IBL = 'ibl:envMap';
const LEDGER_KEY_POST_PROCESSING = 'rt:post-processing';

/**
 * GTAONode subclass that renders at half the screen resolution.
 */
class HalfResGTAONode extends GTAONode {
  setSize(width: number, height: number): void {
    super.setSize(Math.floor(width / 2), Math.floor(height / 2));
  }
}

function toneMappingFor(algorithm: ToneMappingAlgorithm): THREE.ToneMapping {
  switch (algorithm) {
    case 'Linear':
      return THREE.LinearToneMapping;
    case 'Reinhard':
      return THREE.ReinhardToneMapping;
    case 'Cineon':
      return THREE.CineonToneMapping;
    case 'ACES':
    default:
      return THREE.ACESFilmicToneMapping;
  }
}

/**
 * Live-mutable handles the visual-config HUD subscribes to so the LIVE knobs
 * (issue #03) can mutate uniforms / property values without a renderer rebuild.
 * Returned by `CityRenderer.getLiveHandles()`.
 */
export interface LiveRenderHandles {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  ambient: THREE.AmbientLight;
  hemi: THREE.HemisphereLight;
  gtaoNode: InstanceType<typeof GTAONode> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Three.js TSL denoise node has no exported type
  denoiseNode: any | null;
}

export class CityRenderer {
  renderer!: THREE.WebGPURenderer;
  scene!: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  sun!: THREE.DirectionalLight;
  ambient!: THREE.AmbientLight;
  hemi!: THREE.HemisphereLight;
  clock = new THREE.Clock();
  private envTexture: THREE.Texture | null = null;
  private postProcessing: THREE.PostProcessing | null = null;
  private gtaoNode: InstanceType<typeof GTAONode> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Three.js TSL denoise node has no exported type
  private denoiseNode: any | null = null;
  private aoEnabled = true;
  private quality!: QualitySettings;
  // Optional ledger; wired by the orchestrator (#08). When set, shadow / IBL /
  // post-processing allocations register themselves so the reconciliation
  // poller does not see them as silent drift on the first 3-second tick.
  private ledger: BudgetLedger | null = null;
  // Idempotency guard for dispose() (issue #17). StrictMode can call dispose()
  // twice; subsequent calls must be no-ops. Also avoids the WebGPU-device-lost
  // re-entrancy race when dispose() runs after a frame already failed.
  private _disposed = false;

  setBudgetLedger(ledger: BudgetLedger | null): void {
    this.ledger = ledger;
  }

  async init(canvas: HTMLCanvasElement, quality: QualitySettings): Promise<void> {
    this.quality = quality;
    const config = loadVisualConfig();
    const c = config.central;

    this.renderer = new THREE.WebGPURenderer({
      canvas,
      // Disable hardware MSAA when post-processing is active — the SMAA
      // pass provides AA, and MSAA causes the WebGPU backend to produce a
      // multisampled render target that the PassNode can't resolve, resulting
      // in a black screen.
      antialias: quality.antialias && !(quality.postProcessing && c.postProcessingEnabled),
      powerPreference: 'high-performance',
      ...(quality.forceWebGL ? { forceWebGL: true } : {}),
    });
    await this.renderer.init();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- internal Three.js property
    const backend = (this.renderer as any).backend;
    const isWebGPU = backend?.constructor?.name === 'WebGPUBackend' || !!backend?.device;
    console.log(`%c[CityViewer] Backend: ${isWebGPU ? 'WebGPU' : 'WebGL'}`,
      `color: ${isWebGPU ? '#3fb950' : '#d29922'}; font-weight: bold`);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));

    // Cap canvas resolution on low-end GPUs
    let w = canvas.clientWidth || window.innerWidth;
    let h = canvas.clientHeight || window.innerHeight;
    if (quality.maxResolution > 0) {
      const scale = Math.min(1, quality.maxResolution / Math.max(w, h));
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    this.renderer.setSize(w, h);
    this.renderer.toneMapping = toneMappingFor(c.toneMappingAlgorithm);
    this.renderer.toneMappingExposure = c.toneMappingExposure;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);
    this.scene.fog = c.fogEnabled
      ? new THREE.FogExp2(
          new THREE.Color(c.fogColor.r, c.fogColor.g, c.fogColor.b),
          c.fogDensity,
        )
      : null;

    this.camera = new THREE.PerspectiveCamera(DEFAULT_FOV, w / h, DEFAULT_NEAR_PLANE, DEFAULT_FAR_PLANE);
    this.camera.position.set(0, 100, 200);

    // Lighting
    this.ambient = new THREE.AmbientLight(0xffffff, c.ambientIntensity);
    this.sun = new THREE.DirectionalLight(
      new THREE.Color(c.sunColor.r, c.sunColor.g, c.sunColor.b),
      c.sunIntensity,
    );
    sunPositionFrom(c.sunAzimuthDeg, c.sunElevationDeg, this.sun.position);
    this.sun.castShadow = false;

    this.hemi = new THREE.HemisphereLight(
      new THREE.Color(c.hemiSkyColor.r, c.hemiSkyColor.g, c.hemiSkyColor.b),
      new THREE.Color(c.hemiGroundColor.r, c.hemiGroundColor.g, c.hemiGroundColor.b),
      c.hemiIntensity,
    );

    this.scene.add(this.ambient, this.sun, this.hemi);

    // Resize is driven by the ResizeObserver in CityViewer.tsx, which passes
    // the actual container dimensions. No window.resize handler here — that
    // would override correct sizes in a panel-based dashboard layout.
  }

  async loadEnvironment(baseAssetsUrl = '', assetVersion?: string): Promise<void> {
    if (this.quality.skipEnvironment) {
      console.log('[CityViewer] Skipping environment map (quality tier: %s)', this.quality.tier);
      return;
    }
    const c = loadVisualConfig().central;
    const rgbeLoader = new RGBELoader();
    try {
      // `?v=` keys the map-asset-cache gateway to the current build (the
      // RGBELoader fetch goes through the patched window.fetch).
      const version = assetVersion ? `?v=${assetVersion}` : '';
      const envPath = baseAssetsUrl ? `${baseAssetsUrl}/env/sky.hdr${version}` : '/env/sky.hdr';
      const hdrTexture = await rgbeLoader.loadAsync(envPath);

      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const envMap = pmrem.fromEquirectangular(hdrTexture).texture;

      this.scene.environment = envMap;
      this.scene.environmentIntensity = c.environmentIntensity;
      this.scene.background = envMap;
      this.scene.backgroundBlurriness = c.backgroundBlurriness;

      hdrTexture.dispose();
      pmrem.dispose();

      this.envTexture = envMap;
      this.ledger?.registerStaticAllocation(LEDGER_KEY_IBL, IBL_PMREM_BYTES_ESTIMATE, 'ibl');

      console.log('[CityViewer] IBL environment loaded');
    } catch (err) {
      console.warn('[CityViewer] Failed to load HDR environment, continuing without IBL:', err);
    }
  }

  /**
   * Set up the GTAO post-processing pipeline. Call after init().
   * Pipeline: PassNode → HalfResGTAO → Denoise → composite → SMAA → screen
   */
  initPostProcessing(): void {
    const c = loadVisualConfig().central;
    if (!this.quality.postProcessing || !c.postProcessingEnabled) {
      console.log('[CityViewer] Post-processing disabled (quality tier: %s)', this.quality.tier);
      this.aoEnabled = false;
      return;
    }
    try {
      const scenePass = pass(this.scene, this.camera);
      const sceneColor = scenePass.getTextureNode('output');
      const sceneDepth = scenePass.getTextureNode('depth');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Three.js TSL node types are untyped
      this.gtaoNode = new HalfResGTAONode(sceneDepth, null as any, this.camera);
      this.gtaoNode.radius.value = c.gtaoRadius;
      this.gtaoNode.distanceExponent.value = c.gtaoDistanceExponent;
      this.gtaoNode.samples.value = c.gtaoSamples;

      const aoTexture = this.gtaoNode.getTextureNode();
      const denoised = denoise(
        aoTexture,
        sceneDepth,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- normals param: null = reconstruct from depth
        null as any,
        this.camera,
      );
      denoised.lumaPhi.value = c.denoiseLumaPhi;
      denoised.depthPhi.value = c.denoiseDepthPhi;
      denoised.normalPhi.value = c.denoiseNormalPhi;
      denoised.radius.value = c.denoiseRadius;
      this.denoiseNode = denoised;

      // The denoise output is an R-channel render target. When sampled in
      // WebGPU it returns vec4(ao, 0, 0, 1) — multiplying component-wise
      // would zero out G and B, producing a red-tinted image. Extract the
      // scalar AO value (.x) so it broadcasts correctly to all RGB channels.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Three.js TSL node types are narrower than the runtime accepts
      const composite = sceneColor.mul((denoised as any).x);
      const output = c.smaaEnabled ? smaa(composite) : composite;

      this.postProcessing = new THREE.PostProcessing(this.renderer, output);
      this.registerPostProcessingAllocation();

      console.log(
        `[CityViewer] GTAO post-processing enabled (half-res, ${c.gtaoSamples} samples${c.smaaEnabled ? ', SMAA' : ''})`,
      );
    } catch (err) {
      console.warn('[CityViewer] Post-processing setup failed, falling back to direct render:', err);
      this.aoEnabled = false;
    }
  }

  private registerPostProcessingAllocation(): void {
    if (!this.ledger || !this.postProcessing) return;
    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);
    const bytes = size.x * size.y * POST_PROCESSING_BYTES_PER_PIXEL;
    this.ledger.registerStaticAllocation(LEDGER_KEY_POST_PROCESSING, bytes, 'rt');
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // Each subsystem's dispose is wrapped in safeDispose because the WebGPU
    // device may already be lost by the time we get here (StrictMode unmounts
    // mid-allocation, navigation away during a failed frame). A throw inside
    // dispose would skip the rest of the chain and leak the surviving
    // subsystems' GPU resources.
    safeDispose(this.envTexture);
    this.envTexture = null;
    this.ledger?.unregisterStaticAllocation(LEDGER_KEY_IBL);
    if (this.scene) {
      this.scene.environment = null;
      this.scene.background = null;
    }

    safeDispose(this.gtaoNode);
    this.gtaoNode = null;

    // PostProcessing owns its internal render targets — disposing it is what
    // releases the GTAO/denoise/SMAA framebuffers.
    safeDispose(this.postProcessing);
    this.postProcessing = null;
    this.ledger?.unregisterStaticAllocation(LEDGER_KEY_POST_PROCESSING);

    // The directional light's shadow map is a render target allocated lazily
    // when shadows render. The light itself doesn't dispose its shadow map.
    if (this.sun?.shadow?.map) {
      safeDispose(this.sun.shadow.map);
      this.sun.shadow.map = null;
    }
    this.ledger?.unregisterStaticAllocation(LEDGER_KEY_SHADOW);

    safeDispose(this.renderer);
  }

  onResize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.quality.maxResolution > 0) {
      const scale = Math.min(1, this.quality.maxResolution / Math.max(width, height));
      this.renderer.setSize(Math.round(width * scale), Math.round(height * scale));
    } else {
      this.renderer.setSize(width, height);
    }
    // Drawing-buffer size changed → post-processing render targets are rebuilt
    // at the new size by the renderer. Re-register so the ledger reflects the
    // new footprint. No-op if the ledger or PostProcessing isn't wired.
    this.registerPostProcessingAllocation();
  }

  render(): void {
    if (this.aoEnabled && this.postProcessing) {
      this.postProcessing.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  setAOEnabled(enabled: boolean): void {
    this.aoEnabled = enabled;
  }

  /**
   * Enable shadows with a one-time GPU bake. Call after scene bounds are known.
   */
  enableShadows(sceneBounds: { min: number[]; max: number[] }): void {
    const c = loadVisualConfig().central;
    if (!this.quality.shadows || !c.shadowsEnabled) {
      console.log('[CityViewer] Shadows disabled (quality tier: %s)', this.quality.tier);
      return;
    }
    // Quality preset acts as the upper bound on shadow resolution; the config
    // value picks the actual size within that ceiling.
    const ceiling = this.quality.shadowResolution || c.shadowResolution;
    const resolution = Math.min(c.shadowResolution, ceiling);
    this.renderer.shadowMap.enabled = true;

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(resolution, resolution);
    this.sun.shadow.bias = c.shadowBias;
    this.sun.shadow.normalBias = c.shadowNormalBias;

    const shadowCam = this.sun.shadow.camera as THREE.OrthographicCamera;
    const extent = Math.max(
      sceneBounds.max[0]! - sceneBounds.min[0]!,
      sceneBounds.max[2]! - sceneBounds.min[2]!,
    ) / 2;
    const height = sceneBounds.max[1]! - sceneBounds.min[1]!;
    const cx = (sceneBounds.min[0]! + sceneBounds.max[0]!) / 2;
    const cz = (sceneBounds.min[2]! + sceneBounds.max[2]!) / 2;

    shadowCam.left = -extent;
    shadowCam.right = extent;
    shadowCam.bottom = -extent;
    shadowCam.top = extent;
    shadowCam.near = 0.1;
    shadowCam.far = height + 1000;
    shadowCam.updateProjectionMatrix();

    this.sun.target.position.set(cx, 0, cz);
    this.sun.target.updateMatrixWorld();

    this.sun.shadow.autoUpdate = false;
    this.sun.shadow.needsUpdate = true;

    // Shadow render target: resolution² × 4 bytes (depth-only). Mirrors
    // memory-profiler.ts so the ledger and the profiler agree.
    this.ledger?.registerStaticAllocation(
      LEDGER_KEY_SHADOW,
      resolution * resolution * 4,
      'shadow',
    );

    console.log(`[CityViewer] Shadows enabled: ${resolution}x${resolution}, one-time bake`);
  }

  get info() {
    return this.renderer.info;
  }

  /**
   * Live-mutable handles for the visual-config HUD's LIVE knob subscriber.
   * Returns `null` for `gtaoNode` / `denoiseNode` when post-processing is
   * disabled at this quality tier.
   */
  getLiveHandles(): LiveRenderHandles {
    return {
      renderer: this.renderer,
      scene: this.scene,
      sun: this.sun,
      ambient: this.ambient,
      hemi: this.hemi,
      gtaoNode: this.gtaoNode,
      denoiseNode: this.denoiseNode,
    };
  }
}

export { sunPositionFrom };

function safeDispose(target: { dispose?: () => void } | null | undefined): void {
  if (!target || typeof target.dispose !== 'function') return;
  try {
    target.dispose();
  } catch (err) {
    console.warn('[CityRenderer] dispose() threw — continuing teardown:', err);
  }
}
