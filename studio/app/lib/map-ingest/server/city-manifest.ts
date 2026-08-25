import { Buffer } from "node:buffer";

import { buildStaticSemantics } from "@simcloud/shared/map-ingest/static-semantics";

import type { CityManifest as CityManifestDocument } from "@simforge/viewer";
import type { MapLayerId } from "@/app/lib/map-ingest/contracts";

export type { CityManifestDocument };

export type GeneratorLayer = {
  layerId: MapLayerId;
  fileName: string;
  bytes: Buffer;
};

export class MissingRoadLayerError extends Error {
  constructor() {
    super("A road GLB layer is required to build a city manifest");
    this.name = "MissingRoadLayerError";
  }
}

export class InvalidGlbSceneError extends Error {
  constructor(fileName: string, reason: string) {
    super(`Cannot inspect ${fileName}: ${reason}`);
    this.name = "InvalidGlbSceneError";
  }
}

type Vec3 = [number, number, number];
type Bounds = { min: Vec3; max: Vec3 };
type GlbAccessor = { count?: number; min?: number[]; max?: number[] };
type GlbPrimitive = {
  attributes?: { POSITION?: number };
  indices?: number;
  mode?: number;
};
type GlbMesh = { primitives?: GlbPrimitive[] };
type GlbNode = {
  children?: number[];
  mesh?: number;
  matrix?: number[];
  rotation?: number[];
  scale?: number[];
  translation?: number[];
};
type GlbScene = { nodes?: number[] };
type GlbDocument = {
  accessors?: GlbAccessor[];
  meshes?: GlbMesh[];
  nodes?: GlbNode[];
  scene?: number;
  scenes?: GlbScene[];
};


const IDENTITY_MATRIX = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
] as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function component(values: readonly number[] | undefined, index: number, fallback: number): number {
  const value = values?.[index];
  return Number.isFinite(value) ? value! : fallback;
}

function multiplyMatrices(left: readonly number[], right: readonly number[]): number[] {
  const output = new Array<number>(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let inner = 0; inner < 4; inner += 1) {
        value += component(left, inner * 4 + row, 0) * component(right, column * 4 + inner, 0);
      }
      output[column * 4 + row] = value;
    }
  }
  return output;
}

function nodeMatrix(node: GlbNode): number[] {
  if (node.matrix?.length === 16 && node.matrix.every(Number.isFinite)) return [...node.matrix];

  const x = component(node.rotation, 0, 0);
  const y = component(node.rotation, 1, 0);
  const z = component(node.rotation, 2, 0);
  const w = component(node.rotation, 3, 1);
  const sx = component(node.scale, 0, 1);
  const sy = component(node.scale, 1, 1);
  const sz = component(node.scale, 2, 1);
  const tx = component(node.translation, 0, 0);
  const ty = component(node.translation, 1, 0);
  const tz = component(node.translation, 2, 0);

  return [
    (1 - 2 * y * y - 2 * z * z) * sx,
    (2 * x * y + 2 * z * w) * sx,
    (2 * x * z - 2 * y * w) * sx,
    0,
    (2 * x * y - 2 * z * w) * sy,
    (1 - 2 * x * x - 2 * z * z) * sy,
    (2 * y * z + 2 * x * w) * sy,
    0,
    (2 * x * z + 2 * y * w) * sz,
    (2 * y * z - 2 * x * w) * sz,
    (1 - 2 * x * x - 2 * y * y) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

function transformPoint(matrix: readonly number[], point: Vec3): Vec3 {
  const x = point[0];
  const y = point[1];
  const z = point[2];
  return [
    component(matrix, 0, 0) * x + component(matrix, 4, 0) * y + component(matrix, 8, 0) * z + component(matrix, 12, 0),
    component(matrix, 1, 0) * x + component(matrix, 5, 0) * y + component(matrix, 9, 0) * z + component(matrix, 13, 0),
    component(matrix, 2, 0) * x + component(matrix, 6, 0) * y + component(matrix, 10, 0) * z + component(matrix, 14, 0),
  ];
}

function includePoint(bounds: Bounds, point: Vec3): void {
  for (let axis = 0; axis < 3; axis += 1) {
    const value = point[axis]!;
    bounds.min[axis] = Math.min(bounds.min[axis]!, value);
    bounds.max[axis] = Math.max(bounds.max[axis]!, value);
  }
}

function includeTransformedBounds(bounds: Bounds, localMin: Vec3, localMax: Vec3, matrix: readonly number[]): void {
  for (const x of [localMin[0], localMax[0]]) {
    for (const y of [localMin[1], localMax[1]]) {
      for (const z of [localMin[2], localMax[2]]) {
        includePoint(bounds, transformPoint(matrix, [x, y, z]));
      }
    }
  }
}

function triangleCount(primitive: GlbPrimitive, accessors: readonly GlbAccessor[]): number {
  const positionIndex = primitive.attributes?.POSITION;
  const position = Number.isInteger(positionIndex) ? accessors[positionIndex!] : undefined;
  const indices = Number.isInteger(primitive.indices) ? accessors[primitive.indices!] : undefined;
  const count = indices?.count ?? position?.count ?? 0;
  switch (primitive.mode ?? 4) {
    case 4:
      return Math.floor(count / 3);
    case 5:
    case 6:
      return Math.max(0, count - 2);
    default:
      return 0;
  }
}

function parseGlbDocument(layer: GeneratorLayer): GlbDocument {
  const bytes = layer.bytes;
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) {
    throw new InvalidGlbSceneError(layer.fileName, "expected binary glTF 2.0");
  }
  if (bytes.readUInt32LE(8) !== bytes.length) {
    throw new InvalidGlbSceneError(layer.fileName, "GLB length header does not match its bytes");
  }
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a || 20 + jsonLength > bytes.length) {
    throw new InvalidGlbSceneError(layer.fileName, "invalid JSON chunk");
  }
  try {
    return JSON.parse(
      bytes.subarray(20, 20 + jsonLength).toString("utf8").replace(/[\0 ]+$/, ""),
    ) as GlbDocument;
  } catch (error) {
    throw new InvalidGlbSceneError(
      layer.fileName,
      error instanceof Error ? error.message : "invalid JSON",
    );
  }
}

function inspectLayer(layer: GeneratorLayer): { bounds: Bounds; triangles: number } {
  const document = parseGlbDocument(layer);
  const nodes = document.nodes ?? [];
  const meshes = document.meshes ?? [];
  const accessors = document.accessors ?? [];
  const scene = document.scenes?.[document.scene ?? 0];
  const childNodes = new Set(nodes.flatMap((node) => node.children ?? []));
  const roots = scene?.nodes ?? nodes.map((_, index) => index).filter((index) => !childNodes.has(index));
  const bounds: Bounds = {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  };
  let triangles = 0;

  const visit = (nodeIndex: number, parentMatrix: readonly number[], ancestors: ReadonlySet<number>): void => {
    if (ancestors.has(nodeIndex)) {
      throw new InvalidGlbSceneError(layer.fileName, `node hierarchy contains a cycle at node ${nodeIndex}`);
    }
    const node = nodes[nodeIndex];
    if (!node) throw new InvalidGlbSceneError(layer.fileName, `scene references missing node ${nodeIndex}`);
    const worldMatrix = multiplyMatrices(parentMatrix, nodeMatrix(node));
    if (Number.isInteger(node.mesh)) {
      const mesh = meshes[node.mesh!];
      if (!mesh) throw new InvalidGlbSceneError(layer.fileName, `node references missing mesh ${node.mesh}`);
      for (const primitive of mesh.primitives ?? []) {
        const positionIndex = primitive.attributes?.POSITION;
        const position = Number.isInteger(positionIndex) ? accessors[positionIndex!] : undefined;
        if (!position || position.min?.length !== 3 || position.max?.length !== 3) {
          throw new InvalidGlbSceneError(layer.fileName, "every rendered primitive needs POSITION min/max bounds");
        }
        const localMin: Vec3 = [position.min[0]!, position.min[1]!, position.min[2]!];
        const localMax: Vec3 = [position.max[0]!, position.max[1]!, position.max[2]!];
        if (![...localMin, ...localMax].every(Number.isFinite)) {
          throw new InvalidGlbSceneError(layer.fileName, "POSITION bounds must be finite");
        }
        includeTransformedBounds(bounds, localMin, localMax, worldMatrix);
        triangles += triangleCount(primitive, accessors);
      }
    }
    const nextAncestors = new Set(ancestors).add(nodeIndex);
    for (const childIndex of node.children ?? []) visit(childIndex, worldMatrix, nextAncestors);
  };

  for (const rootIndex of roots) visit(rootIndex, IDENTITY_MATRIX, new Set());
  if (![...bounds.min, ...bounds.max].every(Number.isFinite)) {
    throw new InvalidGlbSceneError(layer.fileName, "scene contains no bounded triangle geometry");
  }
  return { bounds, triangles };
}

export function buildCityManifest(
  layers: GeneratorLayer[],
): { manifest: CityManifestDocument; bytes: Buffer } {
  const orderedLayers = [...layers].sort(
    (left, right) => left.layerId.localeCompare(right.layerId) || left.fileName.localeCompare(right.fileName),
  );
  if (!orderedLayers.some((layer) => layer.layerId === "road")) throw new MissingRoadLayerError();

  const sceneBounds: Bounds = {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  };
  let totalTriangles = 0;
  const staticLayers = orderedLayers.map((layer) => {
    const inspected = inspectLayer(layer);
    includePoint(sceneBounds, inspected.bounds.min);
    includePoint(sceneBounds, inspected.bounds.max);
    totalTriangles += inspected.triangles;
    return {
      id: layer.layerId,
      file: layer.fileName,
      triangles: inspected.triangles,
      fileSize: layer.bytes.length,
    };
  });

  const width = sceneBounds.max[0] - sceneBounds.min[0];
  const depth = sceneBounds.max[2] - sceneBounds.min[2];
  const manifest: CityManifestDocument = {
    version: "1.2.0",
    generator: "simforge-map-upload",
    // This document is content-addressed; a build timestamp would make identical uploads produce different bytes.
    created: "1970-01-01T00:00:00.000Z",
    scene: {
      bounds: sceneBounds,
      totalTriangles,
      gridDimensions: [1, 1],
      cellSize: [width, depth],
      origin: [
        sceneBounds.min[0] + width / 2,
        sceneBounds.min[1],
        sceneBounds.min[2] + depth / 2,
      ],
      lodLevels: 1,
      coordinateSystem: "y-up",
    },
    tiles: [],
    staticLayers,
  };
  return { manifest, bytes: Buffer.from(`${canonicalJson(manifest)}\n`) };
}

export function buildSemantics(layers: GeneratorLayer[]): { bytes: Buffer } | null {
  const result = buildStaticSemantics(
    [...layers]
      .sort((left, right) => left.fileName.localeCompare(right.fileName))
      .map((layer) => ({ sourcePath: layer.fileName, role: "static", bytes: layer.bytes })),
  );
  // Anonymous exports legitimately have no stable node names to bind to sensor instance ids.
  if (result.semantics.objects.length === 0) return null;
  const semantics = JSON.parse(result.bytes.toString("utf8")) as unknown;
  return { bytes: Buffer.from(`${canonicalJson(semantics)}\n`) };
}
