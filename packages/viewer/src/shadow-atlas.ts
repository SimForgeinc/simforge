import { DataTexture, LinearFilter, ClampToEdgeWrapping, RedFormat, UnsignedByteType, Vector4 } from 'three';
import type { CityManifest, ManifestTile } from './types';
import { resolveUrl } from './manifest';

/**
 * Stitches the per-tile baked sun-shadow PNGs into one scene-wide R8 texture
 * addressed by world XZ.
 *
 * Why one atlas instead of per-tile textures: the dominant shadow receiver is
 * `staticLayers/road.glb`, a single un-tiled mesh set that spans the whole map,
 * so a per-tile texture could not be bound for it. Because the manifest grid is
 * uniform (`origin + grid * cellSize` reproduces every tile's bounds exactly,
 * verified against the data), world -> atlas UV is one affine transform shared
 * by every material in the scene.
 *
 * Orientation (verified empirically, do not "fix" without re-checking):
 * PNG row 0 is the tile's **minZ** edge and column 0 is its **minX** edge. This
 * was established by projecting the world AABBs of the buildings in tile_0_2
 * (computed from node TRS x quantized POSITION min/max) into the lightmap and
 * matching them against the dark regions: every blob sits offset from its
 * building toward -X/-Z, which is exactly where `shadowLightmap.sunDirection`
 * (-0.526, -0.526, -0.669) throws them. Ground *underneath* a building is left
 * white in the bake, which is why applying the term to the buildings themselves
 * does not self-darken them.
 *
 * The atlas is built from the LOD2 lightmaps (512px/cell ~= 0.15 m/texel,
 * ~10 kB per tile) so the whole scene's shadowing is resident from the first
 * second and never has to stream.
 */
export class ShadowAtlas {
  readonly texture: DataTexture;
  /** (originX, originZ, 1/spanX, 1/spanZ) — world XZ to atlas UV. */
  readonly rect: Vector4;

  private readonly cellPx: number;
  private readonly gridX: number;
  private readonly gridZ: number;
  private readonly data: Uint8Array;
  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(manifest: CityManifest, cellPx: number) {
    const [gx = 1, gz = 1] = manifest.scene.gridDimensions;
    const [cx = 1, cz = 1] = manifest.scene.cellSize;
    const [ox = 0, , oz = 0] = manifest.scene.origin;
    this.cellPx = cellPx;
    this.gridX = gx;
    this.gridZ = gz;
    this.data = new Uint8Array(gx * cellPx * gz * cellPx).fill(255);
    this.texture = new DataTexture(this.data, gx * cellPx, gz * cellPx, RedFormat, UnsignedByteType);
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearFilter; // no mips: they would bleed across cells
    this.texture.wrapS = ClampToEdgeWrapping;
    this.texture.wrapT = ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    this.rect = new Vector4(ox, oz, 1 / (gx * cx), 1 / (gz * cz));
  }

  /** Fetches every tile lightmap and blits it into the atlas. Never rejects. */
  async load(manifest: CityManifest, baseUrl: string, signal: AbortSignal): Promise<void> {
    const jobs = manifest.tiles.map((tile) => this.loadTile(tile, baseUrl, signal));
    await Promise.all(jobs);
    this.flush();
  }

  private pickLightmap(tile: ManifestTile): string | null {
    const maps = tile.shadowLightmaps;
    if (!maps || maps.length === 0) return null;
    // Prefer the entry whose native resolution is closest to the cell size;
    // LOD2 is 512px for this dataset, LOD3 256px, LOD1 1024px.
    const preferred = maps.find((m) => m.lod === 2) ?? maps[maps.length - 1];
    return preferred?.file ?? null;
  }

  private async loadTile(tile: ManifestTile, baseUrl: string, signal: AbortSignal): Promise<void> {
    const file = this.pickLightmap(tile);
    if (!file) return;
    try {
      const res = await fetch(resolveUrl(baseUrl, file), { signal });
      if (!res.ok) return;
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      if (this.disposed) {
        bitmap.close();
        return;
      }
      this.writeCell(tile.gridX, tile.gridZ, bitmap);
      bitmap.close();
      this.scheduleFlush();
    } catch {
      /* a missing lightmap just means that cell stays fully lit */
    }
  }

  private writeCell(gx: number, gz: number, bitmap: ImageBitmap): void {
    if (gx < 0 || gz < 0 || gx >= this.gridX || gz >= this.gridZ) return;
    const n = this.cellPx;
    if (!this.canvas) {
      this.canvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(n, n)
          : Object.assign(document.createElement('canvas'), { width: n, height: n });
    }
    const ctx = (this.canvas as OffscreenCanvas).getContext('2d', {
      willReadFrequently: true,
    }) as OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return;
    ctx.clearRect(0, 0, n, n);
    ctx.drawImage(bitmap, 0, 0, n, n);
    const rgba = ctx.getImageData(0, 0, n, n).data;
    const atlasW = this.gridX * n;
    for (let row = 0; row < n; row++) {
      // canvas row 0 == PNG row 0 == tile minZ; DataTexture row 0 == v 0 == minZ
      const dst = (gz * n + row) * atlasW + gx * n;
      const src = row * n * 4;
      for (let col = 0; col < n; col++) {
        this.data[dst + col] = rgba[src + col * 4] ?? 255;
      }
    }
    this.dirty = true;
  }

  /** Coalesces the (full-texture) re-uploads that each tile blit would trigger. */
  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.disposed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 250);
  }

  private flush(): void {
    if (!this.dirty || this.disposed) return;
    this.dirty = false;
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.texture.dispose();
    this.canvas = null;
  }
}
