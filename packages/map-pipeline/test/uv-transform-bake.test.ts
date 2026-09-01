import { Document } from '@gltf-transform/core';
import type { Material, Primitive, TextureInfo } from '@gltf-transform/core';
import { KHRTextureTransform } from '@gltf-transform/extensions';
import type { Transform } from '@gltf-transform/extensions';
import { describe, expect, it } from 'vitest';

import { assertBevyRepresentableSampling, bakeDivergentTextureTransforms } from '../src/uv-transform-bake.js';

const PNG_STUB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface SlotTransform {
  offset?: [number, number];
  scale?: [number, number];
  rotation?: number;
}

function buildDocument(baseTransform: SlotTransform | null, occlusionTransform: SlotTransform | null): { document: Document; material: Material; primitive: Primitive } {
  const document = new Document();
  const buffer = document.createBuffer();
  const ext = document.createExtension(KHRTextureTransform);

  const uv = document
    .createAccessor('uv')
    .setType('VEC2')
    .setArray(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]))
    .setBuffer(buffer);
  const position = document
    .createAccessor('position')
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);

  const baseTex = document.createTexture('base').setImage(PNG_STUB).setMimeType('image/png');
  const occTex = document.createTexture('occ').setImage(PNG_STUB).setMimeType('image/png');
  const material = document.createMaterial('m').setBaseColorTexture(baseTex).setOcclusionTexture(occTex);

  const apply = (info: TextureInfo | null, slot: SlotTransform | null) => {
    if (info === null || slot === null) return;
    const transform = ext.createTransform();
    if (slot.offset) transform.setOffset(slot.offset);
    if (slot.scale) transform.setScale(slot.scale);
    if (slot.rotation !== undefined) transform.setRotation(slot.rotation);
    info.setExtension('KHR_texture_transform', transform);
  };
  apply(material.getBaseColorTextureInfo(), baseTransform);
  apply(material.getOcclusionTextureInfo(), occlusionTransform);

  const primitive = document.createPrimitive().setAttribute('POSITION', position).setAttribute('TEXCOORD_0', uv).setMaterial(material);
  const mesh = document.createMesh('quad').addPrimitive(primitive);
  const node = document.createNode('n').setMesh(mesh);
  document.createScene('s').addChild(node);
  return { document, material, primitive };
}

function uvValues(primitive: Primitive, semantic: string): number[] {
  const accessor = primitive.getAttribute(semantic);
  expect(accessor).not.toBeNull();
  return [...(accessor!.getArray() as Float32Array)];
}

describe('bakeDivergentTextureTransforms', () => {
  it('bakes an occlusion transform diverging from an untransformed base color into UV1', () => {
    const { document, material, primitive } = buildDocument(null, { offset: [0.5, 0.25], scale: [2, 3] });
    expect(bakeDivergentTextureTransforms(document)).toBe(1);

    // Base color keeps identity UV0.
    expect(material.getBaseColorTextureInfo()!.getTexCoord()).toBe(0);
    expect(uvValues(primitive, 'TEXCOORD_0')).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);

    // Occlusion moved to a baked UV1: u' = 2u + 0.5, v' = 3v + 0.25.
    expect(material.getOcclusionTextureInfo()!.getTexCoord()).toBe(1);
    expect(uvValues(primitive, 'TEXCOORD_1')).toEqual([0.5, 0.25, 2.5, 0.25, 2.5, 3.25, 0.5, 3.25]);

    // No per-slot transform survives on the baked material.
    expect(material.getBaseColorTextureInfo()!.getExtension('KHR_texture_transform')).toBeNull();
    expect(material.getOcclusionTextureInfo()!.getExtension('KHR_texture_transform')).toBeNull();
    expect(() => assertBevyRepresentableSampling(document)).not.toThrow();
  });

  it('bakes both variants when base color and occlusion each carry distinct transforms', () => {
    const { document, material, primitive } = buildDocument(
      { offset: [1, 0], scale: [2, 2] },
      { offset: [0, 1] },
    );
    expect(bakeDivergentTextureTransforms(document)).toBe(1);

    // Base variant baked into UV0: u' = 2u + 1, v' = 2v.
    expect(material.getBaseColorTextureInfo()!.getTexCoord()).toBe(0);
    expect(uvValues(primitive, 'TEXCOORD_0')).toEqual([1, 0, 3, 0, 3, 2, 1, 2]);

    // Occlusion variant baked into UV1: u' = u, v' = v + 1.
    expect(material.getOcclusionTextureInfo()!.getTexCoord()).toBe(1);
    expect(uvValues(primitive, 'TEXCOORD_1')).toEqual([0, 1, 1, 1, 1, 2, 0, 2]);
    expect(() => assertBevyRepresentableSampling(document)).not.toThrow();
  });

  it('applies the spec rotation composition Translation * Rotation * Scale', () => {
    const { document, primitive } = buildDocument(null, { rotation: Math.PI / 2, scale: [1, 2] });
    expect(bakeDivergentTextureTransforms(document)).toBe(1);
    // r = pi/2: u' = cos*sx*u + sin*sy*v = 2v; v' = -sin*sx*u + cos*sy*v = -u.
    const uv = uvValues(primitive, 'TEXCOORD_1');
    const expected = [0, 0, 0, -1, 2, -1, 2, 0];
    for (const [i, value] of expected.entries()) expect(uv[i]).toBeCloseTo(value, 6);
    expect(() => assertBevyRepresentableSampling(document)).not.toThrow();
  });

  it('leaves materials whose slots share the base-color transform untouched', () => {
    const shared: SlotTransform = { offset: [0.5, 0.5], scale: [4, 4] };
    const { document, material, primitive } = buildDocument(shared, shared);
    expect(bakeDivergentTextureTransforms(document)).toBe(0);
    expect(material.getBaseColorTextureInfo()!.getExtension('KHR_texture_transform')).not.toBeNull();
    expect(primitive.getAttribute('TEXCOORD_1')).toBeNull();
    expect(uvValues(primitive, 'TEXCOORD_0')).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    expect(() => assertBevyRepresentableSampling(document)).not.toThrow();
  });

  it('rejects materials needing more than two sampling variants', () => {
    const { document, material } = buildDocument({ offset: [1, 0] }, { offset: [0, 1] });
    const ext = document.createExtension(KHRTextureTransform);
    const mrTex = document.createTexture('mr').setImage(PNG_STUB).setMimeType('image/png');
    material.setMetallicRoughnessTexture(mrTex);
    const transform = ext.createTransform().setOffset([2, 2]);
    material.getMetallicRoughnessTextureInfo()!.setExtension('KHR_texture_transform', transform);
    expect(() => bakeDivergentTextureTransforms(document)).toThrow(/sampling variants/);
  });

  it('moves a non-divergent material sampling UV2 into UV0 and strips the UV2 attribute', () => {
    const { document, material, primitive } = buildDocument(null, null);
    const uv2 = document.createAccessor('uv2').setType('VEC2')
      .setArray(new Float32Array([0, 0, 3, 0, 3, 3, 0, 3]))
      .setBuffer(document.getRoot().listBuffers()[0]!);
    primitive.setAttribute('TEXCOORD_2', uv2);
    material.getBaseColorTextureInfo()!.setTexCoord(2);
    material.getOcclusionTextureInfo()!.setTexCoord(2);
    expect(bakeDivergentTextureTransforms(document)).toBe(1);
    expect(material.getBaseColorTextureInfo()!.getTexCoord()).toBe(0);
    expect(material.getOcclusionTextureInfo()!.getTexCoord()).toBe(0);
    expect(uvValues(primitive, 'TEXCOORD_0')).toEqual([0, 0, 3, 0, 3, 3, 0, 3]);
    expect(primitive.getAttribute('TEXCOORD_2')).toBeNull();
    expect(() => assertBevyRepresentableSampling(document)).not.toThrow();
  });

  it('normalizes a transform texCoord override onto the TextureInfo for untouched materials', () => {
    const shared: SlotTransform = { scale: [2, 2] };
    const { document, material, primitive } = buildDocument(shared, shared);
    primitive.setAttribute('TEXCOORD_1', primitive.getAttribute('TEXCOORD_0'));
    const infos = [material.getBaseColorTextureInfo()!, material.getOcclusionTextureInfo()!];
    for (const info of infos) info.getExtension<Transform>('KHR_texture_transform')!.setTexCoord(1);
    expect(bakeDivergentTextureTransforms(document)).toBe(0);
    for (const info of infos) {
      expect(info.getTexCoord()).toBe(1);
      expect(info.getExtension<Transform>('KHR_texture_transform')!.getTexCoord()).toBeNull();
    }
  });
});
