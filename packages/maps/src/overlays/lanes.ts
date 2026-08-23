/**
 * Lane-surface overlay builder.
 *
 * Renderer-agnostic: a pure function in, one `THREE.Group` out. Nothing here
 * touches a `WebGLRenderer`, so it runs in Node tests too.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  ShapeUtils,
  Vector2,
  type Material,
  type Object3D,
} from 'three';
import type { LanePolygon } from '../lanes.js';
import { createHeightResolver, type HeightOptions } from './height.js';

export type { HeightSampler, MissingHeightPolicy } from './height.js';

/** Options for {@link buildLaneOverlay}. */
export interface LaneOverlayOptions extends HeightOptions {
  /** Lift above the sampled ground so the overlay does not z-fight. Default `0.04` m. */
  drapeOffset?: number;
  /** Base tint. Default cyan `0x22d3ee`. */
  color?: number;
  /** Base opacity. Default `0.28`. */
  opacity?: number;
  /** Per-lane tint; enables vertex colours. Return `null` to use the base tint. */
  colorFor?: (lane: LanePolygon) => number | null;
  /** Keep only the lanes you want (e.g. `l => l.laneType === 'driving'`). */
  filter?: (lane: LanePolygon) => boolean;
  /**
   * Discard triangles below this ground-plane area, in m², measured on the
   * Float32 coordinates that actually reach the GPU. Default `1e-9`.
   *
   * Earcut emits slivers where a lane boundary has near-collinear vertices
   * (~8% of triangles on real Yale Street lanes are under 1 cm²); the thinnest
   * of them collapse to exactly zero area once written to a Float32 buffer at
   * ~2 km from the origin. They render nothing and only cost bandwidth.
   */
  minTriangleArea?: number;
  /** Replace the generated material entirely. */
  material?: Material;
}

/** Index-buffer span occupied by one lane, for picking. */
export interface LaneRange {
  id: string;
  laneType: string;
  /** First index in the geometry index buffer. */
  indexStart: number;
  /** Number of indices (3 per triangle). */
  indexCount: number;
}

/** `userData` attached to the group returned by {@link buildLaneOverlay}. */
export interface LaneOverlayUserData {
  layer: 'lanes';
  ranges: LaneRange[];
  laneCount: number;
  triangleCount: number;
  /** Triangles dropped by the `minTriangleArea` filter. */
  degenerateTriangles: number;
  /** Lanes dropped because the height sampler missed and `onMissingHeight` is `'skip'`. */
  skippedLanes: number;
}

function srgbBytes(hex: number): [number, number, number] {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

/**
 * Triangulate lane polygons into a single draped mesh.
 *
 * Every lane is merged into one `BufferGeometry` (one draw call for ~1000
 * lanes); per-lane identity survives in `group.userData.ranges`, which
 * {@link laneIdForFace} turns back into a lane id after a raycast.
 *
 * Winding: rings arrive normalised by the loader (outer CCW in the `(x, -z)`
 * plane), which is exactly the orientation that yields +Y-facing triangles.
 * The material is still `DoubleSide` so a stray inverted ring cannot vanish.
 *
 * @returns A `Group` named `lanes` containing one `Mesh` named `lane-surfaces`.
 */
export function buildLaneOverlay(lanes: LanePolygon[], options: LaneOverlayOptions = {}): Group {
  const {
    drapeOffset = 0.04,
    color = 0x22d3ee,
    opacity = 0.28,
    colorFor,
    filter,
    material,
    minTriangleArea = 1e-9,
  } = options;
  const resolveHeight = createHeightResolver({
    ...options,
    defaultHeight: options.defaultHeight ?? 0,
  });

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const ranges: LaneRange[] = [];
  const baseColor = srgbBytes(color);
  const useVertexColors = typeof colorFor === 'function';
  let degenerateTriangles = 0;
  let skippedLanes = 0;

  for (const lane of lanes) {
    if (filter && !filter(lane)) continue;
    if (lane.rings.length === 0) continue;

    const rings = lane.rings.map((flat) => {
      const pts: Vector2[] = [];
      for (let i = 0; i < flat.length; i += 2) {
        // Triangulate in (u, v) = (x, -z): CCW there means a +Y normal in a
        // y-up right-handed scene.
        pts.push(new Vector2(flat[i] as number, -(flat[i + 1] as number)));
      }
      return pts;
    });

    const contour = rings[0] as Vector2[];
    const holes = rings.slice(1);
    let faces: number[][];
    try {
      faces = ShapeUtils.triangulateShape(contour, holes);
    } catch {
      continue; // self-intersecting ring; drop rather than poison the buffer
    }
    if (faces.length === 0) continue;

    const flatPts: Vector2[] = [...contour, ...holes.flat()];
    const vertexBase = positions.length / 3;
    const tint = useVertexColors ? (colorFor?.(lane) ?? color) : color;
    const rgb = useVertexColors ? srgbBytes(tint) : baseColor;

    // Float32-rounded ground-plane coordinates, so degeneracy is judged on what
    // the GPU will actually see rather than on the double-precision source.
    const fx: number[] = [];
    const fz: number[] = [];
    // Staged, not appended: with `onMissingHeight: 'skip'` a single unresolved
    // vertex drops the whole lane, and a half-written lane would corrupt the
    // shared buffer.
    const staged: number[] = [];
    let missing = false;
    for (const pt of flatPts) {
      const x = pt.x;
      const z = -pt.y;
      const ground = resolveHeight(x, z);
      if (ground === null) {
        missing = true;
        break;
      }
      staged.push(x, ground + drapeOffset, z);
      fx.push(Math.fround(x));
      fz.push(Math.fround(z));
    }
    if (missing) {
      skippedLanes++;
      continue;
    }
    for (const value of staged) positions.push(value);
    if (useVertexColors) {
      for (let i = 0; i < flatPts.length; i++) colors.push(rgb[0], rgb[1], rgb[2]);
    }

    const indexStart = indices.length;
    for (const face of faces) {
      const a = face[0] as number;
      const b = face[1] as number;
      const c = face[2] as number;
      if (a === b || b === c || a === c) {
        degenerateTriangles++;
        continue;
      }
      const area =
        Math.abs(
          ((fx[b] as number) - (fx[a] as number)) * ((fz[c] as number) - (fz[a] as number)) -
            ((fx[c] as number) - (fx[a] as number)) * ((fz[b] as number) - (fz[a] as number)),
        ) / 2;
      if (!(area > minTriangleArea)) {
        degenerateTriangles++;
        continue;
      }
      indices.push(vertexBase + a, vertexBase + b, vertexBase + c);
    }
    const indexCount = indices.length - indexStart;
    if (indexCount === 0) continue;
    ranges.push({ id: lane.id, laneType: lane.laneType, indexStart, indexCount });
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  if (useVertexColors) {
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  }
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const mat =
    material ??
    new MeshBasicMaterial({
      color,
      vertexColors: useVertexColors,
      transparent: true,
      opacity,
      depthWrite: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: false,
    });

  const mesh = new Mesh(geometry, mat);
  mesh.name = 'lane-surfaces';
  mesh.renderOrder = 10;
  mesh.frustumCulled = true;

  const group = new Group();
  group.name = 'lanes';
  group.add(mesh);
  const userData: LaneOverlayUserData = {
    layer: 'lanes',
    ranges,
    laneCount: ranges.length,
    triangleCount: indices.length / 3,
    degenerateTriangles,
    skippedLanes,
  };
  group.userData = userData;
  return group;
}

/**
 * Resolve a raycast hit back to a lane id.
 *
 * @param group A group produced by {@link buildLaneOverlay}.
 * @param faceIndex `THREE.Intersection.faceIndex` from a raycast against the
 *   `lane-surfaces` mesh.
 * @returns The lane id, or `null` if the face is out of range.
 */
export function laneIdForFace(group: Object3D, faceIndex: number): string | null {
  const ranges = (group.userData as Partial<LaneOverlayUserData>).ranges;
  if (!ranges || faceIndex < 0) return null;
  const target = faceIndex * 3;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid] as LaneRange;
    if (target < r.indexStart) hi = mid - 1;
    else if (target >= r.indexStart + r.indexCount) lo = mid + 1;
    else return r.id;
  }
  return null;
}
