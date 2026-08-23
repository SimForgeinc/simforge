import { z } from 'zod';

/**
 * Single source of truth for the city viewer's renderer + per-layer visual
 * configuration. The default values mirror the magic numbers previously
 * hardcoded in `renderer.ts` and the implicit "all 1.0" per-layer multipliers,
 * so a fresh-defaults canvas matches the pre-HUD baseline.
 *
 * The shape covers both LIVE and RELOAD knob fields up-front (issues #03/#04
 * wire LIVE knobs, #05 wires RELOAD knobs) — keeping the schema stable lets
 * the renderer + loaders read the same constant from day one.
 */

const STORAGE_KEY = 'city-viewer:visual-config';
const PERSIST_DEBOUNCE_MS = 200;

const Vec3Schema = z.object({
  r: z.number().min(0).max(4),
  g: z.number().min(0).max(4),
  b: z.number().min(0).max(4),
});

const ToneMappingAlgorithmSchema = z.enum(['ACES', 'Linear', 'Reinhard', 'Cineon']);
const ShadowResolutionSchema = z.union([
  z.literal(512),
  z.literal(1024),
  z.literal(2048),
  z.literal(4096),
]);
const GtaoSamplesSchema = z.union([
  z.literal(4),
  z.literal(8),
  z.literal(16),
  z.literal(32),
]);

const CentralConfigSchema = z.object({
  sunAzimuthDeg: z.number().min(0).max(360),
  sunElevationDeg: z.number().min(0).max(90),
  sunColor: Vec3Schema,
  sunIntensity: z.number().min(0).max(5),
  ambientIntensity: z.number().min(0).max(5),
  hemiSkyColor: Vec3Schema,
  hemiGroundColor: Vec3Schema,
  hemiIntensity: z.number().min(0).max(5),
  toneMappingAlgorithm: ToneMappingAlgorithmSchema,
  toneMappingExposure: z.number().min(0).max(3),
  fogEnabled: z.boolean(),
  fogColor: Vec3Schema,
  fogDensity: z.number().min(0).max(0.01),
  environmentIntensity: z.number().min(0).max(3),
  backgroundBlurriness: z.number().min(0).max(1),
  postProcessingEnabled: z.boolean(),
  gtaoSamples: GtaoSamplesSchema,
  gtaoRadius: z.number().min(0).max(2),
  gtaoDistanceExponent: z.number().min(0).max(5),
  smaaEnabled: z.boolean(),
  denoiseLumaPhi: z.number().min(0).max(20),
  denoiseDepthPhi: z.number().min(0).max(20),
  denoiseNormalPhi: z.number().min(0).max(20),
  denoiseRadius: z.number().min(0).max(10),
  shadowsEnabled: z.boolean(),
  shadowResolution: ShadowResolutionSchema,
  shadowBias: z.number().min(-0.01).max(0.01),
  shadowNormalBias: z.number().min(0).max(0.1),
});

const LayerMultipliersSchema = z.object({
  roughnessMultiplier: z.number().min(0).max(4),
  metalnessMultiplier: z.number().min(0).max(4),
  colorTint: Vec3Schema,
  normalScaleMultiplier: z.number().min(0).max(4),
  aoMapIntensityMultiplier: z.number().min(0).max(4),
  envMapIntensityMultiplier: z.number().min(0).max(4),
  forceFlatShading: z.boolean(),
});

const VegetationLayerMultipliersSchema = LayerMultipliersSchema.extend({
  density: z.number().min(0.05).max(1),
  castShadows: z.boolean(),
});

export const VisualConfigSchema = z.object({
  central: CentralConfigSchema,
  layers: z.object({
    asset: LayerMultipliersSchema,
    road: LayerMultipliersSchema,
    vegetation: VegetationLayerMultipliersSchema,
  }),
});

export type VisualConfig = z.infer<typeof VisualConfigSchema>;
export type CentralConfig = VisualConfig['central'];
export type LayerMultipliers = VisualConfig['layers']['asset'];
export type VegetationLayerMultipliers = VisualConfig['layers']['vegetation'];
export type ToneMappingAlgorithm = z.infer<typeof ToneMappingAlgorithmSchema>;
export type LayerKind = 'asset' | 'road' | 'vegetation';

const IDENTITY_TINT = { r: 1, g: 1, b: 1 } as const;

const DEFAULT_LAYER_MULTIPLIERS = {
  roughnessMultiplier: 1,
  metalnessMultiplier: 1,
  colorTint: { ...IDENTITY_TINT },
  normalScaleMultiplier: 1,
  aoMapIntensityMultiplier: 1,
  envMapIntensityMultiplier: 1,
  forceFlatShading: false,
} as const;

// Sun azimuth/elevation chosen so the converted position vector matches the
// direction of the previous hardcoded sun.position = (200, 400, 300):
//   atan2(200, 300) ≈ 33.69°, asin(400 / |v|) ≈ 47.99°.
// With the R=500 conversion radius the position lands at (185.7, 371.4, 278.5)
// — same lighting direction (only direction matters for a DirectionalLight).
export const DEFAULT_VISUAL_CONFIG: VisualConfig = {
  central: {
    sunAzimuthDeg: 33.69,
    sunElevationDeg: 47.99,
    sunColor: { r: 1.0, g: 0.957, b: 0.902 }, // 0xfff4e6
    sunIntensity: 1.5,
    ambientIntensity: 0.15,
    hemiSkyColor: { r: 0.529, g: 0.808, b: 0.922 }, // 0x87ceeb
    hemiGroundColor: { r: 0.212, g: 0.161, b: 0.027 }, // 0x362907
    hemiIntensity: 0.1,
    toneMappingAlgorithm: 'ACES',
    toneMappingExposure: 1.0,
    fogEnabled: true,
    fogColor: { r: 0.784, g: 0.847, b: 0.91 }, // 0xc8d8e8
    fogDensity: 0.00025,
    environmentIntensity: 0.6,
    backgroundBlurriness: 0.05,
    postProcessingEnabled: true,
    gtaoSamples: 16,
    gtaoRadius: 0.5,
    gtaoDistanceExponent: 2,
    smaaEnabled: true,
    denoiseLumaPhi: 5,
    denoiseDepthPhi: 5,
    denoiseNormalPhi: 5,
    denoiseRadius: 5,
    shadowsEnabled: true,
    shadowResolution: 4096,
    shadowBias: -0.001,
    shadowNormalBias: 0.02,
  },
  layers: {
    asset: { ...DEFAULT_LAYER_MULTIPLIERS, colorTint: { ...IDENTITY_TINT } },
    road: { ...DEFAULT_LAYER_MULTIPLIERS, colorTint: { ...IDENTITY_TINT } },
    vegetation: {
      ...DEFAULT_LAYER_MULTIPLIERS,
      colorTint: { ...IDENTITY_TINT },
      density: 1,
      castShadows: false,
    },
  },
};

// ---------------------------------------------------------------------------
// In-memory state, subscribers, debounced persist
// ---------------------------------------------------------------------------

let _state: VisualConfig | null = null;
const _listeners = new Set<(cfg: VisualConfig) => void>();
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

type Listener = (cfg: VisualConfig) => void;

function readLocalStorage(): unknown {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Recursively merges `partial` over `defaults`. Plain-object values are merged
 * key-by-key; everything else (numbers, booleans, strings, arrays) replaces
 * outright. Used both to forward-compat older saved blobs that lack newly-added
 * keys and to produce the next state from a `Partial<VisualConfig>` patch.
 */
function deepMerge(defaults: unknown, partial: unknown): unknown {
  if (!isPlainObject(defaults)) {
    return partial !== undefined ? partial : defaults;
  }
  if (!isPlainObject(partial)) {
    return defaults;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(defaults)) {
    result[key] = deepMerge(defaults[key], partial[key]);
  }
  for (const key of Object.keys(partial)) {
    if (!(key in result)) result[key] = partial[key];
  }
  return result;
}

function notifyAll(): void {
  if (!_state) return;
  for (const l of _listeners) l(_state);
}

function schedulePersist(): void {
  if (typeof window === 'undefined') return;
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    if (!_state) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(_state));
    } catch {
      /* localStorage may be disabled (privacy mode) — silently noop */
    }
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Synchronously persist the in-memory state to localStorage and cancel any
 * pending debounced write. Used by the HUD's "Apply (reload)" button so the
 * working draft is durable before `window.location.reload()` (without this,
 * a sub-200 ms reload race would lose the unflushed change).
 *
 * No-op when no state has been loaded yet (nothing to flush). Safe to call
 * outside a browser context — the localStorage write is guarded.
 */
export function flushVisualConfig(): void {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  if (!_state) return;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(_state));
  } catch {
    /* ignore */
  }
}

/**
 * Read the current config. Populates the in-memory cache on first call from
 * localStorage, deep-merging missing keys from `DEFAULT_VISUAL_CONFIG` so older
 * saved blobs forward-compat into newly-added fields. Falls back to defaults if
 * the saved blob is missing, unparseable, or fails Zod validation.
 */
export function loadVisualConfig(): VisualConfig {
  if (_state !== null) return _state;
  const raw = readLocalStorage();
  if (raw === null || raw === undefined) {
    _state = DEFAULT_VISUAL_CONFIG;
    return _state;
  }
  const merged = deepMerge(DEFAULT_VISUAL_CONFIG, raw);
  const parsed = VisualConfigSchema.safeParse(merged);
  if (parsed.success) {
    _state = parsed.data;
    return _state;
  }
  console.warn('[visual-config] saved blob failed schema validation, falling back to defaults');
  _state = DEFAULT_VISUAL_CONFIG;
  return _state;
}

export type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

/**
 * Merge a partial patch into the current config, validate, notify subscribers
 * synchronously (so live tuning is real-time), and schedule a debounced
 * localStorage write. If validation fails, the patch is rejected — the caller
 * is the HUD's slider components, which constrain to the schema's ranges, so
 * a rejection here is unexpected and surfaced to the console.
 */
export function saveVisualConfig(partial: DeepPartial<VisualConfig>): void {
  const current = loadVisualConfig();
  const merged = deepMerge(current, partial);
  const parsed = VisualConfigSchema.safeParse(merged);
  if (!parsed.success) {
    console.warn(
      '[visual-config] save rejected: schema validation failed',
      parsed.error.issues,
    );
    return;
  }
  _state = parsed.data;
  notifyAll();
  schedulePersist();
}

export function subscribeVisualConfig(listener: Listener): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

export function exportConfigJSON(): string {
  return JSON.stringify(loadVisualConfig(), null, 2);
}

export function importConfigJSON(
  json: string,
): { ok: true } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      error: `Malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const merged = deepMerge(DEFAULT_VISUAL_CONFIG, raw);
  const parsed = VisualConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `Schema validation failed: ${issues}` };
  }
  _state = parsed.data;
  notifyAll();
  schedulePersist();
  return { ok: true };
}

/**
 * Restore the in-memory config to `DEFAULT_VISUAL_CONFIG`, drop any pending
 * persist, clear the localStorage entry, and notify subscribers.
 */
export function resetVisualConfig(): void {
  _state = DEFAULT_VISUAL_CONFIG;
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
  notifyAll();
}

/**
 * Reset module-level state. Test-only helper — call before each test so the
 * cached `_state` and listener set don't leak between cases.
 */
export function __resetVisualConfigForTesting(): void {
  _state = null;
  _listeners.clear();
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
}

export const __VISUAL_CONFIG_STORAGE_KEY = STORAGE_KEY;
