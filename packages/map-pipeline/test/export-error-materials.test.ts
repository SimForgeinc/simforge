import { Document } from '@gltf-transform/core';
import { KHRMaterialsEmissiveStrength } from '@gltf-transform/extensions';
import { describe, expect, it } from 'vitest';

import { isExportErrorMaterial, neutralizeExportErrorMaterials } from '../src/export-error-materials.js';

const PNG_STUB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('neutralizeExportErrorMaterials', () => {
  it('rewrites untextured magenta materials by name class and strips emission', () => {
    const document = new Document();
    const strengthExt = document.createExtension(KHRMaterialsEmissiveStrength);
    const post = document
      .createMaterial('Metal_Signals_Prop_signal_post_35ft')
      .setBaseColorFactor([1, 0, 1, 1])
      .setEmissiveFactor([1, 0, 1]);
    post.setExtension('KHR_materials_emissive_strength', strengthExt.createEmissiveStrength().setEmissiveStrength(5));
    const glass = document.createMaterial('GlassInstance_SM_MiniCooperS7').setBaseColorFactor([1, 0, 1, 1]);
    const sign = document.createMaterial('Sign_R3-18_svg_rrx_Sign').setBaseColorFactor([1, 0, 1, 1]).setEmissiveFactor([1, 0, 1]);

    const report = neutralizeExportErrorMaterials(document);

    expect(report.count).toBe(3);
    expect(report.byClass).toEqual({ glass: 1, sign: 1, prop: 1 });
    expect(post.getBaseColorFactor()).toEqual([0.45, 0.45, 0.45, 1]);
    expect(post.getEmissiveFactor()).toEqual([0, 0, 0]);
    expect(post.getExtension('KHR_materials_emissive_strength')).toBeNull();
    expect(glass.getAlphaMode()).toBe('BLEND');
    expect(glass.getBaseColorFactor()[3]).toBeLessThan(1);
    expect(sign.getBaseColorFactor()).toEqual([0.72, 0.72, 0.7, 1]);
  });

  it('leaves textured, non-magenta, and deliberately emissive-textured materials alone', () => {
    const document = new Document();
    const texture = document.createTexture('t').setImage(PNG_STUB).setMimeType('image/png');
    const textured = document.createMaterial('textured').setBaseColorFactor([1, 0, 1, 1]).setBaseColorTexture(texture);
    const red = document.createMaterial('red').setBaseColorFactor([1, 0, 0, 1]);
    const emissiveTextured = document.createMaterial('neon').setBaseColorFactor([1, 0, 1, 1]).setEmissiveTexture(texture);

    expect(isExportErrorMaterial(textured)).toBe(false);
    expect(isExportErrorMaterial(red)).toBe(false);
    expect(isExportErrorMaterial(emissiveTextured)).toBe(false);
    expect(neutralizeExportErrorMaterials(document).count).toBe(0);
    expect(textured.getBaseColorFactor()).toEqual([1, 0, 1, 1]);
  });
});
