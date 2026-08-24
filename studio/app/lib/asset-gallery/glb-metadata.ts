import "server-only";

import sharp from "sharp";
import { GALLERY_MAX_THUMBNAIL_BYTES } from "./contracts";

const GLB_HEADER_BYTES = 12;
const GLB_CHUNK_HEADER_BYTES = 8;
const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;
const TRIANGLES_MODE = 4;
const THUMBNAIL_SIZE = 512;
const WEBP_QUALITIES = [90, 80, 70, 60, 50, 40, 30, 20, 10] as const;

type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];
type Mat4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

interface GltfAccessor {
  count?: number;
  min?: number[];
  max?: number[];
}

interface GltfPrimitive {
  mode?: number;
  indices?: number;
  attributes?: Record<string, number>;
}

interface GltfMesh {
  primitives?: GltfPrimitive[];
}

interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface GltfScene {
  nodes?: number[];
}

interface GltfAnimation {
  name?: string;
}

interface GltfDocument {
  asset?: { version?: string };
  accessors?: GltfAccessor[];
  meshes?: GltfMesh[];
  nodes?: GltfNode[];
  scenes?: GltfScene[];
  scene?: number;
  materials?: unknown[];
  animations?: GltfAnimation[];
  extensionsUsed?: unknown[];
}

export interface GlbMetadata {
  dims: { l: number; w: number; h: number };
  bounds: { min: [number, number, number]; max: [number, number, number] };
  triangleCount: number;
  meshCount: number;
  materialCount: number;
  extensions: string[];
  animated: boolean;
  clips: string[];
}

export class GlbParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlbParseError";
  }
}

function parseJsonChunk(bytes: Uint8Array): GltfDocument {
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/[\u0000\u0020\t\r\n]+$/u, "");
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown JSON error";
    throw new GlbParseError(`GLB JSON chunk is invalid: ${reason}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GlbParseError("GLB JSON chunk must contain an object");
  }
  return parsed as GltfDocument;
}

function gltfFromContainer(bytes: Uint8Array): GltfDocument {
  if (bytes.byteLength < GLB_HEADER_BYTES) {
    throw new GlbParseError(
      `GLB header is truncated: expected ${GLB_HEADER_BYTES} bytes, received ${bytes.byteLength}`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    throw new GlbParseError(`GLB magic is invalid: expected 0x46546c67, received 0x${magic.toString(16).padStart(8, "0")}`);
  }

  const version = view.getUint32(4, true);
  if (version !== 2) throw new GlbParseError(`GLB version ${version} is unsupported; expected version 2`);

  const declaredLength = view.getUint32(8, true);
  if (declaredLength < GLB_HEADER_BYTES) {
    throw new GlbParseError(`GLB declared length ${declaredLength} is smaller than its header`);
  }
  if (declaredLength > bytes.byteLength) {
    throw new GlbParseError(`GLB is truncated: header declares ${declaredLength} bytes, received ${bytes.byteLength}`);
  }
  if (declaredLength !== bytes.byteLength) {
    throw new GlbParseError(`GLB length mismatch: header declares ${declaredLength} bytes, received ${bytes.byteLength}`);
  }

  let offset = GLB_HEADER_BYTES;
  let json: GltfDocument | null = null;
  while (offset < declaredLength) {
    if (declaredLength - offset < GLB_CHUNK_HEADER_BYTES) {
      throw new GlbParseError(`GLB chunk header at byte ${offset} is truncated`);
    }
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkStart = offset + GLB_CHUNK_HEADER_BYTES;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > declaredLength || chunkEnd < chunkStart) {
      throw new GlbParseError(
        `GLB chunk at byte ${offset} declares ${chunkLength} data bytes beyond the ${declaredLength}-byte container`,
      );
    }

    if (chunkType === GLB_JSON_CHUNK) {
      if (json) throw new GlbParseError("GLB contains more than one JSON chunk");
      json = parseJsonChunk(bytes.subarray(chunkStart, chunkEnd));
    } else if (chunkType === GLB_BIN_CHUNK) {
      // BIN payloads are intentionally left unread: accessor bounds and counts live in JSON,
      // so touching several megabytes of geometry would add cost without changing metadata.
    }
    offset = chunkEnd;
  }

  if (!json) throw new GlbParseError("GLB does not contain a JSON chunk");
  if (json.asset?.version !== "2.0") {
    throw new GlbParseError(`glTF asset version ${json.asset?.version ?? "missing"} is unsupported; expected 2.0`);
  }
  return json;
}

function assertFiniteVector(
  value: number[] | undefined,
  length: number,
  label: string,
): asserts value is number[] {
  if (!Array.isArray(value) || value.length !== length || value.some((entry) => !Number.isFinite(entry))) {
    throw new GlbParseError(`${label} must contain ${length} finite numbers`);
  }
}

function finiteVec3(value: number[] | undefined, label: string): Vec3 {
  assertFiniteVector(value, 3, label);
  return [value[0]!, value[1]!, value[2]!];
}

function finiteVec4(value: number[] | undefined, label: string): Vec4 {
  assertFiniteVector(value, 4, label);
  return [value[0]!, value[1]!, value[2]!, value[3]!];
}

function finiteMat4(value: number[] | undefined, label: string): Mat4 {
  assertFiniteVector(value, 16, label);
  return [
    value[0]!, value[1]!, value[2]!, value[3]!,
    value[4]!, value[5]!, value[6]!, value[7]!,
    value[8]!, value[9]!, value[10]!, value[11]!,
    value[12]!, value[13]!, value[14]!, value[15]!,
  ];
}

function nonnegativeInteger(value: number | undefined, label: string): number {
  if (!Number.isInteger(value) || (value ?? -1) < 0) throw new GlbParseError(`${label} must be a non-negative integer`);
  return value!;
}

function indexed<T>(items: T[] | undefined, index: number | undefined, label: string): T {
  if (!Number.isInteger(index) || (index ?? -1) < 0 || !items || index === undefined || index >= items.length) {
    throw new GlbParseError(`${label} references invalid index ${String(index)}`);
  }
  return items[index]!;
}

const IDENTITY: Mat4 = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

function multiplyMatrices(left: Mat4, right: Mat4): Mat4 {
  const result = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let index = 0; index < 4; index += 1) {
        value += left[index * 4 + row]! * right[column * 4 + index]!;
      }
      result[column * 4 + row] = value;
    }
  }
  return result as Mat4;
}

function nodeMatrix(node: GltfNode, nodeIndex: number): Mat4 {
  if (node.matrix !== undefined) {
    return finiteMat4(node.matrix, `node ${nodeIndex} matrix`);
  }

  const translation: Vec3 = node.translation === undefined
    ? [0, 0, 0]
    : finiteVec3(node.translation, `node ${nodeIndex} translation`);
  const rotation: Vec4 = node.rotation === undefined
    ? [0, 0, 0, 1]
    : finiteVec4(node.rotation, `node ${nodeIndex} rotation`);
  const scale: Vec3 = node.scale === undefined
    ? [1, 1, 1]
    : finiteVec3(node.scale, `node ${nodeIndex} scale`);

  const quaternionLength = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
  if (quaternionLength === 0) throw new GlbParseError(`node ${nodeIndex} rotation quaternion has zero length`);
  const x = rotation[0] / quaternionLength;
  const y = rotation[1] / quaternionLength;
  const z = rotation[2] / quaternionLength;
  const w = rotation[3] / quaternionLength;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  return [
    (1 - (yy + zz)) * scale[0], (xy + wz) * scale[0], (xz - wy) * scale[0], 0,
    (xy - wz) * scale[1], (1 - (xx + zz)) * scale[1], (yz + wx) * scale[1], 0,
    (xz + wy) * scale[2], (yz - wx) * scale[2], (1 - (xx + yy)) * scale[2], 0,
    translation[0], translation[1], translation[2], 1,
  ];
}

function transformPoint(matrix: Mat4, x: number, y: number, z: number): Vec3 {
  const denominator = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (!Number.isFinite(denominator) || denominator === 0) {
    throw new GlbParseError("node transform maps a POSITION bound to an invalid homogeneous coordinate");
  }
  return [
    (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / denominator,
    (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / denominator,
    (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / denominator,
  ];
}

function triangleCountFor(document: GltfDocument): number {
  let triangles = 0;
  for (const [meshIndex, mesh] of (document.meshes ?? []).entries()) {
    for (const [primitiveIndex, primitive] of (mesh.primitives ?? []).entries()) {
      if (primitive.mode !== undefined && primitive.mode !== TRIANGLES_MODE) continue;
      const count = primitive.indices === undefined
        ? indexed(
          document.accessors,
          primitive.attributes?.POSITION,
          `mesh ${meshIndex} primitive ${primitiveIndex} POSITION`,
        ).count
        : indexed(
          document.accessors,
          primitive.indices,
          `mesh ${meshIndex} primitive ${primitiveIndex} indices`,
        ).count;
      triangles += nonnegativeInteger(count, `mesh ${meshIndex} primitive ${primitiveIndex} accessor count`) / 3;
    }
  }
  if (!Number.isInteger(triangles)) throw new GlbParseError("triangle accessor counts must be divisible by 3");
  return triangles;
}

function sceneBounds(document: GltfDocument): { min: Vec3; max: Vec3 } {
  const scenes = document.scenes ?? [];
  if (scenes.length === 0) throw new GlbParseError("glTF has no scene from which to measure bounds");
  const sceneIndex = document.scene ?? 0;
  const scene = indexed(scenes, sceneIndex, "default scene");
  const min: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  let measuredPrimitive = false;

  const visit = (nodeIndex: number, parentMatrix: Mat4, ancestors: number[]) => {
    if (ancestors.includes(nodeIndex)) {
      throw new GlbParseError(`scene graph contains a cycle at node ${nodeIndex}`);
    }
    const node = indexed(document.nodes, nodeIndex, "scene node");
    const worldMatrix = multiplyMatrices(parentMatrix, nodeMatrix(node, nodeIndex));
    if (node.mesh !== undefined) {
      const mesh = indexed(document.meshes, node.mesh, `node ${nodeIndex} mesh`);
      for (const [primitiveIndex, primitive] of (mesh.primitives ?? []).entries()) {
        if (primitive.attributes?.POSITION === undefined) continue;
        const accessor = indexed(
          document.accessors,
          primitive.attributes.POSITION,
          `node ${nodeIndex} primitive ${primitiveIndex} POSITION`,
        );
        const localMin = finiteVec3(accessor.min, `POSITION accessor ${primitive.attributes.POSITION} min`);
        const localMax = finiteVec3(accessor.max, `POSITION accessor ${primitive.attributes.POSITION} max`);
        if (localMin[0] > localMax[0] || localMin[1] > localMax[1] || localMin[2] > localMax[2]) {
          throw new GlbParseError(`POSITION accessor ${primitive.attributes.POSITION} has min greater than max`);
        }

        // A rotation can make either endpoint cease to be extreme on a world axis;
        // all eight corners are required rather than transforming only min and max.
        for (const x of [localMin[0], localMax[0]]) {
          for (const y of [localMin[1], localMax[1]]) {
            for (const z of [localMin[2], localMax[2]]) {
              const point = transformPoint(worldMatrix, x, y, z);
              min[0] = Math.min(min[0], point[0]);
              min[1] = Math.min(min[1], point[1]);
              min[2] = Math.min(min[2], point[2]);
              max[0] = Math.max(max[0], point[0]);
              max[1] = Math.max(max[1], point[1]);
              max[2] = Math.max(max[2], point[2]);
            }
          }
        }
        measuredPrimitive = true;
      }
    }

    const nextAncestors = [...ancestors, nodeIndex];
    for (const child of node.children ?? []) visit(child, worldMatrix, nextAncestors);
  };

  for (const nodeIndex of scene.nodes ?? []) visit(nodeIndex, IDENTITY, []);
  if (!measuredPrimitive) throw new GlbParseError("default scene has no mesh primitive with POSITION bounds");
  return { min, max };
}

export function readGlbMetadata(bytes: Uint8Array): GlbMetadata {
  const document = gltfFromContainer(bytes);
  const bounds = sceneBounds(document);
  const sizeX = bounds.max[0] - bounds.min[0];
  const sizeY = bounds.max[1] - bounds.min[1];
  const sizeZ = bounds.max[2] - bounds.min[2];
  const animations = document.animations ?? [];
  const clips = animations.map((animation, index) => {
    const name = typeof animation.name === "string" ? animation.name.trim() : "";
    return name || `animation-${index}`;
  });

  return {
    // glTF is Y-up and SimForge actors face +X. These dimensions are metres only
    // because the Meshy request enables auto_size; a generic GLB has no unit.
    dims: { l: sizeX, w: sizeZ, h: sizeY },
    bounds,
    triangleCount: triangleCountFor(document),
    meshCount: document.meshes?.length ?? 0,
    materialCount: document.materials?.length ?? 0,
    extensions: (document.extensionsUsed ?? []).filter((extension): extension is string => typeof extension === "string"),
    animated: animations.length > 0,
    clips,
  };
}

export async function referenceThumbnailToWebp(png: Uint8Array): Promise<Uint8Array> {
  // Browser imports render a 512px WebGL canvas, but generated assets arrive in a
  // server worker with no DOM or canvas. Sharp provides the equivalent bounded,
  // alpha-preserving encode without pulling the browser renderer into Node.
  const resized = sharp(png, { failOn: "error" }).resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
    fit: "inside",
    withoutEnlargement: true,
  });
  let smallest: Uint8Array | null = null;
  for (const quality of WEBP_QUALITIES) {
    const encoded = await resized.clone().webp({ quality, alphaQuality: 100, effort: 6 }).toBuffer();
    smallest = encoded;
    if (encoded.byteLength <= GALLERY_MAX_THUMBNAIL_BYTES) return encoded;
  }
  throw new Error(
    `Generated thumbnail is ${smallest?.byteLength ?? 0} bytes after minimum-quality WebP encoding; maximum is ${GALLERY_MAX_THUMBNAIL_BYTES}`,
  );
}
