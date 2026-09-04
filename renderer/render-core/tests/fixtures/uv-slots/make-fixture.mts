/**
 * Builds `uv-slots.gltf`: one quad with TEXCOORD_0 and TEXCOORD_2 whose base
 * colour samples UV0 through a 2x scale transform while the emissive slot
 * samples UV2 through a (0.25, 0) offset transform. A loader that honours
 * per-slot KHR_texture_transform and TEXCOORD_2 renders the emissive quadrant
 * pattern displaced against the base colour one; the upstream fallback (base
 * colour transform everywhere, TEXCOORD_2 -> 0) renders them aligned.
 *
 * Regenerate with the map-pipeline package's node_modules:
 *   cd packages/map-pipeline && npx tsx ../../renderer/render-core/tests/fixtures/uv-slots/make-fixture.mts
 * (`dir` resolves this file's directory, so running it from there is fine once
 * tsx can resolve @gltf-transform from the caller's package.)
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsEmissiveStrength, KHRTextureTransform } from '@gltf-transform/extensions';
import sharp from 'sharp';

const dir = path.dirname(new URL(import.meta.url).pathname);
const size = 64;
const rgba = Buffer.alloc(size * size * 4);
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const i = (y * size + x) * 4;
    const left = x < size / 2;
    const top = y < size / 2;
    // quadrants: red, green / blue, white
    rgba[i] = left && top ? 255 : !left && !top ? 255 : 0;
    rgba[i + 1] = !left && top ? 255 : !left && !top ? 255 : 0;
    rgba[i + 2] = left && !top ? 255 : !left && !top ? 255 : 0;
    rgba[i + 3] = 255;
  }
}
const png = await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();

const document = new Document();
const buffer = document.createBuffer();
const texture = document.createTexture('quadrants').setMimeType('image/png').setImage(new Uint8Array(png));
const transforms = document.createExtension(KHRTextureTransform);
const strength = document.createExtension(KHRMaterialsEmissiveStrength);
const material = document
  .createMaterial('uv-slots')
  .setBaseColorTexture(texture)
  .setEmissiveTexture(texture)
  .setEmissiveFactor([1, 1, 1])
  .setRoughnessFactor(1)
  .setMetallicFactor(0);
material.getBaseColorTextureInfo()!.setExtension('KHR_texture_transform', transforms.createTransform().setScale([2, 2]));
material.getEmissiveTextureInfo()!.setTexCoord(2).setExtension('KHR_texture_transform', transforms.createTransform().setOffset([0.25, 0]));
material.setExtension('KHR_materials_emissive_strength', strength.createEmissiveStrength().setEmissiveStrength(4));
for (const info of [material.getBaseColorTextureInfo()!, material.getEmissiveTextureInfo()!]) info.setWrapS(10497).setWrapT(10497);

const position = document.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]));
const normal = document.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]));
const uv0 = document.createAccessor().setType('VEC2').setBuffer(buffer).setArray(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]));
// UV2: the same unit square mirrored horizontally, so a loader that falls
// back to UV0 cannot reproduce it.
const uv2 = document.createAccessor().setType('VEC2').setBuffer(buffer).setArray(new Float32Array([1, 1, 0, 1, 0, 0, 1, 0]));
const indices = document.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(new Uint16Array([0, 1, 2, 0, 2, 3]));
const primitive = document
  .createPrimitive()
  .setAttribute('POSITION', position)
  .setAttribute('NORMAL', normal)
  .setAttribute('TEXCOORD_0', uv0)
  .setAttribute('TEXCOORD_2', uv2)
  .setIndices(indices)
  .setMaterial(material);
const mesh = document.createMesh('quad').addPrimitive(primitive);
const scene = document.createScene('scene');
scene.addChild(document.createNode('quad').setMesh(mesh));
document.getRoot().setDefaultScene(scene);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
writeFileSync(path.join(dir, 'uv-slots.glb'), await io.writeBinary(document));
console.log('wrote', path.join(dir, 'uv-slots.glb'));
