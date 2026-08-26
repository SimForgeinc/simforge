import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildMaterialBindingPlan,
  classifyTextureRole,
  matchMaterialName,
  renderBinding,
} from '../src/index.js';

const yale = '/home/path/simforge-assets/incoming/Level_FBX/Yale_St_Palo_Alto_CA';

describe('materials.json binding contract', () => {
  it('matches Blender FBX material names to Unreal asset leaves', () => {
    const materials = [
      { path: '/Game/Buildings/Outer_Wall.Outer_Wall' },
      { path: '/Game/Road/M_Asphalt.M_Asphalt' },
    ];
    expect(matchMaterialName('Outer_Wall.001', materials)?.path).toContain('Outer_Wall');
    expect(matchMaterialName('Material:M_Asphalt', materials)?.path).toContain('M_Asphalt');
    expect(matchMaterialName('missing', materials)).toBeUndefined();
  });

  it.each([
    ['wall_BaseColor.png', 'baseColor'],
    ['signals_Diff.tga', 'baseColor'],
    ['brick_Normal_DirectX.png', 'normal'],
    ['road_Norm.png', 'normal'],
    ['surface_AORM.png', 'orm'],
    ['surface_ORMH1.png', 'orm'],
    ['surface_Roughness.png', 'roughness'],
    ['surface_Metallic.png', 'metallic'],
    ['leaf_Opacity.png', 'opacity'],
    ['lamp_Emissive.png', 'emissive'],
    ['terrain_Displacement.exr', 'height'],
  ])('classifies %s as %s', (filename, role) => {
    expect(classifyTextureRole(filename)).toBe(role);
  });

  it('maps Unreal render state to glTF alpha and culling state', () => {
    expect(renderBinding({ blend_mode: 'Opaque', two_sided: false })).toEqual({
      alphaMode: 'OPAQUE', doubleSided: false,
    });
    expect(renderBinding({ blend_mode: 'Translucent', two_sided: true })).toEqual({
      alphaMode: 'BLEND', doubleSided: true,
    });
    expect(renderBinding({ blend_mode: 'Masked', opacity_mask_clip_value: 0.3333, two_sided: true })).toEqual({
      alphaMode: 'MASK', alphaCutoff: 0.3333, doubleSided: true,
    });
  });

  it('resolves every Yale UE texture path and asserts role color spaces and ORM channels', async () => {
    expect(path.isAbsolute(yale)).toBe(true);
    const plan = await buildMaterialBindingPlan(yale);
    const resolved = Object.values(plan.roleCounts).reduce((sum, count) => sum + count, 0);
    expect(resolved).toBe(1265);
    expect(plan.unresolvedTextures).toEqual([]);
    expect(plan.ormChannels).toEqual({ occlusion: 'R', roughness: 'G', metallic: 'B' });
    for (const material of plan.materials) {
      for (const texture of material.textures) {
        expect(texture.colorSpace).toBe(
          texture.role === 'baseColor' || texture.role === 'emissive' ? 'srgb' : 'linear',
        );
        if (texture.role === 'normal') expect(texture.normalConvention).toBe('directx');
      }
    }
  });
});
