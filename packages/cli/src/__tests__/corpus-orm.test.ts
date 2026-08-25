/**
 * ORM material contract through the corpus decode step (WSB1).
 *
 * Production tiles historically lost their AORM maps at the UE→glTF export,
 * so nothing downstream ever exercised occlusion/metallicRoughness survival.
 * With `tools/glb-orm-repair` wiring packed ORM textures (R=AO, G=roughness,
 * B=metallic; occlusionTexture and metallicRoughnessTexture share one image)
 * back into tiles, the corpus build must carry that wiring into the
 * Bevy-consumable GLB: WebP payloads become PNG, but the slots, the shared
 * texture reference, and the metallic/roughness factors must be untouched.
 */

import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { decodeGlb } from '../commands/corpus.js';

async function tinyImage(format: 'webp' | 'png', tone: number): Promise<Uint8Array> {
  const raw = Buffer.alloc(4 * 4 * 3, tone);
  const image = sharp(raw, { raw: { width: 4, height: 4, channels: 3 } });
  return format === 'webp' ? image.webp({ lossless: true }).toBuffer() : image.png().toBuffer();
}

async function makeOrmGlb(io: NodeIO, ormFormat: 'webp' | 'png'): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]))
    .setBuffer(buffer);
  const baseColor = doc
    .createTexture('Asphalt1_Diff')
    .setImage(await tinyImage('webp', 96))
    .setMimeType('image/webp');
  const orm = doc
    .createTexture('Asphalt1_AORM')
    .setImage(await tinyImage(ormFormat, 160))
    .setMimeType(`image/${ormFormat}`);
  const material = doc
    .createMaterial('Asphalt1')
    .setBaseColorTexture(baseColor)
    .setMetallicRoughnessTexture(orm)
    .setOcclusionTexture(orm)
    .setMetallicFactor(1)
    .setRoughnessFactor(1);
  const primitive = doc.createPrimitive().setAttribute('POSITION', position).setMaterial(material);
  const mesh = doc.createMesh('Roads_Layer0').addPrimitive(primitive);
  const node = doc.createNode('Roads_Layer0').setMesh(mesh);
  doc.createScene().addChild(node);
  return io.writeBinary(doc);
}

describe('corpus decode preserves ORM wiring', () => {
  const io = new NodeIO();

  it('keeps occlusion+metallicRoughness on one texture through WebP→PNG', async () => {
    const glb = await makeOrmGlb(io, 'webp');
    const { doc, converted } = await decodeGlb(Buffer.from(glb), io);
    expect(converted).toBe(2); // baseColor + ORM were both WebP

    const material = doc.getRoot().listMaterials()[0]!;
    const occlusion = material.getOcclusionTexture();
    const metallicRoughness = material.getMetallicRoughnessTexture();
    expect(occlusion).not.toBeNull();
    expect(metallicRoughness).not.toBeNull();
    // The packed ORM image serves both slots — same texture, not a copy.
    expect(occlusion).toBe(metallicRoughness);
    expect(occlusion!.getMimeType()).toBe('image/png');
    expect(material.getMetallicFactor()).toBe(1);
    expect(material.getRoughnessFactor()).toBe(1);
    expect(material.getBaseColorTexture()!.getMimeType()).toBe('image/png');
  });

  it('leaves non-WebP ORM payloads byte-identical', async () => {
    const glb = await makeOrmGlb(io, 'png');
    const before = await io.readBinary(Buffer.from(glb));
    const sourceOrm = before.getRoot().listMaterials()[0]!.getOcclusionTexture()!.getImage()!;

    const { doc, converted } = await decodeGlb(Buffer.from(glb), io);
    expect(converted).toBe(1); // only the WebP baseColor converts
    const material = doc.getRoot().listMaterials()[0]!;
    const orm = material.getOcclusionTexture()!;
    expect(orm.getMimeType()).toBe('image/png');
    expect(Buffer.from(orm.getImage()!).equals(Buffer.from(sourceOrm))).toBe(true);
    expect(material.getOcclusionTexture()).toBe(material.getMetallicRoughnessTexture());
  });
});
