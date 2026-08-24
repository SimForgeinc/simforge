/**
 * GLB ORM repair — append packed ORM (occlusion/roughness/metallic) textures
 * to an existing GLB and rewire materials per the glTF 2.0 spec, without
 * touching any authored byte.
 *
 * Channel convention (glTF 2.0 core, and RoadRunner's `*_AORM` maps):
 *   R = ambient occlusion   → material.occlusionTexture      (spec: R only)
 *   G = roughness           → pbrMetallicRoughness.metallicRoughnessTexture
 *   B = metallic            → pbrMetallicRoughness.metallicRoughnessTexture
 * One packed image therefore serves BOTH slots — occlusionTexture and
 * metallicRoughnessTexture reference the same texture index. Poly Haven
 * `*_arm_*` maps use this exact layout. Spec/gloss maps have no glTF slot;
 * they must never be wired as baseColor (the export bug this tool repairs).
 *
 * Identity guarantee: the output BIN chunk begins with the source BIN chunk
 * byte-for-byte (new image payloads are appended after it), and every
 * authored JSON element (scenes, nodes, meshes, accessors, bufferViews,
 * samplers, images, textures) is preserved verbatim — only appended entries
 * and the named materials' texture slots change. EXT_meshopt_compression
 * streams and KHR quantization are untouched by construction; the tool never
 * decodes geometry. `repairGlb` verifies all of this before returning.
 */

import { createHash } from 'node:crypto';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const REPEAT = 10497;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readGlb(buffer) {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== GLB_MAGIC || buffer.readUInt32LE(4) !== 2) {
    throw new Error('expected a binary glTF 2.0 file');
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
    else if (type === BIN_CHUNK) bin = payload;
    offset += 8 + length;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  if ((json.buffers ?? []).some((entry) => entry.uri)) {
    throw new Error('external buffers are unsupported');
  }
  return { json, bin };
}

export function writeGlb(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + (bin.length ? 8 + bin.length + binPad : 0);
  const out = Buffer.alloc(total, 0);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBytes.length + jsonPad, 12);
  out.writeUInt32LE(JSON_CHUNK, 16);
  jsonBytes.copy(out, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  if (bin.length) {
    const at = 20 + jsonBytes.length + jsonPad;
    out.writeUInt32LE(bin.length + binPad, at);
    out.writeUInt32LE(BIN_CHUNK, at + 4);
    bin.copy(out, at + 8);
  }
  return out;
}

/** Sniff an embedded image payload's media type from magic bytes. */
export function sniffImageMime(bytes) {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  throw new Error('unsupported image payload; expected PNG, JPEG, or WebP');
}

function textureImageIndex(json, textureIndex) {
  const texture = json.textures?.[textureIndex];
  if (!texture) return undefined;
  return (
    texture.extensions?.KHR_texture_basisu?.source ??
    texture.extensions?.EXT_texture_webp?.source ??
    texture.extensions?.EXT_texture_avif?.source ??
    texture.source
  );
}

function imageBytes(json, bin, imageIndex) {
  const image = json.images?.[imageIndex];
  if (!Number.isInteger(image?.bufferView)) return null;
  const view = json.bufferViews?.[image.bufferView];
  if (!view || (view.buffer ?? 0) !== 0) return null;
  const start = view.byteOffset ?? 0;
  return bin.subarray(start, start + view.byteLength);
}

const SUSPECT_BASECOLOR = /spec|gloss/i;

/**
 * Material wiring table with defect flags:
 * - `spec-as-baseColor`: the base color image is a specular/glossiness map
 *   (UE→glTF export bug — those maps have no glTF slot).
 * - `frozen-roughness`: no metallicRoughnessTexture and roughnessFactor left
 *   at a constant, so the surface has zero roughness variation.
 */
export function auditGlb(buffer) {
  const { json, bin } = readGlb(buffer);
  const rows = [];
  for (let index = 0; index < (json.materials ?? []).length; index += 1) {
    const material = json.materials[index];
    const pbr = material.pbrMetallicRoughness ?? {};
    const slot = (ref) => {
      if (!Number.isInteger(ref?.index)) return null;
      const imageIndex = textureImageIndex(json, ref.index);
      const image = json.images?.[imageIndex];
      return { texture: ref.index, image: imageIndex, name: image?.name ?? null, mimeType: image?.mimeType ?? null };
    };
    const row = {
      index,
      name: material.name ?? null,
      baseColor: slot(pbr.baseColorTexture),
      metallicRoughness: slot(pbr.metallicRoughnessTexture),
      occlusion: slot(material.occlusionTexture),
      normal: slot(material.normalTexture),
      metallicFactor: pbr.metallicFactor ?? 1,
      roughnessFactor: pbr.roughnessFactor ?? 1,
      flags: [],
    };
    if (row.baseColor?.name && SUSPECT_BASECOLOR.test(row.baseColor.name)) row.flags.push('spec-as-baseColor');
    if (!row.metallicRoughness && row.baseColor) row.flags.push('frozen-roughness');
    rows.push(row);
  }
  return { materials: rows, images: (json.images ?? []).length, textures: (json.textures ?? []).length, binBytes: bin.length };
}

function align4(value) {
  return (value + 3) & ~3;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Rewire materials with sidecar textures.
 *
 * `entries`: array of
 *   {
 *     material: string,               // exact material name (must exist unless optional)
 *     optional?: boolean,
 *     orm?: { bytes, name? },         // packed R=AO G=rough B=metal image
 *     baseColor?: { bytes, name? } | 'remove',
 *     normal?: { bytes, name? },
 *     baseColorFactor?: [r,g,b,a],    // applied when provided, and on 'remove'
 *     metallicFactor?: number,        // default 1 when orm is wired
 *     roughnessFactor?: number,       // default 1 when orm is wired
 *     occlusionStrength?: number,     // default omitted (spec default 1)
 *     normalScale?: number,
 *   }
 */
export function repairGlb(sourceBuffer, entries) {
  const { json: source, bin } = readGlb(sourceBuffer);
  const json = structuredClone(source);
  json.materials ??= [];
  json.bufferViews ??= [];
  json.images ??= [];
  json.textures ??= [];
  json.samplers ??= [];
  const originalCounts = {
    bufferViews: json.bufferViews.length,
    images: json.images.length,
    textures: json.textures.length,
    samplers: json.samplers.length,
  };

  // Content-addressed reuse: an image already embedded (authored or appended
  // earlier in this run) is never appended twice, so re-running a repair or
  // sharing one ORM map across materials costs zero extra bytes.
  const imageByDigest = new Map();
  for (let index = 0; index < originalCounts.images; index += 1) {
    const bytes = imageBytes(json, bin, index);
    if (bytes) imageByDigest.set(sha256(bytes), index);
  }

  const appended = []; // {bytes, offset} relative to the aligned append base
  let appendLength = 0;
  const appendImage = (sidecar) => {
    const digest = sha256(sidecar.bytes);
    const existing = imageByDigest.get(digest);
    if (existing !== undefined) return existing;
    const mimeType = sniffImageMime(sidecar.bytes);
    const offset = align4(appendLength);
    appended.push({ bytes: sidecar.bytes, offset });
    appendLength = offset + sidecar.bytes.length;
    json.bufferViews.push({ buffer: 0, byteOffset: -1 - offset, byteLength: sidecar.bytes.length });
    const imageIndex = json.images.length;
    json.images.push({
      ...(sidecar.name ? { name: sidecar.name } : {}),
      mimeType,
      bufferView: json.bufferViews.length - 1,
    });
    imageByDigest.set(digest, imageIndex);
    return imageIndex;
  };

  let repeatSampler = json.samplers.findIndex((s) => (s.wrapS ?? REPEAT) === REPEAT && (s.wrapT ?? REPEAT) === REPEAT);
  const pickSampler = (material) => {
    const pbr = material.pbrMetallicRoughness ?? {};
    const baseTexture = json.textures[pbr.baseColorTexture?.index];
    if (Number.isInteger(baseTexture?.sampler)) return baseTexture.sampler;
    if (repeatSampler === -1) {
      repeatSampler = json.samplers.length;
      json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: REPEAT, wrapT: REPEAT });
    }
    return repeatSampler;
  };

  const textureByKey = new Map();
  const ensureTexture = (imageIndex, sampler) => {
    const key = `${imageIndex}:${sampler}`;
    const existing = textureByKey.get(key);
    if (existing !== undefined) return existing;
    const index = json.textures.length;
    json.textures.push({ sampler, source: imageIndex });
    textureByKey.set(key, index);
    return index;
  };

  const report = [];
  for (const entry of entries) {
    const materialIndex = json.materials.findIndex((m) => m.name === entry.material);
    if (materialIndex === -1) {
      if (entry.optional) continue;
      throw new Error(`material "${entry.material}" not found`);
    }
    const material = json.materials[materialIndex];
    const pbr = (material.pbrMetallicRoughness ??= {});
    const texCoord = pbr.baseColorTexture?.texCoord ?? 0;
    const sampler = pickSampler(material);
    const wired = { material: entry.material, index: materialIndex };

    if (entry.orm) {
      const textureIndex = ensureTexture(appendImage(entry.orm), sampler);
      material.occlusionTexture = {
        index: textureIndex,
        ...(texCoord ? { texCoord } : {}),
        ...(entry.occlusionStrength !== undefined ? { strength: entry.occlusionStrength } : {}),
      };
      pbr.metallicRoughnessTexture = { index: textureIndex, ...(texCoord ? { texCoord } : {}) };
      pbr.metallicFactor = entry.metallicFactor ?? 1;
      pbr.roughnessFactor = entry.roughnessFactor ?? 1;
      wired.orm = textureIndex;
    } else {
      if (entry.metallicFactor !== undefined) pbr.metallicFactor = entry.metallicFactor;
      if (entry.roughnessFactor !== undefined) pbr.roughnessFactor = entry.roughnessFactor;
    }

    if (entry.baseColor === 'remove') {
      delete pbr.baseColorTexture;
      pbr.baseColorFactor = entry.baseColorFactor ?? [0.5, 0.5, 0.5, 1];
      wired.baseColor = 'removed';
    } else if (entry.baseColor) {
      const textureIndex = ensureTexture(appendImage(entry.baseColor), sampler);
      pbr.baseColorTexture = { index: textureIndex, ...(texCoord ? { texCoord } : {}) };
      if (entry.baseColorFactor) pbr.baseColorFactor = entry.baseColorFactor;
      wired.baseColor = textureIndex;
    } else if (entry.baseColorFactor) {
      pbr.baseColorFactor = entry.baseColorFactor;
    }

    if (entry.normal) {
      const textureIndex = ensureTexture(appendImage(entry.normal), sampler);
      material.normalTexture = {
        index: textureIndex,
        ...(texCoord ? { texCoord } : {}),
        ...(entry.normalScale !== undefined ? { scale: entry.normalScale } : {}),
      };
      wired.normal = textureIndex;
    }
    report.push(wired);
  }

  // Materialize the appended payloads after the untouched source BIN.
  const appendBase = align4(bin.length);
  for (const view of json.bufferViews) {
    if (view.byteOffset < 0) view.byteOffset = appendBase + (-1 - view.byteOffset);
  }
  const chunks = [bin];
  if (appended.length > 0) {
    let cursor = bin.length;
    for (const item of appended) {
      const at = appendBase + item.offset;
      if (at > cursor) chunks.push(Buffer.alloc(at - cursor));
      chunks.push(item.bytes);
      cursor = at + item.bytes.length;
    }
  }
  const outBin = Buffer.concat(chunks);
  json.buffers ??= [{}];
  json.buffers[0] = { ...json.buffers[0], byteLength: outBin.length };

  const output = writeGlb(json, outBin);
  verifyRepair(sourceBuffer, output, originalCounts);
  return {
    output,
    report: {
      materials: report,
      imagesAppended: json.images.length - originalCounts.images,
      texturesAppended: json.textures.length - originalCounts.textures,
      bytesAppended: output.length - sourceBuffer.length,
      sourceBytes: sourceBuffer.length,
      outputBytes: output.length,
    },
  };
}

/**
 * Prove the repair changed nothing it should not have. Throws on violation.
 * - The output BIN chunk begins with the source BIN chunk byte-for-byte.
 * - Scenes, nodes, meshes, accessors, skins, animations, extensions are
 *   verbatim; original bufferViews/images/textures/samplers are verbatim and
 *   only appended after.
 */
export function verifyRepair(sourceBuffer, outputBuffer, originalCounts) {
  const source = readGlb(sourceBuffer);
  const output = readGlb(outputBuffer);
  if (!output.bin.subarray(0, source.bin.length).equals(source.bin)) {
    throw new Error('identity violation: source BIN bytes changed');
  }
  for (const key of ['scenes', 'scene', 'nodes', 'meshes', 'accessors', 'skins', 'animations', 'extensionsUsed', 'extensionsRequired', 'asset']) {
    if (!deepEqual(source.json[key], output.json[key])) {
      throw new Error(`identity violation: "${key}" changed`);
    }
  }
  const counts = originalCounts ?? {
    bufferViews: (source.json.bufferViews ?? []).length,
    images: (source.json.images ?? []).length,
    textures: (source.json.textures ?? []).length,
    samplers: (source.json.samplers ?? []).length,
  };
  for (const [key, count] of Object.entries(counts)) {
    const before = source.json[key] ?? [];
    const after = output.json[key] ?? [];
    if (after.length < count) throw new Error(`identity violation: "${key}" shrank`);
    for (let index = 0; index < count; index += 1) {
      if (!deepEqual(before[index], after[index])) {
        throw new Error(`identity violation: ${key}[${index}] changed`);
      }
    }
  }
}
