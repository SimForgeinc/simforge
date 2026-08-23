/**
 * Reconciliation poller — drift detection between accounted and actual
 * GPU memory.
 *
 * The {@link BudgetLedger} (issue #02) tracks memory via accounting only —
 * activate adds, evict subtracts. Anything that allocates GPU memory
 * outside the tile pipeline (leaked textures, render-target growth on
 * viewport resize, environment maps, dynamic materials) drifts the ledger
 * from reality silently.
 *
 * This poller traverses the scene graph at a fixed interval (3 s by
 * default), sums the actually-resident bytes, compares to the ledger's
 * `currentBytes`, and corrects the ledger when drift exceeds 10%. It does
 * NOT pause loading or evict tiles — that is the degradation controller's
 * job (issue #06). The poller's job is to keep the ledger truthful.
 *
 * See `.scratch/streaming-budget-pacing/issues/07-reconciliation-poller.md`.
 */

import * as THREE from "three/webgpu";

import type { BudgetLedger } from "./budget-ledger";
import { estimateRenderTargetBytes } from "./budget-ledger";

const DEFAULT_INTERVAL_MS = 3_000;
const DEFAULT_DRIFT_THRESHOLD = 0.10;
const BYTES_PER_MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Scene-graph measurement
// ---------------------------------------------------------------------------

interface ImageLikeSource {
  width?: number;
  height?: number;
  videoWidth?: number;
  videoHeight?: number;
}

interface TextureLike {
  id: number;
  generateMipmaps?: boolean;
  type?: number;
  isCubeTexture?: boolean;
  source?: { data?: ImageLikeSource };
  image?: ImageLikeSource;
}

interface AttributeLike {
  array?: { byteLength: number };
}

interface GeometryLike {
  id: number;
  attributes: Record<string, AttributeLike | undefined>;
  index?: AttributeLike;
}

interface MeshLike {
  isMesh?: boolean;
  isInstancedMesh?: boolean;
  count?: number;
  instanceMatrix?: AttributeLike;
  instanceColor?: AttributeLike;
  geometry?: GeometryLike;
  material?: unknown;
}

interface SceneLike {
  traverse(cb: (obj: MeshLike) => void): void;
  environment?: TextureLike | null;
  background?: unknown;
}

interface RendererLike {
  getSize(target: THREE.Vector2): { x: number; y: number };
}

export interface SceneGraphMeasureInput {
  renderer: RendererLike;
  scene: SceneLike;
  quality: {
    shadows: boolean;
    shadowResolution: number;
    postProcessing: boolean;
  };
}

function getTextureSource(tex: TextureLike): ImageLikeSource | null {
  return tex.source?.data ?? tex.image ?? null;
}

function estimateTextureBytes(tex: TextureLike): number {
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
  if (tex.isCubeTexture) bytes *= 6;

  return bytes;
}

function isTextureLike(value: unknown): value is TextureLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof (value as { id: unknown }).id === "number" &&
    ("source" in value || "image" in value)
  );
}

/**
 * Measure actually-resident GPU bytes by traversing the scene graph and
 * summing texture, geometry, and render-target contributions. Mirrors the
 * per-frame estimate in `MemoryProfiler.collect` (see `memory-profiler.ts`)
 * but is a pure function with no internal throttling — the reconciliation
 * poller drives the cadence.
 */
export function measureSceneGraphBytes(input: SceneGraphMeasureInput): number {
  const { renderer, scene, quality } = input;

  let geometryBytes = 0;
  let textureBytes = 0;
  const seenGeo = new Set<number>();
  const seenTex = new Set<number>();

  scene.traverse((obj) => {
    if (!obj?.isMesh) return;

    const geo = obj.geometry;
    if (geo && !seenGeo.has(geo.id)) {
      seenGeo.add(geo.id);
      for (const attr of Object.values(geo.attributes)) {
        if (attr?.array) geometryBytes += attr.array.byteLength;
      }
      if (geo.index?.array) geometryBytes += geo.index.array.byteLength;
      if (obj.isInstancedMesh) {
        if (obj.instanceMatrix?.array) {
          geometryBytes += obj.instanceMatrix.array.byteLength;
        }
        if (obj.instanceColor?.array) {
          geometryBytes += obj.instanceColor.array.byteLength;
        }
      }
    }

    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (!mat || typeof mat !== "object") continue;
      for (const val of Object.values(mat as Record<string, unknown>)) {
        if (!isTextureLike(val)) continue;
        if (seenTex.has(val.id)) continue;
        seenTex.add(val.id);
        textureBytes += estimateTextureBytes(val);
      }
    }
  });

  if (scene.environment && !seenTex.has(scene.environment.id)) {
    seenTex.add(scene.environment.id);
    textureBytes += estimateTextureBytes(scene.environment);
  }
  if (isTextureLike(scene.background) && !seenTex.has(scene.background.id)) {
    seenTex.add(scene.background.id);
    textureBytes += estimateTextureBytes(scene.background);
  }

  const size = renderer.getSize(new THREE.Vector2());
  const renderTargetBytes = estimateRenderTargetBytes({
    width: size.x,
    height: size.y,
    shadows: quality.shadows,
    shadowResolution: quality.shadowResolution,
    postProcessing: quality.postProcessing,
  });

  return geometryBytes * 2 + textureBytes + renderTargetBytes;
}

export interface ReconciliationPollerOptions {
  ledger: BudgetLedger;
  /**
   * Returns the actually-resident GPU bytes from a fresh scene-graph
   * traversal. Injected so the poller is testable without a real renderer.
   * In production, callers wire this to `measureSceneGraphBytes`.
   */
  measure: () => number;
  /** Reports the latest drift (in MB, signed) on every poll. */
  onDrift?: (deltaMB: number) => void;
  /** Polling interval in milliseconds. Defaults to 3000. */
  intervalMs?: number;
  /**
   * Drift threshold, as a fraction of tracked bytes. Drift above this
   * triggers a warning + ledger correction. Defaults to 0.10 (10%).
   */
  driftThreshold?: number;
}

export class ReconciliationPoller {
  private readonly ledger: BudgetLedger;
  private readonly measure: () => number;
  private readonly onDrift: (deltaMB: number) => void;
  private readonly intervalMs: number;
  private readonly driftThreshold: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private _lastDriftMB = 0;

  constructor(opts: ReconciliationPollerOptions) {
    this.ledger = opts.ledger;
    this.measure = opts.measure;
    this.onDrift = opts.onDrift ?? (() => {});
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.driftThreshold = opts.driftThreshold ?? DEFAULT_DRIFT_THRESHOLD;
  }

  start(): void {
    if (this.disposed || this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  /**
   * Run one reconciliation pass. Exposed for the render loop and tests.
   * Always reports drift via the callback; corrects the ledger and warns
   * only when |delta| / max(tracked, 1) > driftThreshold.
   */
  poll(): void {
    const actual = this.measure();
    const tracked = this.ledger.currentBytes;
    const deltaBytes = actual - tracked;
    const deltaMB = deltaBytes / BYTES_PER_MB;
    this._lastDriftMB = Math.round(Math.abs(deltaMB) * 10) / 10;
    this.onDrift(Math.round(deltaMB * 10) / 10);

    const denom = Math.max(tracked, 1);
    if (Math.abs(deltaBytes) / denom <= this.driftThreshold) return;

    console.warn(
      `[ReconciliationPoller] ledger drift detected — actual=${(actual / BYTES_PER_MB).toFixed(1)} MB, ` +
        `tracked=${(tracked / BYTES_PER_MB).toFixed(1)} MB, delta=${(deltaMB >= 0 ? "+" : "")}${deltaMB.toFixed(1)} MB. ` +
        `Correcting ledger.`,
    );
    this.ledger.reconcile(actual);
  }

  get lastDriftMB(): number {
    return this._lastDriftMB;
  }
}
