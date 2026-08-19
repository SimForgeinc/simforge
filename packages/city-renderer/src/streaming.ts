import { Box3, Group, Vector3 } from 'three';
import type { Camera, Object3D, Texture, WebGLRenderer, Scene } from 'three';
import type { ManifestLod } from './types';
import type { AssetResources } from './gltf';
import { disposeResources, uploadTexture } from './gltf';
import { estimateLodBytes } from './manifest';

export interface StreamTileDef {
  id: string;
  box: Box3;
  /** LODs sorted coarse-first: index 0 is the cheapest fallback. */
  lods: ManifestLod[];
  /** Anything the asset builder needs (instance data, grid coords, ...). */
  userData?: unknown;
}

export interface PreparedAsset {
  object: Object3D;
  resources: AssetResources;
  bytes: number;
  /** Textures still to be pushed to the GPU, drained by the upload pacer. */
  pendingTextures: Texture[];
  /** Called on eviction, after the object leaves the scene graph. */
  dispose?: () => void;
}

export type AssetBuilder = (
  def: StreamTileDef,
  lod: ManifestLod,
  signal: AbortSignal,
) => Promise<PreparedAsset>;

interface Entry {
  def: StreamTileDef;
  resident: Map<number, PreparedAsset>;
  displayed: number;
  /** Wanted LOD index, or -1 when the tile should not be resident at all. */
  desired: number;
  loading: { index: number; controller: AbortController } | null;
  /** Decoded/uploading/compiling LOD. Prevents duplicate fetches before swap-in. */
  preparing: number | null;
  /** The current desired LOD cannot fit without evicting another desired LOD. */
  budgetBlocked: boolean;
  failures: number;
  /** Pixels of error we would win by loading `desired`. */
  gain: number;
  distance: number;
}

export interface EvictionCandidate {
  layer: TileStreamLayer;
  entryId: string;
  index: number;
  bytes: number;
  score: number;
}

export interface LayerStats {
  residentTiles: number;
  residentAssets: number;
  bytes: number;
  pendingBytes: number;
  loading: number;
  queued: number;
  uploading: number;
}

export interface MemoryGovernor {
  /**
   * True if `bytes` more may be brought in right now. `priority` is the
   * requester's eviction score (smaller = more valuable); the governor may only
   * evict assets that score worse than that, which is what stops a distant tile
   * from kicking out a near one and thrashing the pipe.
   */
  admit(bytes: number, priority: number): boolean;
  /** Largest single asset worth holding; coarser LODs are used above this. */
  maxAssetBytes(): number;
}

export interface TileStreamLayerOptions {
  name: string;
  renderer: WebGLRenderer;
  scene: Scene;
  defs: StreamTileDef[];
  build: AssetBuilder;
  maxConcurrent: number;
  /** Shared byte ledger; keeps in-flight decodes from blowing past the budget. */
  memory: MemoryGovernor;
  /**
   * Load the coarsest LOD of every tile before anything finer is fetched, and
   * never evict it. Used for the city so the full map is on screen in the first
   * seconds and no tile can ever disappear.
   */
  pinCoarsest: boolean;
  /** Infrastructure such as the single road/ground asset must load even when its conservative estimate exceeds the quality budget. */
  essentialCoarsest?: boolean;
  /** Every LOD is required (used by progressive road fidelity, not optional city detail). */
  essentialAll?: boolean;
  /** Return false to keep a tile unloaded entirely (vegetation range limit). */
  want?: (def: StreamTileDef, distance: number) => boolean;
  /** Dynamic upper LOD bound for runtime fidelity modes. */
  maxDesiredIndex?: (def: StreamTileDef) => number;
  /** Called after a new LOD becomes the displayed one. */
  onDisplay?: (def: StreamTileDef, asset: PreparedAsset, index: number) => void;
  /** Called every frame for the displayed asset (vegetation density LOD). */
  onTick?: (def: StreamTileDef, asset: PreparedAsset, distance: number, index: number) => void;
}

const MAX_FAILURES = 2;
const MAX_UPLOAD_BACKLOG = 3;

/**
 * Screen-space-error driven LOD streaming for one class of tiles.
 *
 * Selection is the 3D-Tiles rule: project a LOD's geometric error to pixels
 * (`error * screenHeight / (distance * 2 * tan(fov/2))`) and take the coarsest
 * LOD whose projected error is under the threshold. Fetches are ordered by the
 * error a tile would *win*, so the tile that is worst on screen goes first.
 * Nothing is removed before its replacement is on the GPU, and with
 * `pinCoarsest` index 0 stays resident forever, so a tile can never become a
 * hole.
 */
export class TileStreamLayer {
  readonly group = new Group();
  readonly entries = new Map<string, Entry>();

  private readonly opts: TileStreamLayerOptions;
  private readonly uploadQueue: { entry: Entry; index: number; asset: PreparedAsset }[] = [];
  /**
   * Shader compilation is asynchronous inside Three.js and cannot be aborted.
   * Keep the promises so the owning viewer can leave its WebGL renderer alive
   * until Three's readiness poll has finished during a map teardown.
   */
  private readonly compilationJobs = new Set<Promise<void>>();
  private readonly compiling = new Map<PreparedAsset, { id: string; startedMs: number }>();
  private bytes = 0;
  private pending = 0;
  private disposed = false;
  private generation = 0;
  private bootstrapped: boolean;

  constructor(opts: TileStreamLayerOptions) {
    this.opts = opts;
    this.group.name = opts.name;
    this.bootstrapped = !opts.pinCoarsest;
    for (const def of opts.defs) {
      this.entries.set(def.id, {
        def,
        resident: new Map(),
        displayed: -1,
        desired: 0,
        loading: null,
        preparing: null,
        budgetBlocked: false,
        failures: 0,
        gain: Infinity,
        distance: Infinity,
      });
    }
  }

  get residentBytes(): number {
    return this.bytes;
  }

  /** Estimated bytes of assets that are decoding or waiting on the GPU. */
  get pendingBytes(): number {
    return this.pending;
  }

  /** True once every tile has its coarsest LOD on screen. */
  get ready(): boolean {
    return this.bootstrapped;
  }

  /** Retry optional detail after the caller changes the shared memory budget. */
  clearBudgetBlocks(): void {
    for (const entry of this.entries.values()) entry.budgetBlocked = false;
  }

  stats(): LayerStats {
    let residentTiles = 0;
    let residentAssets = 0;
    let queued = 0;
    let loading = 0;
    for (const entry of this.entries.values()) {
      if (entry.resident.size > 0) residentTiles++;
      residentAssets += entry.resident.size;
      if (entry.loading) loading++;
      else if (entry.preparing === null && !entry.budgetBlocked && entry.desired > this.finestResident(entry)) queued++;
    }
    return {
      residentTiles,
      residentAssets,
      bytes: this.bytes,
      pendingBytes: this.pending,
      loading,
      queued,
      uploading: this.uploadQueue.length + this.compiling.size,
    };
  }

  /**
   * Names the units behind a non-zero `uploading` stat: which tiles wait in the
   * upload queue and which sit in shader compilation, with ages. Exists so a
   * capture-readiness refusal can say *what* is stuck instead of a bare count -
   * a compile that never resolves (e.g. across a lost GL context) is otherwise
   * indistinguishable from a starved upload queue.
   */
  pendingDetail(now = performance.now()): string[] {
    const detail: string[] = [];
    for (const job of this.uploadQueue) {
      detail.push(`upload ${job.entry.def.id}#lod${job.index} (${job.asset.pendingTextures.length} tex)`);
    }
    for (const [asset, meta] of this.compiling) {
      detail.push(`compile ${meta.id} for ${((now - meta.startedMs) / 1000).toFixed(1)}s`);
    }
    return detail;
  }

  private finestResident(entry: Entry): number {
    let best = -1;
    for (const index of entry.resident.keys()) if (index > best) best = index;
    return best;
  }

  /**
   * Refreshes desired LODs, starts/cancels fetches and swaps ready assets in.
   * `sseScale` is `screenHeight / (2 * tan(fov / 2))`.
   */
  update(cameraPos: Vector3, sseScale: number, maxSse: number): void {
    if (this.disposed) return;

    let bootstrapped = true;
    for (const entry of this.entries.values()) {
      const distance = Math.max(1e-3, entry.def.box.distanceToPoint(cameraPos));
      const previousDistance = entry.distance;
      entry.distance = distance;
      const lods = entry.def.lods;

      const wanted = this.opts.want ? this.opts.want(entry.def, distance) : true;
      let desired = -1;
      if (wanted && entry.failures < MAX_FAILURES) {
        desired = lods.length - 1;
        for (let i = 0; i < lods.length; i++) {
          const err = lods[i]?.geometricError ?? 0;
          if ((err * sseScale) / distance <= maxSse) {
            desired = i;
            break;
          }
        }
        // A single asset that would eat most of the budget is never worth it:
        // one LOD0 tile in this dataset can be ~900 MB of RGBA.
        if (!this.opts.essentialAll) {
          const cap = this.opts.memory.maxAssetBytes();
          while (desired > 0) {
            const candidate = lods[desired];
            if (!candidate || estimateLodBytes(candidate) <= cap) break;
            desired--;
          }
        }
        if (this.opts.maxDesiredIndex) desired = Math.min(desired, this.opts.maxDesiredIndex(entry.def));
        if (!this.bootstrapped) desired = 0;
      }
      if (desired !== entry.desired
        || (Number.isFinite(previousDistance) && Math.abs(distance - previousDistance) > Math.max(10, previousDistance * 0.2))) {
        entry.budgetBlocked = false;
      }
      entry.desired = desired;

      if (this.opts.pinCoarsest && !entry.resident.has(0) && entry.failures < MAX_FAILURES) {
        bootstrapped = false;
      }

      const finest = this.finestResident(entry);
      const currentErr = finest >= 0 ? (lods[finest]?.geometricError ?? 0) : Infinity;
      const desiredErr = desired >= 0 ? (lods[desired]?.geometricError ?? 0) : 0;
      entry.gain = ((currentErr - desiredErr) * sseScale) / distance;

      // A queued fetch nobody wants any more (camera moved away) is dropped
      // instead of finished — it would only burn budget on an evictable LOD.
      if (entry.loading && entry.loading.index > Math.max(desired, finest)) {
        entry.loading.controller.abort();
        entry.loading = null;
      }
    }
    this.bootstrapped = this.bootstrapped || bootstrapped;

    this.pumpFetches();
  }

  private pumpFetches(): void {
    // A decoded asset holds its whole texture set as ImageBitmaps until the
    // pacer uploads it. Letting the fetchers run ahead of the (deliberately
    // slow) upload pacer is how the transient footprint explodes, so the
    // backlog is capped.
    if (this.uploadQueue.length >= MAX_UPLOAD_BACKLOG) return;
    let active = 0;
    for (const entry of this.entries.values()) if (entry.loading) active++;
    if (active >= this.opts.maxConcurrent) return;

    const wanted: Entry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.loading || entry.preparing !== null || entry.budgetBlocked || entry.desired < 0) continue;
      if (entry.desired <= this.finestResident(entry)) continue;
      if (entry.resident.has(entry.desired)) continue;
      wanted.push(entry);
    }
    if (wanted.length === 0) return;
    // Biggest screen-space win first; not-yet-loaded tiles (gain Infinity) lead.
    wanted.sort((a, b) => b.gain - a.gain || a.distance - b.distance);

    for (const entry of wanted) {
      if (active >= this.opts.maxConcurrent) break;
      // Admission can refuse (budget full); try the next tile instead of stalling.
      if (this.startLoad(entry, entry.desired)) active++;
    }
  }

  private startLoad(entry: Entry, index: number): boolean {
    const lod = entry.def.lods[index];
    if (!lod) return false;
    const estimate = estimateLodBytes(lod);
    const essential = this.opts.essentialAll === true
      || (this.opts.essentialCoarsest === true && index === 0);
    if (!essential && !this.opts.memory.admit(estimate, entry.distance)) {
      entry.budgetBlocked = true;
      return false;
    }
    this.pending += estimate;
    const controller = new AbortController();
    const generation = this.generation;
    entry.loading = { index, controller };
    this.opts
      .build(entry.def, lod, controller.signal)
      .then((asset) => {
        if (generation === this.generation) entry.loading = null;
        this.pending -= estimate;
        if (this.disposed || controller.signal.aborted) {
          asset.dispose?.();
          disposeResources(asset.resources);
          return;
        }
        entry.preparing = index;
        this.pending += asset.bytes;
        this.uploadQueue.push({ entry, index, asset });
      })
      .catch((err: unknown) => {
        if (generation === this.generation) entry.loading = null;
        this.pending -= estimate;
        if (!controller.signal.aborted && !this.disposed) {
          entry.failures++;
          console.error(`[city-renderer] ${entry.def.id} lod${lod.level} failed`, err);
        }
      });
    return true;
  }

  /**
   * Pushes queued textures to the GPU under a per-frame time budget so a 140 MB
   * LOD0 tile cannot stall a frame, then compiles and swaps the asset in.
   */
  pumpUploads(deadline: number, pixelBudget: { remaining: number }, camera: Camera): void {
    if (this.disposed || this.uploadQueue.length === 0) return;
    this.uploadQueue.sort(
      (a, b) => b.entry.gain - a.entry.gain || a.entry.distance - b.entry.distance,
    );
    while (this.uploadQueue.length > 0 && performance.now() < deadline && pixelBudget.remaining > 0) {
      const job = this.uploadQueue[0];
      if (!job) break;
      const tex = job.asset.pendingTextures.pop();
      if (tex) {
        const image = tex.image as { width?: number; height?: number } | undefined;
        // Charged before the upload so one 2048px texture (~4.2 Mpx, the
        // dominant cost at LOD0/LOD1) is all a frame ever does.
        pixelBudget.remaining -= (image?.width ?? 0) * (image?.height ?? 0);
        uploadTexture(this.opts.renderer, tex);
        continue;
      }
      this.uploadQueue.shift();
      this.pending -= job.asset.bytes;
      this.finishAsset(job.entry, job.index, job.asset, camera);
    }
  }

  private finishAsset(entry: Entry, index: number, asset: PreparedAsset, camera: Camera): void {
    asset.object.updateMatrixWorld(true);
    this.compiling.set(asset, { id: `${entry.def.id}#lod${index}`, startedMs: performance.now() });
    this.pending += asset.bytes;
    const job = this.opts.renderer
      .compileAsync(asset.object, camera, this.opts.scene)
      .catch((error: unknown) => {
        // A compile failure is still useful diagnostic information. Disposal is
        // the only expected cancellation path, and compileAsync itself has no
        // AbortSignal, so do not turn unrelated failures into silent success.
        if (!this.disposed) console.error(`[city-renderer] ${entry.def.id} shader compilation failed`, error);
      })
      .then((): void => {
        this.compiling.delete(asset);
        this.pending -= asset.bytes;
        if (entry.preparing === index) entry.preparing = null;
        if (this.disposed) {
          asset.dispose?.();
          disposeResources(asset.resources);
          return;
        }
        this.swapIn(entry, index, asset);
      });
    this.compilationJobs.add(job);
    void job.then(
      () => this.compilationJobs.delete(job),
      (error: unknown) => {
        this.compilationJobs.delete(job);
        console.error(`[city-renderer] ${entry.def.id} compilation finalization failed`, error);
      },
    );
  }

  /** Resolves after all non-cancellable Three.js shader polls have stopped. */
  whenCompilationIdle(): Promise<void> {
    return Promise.allSettled([...this.compilationJobs]).then(() => undefined);
  }

  /** Drop every resident/uploaded asset so a source-variant change can rebuild the layer. */
  async resetAssets(): Promise<void> {
    if (this.disposed) return;
    await this.whenCompilationIdle();
    if (this.disposed) return;
    this.generation++;
    for (const entry of this.entries.values()) {
      entry.loading?.controller.abort();
      entry.loading = null;
      entry.preparing = null;
      entry.budgetBlocked = false;
      for (const asset of entry.resident.values()) {
        this.group.remove(asset.object);
        asset.dispose?.();
        disposeResources(asset.resources);
      }
      entry.resident.clear();
      entry.displayed = -1;
      entry.failures = 0;
      entry.gain = Infinity;
    }
    for (const job of this.uploadQueue.splice(0)) {
      this.pending -= job.asset.bytes;
      job.asset.dispose?.();
      disposeResources(job.asset.resources);
    }
    this.bytes = 0;
    this.pending = Math.max(0, this.pending);
    this.bootstrapped = !this.opts.pinCoarsest;
    this.group.clear();
  }

  private swapIn(entry: Entry, index: number, asset: PreparedAsset): void {
    if (entry.resident.has(index)) {
      asset.dispose?.();
      disposeResources(asset.resources);
      return;
    }
    entry.resident.set(index, asset);
    this.bytes += asset.bytes;

    if (index > entry.displayed) {
      const old = entry.displayed >= 0 ? entry.resident.get(entry.displayed) : undefined;
      this.group.add(asset.object);
      if (old) this.group.remove(old.object);
      entry.displayed = index;
      this.opts.onDisplay?.(entry.def, asset, index);
    }

    // Keep at most the pinned fallback plus whatever is on screen.
    for (const [level, resident] of [...entry.resident]) {
      if (level === entry.displayed) continue;
      if (level === 0 && this.opts.pinCoarsest) continue;
      entry.resident.delete(level);
      this.bytes -= resident.bytes;
      this.group.remove(resident.object);
      resident.dispose?.();
      disposeResources(resident.resources);
    }
  }

  /** Per-frame hook for LOD behaviour that needs no reload (veg density/range). */
  tickDisplayed(): void {
    const onTick = this.opts.onTick;
    if (!onTick) return;
    for (const entry of this.entries.values()) {
      if (entry.displayed < 0) continue;
      const asset = entry.resident.get(entry.displayed);
      if (asset) onTick(entry.def, asset, entry.distance, entry.displayed);
    }
  }

  evictionCandidates(out: EvictionCandidate[]): void {
    for (const entry of this.entries.values()) {
      for (const [index, asset] of entry.resident) {
        if (index === 0 && this.opts.pinCoarsest) continue; // never evicted
        // Evicting the exact asset this stationary view still wants creates an
        // endless fetch -> upload -> eviction loop. Refuse the new admission
        // instead; a camera/quality change will make it eligible later.
        if (index === entry.desired) continue;
        const unwanted = entry.desired < 0 ? 100 : index > entry.desired ? 5 : 1;
        out.push({
          layer: this,
          entryId: entry.def.id,
          index,
          bytes: asset.bytes,
          score: entry.distance * unwanted,
        });
      }
    }
  }

  evict(candidate: EvictionCandidate): number {
    const entry = this.entries.get(candidate.entryId);
    const asset = entry?.resident.get(candidate.index);
    if (!entry || !asset) return 0;
    entry.resident.delete(candidate.index);
    this.bytes -= asset.bytes;
    this.group.remove(asset.object);
    if (entry.displayed === candidate.index) {
      const fallback = entry.resident.get(0);
      if (fallback) {
        this.group.add(fallback.object);
        entry.displayed = 0;
      } else {
        entry.displayed = -1;
      }
    }
    asset.dispose?.();
    disposeResources(asset.resources);
    return asset.bytes;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.loading?.controller.abort();
      entry.preparing = null;
      for (const asset of entry.resident.values()) {
        this.group.remove(asset.object);
        asset.dispose?.();
        disposeResources(asset.resources);
      }
      entry.resident.clear();
    }
    for (const job of this.uploadQueue) {
      job.asset.dispose?.();
      disposeResources(job.asset.resources);
    }
    this.uploadQueue.length = 0;
    this.pending = 0;
    this.group.clear();
    this.entries.clear();
    this.bytes = 0;
  }
}

export function boxOf(min: number[], max: number[]): Box3 {
  return new Box3(
    new Vector3(min[0] ?? 0, min[1] ?? 0, min[2] ?? 0),
    new Vector3(max[0] ?? 0, max[1] ?? 0, max[2] ?? 0),
  );
}

export type { Object3D };
