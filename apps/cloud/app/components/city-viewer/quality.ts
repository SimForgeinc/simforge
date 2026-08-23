/**
 * GPU capability detection and quality tier system.
 *
 * Uses a layered approach:
 *   1. Try WebGPU adapter (with high-performance preference for hybrid GPUs)
 *   2. Fall back to WebGL WEBGL_debug_renderer_info if WebGPU unavailable
 *   3. Classify into high / low based on vendor + capability limits
 *
 * The key principle: "unable to detect" maps to high, not low.
 * Only positively-identified weak hardware (integrated Intel, very low
 * memory / limits) gets the low tier.
 */

import { readRenderingPreference, usesLightweightRendering } from './rendering-preference';

export type QualityTier = 'low' | 'high';

export interface GpuInfo {
  vendor: string;
  device: string;
  description: string;
  tier: QualityTier;
  reason: string;
  /** How the GPU was detected — useful for debugging reports */
  detectionMethod: 'webgpu' | 'webgl' | 'none';
}

interface QualityPreset {
  tier: QualityTier;
  /** Force WebGL instead of WebGPU (more stable on integrated GPUs) */
  forceWebGL: boolean;
  /** Hardware MSAA — cheap driver-level AA, good for geometric edges like lane markings */
  antialias: boolean;
  postProcessing: boolean;
  /** Load vegetation instanced meshes (trees, grass) */
  vegetation: boolean;
  shadows: boolean;
  shadowResolution: number;
  maxPixelRatio: number;
  /** Cap canvas resolution (0 = no cap, use container size) */
  maxResolution: number;
  memoryBudgetBytes: number;
  maxConcurrentFetches: number;
  /** Target FPS cap (0 = uncapped/requestAnimationFrame) */
  fpsLimit: number;
  sseThreshold: number;
  minLodLevel: number;
  /** Skip environment map (HDR IBL) loading */
  skipEnvironment: boolean;
  /** Skip compileAsync on loaded tiles (reduces upfront GPU stress) */
  skipCompileAsync: boolean;
  /** Max tiles in scene at once (0 = unlimited) */
  maxTilesInScene: number;
  /** Downscale textures to this max dimension after loading (0 = no limit) */
  maxTextureSize: number;
  /** Multiplier (0–1) on vegetation instance counts — applied on top of LOD thinning */
  vegetationDensityScale: number;
  /** Minimum LOD level for vegetation tiles (independent of building minLodLevel) */
  vegetationMinLod: number;
}

export type QualitySettings = QualityPreset & { gpuInfo: GpuInfo };

/** @internal Exported for testing */
export const QUALITY_PRESETS: Record<QualityTier, QualityPreset> = {
  low: {
    tier: 'low',
    forceWebGL: true,
    antialias: true,
    postProcessing: false,
    vegetation: true,
    shadows: false,
    shadowResolution: 0,
    maxPixelRatio: 1,
    maxResolution: 1920,
    memoryBudgetBytes: 256 * 1024 * 1024,   // 256 MB
    maxConcurrentFetches: 2,
    fpsLimit: 30,
    sseThreshold: 16.0,
    minLodLevel: 1,
    skipEnvironment: true,
    skipCompileAsync: true,
    maxTilesInScene: 12,
    maxTextureSize: 256,
    vegetationDensityScale: 0.2,
    vegetationMinLod: 3,
  },
  high: {
    tier: 'high',
    forceWebGL: false,
    antialias: true,
    postProcessing: true,
    vegetation: true,
    shadows: true,
    shadowResolution: 4096,
    maxPixelRatio: 2,
    maxResolution: 0,
    memoryBudgetBytes: 4096 * 1024 * 1024,  // 4 GB — see streaming-budget-pacing PRD
    maxConcurrentFetches: 6,
    fpsLimit: 0,
    sseThreshold: 6.0,
    minLodLevel: 0,
    skipEnvironment: false,
    skipCompileAsync: false,
    maxTilesInScene: 0,
    maxTextureSize: 0,
    vegetationDensityScale: 1.0,
    vegetationMinLod: 0,
  },
};

function withGpuInfo(preset: QualityPreset, gpuInfo: GpuInfo): QualitySettings {
  return { ...preset, gpuInfo };
}

/* -------------------------------------------------------------------------- */
/*  WebGL fallback detection                                                  */
/* -------------------------------------------------------------------------- */

interface WebGLGpuHint {
  renderer: string;
  vendor: string;
}

/**
 * Extract GPU vendor/renderer from WebGL when WebGPU is unavailable.
 * Uses WEBGL_debug_renderer_info which is widely supported.
 */
function probeWebGL(): WebGLGpuHint | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return null;

    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return null;

    const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
    const vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) as string;

    // Clean up
    const loseExt = gl.getExtension('WEBGL_lose_context');
    loseExt?.loseContext();

    return { renderer: renderer ?? '', vendor: vendor ?? '' };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Vendor / capability classification helpers                                */
/* -------------------------------------------------------------------------- */

interface GpuClassification {
  isNvidia: boolean;
  isAmd: boolean;
  isApple: boolean;
  isIntel: boolean;
  isIntegrated: boolean;
  isDedicated: boolean;
}

/** @internal Exported for testing */
export function classifyGpuStrings(vendor: string, description: string): GpuClassification {
  const v = vendor.toLowerCase();
  const d = description.toLowerCase();

  const isNvidia = v.includes('nvidia') || d.includes('nvidia') || d.includes('geforce');
  const isAmd = v.includes('amd') || v.includes('ati') || d.includes('radeon') || d.includes('amd');
  const isApple = v.includes('apple') || d.includes('apple');
  const isIntel = v.includes('intel') || d.includes('intel');

  // Intel Arc is dedicated (discrete GPU)
  const isIntelArc = isIntel && (d.includes('arc') || /\ba[3-9]\d{2,3}\b/.test(d));

  // All non-Arc Intel is integrated. Previous logic required matching specific
  // keywords (uhd, iris, mesa, etc.) which missed GPUs that report as plain
  // "Intel" or "Intel(R) Graphics" without those markers.
  const isIntegrated = isIntel && !isIntelArc;

  const isDedicated = isNvidia || isAmd || isIntelArc || isApple;

  return { isNvidia, isAmd, isApple, isIntel, isIntegrated, isDedicated };
}

/**
 * Detect GPU capability and return appropriate quality settings.
 * Must be called before renderer init (needs raw WebGPU adapter).
 */
export async function detectQuality(): Promise<QualitySettings> {
  // ---- Override: ?quality=low or ?quality=high forces a tier for testing ----
  if (typeof window !== 'undefined') {
    const override = new URLSearchParams(window.location.search).get('quality');
    if (override === 'low' || override === 'high') {
      console.log(`[Quality] Tier FORCED to ${override} via ?quality= URL parameter`);
      const preset = { ...QUALITY_PRESETS[override] };
      // If the preset allows WebGPU but the browser doesn't support it,
      // force WebGL so the renderer can still initialize.
      if (!preset.forceWebGL && !navigator.gpu) {
        preset.forceWebGL = true;
        console.warn('[Quality] WebGPU unavailable — forcing WebGL backend despite high preset');
      }
      // When forcing high on a low-end GPU, keep the FPS and resolution
      // caps so the integrated GPU isn't overwhelmed by uncapped rendering.
      if (override === 'high') {
        const webglHint = probeWebGL();
        const gpu = webglHint
          ? classifyGpuStrings(webglHint.vendor, webglHint.renderer)
          : null;
        if (gpu?.isIntegrated) {
          preset.fpsLimit = QUALITY_PRESETS.low.fpsLimit;
          preset.maxResolution = QUALITY_PRESETS.low.maxResolution;
          preset.maxPixelRatio = QUALITY_PRESETS.low.maxPixelRatio;
          console.log('[Quality] Integrated GPU detected — keeping FPS/resolution caps with high preset');
        }
      }
      return withGpuInfo(preset, {
        vendor: 'override', device: 'override', description: `Forced ${override} via URL`,
        tier: override, reason: `Quality tier forced to "${override}" via URL parameter.`,
        detectionMethod: 'none',
      });
    }
  }

  // A choice made during the first authenticated dashboard visit is the
  // browser-level default. Keep URL overrides above it so explicit per-view
  // quality controls and test links continue to work.
  const renderingPreference = readRenderingPreference();
  if (renderingPreference) {
    const tier: QualityTier = usesLightweightRendering(renderingPreference) ? 'low' : 'high';
    const preset = { ...QUALITY_PRESETS[tier] };
    if (tier === 'high' && !navigator.gpu) {
      preset.forceWebGL = true;
    }
    return withGpuInfo(preset, {
      vendor: 'preference',
      device: 'browser',
      description: `${renderingPreference} model quality preference`,
      tier,
      reason: `Using the ${renderingPreference} rendering preference saved in this browser.`,
      detectionMethod: 'none',
    });
  }

  // ---- Path 1: Try WebGPU (preferred — gives us adapter limits) ----
  if (navigator.gpu) {
    try {
      // Request high-performance adapter to prefer discrete GPU on hybrid laptops
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        return classifyFromWebGPU(adapter);
      }
      console.warn('[Quality] WebGPU available but no adapter returned');
    } catch (err) {
      console.warn('[Quality] WebGPU adapter request failed:', err);
    }
  }

  // ---- Path 2: Fall back to WebGL for GPU identification ----
  const webglHint = probeWebGL();
  if (webglHint) {
    return classifyFromWebGL(webglHint);
  }

  // ---- Path 3: No detection possible — default to high ----
  // If we can't detect anything, the user likely has a capable machine
  // whose browser just isn't exposing GPU info. Punishing them with low
  // quality is worse than risking a slightly heavier render.
  console.warn('[Quality] No WebGPU or WebGL detection available — defaulting to high');
  return withGpuInfo(QUALITY_PRESETS.high, {
    vendor: 'unknown', device: 'unknown', description: 'unknown',
    tier: 'high', reason: 'Could not detect GPU — using full quality by default.',
    detectionMethod: 'none',
  });
}

/* -------------------------------------------------------------------------- */
/*  WebGPU classification                                                     */
/* -------------------------------------------------------------------------- */

async function classifyFromWebGPU(adapter: GPUAdapter): Promise<QualitySettings> {
  // Extract adapter info (API varies across browsers)
  let info: { vendor?: string; device?: string; description?: string; architecture?: string } = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter API varies across browsers
    info = (adapter as any).info ?? {};
  } catch { /* ignore */ }
  if (!info.vendor && !info.description) {
    try {
      // Older Chrome (pre-124) exposes requestAdapterInfo() as an async method
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- older Chrome async API
      info = (await (adapter as any).requestAdapterInfo?.()) ?? info;
    } catch { /* ignore */ }
  }

  const desc = info.description ?? info.device ?? info.architecture ?? '';
  const vendor = info.vendor ?? '';
  const gpuLabel = info.description || info.device || info.architecture || 'Unknown GPU';

  console.log(`[Quality] WebGPU adapter: vendor="${vendor}" device="${info.device ?? ''}" desc="${desc}" arch="${info.architecture ?? ''}"`);

  const baseInfo: Omit<GpuInfo, 'tier' | 'reason' | 'detectionMethod'> = {
    vendor: vendor || 'unknown',
    device: info.device ?? 'unknown',
    description: gpuLabel,
  };

  const gpu = classifyGpuStrings(vendor, desc);
  const maxTextureDim = adapter.limits.maxTextureDimension2D ?? 0;
  const maxBufferSize = adapter.limits.maxBufferSize ?? 0;
  const deviceMemoryGB = (navigator as unknown as Record<string, unknown>).deviceMemory as number | undefined;

  console.log(`[Quality] dedicated=${gpu.isDedicated} intel=${gpu.isIntel} integrated=${gpu.isIntegrated} maxBuffer=${(maxBufferSize / 1024 / 1024).toFixed(0)}MB maxTex=${maxTextureDim} deviceMem=${deviceMemoryGB ?? 'unknown'}GB`);

  // LOW: Confirmed integrated Intel with low capability limits
  if (gpu.isIntegrated && maxTextureDim > 0 && maxTextureDim < 8192) {
    console.log('[Quality] Tier: LOW — integrated GPU with low limits');
    return withGpuInfo(QUALITY_PRESETS.low, {
      ...baseInfo, tier: 'low', detectionMethod: 'webgpu',
      reason: `Integrated GPU detected (${gpuLabel}, maxTexture=${maxTextureDim}). Using reduced quality to prevent crashes.`,
    });
  }

  // LOW: Very low device memory (known and <= 2 GB)
  if (deviceMemoryGB != null && deviceMemoryGB <= 2) {
    console.log('[Quality] Tier: LOW — very low device memory');
    return withGpuInfo(QUALITY_PRESETS.low, {
      ...baseInfo, tier: 'low', detectionMethod: 'webgpu',
      reason: `Low device memory (${deviceMemoryGB}GB). Using reduced quality to prevent crashes.`,
    });
  }

  // LOW: Integrated Intel with adequate limits — still not great for heavy 3D
  if (gpu.isIntegrated) {
    console.log('[Quality] Tier: LOW — integrated GPU');
    return withGpuInfo(QUALITY_PRESETS.low, {
      ...baseInfo, tier: 'low', detectionMethod: 'webgpu',
      reason: `Integrated GPU detected (${gpuLabel}). Using reduced quality to prevent crashes.`,
    });
  }

  // HIGH: Everything else — dedicated GPU, Apple Silicon, unknown vendor, etc.
  console.log(`[Quality] Tier: HIGH — ${gpu.isDedicated ? 'dedicated GPU' : 'assuming capable'}`);
  return withGpuInfo(QUALITY_PRESETS.high, {
    ...baseInfo, tier: 'high', detectionMethod: 'webgpu',
    reason: gpu.isDedicated
      ? `Dedicated GPU detected (${gpuLabel}). Full quality rendering enabled.`
      : `GPU identified (${gpuLabel}). Full quality rendering enabled.`,
  });
}

/* -------------------------------------------------------------------------- */
/*  WebGL fallback classification                                             */
/* -------------------------------------------------------------------------- */

function classifyFromWebGL(hint: WebGLGpuHint): QualitySettings {
  const gpuLabel = hint.renderer || hint.vendor || 'Unknown GPU';
  console.log(`[Quality] WebGL fallback: vendor="${hint.vendor}" renderer="${hint.renderer}"`);

  const baseInfo: Omit<GpuInfo, 'tier' | 'reason' | 'detectionMethod'> = {
    vendor: hint.vendor || 'unknown',
    device: 'unknown',
    description: gpuLabel,
  };

  const gpu = classifyGpuStrings(hint.vendor, hint.renderer);

  // LOW: Confirmed integrated Intel
  if (gpu.isIntegrated) {
    console.log('[Quality] Tier: LOW — integrated GPU via WebGL');
    return withGpuInfo(QUALITY_PRESETS.low, {
      ...baseInfo, tier: 'low', detectionMethod: 'webgl',
      reason: `Integrated GPU detected via WebGL (${gpuLabel}). Using reduced quality to prevent crashes.`,
    });
  }

  // HIGH: Anything else detected through WebGL (dedicated or unknown).
  // Force WebGL backend since we know WebGPU isn't available.
  console.log(`[Quality] Tier: HIGH — ${gpu.isDedicated ? 'dedicated' : 'unknown'} GPU via WebGL`);
  const preset = { ...QUALITY_PRESETS.high, forceWebGL: true };
  return withGpuInfo(preset, {
    ...baseInfo, tier: 'high', detectionMethod: 'webgl',
    reason: gpu.isDedicated
      ? `Dedicated GPU detected via WebGL (${gpuLabel}). High quality with WebGL backend.`
      : `GPU detected via WebGL (${gpuLabel}). High quality with WebGL backend.`,
  });
}
