import * as THREE from "three/webgpu";

import { isHeavyTwinDetail } from "./twin-detail-mode";

/**
 * Client-side geometry decimation for vegetation prototypes.
 *
 * ## Why this exists
 *
 * Vegetation is ~99% of the twin's rendered triangles: a scene audit of Belmont
 * measured 66.4M of 67.3M triangles coming from vegetation, across ~9.4k
 * instances — roughly 7,100 triangles per shrub or tree.
 *
 * The pipeline's LOD chain does not help. Across all four levels the vegetation
 * tile GLBs carry byte-identical triangle counts; only file size falls, so they
 * are texture LODs, not geometry LODs. The per-LOD `lodKeepCounts` sidecar
 * thins the *instance count* to about half by LOD3, which still leaves tens of
 * millions of triangles. Nothing the renderer selects makes a distant tree
 * cheaper.
 *
 * So the renderer decimates the prototypes itself, and gets to delete this the
 * day the pipeline emits real geometry LODs.
 *
 * ## Why it is cheap
 *
 * meshoptimizer's simplifier returns a **new index buffer over the original
 * vertices**. Every other attribute — normals, UVs, tangents — is untouched and
 * shared, so a simplified prototype costs one extra index buffer and no vertex
 * duplication. Prototypes repeat heavily across tiles (`SM_Bush`, `SM_Maple_M`
 * …), so results are cached by prototype and level and each unique plant is
 * simplified once per session, not once per tile.
 */

/**
 * Fraction of the original triangles to keep at each LOD.
 *
 * LOD0 is untouched: it is what you see standing next to the plant. The rest
 * fall off hard, because a tree 200 m away through a windscreen does not need
 * 7,000 triangles. These are starting values, tuned against the frame budget
 * rather than derived — the audit harness is what says whether they are right.
 */
export const VEGETATION_LOD_KEEP_RATIO: readonly number[] = [1, 0.3, 0.1, 0.035];

/** Never simplify below this many triangles — past it the silhouette collapses. */
const MIN_TRIANGLES = 24;

/**
 * Geometric error, in metres, for each vegetation LOD — replacing the values
 * the manifest ships.
 *
 * The pipeline's vegetation `geometricError` cannot be used. On Belmont it
 * reports 47.6 m at LOD1 and 190.5 m at LOD2, for levels whose meshes are
 * byte-for-byte identical to LOD0. Fed to the screen-space-error selector at
 * the `high` tier's 6 px threshold, LOD1 only becomes eligible beyond about
 * 5 km — and the entire map is 634 m across. The result measured on 2026-07-28
 * was that **100% of vegetation streamed at LOD0**, at 95 M triangles, however
 * far the camera pulled back. The LOD system was inert.
 *
 * These values instead describe the error this renderer's own decimation
 * introduces (see `VEGETATION_LOD_KEEP_RATIO`): roughly the silhouette
 * deviation of a shrub or tree once it has been simplified to that ratio. At a
 * 6 px threshold and a 1080p viewport they put the LOD1 switch near 65 m, LOD2
 * near 165 m and LOD3 near 330 m — bands that fit a map this size.
 *
 * They stop being ours to define the moment the pipeline emits genuine
 * geometry LODs with honest error values.
 */
export const VEGETATION_LOD_GEOMETRIC_ERROR: readonly number[] = [
  0, 0.6, 1.5, 3.0,
];

type Simplifier = {
  ready: Promise<void>;
  simplify(
    indices: Uint32Array,
    positions: Float32Array,
    positionStride: number,
    targetIndexCount: number,
    targetError: number,
    flags?: string[],
  ): [Uint32Array, number];
};

let simplifierPromise: Promise<Simplifier | null> | null = null;

/**
 * Load and initialise the simplifier once. Resolves to null if it is
 * unavailable, and callers then keep full-detail geometry — decimation is an
 * optimisation, never a correctness requirement.
 */
export function ensureSimplifier(): Promise<Simplifier | null> {
  if (!simplifierPromise) {
    simplifierPromise = import("meshoptimizer/simplifier")
      .then(async (mod) => {
        const simplifier = (mod as unknown as { MeshoptSimplifier: Simplifier })
          .MeshoptSimplifier;
        await simplifier.ready;
        return simplifier;
      })
      .catch((err) => {
        console.warn(
          "[VegetationSimplify] simplifier unavailable, keeping full-detail vegetation",
          err,
        );
        return null;
      });
  }
  return simplifierPromise;
}

/** prototype name + LOD → simplified geometry. */
const geometryCache = new Map<string, THREE.BufferGeometry>();

function cacheKey(prototypeName: string, meshIndex: number, lod: number) {
  return `${prototypeName}#${meshIndex}@${lod}`;
}

/**
 * Simplify one prototype geometry for a LOD level.
 *
 * Returns the input unchanged when the simplifier is unavailable, the geometry
 * is non-indexed or lacks positions, the level asks for no reduction, or the
 * mesh is already small. The result shares every attribute buffer with the
 * input and differs only in its index.
 */
export function simplifyPrototypeGeometry(
  simplifier: Simplifier | null,
  geometry: THREE.BufferGeometry,
  prototypeName: string,
  meshIndex: number,
  lod: number,
): THREE.BufferGeometry {
  // `heavy` mode is the pre-optimisation renderer: prototypes keep every
  // triangle the pipeline shipped.
  if (isHeavyTwinDetail()) return geometry;

  const ratio = VEGETATION_LOD_KEEP_RATIO[lod] ?? 1;
  if (!simplifier || ratio >= 1) return geometry;

  const key = cacheKey(prototypeName, meshIndex, lod);
  const cached = geometryCache.get(key);
  if (cached) return cached;

  const index = geometry.getIndex();
  const position = geometry.getAttribute("position");
  if (!index || !position) return geometry;

  // Multi-material meshes address their materials through `groups`, which are
  // index ranges. Simplification rewrites the index buffer wholesale, so those
  // ranges no longer mean anything and the mesh would render with the wrong
  // materials (bark shaded as leaves, or nothing at all). Leave them alone;
  // splitting per group and simplifying each is a later refinement.
  if (geometry.groups && geometry.groups.length > 1) return geometry;

  const triangles = index.count / 3;
  if (triangles <= MIN_TRIANGLES) return geometry;

  const targetTriangles = Math.max(
    MIN_TRIANGLES,
    Math.floor(triangles * ratio),
  );

  try {
    const indices =
      index.array instanceof Uint32Array
        ? index.array
        : new Uint32Array(index.array);

    // De-interleave into a tight xyz buffer. Meshopt-compressed GLBs hand back
    // InterleavedBufferAttributes, where `array` is the whole interleaved block
    // and `itemSize` is not the stride — feeding those to the simplifier
    // straight trips an assertion inside wasm. Reading through the attribute
    // accessors also normalises quantised types for free. Done once per
    // prototype thanks to the cache.
    const vertexCount = position.count;
    const positions = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      positions[i * 3] = position.getX(i);
      positions[i * 3 + 1] = position.getY(i);
      positions[i * 3 + 2] = position.getZ(i);
    }

    const [simplified] = simplifier.simplify(
      indices,
      positions,
      3,
      targetTriangles * 3,
      // Generous error bound: silhouette matters far more than surface
      // fidelity at the distances these levels are shown at, and LockBorder
      // keeps tile-edge geometry from pulling apart.
      0.05,
      ["LockBorder"],
    );

    const out = new THREE.BufferGeometry();
    // Attributes are shared by reference — the simplifier only reindexes.
    for (const name of Object.keys(geometry.attributes)) {
      out.setAttribute(name, geometry.attributes[name]!);
    }
    out.setIndex(new THREE.BufferAttribute(simplified, 1));
    out.boundingBox = geometry.boundingBox;
    out.boundingSphere = geometry.boundingSphere;

    geometryCache.set(key, out);
    return out;
  } catch (err) {
    console.warn(
      `[VegetationSimplify] failed for ${prototypeName}@${lod}, keeping full detail`,
      err,
    );
    return geometry;
  }
}

/** Test seam: drop cached geometries and the simplifier handle. */
export function resetVegetationSimplifyCaches(): void {
  geometryCache.clear();
  simplifierPromise = null;
}
