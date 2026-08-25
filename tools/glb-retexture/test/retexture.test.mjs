import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeGlb } from '../../glb-ktx2-repack/src/glb.mjs';
import { retextureGlb, scanImageHashes } from '../src/retexture.mjs';

const geometry = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
const oldImage = Buffer.from('old-RoadRunner-image');
const sourceBin = Buffer.concat([geometry, oldImage]);
const sourceJson = {
  asset: { version: '2.0' },
  buffers: [{ byteLength: sourceBin.length }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: geometry.length, target: 34962 },
    { buffer: 0, byteOffset: geometry.length, byteLength: oldImage.length },
  ],
  accessors: [{ bufferView: 0, componentType: 5121, count: 8, type: 'SCALAR' }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  images: [{ name: 'Asphalt1_Diff', mimeType: 'image/webp', bufferView: 1 }],
  textures: [{ source: 0 }],
};

test('replaces only named image bytes deterministically and preserves geometry', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-retexture-test-'));
  try {
    const png = path.join(temporary, 'clean.png');
    fs.writeFileSync(png, Buffer.from('clean-room-png'));
    const source = writeGlb(sourceJson, sourceBin);
    const manifest = { replacements: { Asphalt1_Diff: { file: 'clean.png', class: 'asphalt', license: 'CC0-1.0' } } };
    const first = retextureGlb(source, manifest, { manifestDir: temporary });
    const second = retextureGlb(source, manifest, { manifestDir: temporary });
    assert.deepEqual(first.glb, second.glb);
    assert.equal(first.report.geometry.identical, true);
    assert.equal(first.report.replacements[0].name, 'Asphalt1_Diff');
    assert.equal(scanImageHashes(first.glb, [first.report.replacements[0].sourceSha256]).length, 0);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('fails closed when a required name is absent', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-retexture-test-'));
  try {
    fs.writeFileSync(path.join(temporary, 'clean.png'), Buffer.from('clean'));
    assert.throws(
      () => retextureGlb(writeGlb(sourceJson, sourceBin), { requiredImageNames: ['Missing'], replacements: { Asphalt1_Diff: 'clean.png' } }, { manifestDir: temporary }),
      /required image names not present: Missing/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
