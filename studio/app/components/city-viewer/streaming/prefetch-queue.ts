/**
 * Prefetch queue — decouples GLB fetch+parse from GPU activation.
 *
 * After `tile-loader` parses a GLB its textures live as blob URLs on
 * `HTMLImageElement`s. Adding the tile to the scene immediately uploads those
 * to the GPU, but under memory pressure the browser can revoke the blob URLs
 * before Three.js finishes the upload — producing the
 * `THREE.GLTFLoader: Couldn't load texture blob:...` console flood.
 *
 * The prefetch queue eagerly decodes each texture to an `ImageBitmap`
 * (off-main-thread via `createImageBitmap`) and revokes the blob URL on
 * success, then holds the prepared payload in a bounded FIFO until the
 * activation gate (issue #04) consumes it. When the queue is full the
 * fetcher is expected to back off — `enqueue` resolves to `false` to signal
 * backpressure. See `.scratch/streaming-budget-pacing/issues/03-prefetch-queue-imagebitmap.md`.
 */

import * as THREE from "three/webgpu";

export interface PrefetchPayload {
  key: string;
  group: THREE.Group;
  byteSize: number;
}

export const DEFAULT_PREFETCH_CAP = 10;

export class PrefetchQueue {
  private readonly queue: PrefetchPayload[] = [];
  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_PREFETCH_CAP) {
    this.capacity = capacity;
  }

  /**
   * Decode every blob-URL texture in the payload's group to an
   * `ImageBitmap`, revoke the blob URL, and queue the prepared payload.
   * Resolves to `true` on success, `false` if the queue is at capacity
   * (backpressure — caller should pause until a slot opens).
   *
   * Decode failures fall back to the undecoded image and log a warning;
   * the payload still enters the queue so the tile is not lost.
   */
  async enqueue(payload: PrefetchPayload): Promise<boolean> {
    if (this.isFull) return false;
    await decodeBlobTextures(payload.group);
    this.queue.push(payload);
    return true;
  }

  dequeue(): PrefetchPayload | null {
    return this.queue.shift() ?? null;
  }

  /**
   * Discard every queued payload. Used by the activation gate (ABH-113) on
   * circuit-breaker freeze entry so the ~10 pre-decoded payloads already in
   * the FIFO do not burst into the ledger when the freeze releases.
   * Returns the number of dropped payloads so callers can surface the count
   * in diagnostic logs.
   *
   * Note: this does not dispose the underlying Group / ImageBitmap GPU
   * resources — those are owned by the loader path. Dropping the payload
   * just releases the JS references; downstream cache eviction handles the
   * GPU side via the normal `dispose` path once the tile re-enters the
   * scene (or never, if the camera moved on).
   */
  clear(): number {
    const dropped = this.queue.length;
    this.queue.length = 0;
    return dropped;
  }

  get isFull(): boolean {
    return this.queue.length >= this.capacity;
  }

  get size(): number {
    return this.queue.length;
  }
}

async function decodeBlobTextures(group: THREE.Group): Promise<void> {
  const textures = collectUniqueTextures(group);
  for (const tex of textures) {
    await decodeTexture(tex);
  }
}

function collectUniqueTextures(group: THREE.Group): THREE.Texture[] {
  const seen = new Set<number>();
  const out: THREE.Texture[] = [];
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const key of Object.keys(mat)) {
        const value = (mat as Record<string, unknown>)[key];
        if (value instanceof THREE.Texture && !seen.has(value.id)) {
          seen.add(value.id);
          out.push(value);
        }
      }
    }
  });
  return out;
}

async function decodeTexture(tex: THREE.Texture): Promise<void> {
  const image = extractImage(tex);
  if (!image) return;
  const blobUrl = readBlobUrl(image);
  try {
    const bitmap = await createImageBitmap(image);
    tex.image = bitmap;
    tex.source = new THREE.Source(bitmap);
    tex.needsUpdate = true;
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  } catch (err) {
    // Leave the original image attached so Three's loader has *something*
    // to upload — losing the texture entirely would visibly corrupt the
    // tile, while a brief blob-revocation OOM is recoverable.
    console.warn(
      "[PrefetchQueue] createImageBitmap failed; passing texture through undecoded",
      err,
    );
  }
}

interface DecodableImage {
  src?: unknown;
}

function extractImage(tex: THREE.Texture): (CanvasImageSource & DecodableImage) | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidate = ((tex.source as any)?.data ?? tex.image) as unknown;
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as CanvasImageSource & DecodableImage;
}

function readBlobUrl(image: DecodableImage): string | undefined {
  const src = image.src;
  if (typeof src !== "string") return undefined;
  return src.startsWith("blob:") ? src : undefined;
}
