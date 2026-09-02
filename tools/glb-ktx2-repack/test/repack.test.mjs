/**
 * Focused tests (assignment: geometry-identity assertion + decode smoke).
 * Runs against the real production fixture fixtures/yale-tile_0_0.lod3.glb.
 * Requires the pinned KTX-Software toolchain (see README); skips with a
 * clear message when toktx is unavailable.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseGlb } from '../src/glb.mjs';
import { classifyImages, repackGlb, resolveKtxBinDir, toktxArgs, verifyGeometryIdentity } from '../src/repack.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '../../../fixtures/yale-tile_0_0.lod3.glb');

let ktxAvailable = true;
try {
  resolveKtxBinDir();
} catch {
  ktxAvailable = false;
}

const srcBuf = fs.readFileSync(fixture);
let repacked = null;
async function repackOnce() {
  if (!repacked) repacked = await repackGlb(srcBuf);
  return repacked;
}

test('geometry identity: every non-image byte range and geometry JSON survive repack', { skip: !ktxAvailable && 'toktx unavailable' }, async () => {
  const { glb, report } = await repackOnce();
  const identity = verifyGeometryIdentity(srcBuf, glb);
  assert.equal(identity.ok, true, JSON.stringify(identity.failures));
  assert.ok(identity.ranges.length > 0, 'fixture must contribute geometry ranges');
  assert.equal(report.geometry.identical, true);

  // Byte-level spot check independent of verifyGeometryIdentity's own walk:
  // the meshopt streams of the first mesh-referenced bufferView are identical.
  const src = parseGlb(srcBuf);
  const out = parseGlb(glb);
  const meshViews = new Set(
    src.json.meshes.flatMap((m) =>
      m.primitives.flatMap((p) => [
        ...Object.values(p.attributes).map((a) => src.json.accessors[a].bufferView),
        ...(p.indices !== undefined ? [src.json.accessors[p.indices].bufferView] : []),
      ]),
    ),
  );
  assert.ok(meshViews.size > 0);
  for (const v of meshViews) {
    const sv = src.json.bufferViews[v];
    const ov = out.json.bufferViews[v];
    const sm = sv.extensions?.EXT_meshopt_compression;
    const om = ov.extensions?.EXT_meshopt_compression;
    const [sBytes, oBytes] = sm
      ? [
          src.bin.subarray(sm.byteOffset ?? 0, (sm.byteOffset ?? 0) + sm.byteLength),
          out.bin.subarray(om.byteOffset ?? 0, (om.byteOffset ?? 0) + om.byteLength),
        ]
      : [
          src.bin.subarray(sv.byteOffset ?? 0, (sv.byteOffset ?? 0) + sv.byteLength),
          out.bin.subarray(ov.byteOffset ?? 0, (ov.byteOffset ?? 0) + ov.byteLength),
        ];
    const sha = (b) => createHash('sha256').update(b).digest('hex');
    assert.equal(sha(sBytes), sha(oBytes), `mesh bufferView ${v} bytes changed`);
  }
});

test('decode smoke: every repacked image is a valid KTX2 with expected codec, transfer, and full mip chain', { skip: !ktxAvailable && 'toktx unavailable' }, async () => {
  const { glb } = await repackOnce();
  const { json, bin } = parseGlb(glb);
  const classes = classifyImages(json);
  assert.equal(json.images.every((i) => i.mimeType === 'image/ktx2'), true);
  assert.ok(json.extensionsUsed.includes('KHR_texture_basisu'));
  assert.ok(json.extensionsRequired.includes('KHR_texture_basisu'));
  for (const texture of json.textures) {
    assert.equal(Number.isInteger(texture.extensions?.KHR_texture_basisu?.source), true);
    assert.equal(texture.source, undefined);
  }
  for (const [i, image] of json.images.entries()) {
    const view = json.bufferViews[image.bufferView];
    const bytes = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    // KTX2 identifier: «KTX 20»\r\n\x1A\n
    assert.deepEqual(
      [...bytes.subarray(0, 12)],
      [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a],
      `image ${i} lacks KTX2 magic`,
    );
    const vkFormat = bytes.readUInt32LE(12);
    assert.equal(vkFormat, 0, `image ${i} must be Basis-encoded (VK_FORMAT_UNDEFINED)`);
    const width = bytes.readUInt32LE(20);
    const height = bytes.readUInt32LE(24);
    assert.equal(width % 4, 0, `image ${i} width is not BC block-aligned`);
    assert.equal(height % 4, 0, `image ${i} height is not BC block-aligned`);
    const levelCount = bytes.readUInt32LE(40);
    const supercompression = bytes.readUInt32LE(44);
    assert.equal(levelCount, Math.floor(Math.log2(Math.max(width, height))) + 1, `image ${i} mip chain incomplete`);
    const cls = classes.get(i);
    // Default profile is UASTC+zstd for every class: bevy_image 0.19 cannot
    // decode BasisLZ (ETC1S), see src/repack.mjs toktxArgs.
    assert.equal(supercompression, 2, `image ${i} (${cls}) must be UASTC+zstd`);
    // DFD transfer function: sRGB (2) for color, linear (1) otherwise.
    const dfdByteOffset = bytes.readUInt32LE(48);
    const transfer = bytes.readUInt8(dfdByteOffset + 14);
    assert.equal(transfer, cls === 'color' ? 2 : 1, `image ${i} (${cls}) wrong transfer function`);
  }
});

test('classification maps material slots to codecs', () => {
  const { json } = parseGlb(srcBuf);
  const classes = classifyImages(json);
  for (const material of json.materials ?? []) {
    const image = (info) => json.textures[info.index].source;
    if (material.normalTexture) assert.equal(classes.get(image(material.normalTexture)), 'normal');
    if (material.occlusionTexture) {
      assert.notEqual(classes.get(image(material.occlusionTexture)), 'color');
    }
  }
});
test('classification rejects one image shared by color and data slots', () => {
  assert.throws(
    () => classifyImages({
      images: [{}],
      textures: [{ source: 0 }],
      materials: [{
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicRoughnessTexture: { index: 0 },
        },
      }],
    }),
    /shared by color and non-color/,
  );
});
test('classification: color-valued extension slots are sRGB, other extension slots linear', () => {
  const classes = classifyImages({
    images: [{}, {}, {}, {}],
    textures: [{ source: 0 }, { source: 1 }, { source: 2 }, { source: 3 }],
    materials: [{
      extensions: {
        KHR_materials_specular: { specularColorTexture: { index: 0 }, specularTexture: { index: 1 } },
        KHR_materials_clearcoat: { clearcoatTexture: { index: 2 }, clearcoatNormalTexture: { index: 3 } },
      },
    }],
  });
  assert.equal(classes.get(0), 'color');
  assert.equal(classes.get(1), 'data');
  assert.equal(classes.get(2), 'data');
  assert.equal(classes.get(3), 'normal');
});

test('repack encodes embedded PNG images and honours maxDimension', { skip: !ktxAvailable && 'toktx unavailable' }, async () => {
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: 300, height: 150, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 255 } } }).png().toBuffer();
  const bin = Buffer.concat([png, Buffer.alloc((4 - (png.length % 4)) % 4)]);
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.length }],
    images: [{ mimeType: 'image/png', bufferView: 0, name: 'albedo' }],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
  };
  const { writeGlb } = await import('../src/glb.mjs');
  const { glb, report } = await repackGlb(writeGlb(json, bin), { maxDimension: 128 });
  const out = parseGlb(glb);
  assert.equal(out.json.images[0].mimeType, 'image/ktx2');
  assert.equal(out.json.textures[0].extensions.KHR_texture_basisu.source, 0);
  assert.equal(report.images[0].sourceMimeType, 'image/png');
  assert.equal(report.images[0].width, 128);
  assert.equal(report.images[0].height, 64);
  const view = out.json.bufferViews[out.json.images[0].bufferView];
  const bytes = out.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  assert.equal(bytes.readUInt32LE(20), 128);
  assert.equal(bytes.readUInt32LE(24), 64);
});


test('toktx argv policy: etc1s only when explicitly requested, normals never RDO', () => {
  const color = toktxArgs('color');
  assert.ok(color.includes('uastc') && color.includes('srgb') && color.includes('--uastc_rdo_l'));
  const webColor = toktxArgs('color', { colorCodec: 'etc1s' });
  assert.ok(webColor.includes('etc1s') && webColor.includes('srgb'));
  const normal = toktxArgs('normal', { colorCodec: 'etc1s' });
  assert.ok(normal.includes('uastc') && normal.includes('linear') && !normal.includes('--uastc_rdo_l'));
  const data = toktxArgs('data');
  assert.ok(data.includes('uastc') && data.includes('linear') && data.includes('--uastc_rdo_l'));
});
