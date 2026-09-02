import { Document } from '@gltf-transform/core';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { dilateAlphaEdges, dilateRgba } from '../src/alpha-dilate.js';

describe('dilateRgba', () => {
  it('floods the nearest opaque colour into invisible texels and keeps alpha and visible texels', () => {
    // 4x1: [green opaque][white invisible][white invisible][red opaque]
    const data = new Uint8Array([0, 255, 0, 255, 255, 255, 255, 0, 255, 255, 255, 3, 255, 0, 0, 255]);
    expect(dilateRgba(data, 4, 1)).toBe(true);
    expect(Array.from(data)).toEqual([0, 255, 0, 255, 0, 255, 0, 0, 255, 0, 0, 3, 255, 0, 0, 255]);
  });

  it('is a no-op for fully opaque or fully transparent images', () => {
    const opaque = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
    const clear = new Uint8Array([1, 2, 3, 0, 4, 5, 6, 0]);
    expect(dilateRgba(opaque, 2, 1)).toBe(false);
    expect(dilateRgba(clear, 2, 1)).toBe(false);
    expect(Array.from(opaque)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(Array.from(clear)).toEqual([1, 2, 3, 0, 4, 5, 6, 0]);
  });
});

describe('dilateAlphaEdges', () => {
  it('rewrites only PNG textures that carry invisible texels', async () => {
    const document = new Document();
    const raw = Buffer.from([0, 255, 0, 255, 255, 255, 255, 0]);
    const cutout = await sharp(raw, { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
    const solid = await sharp(Buffer.from([9, 9, 9, 255]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
    const leaf = document.createTexture('leaf').setImage(new Uint8Array(cutout)).setMimeType('image/png');
    const wall = document.createTexture('wall').setImage(new Uint8Array(solid)).setMimeType('image/png');

    const report = await dilateAlphaEdges(document);

    expect(report.textures).toBe(1);
    expect(wall.getImage()).toEqual(new Uint8Array(solid));
    const decoded = await sharp(Buffer.from(leaf.getImage()!)).raw().toBuffer();
    expect(Array.from(decoded)).toEqual([0, 255, 0, 255, 0, 255, 0, 0]);
  });
});
