/**
 * Memory profiler for the city viewer.
 *
 * Estimates real GPU/system memory usage that Chrome's performance.memory
 * doesn't capture: geometry buffers (JS + VRAM copies), textures, render
 * targets, shadow maps, and post-processing buffers.
 *
 * Detects sustained memory growth and flags suspected leaks.
 * Saves snapshots to localStorage so the last state is recoverable after
 * a browser crash.
 */

import * as THREE from 'three/webgpu';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface MemoryMetrics {
  // JS Heap (Chrome only — 0 elsewhere)
  jsHeapUsedMB: number;
  jsHeapLimitMB: number;

  // Three.js renderer-tracked resource counts
  geometryCount: number;
  textureCount: number;

  // Estimated GPU memory breakdown (MB)
  geometryMB: number;
  textureMB: number;
  renderTargetMB: number;
  gpuTotalMB: number;

  // Scene complexity
  meshCount: number;
  instancedMeshCount: number;
  totalInstances: number;

  // Memory trend (MB / min)
  gpuGrowthMBPerMin: number;
  heapGrowthMBPerMin: number;
  leakSuspected: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const COLLECT_INTERVAL_MS = 3_000;
const MAX_SNAPSHOTS = 20; // 60 s of history at 3 s intervals
const LEAK_THRESHOLD_MB_PER_MIN = 15;
const LEAK_MIN_SAMPLES = 6; // need ≥ 18 s of data
const CRASH_SNAPSHOT_KEY = 'cityviewer-last-memory-snapshot';
const GPU_WARN_MB = 1_200;
const GPU_CRITICAL_MB = 1_800;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

interface Snapshot {
  time: number;
  gpuMB: number;
  heapMB: number;
}

/** Chrome-only non-standard Performance.memory API. */
interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/** Narrow type for image-like sources that have width/height. */
interface ImageLikeSource {
  width?: number;
  height?: number;
  videoWidth?: number;
  videoHeight?: number;
}

function getPerformanceMemory(): PerformanceMemory | null {
  return (performance as Performance & { memory?: PerformanceMemory }).memory ?? null;
}

function getDeviceMemoryGB(): number | undefined {
  return (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
}

function getTextureSource(tex: THREE.Texture): ImageLikeSource | null {
  const source = tex.source as { data?: ImageLikeSource } | undefined;
  return source?.data ?? (tex.image as ImageLikeSource | null);
}

function estimateTextureBytes(tex: THREE.Texture): number {
  const img = getTextureSource(tex);
  if (!img) return 0;

  const width = img.width ?? img.videoWidth ?? 0;
  const height = img.height ?? img.videoHeight ?? 0;
  if (width === 0 || height === 0) return 0;

  let bpp = 4; // RGBA8
  if (tex.type === THREE.FloatType) bpp = 16;
  else if (tex.type === THREE.HalfFloatType) bpp = 8;

  let bytes = width * height * bpp;
  if (tex.generateMipmaps) bytes = Math.ceil(bytes * 1.33);
  if ('isCubeTexture' in tex && tex.isCubeTexture) bytes *= 6;

  return bytes;
}

function emptyMetrics(): MemoryMetrics {
  return {
    jsHeapUsedMB: 0,
    jsHeapLimitMB: 0,
    geometryCount: 0,
    textureCount: 0,
    geometryMB: 0,
    textureMB: 0,
    renderTargetMB: 0,
    gpuTotalMB: 0,
    meshCount: 0,
    instancedMeshCount: 0,
    totalInstances: 0,
    gpuGrowthMBPerMin: 0,
    heapGrowthMBPerMin: 0,
    leakSuspected: false,
  };
}

/* -------------------------------------------------------------------------- */
/*  Heap pressure guard                                                       */
/* -------------------------------------------------------------------------- */


let _baselineHeapMB = 0;

/** Call once before the viewer starts loading to record the starting heap. */
export function recordHeapBaseline(): void {
  const mem = getPerformanceMemory();
  _baselineHeapMB = mem ? mem.usedJSHeapSize / (1024 * 1024) : 0;
  console.log(`[MemoryGuard] Heap baseline: ${Math.round(_baselineHeapMB)} MB`);
}

/** How much JS heap the viewer has added since {@link recordHeapBaseline}. */
export function getHeapGrowthMB(): number {
  const mem = getPerformanceMemory();
  if (!mem) return 0;
  return mem.usedJSHeapSize / (1024 * 1024) - _baselineHeapMB;
}

export interface MemoryGuardLimits {
  /** Max JS heap growth since baseline (MB) */
  heapGrowthMB: number;
  /**
   * Max estimated GPU memory (MB).
   * On integrated GPUs textures live in system RAM, so this is effectively
   * a system memory cap for texture + geometry data.
   */
  gpuTotalMB: number;
}

/**
 * Compute safe memory caps for the viewer from the configured tile budget.
 *
 * Caps used to derive from `navigator.deviceMemory` (30% for GPU, 25% for
 * heap), but that value reports system RAM rather than VRAM and so inflated
 * the GPU cap on machines with abundant system memory but a modest GPU.
 * The streaming-budget-pacing PRD removes the heuristic — caps are now a
 * pure function of the tier budget, which already encodes GPU capability.
 */
export function computeMemoryGuardLimits(budgetBytes: number): MemoryGuardLimits {
  const budgetMB = Math.round(budgetBytes / (1024 * 1024));
  const gpuTotalMB = Math.max(200, budgetMB);
  const heapGrowthMB = Math.max(128, Math.round(budgetMB * 1.5));

  console.log(
    `[MemoryGuard] Limits: heapGrowth=${heapGrowthMB} MB, gpuTotal=${gpuTotalMB} MB` +
    ` (budget=${budgetMB} MB)`,
  );
  return { heapGrowthMB, gpuTotalMB };
}

/**
 * Returns true if the viewer should stop loading more assets.
 *
 * Checks (any one triggers):
 * 1. JS heap growth since baseline exceeds the heap cap
 * 2. Remaining JS heap headroom is dangerously low (< 150 MB)
 * 3. Estimated GPU memory (textures + geometry + render targets) exceeds
 *    the GPU cap — this catches the real killer on integrated GPUs where
 *    decoded textures live in renderer/process memory invisible to JS heap
 */
export function shouldPauseLoading(limits: MemoryGuardLimits, latestGpuTotalMB: number): boolean {
  // GPU/texture memory check — catches the #1 crash cause on integrated GPUs
  if (latestGpuTotalMB > limits.gpuTotalMB) return true;

  // JS heap checks
  const mem = getPerformanceMemory();
  if (!mem) return false;

  const growthMB = mem.usedJSHeapSize / (1024 * 1024) - _baselineHeapMB;
  if (growthMB > limits.heapGrowthMB) return true;

  const headroomMB = (mem.jsHeapSizeLimit - mem.usedJSHeapSize) / (1024 * 1024);
  if (headroomMB < 150) return true;

  return false;
}

/* -------------------------------------------------------------------------- */
/*  MemoryProfiler                                                            */
/* -------------------------------------------------------------------------- */

export interface QualityHints {
  shadows: boolean;
  shadowResolution: number;
  postProcessing: boolean;
}

export class MemoryProfiler {
  private snapshots: Snapshot[] = [];
  private lastCollectTime = 0;
  private metrics: MemoryMetrics = emptyMetrics();
  private warnedHigh = false;
  private warnedCritical = false;
  private warnedLeak = false;

  constructor() {
    this.logPreviousSession();
  }

  /* ---- Public API -------------------------------------------------------- */

  /**
   * Collect metrics. Safe to call every frame — internally throttled to
   * once per {@link COLLECT_INTERVAL_MS}.
   */
  collect(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    quality: QualityHints,
  ): MemoryMetrics {
    const now = performance.now();
    if (now - this.lastCollectTime < COLLECT_INTERVAL_MS) return this.metrics;
    this.lastCollectTime = now;

    // ---- JS heap ----
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const perfMem = (performance as any).memory;
    const jsHeapUsedMB = perfMem ? perfMem.usedJSHeapSize / (1024 * 1024) : 0;
    const jsHeapLimitMB = perfMem ? perfMem.jsHeapSizeLimit / (1024 * 1024) : 0;

    // ---- Three.js resource counts ----
    const info = renderer.info;
    const geometryCount = info.memory?.geometries ?? 0;
    const textureCount = info.memory?.textures ?? 0;

    // ---- Scene traversal for GPU memory estimates ----
    let geometryBytes = 0;
    let textureBytes = 0;
    let meshCount = 0;
    let instancedMeshCount = 0;
    let totalInstances = 0;
    const seenGeo = new Set<number>();
    const seenTex = new Set<number>();

    scene.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      meshCount++;

      const isInstanced = (mesh as THREE.InstancedMesh).isInstancedMesh;
      if (isInstanced) {
        instancedMeshCount++;
        totalInstances += (mesh as THREE.InstancedMesh).count;
      }

      // Geometry buffer sizes (JS-side — GPU has a copy too)
      const geo = mesh.geometry;
      if (geo && !seenGeo.has(geo.id)) {
        seenGeo.add(geo.id);
        for (const attr of Object.values(geo.attributes)) {
          if (attr?.array) geometryBytes += attr.array.byteLength;
        }
        if (geo.index?.array) geometryBytes += geo.index.array.byteLength;
        if (isInstanced) {
          const im = mesh as THREE.InstancedMesh;
          if (im.instanceMatrix) geometryBytes += im.instanceMatrix.array.byteLength;
          if (im.instanceColor) geometryBytes += im.instanceColor.array.byteLength;
        }
      }

      // Texture sizes
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat) continue;
        for (const val of Object.values(mat)) {
          if (val instanceof THREE.Texture && !seenTex.has(val.id)) {
            seenTex.add(val.id);
            textureBytes += estimateTextureBytes(val);
          }
        }
      }
    });

    // Environment / background textures
    if (scene.environment && !seenTex.has(scene.environment.id)) {
      seenTex.add(scene.environment.id);
      textureBytes += estimateTextureBytes(scene.environment);
    }
    if (scene.background instanceof THREE.Texture && !seenTex.has(scene.background.id)) {
      seenTex.add(scene.background.id);
      textureBytes += estimateTextureBytes(scene.background);
    }

    // ---- Render target estimates ----
    let renderTargetBytes = 0;
    const size = renderer.getSize(new THREE.Vector2());
    const px = size.x * size.y;

    if (quality.shadows && quality.shadowResolution > 0) {
      renderTargetBytes += quality.shadowResolution * quality.shadowResolution * 4;
    }
    if (quality.postProcessing) {
      // Scene pass colour (RGBA16F=8) + depth (4), GTAO half-res (1),
      // denoise (4), SMAA (4) ≈ ~21 bytes/pixel at full res
      renderTargetBytes += px * 8;  // scene colour
      renderTargetBytes += px * 4;  // scene depth
      renderTargetBytes += px * 1;  // GTAO at half-res ≈ quarter pixels
      renderTargetBytes += px * 4;  // denoise
      renderTargetBytes += px * 4;  // SMAA
    }

    // ---- Geometry counts as 2× (JS + GPU copy) ----
    const geometryTotal = geometryBytes * 2;

    const MB = 1024 * 1024;
    const geometryMB = round1(geometryTotal / MB);
    const textureMB = round1(textureBytes / MB);
    const renderTargetMB = round1(renderTargetBytes / MB);
    const gpuTotalMB = round1(geometryMB + textureMB + renderTargetMB);

    // ---- Growth tracking ----
    this.snapshots.push({ time: now, gpuMB: gpuTotalMB, heapMB: jsHeapUsedMB });
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
    const { gpuGrowth, heapGrowth, leakSuspected } = this.computeGrowth();

    this.metrics = {
      jsHeapUsedMB: Math.round(jsHeapUsedMB),
      jsHeapLimitMB: Math.round(jsHeapLimitMB),
      geometryCount,
      textureCount,
      geometryMB,
      textureMB,
      renderTargetMB,
      gpuTotalMB,
      meshCount,
      instancedMeshCount,
      totalInstances,
      gpuGrowthMBPerMin: round1(gpuGrowth),
      heapGrowthMBPerMin: round1(heapGrowth),
      leakSuspected,
    };

    // ---- Warnings ----
    if (gpuTotalMB > GPU_CRITICAL_MB && !this.warnedCritical) {
      this.warnedCritical = true;
      console.warn(
        `%c[MemoryProfiler] CRITICAL GPU MEMORY: ~${gpuTotalMB.toFixed(0)} MB — crash is likely`,
        'color: #ff4444; font-weight: bold; font-size: 13px',
      );
      this.dumpToConsole();
    } else if (gpuTotalMB > GPU_WARN_MB && !this.warnedHigh) {
      this.warnedHigh = true;
      console.warn(
        `%c[MemoryProfiler] HIGH GPU MEMORY: ~${gpuTotalMB.toFixed(0)} MB`,
        'color: #d29922; font-weight: bold',
      );
    }

    if (leakSuspected && !this.warnedLeak) {
      this.warnedLeak = true;
      console.warn(
        '%c[MemoryProfiler] LEAK SUSPECTED — sustained memory growth detected',
        'color: #ff4444; font-weight: bold; font-size: 13px',
      );
      this.dumpToConsole();
    }

    // ---- Persist for crash recovery ----
    this.saveCrashSnapshot();

    return this.metrics;
  }

  getMetrics(): MemoryMetrics {
    return this.metrics;
  }

  /**
   * Print a detailed memory breakdown to the browser console.
   * Callable from the stats panel or via `window.__cityViewerDump()`.
   */
  dumpToConsole(): void {
    const m = this.metrics;

    console.group('%c[MemoryProfiler] Detailed Memory Dump', 'color: #3fb950; font-weight: bold');

    console.log('--- JS Heap ---');
    console.log(`  Used: ${m.jsHeapUsedMB} MB / Limit: ${m.jsHeapLimitMB} MB`);

    console.log('--- Estimated GPU Memory ---');
    console.log(`  Geometry buffers (JS+GPU): ${m.geometryMB} MB  (${m.geometryCount} geometries)`);
    console.log(`  Textures:                  ${m.textureMB} MB  (${m.textureCount} textures)`);
    console.log(`  Render targets:            ${m.renderTargetMB} MB`);
    console.log(`  TOTAL (estimated):         ${m.gpuTotalMB} MB`);

    console.log('--- Scene Graph ---');
    console.log(`  Meshes: ${m.meshCount}  (${m.instancedMeshCount} instanced, ${m.totalInstances} total instances)`);

    console.log('--- Memory Trend ---');
    console.log(`  GPU growth:  ${m.gpuGrowthMBPerMin >= 0 ? '+' : ''}${m.gpuGrowthMBPerMin} MB/min`);
    console.log(`  Heap growth: ${m.heapGrowthMBPerMin >= 0 ? '+' : ''}${m.heapGrowthMBPerMin} MB/min`);
    if (m.leakSuspected) {
      console.warn('  *** LEAK SUSPECTED — memory has been growing consistently ***');
    }

    const deviceMem = getDeviceMemoryGB();
    if (deviceMem) {
      const totalEstMB = m.gpuTotalMB + m.jsHeapUsedMB;
      const pct = (totalEstMB / (deviceMem * 1024)) * 100;
      console.log(`--- System ---`);
      console.log(`  Device memory: ~${deviceMem} GB`);
      console.log(`  Est. memory pressure: ${pct.toFixed(1)}% of reported device memory`);
    }

    console.log('--- Snapshot History ---');
    console.table(
      this.snapshots.map((s, i) => ({
        '#': i,
        'Age (s)': round1((performance.now() - s.time) / 1000),
        'GPU (MB)': s.gpuMB,
        'Heap (MB)': Math.round(s.heapMB),
      })),
    );

    console.groupEnd();
  }

  dispose(): void {
    this.snapshots = [];
    // Clean shutdown — remove the crash snapshot so the next session
    // doesn't falsely report "previous session" data.
    try { localStorage.removeItem(CRASH_SNAPSHOT_KEY); } catch { /* ignore */ }
  }

  /* ---- Internals --------------------------------------------------------- */

  private computeGrowth(): {
    gpuGrowth: number;
    heapGrowth: number;
    leakSuspected: boolean;
  } {
    if (this.snapshots.length < LEAK_MIN_SAMPLES) {
      return { gpuGrowth: 0, heapGrowth: 0, leakSuspected: false };
    }

    const first = this.snapshots[0]!;
    const last = this.snapshots[this.snapshots.length - 1]!;
    const elapsedMin = (last.time - first.time) / 60_000;
    if (elapsedMin < 0.25) {
      return { gpuGrowth: 0, heapGrowth: 0, leakSuspected: false };
    }

    const gpuGrowth = (last.gpuMB - first.gpuMB) / elapsedMin;
    const heapGrowth = (last.heapMB - first.heapMB) / elapsedMin;

    // Consistently growing? (> 70% of intervals positive)
    let rising = 0;
    for (let i = 1; i < this.snapshots.length; i++) {
      if (this.snapshots[i]!.gpuMB > this.snapshots[i - 1]!.gpuMB) rising++;
    }
    const consistent = rising > this.snapshots.length * 0.7;
    const leakSuspected =
      consistent &&
      (gpuGrowth > LEAK_THRESHOLD_MB_PER_MIN || heapGrowth > LEAK_THRESHOLD_MB_PER_MIN);

    return { gpuGrowth, heapGrowth, leakSuspected };
  }

  private saveCrashSnapshot(): void {
    try {
      const mem = getPerformanceMemory();
      const deviceGB = getDeviceMemoryGB();
      const m = this.metrics;
      const payload = {
        ts: new Date().toISOString(),
        uptimeSec: Math.round((performance.now() - (this.snapshots[0]?.time ?? performance.now())) / 1000),
        // JS Heap
        jsHeapUsedMB: m.jsHeapUsedMB,
        jsHeapLimitMB: m.jsHeapLimitMB,
        jsHeapGrowthSinceBaselineMB: Math.round(getHeapGrowthMB()),
        // GPU estimates
        geometryCount: m.geometryCount,
        textureCount: m.textureCount,
        geometryMB: m.geometryMB,
        textureMB: m.textureMB,
        renderTargetMB: m.renderTargetMB,
        gpuTotalMB: m.gpuTotalMB,
        // Scene
        meshCount: m.meshCount,
        instancedMeshCount: m.instancedMeshCount,
        totalInstances: m.totalInstances,
        // Trends
        gpuGrowthMBPerMin: m.gpuGrowthMBPerMin,
        heapGrowthMBPerMin: m.heapGrowthMBPerMin,
        leakSuspected: m.leakSuspected,
        // System context
        deviceMemoryGB: deviceGB ?? null,
        jsHeapTotalMB: mem ? Math.round(mem.totalJSHeapSize / (1024 * 1024)) : null,
        // Estimated real process impact (textures decoded in native memory ≈ 2x GPU texture estimate)
        estimatedProcessMB: Math.round(m.jsHeapUsedMB + m.textureMB * 2 + m.geometryMB),
        // Snapshot history (last 5 readings for trend)
        recentHistory: this.snapshots.slice(-5).map(s => ({
          ageSec: Math.round((performance.now() - s.time) / 1000),
          gpuMB: s.gpuMB,
          heapMB: Math.round(s.heapMB),
        })),
      };
      localStorage.setItem(CRASH_SNAPSHOT_KEY, JSON.stringify(payload));
    } catch {
      // localStorage may be full or unavailable
    }
  }

  private logPreviousSession(): void {
    try {
      const raw = localStorage.getItem(CRASH_SNAPSHOT_KEY);
      if (!raw) return;
      const prev = JSON.parse(raw);
      console.log(
        '%c[MemoryProfiler] Previous session snapshot (from %s, uptime %ss):',
        'color: #d29922; font-weight: bold',
        prev.ts,
        prev.uptimeSec ?? '?',
      );
      console.table({
        'JS Heap Used (MB)': prev.jsHeapUsedMB,
        'JS Heap Total (MB)': prev.jsHeapTotalMB,
        'JS Heap Limit (MB)': prev.jsHeapLimitMB,
        'Heap Growth Since Baseline (MB)': prev.jsHeapGrowthSinceBaselineMB,
        'GPU Total est. (MB)': prev.gpuTotalMB,
        '  Geometry (MB)': prev.geometryMB,
        '  Textures (MB)': `${prev.textureMB} (${prev.textureCount} textures)`,
        '  Render Targets (MB)': prev.renderTargetMB,
        'Meshes': `${prev.meshCount} (${prev.instancedMeshCount} instanced, ${prev.totalInstances} instances)`,
        'GPU Growth (MB/min)': prev.gpuGrowthMBPerMin,
        'Heap Growth (MB/min)': prev.heapGrowthMBPerMin,
        'Leak Suspected': prev.leakSuspected,
        'Device Memory (GB)': prev.deviceMemoryGB,
        'Est. Process Impact (MB)': prev.estimatedProcessMB,
      });
      if (prev.recentHistory?.length) {
        console.log('Recent trend (oldest → newest):');
        console.table(prev.recentHistory);
      }
      localStorage.removeItem(CRASH_SNAPSHOT_KEY);
    } catch {
      // ignore
    }
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
