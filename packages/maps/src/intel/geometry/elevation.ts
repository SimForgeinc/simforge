/**
 * Coarse ground-elevation sampling.
 *
 * The topology index's lane polylines are 2D, but the RoadRunner `map.geojson`
 * ships 3D lane centrelines. A uniform grid of `(x, y) → z` samples taken from
 * those centrelines gives every catalog record a real scene `y` without
 * touching a single glTF tile.
 *
 * Accuracy is deliberately modest (nearest sample within a 25 m cell); this is
 * for placing ghosts and camera targets, not for grade computation — grades
 * come from the search index, which derived them from the road profile.
 */

import type { Point2 } from './vec.js';

const CELL_M = 25;

/** Grid of ground elevation samples in xodr-local metres. */
export class ElevationField {
  readonly #cells = new Map<string, { x: number; y: number; z: number; n: number }>();
  #fallback = 0;

  /** Add one sample. Samples in the same cell are averaged. */
  add(x: number, y: number, z: number): void {
    if (!Number.isFinite(z)) return;
    const key = `${Math.floor(x / CELL_M)},${Math.floor(y / CELL_M)}`;
    const cell = this.#cells.get(key);
    if (cell) {
      cell.x += x;
      cell.y += y;
      cell.z += z;
      cell.n += 1;
    } else {
      this.#cells.set(key, { x, y, z, n: 1 });
    }
  }

  /** Finalise: compute the global mean used when no cell is within range. */
  finalise(): void {
    let sum = 0;
    let n = 0;
    for (const c of this.#cells.values()) {
      sum += c.z;
      n += c.n;
    }
    this.#fallback = n > 0 ? sum / n : 0;
  }

  /** Number of populated cells. */
  get cellCount(): number {
    return this.#cells.size;
  }

  /** Elevation at a point; searches outward up to `maxRings` cells. */
  at(p: Point2, maxRings = 4): number {
    const cx = Math.floor(p.x / CELL_M);
    const cy = Math.floor(p.y / CELL_M);
    for (let ring = 0; ring <= maxRings; ring++) {
      let best: number | null = null;
      let bestD = Infinity;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const cell = this.#cells.get(`${cx + dx},${cy + dy}`);
          if (!cell) continue;
          const mx = cell.x / cell.n;
          const my = cell.y / cell.n;
          const d = Math.hypot(mx - p.x, my - p.y);
          if (d < bestD) {
            bestD = d;
            best = cell.z / cell.n;
          }
        }
      }
      if (best !== null) return best;
    }
    return this.#fallback;
  }
}
