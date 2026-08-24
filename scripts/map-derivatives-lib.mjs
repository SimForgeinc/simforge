import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function readGlb(buffer) {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== GLB_MAGIC || buffer.readUInt32LE(4) !== 2) {
    throw new Error('Expected a binary glTF 2.0 file');
  }
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error('GLB length header mismatch');
  let offset = 12;
  let json = null;
  let bin = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const payload = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === JSON_CHUNK) json = JSON.parse(payload.toString('utf8').replace(/[\0 ]+$/, ''));
    else if (type === BIN_CHUNK) bin = Buffer.from(payload);
    offset += 8 + length;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  if ((json.buffers ?? []).some((entry) => entry.uri)) throw new Error('External buffers are unsupported; refusing a partial derivative');
  return { json, bin };
}

export function writeGlb(json, bin) {
  const rawJson = Buffer.from(JSON.stringify(json));
  const jsonPad = (4 - (rawJson.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const jsonChunk = Buffer.concat([rawJson, Buffer.alloc(jsonPad, 0x20)]);
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad)]);
  const total = 12 + 8 + jsonChunk.length + (binChunk.length ? 8 + binChunk.length : 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0); jsonHeader.writeUInt32LE(JSON_CHUNK, 4);
  if (!binChunk.length) return Buffer.concat([header, jsonHeader, jsonChunk]);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0); binHeader.writeUInt32LE(BIN_CHUNK, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}

function visit(value, callback) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) visit(item, callback); return; }
  callback(value);
  for (const child of Object.values(value)) visit(child, callback);
}

export function geometryIdentity(json) {
  return sha256(JSON.stringify({
    scene: json.scene,
    scenes: json.scenes,
    nodes: (json.nodes ?? []).map(({ name, mesh, matrix, translation, rotation, scale, children }) => ({ name, mesh, matrix, translation, rotation, scale, children })),
    meshes: (json.meshes ?? []).map(({ name, primitives }) => ({ name, primitives: primitives?.map(({ attributes, indices, mode }) => ({ attributes, indices, mode })) })),
    // bufferView indices are intentionally excluded: compacting image-only
    // views renumbers them without changing any accessor semantics or bytes.
    accessors: (json.accessors ?? []).map(({ byteOffset, componentType, normalized, count, type, min, max }) => ({ byteOffset, componentType, normalized, count, type, min, max })),
  }));
}

function hexToLinear(hex) {
  return [hex >> 16, (hex >> 8) & 0xff, hex & 0xff].map(srgbToLinear);
}

const FALLBACK_COLORS = {
  asphalt: hexToLinear(0x2f363d),
  grass: hexToLinear(0x47733f),
  concrete: hexToLinear(0x8a8d8d),
  building: hexToLinear(0x9a826c),
  roof: hexToLinear(0x51463f),
  vegetation: hexToLinear(0x356331),
  bark: hexToLinear(0x59402b),
  markingWhite: hexToLinear(0xd7d4c7),
  markingYellow: hexToLinear(0xd4ae45),
  metal: hexToLinear(0x666d72),
  unknown: hexToLinear(0x777f86),
};

export function semanticFallbackColor(name = '') {
  const value = name.toLowerCase();
  if (/yellow/.test(value)) return FALLBACK_COLORS.markingYellow;
  if (/lane.?mark|marking|white.?line/.test(value)) return FALLBACK_COLORS.markingWhite;
  if (/asphalt|road|oilpath|crack/.test(value)) return FALLBACK_COLORS.asphalt;
  if (/grass|groundcover/.test(value)) return FALLBACK_COLORS.grass;
  if (/leaf|bush|foliage|vegetation|pine|oak|maple|cypress/.test(value)) return FALLBACK_COLORS.vegetation;
  if (/bark|trunk|wood/.test(value)) return FALLBACK_COLORS.bark;
  if (/sidewalk|curb|gutter|concrete|cement|pavement/.test(value)) return FALLBACK_COLORS.concrete;
  if (/roof|shingle/.test(value)) return FALLBACK_COLORS.roof;
  if (/building|wall|home|house|stucco|brick/.test(value)) return FALLBACK_COLORS.building;
  if (/metal|steel|signal|lamp|tower|fence/.test(value)) return FALLBACK_COLORS.metal;
  return FALLBACK_COLORS.unknown;
}

function imageBytes(image, views, bin) {
  if (Number.isInteger(image?.bufferView)) {
    const view = views[image.bufferView];
    if (!view || (view.buffer ?? 0) !== 0) return null;
    return bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  }
  if (typeof image?.uri === 'string' && image.uri.startsWith('data:')) {
    const comma = image.uri.indexOf(',');
    if (comma < 0) return null;
    return image.uri.includes(';base64,')
      ? Buffer.from(image.uri.slice(comma + 1), 'base64')
      : Buffer.from(decodeURIComponent(image.uri.slice(comma + 1)), 'utf8');
  }
  return null;
}

function srgbToLinear(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export async function representativeImageColor(bytes, cache = new Map(), options = {}) {
  const alphaMode = options.alphaMode ?? 'OPAQUE';
  const alphaCutoff = options.alphaCutoff ?? 0.5;
  const key = `${sha256(bytes)}:${alphaMode}:${alphaCutoff}`;
  if (cache.has(key)) return cache.get(key);
  const { data, info } = await sharp(bytes, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let red = 0; let green = 0; let blue = 0; let alphaWeight = 0; let alpha = 0;
  const pixels = info.width * info.height;
  for (let offset = 0; offset < data.length; offset += 4) {
    const sourceAlpha = data[offset + 3] / 255;
    const weight = alphaMode === 'MASK' ? (sourceAlpha >= alphaCutoff ? 1 : 0)
      : alphaMode === 'BLEND' ? sourceAlpha : 1;
    red += srgbToLinear(data[offset]) * weight;
    green += srgbToLinear(data[offset + 1]) * weight;
    blue += srgbToLinear(data[offset + 2]) * weight;
    alpha += sourceAlpha;
    alphaWeight += weight;
  }
  const divisor = alphaWeight || Math.max(1, pixels);
  const result = [red / divisor, green / divisor, blue / divisor, alpha / Math.max(1, pixels)];
  cache.set(key, result);
  return result;
}

/** Removes every texture payload while preserving geometry/accessor bytes and scene transforms. */
export async function makeGeometryOnlyGlb(sourceBuffer, options = {}) {
  const { json: source, bin } = readGlb(sourceBuffer);
  const before = geometryIdentity(source);
  const json = structuredClone(source);
  const imageViews = new Set((json.images ?? []).map((image) => image.bufferView).filter(Number.isInteger));
  const textures = json.textures ?? [];
  const images = json.images ?? [];
  const views = json.bufferViews ?? [];
  const colorCache = options.representativeColorCache ?? new Map();
  const materials = [];
  for (const material of json.materials ?? []) {
    const pbr = material.pbrMetallicRoughness ?? {};
    const factor = pbr.baseColorFactor ?? [1, 1, 1, 1];
    const textureIndex = pbr.baseColorTexture?.index;
    const texture = Number.isInteger(textureIndex) ? textures[textureIndex] : null;
    const imageIndex = texture?.extensions?.KHR_texture_basisu?.source
      ?? texture?.extensions?.EXT_texture_webp?.source
      ?? texture?.extensions?.EXT_texture_avif?.source
      ?? texture?.source;
    const bytes = Number.isInteger(imageIndex) ? imageBytes(images[imageIndex], views, bin) : null;
    let representative = null;
    if (bytes) {
      try {
        representative = await representativeImageColor(bytes, colorCache, {
          alphaMode: material.alphaMode ?? 'OPAQUE',
          alphaCutoff: material.alphaCutoff ?? 0.5,
        });
      } catch { /* semantic fallback below */ }
    }
    const factorLooksDefault = factor.slice(0, 3).every((channel) => channel >= 0.94);
    const fallback = semanticFallbackColor(material.name);
    const rgb = representative
      ? representative.slice(0, 3).map((channel, index) => Math.min(1, Math.max(0, channel * factor[index])))
      : factorLooksDefault ? fallback : factor.slice(0, 3);
    const alpha = material.alphaMode === 'BLEND' && representative
      ? factor[3] * representative[3]
      : factor[3];
    materials.push({
      name: material.name,
      doubleSided: material.doubleSided,
      alphaMode: material.alphaMode,
      alphaCutoff: material.alphaCutoff,
      pbrMetallicRoughness: {
        baseColorFactor: [...rgb, alpha],
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      extras: {
        ...(material.extras ?? {}),
        simforgeGeometryOnly: { version: 2, source: representative ? 'base-color-average' : 'factor-or-semantic' },
      },
    });
  }
  delete json.images; delete json.textures; delete json.samplers;
  json.materials = materials;
  const removedTextureExtensions = new Set(['KHR_texture_basisu', 'KHR_texture_transform', 'EXT_texture_webp', 'EXT_texture_avif']);
  if (json.extensionsUsed) json.extensionsUsed = json.extensionsUsed.filter((name) => !removedTextureExtensions.has(name));
  if (json.extensionsRequired) json.extensionsRequired = json.extensionsRequired.filter((name) => !removedTextureExtensions.has(name));
  if (json.extensionsUsed?.length === 0) delete json.extensionsUsed;
  if (json.extensionsRequired?.length === 0) delete json.extensionsRequired;
  const textureReferencePattern = /"(?:images|textures|samplers|baseColorTexture|metallicRoughnessTexture|normalTexture|occlusionTexture|emissiveTexture|propertyTextures)"\s*:/;
  if (textureReferencePattern.test(JSON.stringify(json))) throw new Error('Texture reference remains in geometry-only derivative');

  const nonImageReferences = new Set();
  visit(json, (object) => {
    if (Number.isInteger(object.bufferView)) nonImageReferences.add(object.bufferView);
  });
  const compactViews = json.bufferViews ?? [];
  const keptOldIndices = compactViews.map((_, index) => index).filter((index) => !imageViews.has(index) || nonImageReferences.has(index));
  const remap = new Map(keptOldIndices.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  json.bufferViews = keptOldIndices.map((index) => structuredClone(compactViews[index]));
  visit(json, (object) => {
    if (Number.isInteger(object.bufferView)) {
      const next = remap.get(object.bufferView);
      if (next === undefined) throw new Error(`Removed bufferView ${object.bufferView} remains referenced`);
      object.bufferView = next;
    }
  });

  const chunks = [];
  const offsets = new Map();
  let byteLength = 0;
  const copyRange = (start, length) => {
    const key = `${start}:${length}`;
    if (offsets.has(key)) return offsets.get(key);
    if (start < 0 || length < 0 || start + length > bin.length) throw new Error(`Invalid BIN range ${key}`);
    const aligned = (byteLength + 3) & ~3;
    if (aligned > byteLength) chunks.push(Buffer.alloc(aligned - byteLength));
    const next = aligned;
    if (length > 0) chunks.push(bin.subarray(start, start + length));
    byteLength = next + length;
    offsets.set(key, next);
    return next;
  };
  for (const view of json.bufferViews) {
    const bufferIndex = view.buffer ?? 0;
    if (bufferIndex === 0) view.byteOffset = copyRange(view.byteOffset ?? 0, view.byteLength);
    const compressed = view.extensions?.EXT_meshopt_compression;
    if (compressed && (compressed.buffer ?? 0) === 0) {
      compressed.byteOffset = copyRange(compressed.byteOffset ?? 0, compressed.byteLength);
    }
  }
  const compactBin = Buffer.concat(chunks);
  if (json.buffers?.[0]) json.buffers[0].byteLength = compactBin.length;
  const output = writeGlb(json, compactBin);
  const after = geometryIdentity(readGlb(output).json);
  if (before !== after) throw new Error('Geometry-only conversion changed scene, transform, or accessor identity');
  return { output, report: { sourceBytes: sourceBuffer.length, outputBytes: output.length, removedBytes: sourceBuffer.length - output.length, geometryIdentity: before } };
}

/** Creates a valid intermediate with only selected scene roots; a pinned prune tool compacts it afterward. */
export function subsetSceneRoots(sourceBuffer, selectedNodeIndices) {
  const { json: source, bin } = readGlb(sourceBuffer);
  const selected = new Set(selectedNodeIndices);
  const json = structuredClone(source);
  json.scenes = (json.scenes ?? []).map((scene) => ({ ...scene, nodes: (scene.nodes ?? []).filter((index) => selected.has(index)) }));
  if (!(json.scenes ?? []).some((scene) => scene.nodes?.length)) throw new Error('Node subset selected no scene roots');
  return writeGlb(json, bin);
}

/** Preserve selected nodes and their ancestor transforms, dropping other branches. */
export function subsetSceneNodes(sourceBuffer, selectedNodeIndices) {
  const { json: source, bin } = readGlb(sourceBuffer);
  const selected = new Set(selectedNodeIndices);
  const json = structuredClone(source);
  const keepTree = (index) => {
    const node = json.nodes?.[index];
    if (!node) return false;
    const children = (node.children ?? []).filter(keepTree);
    if (children.length) node.children = children;
    else delete node.children;
    return selected.has(index) || children.length > 0;
  };
  json.scenes = (json.scenes ?? []).map((scene) => ({ ...scene, nodes: (scene.nodes ?? []).filter(keepTree) }));
  if (!(json.scenes ?? []).some((scene) => scene.nodes?.length)) throw new Error('Node subset selected no scene nodes');
  return writeGlb(json, bin);
}

const ROAD_SURFACE = /^(?:roads?|terrain)[_ .-](?:(?:road|bridge|curb|gutter|ground|marking|sidewalk|terrain|uncategorized)[_ .-])?layer\d*(?:[_ .-]|$)/i;
const TRAFFIC_SIGNAL = /traffic[_ .-]?(?:light|signal)|signal(?:[_ .-]|\w)*(?:head|post|pole|mast|light)|pole(?:[_ .-]|\w)*signal|^(?:walk[_ .-]?)?light[_ .-]?(?:red|yellow|green|walk)(?:\d|[_ .-]|$)/i;
const MARKING_LAYER = /(?:^|[_ .-])(?:roads?|terrain)[_ .-]marking[_ .-]layer\d*(?:[_ .-]|$)/i;
const MARKING_MATERIAL = /(?:marking|lane[_ .-]?mark|crosswalk|stop[_ .-]?(?:bar|line)|direction[_ .-]?arrow|road[_ .-]?text|handicapped|utilities|yellow[_ .-]?material)/i;
const SUPPORT_LAYER = /(?:^|[_ .-])(?:roads?[_ .-](?:road[_ .-])?layer\d*|terrain[_ .-](?:ground[_ .-])?layer\d*)(?:[_ .-]|$)/i;
const SUPPORT_MATERIAL = /(?:asphalt|(?:^|[_ .-])road(?:[_ .-]|$)|oilpath|linearcracks)/i;

/**
 * Creates the marking-first Roads Only v2 intermediate.
 *
 * The editor already renders canonical, batched OpenDRIVE signal heads, and
 * uses semantic topology for lanes and picking. Detailed RoadRunner signal
 * furniture is therefore redundant in the CPU-first preset and is deliberately
 * omitted. Every primitive exported in a marking layer is retained byte-for-
 * byte; outside those layers we retain explicitly named marking materials and
 * the minimum asphalt support sheet. Normals, UVs, tangents and vertex colours
 * are unnecessary because the runtime replaces these materials with a flat,
 * unlit palette.
 *
 * A pinned prune/meshopt pass compacts this intermediate afterward. Keeping
 * this classification here, rather than in the runtime, guarantees excluded
 * geometry is never downloaded or decoded.
 */
export function makeMarkingFirstRoadsOnlyGlb(sourceBuffer) {
  const { json: source, bin } = readGlb(sourceBuffer);
  const json = structuredClone(source);
  const meshNodeNames = new Map();
  for (const node of json.nodes ?? []) {
    if (!Number.isInteger(node.mesh)) continue;
    const names = meshNodeNames.get(node.mesh) ?? [];
    names.push(node.name ?? '');
    meshNodeNames.set(node.mesh, names);
  }

  let sourceMarkingPrimitives = 0;
  let keptMarkingPrimitives = 0;
  let keptSupportPrimitives = 0;
  let droppedPrimitives = 0;
  const markingInventory = [];
  const supportInventory = [];
  for (let meshIndex = 0; meshIndex < (json.meshes ?? []).length; meshIndex++) {
    const mesh = json.meshes[meshIndex];
    const nodeNames = meshNodeNames.get(meshIndex) ?? [];
    const semanticName = `${mesh.name ?? ''} ${nodeNames.join(' ')}`;
    const markingLayer = MARKING_LAYER.test(semanticName);
    const supportLayer = SUPPORT_LAYER.test(semanticName);
    const kept = [];
    for (let primitiveIndex = 0; primitiveIndex < (mesh.primitives ?? []).length; primitiveIndex++) {
      const primitive = mesh.primitives[primitiveIndex];
      const materialName = json.materials?.[primitive.material]?.name ?? '';
      const isMarking = markingLayer || MARKING_MATERIAL.test(materialName);
      const isSupport = !isMarking && supportLayer && SUPPORT_MATERIAL.test(materialName);
      if (isMarking) sourceMarkingPrimitives++;
      if (!isMarking && !isSupport) {
        droppedPrimitives++;
        continue;
      }
      const output = structuredClone(primitive);
      output.attributes = { POSITION: primitive.attributes.POSITION };
      kept.push(output);
      const record = { mesh: mesh.name ?? '', nodes: nodeNames, primitive: primitiveIndex, material: materialName };
      if (isMarking) {
        keptMarkingPrimitives++;
        markingInventory.push(record);
      } else {
        keptSupportPrimitives++;
        supportInventory.push(record);
      }
    }
    mesh.primitives = kept;
  }

  for (const node of json.nodes ?? []) {
    if (Number.isInteger(node.mesh) && !(json.meshes?.[node.mesh]?.primitives?.length)) delete node.mesh;
  }
  if (sourceMarkingPrimitives === 0 || keptSupportPrimitives === 0) {
    throw new Error(`Marking-first derivative requires markings and support (found ${sourceMarkingPrimitives}/${keptSupportPrimitives})`);
  }
  if (sourceMarkingPrimitives !== keptMarkingPrimitives) throw new Error('Marking-first derivative dropped a marking primitive');
  return {
    output: writeGlb(json, bin),
    report: {
      sourceMarkingPrimitives,
      keptMarkingPrimitives,
      keptSupportPrimitives,
      droppedPrimitives,
      markingInventory,
      supportInventory,
      signalRepresentation: 'canonical-opendrive-orb-overlay',
      retainedAttributes: ['POSITION'],
    },
  };
}

/**
 * Select authoring-critical road and traffic-signal scene roots for a compact
 * Roads Only derivative. Structured extras are preferred. The regex fallback
 * is deliberately allow-list based and audited in the generated manifest;
 * unknown furniture is dropped instead of silently bloating the preset.
 */
export function classifyRoadsOnlySceneRoots(sourceBuffer) {
  const { json } = readGlb(sourceBuffer);
  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const kept = [];
  const dropped = [];
  const reasonFor = (node) => {
    const mesh = Number.isInteger(node.mesh) ? meshes[node.mesh] : null;
    const extras = { ...(mesh?.extras ?? {}), ...(node.extras ?? {}) };
    const category = [extras.category, extras.kind, extras.role, extras.semantic, extras.class]
      .filter((value) => typeof value === 'string').join(' ');
    const text = `${node.name ?? ''} ${mesh?.name ?? ''} ${category}`;
    if (/traffic[_ .-]?(?:light|signal)|signal[_ .-]?(?:head|post|pole|mast)/i.test(category)) return 'signal-metadata';
    if (ROAD_SURFACE.test(node.name ?? '') || ROAD_SURFACE.test(mesh?.name ?? '')) return 'road-surface';
    if (TRAFFIC_SIGNAL.test(text)) return 'signal-name-fallback';
    return null;
  };
  const visited = new Set();
  const visitNode = (index) => {
    if (visited.has(index)) return;
    visited.add(index);
    const node = nodes[index] ?? {};
    if (Number.isInteger(node.mesh)) {
      const reason = reasonFor(node);
      (reason ? kept : dropped).push({ node: index, name: node.name ?? '', mesh: meshes[node.mesh]?.name ?? '', reason: reason ?? 'not-authoring-critical' });
    }
    for (const child of node.children ?? []) visitNode(child);
  };
  for (const root of json.scenes?.[json.scene ?? 0]?.nodes ?? []) {
    visitNode(root);
  }
  return { selectedNodeIndices: kept.map((entry) => entry.node), kept, dropped };
}

function accessorBounds(json, meshIndex) {
  const mesh = json.meshes?.[meshIndex];
  const boxes = (mesh?.primitives ?? []).map((primitive) => json.accessors?.[primitive.attributes?.POSITION]).filter((a) => a?.min && a?.max);
  if (!boxes.length) return null;
  return {
    min: [Math.min(...boxes.map((a) => a.min[0])), Math.min(...boxes.map((a) => a.min[1])), Math.min(...boxes.map((a) => a.min[2]))],
    max: [Math.max(...boxes.map((a) => a.max[0])), Math.max(...boxes.map((a) => a.max[1])), Math.max(...boxes.map((a) => a.max[2]))],
  };
}

/** Whole-node road tiling is allowed only when every node fits one cell without rotation/hierarchy ambiguity. */
export function analyzeRoadTiling(sourceBuffer, { origin = [0, 0, 0], cellSize = [100, 100] } = {}) {
  const { json } = readGlb(sourceBuffer);
  const unsafe = [];
  const assignments = {};
  for (let index = 0; index < (json.nodes ?? []).length; index++) {
    const node = json.nodes[index];
    if (!Number.isInteger(node.mesh)) continue;
    if (node.children?.length) {
      unsafe.push({ node: index, name: node.name, reason: 'node hierarchy requires geometric splitting' });
      continue;
    }
    const box = accessorBounds(json, node.mesh);
    if (!box) { unsafe.push({ node: index, name: node.name, reason: 'missing POSITION bounds' }); continue; }
    const transform = (point) => {
      if (node.matrix) {
        const m = node.matrix;
        return [m[0] * point[0] + m[4] * point[1] + m[8] * point[2] + m[12], m[1] * point[0] + m[5] * point[1] + m[9] * point[2] + m[13], m[2] * point[0] + m[6] * point[1] + m[10] * point[2] + m[14]];
      }
      const t = node.translation ?? [0, 0, 0];
      const s = node.scale ?? [1, 1, 1];
      const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
      const x = point[0] * s[0], y = point[1] * s[1], z = point[2] * s[2];
      const ix = qw * x + qy * z - qz * y;
      const iy = qw * y + qz * x - qx * z;
      const iz = qw * z + qx * y - qy * x;
      const iw = -qx * x - qy * y - qz * z;
      return [ix * qw + iw * -qx + iy * -qz - iz * -qy + t[0], iy * qw + iw * -qy + iz * -qx - ix * -qz + t[1], iz * qw + iw * -qz + ix * -qy - iy * -qx + t[2]];
    };
    const corners = [];
    for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) corners.push(transform([x, y, z]));
    const x0 = Math.min(...corners.map((point) => point[0]));
    const x1 = Math.max(...corners.map((point) => point[0]));
    const z0 = Math.min(...corners.map((point) => point[2]));
    const z1 = Math.max(...corners.map((point) => point[2]));
    const gx0 = Math.floor((x0 - origin[0]) / cellSize[0]);
    const gx1 = Math.floor((x1 - 1e-6 - origin[0]) / cellSize[0]);
    const gz0 = Math.floor((z0 - origin[2]) / cellSize[1]);
    const gz1 = Math.floor((z1 - 1e-6 - origin[2]) / cellSize[1]);
    if (gx0 !== gx1 || gz0 !== gz1) unsafe.push({ node: index, name: node.name, reason: 'node crosses spatial cell boundary' });
    else (assignments[`${gx0}_${gz0}`] ??= []).push(index);
  }
  const cells = Object.keys(assignments);
  return { safe: unsafe.length === 0 && cells.length > 1, assignments, unsafe, cellCount: cells.length };
}

export function collectManifestGlbs(manifest) {
  const files = new Set();
  for (const layer of manifest.staticLayers ?? []) if (layer.file?.endsWith('.glb')) files.add(layer.file);
  for (const tile of [...(manifest.tiles ?? []), ...(manifest.vegetationTiles ?? [])]) {
    for (const lod of tile.lods ?? []) if (lod.file?.endsWith('.glb')) files.add(lod.file);
  }
  return [...files].sort();
}

export function atomicWrite(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, file);
}
