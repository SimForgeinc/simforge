import { Document } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';
import { clampPbrFactors } from '../src/material-ranges.js';

describe('clampPbrFactors', () => {
  it('clamps out-of-spec roughness/metallic and leaves valid materials alone', () => {
    const document = new Document();
    const grass = document.createMaterial('MI_Grass1').setRoughnessFactor(2).setMetallicFactor(0);
    const paint = document.createMaterial('Paint').setRoughnessFactor(10).setMetallicFactor(-0.5);
    const ok = document.createMaterial('Asphalt').setRoughnessFactor(0.96).setMetallicFactor(0);
    const report = clampPbrFactors(document);
    expect(report).toEqual({ clamped: 2, byName: { MI_Grass1: ['roughnessFactor:2'], Paint: ['roughnessFactor:10', 'metallicFactor:-0.5'] } });
    expect(grass.getRoughnessFactor()).toBe(1);
    expect(paint.getRoughnessFactor()).toBe(1);
    expect(paint.getMetallicFactor()).toBe(0);
    expect(ok.getRoughnessFactor()).toBeCloseTo(0.96);
  });
});
