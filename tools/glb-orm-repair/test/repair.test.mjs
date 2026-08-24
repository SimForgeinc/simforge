import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

import { auditGlb, readGlb, repairGlb, sniffImageMime, verifyRepair, writeGlb } from '../src/repair.mjs';

// --- synthetic fixtures ------------------------------------------------------

/** Minimal valid 1x1 gray PNG built at runtime; nothing binary in git. */
function makePng(seed = 0) {
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const idat = zlib.deflateSync(Buffer.from([0, 0x40 + (seed & 0x3f)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Fake-but-sniffable WebP payload (magic only; never decoded by the tool). */
function makeWebp(fill) {
  const body = Buffer.alloc(64, fill);
  body.write('RIFF', 0, 'latin1');
  body.writeUInt32LE(56, 4);
  body.write('WEBP', 8, 'latin1');
  return body;
}

/**
 * A tile-shaped GLB: quantized-looking geometry bytes, one embedded WebP
 * diffuse, one embedded WebP spec map mis-wired as Curb's base color —
 * mirroring tiles_road.glb's Asphalt1/Curb_Saratoga defect pair.
 */
function makeSourceGlb() {
  const geometry = Buffer.from(Array.from({ length: 36 }, (_, i) => (i * 37) & 0xff));
  const specImage = makeWebp(0xa1);
  const diffImage = makeWebp(0xb2);
  const geometryAt = 0;
  const specAt = geometry.length; // 36 → aligned already
  const diffAt = specAt + specImage.length;
  const bin = Buffer.concat([geometry, specImage, diffImage]);
  const json = {
    asset: { version: '2.0', generator: 'sf-orm test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Roads_Layer0' }],
    meshes: [
      {
        name: 'Roads_Layer0',
        primitives: [
          { attributes: { POSITION: 0 }, material: 0 },
          { attributes: { POSITION: 0 }, material: 1 },
        ],
      },
    ],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] }],
    bufferViews: [
      { buffer: 0, byteOffset: geometryAt, byteLength: geometry.length },
      { buffer: 0, byteOffset: specAt, byteLength: specImage.length },
      { buffer: 0, byteOffset: diffAt, byteLength: diffImage.length },
    ],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    images: [
      { name: 'Asphalt3_Spec', mimeType: 'image/webp', bufferView: 1 },
      { name: 'Asphalt1_Diff', mimeType: 'image/webp', bufferView: 2 },
    ],
    textures: [
      { sampler: 0, source: 0 },
      { sampler: 0, source: 1 },
    ],
    materials: [
      { name: 'Curb_Saratoga', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.5 } },
      { name: 'Asphalt1', pbrMetallicRoughness: { baseColorTexture: { index: 1 }, metallicFactor: 0, roughnessFactor: 0.5 } },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  return writeGlb(json, bin);
}

// --- tests -------------------------------------------------------------------

test('writeGlb/readGlb round-trip with 4-byte alignment', () => {
  const source = makeSourceGlb();
  assert.equal(source.readUInt32LE(8), source.length);
  assert.equal(source.length % 4, 0);
  const { json, bin } = readGlb(source);
  assert.equal(json.materials.length, 2);
  assert.equal(bin.readUInt8(0), 0);
});

test('sniffImageMime detects png/webp/jpeg and rejects junk', () => {
  assert.equal(sniffImageMime(makePng()), 'image/png');
  assert.equal(sniffImageMime(makeWebp(1)), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.throws(() => sniffImageMime(Buffer.from('not an image')), /unsupported image/);
});

test('audit flags spec-as-baseColor and frozen-roughness', () => {
  const audit = auditGlb(makeSourceGlb());
  const curb = audit.materials.find((m) => m.name === 'Curb_Saratoga');
  const asphalt = audit.materials.find((m) => m.name === 'Asphalt1');
  assert.deepEqual(curb.flags, ['spec-as-baseColor', 'frozen-roughness']);
  assert.deepEqual(asphalt.flags, ['frozen-roughness']);
  assert.equal(curb.baseColor.name, 'Asphalt3_Spec');
});

test('repair wires one packed ORM image into both glTF slots per spec', () => {
  const source = makeSourceGlb();
  const orm = makePng(1);
  const { output } = repairGlb(source, [{ material: 'Asphalt1', orm: { bytes: orm, name: 'asphalt_arm' } }]);
  const { json, bin } = readGlb(output);
  const material = json.materials.find((m) => m.name === 'Asphalt1');
  const pbr = material.pbrMetallicRoughness;
  assert.equal(material.occlusionTexture.index, pbr.metallicRoughnessTexture.index);
  assert.equal(pbr.metallicFactor, 1);
  assert.equal(pbr.roughnessFactor, 1);
  const texture = json.textures[material.occlusionTexture.index];
  assert.equal(texture.sampler, 0); // reused the material's existing sampler
  const image = json.images[texture.source];
  assert.equal(image.mimeType, 'image/png');
  const view = json.bufferViews[image.bufferView];
  assert.ok(view.byteOffset % 4 === 0);
  assert.ok(bin.subarray(view.byteOffset, view.byteOffset + view.byteLength).equals(orm));
  // base color untouched on a pure ORM repair
  assert.equal(pbr.baseColorTexture.index, 1);
});

test('repair fixes spec-as-baseColor with replacement textures', () => {
  const { output, report } = repairGlb(makeSourceGlb(), [
    {
      material: 'Curb_Saratoga',
      orm: { bytes: makePng(2), name: 'concrete_arm' },
      baseColor: { bytes: makePng(3), name: 'concrete_diff' },
      normal: { bytes: makePng(4), name: 'concrete_nor' },
    },
  ]);
  const { json } = readGlb(output);
  const curb = json.materials.find((m) => m.name === 'Curb_Saratoga');
  const image = (ref) => json.images[json.textures[ref.index].source].name;
  assert.equal(image(curb.pbrMetallicRoughness.baseColorTexture), 'concrete_diff');
  assert.equal(image(curb.normalTexture), 'concrete_nor');
  assert.equal(image(curb.occlusionTexture), 'concrete_arm');
  assert.equal(report.materials[0].baseColor, json.materials.indexOf(curb) >= 0 ? curb.pbrMetallicRoughness.baseColorTexture.index : -1);
  const flags = auditGlb(output).materials.find((m) => m.name === 'Curb_Saratoga').flags;
  assert.deepEqual(flags, []);
});

test('baseColor:"remove" drops the mis-wired texture and sets the factor', () => {
  const { output } = repairGlb(makeSourceGlb(), [
    { material: 'Curb_Saratoga', baseColor: 'remove', baseColorFactor: [0.4, 0.4, 0.42, 1] },
  ]);
  const { json } = readGlb(output);
  const curb = json.materials.find((m) => m.name === 'Curb_Saratoga');
  assert.equal(curb.pbrMetallicRoughness.baseColorTexture, undefined);
  assert.deepEqual(curb.pbrMetallicRoughness.baseColorFactor, [0.4, 0.4, 0.42, 1]);
});

test('identity: source BIN is a byte-verbatim prefix; authored JSON untouched', () => {
  const source = makeSourceGlb();
  const { output } = repairGlb(source, [
    { material: 'Asphalt1', orm: { bytes: makePng(5) } },
    { material: 'Curb_Saratoga', baseColor: { bytes: makePng(6) } },
  ]);
  const src = readGlb(source);
  const out = readGlb(output);
  assert.ok(out.bin.subarray(0, src.bin.length).equals(src.bin));
  assert.deepEqual(out.json.meshes, src.json.meshes);
  assert.deepEqual(out.json.accessors, src.json.accessors);
  assert.deepEqual(out.json.nodes, src.json.nodes);
  assert.deepEqual(out.json.bufferViews.slice(0, 3), src.json.bufferViews);
  assert.deepEqual(out.json.images.slice(0, 2), src.json.images);
  assert.deepEqual(out.json.textures.slice(0, 2), src.json.textures);
});

test('shared and re-run sidecars are content-addressed, never duplicated', () => {
  const orm = { bytes: makePng(7), name: 'shared_arm' };
  const first = repairGlb(makeSourceGlb(), [
    { material: 'Asphalt1', orm },
    { material: 'Curb_Saratoga', orm },
  ]);
  assert.equal(first.report.imagesAppended, 1);
  const again = repairGlb(first.output, [{ material: 'Asphalt1', orm }]);
  assert.equal(again.report.imagesAppended, 0);
});

test('unknown material throws unless optional', () => {
  assert.throws(() => repairGlb(makeSourceGlb(), [{ material: 'Nope', orm: { bytes: makePng(8) } }]), /not found/);
  const { report } = repairGlb(makeSourceGlb(), [{ material: 'Nope', optional: true, orm: { bytes: makePng(8) } }]);
  assert.equal(report.materials.length, 0);
});

test('verifyRepair rejects geometry tampering', () => {
  const source = makeSourceGlb();
  const { output } = repairGlb(source, [{ material: 'Asphalt1', orm: { bytes: makePng(9) } }]);
  const tampered = Buffer.from(output);
  const { json } = readGlb(source);
  void json;
  // flip one byte inside the original geometry bufferView region of the BIN chunk
  const jsonLength = tampered.readUInt32LE(12);
  const binStart = 20 + jsonLength + 8;
  tampered[binStart + 4] ^= 0xff;
  assert.throws(() => verifyRepair(source, tampered), /source BIN bytes changed/);
});
