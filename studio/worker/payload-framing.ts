import { readFile } from "node:fs/promises";

export type Vec3 = [number, number, number];
export type WorldBounds = { min: Vec3; max: Vec3 };
export type FramedPayload = { eye: Vec3; target: Vec3 };

type GltfAccessor = { min?: number[]; max?: number[] };
type GltfPrimitive = { attributes?: { POSITION?: number } };
type GltfMesh = { primitives?: GltfPrimitive[] };
type GltfNode = {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
};
type GltfDocument = {
  accessors?: GltfAccessor[];
  meshes?: GltfMesh[];
  nodes?: GltfNode[];
  scenes?: Array<{ nodes?: number[] }>;
  scene?: number;
};

type Mat4 = [number, number, number, number, number, number, number, number,
  number, number, number, number, number, number, number, number];

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = Array<number>(16).fill(0) as Mat4;
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) {
        const index = column * 4 + row;
        out[index] = (out[index] ?? 0) + (a[k * 4 + row] ?? 0) * (b[column * 4 + k] ?? 0);
      }
    }
  }
  return out;
}

function vec3(value: number[] | undefined, fallback: Vec3): Vec3 {
  return value?.length === 3 ? [value[0]!, value[1]!, value[2]!] : fallback;
}

function quat(value: number[] | undefined): [number, number, number, number] {
  return value?.length === 4 ? [value[0]!, value[1]!, value[2]!, value[3]!] : [0, 0, 0, 1];
}

function nodeMatrix(node: GltfNode): Mat4 {
  if (node.matrix?.length === 16) return [...node.matrix] as Mat4;
  const [x, y, z, w] = quat(node.rotation);
  const [sx, sy, sz] = vec3(node.scale, [1, 1, 1]);
  const [tx, ty, tz] = vec3(node.translation, [0, 0, 0]);
  const x2 = x + x; const y2 = y + y; const z2 = z + z;
  const xx = x * x2; const xy = x * y2; const xz = x * z2;
  const yy = y * y2; const yz = y * z2; const zz = z * z2;
  const wx = w * x2; const wy = w * y2; const wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function transformPoint(matrix: Mat4, point: Vec3): Vec3 {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

export function boundsCorners(bounds: WorldBounds): Vec3[] {
  const corners: Vec3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) {
    for (const z of [bounds.min[2], bounds.max[2]]) corners.push([x, y, z]);
  }
  return corners;
}

function include(bounds: WorldBounds, point: Vec3): void {
  bounds.min = [
    Math.min(bounds.min[0], point[0]),
    Math.min(bounds.min[1], point[1]),
    Math.min(bounds.min[2], point[2]),
  ];
  bounds.max = [
    Math.max(bounds.max[0], point[0]),
    Math.max(bounds.max[1], point[1]),
    Math.max(bounds.max[2], point[2]),
  ];
}

function parseGltfJson(bytes: Buffer): GltfDocument {
  if (bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "glTF") {
    const jsonLength = bytes.readUInt32LE(12);
    const chunkType = bytes.readUInt32LE(16);
    if (chunkType !== 0x4e4f534a || 20 + jsonLength > bytes.length) {
      throw new Error("GLB has no valid JSON chunk");
    }
    return JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength).trimEnd()) as GltfDocument;
  }
  return JSON.parse(bytes.toString("utf8")) as GltfDocument;
}

/**
 * Resolve accessor bounds through the complete glTF node hierarchy. Accessor
 * min/max values are mesh-local; every parent and node TRS/matrix is composed
 * before the eight corners are accumulated into one world-space AABB.
 */
export async function computePayloadWorldBounds(paths: readonly string[]): Promise<WorldBounds> {
  const bounds: WorldBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const path of paths) {
    const gltf = parseGltfJson(await readFile(path));
    const nodes = gltf.nodes ?? [];
    const childNodes = new Set(nodes.flatMap((node) => node.children ?? []));
    const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? nodes.map((_, index) => index).filter((index) => !childNodes.has(index));
    const visit = (index: number, parent: Mat4): void => {
      const node = nodes[index];
      if (!node) return;
      const world = multiply(parent, nodeMatrix(node));
      if (node.mesh !== undefined) {
        for (const primitive of gltf.meshes?.[node.mesh]?.primitives ?? []) {
          const accessorIndex = primitive.attributes?.POSITION;
          const accessor = accessorIndex === undefined ? undefined : gltf.accessors?.[accessorIndex];
          if (!accessor?.min || !accessor.max || accessor.min.length < 3 || accessor.max.length < 3) continue;
          for (const corner of boundsCorners({ min: accessor.min.slice(0, 3) as Vec3, max: accessor.max.slice(0, 3) as Vec3 })) {
            include(bounds, transformPoint(world, corner));
          }
        }
      }
      for (const child of node.children ?? []) visit(child, world);
    };
    for (const root of roots) visit(root, IDENTITY);
  }
  if (!bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite)) {
    throw new Error("native payloads contain no POSITION accessor bounds");
  }
  return bounds;
}

/**
 * Frame a world-space AABB from an elevated oblique y-up view. Enclosing the
 * box in a sphere makes the guarantee independent of camera orientation: a
 * distance of radius/sin(the narrower half-FOV) contains that sphere in both
 * frustum axes. The 5% margin absorbs floating-point and raster edge rounding.
 */
export function framePayload(bounds: WorldBounds, aspect: number, fovYDeg: number): FramedPayload {
  if (!(aspect > 0) || !(fovYDeg > 0 && fovYDeg < 180)) throw new Error("invalid camera intrinsics");
  const target: Vec3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const halfX = Math.max((bounds.max[0] - bounds.min[0]) / 2, 0.01);
  const halfY = Math.max((bounds.max[1] - bounds.min[1]) / 2, 0.01);
  const halfZ = Math.max((bounds.max[2] - bounds.min[2]) / 2, 0.01);
  const radius = Math.hypot(halfX, halfY, halfZ);
  const halfYFov = (fovYDeg * Math.PI) / 360;
  const halfXFov = Math.atan(Math.tan(halfYFov) * aspect);
  const distance = 1.05 * radius / Math.sin(Math.min(halfYFov, halfXFov));
  const directionLength = Math.hypot(1, 1.2, 1);
  const direction: Vec3 = [1 / directionLength, 1.2 / directionLength, 1 / directionLength];
  return {
    eye: [
      target[0] + direction[0] * distance,
      target[1] + direction[1] * distance,
      target[2] + direction[2] * distance,
    ],
    target,
  };
}
