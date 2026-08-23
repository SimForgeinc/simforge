/**
 * A static, query-fast ground heightfield built from real triangles.
 *
 * ## Why this exists
 *
 * {@link CityViewer.sampleGroundHeight} raycasts the live scene graph, which is
 * correct but costs ~9.5 ms per call on Yale Street (807 road meshes + ~270
 * resident city meshes, no BVH). Draping the lane overlay needs a height per
 * lane-polygon vertex — 86,272 of them — which would take about 14 minutes.
 *
 * `GroundIndex` bakes the road layer's triangles into world space once and bins
 * them into a uniform XZ grid. Measured on Yale Street in Chrome/M-series:
 *
 * | | raycast | GroundIndex |
 * |---|---|---|
 * | build | — | 30 ms (16 MB, 376,512 triangles) |
 * | query | 9500 µs | 0.22 µs |
 *
 * Agreement with a road-layer raycast over 400 spread points: p50 3.4e-7 m,
 * max 2.3e-5 m — i.e. identical up to the Float32 the GPU already holds.
 *
 * ## What it indexes, and why only that
 *
 * The road layer only. It is the map's actual ground surface, it is pinned
 * resident with a single LOD, and it never changes after load — so one bake
 * stays valid for the session. City tiles are deliberately excluded: they swap
 * LODs as the camera moves (the bake would go stale) and their topmost surface
 * over a street is a *building roof*, which would lift draped overlays onto
 * rooftops. `sampleGroundHeight` includes them because it answers a different
 * question ("what is the highest thing under this pixel").
 *
 * Instanced meshes (vegetation) are skipped: they are not ground. So is street
 * furniture — see {@link GroundIndexOptions.meshFilter} and
 * {@link GroundIndexOptions.surface}, which between them keep lane overlays off
 * lamp posts.
 */

import { Box3, Vector3, type Mesh, type Object3D } from 'three';

/** Options for {@link GroundIndex.build}. */
export interface GroundIndexOptions {
  /**
   * Grid cell size in metres. Default `4`, which on Yale Street puts ~45
   * triangles in the average occupied cell — small enough that a query is a
   * couple of dozen point-in-triangle tests, large enough that the index stays
   * under 20 MB.
   */
  cellSize?: number;
  /** Extra slack in metres around the triangle bounds. Default `1`. */
  padding?: number;
  /**
   * Decide which meshes count as ground. Default {@link isGroundSurfaceMesh}.
   *
   * This matters more than it sounds: RoadRunner bakes street furniture into
   * the same glTF as the road surface (Yale Street's road layer carries 37
   * signal posts, 36 lamp posts, mast arms and electric towers), and without a
   * filter a lane vertex under a lamp post drapes onto the lamp.
   */
  meshFilter?: (mesh: Mesh) => boolean;
  /**
   * Which covering surface {@link GroundIndex.sample} returns when several are
   * stacked at one XZ. Default `'lowest'` — the ground is the thing underneath.
   *
   * With a working {@link GroundIndexOptions.meshFilter} this barely matters:
   * 90% of Yale Street lane vertices are covered by exactly one surface, and
   * where two stack the gap is 8 mm at p95 (lane-marking decals floating just
   * off the asphalt). It earns its keep as the second line of defence — pass a
   * permissive `meshFilter` on a map whose ground is not sheet-shaped and
   * `'lowest'` still keeps overlays off the furniture.
   *
   * `'highest'` reproduces the ray-from-above semantics of
   * {@link CityViewer.sampleGroundHeight}. Prefer it only for maps with real
   * stacked decks where the top one is wanted.
   */
  surface?: 'lowest' | 'highest';
}

/** Build-time facts, for logging and HUD copy. */
export interface GroundIndexStats {
  meshes: number;
  /** Meshes turned away by the mesh filter — street furniture, mostly. */
  rejectedMeshes: number;
  triangles: number;
  cellSize: number;
  cells: number;
  occupiedCells: number;
  /** Triangle references stored (a triangle spanning N cells is listed N times). */
  entries: number;
  /** Typed-array bytes held by the index. Not GPU memory — nothing here is uploaded. */
  bytes: number;
  buildMs: number;
}

const _box = new Box3();
const _v = new Vector3();
const _size = new Vector3();

/**
 * Is this mesh a ground *surface* rather than an *object* standing on it?
 *
 * Name-free on purpose — asset naming varies per pipeline. The discriminator is
 * horizontal extent: exporters emit ground as a handful of map-spanning sheets
 * (one per material), and furniture as many small props. On Yale Street's road
 * layer the two populations do not overlap at all:
 *
 * | | narrowest horizontal span |
 * |---|---|
 * | 24 ground sheets (asphalt, curb, gutter, sidewalk, markings, terrain) | 11.2 m – 628 m |
 * | 783 props (mast arms, lamp posts, signal heads, insulators, signs) | 8.6 m and below |
 *
 * Aspect ratio was tried first and is not enough: it correctly rejects a 0.3 m
 * wide, 10 m tall utility pole, but happily accepts the 0.8 x 0.8 x 0.2 m
 * luminaire head bolted to the top of it — and a lane vertex under that head
 * then drapes 10 m in the air. Filtering on footprint removed every one of
 * those (worst local lift over 85,125 lane vertices: 9.96 m -> 0.60 m, and the
 * 0.60 m is a real kerb).
 *
 * @param minFootprint Metres. A mesh is ground when *both* horizontal spans
 *   reach this. Default `10` — mid-gap for the table above.
 */
export function isGroundSurfaceMesh(mesh: Mesh, minFootprint = 10): boolean {
  const geometry = mesh.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return true;
  _box.copy(box).applyMatrix4(mesh.matrixWorld);
  _box.getSize(_size);
  return Math.min(_size.x, _size.z) >= minFootprint;
}

/** A point-in-triangle test tolerance, in barycentric units. */
const EPS = 1e-7;

/**
 * Uniform-grid triangle index answering "what is the ground height at (x, z)?".
 *
 * Build once after the road layer is resident, then call {@link sample} freely.
 * The instance holds plain typed arrays — no GPU resources, no scene-graph
 * references — so it costs nothing to keep around and nothing to throw away.
 */
export class GroundIndex {
  /** World-space triangle vertices, 9 floats per triangle (ax ay az bx ... cz). */
  private readonly positions: Float32Array;
  /** Prefix offsets into {@link items}, length `cells + 1`. */
  private readonly starts: Int32Array;
  /** Triangle ids, grouped by cell. */
  private readonly items: Int32Array;

  private readonly minX: number;
  private readonly minZ: number;
  private readonly cellSize: number;
  private readonly nx: number;
  private readonly nz: number;
  /** `true` when {@link sample} keeps the lowest covering surface. */
  private readonly preferLowest: boolean;

  readonly stats: GroundIndexStats;

  private constructor(parts: {
    positions: Float32Array;
    starts: Int32Array;
    items: Int32Array;
    minX: number;
    minZ: number;
    cellSize: number;
    nx: number;
    nz: number;
    preferLowest: boolean;
    stats: GroundIndexStats;
  }) {
    this.positions = parts.positions;
    this.starts = parts.starts;
    this.items = parts.items;
    this.minX = parts.minX;
    this.minZ = parts.minZ;
    this.cellSize = parts.cellSize;
    this.nx = parts.nx;
    this.nz = parts.nz;
    this.preferLowest = parts.preferLowest;
    this.stats = parts.stats;
  }

  /**
   * Bake the triangles under `roots` into an index.
   *
   * Meshes are read through their current `matrixWorld`, so callers must make
   * sure world matrices are up to date (the viewer's tile pipeline already does
   * this in `prepareTree`).
   *
   * @returns The index, or `null` when `roots` contain no triangles yet.
   */
  static build(roots: Object3D | Object3D[], options: GroundIndexOptions = {}): GroundIndex | null {
    const t0 =
      typeof performance === 'undefined' ? Date.now() : performance.now();
    const {
      cellSize = 4,
      padding = 1,
      meshFilter = isGroundSurfaceMesh,
      surface = 'lowest',
    } = options;
    const list = Array.isArray(roots) ? roots : [roots];

    const meshes: Mesh[] = [];
    let triangles = 0;
    let rejected = 0;
    for (const root of list) {
      root.updateMatrixWorld(true);
      root.traverse((obj) => {
        const mesh = obj as Mesh;
        if (!mesh.isMesh) return;
        // Vegetation and other instanced content is not ground.
        if ((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) return;
        const position = mesh.geometry?.attributes?.position;
        if (!position) return;
        const count = mesh.geometry.index ? mesh.geometry.index.count : position.count;
        if (count < 3) return;
        if (!meshFilter(mesh)) {
          rejected++;
          return;
        }
        meshes.push(mesh);
        triangles += Math.floor(count / 3);
      });
    }
    if (triangles === 0) return null;

    // --- bake world-space triangles -------------------------------------
    const positions = new Float32Array(triangles * 9);
    let w = 0;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const mesh of meshes) {
      const geometry = mesh.geometry;
      const attr = geometry.attributes.position as { getX(i: number): number; getY(i: number): number; getZ(i: number): number };
      const index = geometry.index;
      const e = mesh.matrixWorld.elements;
      const count = index ? index.count : (geometry.attributes.position as { count: number }).count;
      const usable = count - (count % 3);
      for (let i = 0; i < usable; i++) {
        const vi = index ? index.getX(i) : i;
        const x = attr.getX(vi);
        const y = attr.getY(vi);
        const z = attr.getZ(vi);
        const wx = (e[0] as number) * x + (e[4] as number) * y + (e[8] as number) * z + (e[12] as number);
        const wy = (e[1] as number) * x + (e[5] as number) * y + (e[9] as number) * z + (e[13] as number);
        const wz = (e[2] as number) * x + (e[6] as number) * y + (e[10] as number) * z + (e[14] as number);
        positions[w++] = wx;
        positions[w++] = wy;
        positions[w++] = wz;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wz < minZ) minZ = wz;
        if (wz > maxZ) maxZ = wz;
      }
    }
    const triCount = Math.floor(w / 9);
    if (triCount === 0 || !Number.isFinite(minX) || !Number.isFinite(minZ)) return null;

    // --- bin by triangle AABB (conservative, so queries stay exact) ------
    const gx = minX - padding;
    const gz = minZ - padding;
    const nx = Math.max(1, Math.ceil((maxX + padding - gx) / cellSize));
    const nz = Math.max(1, Math.ceil((maxZ + padding - gz) / cellSize));
    const cells = nx * nz;

    /**
     * Visit every cell a triangle's XZ AABB touches. Binning by AABB rather
     * than by exact coverage is conservative — a cell may list a triangle that
     * does not actually cover any of it — which is what keeps queries exact:
     * the point-in-triangle test rejects the extras.
     */
    const forEachCell = (t: number, visit: (cell: number) => void): void => {
      const o = t * 9;
      const ax = positions[o] as number;
      const az = positions[o + 2] as number;
      const bx = positions[o + 3] as number;
      const bz = positions[o + 5] as number;
      const cx = positions[o + 6] as number;
      const cz = positions[o + 8] as number;
      let i0 = Math.floor((Math.min(ax, bx, cx) - gx) / cellSize);
      let i1 = Math.floor((Math.max(ax, bx, cx) - gx) / cellSize);
      let j0 = Math.floor((Math.min(az, bz, cz) - gz) / cellSize);
      let j1 = Math.floor((Math.max(az, bz, cz) - gz) / cellSize);
      if (i1 < 0 || j1 < 0 || i0 >= nx || j0 >= nz) return;
      if (i0 < 0) i0 = 0;
      if (j0 < 0) j0 = 0;
      if (i1 >= nx) i1 = nx - 1;
      if (j1 >= nz) j1 = nz - 1;
      for (let j = j0; j <= j1; j++) {
        const row = j * nx;
        for (let i = i0; i <= i1; i++) visit(row + i);
      }
    };

    // Count, prefix-sum, then fill — one exact allocation, no per-cell arrays.
    const counts = new Int32Array(cells);
    for (let t = 0; t < triCount; t++) {
      forEachCell(t, (c) => {
        counts[c] = (counts[c] as number) + 1;
      });
    }

    const starts = new Int32Array(cells + 1);
    let acc = 0;
    let occupied = 0;
    for (let c = 0; c < cells; c++) {
      starts[c] = acc;
      const n = counts[c] as number;
      if (n > 0) occupied++;
      acc += n;
    }
    starts[cells] = acc;

    const items = new Int32Array(acc);
    const cursor = starts.slice(0, cells);
    for (let t = 0; t < triCount; t++) {
      forEachCell(t, (c) => {
        items[cursor[c] as number] = t;
        cursor[c] = (cursor[c] as number) + 1;
      });
    }

    const t1 = typeof performance === 'undefined' ? Date.now() : performance.now();

    return new GroundIndex({
      positions,
      starts,
      items,
      minX: gx,
      minZ: gz,
      cellSize,
      nx,
      nz,
      preferLowest: surface === 'lowest',
      stats: {
        meshes: meshes.length,
        rejectedMeshes: rejected,
        triangles: triCount,
        cellSize,
        cells,
        occupiedCells: occupied,
        entries: items.length,
        bytes: positions.byteLength + starts.byteLength + items.byteLength,
        buildMs: t1 - t0,
      },
    });
  }

  /** World-space XZ extent the index covers. */
  bounds(): Box3 {
    _box.makeEmpty();
    _box.expandByPoint(_v.set(this.minX, 0, this.minZ));
    _box.expandByPoint(
      _v.set(this.minX + this.nx * this.cellSize, 0, this.minZ + this.nz * this.cellSize),
    );
    return _box.clone();
  }

  /**
   * Ground height at a world XZ, or `null` when no indexed triangle covers it.
   *
   * Which surface wins when several are stacked is set by
   * {@link GroundIndexOptions.surface} (default: the lowest). Bound as a field
   * so it can be handed straight to an overlay builder's `heightSampler`.
   */
  sample = (x: number, z: number): number | null => {
    const i = Math.floor((x - this.minX) / this.cellSize);
    const j = Math.floor((z - this.minZ) / this.cellSize);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return null;
    return this.sampleCell(j * this.nx + i, x, z);
  };

  /**
   * {@link sample}, but when nothing covers the point, fall back to the height
   * of the nearest indexed triangle within `radius` metres.
   *
   * Lane polygons occasionally overhang the paved surface the road mesh models
   * (kerb lines, driveway aprons); dropping those vertices to a global constant
   * would tear the overlay, while snapping them to the nearest real ground
   * keeps the surface continuous. Only misses pay for the search.
   *
   * @param radius Search radius in metres. Default `8`.
   */
  sampleNear = (x: number, z: number, radius = 8): number | null => {
    const hit = this.sample(x, z);
    if (hit !== null) return hit;

    const ci = Math.floor((x - this.minX) / this.cellSize);
    const cj = Math.floor((z - this.minZ) / this.cellSize);
    const rings = Math.max(1, Math.ceil(radius / this.cellSize));
    let bestDist = radius * radius;
    let bestY: number | null = null;

    // Rings outward from the query cell. A cell in ring r cannot hold anything
    // closer than (r-1) cells, so once the best hit beats that we can stop.
    for (let r = 0; r <= rings; r++) {
      if (bestY !== null && bestDist <= ((r - 1) * this.cellSize) ** 2) break;
      for (let j = cj - r; j <= cj + r; j++) {
        if (j < 0 || j >= this.nz) continue;
        const onJEdge = Math.abs(j - cj) === r;
        for (let i = ci - r; i <= ci + r; i++) {
          // Ring only: the interior was covered by a previous r.
          if (!onJEdge && Math.abs(i - ci) !== r) continue;
          if (i < 0 || i >= this.nx) continue;
          const c = j * this.nx + i;
          const end = this.starts[c + 1] as number;
          for (let k = this.starts[c] as number; k < end; k++) {
            const o = (this.items[k] as number) * 9;
            // Closest point of the triangle's XZ projection to (x, z). For an
            // exterior point that always lies on an edge, so three clamped
            // segment projections give both the distance and the height there.
            for (let e = 0; e < 3; e++) {
              const p = o + e * 3;
              const q = o + ((e + 1) % 3) * 3;
              const ax = this.positions[p] as number;
              const ay = this.positions[p + 1] as number;
              const az = this.positions[p + 2] as number;
              const dx = (this.positions[q] as number) - ax;
              const dz = (this.positions[q + 2] as number) - az;
              const len2 = dx * dx + dz * dz;
              let t = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
              if (t < 0) t = 0;
              else if (t > 1) t = 1;
              const qx = ax + t * dx;
              const qz = az + t * dz;
              const d = (qx - x) ** 2 + (qz - z) ** 2;
              if (d < bestDist) {
                bestDist = d;
                bestY = ay + t * ((this.positions[q + 1] as number) - ay);
              }
            }
          }
        }
      }
    }
    return bestY;
  };

  /**
   * Every indexed surface height at a world XZ, ascending.
   *
   * `sample` returns the first or last entry depending on the `surface` policy.
   * Useful for diagnostics ("what is stacked here?") and for callers that need
   * a specific deck.
   */
  sampleAll = (x: number, z: number): number[] => {
    const i = Math.floor((x - this.minX) / this.cellSize);
    const j = Math.floor((z - this.minZ) / this.cellSize);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return [];
    const out: number[] = [];
    this.sampleCell(j * this.nx + i, x, z, out);
    return out.sort((a, b) => a - b);
  };

  /**
   * The winning triangle height in one cell covering (x, z), per the index's
   * `surface` policy.
   *
   * @param collect When given, every covering height is pushed here too.
   */
  private sampleCell(cell: number, x: number, z: number, collect?: number[]): number | null {
    const end = this.starts[cell + 1] as number;
    let best: number | null = null;
    for (let k = this.starts[cell] as number; k < end; k++) {
      const o = (this.items[k] as number) * 9;
      const ax = this.positions[o] as number;
      const ay = this.positions[o + 1] as number;
      const az = this.positions[o + 2] as number;
      const bx = this.positions[o + 3] as number;
      const by = this.positions[o + 4] as number;
      const bz = this.positions[o + 5] as number;
      const cx = this.positions[o + 6] as number;
      const cy = this.positions[o + 7] as number;
      const cz = this.positions[o + 8] as number;

      // Barycentric solve in the XZ plane. `det` is twice the projected area;
      // a zero means the triangle is edge-on to the ray and cannot be hit.
      const det = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      if (det === 0) continue;
      const u = ((bz - z) * (cx - x) - (bx - x) * (cz - z)) / det;
      if (u < -EPS || u > 1 + EPS) continue;
      const v = ((cz - z) * (ax - x) - (cx - x) * (az - z)) / det;
      if (v < -EPS || v > 1 + EPS) continue;
      const w = 1 - u - v;
      if (w < -EPS) continue;
      const y = u * ay + v * by + w * cy;
      collect?.push(y);
      if (best === null || (this.preferLowest ? y < best : y > best)) best = y;
    }
    return best;
  }
}
