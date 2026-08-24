import * as THREE from 'three/webgpu';

export type TextureKey = string;

/**
 * Derive a stable cross-parse content identity for a parsed texture. Returns
 * null when no stable key can be derived (in which case the texture is left
 * un-pooled). Belmont's GLBs name every texture; the URL fallback handles the
 * rare case of a name-less texture that still has an identifiable image src.
 *
 * Pixel dimensions are folded into the name-based key because Three.js's
 * GLTFLoader copies `gltf.images[].name` onto every texture sharing that
 * image. Belmont's per-LOD GLBs reuse the same source filenames at different
 * resolutions (e.g. LOD0 ships `b_01_st_basecolor.tga` at 2048², LOD3 at
 * 256²). A name-only key would collapse them and rewrite LOD0 material slots
 * to the LOD3 low-res canonical that the preload cached first — the
 * user-visible "buildings render at coarse / glass LOD with budget headroom"
 * symptom (ABH-110). Including `WxH` keeps cross-tile dedupe at the same LOD
 * intact while preventing the LOD3 → LOD0 poisoning.
 */
function textureKey(tex: THREE.Texture): TextureKey | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const img = (tex.source as any)?.data ?? tex.image;
  const w = img?.naturalWidth ?? img?.width ?? 0;
  const h = img?.naturalHeight ?? img?.height ?? 0;
  if (tex.name) {
    if (w > 0 && h > 0) return `n:${tex.name}:${w}x${h}`;
    // Dimensions not yet known — refuse to pool so we don't risk collapsing
    // textures whose content we can't compare. Returning null leaves the
    // caller's slot pointing at its own instance.
    return null;
  }
  const src = img?.src;
  if (typeof src === 'string' && src.length > 0) return `s:${src}`;
  return null;
}

export interface TextureRegistrationCallback {
  (key: TextureKey, bytes: number): void;
}

/**
 * Paired with `TextureRegistrationCallback`. Fires when a pooled texture's
 * refcount transitions 1 → 0 — i.e. its last referencing tile released. The
 * orchestrator wires this to `BudgetLedger.unregisterStaticAllocation` so
 * the static-allocation book debits in real time when the canonical texture
 * is actually released. Without this seam the pool's static registrations
 * accumulated monotonically as referencing tiles cycled through the cache,
 * producing the negative drift symptom in ABH-112.
 */
export interface TextureUnregistrationCallback {
  (key: TextureKey): void;
}

let registrationCb: TextureRegistrationCallback | null = null;
let unregistrationCb: TextureUnregistrationCallback | null = null;

export function setTextureRegistrationCallback(
  cb: TextureRegistrationCallback | null,
): void {
  registrationCb = cb;
}

export function setTextureUnregistrationCallback(
  cb: TextureUnregistrationCallback | null,
): void {
  unregistrationCb = cb;
}

/**
 * Minimum surface area the cross-tile dedupe seam needs to defer
 * disposal of a redundant texture (ABH-111). Matches
 * `DeferredDisposalQueue.enqueue` exactly so the live queue can be
 * passed in without an adapter.
 */
export interface TextureDisposeQueue {
  enqueue(target: { dispose?: () => void } | null | undefined): void;
}

let disposeQueue: TextureDisposeQueue | null = null;

/**
 * Wire (or clear) the frame-deferred disposal queue used by
 * `dedupeGroupTextures` when retiring a redundant just-parsed texture.
 *
 * Without a queue, redundant textures are disposed synchronously inside
 * the parse pipeline — fine for tests and isolated parses, but in the
 * live viewer the texture may have already been bound to a material that
 * the current frame's command buffer references, which trips WebGPU's
 * `THREE.Destroyed texture ... used in a submit` validation error. The
 * tile-manager passes its `DeferredDisposalQueue` here at boot so every
 * parse-time dedupe defers through the same seam as cache eviction.
 */
export function setTextureDisposeQueue(queue: TextureDisposeQueue | null): void {
  disposeQueue = queue;
}

let frozen = false;

/**
 * ABH-114: when the budget ledger crosses the critical utilisation line,
 * the orchestrator latches the pool so `getOrAdoptTexture` refuses to add
 * new canonicals — the parsed texture is returned as-is, owned by the
 * source tile group, and released when that tile is evicted.
 *
 * Dedupe against EXISTING pool entries still happens while frozen — that
 * path saves memory (slot rewrite + redundant dispose) and never grows the
 * pool. Only the "first sighting → adopt as canonical" path is suppressed.
 *
 * Mirrors ABH-113's ActivationGate freeze: enter at 95% util, exit at 75%.
 */
export function setTexturePoolFrozen(value: boolean): void {
  frozen = value;
}

/** True while the texture pool refuses new canonical adoptions. */
export function isTexturePoolFrozen(): boolean {
  return frozen;
}

const pool = new Map<TextureKey, THREE.Texture>();
/**
 * Set of every canonical texture instance currently in the pool, keyed
 * by reference identity. Mirrors the `pool` map's values so callers can
 * answer "is this Texture the canonical instance the pool owns?" in O(1)
 * without iterating. Updated alongside every `pool.set` / `pool.delete` /
 * `clearTexturePool` so the two views never drift.
 */
const pooledInstances = new WeakSet<THREE.Texture>();
/**
 * Strong-reference set of every pooled instance — kept in lockstep with
 * the weak set so `clearTexturePool` can clear the weak membership view
 * without leaking entries. Pool textures live for the session anyway
 * (cleared on viewer dispose), so the extra strong refs don't change the
 * effective lifetime.
 */
const pooledInstancesStrong = new Set<THREE.Texture>();
/**
 * ABH-112 — per-pool-texture count of tile groups that currently reference
 * the canonical instance through a material slot. The orchestrator wires
 * `releaseTileTextureReferences(group)` into the cache's runtime disposal
 * path; the 1 → 0 transition unregisters the static-allocation row and
 * routes the GPU `.dispose()` through the wired `DeferredDisposalQueue`
 * (the same seam ABH-111 plumbs for tile-cache eviction). Tracked here
 * rather than on the texture instance so the canonical can be retired and
 * a fresh adoption later re-uses the same content key without inheriting
 * stale state.
 */
const refCount = new Map<TextureKey, number>();
/**
 * Reverse-lookup populated when a texture is first adopted (and only then).
 * Lets `addTileTextureReferences` / `releaseTileTextureReferences` resolve a
 * material-slot Texture back to its pool key in O(1) without re-deriving
 * the key from `tex.source.data`. Cleared via the strong-instance set in
 * `clearTexturePool` so a fresh adoption after pool clear cannot match a
 * stale reverse-lookup entry.
 */
const reverseLookup = new WeakMap<THREE.Texture, TextureKey>();

/**
 * Return the canonical texture instance for a given content key. The first
 * texture seen for each key wins. Subsequent calls with content-equivalent
 * textures return the canonical instance — the caller is responsible for
 * disposing the redundant input.
 */
export function getOrAdoptTexture(tex: THREE.Texture): THREE.Texture {
  const key = textureKey(tex);
  if (!key) return tex;
  const existing = pool.get(key);
  if (existing) return existing;
  // ABH-114: under memory pressure the orchestrator freezes the pool so new
  // first-sighting textures are NOT adopted as canonicals. The caller keeps
  // the parsed texture on its tile group; when the tile is evicted the
  // texture is disposed normally. Skipping the registration callback here
  // is intentional — the pool didn't accept the texture, so the ledger
  // mustn't count it as a session-persistent allocation.
  if (frozen) return tex;
  pool.set(key, tex);
  pooledInstances.add(tex);
  pooledInstancesStrong.add(tex);
  reverseLookup.set(tex, key);
  // Initialise the refcount slot so the first `addTileTextureReferences`
  // for the adopting tile increments from 0 → 1. The slot is cleared on
  // the matching 1 → 0 transition or by `clearTexturePool`.
  if (!refCount.has(key)) refCount.set(key, 0);
  if (registrationCb) {
    try {
      registrationCb(key, estimateTextureBytes(tex));
    } catch (err) {
      console.warn('[TexturePool] registration callback threw', err);
    }
  }
  return tex;
}

/**
 * True iff `tex` is the canonical pooled instance for some content key.
 * Used by `TileCache.disposeEntry` so a tile-eviction sweep never
 * destroys a shared texture that's also referenced by another live
 * tile's material — the texture-pool owns the lifetime of every
 * canonical instance and clears them on viewer teardown via
 * `clearTexturePool`.
 */
export function isPooledTexture(tex: THREE.Texture): boolean {
  return pooledInstances.has(tex);
}

function estimateTextureBytes(tex: THREE.Texture): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const img = (tex.source as any)?.data ?? tex.image;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  if (w <= 0 || h <= 0) return 0;
  // 4 bytes per pixel + ~33% mipmap chain overhead.
  return Math.round(w * h * 4 * 1.33);
}

export function getTexturePoolSize(): number {
  return pool.size;
}

export function clearTexturePool(): void {
  pool.clear();
  for (const tex of pooledInstancesStrong) {
    pooledInstances.delete(tex);
    reverseLookup.delete(tex);
  }
  pooledInstancesStrong.clear();
  refCount.clear();
}

export interface DedupeResult {
  adopted: number;
  deduped: number;
}

/**
 * Walk a parsed scene graph and replace material texture slots with their
 * canonical pooled instances. Disposes redundant texture instances along the
 * way so the GPU upload they made during parse is released.
 *
 * Counts are per-call (not per-pool):
 *  - adopted — distinct texture instances seen for the first time and added
 *  - deduped — slot rewrites where the parser-produced texture was redundant
 */
export function dedupeGroupTextures(group: THREE.Group): DedupeResult {
  let adopted = 0;
  let deduped = 0;
  // A single GLB parse often references one Texture instance from many
  // material slots. Only count the first sighting per traversal so the
  // returned counts reflect distinct content events, not slot occurrences.
  const seenInGroup = new Set<number>();

  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const key of Object.keys(mat)) {
        const tex = (mat as Record<string, unknown>)[key];
        if (!(tex instanceof THREE.Texture)) continue;
        const canonical = getOrAdoptTexture(tex);
        if (canonical === tex) {
          if (!seenInGroup.has(tex.id)) {
            seenInGroup.add(tex.id);
            adopted++;
          }
          continue;
        }
        // ABH-111: route the redundant texture through the frame-deferred
        // disposal queue when one is wired. The just-parsed redundant
        // texture may still be referenced by an in-flight WebGPU command
        // buffer (parse runs interleaved with renders), so disposing it
        // synchronously here trips the destroyed-texture validation on
        // WebGPU. Fall back to sync dispose for tests / standalone
        // callers that have not wired a queue.
        if (disposeQueue) {
          disposeQueue.enqueue(tex);
        } else {
          try {
            tex.dispose();
          } catch (err) {
            console.warn('[TexturePool] dispose of redundant texture threw', err);
          }
        }
        (mat as Record<string, unknown>)[key] = canonical;
        deduped++;
      }
    }
  });

  return { adopted, deduped };
}

/**
 * ABH-112 — increment the per-tile reference count for every distinct pooled
 * texture that `group` references through a material slot. Idempotent within
 * a single group (a canonical referenced by 50 material slots counts as one
 * tile reference). Call ONCE after `dedupeGroupTextures` when a tile group
 * is admitted to the streaming pipeline. The paired
 * `releaseTileTextureReferences(group)` MUST run on cache eviction or LOD
 * detach so the refcount stays balanced — without it the pool's static-
 * allocation registrations accumulate monotonically as tiles cycle through
 * the cache, producing the negative drift symptom in ABH-112.
 *
 * Non-pooled textures (no entry in `reverseLookup`) are silently ignored so
 * callers can hand the whole tile group in without pre-filtering.
 */
export function addTileTextureReferences(group: THREE.Object3D): void {
  const seen = new Set<TextureKey>();
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const value of Object.values(mat)) {
        if (!(value instanceof THREE.Texture)) continue;
        const key = reverseLookup.get(value);
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        refCount.set(key, (refCount.get(key) ?? 0) + 1);
      }
    }
  });
}

/**
 * ABH-112 — paired with `addTileTextureReferences`. Walks `group` once,
 * decrementing the per-pool-texture refcount for each distinct pooled
 * texture the group references. On the 1 → 0 transition the canonical
 * instance is:
 *
 *  1. removed from `pool` / reverse-lookup / pooled-instance sets so a
 *     concurrent parse cannot adopt the soon-to-be-disposed texture;
 *  2. its static-allocation row is debited synchronously via the registered
 *     `TextureUnregistrationCallback` (the ledger reflects the freed bytes
 *     before the next cascade decision reads it);
 *  3. the actual `tex.dispose()` is routed through the wired
 *     `DeferredDisposalQueue` (same seam as tile-cache eviction — see
 *     ABH-111). Falls back to synchronous `tex.dispose()` when no queue is
 *     wired so tests and standalone callers behave consistently.
 *
 * Idempotent within a single group. Non-pooled textures (no
 * `reverseLookup` entry) are ignored. Returns the keys of the pool entries
 * that were retired this call so dev-mode invariant logs can surface them.
 */
export function releaseTileTextureReferences(group: THREE.Object3D): TextureKey[] {
  const seen = new Set<TextureKey>();
  const released: TextureKey[] = [];
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const value of Object.values(mat)) {
        if (!(value instanceof THREE.Texture)) continue;
        const key = reverseLookup.get(value);
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        const current = refCount.get(key) ?? 0;
        const next = current - 1;
        if (next > 0) {
          refCount.set(key, next);
          continue;
        }
        refCount.delete(key);
        const tex = pool.get(key);
        if (tex) {
          pool.delete(key);
          pooledInstances.delete(tex);
          pooledInstancesStrong.delete(tex);
          reverseLookup.delete(tex);
          // The static-allocation debit MUST fire before the deferred
          // dispose: the budget ledger feeds the cascade's eviction sweep
          // and the breaker's headroom check on every controller tick. If
          // we deferred the debit, the sweep would over-estimate occupancy
          // for one or two frames after the last tile evicted, potentially
          // triggering a redundant cascade step.
          if (unregistrationCb) {
            try {
              unregistrationCb(key);
            } catch (err) {
              console.warn('[TexturePool] unregistration callback threw', err);
            }
          }
          // GPU `.dispose()` is what races the in-flight WebGPU command
          // buffer; route through the wired queue when one is set so the
          // submit completes before disposal runs.
          if (disposeQueue) {
            disposeQueue.enqueue(tex);
          } else {
            try {
              tex.dispose();
            } catch (err) {
              console.warn('[TexturePool] dispose of pooled texture threw', err);
            }
          }
        }
        released.push(key);
      }
    }
  });
  return released;
}

/**
 * Diagnostic accessor — returns the current tile-reference count for a pool
 * key, or 0 when the key is not tracked. Used by tests and dev-mode
 * invariant logs to detect refcount drift without exposing the internal
 * map.
 */
export function getTextureRefCount(key: TextureKey): number {
  return refCount.get(key) ?? 0;
}
