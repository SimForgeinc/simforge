import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Mesh,
  type MeshStandardMaterial,
  Object3D,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
} from 'three';

export type Vec3 = readonly [number, number, number];
export type Point2 = readonly [number, number];

export interface PartOptions {
  /** Position of the part's centre (or its documented anchor). */
  at?: Vec3;
  /** Euler XYZ rotation, radians. */
  rot?: Vec3;
  scale?: number | Vec3;
  name?: string;
}

function applyOptions(object: Object3D, opts: PartOptions | undefined): void {
  if (!opts) return;
  if (opts.at) object.position.set(opts.at[0], opts.at[1], opts.at[2]);
  if (opts.rot) object.rotation.set(opts.rot[0], opts.rot[1], opts.rot[2]);
  if (opts.scale !== undefined) {
    if (typeof opts.scale === 'number') object.scale.setScalar(opts.scale);
    else object.scale.set(opts.scale[0], opts.scale[1], opts.scale[2]);
  }
  if (opts.name) object.name = opts.name;
}

/** Wrap a geometry in a shadow-casting mesh with the given material. */
export function part(
  geometry: BufferGeometry,
  mat: MeshStandardMaterial,
  opts?: PartOptions,
): Mesh {
  const mesh = new Mesh(geometry, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  applyOptions(mesh, opts);
  return mesh;
}

/** `BoxGeometry` sized `[x, y, z]`, centred on its own origin. */
export function box(size: Vec3, mat: MeshStandardMaterial, opts?: PartOptions): Mesh {
  return part(new BoxGeometry(size[0], size[1], size[2]), mat, opts);
}

export interface CylOptions extends PartOptions {
  /** Top radius; defaults to `r` (a straight cylinder). */
  rTop?: number;
  axis?: 'x' | 'y' | 'z';
  segments?: number;
  open?: boolean;
}

/** Cylinder / truncated cone. `axis` picks which world axis it runs along. */
export function cyl(
  r: number,
  h: number,
  mat: MeshStandardMaterial,
  opts: CylOptions = {},
): Mesh {
  const geom = new CylinderGeometry(
    opts.rTop ?? r,
    r,
    h,
    opts.segments ?? 20,
    1,
    opts.open ?? false,
  );
  if (opts.axis === 'x') geom.rotateZ(Math.PI / 2);
  else if (opts.axis === 'z') geom.rotateX(Math.PI / 2);
  return part(geom, mat, opts);
}

export function cone(
  r: number,
  h: number,
  mat: MeshStandardMaterial,
  opts: PartOptions & { segments?: number } = {},
): Mesh {
  return part(new ConeGeometry(r, h, opts.segments ?? 20), mat, opts);
}

export function sphere(
  r: number,
  mat: MeshStandardMaterial,
  opts: PartOptions & { segments?: number } = {},
): Mesh {
  const s = opts.segments ?? 14;
  return part(new SphereGeometry(r, s, Math.max(6, Math.round(s * 0.6))), mat, opts);
}

/** Capsule running along Y. Total height is `length + 2 * r`. */
export function capsule(
  r: number,
  length: number,
  mat: MeshStandardMaterial,
  opts: PartOptions & { segments?: number } = {},
): Mesh {
  return part(new CapsuleGeometry(r, Math.max(length, 0.001), 4, opts.segments ?? 12), mat, opts);
}

export function torus(
  r: number,
  tube: number,
  mat: MeshStandardMaterial,
  opts: PartOptions & { segments?: number } = {},
): Mesh {
  return part(new TorusGeometry(r, tube, 8, opts.segments ?? 20), mat, opts);
}

/**
 * Rounded polygon in the XY plane.
 *
 * Corner rounding is what stops every prop reading as a stack of boxes; the
 * radius is clamped per corner so a short edge cannot invert the outline.
 */
export function roundedShape(points: readonly Point2[], radius: number): Shape {
  const n = points.length;
  const shape = new Shape();
  if (n < 3) throw new Error('roundedShape needs at least 3 points');

  const at = (i: number): Point2 => points[((i % n) + n) % n] as Point2;
  const lerp = (a: Point2, b: Point2, t: number): Point2 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ];
  const dist = (a: Point2, b: Point2): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

  let started = false;
  for (let i = 0; i < n; i++) {
    const prev = at(i - 1);
    const cur = at(i);
    const next = at(i + 1);
    const dPrev = dist(prev, cur);
    const dNext = dist(cur, next);
    const r = Math.min(radius, dPrev * 0.5, dNext * 0.5);
    const start = lerp(cur, prev, dPrev === 0 ? 0 : r / dPrev);
    const end = lerp(cur, next, dNext === 0 ? 0 : r / dNext);
    if (!started) {
      shape.moveTo(start[0], start[1]);
      started = true;
    } else {
      shape.lineTo(start[0], start[1]);
    }
    if (r > 1e-6) shape.quadraticCurveTo(cur[0], cur[1], end[0], end[1]);
  }
  shape.closePath();
  return shape;
}

export interface ProfileOptions extends PartOptions {
  /** Corner rounding radius applied to the 2D outline. */
  radius?: number;
  /** Edge chamfer on the two extruded faces. Consumes part of `width`. */
  bevel?: number;
  curveSegments?: number;
}

/**
 * Extrude a side-view outline (X = length, Y = height) along Z.
 *
 * The result occupies exactly the authored outline in XY and exactly `width`
 * in Z, centred on Z. Both halves of that need care: the bevel eats into the
 * extrusion depth rather than adding to it, and `bevelOffset: -bevel` starts
 * the chamfer *inside* the outline so it rounds the silhouette instead of
 * inflating it. Without the offset every profiled prop came out 2·bevel too
 * long and too tall, and sat a bevel below the ground plane.
 */
export function profileGeometry(
  points: readonly Point2[],
  width: number,
  opts: ProfileOptions = {},
): BufferGeometry {
  const bevel = Math.min(opts.bevel ?? 0.05, width * 0.24);
  const depth = Math.max(width - 2 * bevel, 0.002);
  const shape = roundedShape(points, opts.radius ?? 0);
  const geom = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 1e-4,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 1,
    curveSegments: opts.curveSegments ?? 4,
    steps: 1,
  });
  geom.translate(0, 0, -depth / 2);
  geom.computeVertexNormals();
  return geom;
}

/** `profileGeometry` as a mesh. */
export function profile(
  points: readonly Point2[],
  width: number,
  mat: MeshStandardMaterial,
  opts: ProfileOptions = {},
): Mesh {
  return part(profileGeometry(points, width, opts), mat, opts);
}

/** Lathe a half-outline (x = radius, y = height) around Y. */
export function lathe(
  outline: readonly Point2[],
  mat: MeshStandardMaterial,
  opts: PartOptions & { segments?: number } = {},
): Mesh {
  const pts = outline.map(([x, y]) => new Vector2(x, y));
  return part(new LatheGeometry(pts, opts.segments ?? 20), mat, opts);
}

/** Add children to a group and return the group (fluent assembly). */
export function assemble(group: Group, ...children: Object3D[]): Group {
  for (const child of children) group.add(child);
  return group;
}

/** Mirror a part factory across the Z axis (left/right pairs). */
export function mirrored(z: number, make: (z: number) => Object3D): Object3D[] {
  return [make(z), make(-z)];
}

/** Deterministic 0..1 noise, so generated clutter is stable across builds. */
export function rand(seed: number): () => number {
  let s = (seed | 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 8) & 0xffffff) / 0xffffff;
  };
}
