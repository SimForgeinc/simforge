import { MeshoptDecoder } from 'meshoptimizer';
import { readGlb, writeGlb } from './map-derivatives.mjs';

export const SNOW_COVER_VARIANT_ID = 'snow-cover-v1';

const COMPONENT_BYTES = Object.freeze({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 });
const TYPE_COMPONENTS = Object.freeze({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 });
const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const MAX_ACCESSOR_COUNT = 0xffffffff;
const MAX_BYTE_STRIDE = 256;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;
const JSON_MEMORY_MULTIPLIER = 12;
const OUTPUT_SERIALIZATION_OVERHEAD_BYTES = 256 * 1024;

export function validateSnowCoverMemoryMiB(value = 512) {
  const mib = Number(value);
  if (!Number.isFinite(mib) || mib <= 0 || mib > 65536) throw new Error('maxMemoryMiB must be between 0 and 65536');
  return mib;
}

function words(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

const EXCLUDED = /(?:^| )(?:actors?|vehicles?|cars?|trucks?|buses|pedestrians?|walkers?|persons?|buildings?|roofs?|walls?|fences?|barriers?|bollards?|props?|signals?|signs?|poles?|lamps?|hydrants?|benches|bins?|vegetation|trees?|bush(?:es)?|shrubs?|foliage|leaves|trunks?|branches|groundcovers?|markings?|crosswalks?|arrows?)(?: |$)|(?:^| )ground covers?(?: |$)|(?:^| )lane marks?(?: |$)|(?:^| )stop (?:bars?|lines?)(?: |$)|(?:^| )road texts?(?: |$)/;
const RECEIVER = /(?:^| )(roads?|roadway|asphalt|terrain|ground|sidewalk|footpath|pavement|curb|kerb|gutter|verge|grass|soil|earth)(?: |$)/;

function labelDecision(value) {
  const normalized = words(value);
  if (!normalized) return null;
  if (EXCLUDED.test(normalized)) return { keep: false, reason: 'excluded-semantic' };
  if (!RECEIVER.test(normalized)) return null;
  const kind = /(?:^| )(?:sidewalk|footpath|pavement)(?: |$)/.test(normalized) ? 'sidewalk'
    : /(?:^| )(?:curb|kerb|gutter)(?: |$)/.test(normalized) ? 'curb'
      : /(?:^| )(?:road|roads|roadway|asphalt)(?: |$)/.test(normalized) ? 'road' : 'terrain';
  return { keep: true, kind };
}

function classifyReceiver(json, nodeNames, mesh, primitive) {
  const material = Number.isInteger(primitive.material) ? json.materials?.[primitive.material] : null;
  const assetLabels = [
    mesh.name,
    mesh.extras?.category,
    material?.name,
    material?.extras?.category,
  ];
  const assetDecisions = assetLabels.map(labelDecision).filter(Boolean);
  const assetExclusion = assetDecisions.find((decision) => !decision.keep);
  if (assetExclusion) return assetExclusion;
  const assetReceiver = assetDecisions.find((decision) => decision.keep);
  const nodeLabel = nodeNames.at(-1);
  const nodeDecision = labelDecision(nodeLabel);
  const genericContainer = /(?:^| )(?:group|collection|container|root|layer)(?: |$)/.test(words(nodeLabel));
  if (nodeDecision && !nodeDecision.keep && !(genericContainer && assetReceiver)) return nodeDecision;
  if (assetReceiver) return assetReceiver;
  if (nodeDecision) return nodeDecision;

  // Ancestors supply a fallback classification only. A generic Building or
  // Actor grouping node must not veto an explicit RoadSurface leaf identity.
  const ancestorDecisions = nodeNames.slice(0, -1).reverse().map(labelDecision).filter(Boolean);
  return ancestorDecisions[0] ?? { keep: false, reason: 'not-ground-receiver' };
}

function checkedInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function checkedProduct(left, right, label, maximum = Number.MAX_SAFE_INTEGER) {
  checkedInteger(left, `${label} left operand`);
  checkedInteger(right, `${label} right operand`);
  const product = left * right;
  if (!Number.isSafeInteger(product) || product > maximum) throw new Error(`${label} exceeds snow-cover memory budget`);
  return product;
}

function checkedSum(left, right, label, maximum = Number.MAX_SAFE_INTEGER) {
  checkedInteger(left, `${label} left operand`);
  checkedInteger(right, `${label} right operand`);
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum > maximum) throw new Error(`${label} exceeds snow-cover memory budget`);
  return sum;
}

function inspectGlbResidentMemory(sourceBuffer, limitBytes) {
  if (!Buffer.isBuffer(sourceBuffer) || sourceBuffer.length < 20 || sourceBuffer.readUInt32LE(0) !== 0x46546c67) {
    throw new Error('snow source must be a binary glTF buffer');
  }
  if (sourceBuffer.readUInt32LE(4) !== 2 || sourceBuffer.readUInt32LE(8) !== sourceBuffer.length) {
    throw new Error('snow source GLB header is invalid');
  }
  let offset = 12;
  let jsonBytes = 0;
  let binBytes = 0;
  let jsonChunks = 0;
  let binChunks = 0;
  while (offset < sourceBuffer.length) {
    if (offset + 8 > sourceBuffer.length) throw new Error('snow source GLB chunk header is truncated');
    const length = sourceBuffer.readUInt32LE(offset);
    const type = sourceBuffer.readUInt32LE(offset + 4);
    const chunkEnd = checkedSum(offset + 8, length, 'snow source GLB chunk range');
    if (chunkEnd > sourceBuffer.length) throw new Error('snow source GLB chunk is truncated');
    if (type === GLB_JSON_CHUNK) { jsonBytes = length; jsonChunks += 1; }
    else if (type === GLB_BIN_CHUNK) { binBytes = length; binChunks += 1; }
    offset = chunkEnd;
  }
  if (jsonChunks !== 1 || binChunks > 1) throw new Error('snow source GLB must contain one JSON chunk and at most one BIN chunk');
  const copiedJsonBytes = checkedProduct(jsonBytes, JSON_MEMORY_MULTIPLIER, 'snow parsed JSON memory');
  const residentBytes = checkedSum(
    checkedSum(sourceBuffer.length, binBytes, 'snow source plus copied BIN memory'),
    copiedJsonBytes,
    'snow source resident memory',
  );
  if (residentBytes > limitBytes) throw new Error('snow source resident state exceeds snow-cover memory budget');
  return residentBytes;
}

class MemoryBudget {
  constructor(maxMemoryMiB, sourceBuffer) {
    const mib = validateSnowCoverMemoryMiB(maxMemoryMiB);
    this.limitBytes = Math.floor(mib * 1024 * 1024);
    this.residentBytes = inspectGlbResidentMemory(sourceBuffer, this.limitBytes);
    this.decodedBytes = 0;
    this.peakRemapBytes = 0;
  }

  reserveDecoded(bytes, label) {
    checkedInteger(bytes, `${label} decoded bytes`, 0, this.limitBytes);
    if (this.residentBytes + this.decodedBytes + bytes > this.limitBytes) throw new Error(`${label} exceeds snow-cover memory budget`);
    this.decodedBytes += bytes;
  }

  assertOutput(positionValues, indexValues, remapEntries = 0) {
    checkedInteger(positionValues, 'snow output position value count', 0, MAX_ACCESSOR_COUNT * 3);
    checkedInteger(indexValues, 'snow output index count', 0, MAX_ACCESSOR_COUNT);
    checkedInteger(remapEntries, 'snow primitive remap size', 0, MAX_ACCESSOR_COUNT);
    // Packed JS number arrays, the live primitive Map, and the output BIN/GLB
    // copies coexist briefly. This deliberately overestimates the peak.
    const arrayBytes = checkedProduct(positionValues + indexValues, 8, 'snow output arrays', this.limitBytes);
    const mapBytes = checkedProduct(remapEntries, 48, 'snow primitive remap', this.limitBytes);
    this.peakRemapBytes = Math.max(this.peakRemapBytes, mapBytes);
    const packedBytes = checkedProduct(positionValues, 4, 'snow packed positions', this.limitBytes)
      + checkedProduct(indexValues, 4, 'snow packed indices', this.limitBytes);
    // position/index packing, their concatenated BIN, writeGlb's padded BIN,
    // and the final GLB can coexist until serialization returns.
    if (this.residentBytes + this.decodedBytes + arrayBytes + this.peakRemapBytes
      + packedBytes * 4 + OUTPUT_SERIALIZATION_OVERHEAD_BYTES > this.limitBytes) {
      throw new Error('snow output exceeds snow-cover memory budget');
    }
  }
}

function nodeMatrix(node) {
  if (node.matrix?.length === 16) return [...node.matrix];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
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

function multiply4(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    }
  }
  return out;
}

function transformPoint(matrix, point) {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ];
}

function normalizedValue(componentType, value) {
  if (componentType === 5120) return Math.max(value / 127, -1);
  if (componentType === 5121) return value / 255;
  if (componentType === 5122) return Math.max(value / 32767, -1);
  if (componentType === 5123) return value / 65535;
  if (componentType === 5125) return value / 4294967295;
  return value;
}

function readComponent(view, offset, componentType) {
  if (componentType === 5120) return view.getInt8(offset);
  if (componentType === 5121) return view.getUint8(offset);
  if (componentType === 5122) return view.getInt16(offset, true);
  if (componentType === 5123) return view.getUint16(offset, true);
  if (componentType === 5125) return view.getUint32(offset, true);
  if (componentType === 5126) return view.getFloat32(offset, true);
  throw new Error(`Unsupported component type ${componentType}`);
}

async function bufferViewBytes(json, bin, viewIndex, cache, budget) {
  if (cache.has(viewIndex)) return cache.get(viewIndex);
  const view = json.bufferViews?.[viewIndex];
  if (!view) throw new Error(`Missing bufferView ${viewIndex}`);
  const compressed = view.extensions?.EXT_meshopt_compression;
  let result;
  if (compressed) {
    if ((compressed.buffer ?? 0) !== 0) throw new Error(`Compressed bufferView ${viewIndex} is not stored in the GLB BIN chunk`);
    const count = checkedInteger(compressed.count, `bufferView ${viewIndex} meshopt count`, 0, MAX_ACCESSOR_COUNT);
    const stride = checkedInteger(compressed.byteStride, `bufferView ${viewIndex} meshopt byteStride`, 1, MAX_BYTE_STRIDE);
    const decodedLength = checkedProduct(count, stride, `bufferView ${viewIndex} decoded length`, budget.limitBytes);
    const sourceOffset = checkedInteger(compressed.byteOffset ?? 0, `bufferView ${viewIndex} compressed byteOffset`);
    const sourceLength = checkedInteger(compressed.byteLength, `bufferView ${viewIndex} compressed byteLength`);
    if (checkedSum(sourceOffset, sourceLength, `bufferView ${viewIndex} compressed range`) > bin.length) throw new Error(`bufferView ${viewIndex} compressed payload exceeds the GLB BIN chunk`);
    budget.reserveDecoded(decodedLength, `bufferView ${viewIndex}`);
    await MeshoptDecoder.ready;
    const bytes = new Uint8Array(decodedLength);
    MeshoptDecoder.decodeGltfBuffer(bytes, count, stride, bin.subarray(sourceOffset, sourceOffset + sourceLength), compressed.mode, compressed.filter);
    result = { bytes, stride };
  } else {
    if ((view.buffer ?? 0) !== 0) throw new Error(`bufferView ${viewIndex} has no readable GLB BIN payload`);
    const sourceOffset = checkedInteger(view.byteOffset ?? 0, `bufferView ${viewIndex} byteOffset`);
    const sourceLength = checkedInteger(view.byteLength, `bufferView ${viewIndex} byteLength`);
    if (checkedSum(sourceOffset, sourceLength, `bufferView ${viewIndex} range`) > bin.length) throw new Error(`bufferView ${viewIndex} exceeds the GLB BIN chunk`);
    const stride = view.byteStride === undefined ? undefined
      : checkedInteger(view.byteStride, `bufferView ${viewIndex} byteStride`, 1, MAX_BYTE_STRIDE);
    result = { bytes: bin.subarray(sourceOffset, sourceOffset + sourceLength), stride };
  }
  cache.set(viewIndex, result);
  return result;
}

async function accessorReader(json, bin, accessorIndex, cache, budget) {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`Missing accessor ${accessorIndex}`);
  if (accessor.sparse) throw new Error(`Sparse accessor ${accessorIndex} is unsupported`);
  if (!Number.isInteger(accessor.bufferView)) throw new Error(`Accessor ${accessorIndex} has no bufferView`);
  const components = TYPE_COMPONENTS[accessor.type];
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  if (!components || !componentBytes) throw new Error(`Unsupported accessor ${accessor.type}/${accessor.componentType}`);
  const count = checkedInteger(accessor.count, `accessor ${accessorIndex} count`, 0, MAX_ACCESSOR_COUNT);
  const elementBytes = checkedProduct(components, componentBytes, `accessor ${accessorIndex} element size`, MAX_BYTE_STRIDE);
  const source = await bufferViewBytes(json, bin, accessor.bufferView, cache, budget);
  const stride = source.stride ?? elementBytes;
  if (stride < elementBytes) throw new Error(`Accessor ${accessorIndex} byteStride is too small`);
  const accessorOffset = checkedInteger(accessor.byteOffset ?? 0, `accessor ${accessorIndex} byteOffset`);
  const requiredBytes = count === 0 ? accessorOffset : checkedSum(
    checkedSum(accessorOffset, checkedProduct(count - 1, stride, `accessor ${accessorIndex} stride span`), `accessor ${accessorIndex} range`),
    elementBytes,
    `accessor ${accessorIndex} element range`,
  );
  if (requiredBytes > source.bytes.byteLength) throw new Error(`Accessor ${accessorIndex} exceeds its bufferView`);
  const dataView = new DataView(source.bytes.buffer, source.bytes.byteOffset, source.bytes.byteLength);
  return {
    accessor,
    count,
    get(index) {
      checkedInteger(index, `accessor ${accessorIndex} index`, 0, count - 1);
      const start = accessorOffset + index * stride;
      if (components === 1) {
        const raw = readComponent(dataView, start, accessor.componentType);
        return accessor.normalized ? normalizedValue(accessor.componentType, raw) : raw;
      }
      const values = new Array(components);
      for (let component = 0; component < components; component += 1) {
        const raw = readComponent(dataView, start + component * componentBytes, accessor.componentType);
        values[component] = accessor.normalized ? normalizedValue(accessor.componentType, raw) : raw;
      }
      return values;
    },
  };
}

function triangleNormalY(a, b, c) {
  const abx = b[0] - a[0]; const aby = b[1] - a[1]; const abz = b[2] - a[2];
  const acx = c[0] - a[0]; const acy = c[1] - a[1]; const acz = c[2] - a[2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const length = Math.hypot(nx, ny, nz);
  return length > 1e-12 ? ny / length : null;
}

function makeKinds() {
  return Object.fromEntries(['road', 'terrain', 'sidewalk', 'curb'].map((kind) => [kind, { primitives: 0, triangles: 0 }]));
}

/** Build an indexed, texture-free, identity/world-space ground receiver shell. */
export async function makeSnowCoverGlb(sourceBuffer, options = {}) {
  const baseShellOffsetM = Number(options.baseShellOffsetM ?? 0);
  const minimumUpwardNormalY = Number(options.minimumUpwardNormalY ?? 0.28);
  if (!Number.isFinite(baseShellOffsetM) || baseShellOffsetM < 0 || baseShellOffsetM > 0.25) throw new Error('baseShellOffsetM must be between 0 and 0.25 meter');
  if (!Number.isFinite(minimumUpwardNormalY) || minimumUpwardNormalY < 0 || minimumUpwardNormalY > 1) throw new Error('minimumUpwardNormalY must be between 0 and 1');
  const budget = new MemoryBudget(options.maxMemoryMiB, sourceBuffer);
  const { json, bin } = readGlb(sourceBuffer);
  const nodes = json.nodes ?? [];
  const declaredRoots = json.scenes?.[json.scene ?? 0]?.nodes;
  const childNodes = new Set(nodes.flatMap((node) => node.children ?? []));
  const inferredRoots = nodes.map((_, index) => index).filter((index) => !childNodes.has(index));
  const roots = declaredRoots ?? (inferredRoots.length > 0 ? inferredRoots : nodes.map((_, index) => index));
  const viewCache = new Map();
  const positions = [];
  const indices = [];
  const receiverKinds = makeKinds();
  const report = {
    sourcePrimitives: 0, keptPrimitives: 0, excludedPrimitives: 0,
    sourceTriangles: 0, keptTriangles: 0, rejectedNonUpwardTriangles: 0,
    receiverKinds, baseShellOffsetM, elevationMode: 'runtime-world-y', retainedAttributes: ['POSITION'],
  };

  const visit = async (nodeIndex, parentMatrix, parentNames, ancestors) => {
    if (ancestors.has(nodeIndex)) throw new Error(`Node cycle at ${nodeIndex}`);
    const node = nodes[nodeIndex];
    if (!node) throw new Error(`Missing node ${nodeIndex}`);
    const world = multiply4(parentMatrix, nodeMatrix(node));
    const names = [...parentNames, node.name ?? ''];
    if (Number.isInteger(node.mesh)) {
      const mesh = json.meshes?.[node.mesh];
      if (!mesh) throw new Error(`Missing mesh ${node.mesh}`);
      for (const primitive of mesh.primitives ?? []) {
        report.sourcePrimitives += 1;
        const classification = classifyReceiver(json, names, mesh, primitive);
        if (!classification.keep || (primitive.mode ?? 4) !== 4 || !Number.isInteger(primitive.attributes?.POSITION)) {
          report.excludedPrimitives += 1;
          continue;
        }
        if (primitive.extensions?.KHR_draco_mesh_compression) throw new Error('KHR_draco_mesh_compression receiver primitive is unsupported');
        const sourcePositions = await accessorReader(json, bin, primitive.attributes.POSITION, viewCache, budget);
        if (sourcePositions.accessor.type !== 'VEC3') throw new Error('Receiver POSITION accessor must be VEC3');
        let sourceIndices;
        if (Number.isInteger(primitive.indices)) {
          sourceIndices = await accessorReader(json, bin, primitive.indices, viewCache, budget);
          if (sourceIndices.accessor.type !== 'SCALAR' || ![5121, 5123, 5125].includes(sourceIndices.accessor.componentType) || sourceIndices.accessor.normalized) {
            throw new Error('Receiver index accessor must be an unsigned non-normalized SCALAR');
          }
        } else {
          sourceIndices = { count: sourcePositions.count, get: (index) => index };
        }
        if (sourceIndices.count % 3 !== 0) throw new Error('Receiver triangle index count must be divisible by three');
        report.sourceTriangles += sourceIndices.count / 3;
        const remap = new Map();
        let primitiveTriangles = 0;
        for (let offset = 0; offset < sourceIndices.count; offset += 3) {
          const sourceVertexIndices = [sourceIndices.get(offset), sourceIndices.get(offset + 1), sourceIndices.get(offset + 2)];
          if (!sourceVertexIndices.every((value) => Number.isSafeInteger(value) && value >= 0 && value < sourcePositions.count)) throw new Error('Receiver primitive contains an out-of-range index');
          const points = sourceVertexIndices.map((index) => transformPoint(world, sourcePositions.get(index)));
          const normalY = triangleNormalY(...points);
          if (normalY === null || normalY < minimumUpwardNormalY) {
            report.rejectedNonUpwardTriangles += 1;
            continue;
          }
          const newVertices = sourceVertexIndices.filter((sourceIndex) => !remap.has(sourceIndex)).length;
          budget.assertOutput(positions.length + newVertices * 3, indices.length + 3, remap.size + newVertices);
          for (let vertex = 0; vertex < 3; vertex += 1) {
            const sourceIndex = sourceVertexIndices[vertex];
            let outputIndex = remap.get(sourceIndex);
            if (outputIndex === undefined) {
              outputIndex = positions.length / 3;
              const point = points[vertex];
              positions.push(Math.fround(point[0]), Math.fround(point[1] + baseShellOffsetM), Math.fround(point[2]));
              remap.set(sourceIndex, outputIndex);
            }
            indices.push(outputIndex);
          }
          primitiveTriangles += 1;
        }
        if (primitiveTriangles > 0) {
          report.keptPrimitives += 1;
          report.keptTriangles += primitiveTriangles;
          receiverKinds[classification.kind].primitives += 1;
          receiverKinds[classification.kind].triangles += primitiveTriangles;
        } else report.excludedPrimitives += 1;
      }
    }
    const nextAncestors = new Set(ancestors).add(nodeIndex);
    for (const child of node.children ?? []) await visit(child, world, names, nextAncestors);
  };
  for (const root of roots) await visit(root, IDENTITY, [], new Set());

  if (report.keptTriangles === 0) return { output: null, report };
  budget.assertOutput(positions.length, indices.length);
  const positionBytes = Buffer.allocUnsafe(positions.length * 4);
  positions.forEach((value, index) => positionBytes.writeFloatLE(value, index * 4));
  const indexComponentType = positions.length / 3 <= 65536 ? 5123 : 5125;
  const indexComponentBytes = indexComponentType === 5123 ? 2 : 4;
  const indexBytes = Buffer.allocUnsafe(indices.length * indexComponentBytes);
  indices.forEach((value, index) => indexComponentType === 5123 ? indexBytes.writeUInt16LE(value, index * 2) : indexBytes.writeUInt32LE(value, index * 4));
  const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = Math.min(min[axis], positions[index + axis]); max[axis] = Math.max(max[axis], positions[index + axis]);
  }
  const outputJson = {
    asset: { version: '2.0', generator: 'SimForge snow-cover-v1' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Snow_Cover_v1', mesh: 0 }],
    meshes: [{ name: 'Snow_Cover_v1', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0, mode: 4 }] }],
    materials: [{ name: 'SimForge_Snow_Cover_v1', pbrMetallicRoughness: { baseColorFactor: [0.94, 0.97, 1, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: false }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: indexComponentType, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, byteStride: 12, target: 34962 },
      { buffer: 0, byteOffset: positionBytes.length, byteLength: indexBytes.length, target: 34963 },
    ],
    buffers: [{ byteLength: positionBytes.length + indexBytes.length }],
    extras: { simforgeOssSnowCover: { version: 1, elevationMode: 'runtime-world-y', baseShellOffsetM, elevationAxis: [0, 1, 0], seamPolicy: 'uniform-world-y-preserves-source-boundaries' } },
  };
  return { output: writeGlb(outputJson, Buffer.concat([positionBytes, indexBytes])), report };
}
